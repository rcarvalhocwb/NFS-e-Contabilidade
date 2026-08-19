/* Verificação de novas versões do gateway.
 *
 * O gateway roda na máquina da contabilidade, sem TI por perto. As regras da
 * Sefin mudam — E0120 e E0712 apareceram em produção sem aviso — e a correção
 * precisa chegar sem depender de alguém lembrar de perguntar se saiu versão
 * nova.
 *
 * Três decisões que moldam este módulo:
 *
 * 1. VERIFICA sozinho, INSTALA nunca. Trocar binários debaixo de um sistema
 *    que está emitindo documento fiscal, sem ninguém olhando, é pedir para
 *    uma nota ficar pela metade. Quem decide a hora é o contador.
 *
 * 2. Falhar aqui não pode atrapalhar. Sem internet, com o GitHub fora do ar ou
 *    com a resposta em formato inesperado, o resultado é "não sei", registrado
 *    e seguindo em frente. Emitir nota não depende disto.
 *
 * 3. O que for baixado é conferido por SHA-256 antes de ser aceito. Um
 *    instalador é código que vai rodar como administrador na máquina que
 *    guarda os certificados A1: baixar de HTTPS não basta se o arquivo não
 *    for o que o autor publicou.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { version: versaoAtual } = require('../../package.json');

/* Compara duas versões no formato x.y.z.
   Devolve >0 se `a` é mais nova, <0 se mais velha, 0 se iguais.
   Comparação numérica por parte: "1.10.0" é mais nova que "1.9.0", coisa que
   comparação de texto erra. */
function compararVersoes(a, b) {
  const partes = v => String(v || '0').replace(/^v/i, '').split('.')
    .map(n => parseInt(n, 10) || 0);
  const x = partes(a);
  const y = partes(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* Lê a última release publicada.
 *
 * Usa a API pública do GitHub, sem token: o repositório de releases é
 * separado do código justamente para não exigir credencial na máquina do
 * cliente. Um token distribuído junto com o instalador estaria, na prática,
 * dando leitura do código-fonte a quem alcançasse a máquina. */
async function consultarRemoto() {
  const url = config.atualizacao.url ||
    `https://api.github.com/repos/${config.atualizacao.repositorio}/releases/latest`;

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), config.atualizacao.timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      signal: controle.signal,
      headers: {
        // O GitHub recusa requisição sem User-Agent
        'user-agent': `nfse-gateway/${versaoAtual}`,
        accept: 'application/vnd.github+json'
      }
    });
  } finally {
    clearTimeout(prazo);
  }

  if (resp.status === 404) {
    throw new Error('Nenhuma versão publicada ainda (ou o repositório de ' +
                    'atualizações não existe): ' + config.atualizacao.repositorio);
  }
  if (!resp.ok) throw new Error(`GitHub respondeu HTTP ${resp.status}`);

  const dados = await resp.json();
  const versao = String(dados.tag_name || '').replace(/^v/i, '');
  if (!/^\d+\.\d+/.test(versao)) {
    throw new Error(`Tag da release não parece uma versão: ${dados.tag_name}`);
  }

  // O instalador é o .exe anexado à release
  const instalador = (dados.assets || []).find(a => /\.exe$/i.test(a.name || ''));

  return {
    versao,
    url: instalador ? instalador.browser_download_url : null,
    tamanho: instalador ? instalador.size : null,
    notas: dados.body || null,
    publicadoEm: dados.published_at || null,
    sha256: extrairSha256(dados.body)
  };
}

/* O SHA-256 do instalador vai nas notas da release, como "SHA-256: <64 hex>".
   É o que permite conferir o download: sem ele, o gateway baixa mas avisa que
   ninguém verificou a origem do arquivo. */
function extrairSha256(texto) {
  const m = String(texto || '').match(/SHA-?256\s*[:=]?\s*`?([a-fA-F0-9]{64})`?/i);
  return m ? m[1].toLowerCase() : null;
}

async function estado() {
  const r = await db.query('SELECT * FROM atualizacao WHERE id = TRUE');
  return r.rows[0] || {};
}

/* Monta o que a tela precisa saber, sem consultar a rede. */
function resumir(linha) {
  const disponivel = linha.versao_disponivel &&
    compararVersoes(linha.versao_disponivel, versaoAtual) > 0;
  return {
    versaoAtual,
    versaoDisponivel: linha.versao_disponivel || null,
    temAtualizacao: !!disponivel,
    // Dispensada some do aviso, mas continua instalável
    dispensada: !!(disponivel && linha.dispensada === linha.versao_disponivel),
    notas: disponivel ? linha.notas : null,
    publicadoEm: disponivel ? linha.publicado_em : null,
    tamanhoBytes: disponivel ? Number(linha.tamanho_bytes) || null : null,
    urlDownload: disponivel ? linha.url_download : null,
    arquivoBaixado: linha.arquivo_baixado || null,
    baixadoEm: linha.baixado_em || null,
    verificadoEm: linha.verificado_em || null,
    erro: linha.erro || null,
    erroEm: linha.erro_em || null
  };
}

