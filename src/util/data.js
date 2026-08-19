/* Datas no fuso de quem emite.
 *
 * `new Date().toISOString().slice(0,10)` devolve a data em UTC. No horário de
 * Brasília (UTC-3) isso vira o dia seguinte a partir das 21h — e o gateway da
 * contabilidade emite à noite como qualquer outro dia de trabalho.
 *
 * Onde isso importava mais: a competência da nota (dCompet), que define o mês
 * de apuração do ISS. Uma nota emitida em 31/01 às 21h30 saía com competência
 * 01/02 — escriturada no mês errado, num campo que a Sefin aceita sem
 * reclamar, porque a data é válida; só não é a certa.
 *
 * A data local da máquina é a resposta correta: o gateway roda no
 * estabelecimento do prestador, então o fuso da máquina é o fuso do fato
 * gerador. Vale para o Acre (UTC-5) tanto quanto para Curitiba.
 */

function doisDigitos(n) { return String(n).padStart(2, '0'); }

/** Data local no formato YYYY-MM-DD. */
function dataLocalISO(d = new Date()) {
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

/** Primeiro dia do mês corrente, YYYY-MM-DD, no fuso local. */
function primeiroDiaDoMes(d = new Date()) {
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-01`;
}

/** Data e hora local com o deslocamento explícito (2026-08-19T21:30:00-03:00).
 *  É o formato que a Sefin espera em dhEmi e dhEvento. */
function dataHoraLocalISO(d = new Date()) {
  const tz = -d.getTimezoneOffset();
  const sinal = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${dataLocalISO(d)}T${doisDigitos(d.getHours())}:${doisDigitos(d.getMinutes())}:` +
         `${doisDigitos(d.getSeconds())}${sinal}${doisDigitos(Math.floor(abs / 60))}:` +
         `${doisDigitos(abs % 60)}`;
}

module.exports = { dataLocalISO, primeiroDiaDoMes, dataHoraLocalISO };
