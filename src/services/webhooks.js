/* Notificação do sistema emissor quando a nota chega a um estado final.
   Enfileira a entrega no banco e a envia com retentativa — assim o endpoint
   estar fora do ar não faz a notificação se perder. */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const db = require('../db');
const sefin = require('../nfse/sefinClient');

const INTERVALO_MS = Number(process.env.WEBHOOK_INTERVALO_MS || 4000);
const MAX_TENTATIVAS = Number(process.env.WEBHOOK_MAX_TENTATIVAS || 6);
const LEASE_SEGUNDOS = Number(process.env.WEBHOOK_LEASE_SEGUNDOS || 60);
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);

let timer = null;
let rodando = false;

function proximaTentativaSegundos(t) {
  return Math.min(10 * t * t, 1800);   // 10s, 40s, 90s... até 30 min
}

/* Valida a URL de destino. Não bloqueamos faixas privadas de propósito: num
   gateway auto-hospedado é comum e legítimo notificar um ERP na rede interna.
   Quem configura o webhook é o operador do próprio gateway. */
function validarUrl(valor) {
  let u;
  try { u = new URL(valor); } catch (_) {
    throw Object.assign(new Error('url inválida'), { status: 400 });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw Object.assign(new Error('url deve usar http ou https'), { status: 400 });
  }
  return u;
}

function postar(url, corpo, header, chave) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const dados = Buffer.from(JSON.stringify(corpo), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': dados.length,
      'User-Agent': 'nfse-gateway'
    };
    if (header && chave) headers[header] = chave;

    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: TIMEOUT_MS
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, corpo: body.slice(0, 500) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout ao chamar o webhook')); });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

/* Monta o corpo enviado ao sistema emissor. */
function montarPayload(nota, cnpjEmpresa) {
  return {
    evento: 'nfse',
    notaId: nota.id,
    referencia: nota.referencia || null,
    cnpjEmpresa,
    ambiente: nota.ambiente,
    status: nota.status,
    serie: nota.serie,
    numero: Number(nota.numero),
    idDps: nota.id_dps,
    chaveAcesso: nota.chave_acesso || null,
    urlDanfse: nota.chave_acesso ? sefin.urlDanfse(nota.ambiente, nota.chave_acesso) : null,
    erro: nota.ultimo_erro || null,
    ocorridoEm: new Date().toISOString()
  };
}

/**
 * Cria as entregas para uma nota que chegou a estado final.
 * Chamada pelo worker de emissão. O índice único (webhook, nota, evento)
 * garante que reprocessar a nota não gere notificação duplicada.
 */
async function enfileirarParaNota(notaId) {
  const r = await db.query(
    `SELECT n.*, e.cnpj AS cnpj_empresa FROM notas n
     JOIN empresas e ON e.id = n.empresa_id WHERE n.id = $1`, [notaId]);
  if (!r.rows.length) return 0;
  const nota = r.rows[0];

  const hooks = await db.query(
    `SELECT id FROM webhooks
      WHERE ativo AND evento = 'nfse'
        AND (empresa_id IS NULL OR empresa_id = $1)
        AND (ambiente   IS NULL OR ambiente   = $2)`,
    [nota.empresa_id, nota.ambiente]);
  if (!hooks.rows.length) return 0;

  const payload = montarPayload(nota, nota.cnpj_empresa);
  let criadas = 0;
  for (const h of hooks.rows) {
    const ins = await db.query(
      `INSERT INTO webhook_entregas (webhook_id, nota_id, evento, payload)
       VALUES ($1,$2,'nfse',$3)
       ON CONFLICT (webhook_id, nota_id, evento) WHERE nota_id IS NOT NULL
       DO NOTHING RETURNING id`,
      [h.id, nota.id, JSON.stringify(payload)]);
    if (ins.rows.length) criadas++;
  }
  if (criadas) console.log(`[webhook] ${criadas} entrega(s) enfileirada(s) para a nota ${notaId}`);
  return criadas;
}

