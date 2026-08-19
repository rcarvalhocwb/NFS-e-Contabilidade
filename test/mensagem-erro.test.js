const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Leitura da mensagem de erro da Sefin.
 *
 * A Sefin devolve os erros com as chaves em maiúscula — Codigo, Descricao,
 * Complemento. O painel procurava as minúsculas, e o resultado era uma caixa
 * de erro vermelha e VAZIA: o operador via "rejeitada" sem nenhuma pista do
 * motivo, com o número da DPS já consumido.
 *
 * A função vive no código do navegador, então o teste extrai e avalia a fonte —
 * duplicá-la aqui deixaria os dois lados livres para divergir. */

function carregarMensagemErro(arquivo) {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', arquivo), 'utf8');
  const inicio = fonte.indexOf('function mensagemErro');
  assert.ok(inicio > 0, 'mensagemErro não encontrada em ' + arquivo);

  // Fecha na primeira linha que volta à indentação de dois espaços
  const resto = fonte.slice(inicio);
  const fim = resto.indexOf('\n  }\n');
  const corpo = resto.slice(0, fim + 4);
  return new Function(corpo + '; return mensagemErro;')();
}

for (const arquivo of ['nota.js', 'painel.js']) {
  test(`${arquivo}: lê o erro da Sefin, que vem em maiúsculas`, () => {
    const mensagemErro = carregarMensagemErro(arquivo);
    const daSefin = {
      erros: [{
        Codigo: 'E1235',
        Descricao: 'Falha no esquema XML do DF-e.',
        Complemento: "The 'cNBS' element is invalid"
      }]
    };
    const texto = mensagemErro(daSefin, 422);
    assert.match(texto, /E1235/);
    assert.match(texto, /Falha no esquema XML/);
    assert.match(texto, /cNBS/);
  });

  test(`${arquivo}: continua lendo a forma minúscula`, () => {
    const mensagemErro = carregarMensagemErro(arquivo);
    const texto = mensagemErro({ erros: [{ codigo: 'E0116', descricao: 'A IM deve ser informada' }] }, 422);
    assert.match(texto, /E0116: A IM deve ser informada/);
  });

  test(`${arquivo}: nunca devolve mensagem vazia`, () => {
    // Vazio é o pior resultado: diz que falhou e não diz o que fazer
    const mensagemErro = carregarMensagemErro(arquivo);
    for (const entrada of [{}, { erros: [{}] }, { erros: [] }, null]) {
      const texto = mensagemErro(entrada, 500);
      assert.ok(texto && texto.trim().length > 3,
        'entrada ' + JSON.stringify(entrada) + ' devolveu: ' + JSON.stringify(texto));
    }
  });

  test(`${arquivo}: erro do próprio gateway tem precedência`, () => {
    const mensagemErro = carregarMensagemErro(arquivo);
    assert.equal(mensagemErro({ erro: 'Empresa não encontrada' }, 404), 'Empresa não encontrada');
  });
}