/* Consulta o repositório, se já passou tempo suficiente desde a última vez.
   `forcar` ignora o intervalo — é o botão "verificar agora". */
async function verificar({ forcar = false } = {}) {
  if (!config.atualizacao.ativo && !forcar) return resumir(await estado());

  const atual = await estado();
  if (!forcar && atual.verificado_em) {
    const horas = (Date.now() - new Date(atual.verificado_em).getTime()) / 3600000;
    if (horas < config.atualizacao.intervaloHoras) return resumir(atual);
  }

  try {
    const nova = await consultarRemoto();
    const r = await db.query(
      `UPDATE atualizacao SET
         verificado_em = now(), versao_disponivel = $1, url_download = $2,
         sha256 = $3, tamanho_bytes = $4, notas = $5, publicado_em = $6,
         erro = NULL, erro_em = NULL
       WHERE id = TRUE RETURNING *`,
      [nova.versao, nova.url, nova.sha256, nova.tamanho, nova.notas, nova.publicadoEm]);
    return resumir(r.rows[0]);
  } catch (e) {
    // Sem rede, GitHub fora, resposta estranha: registra e segue. Não saber a
    // versão nova não pode impedir ninguém de emitir nota.
    const r = await db.query(
      `UPDATE atualizacao SET erro = $1, erro_em = now(), verificado_em = now()
       WHERE id = TRUE RETURNING *`, [e.message]);
    return resumir(r.rows[0]);
  }
}

/* Baixa o instalador e confere o SHA-256 publicado.
 *
 * O arquivo NÃO é executado: fica numa pasta e o operador instala quando
 * puder parar o gateway. Instalar sozinho, no meio do expediente, arriscaria
 * derrubar o sistema com nota na fila. */
async function baixar() {
  const linha = await estado();
  if (!linha.url_download) {
    throw Object.assign(new Error('Não há instalador para baixar. Verifique as atualizações primeiro.'),
      { status: 400 });
  }
  if (compararVersoes(linha.versao_disponivel, versaoAtual) <= 0) {
    throw Object.assign(new Error('O gateway já está na versão mais recente.'), { status: 400 });
  }

  const resp = await fetch(linha.url_download, {
    headers: { 'user-agent': `nfse-gateway/${versaoAtual}` },
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error(`Download falhou: HTTP ${resp.status}`);

  const conteudo = Buffer.from(await resp.arrayBuffer());
  const soma = crypto.createHash('sha256').update(conteudo).digest('hex');

  if (linha.sha256 && soma.toLowerCase() !== String(linha.sha256).toLowerCase()) {
    // Arquivo diferente do que o autor publicou. Pode ser download corrompido
    // ou algo pior; em nenhum dos casos ele deve ficar no disco convidando a
    // um duplo clique.
    throw Object.assign(new Error(
      'O arquivo baixado não confere com a soma de verificação publicada. ' +
      'O download foi descartado. Tente de novo; se repetir, baixe manualmente ' +
      'pela página de releases.'), { status: 502 });
  }

  // A pasta só nasce depois do arquivo ser aprovado: um download recusado não
  // deixa nem diretório para trás
  const pasta = config.atualizacao.pasta;
  fs.mkdirSync(pasta, { recursive: true });
  const destino = path.join(pasta, `nfse-gateway-setup-${linha.versao_disponivel}.exe`);
  fs.writeFileSync(destino, conteudo);

  const r = await db.query(
    `UPDATE atualizacao SET arquivo_baixado = $1, baixado_em = now()
     WHERE id = TRUE RETURNING *`, [destino]);

  return Object.assign(resumir(r.rows[0]), {
    verificado: !!linha.sha256,
    // Sem checksum publicado o download acontece, mas quem instala precisa
    // saber que ninguém conferiu a origem do arquivo
    aviso: linha.sha256 ? null
      : 'A release não publicou a soma SHA-256, então não foi possível conferir o arquivo.'
  });
}

/* Silencia o aviso de uma versão específica. Não impede instalar depois. */
async function dispensar(versao) {
  const r = await db.query(
    'UPDATE atualizacao SET dispensada = $1 WHERE id = TRUE RETURNING *', [versao || null]);
  return resumir(r.rows[0]);
}

/* Verificação periódica em segundo plano. Uma consulta a cada intervalo, e a
   primeira só depois de um minuto de vida: subir o gateway é quando a máquina
   está mais ocupada, e isto não tem pressa nenhuma. */
let timer = null;
function iniciarVerificacaoPeriodica() {
  if (!config.atualizacao.ativo || timer) return;
  const intervaloMs = config.atualizacao.intervaloHoras * 3600000;
  const rodar = () => verificar().catch(e =>
    console.warn('[atualizacao] verificação falhou:', e.message));

  setTimeout(rodar, 60000).unref();
  timer = setInterval(rodar, intervaloMs);
  timer.unref();  // não segura o processo no ar
}

function pararVerificacaoPeriodica() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  compararVersoes, extrairSha256, verificar, baixar, dispensar, resumir, estado,
  iniciarVerificacaoPeriodica, pararVerificacaoPeriodica, versaoAtual
};
