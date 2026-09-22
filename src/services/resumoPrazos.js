/* Resumo diário dos prazos do escritório.
 *
 * A agenda existe no painel, mas só é vista por quem abre o painel. Um prazo
 * que vence hoje precisa alcançar a pessoa onde ela está — e o e-mail chega no
 * celular sem que o gateway precise ser exposto na internet.
 *
 * Vai com os compromissos anexados em .ics: quem recebe toca uma vez e os
 * prazos entram na agenda do celular, com alarme. É o mesmo resultado de uma
 * integração com a API do Google Agenda, sem projeto no Google Cloud, sem
 * token de terceiro guardado aqui e funcionando em qualquer agenda.
 */
const db = require('../db');
const nodemailer = require('nodemailer');
const configEmail = require('./configEmail');
const obrigacoes = require('./obrigacoes');
const identidade = require('./identidade');
const { montarIcs } = require('../util/calendario');
const { dataLocalISO } = require('../util/data');

const INTERVALO_MS = 15 * 60 * 1000;   // confere de 15 em 15 minutos
let timer = null;

function fmtData(iso) {
  return String(iso).slice(0, 10).split('-').reverse().join('/');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Monta o corpo do aviso. Atrasadas primeiro: é o que precisa de resposta
   hoje, e enterrá-las no meio da lista é o mesmo que não avisar. */
function montarHtml(lista, marca) {
  const atrasadas = lista.filter(o => o.atrasada);
  const proximas = lista.filter(o => !o.atrasada);

  const linha = o =>
    `<tr>
       <td style="padding:7px 12px 7px 0;white-space:nowrap;font-variant-numeric:tabular-nums">
         ${esc(fmtData(o.vencimento))}</td>
       <td style="padding:7px 12px 7px 0">${esc(o.razao_social)}</td>
       <td style="padding:7px 12px 7px 0">${esc(o.nome)}</td>
       <td style="padding:7px 0;color:#6b7280">${esc(o.competencia)}</td>
     </tr>`;

  const bloco = (titulo, itens, cor) => !itens.length ? '' :
    `<h3 style="font-size:14px;margin:22px 0 8px;color:${cor}">${titulo} (${itens.length})</h3>
     <table style="border-collapse:collapse;font-size:14px;width:100%">${itens.map(linha).join('')}</table>`;

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#14181f;max-width:640px">
    <h2 style="font-size:17px;margin:0 0 4px">${esc(marca.nome || 'Prazos do escritório')}</h2>
    <div style="color:#6b7280;font-size:13px;margin-bottom:4px">
      Obrigações de ${esc(fmtData(dataLocalISO()))}</div>
    ${bloco('Atrasadas', atrasadas, '#a41f1f')}
    ${bloco('A vencer', proximas, '#8a5a13')}
    <p style="color:#6b7280;font-size:12.5px;margin-top:26px;border-top:1px solid #e5e7eb;padding-top:14px">
      Os compromissos vão anexados neste e-mail: abra o anexo para colocá-los na
      sua agenda, com aviso no celular.<br>
      ${esc(marca.rodape || '')}
    </p>
  </div>`;
}

/* O escritório recebe um arquivo só, com todos os prazos. Reenviar o mesmo
   prazo atualiza o compromisso em vez de duplicá-lo — o UID é estável. */
function montarAnexo(lista) {
  return montarIcs(lista.map(o => ({
    id: 'obrigacao-' + o.id,
    titulo: `${o.nome} · ${o.razao_social}`,
    descricao: `Competência ${o.competencia}.` +
               (o.observacao ? ` ${o.observacao}` : ''),
    /* O driver devolve DATE como objeto Date, não como texto. Recortar os dez
       primeiros caracteres de um Date dá "Thu Sep 10", e a data vira NaN no
       arquivo — que a agenda ignora em silêncio. */
    data: o.vencimento instanceof Date ? o.vencimento : String(o.vencimento).slice(0, 10),
    alarmeDias: 1
  })), { nome: 'Obrigações do escritório' });
}

async function transporte(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.porta, secure: cfg.seguro,
    auth: cfg.usuario ? { user: cfg.usuario, pass: cfg.senha } : undefined
  });
}

/**
 * Envia o resumo, se for a hora e se ainda não foi enviado hoje.
 * `forcar` ignora as duas condições — é o botão "enviar agora" da tela.
 */
async function enviar({ forcar = false } = {}) {
  const c = await configEmail.ler();
  if (!forcar) {
    if (!c.resumo_diario || !c.resumo_para) return { enviado: false, motivo: 'resumo desligado' };
    const agora = new Date();
    if (agora.getHours() < Number(c.resumo_hora)) {
      return { enviado: false, motivo: 'ainda não deu a hora' };
    }
    if (c.resumo_enviado_em && dataLocalISO(new Date(c.resumo_enviado_em)) === dataLocalISO()) {
      return { enviado: false, motivo: 'já enviado hoje' };
    }
  }
  const destino = c.resumo_para;
  if (!destino) throw Object.assign(new Error('Informe para quem enviar o resumo.'), { status: 400 });

  const cfg = await configEmail.efetiva();
  if (!cfg) throw Object.assign(new Error('E-mail não configurado.'), { status: 400 });

  // null = todas as empresas: o resumo é do escritório, não de um operador
  const lista = await obrigacoes.agenda({ empresasIds: null, dias: 15 });
  if (!lista.length && !forcar) {
    // Nada a vencer não gera e-mail: aviso diário vazio ensina a ignorar o aviso
    await db.query('UPDATE config_email SET resumo_enviado_em = CURRENT_DATE WHERE id = TRUE');
    return { enviado: false, motivo: 'nenhum prazo no período' };
  }

  const marca = await identidade.ler();
  const t = await transporte(cfg);
  const atrasadas = lista.filter(o => o.atrasada).length;

  await t.sendMail({
    from: cfg.remetente,
    to: destino,
    subject: (atrasadas ? `[${atrasadas} atrasada(s)] ` : '') +
             `Prazos de ${fmtData(dataLocalISO())}` +
             (marca.nome ? ` · ${marca.nome}` : ''),
    html: montarHtml(lista, marca),
    attachments: lista.length ? [{
      filename: 'prazos.ics',
      content: montarAnexo(lista),
      contentType: 'text/calendar; charset=utf-8; method=PUBLISH'
    }] : []
  });

  await db.query('UPDATE config_email SET resumo_enviado_em = CURRENT_DATE WHERE id = TRUE');
  return { enviado: true, prazos: lista.length, atrasadas, destino };
}

function iniciar() {
  if (timer) return;

  /* Um resumo por escritório, e cada um com o seu SMTP e a sua lista de
     prazos — `config_email` deixou de ser linha única do servidor.

     Escritório sem e-mail configurado, ou sem destinatário, não é falha: é a
     configuração padrão de quem ainda não mexeu nisso. `enviar` sinaliza esses
     casos com status 400, e aqui eles passam calados. Um aviso diário por
     escritório não configurado ensinaria a ignorar o log inteiro. */
  const rodar = () => db.porInquilino(
    () => enviar().catch(e => {
      if (e.status === 400) return;
      throw e;
    }),
    (e, id) => console.warn(`[resumo] escritório ${id} falhou:`, e.message)
  ).catch(e => console.warn('[resumo] não consegui listar escritórios:', e.message));
  timer = setInterval(rodar, INTERVALO_MS);
  timer.unref();
  setTimeout(rodar, 90000).unref();   // uma vez, pouco depois de subir
}

function parar() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { enviar, iniciar, parar, montarHtml, montarAnexo };
