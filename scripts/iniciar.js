#!/usr/bin/env node
/**
 * Sobe o gateway esperando o banco estar de pé.
 *
 * É o que a tarefa do Windows executa. Existe por causa de uma ordem que só
 * aparece depois de um reinício de verdade:
 *
 *   - a tarefa do gateway dispara na inicialização
 *   - o serviço do Postgres também, e não há garantia de quem chega primeiro
 *   - se o gateway chegar antes, ele sobe sem banco e fica inútil em silêncio
 *
 * Antes disto, a tarefa chamava `src/server.js` direto e pulava o
 * `garantir-banco.js`, que é um hook de `prestart` do npm. Numa máquina
 * reiniciada isso significava gateway no ar, banco fora, e a mesma falha muda
 * que a tarefa foi criada para eliminar.
 *
 * Por que esperar em vez de subir o Postgres daqui: no Windows, o
 * `postgres.exe` se recusa a rodar sob conta administrativa, e a tarefa roda
 * como SYSTEM. A exceção é quando quem o inicia é o Gerenciador de Serviços —
 * por isso o Postgres do gateway é registrado como serviço, e aqui só se
 * espera por ele.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

const ESPERA_MAX_MS = 120000;
const INTERVALO_MS = 1000;

/* O registro em arquivo começa AQUI, e não no server.js.
   A espera pelo banco acontece antes de o servidor carregar; sem isto, o
   trecho mais interessante do boot — quanto tempo se esperou, e se chegou a
   desistir — ficava só no stdout da tarefa, que ninguém lê. */
require(path.join(RAIZ, 'src', 'services', 'registro')).iniciar();

function alvo() {
  /* A porta do banco vem da URL. O Postgres portátil escolhe a porta livre na
     instalação e a grava ao lado dos dados, então ela varia por máquina. */
  const url = process.env.DATABASE_URL ||
    (fs.existsSync(path.join(RAIZ, '.env'))
      ? (fs.readFileSync(path.join(RAIZ, '.env'), 'utf8')
          .match(/^DATABASE_URL=(.+)$/m) || [])[1]
      : null);
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return { host: u.hostname, porta: Number(u.port || 5432) };
  } catch (_) { return null; }
}

function atende({ host, porta }) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: porta });
    const fim = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(2000);
    s.on('connect', () => fim(true));
    s.on('error', () => fim(false));
    s.on('timeout', () => fim(false));
  });
}

async function esperarBanco() {
  const onde = alvo();
  if (!onde) return;                       // banco externo ou URL ilegível
  if (await atende(onde)) return;

  const desde = Date.now();
  console.log('[iniciar] esperando o banco em ' + onde.host + ':' + onde.porta + '…');
  const limite = Date.now() + ESPERA_MAX_MS;
  while (Date.now() < limite) {
    await new Promise(r => setTimeout(r, INTERVALO_MS));
    if (await atende(onde)) {
      console.log('[iniciar] banco respondeu em ' +
        Math.round((Date.now() - desde) / 1000) + 's; subindo o gateway');
      return;
    }
  }

  /* Dois minutos é bastante para um serviço que sobe junto com o Windows. Se
     não veio, subir mesmo assim é melhor do que não subir: o painel abre, o
     erro aparece na tela e alguém consegue agir. Ficar esperando para sempre
     deixaria a máquina sem nada, e sem ninguém saber por quê. */
  console.error('[iniciar] o banco não respondeu em ' + (ESPERA_MAX_MS / 1000) +
    's. Subindo assim mesmo — o painel vai mostrar o erro de conexão. ' +
    'Confira o serviço nfse-postgres.');
}

esperarBanco()
  .catch(e => console.error('[iniciar]', e.message))
  .then(() => require(path.join(RAIZ, 'src', 'server.js')));
