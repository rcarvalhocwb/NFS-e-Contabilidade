const express = require('express');
const config = require('../config');
const db = require('../db');
const usuarios = require('../services/usuarios');
const sessoes = require('../services/sessoes');
const licencaService = require('../services/licencaService');
const { limitarLogin, registrarFalhaLogin, limparFalhasLogin } = require('../middleware/protecao');

const router = express.Router();

/* Estas rotas ficam ANTES do middleware de auth — quem vai fazer login ainda
   não tem credencial. Cada uma se protege por conta própria. */

const cookieSeguro = req => req.secure || req.get('x-forwarded-proto') === 'https';

/* Estado inicial da tela de acesso: diz se o sistema já tem algum usuário.
   Sem isso o painel não saberia se mostra "entrar" ou "criar primeiro acesso".

   Banco fora do ar não vira 500 aqui: a tela de acesso é a primeira coisa que
   a contabilidade vê, e "não foi possível falar com o banco" é uma explicação
   acionável — um login que não responde não é. */
/* A instalação já tem dono?
 *
 * A tela de acesso pergunta isso para decidir entre pedir login e oferecer a
 * criação do primeiro administrador. A pergunta é feita ANTES de haver sessão,
 * e `usuarios` está sob policy — sem inquilino, a consulta volta vazia e o
 * sistema se declara recém-instalado. O efeito é grave e imediato: a tela de
 * acesso some e dá lugar ao formulário de primeiro acesso, num servidor cheio
 * de escritórios. Ninguém entra pelo painel.
 *
 * Com vários escritórios a pergunta nem faz sentido do jeito antigo. Abrir uma
 * casa nova é ato de operador (scripts/criar-escritorio.js), que já cria o
 * administrador dela. Então: existindo escritório, existe dono, e a tela pede
 * login.
 *
 * Numa instalação de mesa a pergunta original continua valendo, e a resposta
 * vem de dentro do único escritório — é lá que o primeiro usuário nasce.
 */
async function instalacaoTemDono() {
  const ids = (await db.comServidor(() => db.query(
    'SELECT * FROM escritorios_ativos() AS id'))).rows.map(r => r.id);

  if (!ids.length) return false;                 // banco recém-migrado
  if (ids.length > 1) return true;               // servidor de vários: tem dono
  return db.comInquilino(ids[0], () => usuarios.existeAlgum());
}

