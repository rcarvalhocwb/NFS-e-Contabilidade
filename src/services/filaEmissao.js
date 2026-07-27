/* Worker de transmissão das DPS pendentes.
   A requisição HTTP só monta, assina e grava a nota; quem fala com a Sefin
   Nacional é este worker. Assim um pico de lentidão da Sefin não segura o
   sistema emissor, e uma falha de rede vira retentativa em vez de nota presa. */
const db = require('../db');
const sefin = require('../nfse/sefinClient');
const { carregarCertificadoAtivo } = require('./certificadoService');
const webhooks = require('./webhooks');

/* Estado final alcançado: notifica os webhooks configurados.
   Uma falha aqui não pode desfazer o desfecho da nota, que já está gravado —
   por isso o erro é registrado e engolido. */
async function notificar(notaId) {
  try {
    await webhooks.enfileirarParaNota(notaId);
  } catch (e) {
    console.error(`[fila] falha ao enfileirar webhook da nota ${notaId}: ${e.message}`);
  }
}

const INTERVALO_MS = Number(process.env.FILA_INTERVALO_MS || 3000);
const MAX_TENTATIVAS = Number(process.env.FILA_MAX_TENTATIVAS || 5);
const LEASE_SEGUNDOS = Number(process.env.FILA_LEASE_SEGUNDOS || 120);

let timer = null;
let rodando = false;

/* Backoff exponencial: 5s, 20s, 45s, 80s... limitado a 10 min. */
function proximaTentativaSegundos(tentativas) {
  return Math.min(5 * tentativas * tentativas, 600);
}

/**
 * Reivindica UMA nota pendente de forma atômica.
 *
 * FOR UPDATE SKIP LOCKED garante que dois workers concorrentes peguem notas
 * diferentes em vez de bloquear ou duplicar. O lease (bloqueado_ate) cobre o
 * caso do processo morrer no meio da transmissão: passado o prazo, a nota
 * volta a ser elegível.
 */