async function reivindicar() {
  const r = await db.query(
    `UPDATE webhook_entregas SET
       bloqueado_ate = now() + ($1 || ' seconds')::interval,
       tentativas = tentativas + 1, atualizado_em = now()
     WHERE id = (
       SELECT id FROM webhook_entregas
        WHERE status = 'pendente'
          AND (processar_apos IS NULL OR processar_apos <= now())
          AND (bloqueado_ate  IS NULL OR bloqueado_ate  <= now())
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [String(LEASE_SEGUNDOS)]);
  return r.rows[0] || null;
}

async function entregar(entrega) {
  const w = await db.query('SELECT * FROM webhooks WHERE id = $1', [entrega.webhook_id]);
  if (!w.rows.length) {
    return db.query(
      `UPDATE webhook_entregas SET status='erro', ultimo_erro='webhook removido',
              bloqueado_ate=NULL, atualizado_em=now() WHERE id=$1`, [entrega.id]);
  }
  const hook = w.rows[0];

  let resp;
  try {
    resp = await postar(hook.url, entrega.payload, hook.header_autorizacao, hook.chave_autorizacao);
  } catch (e) {
    return falhar(entrega, e.message, null);
  }

  // 2xx = entregue. Qualquer outra coisa é retentável: um 4xx pode ser
  // aplicação subindo, rota ainda não publicada, proxy no meio.
  if (resp.status >= 200 && resp.status < 300) {
    await db.query(
      `UPDATE webhook_entregas SET status='entregue', http_status=$2, ultimo_erro=NULL,
              bloqueado_ate=NULL, processar_apos=NULL, atualizado_em=now() WHERE id=$1`,
      [entrega.id, resp.status]);
    console.log(`[webhook] entrega ${entrega.id} confirmada (HTTP ${resp.status})`);
    return;
  }
  return falhar(entrega, `destino respondeu HTTP ${resp.status}`, resp.status);
}

async function falhar(entrega, mensagem, httpStatus) {
  if (entrega.tentativas >= MAX_TENTATIVAS) {
    await db.query(
      `UPDATE webhook_entregas SET status='erro', ultimo_erro=$2, http_status=$3,
              bloqueado_ate=NULL, atualizado_em=now() WHERE id=$1`,
      [entrega.id, mensagem, httpStatus]);
    console.error(`[webhook] entrega ${entrega.id} desistiu após ${entrega.tentativas} tentativas: ${mensagem}`);
  } else {
    const espera = proximaTentativaSegundos(entrega.tentativas);
    await db.query(
      `UPDATE webhook_entregas SET ultimo_erro=$2, http_status=$3, bloqueado_ate=NULL,
              processar_apos = now() + ($4 || ' seconds')::interval, atualizado_em=now()
       WHERE id=$1`,
      [entrega.id, mensagem, httpStatus, String(espera)]);
    console.warn(`[webhook] entrega ${entrega.id} falhou (tentativa ${entrega.tentativas}), retry em ${espera}s: ${mensagem}`);
  }
}

async function processarRodada(limite = 10) {
  let n = 0;
  for (; n < limite; n++) {
    const e = await reivindicar();
    if (!e) break;
    try { await entregar(e); }
    catch (err) { await falhar(e, 'Erro inesperado: ' + err.message, null); }
  }
  return n;
}

async function tick() {
  if (rodando) return;
  rodando = true;
  try { await processarRodada(); }
  catch (e) { console.error('[webhook] erro na rodada:', e.message); }
  finally { rodando = false; }
}

function iniciar() {
  if (timer) return;
  timer = setInterval(tick, INTERVALO_MS);
  if (timer.unref) timer.unref();
  console.log(`[webhook] worker de entrega ativo (a cada ${INTERVALO_MS}ms)`);
}

function parar() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { iniciar, parar, processarRodada, enfileirarParaNota, validarUrl, montarPayload };
