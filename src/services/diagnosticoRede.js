const os = require('os');
const db = require('../db');
const config = require('../config');

/* Diagnóstico de rede do gateway.
 *
 * NÃO EXISTE PORTA PARA ABRIR, NEM IP PÚBLICO NEM DNS PARA APONTAR, e isso é
 * a decisão de arquitetura, não uma funcionalidade que falta. Todas as
 * conexões partem daqui:
 *
 *   gateway → Sefin Nacional   (transmite a DPS, consulta, cancela)
 *   gateway → portal do cliente (busca solicitação, devolve desfecho, replica cadastro)
 *
 * O portal nunca precisa enxergar esta máquina. Encaminhar porta no roteador
 * para "o portal alcançar o gateway" exporia à internet justamente o
 * computador que guarda os certificados A1 e as notas de todos os clientes do
 * escritório — e não resolveria nada que o laço de saída já não resolva.
 *
 * O que este módulo faz, então, é o contrário: conferir se as saídas funcionam
 * e dizer onde parou quando não funcionam. É o painel que o escritório precisa
 * quando alguém pergunta "está tudo certo?".
 *
 * Rede local é outra conversa, e essa sim tem configuração: para outra máquina
 * do escritório abrir o painel, o gateway precisa aceitar conexão da rede
 * (HOST) e o firewall do Windows precisa liberar a porta. Nada disso envolve
 * roteador nem internet.
 */

const TIMEOUT_MS = 8000;

/* Endereços desta máquina na rede local — é por eles que outro computador do
   escritório abre o painel. Descarta interface interna e IPv6 de link local. */
function enderecosLocais() {
  const achados = [];
  const interfaces = os.networkInterfaces();
  for (const nome of Object.keys(interfaces)) {
    for (const i of interfaces[nome] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      achados.push({ interface: nome, ip: i.address });
    }
  }
  return achados;
}

async function bater(url, opcoes = {}) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TIMEOUT_MS);
  const comeco = Date.now();
  try {
    const r = await fetch(url, Object.assign({
      method: 'GET', signal: controle.signal, redirect: 'manual'
    }, opcoes));
    return { ok: true, status: r.status, ms: Date.now() - comeco };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - comeco,
      erro: e.name === 'AbortError'
        ? `sem resposta em ${TIMEOUT_MS / 1000}s`
        : (e.cause && e.cause.code) || e.message
    };
  } finally {
    clearTimeout(prazo);
  }
}

/* A saída para a Sefin. Qualquer resposta HTTP serve como prova de que a linha
   existe: 401 e 403 são a Sefin dizendo "sem certificado nesta chamada", e é
   justamente o que se espera de um teste sem mTLS. O que interessa aqui é o
   caminho, não a credencial. */
async function conferirSefin(ambiente) {
  const amb = config.ambientes[ambiente] || config.ambientes.producao;
  const base = amb.sefinBaseUrl || '';
  if (!base) return { nome: 'Sefin Nacional', alcancavel: false, detalhe: 'ambiente sem URL configurada' };

  const r = await bater(base);
  return {
    nome: 'Sefin Nacional (' + ambiente + ')',
    endereco: base,
    alcancavel: r.ok,
    ms: r.ms,
    detalhe: r.ok
      ? `respondeu HTTP ${r.status} em ${r.ms} ms`
      : 'não respondeu — ' + r.erro
  };
}

async function conferirPortal() {
  const ponte = require('./ponteNuvem');
  const c = await ponte.ler();
  if (!c.url) {
    return { nome: 'Portal do cliente', alcancavel: null,
             detalhe: 'não configurado — o portal é opcional' };
  }
  const r = await bater(c.url);
  return {
    nome: 'Portal do cliente',
    endereco: c.url,
    alcancavel: r.ok,
    ms: r.ms,
    detalhe: r.ok ? `respondeu HTTP ${r.status} em ${r.ms} ms`
                  : 'não respondeu — ' + r.erro
  };
}

/* Notas prontas e assinadas esperando a linha voltar.
   Elas não estão perdidas nem queimadas: o número já está reservado, o XML já
   está assinado, e saem sozinhas quando a conexão voltar. */
async function filaDeEspera() {
  const r = await db.query(
    `SELECT count(*)::int AS total,
            min(criado_em) AS mais_antiga,
            max(ultimo_erro) AS ultimo_erro
       FROM notas
      WHERE status = 'processando' AND falha_tipo IN ('rede', 'sefin')`);
  const f = r.rows[0];

  const proc = await db.query(
    `SELECT count(*)::int AS total FROM notas WHERE status = 'processando'`);

  /* DPS assinada hoje e transmitida daqui a dias pode não ser aceita: a data de
     emissão vai dentro do documento assinado. Não achei o prazo exato nos
     esquemas publicados, então o aviso é honesto sobre isso em vez de inventar
     um número — mas espera longa precisa ser olhada por gente. */
  const horas = f.mais_antiga
    ? (Date.now() - new Date(f.mais_antiga).getTime()) / 3600000 : 0;

  return {
    esperandoConexao: f.total,
    naFila: proc.rows[0].total,
    maisAntiga: f.mais_antiga,
    horasEsperando: Math.round(horas * 10) / 10,
    ultimoErro: f.ultimo_erro,
    alerta: horas >= 24
      ? 'Há nota assinada esperando há mais de um dia. A data de emissão vai dentro ' +
        'do documento assinado, e a Sefin pode recusar uma DPS antiga — confira ' +
        'estas notas antes que a fila volte a andar.'
      : null
  };
}

async function completo() {
  const [sefin, portal, fila] = await Promise.all([
    conferirSefin(process.env.AMBIENTE_PADRAO || 'producao'),
    conferirPortal(),
    filaDeEspera()
  ]);

  const porta = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  return {
    saidas: [sefin, portal],
    fila,
    rede: {
      porta,
      host,
      /* 0.0.0.0 aceita conexão de qualquer interface — inclusive da rede do
         escritório. É o que permite outra máquina abrir o painel, e é bom o
         contador saber que é assim. */
      aceitaRedeLocal: host === '0.0.0.0' || host === '::',
      enderecos: enderecosLocais().map(e => Object.assign(e, {
        url: `http://${e.ip}:${porta}`
      }))
    },
    /* Repetido aqui de propósito: é a pergunta que sempre volta, e a resposta
       precisa estar na tela, não só na documentação. */
    exposicao: {
      precisaAbrirPorta: false,
      precisaIpPublico: false,
      precisaDns: false,
      porque: 'Todas as conexões partem do gateway. O portal e a Sefin nunca ' +
              'iniciam conexão para esta máquina, então não há porta para ' +
              'encaminhar no roteador, nem IP fixo ou DNS para contratar.'
    }
  };
}

module.exports = { completo, conferirSefin, conferirPortal, filaDeEspera, enderecosLocais };
