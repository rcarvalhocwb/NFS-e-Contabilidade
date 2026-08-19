/* Trilha de auditoria.
 *
 * O escritório responde por documento fiscal de terceiros. Quando o cliente
 * pergunta "quem cancelou a nota 1231, e por quê?", a resposta precisa existir.
 * A emissão já guardava o usuário; cancelar, trocar certificado e ligar
 * produção não guardavam nada.
 *
 * Duas regras que valem para todo este arquivo:
 *
 * 1. Registrar nunca derruba a ação. Se a auditoria falhar, a nota já foi
 *    cancelada de verdade — abortar aqui não desfaz nada e ainda esconde o que
 *    aconteceu. O erro vai para o log e a vida segue.
 *
 * 2. Nada de segredo no detalhe. Senha, token e conteúdo de certificado não
 *    entram: a trilha é lida por mais gente do que os dados que ela descreve.
 */
const db = require('../db');

/* Descrição curta de quem agiu, resistente à exclusão da conta depois. */
function autorDe(req) {
  if (!req || !req.auth) return { autor: 'sistema', origem: 'sistema', usuarioId: null };
  if (req.auth.tipo === 'usuario') {
    return { autor: req.auth.email || `usuário ${req.auth.usuarioId}`,
             origem: 'painel', usuarioId: req.auth.usuarioId };
  }
  if (req.auth.tipo === 'empresa') {
    return { autor: `integração (${req.auth.cnpj})`, origem: 'api', usuarioId: null };
  }
  return { autor: 'chave de instalação', origem: 'api', usuarioId: null };
}

/* Campos que não podem entrar no detalhe, venham de onde vierem. */
const PROIBIDOS = /senha|password|token|pfx|certificad|chave|secret|masterkey/i;

function limpar(detalhe) {
  if (!detalhe || typeof detalhe !== 'object') return null;
  const saida = {};
  for (const [k, v] of Object.entries(detalhe)) {
    if (PROIBIDOS.test(k)) continue;
    if (v === undefined) continue;
    saida[k] = typeof v === 'object' && v !== null ? limpar(v) : v;
  }
  return Object.keys(saida).length ? saida : null;
}

/**
 * Registra uma ação na trilha.
 *
 * @param req        requisição, para saber quem agiu (pode ser null)
 * @param empresaId  cliente afetado, ou null
 * @param acao       identificador curto: 'nota.cancelada', 'empresa.ambiente'
 * @param descricao  frase pronta para a tela, em português
 * @param extra      { referencia, detalhe }
 */
async function registrar(req, empresaId, acao, descricao, extra = {}) {
  try {
    const quem = autorDe(req);
    await db.query(
      `INSERT INTO auditoria (usuario_id, autor, origem, ip, empresa_id,
                              acao, descricao, referencia, detalhe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [quem.usuarioId, quem.autor, quem.origem,
       req && req.ip ? String(req.ip).slice(0, 45) : null,
       empresaId || null, acao, descricao,
       extra.referencia ? String(extra.referencia).slice(0, 60) : null,
       extra.detalhe ? JSON.stringify(limpar(extra.detalhe)) : null]
    );
  } catch (e) {
    // Ver regra 1 no topo: a ação já aconteceu.
    console.error('[auditoria] não foi possível registrar', acao + ':', e.message);
  }
}

/* Histórico de um cliente, do mais recente para o mais antigo. */
async function historico(empresaId, { limite = 100, antesDe = null, acao = null } = {}) {
  const params = [empresaId];
  let filtro = '';
  if (antesDe) { params.push(antesDe); filtro += ` AND ocorrido_em < $${params.length}`; }
  if (acao)    { params.push(acao + '%'); filtro += ` AND acao LIKE $${params.length}`; }
  params.push(Math.min(Number(limite) || 100, 500));

  const r = await db.query(
    `SELECT id, ocorrido_em, autor, origem, acao, descricao, referencia, detalhe
       FROM auditoria
      WHERE empresa_id = $1${filtro}
      ORDER BY ocorrido_em DESC, id DESC
      LIMIT $${params.length}`, params);
  return r.rows;
}

module.exports = { registrar, historico, autorDe };
