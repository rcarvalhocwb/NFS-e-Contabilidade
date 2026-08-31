#!/usr/bin/env node
/**
 * Monitor do gateway — programa separado, com ícone próprio.
 *
 * POR QUE NÃO É UMA TELA DO PAINEL: um monitor que morre junto com o que ele
 * monitora não serve para nada. Quando o gateway cai — que é exatamente quando
 * alguém quer olhar — o painel cai com ele. Este processo é outro: sobe
 * sozinho, lê o log e o banco direto, e continua de pé para dizer o que houve e
 * para religar o gateway.
 *
 * O QUE ELE NÃO É: não emite nota, não assina nada, não fala com a Sefin nem
 * com a Meta. Ele observa e liga/desliga. Tudo que ele mostra já existe no
 * banco e no log.
 *
 * ACESSO: atende só em 127.0.0.1, e exige um token sorteado a cada subida. O
 * `Monitor.bat` lê o token e abre o navegador já com ele — ninguém digita nada.
 * Sem isso, qualquer programa da máquina que falasse com a porta poderia parar
 * a emissão do escritório.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PORTA = Number(process.env.MONITOR_PORT || 3100);
const GATEWAY = process.env.MONITOR_GATEWAY || 'http://127.0.0.1:3000';
const NOME_TAREFA = 'NFS-e Gateway';
const NOME_SERVICO_BANCO = 'nfse-postgres';
const ARQUIVO_SESSAO = path.join(__dirname, 'sessao.txt');
const PASTA_LOG = process.env.LOG_PASTA || path.join(RAIZ, 'logs');

/* O token vem do Monitor.bat quando ele o sorteou; senão, sorteia aqui. Os dois
   caminhos existem porque o .bat precisa saber o token para montar a URL. */
const TOKEN = process.env.MONITOR_TOKEN || crypto.randomBytes(24).toString('hex');

let db = null;
try { db = require(path.join(RAIZ, 'src', 'db')); } catch (_) { /* sem banco: o resto ainda serve */ }

/* --------------------------------------------------------------- utilidades */

function rodar(programa, args, ms = 6000) {
  return new Promise(resolve => {
    execFile(programa, args, { timeout: ms, windowsHide: true },
      (erro, saida, err) => resolve({ erro, texto: String(saida || '') + String(err || '') }));
  });
}

async function alcanca(url, ms = 2500) {
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.status;
  } catch (_) { return null; } finally { clearTimeout(prazo); }
}

/* --------------------------------------------------------------- o retrato */

async function estadoDoWindows() {
  if (process.platform !== 'win32') return { tarefa: 'nao_se_aplica', banco: 'nao_se_aplica' };

  const [t, b] = await Promise.all([
    rodar('schtasks', ['/query', '/TN', NOME_TAREFA, '/FO', 'LIST']),
    rodar('sc', ['query', NOME_SERVICO_BANCO])
  ]);

  let tarefa;
  if (!t.erro) {
    tarefa = /running|em execu/i.test(
      (t.texto.match(/(?:Status|Estado):\s*(.+)/i) || [])[1] || '') ? 'rodando' : 'parada';
  } else {
    tarefa = /negado|denied/i.test(t.texto) ? 'sem_permissao' : 'ausente';
  }

  const banco = /RUNNING|EM_EXECU/i.test(b.texto) ? 'rodando'
              : /1060|does not exist|n.o existe/i.test(b.texto) ? 'ausente' : 'parado';

  return { tarefa, banco };
}

async function doBanco() {
  if (!db) return null;
  try {
    const [fila, notas, pedidos] = await Promise.all([
      db.query(`SELECT status, count(*)::int n FROM notas
                 WHERE status IN ('processando','erro') GROUP BY status`),
      db.query(`SELECT n.id, n.serie, n.numero, n.status, n.ambiente, n.atualizado_em,
                       e.nome_fantasia, e.razao_social
                  FROM notas n LEFT JOIN empresas e ON e.id = n.empresa_id
                 ORDER BY n.id DESC LIMIT 8`),
      db.query(`SELECT s.id_externo, s.situacao, s.origem, s.remetente, s.recebida_em,
                       e.nome_fantasia, e.razao_social
                  FROM solicitacoes s LEFT JOIN empresas e ON e.id = s.empresa_id
                 ORDER BY s.id DESC LIMIT 8`)
    ]);
    const porStatus = {};
    fila.rows.forEach(r => { porStatus[r.status] = r.n; });
    return {
      processando: porStatus.processando || 0,
      comErro: porStatus.erro || 0,
      notas: notas.rows,
      pedidos: pedidos.rows
    };
  } catch (e) {
    return { erro: e.message };
  }
}

async function retrato() {
  const [win, banco, saudeGw] = await Promise.all([
    estadoDoWindows(), doBanco(), alcanca(GATEWAY + '/health')
  ]);
  return {
    em: new Date().toISOString(),
    gateway: saudeGw === 200 ? 'no_ar' : 'fora',
    tarefa: win.tarefa,
    servicoBanco: win.banco,
    dados: banco
  };
}

/* ------------------------------------------------------------- o log ao vivo
 *
 * Segue o arquivo do dia pelo tamanho, lendo só o que cresceu. Ler o arquivo
 * inteiro a cada segundo funcionaria hoje e ficaria pesado em dezembro. */
