/* Worker de transmissão das DPS pendentes.
   A requisição HTTP só monta, assina e grava a nota; quem fala com a Sefin
   Nacional é este worker. Assim um pico de lentidão da Sefin não segura o
   sistema emissor, e uma falha de rede vira retentativa em vez de nota presa. */
const db = require('../db');
const sefin = require('../nfse/sefinClient');
const { carregarCertificadoAtivo } = require('./certificadoService');
const webhooks = require('./webhooks');
const emailTomador = require('./emailTomador');

/* Estado final alcançado: notifica webhooks e, se autorizada, e-mail ao
   tomador. Uma falha aqui não pode desfazer o desfecho da nota, que já está
   gravado — por isso cada erro é registrado e engolido. */
async function notificar(notaId) {
  try {
    await webhooks.enfileirarParaNota(notaId);
  } catch (e) {
    console.error(`[fila] falha ao enfileirar webhook da nota ${notaId}: ${e.message}`);
  }
  try {
    // enfileirarParaNota já filtra: só autorizada, empresa opt-in e com e-mail.
    await emailTomador.enfileirarParaNota(notaId);
  } catch (e) {
    console.error(`[fila] falha ao enfileirar e-mail da nota ${notaId}: ${e.message}`);
  }
}

const INTERVALO_MS = Number(process.env.FILA_INTERVALO_MS || 3000);
const MAX_TENTATIVAS = Number(process.env.FILA_MAX_TENTATIVAS || 5);
const LEASE_SEGUNDOS = Number(process.env.FILA_LEASE_SEGUNDOS || 120);

let timer = null;
let rodando = false;

/* Backoff exponencial: 5s, 20s, 45s, 80s... limitado a 10 min.
   Para falha de rede o teto é menor: quando a internet volta, ninguém quer
   esperar mais dez minutos para a nota sair. */
