/* As palavras do robô.
 *
 * Três campos, todos opcionais, todos apenas sobre COMO se diz — nunca sobre o
 * que o sistema faz. A separação é deliberada: texto configurável que pudesse
 * mudar comportamento viraria, na prática, uma segunda implementação da regra,
 * escrita por quem não sabe que está programando.
 *
 * Nulo significa "use o padrão". Quem decide qual é o padrão é o repassador,
 * em relay/mensagens.js, junto do texto que ele já usava — e não aqui, porque
 * duplicar o padrão nos dois lados garante que um dia eles divirjam.
 */
const db = require('../db');

/* Teto por campo. Uma saudação de dois mil caracteres não é personalização: é
   a primeira mensagem virando parede de texto num aplicativo de celular. */
const LIMITES = { saudacao: 300, atendente: 60, horario: 120 };

async function ler() {
  const r = await db.query(
    'SELECT saudacao, atendente, horario, atualizado_em FROM chatbot WHERE id = TRUE');
  return r.rows[0] || {};
}

function limpar(campo, valor) {
  if (valor === undefined) return undefined;
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  if (s.length > LIMITES[campo]) {
    throw Object.assign(
      new Error('O campo "' + campo + '" passa de ' + LIMITES[campo] + ' caracteres. ' +
                'No WhatsApp isso vira parede de texto.'),
      { status: 400 });
  }
  /* Quebra de linha some: a saudação é UMA linha da primeira mensagem, e um
     Enter colado do Word desmontaria o resto do bloco. */
  return s.replace(/\s*[\r\n]+\s*/g, ' ');
}

async function salvar(dados = {}) {
  const campos = [];
  const valores = [];
  for (const nome of ['saudacao', 'atendente', 'horario']) {
    const v = limpar(nome, dados[nome]);
    if (v === undefined) continue;
    valores.push(v);
    campos.push(nome + ' = $' + valores.length);
  }
  if (!campos.length) return ler();

  await db.query(
    'UPDATE chatbot SET ' + campos.join(', ') + ', atualizado_em = now() WHERE id = TRUE',
    valores);
  return ler();
}

module.exports = { ler, salvar, LIMITES };
