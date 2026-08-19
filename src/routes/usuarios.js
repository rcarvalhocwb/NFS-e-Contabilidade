const express = require('express');
const usuarios = require('../services/usuarios');
const sessoes = require('../services/sessoes');
const db = require('../db');
const { somenteAdmin, exigirUsuario, empresaVisivel } = require('../middleware/escopo');

const router = express.Router();

/* ------------------------------------------------------------------- conta */
/* Rotas do próprio usuário: qualquer perfil, sobre si mesmo. */

router.get('/eu', exigirUsuario, async (req, res, next) => {
  try {
    const r = await db.query('SELECT empresa_padrao_id FROM usuarios WHERE id = $1',
      [req.auth.usuarioId]);
    res.json({
      id: req.auth.usuarioId,
      nome: req.auth.nome,
      email: req.auth.email,
      perfil: req.auth.perfil,
      trocarSenha: req.auth.trocarSenha,
      empresasIds: req.auth.empresasIds,   // null = todas
      empresaPadraoId: r.rows[0] ? r.rows[0].empresa_padrao_id : null
    });
  } catch (e) { next(e); }
});

/* Empresa que já vem escolhida ao abrir a emissão. Preferência de quem opera,
   não configuração do sistema: cada pessoa do escritório cuida de clientes
   diferentes. */
router.put('/eu/empresa-padrao', exigirUsuario, async (req, res, next) => {
  try {
    const id = (req.body || {}).empresaId;
    if (id !== null && id !== undefined && !empresaVisivel(req, id)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    await db.query('UPDATE usuarios SET empresa_padrao_id = $1 WHERE id = $2',
      [id || null, req.auth.usuarioId]);
    res.json({ ok: true, empresaPadraoId: id || null });
  } catch (e) { next(e); }
});

router.post('/eu/senha', exigirUsuario, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.senhaAtual || !b.senhaNova) {
      return res.status(400).json({ erro: 'Informe a senha atual e a nova' });
    }
    await usuarios.trocarPropriaSenha(req.auth.usuarioId, b.senhaAtual, b.senhaNova);

    // Encerra as outras sessões e renova a desta aba: se a troca foi por
    // suspeita de senha vazada, sessões antigas não podem continuar valendo.
    await sessoes.encerrarTodasDoUsuario(req.auth.usuarioId);
    const token = await sessoes.criar(req.auth.usuarioId, req);
    sessoes.definirCookie(res, token, req.secure || req.get('x-forwarded-proto') === 'https');

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- gestão */
/* Daqui para baixo, só administrador. */

router.use(somenteAdmin);

router.get('/', async (_req, res, next) => {
  try {
    res.json(await usuarios.listar());
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    res.status(201).json(await usuarios.criar({
      nome: b.nome,
      email: b.email,
      senha: b.senha,
      perfil: b.perfil,
      empresasIds: b.empresasIds,
      // Senha definida por outra pessoa é provisória: o dono troca ao entrar
      trocarSenha: b.trocarSenha !== undefined ? b.trocarSenha : true
    }));
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    /* Senha definida para OUTRA pessoa é provisória; definida para si mesmo,
       não. Sem essa distinção, o administrador que trocasse a própria senha
       por esta tela ficava marcado para trocar de novo — e o diálogo de troca
       obrigatória voltava a cada carga da página. */
    if (b.senha && b.trocarSenha === undefined &&
        req.auth.tipo === 'usuario' && Number(req.auth.usuarioId) === id) {
      b.trocarSenha = false;
    }

    // Não deixar o sistema ficar sem administrador: sem ninguém para promover
    // outro, a instalação vira um beco sem saída.
    const perdeAdmin = (b.perfil !== undefined && b.perfil !== 'admin') || b.ativo === false;
    if (perdeAdmin && await usuarios.contarAdminsAtivos(id) === 0) {
      return res.status(409).json({
        erro: 'Este é o único administrador ativo. Promova outro usuário antes de alterar este.'
      });
    }

    res.json(await usuarios.atualizar(id, b));
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (req.auth.tipo === 'usuario' && Number(req.auth.usuarioId) === id) {
      return res.status(409).json({ erro: 'Você não pode excluir a própria conta' });
    }
    if (await usuarios.contarAdminsAtivos(id) === 0) {
      return res.status(409).json({
        erro: 'Este é o único administrador ativo. Promova outro usuário antes de excluir este.'
      });
    }
    await usuarios.remover(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Derruba as sessões abertas de um usuário — para quando alguém perde o acesso
   à máquina em que estava logado. */
router.post('/:id/encerrar-sessoes', async (req, res, next) => {
  try {
    await sessoes.encerrarTodasDoUsuario(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