function proximaTentativaSegundos(tentativas, transitoria) {
  return Math.min(5 * tentativas * tentativas, transitoria ? 120 : 600);
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

/* Registra a falha e decide se ainda vale insistir.
 *
 * `tipo` é o que separa "a Sefin não foi alcançada" de "a Sefin recusou a
 * credencial". A primeira não é julgamento nenhum sobre a nota, e desistir dela
 * queima um número da sequência fiscal por causa de um cabo solto — que foi
 * exatamente o que acontecia com qualquer queda de internet acima de cinco
 * minutos. Falha transitória fica na fila para sempre; a tela mostra a espera. */
async function marcarFalha(nota, mensagem, tipo = 'definitiva') {
  const transitoria = tipo === 'rede' || tipo === 'sefin';
  const desiste = !transitoria && nota.tentativas >= MAX_TENTATIVAS;

  if (transitoria) {
    const espera = proximaTentativaSegundos(nota.tentativas, true);
    await db.query(
      `UPDATE notas SET ultimo_erro=$2, falha_tipo=$3, bloqueado_ate=NULL,
              processar_apos = now() + ($4 || ' seconds')::interval, atualizado_em=now()
       WHERE id=$1`, [nota.id, mensagem, tipo, String(espera)]);
    console.warn(`[fila] nota ${nota.id} esperando conexão (tentativa ${nota.tentativas}), ` +
                 `nova tentativa em ${espera}s: ${mensagem}`);
    return;
  }

  if (desiste) {
    // Esgotou as tentativas: vira 'erro' e sai da fila. A nota NÃO foi
    // confirmada pela Sefin — a numeração reservada fica com esse buraco,
    // que é o comportamento correto (não reaproveitar número de DPS).
    await db.query(
      `UPDATE notas SET status='erro', ultimo_erro=$2, falha_tipo='definitiva',
              bloqueado_ate=NULL, atualizado_em=now()
       WHERE id=$1`, [nota.id, mensagem]);
    console.error(`[fila] nota ${nota.id} desistiu após ${nota.tentativas} tentativas: ${mensagem}`);
    await notificar(nota.id);
  } else {
    const espera = proximaTentativaSegundos(nota.tentativas, false);
    await db.query(
      `UPDATE notas SET ultimo_erro=$2, falha_tipo='definitiva', bloqueado_ate=NULL,
              processar_apos = now() + ($3 || ' seconds')::interval, atualizado_em=now()
       WHERE id=$1`, [nota.id, mensagem, String(espera)]);
    console.warn(`[fila] nota ${nota.id} falhou (tentativa ${nota.tentativas}), nova tentativa em ${espera}s: ${mensagem}`);
  }
}

async function transmitir(nota) {
  const emp = await db.query('SELECT * FROM empresas WHERE id = $1', [nota.empresa_id]);
  if (!emp.rows.length) {
    return marcarFalha(nota, 'Empresa não encontrada', 'definitiva');
  }
  const empresa = emp.rows[0];

  let cert;
  try {
    cert = await carregarCertificadoAtivo(empresa.id);
  } catch (e) {
    return marcarFalha(nota, 'Certificado: ' + e.message, 'definitiva');
  }

  let resp;
  try {
    /* Quem recebe a DPS depende do município do emitente: a Sefin Nacional na
       maioria, o provedor municipal onde ele aceita o layout nacional. O
       documento é o mesmo — muda o carteiro. */
    const mun = await require('./municipiosService').obter(empresa.codigo_municipio);
    const transporte = require('../nfse/emissorMunicipal').transporte(mun, empresa);
    resp = await transporte.enviarDps(
      mun, nota.ambiente || empresa.ambiente, nota.dps_xml, cert);
  } catch (e) {
    /* Não chegou a falar com a Sefin: DNS, timeout, cabo, roteador reiniciando.
       A nota está pronta e assinada aqui — só falta a linha. Fica na fila. */
    return marcarFalha(nota, 'Sem conexão com a Sefin: ' + e.message, 'rede');
  }

  const autorizada = resp.status >= 200 && resp.status < 300 && resp.json && resp.json.chaveAcesso;

  // 5xx da Sefin é transitório: retenta em vez de rejeitar a nota. Em janeiro
  // de 2026 a Receita reconheceu indisponibilidade do Emissor Nacional por
  // volume de acesso — dias assim não podem queimar numeração.
  if (!autorizada && resp.status >= 500) {
    return marcarFalha(nota, `A Sefin respondeu HTTP ${resp.status} (indisponível)`, 'sefin');
  }

  // 401/403 não são julgamento da nota: são credencial recusada (certificado
  // fora da ICP-Brasil, vencido, ou empresa não habilitada no ambiente).
  // Retentar não resolve, mas chamar de "rejeitada" faria parecer que a Sefin
  // analisou e recusou o documento — então o status correto é 'erro'.
  if (!autorizada && (resp.status === 401 || resp.status === 403)) {
    await db.query(
      `UPDATE notas SET status='erro', ultimo_erro=$2, mensagens=$3,
              falha_tipo='definitiva', bloqueado_ate=NULL, processar_apos=NULL,
              atualizado_em=now()
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
            ultimo_erro=NULL, falha_tipo=NULL, bloqueado_ate=NULL,
            processar_apos=NULL, atualizado_em=now()
     WHERE id=$1`,
    [
      nota.id,
      autorizada ? 'autorizada' : 'rejeitada',
      autorizada ? resp.json.chaveAcesso : null,
      autorizada ? resp.json.nfseXml : null,
      JSON.stringify(resp.json ?? { httpStatus: resp.status, corpo: resp.raw })
    ]
  );
  // Substituição autorizada: a Sefin cancelou a original (evento de
  // Cancelamento por Substituição). Refletir isso aqui, senão a original
  // continuaria aparecendo como 'autorizada' no gateway estando cancelada
  // na Sefin.
  if (autorizada && nota.substitui_chave) {
    const r = await db.query(
      `UPDATE notas SET status='substituida', substituida_por=$2, atualizado_em=now()
       WHERE chave_acesso=$1 AND status <> 'substituida' RETURNING id`,
      [nota.substitui_chave, resp.json.chaveAcesso]);
    if (r.rows.length) {
      console.log(`[fila] nota ${r.rows[0].id} marcada como substituida pela ${nota.id}`);
    }
  }

  if (!autorizada) await aprenderRegraIm(nota, empresa, resp.json);

  console.log(`[fila] nota ${nota.id} ${autorizada ? 'autorizada' : 'rejeitada'} (HTTP ${resp.status})`);
  await notificar(nota.id);
}

/* A Sefin acabou de dizer se a IM devia ou não estar na DPS. Guardar isso
   evita queimar um segundo número da sequência fiscal pelo mesmo motivo:
   E0116 e E0120 são a mesma pergunta respondida nos dois sentidos, e a
   resposta vale para o par município + ambiente, não para a empresa. */
async function aprenderRegraIm(nota, empresa, retorno) {
  var codigos = ((retorno && retorno.erros) || []).map(function (e) {
    return String(e.Codigo || e.codigo || '');
  });
  var exige;
  if (codigos.indexOf('E0116') >= 0) exige = true;       // faltou a IM
  else if (codigos.indexOf('E0120') >= 0) exige = false;  // sobrou a IM
  else return;

  var ambiente = nota.ambiente || empresa.ambiente;
  await db.query(
    `INSERT INTO regra_im_dps (codigo_municipio, ambiente, exige_im, origem, observacao)
     VALUES ($1, $2, $3, 'sefin', $4)
     ON CONFLICT (codigo_municipio, ambiente) DO UPDATE SET
       exige_im = EXCLUDED.exige_im, origem = 'sefin',
       observacao = EXCLUDED.observacao, atualizado_em = now()`,
    [empresa.codigo_municipio, ambiente, exige,
     'Aprendido da rejeicao da DPS ' + nota.serie + '/' + nota.numero]);

  console.log('[fila] regra da IM aprendida: municipio ' + empresa.codigo_municipio +
              ' em ' + ambiente + ' ' + (exige ? 'exige' : 'proibe') + ' a IM');
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

/* marcarFalha sai exportada porque a queda de internet e o unico caminho
   que nao da para exercitar de fora sem derrubar a rede da maquina. */
module.exports = { iniciar, parar, processarRodada, reivindicar, marcarFalha };
