const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Isolamento entre as empresas atendidas pelo escritório.
 *
 * É a garantia que sustenta o resto: um escritório atende dezenas de CNPJs no
 * mesmo gateway, e misturar dados entre eles não é um bug de tela — é nota
 * fiscal emitida na empresa errada, com o certificado errado, e imposto
 * lançado para quem não devia.
 *
 * Três mecanismos sustentam isso, e cada um tem seu teste aqui:
 *
 *   1. o certificado é buscado por empresa_id, nunca por CNPJ vindo de fora;
 *   2. o token de integração SOBRESCREVE o CNPJ do corpo da requisição, então
 *      um payload apontando para outra empresa emite na empresa do token;
 *   3. as rotas conferem escopo antes de tocar em dados ou certificado.
 *
 * Verificado também com o sistema no ar, com duas empresas e dois operadores:
 * onze rotas devolveram 404 e nenhuma vazou dado. Estes testes travam a forma
 * do código para que a próxima alteração não desfaça isso em silêncio. */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', ...partes), 'utf8');
}

test('o certificado é escolhido por empresa_id, não por CNPJ', () => {
  /* Se a consulta aceitasse CNPJ, bastaria mandar o de outra empresa para
     assinar com o certificado dela. A chave é a identidade já resolvida. */
  const servico = fonte('services', 'certificadoService.js');
  const fn = servico.slice(servico.indexOf('async function carregarCertificadoAtivo'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /empresa_id\s*=\s*\$1/, 'a busca precisa ser por empresa_id');
  assert.ok(!/cnpj/i.test(corpo.split('WHERE')[1] || ''),
    'a cláusula WHERE não pode aceitar CNPJ');
});

test('emitir carrega o certificado da empresa já resolvida', () => {
  const emissao = fonte('services', 'emissaoService.js');
  assert.match(emissao, /carregarCertificadoAtivo\(empresa\.id\)/,
    'o certificado sai do registro da empresa, não do corpo da requisição');
  assert.ok(!/carregarCertificadoAtivo\(\s*(dados|b|req)\./.test(emissao),
    'nada vindo do cliente pode escolher o certificado');
});

test('o token de empresa sobrescreve o CNPJ do corpo', () => {
  /* Um sistema cliente que mande o CNPJ de outra empresa não emite lá: o
     gateway troca o valor pelo da empresa dona do token, antes de qualquer
     rota ver o corpo. */
  const escopo = fonte('middleware', 'escopo.js');
  const fn = escopo.slice(escopo.indexOf('function fixarEscopoEmpresa'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /req\.body\.cnpjEmpresa\s*=\s*req\.auth\.cnpj/);
  assert.match(corpo, /req\.query\.cnpjEmpresa\s*=\s*req\.auth\.cnpj/,
    'o filtro por query também precisa ser fixado');
});

test('a rota de NFS-e passa pela fixação de escopo', () => {
  const servidor = fonte('server.js');
  assert.match(servidor, /app\.use\('\/nfse',\s*fixarEscopoEmpresa/,
    'sem isso, o token de uma empresa alcançaria outra');
});

test('quem não tem escopo recebe 404, não 403', () => {
  /* 403 confirmaria que aquele CNPJ existe no sistema — num escritório, que a
     empresa é cliente da casa. Quem não tem acesso não distingue "não existe"
     de "não é seu". */
  for (const [arquivo, nome] of [['routes/nfse.js', 'exigirEmpresaNoEscopo'],
                                 ['routes/empresas.js', 'exigirEmpresaVisivel']]) {
    const s = fonte(...arquivo.split('/'));
    const i = s.indexOf('function ' + nome);
    assert.ok(i > 0, nome + ' não encontrada em ' + arquivo);
    const corpo = s.slice(i, s.indexOf('\n}\n', i));
    assert.match(corpo, /status\(404\)/, nome + ' precisa responder 404');
    assert.ok(!/status\(403\)/.test(corpo),
      nome + ' não pode revelar que a empresa existe');
  }
});

test('o operador só enxerga as empresas às quais está vinculado', () => {
  const escopo = fonte('middleware', 'escopo.js');
  const fn = escopo.slice(escopo.indexOf('function empresasVisiveis'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  // token de empresa: uma só; usuário: as vinculadas; máquina: todas
  assert.match(corpo, /tipo === 'empresa'.*\[req\.auth\.empresaId\]/s);
  assert.match(corpo, /tipo === 'usuario'.*empresasIds/s);
});

test('a numeração fiscal é reservada por empresa e ambiente', () => {
  /* Numeração compartilhada entre empresas produziria números repetidos na
     Sefin — cada CNPJ tem a sua sequência. */
  const emissao = fonte('services', 'emissaoService.js');
  const fn = emissao.slice(emissao.indexOf('async function reservarNumeracao'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /empresa_id/);
  assert.match(corpo, /ambiente/);
});
