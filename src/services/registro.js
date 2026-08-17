const fs = require('fs');
const path = require('path');

/**
 * Registro em arquivo, além do console.
 *
 * O gateway roda numa janela de console que a contabilidade fecha ao fim do
 * expediente — e com ela vai embora todo o histórico. Quando alguém liga
 * dizendo "a nota não saiu ontem", não há o que consultar.
 *
 * Sem biblioteca: o volume é de dezenas de linhas por dia, e um arquivo por dia
 * com 30 dias de retenção resolve. Nada aqui justifica winston ou pino.
 */

const PASTA = process.env.LOG_PASTA || path.join(__dirname, '..', '..', 'logs');
const DIAS_RETENCAO = 30;

let fluxo = null;
let diaAtual = null;

function nomeDoDia(data) {
  return `gateway-${data.toISOString().slice(0, 10)}.log`;
}

function abrirFluxo() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (fluxo && diaAtual === hoje) return fluxo;

  if (fluxo) fluxo.end();
  fs.mkdirSync(PASTA, { recursive: true });
  fluxo = fs.createWriteStream(path.join(PASTA, nomeDoDia(new Date())), { flags: 'a' });
  // Falha ao gravar log não pode derrubar o gateway — disco cheio, pasta sem
  // permissão. O console continua funcionando.
  fluxo.on('error', () => { fluxo = null; });
  diaAtual = hoje;
  return fluxo;
}

function limparAntigos() {
  try {
    const limite = Date.now() - DIAS_RETENCAO * 86400000;
    for (const arquivo of fs.readdirSync(PASTA)) {
      if (!/^gateway-\d{4}-\d{2}-\d{2}\.log$/.test(arquivo)) continue;
      const caminho = path.join(PASTA, arquivo);
      if (fs.statSync(caminho).mtimeMs < limite) fs.unlinkSync(caminho);
    }
  } catch (_) { /* limpeza é oportunista */ }
}

function formatar(nivel, args) {
  const texto = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
    return String(a);
  }).join(' ');
  return `${new Date().toISOString()} ${nivel} ${texto}\n`;
}

/* Espelha console.log/warn/error para o arquivo, mantendo a saída no console.
   Envolver o console em vez de trocar as chamadas mantém o código do gateway
   sem uma camada de logger no meio. */
function iniciar() {
  if (process.env.LOG_ARQUIVO === 'false') return;

  fs.mkdirSync(PASTA, { recursive: true });
  limparAntigos();

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const espelhar = (nivel, orig) => (...args) => {
    orig(...args);
    try {
      const f = abrirFluxo();
      if (f) f.write(formatar(nivel, args));
    } catch (_) { /* nunca deixar o log quebrar a operação */ }
  };

  console.log = espelhar('INFO ', original.log);
  console.warn = espelhar('AVISO', original.warn);
  console.error = espelhar('ERRO ', original.error);

  // Roda uma vez por dia; a troca de arquivo acontece sozinha em abrirFluxo
  setInterval(limparAntigos, 24 * 3600 * 1000).unref();

  original.log(`[log] gravando em ${PASTA} (${DIAS_RETENCAO} dias)`);
}

function caminhoPasta() { return PASTA; }

module.exports = { iniciar, caminhoPasta };