async function reivindicar() {
  const r = await db.query(
    `UPDATE notas SET
       bloqueado_ate = now() + ($1 || ' seconds')::interval,
       tentativas    = tentativas + 1,
       atualizado_em = now()
     WHERE id = (
       SELECT id FROM notas
        WHERE status = 'processando'
          AND (processar_apos IS NULL OR processar_apos <= now())
          AND (bloqueado_ate  IS NULL OR bloqueado_ate  <= now())
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [String(LEASE_SEGUNDOS)]
  );
  return r.rows[0] || null;
}

async function marcarFalha(nota, mensagem) {
  const desiste = nota.tentativas >= MAX_TENTATIVAS;
  if (desiste) {
    // Esgotou as tentativas: vira 'erro' e sai da fila. A nota NÃO foi
    // confirmada pela Sefin — a numeração reservada fica com esse buraco,
    // que é o comportamento correto (não reaproveitar número de DPS).
    await db.query(
      `UPDATE notas SET status='erro', ultimo_erro=$2, bloqueado_ate=NULL, atualizado_em=now()
       WHERE id=$1`, [nota.id, mensagem]);
    console.error(`[fila] nota ${nota.id} desistiu após ${nota.tentativas} tentativas: ${mensagem}`);
    await notificar(nota.id);
  } else {
    const espera = proximaTentativaSegundos(nota.tentativas);
    await db.query(
      `UPDATE notas SET ultimo_erro=$2, bloqueado_ate=NULL,
              processar_apos = now() + ($3 || ' seconds')::interval, atualizado_em=now()
       WHERE id=$1`, [nota.id, mensagem, String(espera)]);
    console.warn(`[fila] nota ${nota.id} falhou (tentativa ${nota.tentativas}), nova tentativa em ${espera}s: ${mensagem}`);
  }
}

async function transmitir(nota) {
  const emp = await db.query('SELECT * FROM empresas WHERE id = $1', [nota.empresa_id]);
  if (!emp.rows.length) {
    return marcarFalha(nota, 'Empresa não encontrada');
  }
  const empresa = emp.rows[0];

  let cert;
  try {
    cert = await carregarCertificadoAtivo(empresa.id);
  } catch (e) {
    return marcarFalha(nota, 'Certificado: ' + e.message);
  }

  let resp;
  try {
    resp = await sefin.enviarDps(nota.ambiente || empresa.ambiente, nota.dps_xml, cert);
  } catch (e) {
    // Falha de rede/transporte: pode ser transitória, então retenta.
    return marcarFalha(nota, 'Comunicação com a Sefin: ' + e.message);
  }

  const autorizada = resp.status >= 200 && resp.status < 300 && resp.json && resp.json.chaveAcesso;

  // 5xx da Sefin é transitório: retenta em vez de rejeitar a nota.
  if (!autorizada && resp.status >= 500) {
    return marcarFalha(nota, `Sefin retornou HTTP ${resp.status}`);
  }

  // 401/403 não são julgamento da nota: são credencial recusada (certificado
  // fora da ICP-Brasil, vencido, ou empresa não habilitada no ambiente).
  // Retentar não resolve, mas chamar de "rejeitada" faria parecer que a Sefin
  // analisou e recusou o documento — então o status correto é 'erro'.
  if (!autorizada && (resp.status === 401 || resp.status === 403)) {
    await db.query(
      `UPDATE notas SET status='erro', ultimo_erro=$2, mensagens=$3,
              bloqueado_ate=NULL, processar_apos=NULL, atualizado_em=now()
       WHERE id=$1`,
      [nota.id,
       `Sefin recusou a credencial (HTTP ${resp.status}). Verifique se o certificado é ICP-Brasil, está válido e se a empresa está habilitada neste ambiente.`,
       JSON.stringify({ httpStatus: resp.status, corpo: String(resp.raw).slice(0, 2000) })]
    );
    console.error(`[fila] nota ${nota.id}: credencial recusada pela Sefin (HTTP ${resp.status})`);
    await notificar(nota.id);
    return;
  }

  await db.query(
    `UPDATE notas SET status=$2, chave_acesso=$3, nfse_xml=$4, mensagens=$5,
            ultimo_erro=NULL, bloqueado_ate=NULL, processar_apos=NULL, atualizado_em=now()
     WHERE id=$1`,
    [
      nota.id,
      autorizada ? 'autorizada' : 'rejeitada',
      autorizada ? resp.json.chaveAcesso : null,
      autorizada ? resp.json.nfseXml : null,
      JSON.stringify(resp.json ?? { httpStatus: resp.status, corpo: resp.raw })
    ]
  );
  console.log(`[fila] nota ${nota.id} ${autorizada ? 'autorizada' : 'rejeitada'} (HTTP ${resp.status})`);
  await notificar(nota.id);
}

/* Processa até `limite` notas por rodada. Exportada para permitir
   execução manual e teste sem depender do timer. */
async function processarRodada(limite = 10) {
  let n = 0;
  for (; n < limite; n++) {
    const nota = await reivindicar();
    if (!nota) break;
    try {
      await transmitir(nota);
    } catch (e) {
      // Falha inesperada: libera o lease para retentativa em vez de deixar preso.
      await marcarFalha(nota, 'Erro inesperado: ' + e.message);
    }
  }
  return n;
}

async function tick() {
  if (rodando) return;          // evita sobreposição se uma rodada demorar
  rodando = true;
  try {
    await processarRodada();
  } catch (e) {
    console.error('[fila] erro na rodada:', e.message);
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (timer) return;
  timer = setInterval(tick, INTERVALO_MS);
  if (timer.unref) timer.unref();   // não segura o processo no encerramento
  console.log(`[fila] worker de emissão ativo (a cada ${INTERVALO_MS}ms)`);
}

function parar() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { iniciar, parar, processarRodada, reivindicar };
