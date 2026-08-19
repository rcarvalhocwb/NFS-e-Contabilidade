const test = require('node:test');
const assert = require('node:assert');
const { dataLocalISO, primeiroDiaDoMes, dataHoraLocalISO } = require('../src/util/data');

/* Datas no fuso de quem emite.
 *
 * `new Date().toISOString().slice(0,10)` devolve a data em UTC. No horário de
 * Brasília (UTC-3) isso vira o dia seguinte a partir das 21h — e a contabilidade
 * emite à noite como em qualquer outro horário de trabalho.
 *
 * O campo que mais doía era dCompet, a competência: define o mês de apuração do
 * ISS. Uma nota emitida em 31/01 às 21h30 saía com competência 01/02,
 * escriturada no mês errado. A Sefin aceita sem reclamar, porque a data é
 * válida — só não é a certa. */

/* Roda uma função com o relógio parado num instante. */
function em(instanteIso, fn) {
  const Real = Date;
  const alvo = new Real(instanteIso);
  global.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [alvo])); }
    static now() { return alvo.getTime(); }
  };
  try { return fn(); } finally { global.Date = Real; }
}

const brasilia = process.env.TZ === 'America/Sao_Paulo' ||
                 new Date('2026-08-19T12:00:00Z').getHours() === 9;

test('à noite, a data local não avança para o dia seguinte', { skip: !brasilia }, () => {
  const d = new Date('2026-08-19T22:10:00-03:00');
  assert.equal(dataLocalISO(d), '2026-08-19');
  assert.equal(d.toISOString().slice(0, 10), '2026-08-20', 'confirma que UTC avança');
});

test('na virada do mês, a competência fica no mês certo', { skip: !brasilia }, () => {
  // O caso caro: nota de janeiro escriturada em fevereiro
  const d = new Date('2026-01-31T21:30:00-03:00');
  assert.equal(dataLocalISO(d), '2026-01-31');
});

test('na virada do ano também', { skip: !brasilia }, () => {
  assert.equal(dataLocalISO(new Date('2026-12-31T23:00:00-03:00')), '2026-12-31');
});

test('de dia, nada muda', () => {
  const d = new Date(2026, 7, 19, 14, 0, 0);
  assert.equal(dataLocalISO(d), '2026-08-19');
});

test('dia e mês saem com dois dígitos', () => {
  assert.equal(dataLocalISO(new Date(2026, 0, 5)), '2026-01-05');
});

test('primeiro dia do mês acompanha o fuso local', { skip: !brasilia }, () => {
  assert.equal(primeiroDiaDoMes(new Date('2026-03-31T22:00:00-03:00')), '2026-03-01');
  // Sem o cuidado, um relatório aberto à noite no dia 31 pediria abril
});

test('sem argumento, usa o agora', () => {
  const agora = new Date();
  assert.equal(dataLocalISO(), dataLocalISO(agora));
});

test('data e hora levam o deslocamento do fuso', { skip: !brasilia }, () => {
  const s = dataHoraLocalISO(new Date('2026-08-19T14:30:05-03:00'));
  assert.match(s, /^2026-08-19T14:30:05-03:00$/);
});

test('a competência da DPS usa a data local', { skip: !brasilia }, () => {
  const { montarDps } = require('../src/nfse/dpsBuilder');
  const xml = em('2026-01-31T22:30:00-03:00', () => montarDps(
    { cnpj: '21583854000118', codigo_municipio: '4106902', uf: 'PR',
      op_simp_nac: 3, reg_esp_trib: 0, omitir_im: true },
    { tomador: { cnpj: '14073521000183', razaoSocial: 'X' },
      servico: { codigoTributacaoNacional: '110201', descricao: 'S',
                 codigoMunicipioPrestacao: '4106902' },
      valores: { valorServico: 10 }, tributacaoIssqn: 1 },
    { tpAmb: '1', verAplic: 't', idDps: 'D', serie: '1', numero: 1 }));

  assert.match(xml, /<dCompet>2026-01-31<\/dCompet>/,
    'nota de 31/01 às 22h30 pertence a janeiro');
});

test('competência informada pelo chamador prevalece', () => {
  const { montarDps } = require('../src/nfse/dpsBuilder');
  const xml = montarDps(
    { cnpj: '21583854000118', codigo_municipio: '4106902', uf: 'PR',
      op_simp_nac: 3, reg_esp_trib: 0, omitir_im: true },
    { dataCompetencia: '2026-07-01',
      tomador: { cnpj: '14073521000183', razaoSocial: 'X' },
      servico: { codigoTributacaoNacional: '110201', descricao: 'S',
                 codigoMunicipioPrestacao: '4106902' },
      valores: { valorServico: 10 }, tributacaoIssqn: 1 },
    { tpAmb: '1', verAplic: 't', idDps: 'D', serie: '1', numero: 1 });
  assert.match(xml, /<dCompet>2026-07-01<\/dCompet>/);
});
