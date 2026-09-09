const db = require('../db');
const crypto = require('crypto');
const { avaliar } = require('../licenca/estado');
const { verificar } = require('../licenca/formato');
const { CHAVE_PUBLICA } = require('../licenca/chave-publica');

/* A licença desta instalação, e os terminais que ela cobre.
 *
 * Nada aqui pode impedir uma nota de sair. O serviço responde "como está a
 * licença"; quem consome usa isso para AVISAR e para desligar conveniência —
 * nunca para barrar emissão, consulta, cancelamento, XML ou backup.
 */

const COOKIE_TERMINAL = 'nfse_terminal';
const ANOS = 3;   /* o cookie precisa durar mais que o contrato, senão o mesmo
                     computador vira terminal novo e a conta sobe sozinha */

/* ------------------------------------------------------------- a licença */

async function ler() {
  const r = await db.query('SELECT * FROM licenca WHERE id = 1');
  return r.rows[0] || null;
}

/** Estado completo: situação, recursos e a conta de terminais. */
async function situacao() {
  const linha = await ler();
  const empresaDoEscritorio = await cnpjDoEscritorio();

  const e = avaliar(linha && linha.texto, CHAVE_PUBLICA, {
    cnpjEscritorio: empresaDoEscritorio
  });

  const t = await contarTerminais();

  return Object.assign(e, {
    origem: linha ? linha.origem : null,
    instaladaEm: linha ? linha.instalada_em : null,
    ultimoContato: linha ? linha.ultimo_contato : null,
    ultimoErro: linha ? linha.ultimo_erro : null,
    /* Sem chave pública embutida, o produto ainda não foi licenciado por
       ninguém — é o estado de hoje. Dizer isso em voz alta evita que a tela
       pareça um erro. */
    semChaveDeConferencia: !CHAVE_PUBLICA,
    terminais: t,
    /* Estourar o contratado é assunto de cobrança, não de bloqueio: aparece
       aqui, aparece no relatório de quem vende, e ninguém para de trabalhar. */
    terminaisAcimaDoContratado: e.terminaisContratados != null &&
      t.contados > e.terminaisContratados
  });
}

/* O CNPJ do escritório é o da empresa marcada como do próprio escritório; na
   falta dela, o da primeira empresa cadastrada. Serve só para avisar quando a
   licença é de outro CNPJ — nunca para bloquear. */
async function cnpjDoEscritorio() {
  const r = await db.query(
    'SELECT cnpj FROM empresas WHERE ativo ORDER BY id LIMIT 1');
  return r.rows.length ? r.rows[0].cnpj : null;
}

/** Guarda uma licença nova. Recusa a que não confere: entregar ao cliente uma
 *  licença que não abre é o pior primeiro contato possível com o produto. */
async function instalar(texto, { origem = 'arquivo', usuarioId = null } = {}) {
  const limpo = String(texto || '').trim().replace(/\s+/g, '');
  if (!limpo) {
    throw Object.assign(new Error('Informe a licença.'), { status: 400 });
  }
  if (!CHAVE_PUBLICA) {
    throw Object.assign(
      new Error('Esta versão foi montada sem a chave de conferência, então não ' +
                'consegue validar licença. Fale com quem forneceu o sistema.'),
      { status: 409 });
  }
  const r = verificar(limpo, CHAVE_PUBLICA);
  if (!r.valida) {
    throw Object.assign(
      new Error('Esta licença não confere: ' + r.motivo + '. Confira se copiou ' +
                'o texto inteiro, sem cortar.'),
      { status: 400 });
  }
  await db.query(
    `UPDATE licenca SET texto = $1, origem = $2, instalada_em = now(),
                        instalada_por = $3, ultimo_erro = NULL, atualizado_em = now()
      WHERE id = 1`,
    [limpo, origem, usuarioId]);
  return situacao();
}

async function remover() {
  await db.query(
    `UPDATE licenca SET texto = NULL, origem = NULL, instalada_em = NULL,
                        instalada_por = NULL, atualizado_em = now() WHERE id = 1`);
  return situacao();
}

