const express = require('express');
const { somenteAdmin } = require('../middleware/escopo');
const servico = require('../services/licencaService');
const auditoria = require('../services/auditoria');

const router = express.Router();

/* A licença desta instalação.
 *
 * A LEITURA é de qualquer usuário logado: quem opera precisa poder ver que a
 * licença está vencendo, senão o aviso morre com o administrador que não abre
 * o sistema há um mês. Não há segredo aqui — a licença diz o que o escritório
 * contratou, e quem paga tem direito de ler.
 *
 * A ESCRITA é do administrador: instalar licença, marcar o que é terminal de
 * trabalho e o que foi visita.
 */

router.get('/', async (_req, res, next) => {
  try { res.json(await servico.situacao()); } catch (e) { next(e); }
});

router.get('/terminais', async (_req, res, next) => {
  try { res.json(await servico.listarTerminais()); } catch (e) { next(e); }
});

router.use(somenteAdmin);

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const estado = await servico.instalar(b.licenca, {
      origem: b.origem === 'ativacao' ? 'ativacao' : 'arquivo',
      usuarioId: req.auth && req.auth.usuarioId
    });
    await auditoria.registrar(req, null, 'licenca.instalar',
      'Instalou a licença ' + (estado.id || '(sem id)'));
    res.json(estado);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const estado = await servico.remover();
    await auditoria.registrar(req, null, 'licenca.remover', 'Removeu a licença');
    res.json(estado);
  } catch (e) { next(e); }
});

router.put('/terminais/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await servico.ajustarTerminal(Number(req.params.id), {
      apelido: b.apelido, contar: b.contar, observacao: b.observacao
    }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

router.delete('/terminais/:id', async (req, res, next) => {
  try {
    res.json(await servico.esquecerTerminal(Number(req.params.id)));
  } catch (e) { next(e); }
});

module.exports = router;
