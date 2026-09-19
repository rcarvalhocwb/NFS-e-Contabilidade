const crypto = require('crypto');
const db = require('../db');
const sessoes = require('../services/sessoes');

/* Amarra a requisição ao escritório dono dela, antes de qualquer rota.
 *
 * Tem de vir antes de `auth`, e não depois: `auth` lê `sessoes`,
 * `empresa_tokens` e `usuarios`, e as três estão sob policy de RLS. Sem
 * inquilino amarrado, `auth` não acha a sessão de ninguém e todo mundo é
 * anônimo — o sistema não vaza, ele para.
 *
 * DE ONDE SAI O ESCRITÓRIO
 *
 * Do hash da credencial, nunca do que o cliente diz. Um cabeçalho
 * `X-Escritorio` seria conveniente e seria o fim do isolamento: escolher o
 * próprio inquilino é escolher os dados de quem se quer ler. As funções
 * `escritorio_da_sessao` e `escritorio_do_token` (migração 047) fazem a
 * tradução dentro do banco, atravessando RLS de propósito e devolvendo só um
 * inteiro.
 *
 * CREDENCIAL NÃO RECONHECIDA
 *
 * Passa adiante sem inquilino. Recusar aqui com 401 seria dar uma resposta
 * antes de `auth` decidir, e roubaria dele o tratamento que já existe — a
 * página de login, a mensagem certa, o registro da tentativa. Sem inquilino,
 * toda consulta a tabela de cliente volta vazia, então passar adiante não
 * abre nada.
 */

function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}

async function resolver(req) {
  /* Ordem igual à de `auth`, do mais específico para o mais amplo, para que
     as duas camadas nunca discordem sobre qual credencial vale. */
  const cookie = sessoes.tokenDoPedido(req);
  if (cookie) {
    const r = await db.comServidor(() => db.query(
      'SELECT escritorio_da_sessao($1) AS id', [hashToken(cookie)]));
    if (r.rows[0].id) return r.rows[0].id;
  }

  const chave = req.header('X-API-Key');
  if (chave) {
    const r = await db.comServidor(() => db.query(
      'SELECT escritorio_do_token($1) AS id', [hashToken(chave)]));
    if (r.rows[0].id) return r.rows[0].id;
    /* Chave que não bate com token de empresa pode ser a GATEWAY_API_KEY:
       credencial de máquina, igual para todos, que não pertence a escritório
       nenhum. Dar um a ela seria escolher um por ela. Ver abaixo. */
  }

  return null;
}

module.exports = async function inquilino(req, res, next) {
  let escritorio;
  try {
    escritorio = await resolver(req);
  } catch (erro) {
    return next(erro);
  }

  if (!escritorio) return next();

  req.escritorioId = escritorio;

  /* O bloco precisa envolver todo o resto da requisição, e `next()` volta
     antes disso — ele só despacha. A promessa fica aberta até a resposta
     terminar, o que mantém o contexto assíncrono vivo por baixo dos handlers.
     Não segura conexão do pool: `comInquilino` guarda o número, não a
     conexão. Ver o cabeçalho de src/db.js. */
  db.comInquilino(escritorio, () => new Promise(pronto => {
    res.on('finish', pronto);
    res.on('close', pronto);
    next();
  })).catch(next);
};

/* Para a credencial de máquina e para tarefa de manutenção: diz em qual
   escritório operar, explicitamente. Não é middleware de rota — é para quem
   já provou que pode agir em nome do servidor e precisa escolher a casa.
   Rota que use isto tem de conferir a autorização ANTES, porque esta função
   não confere nada: ela obedece. */
module.exports.escolherEscritorio = function escolherEscritorio(id, fn) {
  return db.comInquilino(id, fn);
};
