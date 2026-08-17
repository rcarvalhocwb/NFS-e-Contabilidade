const express = require('express');
const config = require('../config');
const db = require('../db');
const usuarios = require('../services/usuarios');
const sessoes = require('../services/sessoes');

const router = express.Router();

/* Estas rotas ficam ANTES do middleware de auth — quem vai fazer login ainda
   não tem credencial. Cada uma se protege por conta própria. */

const cookieSeguro = req => req.secure || req.get('x-forwarded-proto') === 'https';

/* Estado inicial da tela de acesso: diz se o sistema já tem algum usuário.
   Sem isso o painel não saberia se mostra "entrar" ou "criar primeiro acesso".

   Banco fora do ar não vira 500 aqui: a tela de acesso é a primeira coisa que
   a contabilidade vê, e "não foi possível falar com o banco" é uma explicação
   acionável — um login que não responde não é. */
router.get('/estado', async (_req, res) => {
  try {
    res.json({ temUsuarios: await usuarios.existeAlgum() });
  } catch (e) {
    console.error('[auth] banco indisponível ao abrir o painel:', e.message);
    res.json({
      bancoIndisponivel: true,
      detalhe: e.message
    });
  }
});

/* Primeiro acesso da instalação.
   Autorizado pela GATEWAY_API_KEY: é o único segredo que existe numa instalação
   nova, e quem instalou o gateway o tem à mão no .env. Só funciona enquanto não
   houver nenhum usuário — depois disso, contas novas saem do painel. */
router.post('/primeiro-acesso', async (req, res, next) => {
  try {
    if (await usuarios.existeAlgum()) {
      return res.status(409).json({
        erro: 'O sistema já tem usuários. Peça a um administrador para criar o seu acesso.'
      });
    }
    const b = req.body || {};
    if (!config.apiKey || b.chaveInstalacao !== config.apiKey) {
      return res.status(401).json({
        erro: 'Chave de instalação incorreta. É o valor de GATEWAY_API_KEY no arquivo .env do gateway.'
      });
    }

    // O primeiro é sempre admin e vê todas as empresas: não haveria quem lhe
    // desse permissão depois.
    const usuario = await usuarios.criar({
      nome: b.nome, email: b.email, senha: b.senha, perfil: 'admin', empresasIds: []
    });

    const token = await sessoes.criar(usuario.id, req);
    sessoes.definirCookie(res, token, cookieSeguro(req));
    res.status(201).json({ usuario });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.email || !b.senha) {
      return res.status(400).json({ erro: 'Informe e-mail e senha' });
    }

    let usuario = null;
    try {
      usuario = await usuarios.porEmail(b.email);
    } catch (_) {
      // E-mail malformado cai aqui; a resposta é a mesma de credencial errada
    }

    // Mesma resposta para e-mail inexistente, senha errada e conta desativada:
    // distinguir permitiria descobrir quem tem conta no sistema.
    const ok = usuario && usuario.ativo &&
      await usuarios.conferirSenha(b.senha, usuario.senha_hash);
    if (!ok) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    }

    const token = await sessoes.criar(usuario.id, req);
    sessoes.definirCookie(res, token, cookieSeguro(req));
    db.query('UPDATE usuarios SET ultimo_acesso = now() WHERE id = $1', [usuario.id])
      .catch(e => console.error('[auth] falha ao registrar acesso:', e.message));

    res.json({
      usuario: {
        id: usuario.id, nome: usuario.nome, email: usuario.email,
        perfil: usuario.perfil, trocarSenha: usuario.trocar_senha
      }
    });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    await sessoes.encerrar(sessoes.tokenDoPedido(req));
    sessoes.limparCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
