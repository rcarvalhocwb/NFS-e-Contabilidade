const test = require('node:test');
const assert = require('node:assert');
const { calcularVencimento, competenciaVale, proximasCompetencias } =
  require('../src/services/obrigacoes');

/* Calendário de obrigações.
 *
 * O que este módulo calcula vira o prazo que o escritório vê na tela — e prazo
 * errado em obrigação acessória custa multa ao cliente. Os casos abaixo são os
 * que quebram uma implementação ingênua: mês curto, virada de ano e as
 * periodicidades que não são mensais.
 *
 * Os prazos em si NÃO são responsabilidade deste código: quem cadastra o dia é
 * o escritório. O que se testa aqui é a aritmética do calendário. */

const MENSAL_DIA_20 = { periodicidade: 'mensal', dia_vencimento: 20, desloca_meses: 1 };

test('competência de agosto vence em setembro', () => {
  // O DAS de agosto vence em 20/09: deslocamento de um mês
  assert.equal(calcularVencimento('2026-08', MENSAL_DIA_20), '2026-09-20');
});

test('sem deslocamento, vence no próprio mês', () => {
  assert.equal(calcularVencimento('2026-08',
    { periodicidade: 'mensal', dia_vencimento: 10, desloca_meses: 0 }), '2026-08-10');
});

test('a virada de ano não perde o mês', () => {
  assert.equal(calcularVencimento('2026-12', MENSAL_DIA_20), '2027-01-20');
});

test('dia 31 num mês de 30 cai no último dia, não escorrega', () => {
  // Sem o ajuste, o Date rolaria para 01/05 — e o prazo apareceria no mês errado
  assert.equal(calcularVencimento('2026-03',
    { periodicidade: 'mensal', dia_vencimento: 31, desloca_meses: 1 }), '2026-04-30');
});

test('dia 30 em fevereiro cai em 28', () => {
  assert.equal(calcularVencimento('2026-01',
    { periodicidade: 'mensal', dia_vencimento: 30, desloca_meses: 1 }), '2026-02-28');
});

test('fevereiro de ano bissexto tem 29', () => {
  assert.equal(calcularVencimento('2028-01',
    { periodicidade: 'mensal', dia_vencimento: 31, desloca_meses: 1 }), '2028-02-29');
});

test('aceita os nomes em camelCase, como vêm do formulário', () => {
  assert.equal(calcularVencimento('2026-08',
    { periodicidade: 'mensal', diaVencimento: 15, deslocaMeses: 1 }), '2026-09-15');
});

/* --------------------------------------------------- periodicidade */

test('mensal vale para toda competência', () => {
  for (const mes of ['01', '06', '12']) {
    assert.ok(competenciaVale('2026-' + mes, { periodicidade: 'mensal' }));
  }
});

test('trimestral só fecha em março, junho, setembro e dezembro', () => {
  const t = { periodicidade: 'trimestral' };
  assert.ok(competenciaVale('2026-03', t));
  assert.ok(competenciaVale('2026-12', t));
  assert.ok(!competenciaVale('2026-01', t));
  assert.ok(!competenciaVale('2026-08', t));
});

test('anual vale só no mês configurado', () => {
  const a = { periodicidade: 'anual', mes_vencimento: 5 };
  assert.ok(competenciaVale('2026-05', a));
  assert.ok(!competenciaVale('2026-06', a));
});

test('obrigação avulsa não se repete sozinha', () => {
  // 'unica' é criada à mão; a geração automática não deve inventá-la
  assert.ok(!competenciaVale('2026-08', { periodicidade: 'unica' }));
});

/* --------------------------------------------------- horizonte */

test('as competências vão do mês corrente para a frente', () => {
  const lista = proximasCompetencias(3, new Date(2026, 7, 19));
  assert.deepEqual(lista, ['2026-08', '2026-09', '2026-10', '2026-11']);
});

test('o horizonte atravessa a virada de ano', () => {
  const lista = proximasCompetencias(2, new Date(2026, 10, 15));
  assert.deepEqual(lista, ['2026-11', '2026-12', '2027-01']);
});
