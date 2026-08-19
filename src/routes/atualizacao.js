const express = require('express');
const atualizacao = require('../services/atualizacao');
const { somenteAdmin } = require('../middleware/escopo');

const router = express.Router();

/* Estado atual, sem tocar na rede. É o que a tela consulta ao abrir: usa o
   resultado da última verificação em segundo plano. */
router.get('/', async (_req, res, next) => {
  try {
    res.json(atualizacao.resumir(await atualizacao.estado()));
  } catch (e) { next(e); }
});

/* Botão "verificar agora": ignora o intervalo e consulta o repositório.
   Nunca devolve erro por falha de rede — o resultado traz o motivo em `erro`,
   porque não conseguir verificar não é uma falha da requisição. */
router.post('/verificar', somenteAdmin, async (_req, res, next) => {
  try {
    res.json(await atualizacao.verificar({ forcar: true }));
  } catch (e) { next(e); }
});

/* Baixa o instalador e confere o SHA-256. NÃO instala: o arquivo fica na
   pasta e quem escolhe a hora de parar o gateway é o operador. */
router.post('/baixar', somenteAdmin, async (_req, res, next) => {
  try {
    res.json(await atualizacao.baixar());
  } catch (e) { next(e); }
});

/* Para de avisar sobre esta versão. Continua instalável. */
router.post('/dispensar', somenteAdmin, async (req, res, next) => {
  try {
    res.json(await atualizacao.dispensar((req.body || {}).versao));
  } catch (e) { next(e); }
});

module.exports = router;
