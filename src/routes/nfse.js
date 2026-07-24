const express = require('express');
const db = require('../db');
const { emitir, consultar, cancelar } = require('../services/emissaoService');

const router = express.Router();

/* Emitir NFS-e.
   Body: { cnpjEmpresa, dataCompetencia, tomador{...}, servico{...}, valores{...} } */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'cnpjEmpresa é obrigatório' });
    if (!b.servico || !b.servico.codigoTributacaoNacional || !b.servico.descricao) {
      return res.status(400).json({ erro: 'servico.codigoTributacaoNacional e servico.descricao são obrigatórios' });
    }
    if (!b.valores || b.valores.valorServico === undefined) {
      return res.status(400).json({ erro: 'valores.valorServico é obrigatório' });
    }
    if (b.referencia !== undefined && !/^[\w.:-]{1,100}$/.test(String(b.referencia))) {
      return res.status(400).json({ erro: 'referencia deve ter até 100 caracteres (letras, números, . : _ -)' });
    }
    const resultado = await emitir(b.cnpjEmpresa, b);
    // 200 (e não 201) quando a referência já existia: nada foi criado agora.
    const codigo = resultado.idempotente
      ? 200
      : (resultado.status === 'autorizada' ? 201 : 422);
    res.status(codigo).json(resultado);
  } catch (e) { next(e); }
});

/* Listar notas locais (filtros: cnpjEmpresa, status, limite) */
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.cnpjEmpresa) {
      params.push(String(req.query.cnpjEmpresa).replace(/\D/g, ''));
      where += ` AND e.cnpj = $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND n.status = $${params.length}`;
    }
    if (req.query.ambiente) {
      params.push(req.query.ambiente);
      where += ` AND n.ambiente = $${params.length}`;
    }
    if (req.query.referencia) {
      params.push(req.query.referencia);
      where += ` AND n.referencia = $${params.length}`;
    }
    params.push(Math.min(parseInt(req.query.limite || '50', 10), 500));
    const r = await db.query(
      `SELECT n.id, e.cnpj AS cnpj_empresa, n.id_dps, n.chave_acesso, n.serie, n.numero,
              n.referencia, n.ambiente,
              n.status, n.mensagens, n.criado_em, n.atualizado_em
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
       WHERE ${where} ORDER BY n.id DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Detalhar nota local (inclui XMLs) */
router.get('/local/:id', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT n.*, e.cnpj AS cnpj_empresa FROM notas n
       JOIN empresas e ON e.id = n.empresa_id WHERE n.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Nota não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Consultar NFS-e na Sefin Nacional pela chave de acesso */
router.get('/:chaveAcesso', async (req, res, next) => {
  try {
    const cnpjEmpresa = req.query.cnpjEmpresa;
    if (!cnpjEmpresa) return res.status(400).json({ erro: 'Informe ?cnpjEmpresa= (certificado usado na consulta)' });
    res.json(await consultar(cnpjEmpresa, req.params.chaveAcesso));
  } catch (e) { next(e); }
});

/* Cancelar NFS-e.
   Body: { cnpjEmpresa, codigoMotivo (1=erro emissão, 2=serviço não prestado, 9=outros), motivo } */
router.post('/:chaveAcesso/cancelamento', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'cnpjEmpresa é obrigatório' });
    if (Number(b.codigoMotivo) === 9 && !b.motivo) {
      return res.status(400).json({ erro: 'motivo é obrigatório quando codigoMotivo = 9' });
    }
    const resultado = await cancelar(b.cnpjEmpresa, req.params.chaveAcesso, b);
    res.status(resultado.cancelada ? 200 : 422).json(resultado);
  } catch (e) { next(e); }
});

module.exports = router;
