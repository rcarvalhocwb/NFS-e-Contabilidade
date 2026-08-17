const express = require('express');
const db = require('../db');
const { validarUrl } = require('../services/webhooks');

const router = express.Router();

/* A chave de autorização é segredo: nunca sai nas listagens, só indicamos
   se está definida. */
const CAMPOS = `id, empresa_id, evento, url, ambiente, header_autorizacao,
                (chave_autorizacao IS NOT NULL) AS tem_chave, ativo, criado_em`;

async function empresaIdPorCnpj(cnpj) {
  if (!cnpj) return null;
  const r = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
    [limparDocumento(cnpj)]);
  if (!r.rows.length) throw Object.assign(new Error('Empresa não encontrada'), { status: 404 });
  return r.rows[0].id;
}

/* Listar */
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.cnpjEmpresa) {
      params.push(await empresaIdPorCnpj(req.query.cnpjEmpresa));
      where += ` AND empresa_id = $${params.length}`;
    }
    const r = await db.query(
      `SELECT ${CAMPOS} FROM webhooks WHERE ${where} ORDER BY id`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Criar.
   Body: { url, cnpjEmpresa?, ambiente?, headerAutorizacao?, chaveAutorizacao? }
   Sem cnpjEmpresa vale para todas as empresas; sem ambiente vale para os dois. */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.url) return res.status(400).json({ erro: 'url é obrigatória' });
    validarUrl(b.url);
    if (b.ambiente && !['producao', 'homologacao'].includes(b.ambiente)) {
      return res.status(400).json({ erro: "ambiente deve ser 'producao' ou 'homologacao'" });
    }
    if (b.chaveAutorizacao && !b.headerAutorizacao) {
      return res.status(400).json({ erro: 'headerAutorizacao é obrigatório quando há chaveAutorizacao' });
    }
    const empresaId = await empresaIdPorCnpj(b.cnpjEmpresa);
    const r = await db.query(
      `INSERT INTO webhooks (empresa_id, evento, url, ambiente, header_autorizacao, chave_autorizacao)
       VALUES ($1,'nfse',$2,$3,$4,$5) RETURNING ${CAMPOS}`,
      [empresaId, b.url, b.ambiente || null,
       b.headerAutorizacao || null, b.chaveAutorizacao || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Atualizar */
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.url) validarUrl(b.url);
    const r = await db.query(
      `UPDATE webhooks SET
         url                = COALESCE($2, url),
         ambiente           = COALESCE($3, ambiente),
         header_autorizacao = COALESCE($4, header_autorizacao),
         chave_autorizacao  = COALESCE($5, chave_autorizacao),
         ativo              = COALESCE($6, ativo),
         atualizado_em      = now()
       WHERE id = $1 RETURNING ${CAMPOS}`,
      [req.params.id, b.url ?? null, b.ambiente ?? null,
       b.headerAutorizacao ?? null, b.chaveAutorizacao ?? null,
       typeof b.ativo === 'boolean' ? b.ativo : null]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Webhook não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Remover */
router.delete('/:id', async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM webhooks WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Webhook não encontrado' });
    res.status(204).end();
  } catch (e) { next(e); }
});

/* Histórico de entregas — para diagnosticar por que uma notificação não chegou */
router.get('/entregas', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.status) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
    if (req.query.notaId) { params.push(req.query.notaId); where += ` AND nota_id = $${params.length}`; }
    params.push(Math.min(parseInt(req.query.limite || '50', 10), 500));
    const r = await db.query(
      `SELECT id, webhook_id, nota_id, evento, status, tentativas, http_status,
              ultimo_erro, processar_apos, criado_em, atualizado_em
       FROM webhook_entregas WHERE ${where}
       ORDER BY id DESC LIMIT $${params.length}`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

module.exports = router;
