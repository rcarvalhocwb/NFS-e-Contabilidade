/* Envio de e-mail ao tomador quando a NFS-e é autorizada.
   Opt-in por empresa. Como webhooks, a entrega é enfileirada no banco e enviada
   com retentativa, para que um SMTP fora do ar não perca a notificação.

   Configuração via .env (SMTP_*). Sem SMTP_HOST, o recurso fica inativo e as
   entregas apenas não são criadas — nada quebra. */
const db = require('../db');
const sefin = require('../nfse/sefinClient');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* opcional */ }

const INTERVALO_MS = Number(process.env.EMAIL_INTERVALO_MS || 5000);
const MAX_TENTATIVAS = Number(process.env.EMAIL_MAX_TENTATIVAS || 5);
const LEASE_SEGUNDOS = Number(process.env.EMAIL_LEASE_SEGUNDOS || 90);

let timer = null;
let rodando = false;
let transporte = null;

function configurado() {
  return !!(nodemailer && process.env.SMTP_HOST);
}

/* Cria o transporte SMTP uma vez, a partir do .env. */
function obterTransporte() {
  if (transporte || !configurado()) return transporte;
  transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',   // true = porta 465
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
  return transporte;
}

function remetente() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'nfse-gateway@localhost';
}

function proximaTentativaSegundos(t) { return Math.min(30 * t, 600); }

/**
 * Enfileira o e-mail de uma nota recém-autorizada, se:
 *  - o recurso está configurado (SMTP_HOST) e a empresa habilitou;
 *  - a nota está autorizada e tem e-mail de tomador.
 * O índice único por nota impede segundo e-mail se a nota reprocessar.
 */
async function enfileirarParaNota(notaId) {
  if (!configurado()) return 0;
  const r = await db.query(
    `SELECT n.*, e.razao_social, e.email_tomador_ativo
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
      WHERE n.id = $1`, [notaId]);
  if (!r.rows.length) return 0;
  const nota = r.rows[0];

  if (!nota.email_tomador_ativo) return 0;
  if (nota.status !== 'autorizada') return 0;
  if (!nota.tomador_email) return 0;

  const assunto = `NFS-e ${nota.serie}/${nota.numero} - ${nota.razao_social}`;
  const ins = await db.query(
    `INSERT INTO email_entregas (nota_id, destinatario, assunto)
     VALUES ($1,$2,$3) ON CONFLICT (nota_id) DO NOTHING RETURNING id`,
    [nota.id, nota.tomador_email, assunto]);
  if (ins.rows.length) console.log(`[email] enfileirado para ${nota.tomador_email} (nota ${notaId})`);
  return ins.rows.length;
}

function corpo(nota) {
  const danfse = nota.chave_acesso ? sefin.urlDanfse(nota.ambiente, nota.chave_acesso) : null;
  const linhas = [
    `Sua NFS-e foi emitida por ${nota.razao_social}.`,
    ``,
    `Número: ${nota.serie}/${nota.numero}`,
    nota.chave_acesso ? `Chave de acesso: ${nota.chave_acesso}` : null,
    danfse ? `DANFSe: ${danfse}` : null,
    ``,
    `Este é um e-mail automático do nfse-gateway.`
  ].filter(l => l !== null);
  return linhas.join('\n');
}

async function reivindicar() {
  const r = await db.query(
    `UPDATE email_entregas SET
       bloqueado_ate = now() + ($1 || ' seconds')::interval,
       tentativas = tentativas + 1, atualizado_em = now()
     WHERE id = (
       SELECT id FROM email_entregas
        WHERE status = 'pendente'
          AND (processar_apos IS NULL OR processar_apos <= now())
          AND (bloqueado_ate  IS NULL OR bloqueado_ate  <= now())
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [String(LEASE_SEGUNDOS)]);
  return r.rows[0] || null;
}

async function enviar(entrega) {
  const t = obterTransporte();
  if (!t) return falhar(entrega, 'SMTP não configurado');

  const r = await db.query(
    `SELECT n.*, e.razao_social FROM notas n JOIN empresas e ON e.id = n.empresa_id
      WHERE n.id = $1`, [entrega.nota_id]);
  if (!r.rows.length) return falhar(entrega, 'nota não encontrada');
  const nota = r.rows[0];

  try {
    await t.sendMail({
      from: remetente(),
      to: entrega.destinatario,
      subject: entrega.assunto,
      text: corpo(nota)
    });
  } catch (e) {
    return falhar(entrega, e.message);
  }

  await db.query(
    `UPDATE email_entregas SET status='enviado', ultimo_erro=NULL,
            bloqueado_ate=NULL, processar_apos=NULL, atualizado_em=now() WHERE id=$1`,
    [entrega.id]);
  console.log(`[email] enviado para ${entrega.destinatario} (nota ${entrega.nota_id})`);
}

async function falhar(entrega, mensagem) {
  if (entrega.tentativas >= MAX_TENTATIVAS) {
    await db.query(
      `UPDATE email_entregas SET status='erro', ultimo_erro=$2,
              bloqueado_ate=NULL, atualizado_em=now() WHERE id=$1`, [entrega.id, mensagem]);
    console.error(`[email] entrega ${entrega.id} desistiu: ${mensagem}`);
  } else {
    const espera = proximaTentativaSegundos(entrega.tentativas);
    await db.query(
      `UPDATE email_entregas SET ultimo_erro=$2, bloqueado_ate=NULL,
              processar_apos = now() + ($3 || ' seconds')::interval, atualizado_em=now()
       WHERE id=$1`, [entrega.id, mensagem, String(espera)]);
    console.warn(`[email] entrega ${entrega.id} falhou (tentativa ${entrega.tentativas}), retry em ${espera}s: ${mensagem}`);
  }
}

async function processarRodada(limite = 10) {
  let n = 0;
  for (; n < limite; n++) {
    const e = await reivindicar();
    if (!e) break;
    try { await enviar(e); }
    catch (err) { await falhar(e, 'Erro inesperado: ' + err.message); }
  }
  return n;
}

async function tick() {
  if (rodando) return;
  rodando = true;
  try { await processarRodada(); }
  catch (e) { console.error('[email] erro na rodada:', e.message); }
  finally { rodando = false; }
}

function iniciar() {
  if (!configurado()) {
    console.log('[email] SMTP não configurado (SMTP_HOST ausente) — envio ao tomador inativo');
    return;
  }
  if (timer) return;
  timer = setInterval(tick, INTERVALO_MS);
  if (timer.unref) timer.unref();
  console.log(`[email] worker de envio ativo (a cada ${INTERVALO_MS}ms)`);
}

function parar() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { iniciar, parar, processarRodada, enfileirarParaNota, configurado, corpo };