/* ------------------------------------------------------------ terminais */

/* Um terminal é uma MÁQUINA que abre o painel, não uma pessoa. O servidor não
   conta: ele é a licença, não um adicional. */
async function contarTerminais() {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE contar AND NOT eh_servidor)::int AS contados,
            count(*) FILTER (WHERE NOT eh_servidor)::int AS vistos,
            count(*) FILTER (WHERE eh_servidor)::int AS servidores
       FROM terminais`);
  return r.rows[0];
}

async function listarTerminais() {
  const r = await db.query(
    `SELECT t.id, t.apelido, t.primeiro_acesso, t.ultimo_acesso, t.ip,
            t.user_agent, t.eh_servidor, t.contar, t.observacao,
            (SELECT count(*)::int FROM sessoes s
              WHERE s.terminal_id = t.id AND s.expira_em > now()) AS sessoes_ativas,
            (SELECT string_agg(DISTINCT u.nome, ', ')
               FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
              WHERE s.terminal_id = t.id) AS pessoas
       FROM terminais t
      ORDER BY t.eh_servidor DESC, t.ultimo_acesso DESC`);
  return r.rows;
}

async function ajustarTerminal(id, { apelido, contar, observacao }) {
  const r = await db.query(
    `UPDATE terminais
        SET apelido    = COALESCE($2, apelido),
            contar     = COALESCE($3, contar),
            observacao = COALESCE($4, observacao)
      WHERE id = $1 RETURNING id`,
    [id, apelido === undefined ? null : apelido,
     contar === undefined ? null : contar,
     observacao === undefined ? null : observacao]);
  if (!r.rows.length) {
    throw Object.assign(new Error('Terminal não encontrado'), { status: 404 });
  }
  return listarTerminais();
}

async function esquecerTerminal(id) {
  /* Some da lista e para de contar. Se a mesma máquina voltar, entra de novo
     com a mesma chave — não é bloqueio, é limpeza de lista. */
  await db.query('DELETE FROM terminais WHERE id = $1', [id]);
  return listarTerminais();
}

/* Registra a máquina de onde veio a requisição e devolve o id do terminal.
   Chamado no login: é o momento em que existe alguém de verdade do outro
   lado, e não um robô batendo na porta. */
async function registrarAcesso(req, res) {
  let chave = lerCookieTerminal(req);
  if (!chave) {
    chave = crypto.randomBytes(16).toString('hex');
    definirCookieTerminal(res, chave);
  }

  const ip = String(req.ip || '').slice(0, 45);
  /* O servidor é quem atende em 127.0.0.1: é a própria instalação licenciada,
     não um terminal a mais. Uma rede que faça NAT para localhost não existe
     aqui — o painel é local. */
  const ehServidor = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip);

  const r = await db.query(
    `INSERT INTO terminais (chave, ip, user_agent, eh_servidor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chave) DO UPDATE
       SET ultimo_acesso = now(), ip = EXCLUDED.ip,
           user_agent = EXCLUDED.user_agent
     RETURNING id`,
    [chave, ip, String(req.get('user-agent') || '').slice(0, 500), ehServidor]);
  return r.rows[0].id;
}

function lerCookieTerminal(req) {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    if (parte.slice(0, igual).trim() === COOKIE_TERMINAL) {
      const v = decodeURIComponent(parte.slice(igual + 1).trim());
      return /^[0-9a-f]{32}$/.test(v) ? v : null;
    }
  }
  return null;
}

function definirCookieTerminal(res, chave) {
  res.cookie(COOKIE_TERMINAL, chave, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ANOS * 365 * 24 * 3600 * 1000,
    path: '/'
  });
}

module.exports = {
  situacao, instalar, remover, ler,
  contarTerminais, listarTerminais, ajustarTerminal, esquecerTerminal,
  registrarAcesso, COOKIE_TERMINAL
};
