const express = require('express');
const municipios = require('../services/municipiosService');

const router = express.Router();

/* Listar municípios classificados */
router.get('/', async (_req, res, next) => {
  try {
    res.json(await municipios.listar());
  } catch (e) { next(e); }
});

/* Detalhar um município */
router.get('/:codigo', async (req, res, next) => {
  try {
    const m = await municipios.obter(req.params.codigo);
    if (!m) return res.status(404).json({ erro: 'Município não classificado' });
    res.json(m);
  } catch (e) { next(e); }
});

/* Classificar automaticamente consultando o ADN.
   Body: { cnpjEmpresa, ambiente? } — o certificado dessa empresa é usado na consulta. */
router.post('/:codigo/classificar', async (req, res, next) => {
  try {
    const b = req.body || {};
    const m = await municipios.classificar(req.params.codigo, b.cnpjEmpresa, b.ambiente || 'homologacao');
    res.json(m);
  } catch (e) { next(e); }
});

/* Definir/atualizar manualmente.
   Body: { modoEmissao: 'nacional'|'proprio'|'desconhecido', nome?, uf?, aliquotaIss? } */
router.put('/:codigo', async (req, res, next) => {
  try {
    const m = await municipios.definirManual(req.params.codigo, req.body || {});
    res.json(m);
  } catch (e) { next(e); }
});

module.exports = router;
