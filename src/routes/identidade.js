const express = require('express');
const multer = require('multer');
const identidade = require('../services/identidade');
const auditoria = require('../services/auditoria');
const { somenteAdmin } = require('../middleware/escopo');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: identidade.LIMITE_BYTES }
});

router.get('/', async (_req, res, next) => {
  try {
    res.json(await identidade.ler());
  } catch (e) { next(e); }
});

router.put('/', somenteAdmin, async (req, res, next) => {
  try {
    const salvo = await identidade.salvar(req.body || {});
    await auditoria.registrar(req, null, 'identidade.alterada',
      'Alterou a identidade visual do escritório');
    res.json(salvo);
  } catch (e) { next(e); }
});

router.post('/logo', somenteAdmin, upload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Escolha um arquivo de imagem.' });
    const r = await identidade.salvarLogo(req.file.buffer);
    await auditoria.registrar(req, null, 'identidade.logo',
      'Trocou a logo do escritório', { detalhe: { tipo: r.tipo, bytes: r.bytes } });
    res.json(r);
  } catch (e) { next(e); }
});

router.delete('/logo', somenteAdmin, async (req, res, next) => {
  try {
    await identidade.removerLogo();
    await auditoria.registrar(req, null, 'identidade.logo', 'Removeu a logo do escritório');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