router.get('/estado', async (_req, res) => {
  try {
    /* `multiEscritorio` não é segredo — é a forma da instalação, e o painel
       precisa dela para não oferecer botão que o servidor vai recusar. */
    res.json({
      temUsuarios: await instalacaoTemDono(),
      multiEscritorio: !!config.multiEscritorio
    });
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
router.post('/primeiro-acesso', limitarLogin, async (req, res, next) => {
  try {
    /* Mesma pergunta da tela, pela mesma razão — e aqui ela é a trava. Com a
       versão antiga, num servidor de vários escritórios a consulta sem
       inquilino voltava vazia e esta porta ficava aberta para sempre. */
    if (await instalacaoTemDono()) {
      return res.status(409).json({
        erro: 'O sistema já tem usuários. Peça a um administrador para criar o seu acesso.'
      });
    }
    const b = req.body || {};
    if (!config.apiKey || b.chaveInstalacao !== config.apiKey) {
      registrarFalhaLogin(req);
      return res.status(401).json({
        erro: 'Chave de instalação incorreta. É o valor de GATEWAY_API_KEY no arquivo .env do gateway.'
      });
    }

    // O primeiro é sempre admin e vê todas as empresas: não haveria quem lhe
    // desse permissão depois.
    /* Em qual casa nasce este administrador.
       Só há uma — `instalacaoTemDono` já barrou o caso de várias — mas ela
       precisa ser dita: o padrão da coluna `escritorio_id` é
       `inquilino_atual()`, e sem inquilino a gravação falha em vez de cair em
       algum lugar. Falhar é o comportamento certo; acontecer aqui, não. */
    const casas = (await db.comServidor(() => db.query(
      'SELECT * FROM escritorios_ativos() AS id'))).rows.map(r => r.id);
    if (!casas.length) {
      return res.status(503).json({
        erro: 'O banco ainda não tem escritório. Rode as migrações antes do primeiro acesso.'
      });
    }

    await db.comInquilino(casas[0], async () => {
      const usuario = await usuarios.criar({
        nome: b.nome, email: b.email, senha: b.senha, perfil: 'admin', empresasIds: []
      });

      const token = await sessoes.criar(usuario.id, req);
      sessoes.definirCookie(res, token, cookieSeguro(req));
      res.status(201).json({ usuario });
    });
  } catch (e) { next(e); }
});

router.post('/login', limitarLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.email || !b.senha) {
      return res.status(400).json({ erro: 'Informe e-mail e senha' });
    }

    /* O e-mail deixou de identificar uma conta: ele é único DENTRO do
       escritório, não no servidor (migração 045). O mesmo contador pode
       atender duas casas, e antes disso a segunda não conseguia nem cadastrá-lo.

       Então o login tem duas etapas. Primeiro, quais escritórios têm conta
       ativa com este e-mail — só os ids, que é o que `escritorios_do_email`
       devolve. Depois, em qual deles a senha confere.

       A ordem é essa de propósito. Perguntar "em qual escritório?" ANTES da
       senha revelaria, a quem só chutou um e-mail, em que casas aquela pessoa
       trabalha. Conferindo a senha primeiro, quem chega na pergunta já provou
       ser a pessoa — e aí o nome do escritório é informação dela. */
    const candidatos = (await db.comServidor(() => db.query(
      'SELECT * FROM escritorios_do_email($1) AS id', [b.email]))).rows.map(r => r.id);

    const conferidos = [];
    for (const escritorioId of candidatos) {
      let u = null;
      try {
        u = await db.comInquilino(escritorioId, () => usuarios.porEmail(b.email));
      } catch (_) {
        // E-mail malformado cai aqui; a resposta é a mesma de credencial errada
        break;
      }
      /* Mesma resposta para e-mail inexistente, senha errada, conta desativada
         e perfil de cliente: distinguir permitiria descobrir quem tem conta no
         sistema. O perfil 'cliente' existe para ser replicado ao portal — a
         pessoa da empresa cliente acessa lá, nunca o painel do escritório. */
      if (u && u.ativo && u.perfil !== 'cliente' &&
          await usuarios.conferirSenha(b.senha, u.senha_hash)) {
        conferidos.push({ escritorioId, usuario: u });
      }
    }

    if (!conferidos.length) {
      registrarFalhaLogin(req);
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
    }

    limparFalhasLogin(req);

    /* Mesmo e-mail e mesma senha em dois escritórios. Raro, e resolvido
       perguntando — nunca escolhendo por conta própria: entrar na casa errada
       é começar a operar a carteira de clientes de outro escritório. */
    let escolhido = conferidos[0];
    if (conferidos.length > 1) {
      const pedido = Number(b.escritorio);
      const achado = conferidos.find(c => c.escritorioId === pedido);
      if (!achado) {
        /* Um bloco por escritório, e não uma consulta só com IN: a policy
           de `escritorios` responde pelo id da conexão, então uma lista só
           voltaria vazia. Aqui a senha já conferiu nos dois, então mostrar o
           nome de cada um é mostrar à pessoa as casas que são dela. */
        const nomes = [];
        for (const c of conferidos) {
          const r = await db.comInquilino(c.escritorioId, () => db.query(
            'SELECT id, nome FROM escritorios WHERE id = $1', [c.escritorioId]));
          if (r.rows.length) nomes.push(r.rows[0]);
        }
        nomes.sort((a, z) => a.nome.localeCompare(z.nome, 'pt-BR'));
        return res.status(409).json({
          erro: 'Sua conta existe em mais de um escritório. Escolha em qual entrar.',
          escritorios: nomes
        });
      }
      escolhido = achado;
    }

    const usuario = escolhido.usuario;
    req.escritorioId = escolhido.escritorioId;

    /* Qual máquina é esta. O adicional cobrado é por terminal instalado, e
       terminal, no desenho, é só um atalho para o painel — não instala
       gateway nenhum, porque dois gateways no mesmo banco reservariam a mesma
       numeração fiscal. Atalho não se conta, então quem conta é o servidor:
       cada navegador ganha uma marca durável no primeiro login.

       Falhar aqui NÃO pode impedir o login. Contagem para faturar não vale
       uma pessoa sem acesso ao sistema às cinco da tarde. */
    /* Daqui para baixo tudo grava: terminal, sessão, último acesso. Amarrado
       ao escritório escolhido, senão a policy recusa a escrita — que é o modo
       certo de falhar, mas o momento errado de descobrir. */
    await db.comInquilino(escolhido.escritorioId, async () => {
      let terminalId = null;
      try {
        terminalId = await licencaService.registrarAcesso(req, res);
      } catch (e) {
        console.error('[auth] não consegui registrar o terminal:', e.message);
      }

      const token = await sessoes.criar(usuario.id, req, { terminalId });
      sessoes.definirCookie(res, token, cookieSeguro(req));
      db.query('UPDATE usuarios SET ultimo_acesso = now() WHERE id = $1', [usuario.id])
        .catch(e => console.error('[auth] falha ao registrar acesso:', e.message));

      res.json({
        usuario: {
          id: usuario.id, nome: usuario.nome, email: usuario.email,
          perfil: usuario.perfil, trocarSenha: usuario.trocar_senha
        }
      });
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
