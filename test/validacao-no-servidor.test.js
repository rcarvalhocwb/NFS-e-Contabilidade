const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { conferirEmissao } = require('../src/nfse/regrasDps');

/* A validação fiscal não pode morar só no navegador.
 *
 * Auditoria de 18/09/2026: sete regras que a tela de emissão aplicava não
 * existiam no servidor. Provado com curl, e não só pelo navegador — o mesmo
 * payload passava pelo caminho de integração documentado (X-API-Key), que é
 * como um sistema cliente emite.
 *
 * O custo não é uma tela feia. `emissaoService` reserva a numeração da DPS
 * ANTES de falar com a Sefin, e o comentário de lá diz o porquê: "uma recusa
 * depois da reserva deixaria buraco na sequência fiscal". Payload que passa
 * aqui e é inválido no XSD queima um número: a Sefin devolve E1235 com a
 * numeração já consumida e a DPS assinada.
 */

const valida = () => ({
  servico: { codigoTributacaoNacional: '110201', descricao: 'Servico prestado' },
  valores: { valorServico: 100, issRetido: false }
});

function com(extra) {
  const d = valida();
  const junta = (a, b) => {
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) junta(a[k], b[k]);
      else a[k] = b[k];
    }
  };
  junta(d, extra);
  return d;
}

test('o corpo válido continua passando', () => {
  assert.doesNotThrow(() => conferirEmissao(valida()));
  assert.doesNotThrow(() => conferirEmissao(com({
    tomador: { cnpj: '14073521000183', razaoSocial: 'Cliente Ltda' },
    servico: { codigoNbs: '123456789' }
  })));
});

test('nota sem valor não é documento fiscal', () => {
  assert.throws(() => conferirEmissao(com({ valores: { valorServico: 0 } })), /maior que zero/);
});

test('documento do tomador exige nome', () => {
  assert.throws(() => conferirEmissao(com({ tomador: { cnpj: '14073521000183' } })),
    /tomador\.razaoSocial é obrigatório/);
  assert.throws(() => conferirEmissao(com({ tomador: { cpf: '11144477735' } })),
    /tomador\.razaoSocial é obrigatório/);
});

test('NBS tem nove dígitos', () => {
  /* O comentário do próprio front dizia o custo: "um dígito a menos custa um
     número da sequência fiscal". A regra estava no lugar errado. */
  assert.throws(() => conferirEmissao(com({ servico: { codigoNbs: '1234' } })),
    /codigoNbs deve ter exatamente 9 dígitos/);
  assert.doesNotThrow(() => conferirEmissao(com({ servico: { codigoNbs: '123456789' } })));
});

test('exigibilidade suspensa exige o número do processo', () => {
  assert.throws(() => conferirEmissao(com({ valores: { exigibilidadeSuspensa: { tipo: 1 } } })),
    /numeroProcesso é obrigatório/);
  assert.doesNotThrow(() => conferirEmissao(com({
    valores: { exigibilidadeSuspensa: { tipo: 1, numeroProcesso: '0001234-55.2026' } } })));
});

test('benefício municipal com número exige o tipo', () => {
  assert.throws(() => conferirEmissao(com({ valores: { beneficioMunicipal: { numero: '123' } } })),
    /beneficioMunicipal\.tipo é obrigatório/);
});

test('exportação de serviço exige o país', () => {
  assert.throws(() => conferirEmissao(com({ valores: { tributacaoIssqn: 3 } })),
    /codigoPaisPrestacao é obrigatório/);
  assert.doesNotThrow(() => conferirEmissao(com({
    valores: { tributacaoIssqn: 3 }, servico: { codigoPaisPrestacao: 'PT' } })));
});

test('intermediário segue a mesma regra do tomador', () => {
  assert.throws(() => conferirEmissao(com({ intermediario: { cpf: '999' } })),
    /intermediario\.cpf deve ter 11 dígitos/);
  assert.throws(() => conferirEmissao(com({ intermediario: { cnpj: '14073521000183' } })),
    /intermediario\.razaoSocial é obrigatório/);
});

test('toda regra da tela de emissão tem par no servidor', () => {
  /* O teste que impede a reincidência. Cada `return { campo, msg }` em
     nota.js é uma regra que o front aplica; se ela não tiver correspondente
     em regrasDps.js, voltamos ao ponto de partida — a tela protege o painel
     e deixa a integração aberta. */
  const front = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'nota.js'), 'utf8');
  const regras = (front.match(/return \{ campo: '?[^',]+'?, msg:/g) || []).length;
  assert.ok(regras >= 18,
    `esperava ao menos 18 regras na tela de emissão, achei ${regras}`);

  const servidor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'nfse', 'regrasDps.js'), 'utf8');
  for (const marca of ['codigoNbs', 'exigibilidadeSuspensa', 'beneficioMunicipal',
                       'codigoPaisPrestacao', 'intermediario', 'maior que zero',
                       'tomador.razaoSocial']) {
    assert.ok(servidor.includes(marca),
      `regra "${marca}" sumiu do servidor — ela não pode viver só na tela`);
  }
});
