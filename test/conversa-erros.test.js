const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Os caminhos em que a pessoa erra.
 *
 * A conversa cobria bem o caso feliz. Quem digitava errado e percebia uma
 * pergunta depois só tinha a saída de recomeçar do zero — e é isso que faz
 * alguém pensar "deixa assim" e emitir uma nota que já sabe estar errada.
 */

const js = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'emitir.js'), 'utf8');

test('dá para voltar uma pergunta', () => {
  assert.match(js, /function voltar\(\)/);
  assert.match(js, /historico\.pop\(\)/);
  const i = js.indexOf('function voltar()');
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /erros = 0/, 'voltar limpa a contagem de tentativas');
  assert.match(corpo, /anterior\(\)/, 'e refaz a pergunta anterior');
});

test('"errei" e "corrigir" valem tanto quanto o botão', () => {
  /* A pessoa escreve antes de procurar botão. */
  const i = js.indexOf('PEDIDOS_DE_VOLTA');
  const linha = js.slice(i, js.indexOf('\n', js.indexOf('=', i)));
  for (const palavra of ['voltar', 'corrigir', 'errei', 'desfazer', 'anterior']) {
    assert.ok(linha.includes(palavra), palavra + ' precisa ser reconhecida');
  }
  assert.match(js, /if \(PEDIDOS_DE_VOLTA\.test\(texto\)\) \{ voltar\(\); return; \}/,
    'e a checagem vem antes de qualquer etapa');
});

test('cada pergunta se empilha para poder ser refeita', () => {
  for (const passo of ['perguntarTomador', 'perguntarServico', 'perguntarValor']) {
    assert.match(js, new RegExp('marcar\\(' + passo + '\\)'),
      passo + ' precisa entrar no histórico');
  }
});

test('insistir no erro oferece saída em vez de repetir a pergunta', () => {
  /* Tres recusas seguidas é o sistema prendendo a pessoa num canto. */
  const i = js.indexOf('function naoEntendi');
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /erros >= 3/);
  assert.match(corpo, /Voltar uma pergunta/);
  assert.match(corpo, /Recomeçar/);
});

test('a recusa diz o que estava errado, não só que estava', () => {
  /* "Inválido" não ajuda ninguém a acertar na segunda tentativa. */
  assert.match(js, /CNPJ tem 14 dígitos e CPF tem 11 — você digitou/);
  assert.match(js, /O código de tributação nacional tem 6 dígitos/);
  assert.match(js, /Você digitou ' \+ cod\.length/);
});

test('valor zero, negativo e ilegível têm respostas diferentes', () => {
  const i = js.indexOf("if (etapa === 'valor')");
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /Não entendi o valor/);
  assert.match(corpo, /precisa ser maior que zero/);
  assert.match(corpo, /window\.parseValorBR\(texto\)/,
    'a leitura de dinheiro é a mesma das outras telas');
});

test('valor alto pede confirmação antes de seguir', () => {
  /* O dedo escorrega no teclado numérico e vira imposto a mais, que só se
     desfaz com cancelamento. */
  assert.match(js, /VALOR_QUE_ASSUSTA = 100000/);
  const i = js.indexOf('VALOR_QUE_ASSUSTA && !nota.valorConfirmado');
  assert.ok(i > 0);
  const corpo = js.slice(i, i + 700);
  assert.match(corpo, /Sim, é esse valor/);
  assert.match(corpo, /Não, digitar de novo/);
});

test('descrição vazia e descrição gigante são barradas', () => {
  assert.match(js, /MAX_DESCRICAO = 2000/);
  const i = js.indexOf("if (etapa === 'servicoDescricao')");
  const corpo = js.slice(i, js.indexOf('\n    }', i));
  assert.match(corpo, /curta demais/);
  assert.match(corpo, /passou de ' \+ MAX_DESCRICAO/);
});

test('clicar duas vezes em emitir não manda duas DPS', () => {
  const i = js.indexOf('if (nota.emitindo) return;');
  assert.ok(i > 0, 'a trava de clique duplo precisa existir');
  assert.match(js.slice(i, i + 120), /nota\.emitindo = true/);
  assert.match(js, /nota\.emitindo = false/, 'e libera se a emissão falhar');
});

test('falha ao emitir não obriga a redigitar tudo', () => {
  /* Nada foi emitido: os dados continuam válidos, e mandar recomeçar por um
     erro que não foi da pessoa é castigo sem motivo. */
  const i = js.indexOf('Não foi possível emitir');
  const corpo = js.slice(i, i + 900);
  assert.match(corpo, /Tentar emitir de novo/);
  assert.match(corpo, /Corrigir o valor/);
});

test('documento recusado explica o motivo provável', () => {
  const i = js.indexOf('var digito =');
  assert.ok(i > 0);
  const corpo = js.slice(i, i + 600);
  assert.match(corpo, /um dígito trocado costuma ser a causa/);
  assert.match(corpo, /base pública fora do ar/);
});

test('rejeição da Sefin diz o que aconteceu com o número', () => {
  /* Sem isso a pessoa fica sem saber se pode emitir de novo com os mesmos
     dados, ou se já existe alguma nota por aí. */
  const i = js.indexOf('A nota não foi autorizada');
  const corpo = js.slice(i, i + 400);
  assert.match(corpo, /número desta DPS foi consumido/);
  assert.match(corpo, /Nenhuma nota existe com estes dados/);
});

/* -------------------------------------------- município de emissor próprio */

test('bloqueio de município diz para onde ir', () => {
  /* "O município 4107652 não serve" deixa a pessoa com a nota na mão.
     A mensagem mudou de casa quando o roteamento por município nasceu: mora em
     emissorMunicipal, que é quem sabe se dá para emitir ali. */
  const servico = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'nfse', 'emissorMunicipal.js'), 'utf8');
  const i = servico.indexOf("municipio.modo_emissao === 'proprio'");
  assert.ok(i > 0, 'o bloqueio do emissor próprio precisa continuar existindo');
  const corpo = servico.slice(i, servico.indexOf('\n    return null;', i));
  assert.match(corpo, /municipio\.emissor/, 'o nome do emissor entra na mensagem');
  assert.match(corpo, /municipio\.url_portal/, 'e o endereço também');
  assert.match(corpo, /municipio\.nome/, 'e o nome do município, não só o código');

  /* E quem chama continua devolvendo 422. */
  const emissao = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'emissaoService.js'), 'utf8');
  assert.match(emissao, /conferirPodeEmitir\(mun, empresa\)[\s\S]{0,160}status: 422/);
});

test('o bloqueio acontece antes de reservar número', () => {
  /* Reservar e depois barrar deixaria buraco na sequência fiscal. */
  const servico = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'emissaoService.js'), 'utf8');
  const bloqueio = servico.indexOf("mun.modo_emissao === 'proprio'");
  const reserva = servico.indexOf('reservarNumeracao(empresa.id');
  assert.ok(bloqueio < reserva, 'o guard vem antes da reserva de numeração');
});
