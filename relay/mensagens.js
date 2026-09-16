/* Os textos que o escritório pode escolher, e os padrões quando não escolheu.
 *
 * POR QUE UM MÓDULO SÓ PARA ISSO: os padrões precisam morar num lugar. Estavam
 * espalhados como literais dentro de `conversa.js`, e cada um que virasse
 * configurável ganharia um `|| 'texto de antes'` ao lado — o padrão duplicado
 * em tantos lugares quantos fossem os usos, divergindo no primeiro ajuste.
 *
 * O CONTRATO: cada função recebe o retrato (nome do escritório, telefone,
 * e-mail, e o que o escritório escreveu) e devolve texto pronto. Nenhuma delas
 * decide NADA sobre a conversa — nem o que perguntar, nem o que aceitar, nem
 * quando parar. Elas trocam a forma de dizer; a regra continua em conversa.js.
 *
 * Isso é o que impede o campo de texto de virar programação por acidente: não
 * há como um escritório escrever uma saudação que faça o robô emitir nota de um
 * jeito diferente, porque a saudação nunca sai daqui.
 */

/* ---------------------------------------------------------------- padrões */

const PADRAO_SAUDACAO = 'Atendimento automático para emissão de notas.';
const PADRAO_ESCRITORIO = 'a contabilidade';

/* -------------------------------------------------------------- utilidades */

function texto(v) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s || null;
}

/* ---------------------------------------------------------- apresentação */

/* O bloco que abre a primeira mensagem: quem está falando, e que é um robô.
 *
 * Dizer que é automático continua fixo e não é configurável de propósito. É a
 * primeira regra de conversa por robô e a que mais evita frustração — a pessoa
 * calibra o que pedir. Um escritório que pudesse apagar essa linha estaria
 * comprando uma reclamação com a própria voz. */
function apresentacao(memoria) {
  const casa = texto((memoria.escritorio() || {}).nome);
  if (!casa) return '';

  const bot = memoria.chatbot() || {};
  const linha = texto(bot.saudacao) || PADRAO_SAUDACAO;
  return '*' + casa + '*\n_' + linha + '_\n\n';
}

/* ------------------------------------------------------ saída para gente */

/* A resposta de "quero falar com alguém".
 *
 * Era aqui que o sistema mais dava a impressão de abandono: sem telefone e sem
 * e-mail cadastrados, ele dizia o nome do escritório e mandava a pessoa
 * "procurar pelos canais de sempre" — que é o que ela já estava tentando
 * fazer. Os campos existem no cadastro desde sempre; o que faltava era o
 * instalador preenchê-los. */
function falarComGente(memoria, formatarTelefone) {
  const casa = memoria.escritorio() || {};
  const bot = memoria.chatbot() || {};

  const nome = texto(casa.nome) || PADRAO_ESCRITORIO;
  const atendente = texto(bot.atendente);
  const horario = texto(bot.horario);

  /* "fale com Maria, da Contabilidade X" é melhor que "fale com a
     Contabilidade X" — a pessoa passa a ter um nome a pedir no telefone. */
  const destino = atendente ? atendente + ', d' +
    (nome === PADRAO_ESCRITORIO ? 'a contabilidade' : 'e ' + nome) : nome;

  const contatos = [];
  if (texto(casa.telefone)) contatos.push('📞 ' + formatarTelefone(casa.telefone));
  if (texto(casa.email)) contatos.push('✉ ' + casa.email);

  let r = 'Claro. Eu sou automático e só sei emitir nota — para o resto, ' +
          'fale direto com ' + destino + ':';

  if (contatos.length) r += '\n\n' + contatos.join('\n');
  else r += '\n\nprocure o escritório pelos canais de sempre.';

  /* O horário vai depois do contato e nunca no lugar dele: é informativo. O
     robô continua atendendo fora dele — recusar de madrugada para parecer
     humano seria piorar o serviço de propósito. */
  if (horario) r += '\n\n_Atendimento humano: ' + horario + '._';

  return r;
}

module.exports = {
  apresentacao,
  falarComGente,
  PADRAO_SAUDACAO,
  PADRAO_ESCRITORIO
};