function arquivoDeHoje() {
  return path.join(PASTA_LOG, 'gateway-' + new Date().toISOString().slice(0, 10) + '.log');
}

let posicao = null;
let arquivoSeguido = null;

function novasLinhas() {
  const arquivo = arquivoDeHoje();
  try {
    const tam = fs.statSync(arquivo).size;
    /* Virada de dia, ou arquivo trocado: recomeça do fim, não do começo — o
       operador quer o que está acontecendo, não o histórico. */
    if (arquivo !== arquivoSeguido) { arquivoSeguido = arquivo; posicao = Math.max(0, tam - 4000); }
    if (tam < posicao) posicao = 0;
    if (tam === posicao) return [];

    const fd = fs.openSync(arquivo, 'r');
    const buf = Buffer.alloc(tam - posicao);
    fs.readSync(fd, buf, 0, buf.length, posicao);
    fs.closeSync(fd);
    posicao = tam;
    return buf.toString('utf8').split('\n').filter(l => l.trim());
  } catch (_) { return []; }
}

/* ------------------------------------------------------------- as ações */

async function acao(qual) {
  if (process.platform !== 'win32') throw new Error('Só no Windows.');

  const priv = await rodar('net', ['session'], 4000);
  if (priv.erro) {
    throw new Error('O monitor não está com permissão de administrador, então ' +
      'não consegue ligar nem desligar o gateway. Feche e abra de novo pelo ' +
      'ícone "Monitor do gateway" — ele pede a permissão sozinho.');
  }

  if (qual === 'parar') {
    await rodar('schtasks', ['/end', '/TN', NOME_TAREFA]);
    return 'Gateway parado. Enquanto isso nenhuma nota é emitida e o WhatsApp não responde.';
  }
  if (qual === 'iniciar') {
    await rodar('schtasks', ['/run', '/TN', NOME_TAREFA]);
    return 'Gateway iniciado. Ele leva alguns segundos para responder.';
  }
  if (qual === 'reiniciar') {
    await rodar('schtasks', ['/end', '/TN', NOME_TAREFA]);
    await new Promise(r => setTimeout(r, 2500));
    await rodar('schtasks', ['/run', '/TN', NOME_TAREFA]);
    return 'Gateway reiniciado. Ele leva alguns segundos para voltar.';
  }
  throw new Error('Ação desconhecida.');
}

/* --------------------------------------------------------------- servidor */

function autorizado(u) { return u.searchParams.get('t') === TOKEN; }

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (!autorizado(u)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Abra o monitor pelo ícone "Monitor do gateway".');
  }

  /* ------------------------------------------------------ os arquivos */
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/monitor.js')) {
    const nome = u.pathname === '/' ? 'monitor.html' : 'monitor.js';
    try {
      let corpo = fs.readFileSync(path.join(__dirname, nome), 'utf8');
      /* O navegador precisa do token nas proprias requisicoes da pagina; sem
         isto o <script> voltaria 403 e a tela ficaria em branco. */
      if (nome === 'monitor.html') corpo = corpo.split('__TOKEN__').join(TOKEN);
      res.writeHead(200, {
        'content-type': TIPOS[path.extname(nome)],
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      return res.end(corpo);
    } catch (e) {
      res.writeHead(500); return res.end('não achei ' + nome);
    }
  }

  /* --------------------------------------------------- o fluxo ao vivo */
  if (req.method === 'GET' && u.pathname === '/eventos') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    const mandar = (tipo, dado) =>
      res.write('event: ' + tipo + '\ndata: ' + JSON.stringify(dado) + '\n\n');

    novasLinhas();                       // descarta o acumulado; daqui, só o novo
    mandar('retrato', await retrato());

    const t1 = setInterval(async () => {
      try { mandar('retrato', await retrato()); } catch (_) {}
    }, 3000);
    const t2 = setInterval(() => {
      const linhas = novasLinhas();
      if (linhas.length) mandar('log', linhas);
    }, 1000);

    req.on('close', () => { clearInterval(t1); clearInterval(t2); });
    return;
  }

  /* --------------------------------------------------------- as ações */
  if (req.method === 'POST' && u.pathname.startsWith('/acao/')) {
    try {
      const texto = await acao(u.pathname.slice(6));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, texto }));
    } catch (e) {
      res.writeHead(409, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ erro: e.message }));
    }
  }

  res.writeHead(404); res.end();
});

if (require.main === module) {
  /* Só 127.0.0.1: o monitor liga e desliga a emissão do escritório. Não há
     motivo para outra máquina da rede alcançá-lo. */
  servidor.listen(PORTA, '127.0.0.1', () => {
    try {
      fs.writeFileSync(ARQUIVO_SESSAO, TOKEN, { encoding: 'utf8', mode: 0o600 });
    } catch (_) { /* o .bat cai para o token do ambiente */ }
    console.log('monitor em http://127.0.0.1:' + PORTA + '/?t=' + TOKEN);
  });

  servidor.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log('o monitor já estava aberto na porta ' + PORTA);
      process.exit(0);
    }
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { servidor, TOKEN };
