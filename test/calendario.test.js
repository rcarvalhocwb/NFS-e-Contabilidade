const test = require('node:test');
const assert = require('node:assert');
const { montarIcs } = require('../src/util/calendario');

/* Compromissos em iCalendar (.ics).
 *
 * É como o prazo chega ao celular: o arquivo vai anexado ao aviso por e-mail,
 * o contador toca uma vez e o compromisso entra na agenda com alarme. Um erro
 * de formato aqui não dá erro visível — a agenda simplesmente ignora o arquivo,
 * e o aviso que deveria chegar ao celular nunca chega. */

const EVENTO = {
  id: 'obrigacao-42',
  titulo: 'DAS — Simples Nacional · RECALCATTI',
  descricao: 'Competência 2026-08. Conferir no painel do gateway.',
  data: '2026-09-20'
};

test('gera um calendário que começa e termina como o RFC pede', () => {
  const ics = montarIcs([EVENTO]);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /VERSION:2\.0/);
});

test('as linhas terminam em CRLF', () => {
  // Agenda rigorosa recusa o arquivo inteiro com LF sozinho
  const ics = montarIcs([EVENTO]);
  const soLf = ics.split('\r\n').join('').includes('\n');
  assert.ok(!soLf, 'não pode sobrar quebra de linha sem CR');
});

test('o prazo é um compromisso de dia inteiro', () => {
  // Prazo é do dia, não das 9h do dia
  const ics = montarIcs([EVENTO]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260920/);
  assert.match(ics, /DTEND;VALUE=DATE:20260921/, 'o fim é o dia seguinte');
  assert.ok(!/DTSTART:\d{8}T/.test(ics), 'não pode virar compromisso com hora');
});

test('leva alarme, que é o que faz o celular avisar', () => {
  const ics = montarIcs([EVENTO]);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(ics, /TRIGGER:-P1D/, 'um dia antes por padrão');
  assert.match(ics, /ACTION:DISPLAY/);
});

test('a antecedência do alarme é configurável', () => {
  const ics = montarIcs([Object.assign({}, EVENTO, { alarmeDias: 5 })]);
  assert.match(ics, /TRIGGER:-P5D/);
});

test('o mesmo prazo reenviado atualiza, não duplica', () => {
  /* UID estável é o que faz a agenda reconhecer o compromisso. Sem isso, cada
     lembrete criaria uma cópia nova e a agenda do contador viraria lixo. */
  const a = montarIcs([EVENTO]);
  const b = montarIcs([EVENTO]);
  const uid = t => t.match(/UID:(.+)/)[1];
  assert.equal(uid(a), uid(b));
  assert.match(uid(a), /obrigacao-42/);
});

test('ponto e vírgula e vírgula no texto não cortam o campo', () => {
  // Têm significado no formato: sem escape, o resto do título vira outro campo
  const ics = montarIcs([Object.assign({}, EVENTO, {
    titulo: 'ISS; retenção, conferir'
  })]);
  assert.match(ics, /SUMMARY:ISS\\; retenção\\, conferir/);
});

test('quebra de linha na descrição vira \\n, não uma linha nova', () => {
  const ics = montarIcs([Object.assign({}, EVENTO, {
    descricao: 'Primeira linha\nSegunda linha'
  })]);
  assert.match(ics, /DESCRIPTION:Primeira linha\\nSegunda linha/);
  assert.ok(!/DESCRIPTION:Primeira linha\r\nSegunda/.test(ics));
});

test('linha longa é dobrada com espaço na continuação', () => {
  const ics = montarIcs([Object.assign({}, EVENTO, {
    titulo: 'Obrigação com um título bastante longo para ultrapassar o limite de ' +
            'setenta e cinco octetos que o RFC 5545 estabelece por linha'
  })]);
  for (const linha of ics.split('\r\n')) {
    assert.ok(Buffer.from(linha, 'utf8').length <= 76,
      'linha com ' + Buffer.from(linha, 'utf8').length + ' octetos: ' + linha.slice(0, 40));
  }
  assert.match(ics, /\r\n [^\r\n]/, 'a continuação começa com espaço');
});

test('vários prazos cabem num arquivo só', () => {
  const ics = montarIcs([
    EVENTO,
    { id: 'obrigacao-43', titulo: 'ISS próprio', data: '2026-09-10' }
  ]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/END:VCALENDAR/g) || []).length, 1);
});

test('prazo não ocupa a agenda como reunião', () => {
  // TRANSPARENT: quem olha a agenda continua parecendo livre naquele dia
  assert.match(montarIcs([EVENTO]), /TRANSP:TRANSPARENT/);
});

test('aceita Date além de texto', () => {
  /* O driver do Postgres devolve coluna DATE como objeto Date. Recortar os dez
     primeiros caracteres dele dá "Thu Sep 10", e a data sai NaNNaNNaN no
     arquivo — que a agenda ignora em silêncio, sem erro nenhum. Aconteceu no
     primeiro teste com dados reais. */
  const ics = montarIcs([Object.assign({}, EVENTO, { data: new Date(2026, 8, 20) })]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260920/);
  assert.ok(!ics.includes('NaN'), 'nenhuma data pode sair como NaN');
});

test('nenhum formato de data aceito produz NaN', () => {
  for (const data of ['2026-09-20', new Date(2026, 8, 20), new Date('2026-09-20T12:00:00')]) {
    const ics = montarIcs([Object.assign({}, EVENTO, { data })]);
    assert.ok(!ics.includes('NaN'), 'entrada ' + data + ' produziu NaN');
  }
});
