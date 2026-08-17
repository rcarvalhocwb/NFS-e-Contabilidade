const crypto = require('crypto');
const db = require('../db');

const COOKIE = 'nfse_sessao';
const DURACAO_HORAS = 12;

/* O token vai para o cliente; no banco fica só o hash. SHA-256 sem sal basta
   aqui: o token já é aleatório de 32 bytes, não há dicionário a proteger. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function criar(usuarioId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessoes (token_hash, usuario_id, expira_em, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [hashToken(token), usuarioId, String(DURACAO_HORAS),
     (req.ip || '').slice(0, 45), String(req.get('user-agent') || '').slice(0, 500)]);
  return token;
}

/* Devolve o usuário da sessão, ou null. Renova a validade a cada uso para que
   quem está trabalhando não seja deslogado no meio de uma emissão. */
async function usuarioDaSessao(token) {
  if (!token) return null;
  const r = await db.query(
    `UPDATE sessoes SET expira_em = now() + ($2 || ' hours')::interval
      WHERE token_hash = $1 AND expira_em > now()
      RETURNING usuario_id`,
    [hashToken(token), String(DURACAO_HORAS)]);
  if (!r.rows.length) return null;

  const u = await db.query(
    `SELECT id, nome, email, perfil, ativo, trocar_senha FROM usuarios WHERE id = $1`,
    [r.rows[0].usuario_id]);
  const usuario = u.rows[0];
  // Conta desativada enquanto a sessão estava aberta não continua valendo
  if (!usuario || !usuario.ativo) return null;
  return usuario;
}

async function encerrar(token) {
  if (!token) return;
  await db.query('DELETE FROM sessoes WHERE token_hash = $1', [hashToken(token)]);
}

async function encerrarTodasDoUsuario(usuarioId) {
  await db.query('DELETE FROM sessoes WHERE usuario_id = $1', [usuarioId]);
}

async function limparExpiradas() {
  const r = await db.query('DELETE FROM sessoes WHERE expira_em < now()');
  return r.rowCount;
}

/* Express não traz parser de cookie e a única coisa que precisamos ler é este
   valor — não vale uma dependência. */
function tokenDoPedido(req) {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    if (parte.slice(0, igual).trim() === COOKIE) {
      return decodeURIComponent(parte.slice(igual + 1).trim());
    }
  }
  return null;
}

function definirCookie(res, token, seguro) {
  res.cookie(COOKIE, token, {
    httpOnly: true,          // fora do alcance de qualquer script na página
    sameSite: 'lax',
    secure: !!seguro,
    maxAge: DURACAO_HORAS * 3600 * 1000,
    path: '/'
  });
}

function limparCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

module.exports = {
  COOKIE, DURACAO_HORAS,
  criar, usuarioDaSessao, encerrar, encerrarTodasDoUsuario, limparExpiradas,
  tokenDoPedido, definirCookie, limparCookie
};
