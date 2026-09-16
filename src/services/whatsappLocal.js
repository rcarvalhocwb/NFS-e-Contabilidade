const db = require('../db');

/* O gateway conversando com o módulo do WhatsApp.
 *
 * O módulo é outro processo, com ícone próprio, que mantém a sessão. Este
 * arquivo é a metade daqui: guarda a configuração, registra o aceite do termo,
 * e sabe pedir ao módulo que envie uma mensagem.
 *
 * NADA AQUI PODE IMPEDIR UMA NOTA DE SAIR. O WhatsApp é um canal de entrada
 * de pedidos; se ele estiver fora do ar, o pedido chega por outro caminho ou
 * não chega — e a emissão pelo painel segue igual. Toda função deste arquivo
 * falha para o lado de "o WhatsApp não está disponível", nunca para o lado de
 * "o sistema parou".
 */

const PORTA_PADRAO = 3200;

async function ler() {
  const r = await db.query('SELECT * FROM whatsapp_local WHERE id = 1');
  return r.rows[0] || null;
}

async function situacao() {
  const linha = await ler();

  /* O `catch` aqui existe para UM caso: instalação antiga, antes da coluna
     `wa_transporte`, em que a consulta falha por ela não existir. Só que ele
     engolia qualquer erro — e engoliu um de verdade por tempo demais.
     `config_nuvem.id` é BOOLEAN, e esta consulta dizia `WHERE id = 1`: o
     Postgres respondia "operador não existe: boolean = integer", o catch
     transformava isso em zero linhas, e zero linhas viravam o padrão 'meta'.
     Resultado: o painel jurava que o transporte era a Meta mesmo com a sessão
     própria escolhida, e ninguém tinha como desconfiar — não havia erro, só uma
     resposta errada com cara de certa.

     Agora só a ausência da coluna é perdoada. Qualquer outra falha sobe, porque
     uma resposta errada sobre POR ONDE a nota sai é pior que uma tela de erro. */
  let transporte = 'meta';
  try {
    const cfg = await db.query('SELECT wa_transporte FROM config_nuvem WHERE id = TRUE');
    if (cfg.rows.length) transporte = cfg.rows[0].wa_transporte;
  } catch (e) {
    /* 42703 = undefined_column: a migração ainda não rodou. */
    if (e.code !== '42703') throw e;
  }

  return {
    transporte,
    ativo: !!(linha && linha.ativo),
    porta: linha ? linha.porta : PORTA_PADRAO,
    numero: linha ? linha.numero : null,
    nomePerfil: linha ? linha.nome_perfil : null,
    /* A situação vem do banco, gravada pelo próprio módulo. É de propósito:
       perguntar ao módulo exigiria que ele estivesse de pé, e é justamente
       quando ele cai que alguém quer saber o que houve. */
    situacaoSessao: linha ? linha.situacao : 'desligado',
    situacaoEm: linha ? linha.situacao_em : null,
    ultimoErro: linha ? linha.ultimo_erro : null,
    termo: linha && linha.termo_aceito_em ? {
      versao: linha.termo_versao,
      aceitoEm: linha.termo_aceito_em,
      aceitoPor: linha.termo_aceito_nome
    } : null
  };
}

/* Registra o aceite. O nome é COPIADO no ato, e não só referenciado: se o
   usuário for removido depois, a prova de quem aceitou não pode sumir com ele. */
async function aceitarTermo({ versao, usuarioId, nome }) {
  if (!versao) {
    throw Object.assign(new Error('Informe a versão do termo aceito.'), { status: 400 });
  }
  await db.query(
    `UPDATE whatsapp_local
        SET termo_versao = $1, termo_aceito_em = now(),
            termo_aceito_por = $2, termo_aceito_nome = $3, atualizado_em = now()
      WHERE id = 1`,
    [versao, usuarioId || null, nome || null]);
  return situacao();
}

/* Liga ou desliga o transporte local. Ligar sem aceite é recusado AQUI, e não
   só na tela do módulo: trava que vive só no navegador não é trava. */
async function definirAtivo(ativo, { porta } = {}) {
  const linha = await ler();
  if (ativo && !(linha && linha.termo_aceito_em)) {
    throw Object.assign(
      new Error('É preciso aceitar o termo de uso do WhatsApp por sessão própria antes de ligar.'),
      { status: 412 });
  }
  await db.query(
    `UPDATE whatsapp_local
        SET ativo = $1, porta = COALESCE($2, porta), atualizado_em = now()
      WHERE id = 1`,
    [!!ativo, porta || null]);

  /* Um transporte de cada vez. Dois escrevendo na mesma conversa dariam
     resposta dobrada ao cliente — e ele não faz ideia de que existem dois. */
  await db.query(
    'UPDATE config_nuvem SET wa_transporte = $1, atualizado_em = now() WHERE id = TRUE',
    [ativo ? 'local' : 'meta']);

  return situacao();
}

/* O módulo avisa como está. Chamado por ele, não pelo painel. */
async function registrarSituacao(estado) {
  await db.query(
    `UPDATE whatsapp_local
        SET situacao = $1, situacao_em = now(), ultimo_erro = $2,
            numero = COALESCE($3, numero), nome_perfil = COALESCE($4, nome_perfil),
            atualizado_em = now()
      WHERE id = 1`,
    [estado.situacao || 'desligado', estado.ultimoErro || null,
     estado.numero || null, estado.nomePerfil || null]);
}

/* Manda uma mensagem pelo módulo. Usado pelo gateway quando a nota fica pronta
   e o cliente precisa receber o link.

   Timeout curto: se o módulo não responde em cinco segundos, ele não vai
   responder — e quem chamou tem outra coisa para fazer (gravar a nota, seguir
   a fila) que não pode esperar por um canal de conveniência. */
async function enviar({ para, texto, documento }) {
  const s = await situacao();
  if (s.transporte !== 'local' || !s.ativo) {
    throw Object.assign(new Error('O WhatsApp por sessão própria não está ligado.'),
      { status: 409 });
  }

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 5000);
  try {
    const r = await fetch('http://127.0.0.1:' + s.porta + '/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Token': await tokenDoModulo() },
      body: JSON.stringify({ para, texto, documento }),
      signal: controle.signal
    });
    if (!r.ok) {
      const corpo = await r.json().catch(() => ({}));
      throw Object.assign(new Error(corpo.erro || ('módulo respondeu ' + r.status)),
        { status: 502 });
    }
    return r.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error('O módulo do WhatsApp não respondeu.'), { status: 504 });
    }
    throw e;
  } finally {
    clearTimeout(relogio);
  }
}

/* O token que o módulo sorteia a cada subida e grava em wa/token.txt. Lê na
   hora: o módulo pode ter reiniciado desde a última chamada, e um token velho
   em memória levaria a um 403 confuso. */
async function tokenDoModulo() {
  const fs = require('fs');
  const path = require('path');
  const arquivo = path.join(__dirname, '..', '..', 'wa', 'token.txt');
  try {
    return fs.readFileSync(arquivo, 'utf8').trim();
  } catch (_) {
    throw Object.assign(
      new Error('O módulo do WhatsApp não está no ar. Abra o WhatsApp.bat.'),
      { status: 409 });
  }
}

module.exports = {
  ler, situacao, aceitarTermo, definirAtivo, registrarSituacao, enviar,
  tokenDoModulo, PORTA_PADRAO
};
