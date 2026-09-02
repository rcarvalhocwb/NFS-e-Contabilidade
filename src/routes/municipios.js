const express = require('express');
const db = require('../db');
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
/* Confirmar que o município com provedor próprio está pronto para emitir.
 *
 * A trava existe porque um endereço de webservice não testado é palpite, e
 * palpite errado reserva número, assina a DPS e falha — deixando buraco na
 * sequência fiscal. Quem confirma assume que o credenciamento na prefeitura
 * foi feito; o nome fica registrado. */
router.post('/:codigo/confirmar-emissor', async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo).replace(/\D/g, '');
    const confirmado = (req.body || {}).confirmado !== false;
    const quem = require('../services/auditoria').autorDe(req);

    const r = await db.query(
      `UPDATE municipios
          SET emissor_confirmado = $2,
              emissor_confirmado_em = CASE WHEN $2 THEN now() ELSE NULL END,
              emissor_confirmado_por = CASE WHEN $2 THEN $3::text ELSE NULL END,
              atualizado_em = now()
        WHERE codigo_municipio = $1 RETURNING *`, [codigo, confirmado, quem.autor]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Município não cadastrado' });

    await require('../services/auditoria').registrar(req, null, 'municipio.emissor',
      (confirmado ? 'Confirmou' : 'Retirou a confirmação de') +
      ' que ' + (r.rows[0].nome || codigo) + ' está credenciado para emitir pelo ' +
      (r.rows[0].provedor || 'sefin'));
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:codigo', async (req, res, next) => {
  try {
    const m = await municipios.definirManual(req.params.codigo, req.body || {});
    res.json(m);
  } catch (e) { next(e); }
});

module.exports = router;
