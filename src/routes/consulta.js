const express = require('express');
const { consultarCnpj, consultarCep } = require('../services/consultaExterna');

const router = express.Router();

/* Autopreenchimento do cadastro a partir de dados públicos.
   Protegidas pelo middleware de auth, como as demais rotas. */

router.get('/cnpj/:cnpj', async (req, res, next) => {
  try {
    res.json(await consultarCnpj(req.params.cnpj));
  } catch (e) { next(e); }
});

router.get('/cep/:cep', async (req, res, next) => {
  try {
    res.json(await consultarCep(req.params.cep));
  } catch (e) { next(e); }
});

module.exports = router;
