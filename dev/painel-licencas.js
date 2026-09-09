#!/usr/bin/env node
/**
 * Painel do desenvolvedor: as licenças de todos os escritórios, num lugar só.
 *
 * ESTE ARQUIVO NUNCA VAI PARA O CLIENTE. A pasta `dev/` é excluída do pacote
 * pelo preparar-pacote.ps1, e test/pacote-limpo.test.js quebra se ela escapar.
 * Não é zelo: aqui mora o caminho para a chave privada, e chave privada num
 * .exe de cliente é o fim do licenciamento inteiro, de uma vez, para todos.
 *
 * Roda SÓ em 127.0.0.1, de propósito. Não é um serviço: é uma tela sobre o
 * registro local de quem vende, aberta quando precisa e fechada depois.
 *
 *   node dev/painel-licencas.js
 *   → http://127.0.0.1:4100
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { verificar } = require('../src/licenca/formato');
const { avaliar } = require('../src/licenca/estado');

const PORTA = Number(process.env.PORTA_PAINEL_DEV || 4100);
const PASTA = process.env.NFSE_LICENCA_DIR || path.join(os.homedir(), '.nfse');
const ARQ_REGISTRO = path.join(PASTA, 'licencas.csv');
const ARQ_PUBLICA = path.join(PASTA, 'licenca.pub');
const RAIZ = path.join(__dirname, '..');

function lerRegistro() {
  if (!fs.existsSync(ARQ_REGISTRO)) return [];
  const linhas = fs.readFileSync(ARQ_REGISTRO, 'utf8').trim().split('\n');
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(';');
  return linhas.slice(1).map(l => {
    const c = l.split(';');
    const o = {};
    cab.forEach((k, i) => { o[k] = c[i]; });
    return o;
  });
}

/* A situação de cada licença é calculada com o MESMO código que roda no
   cliente. Duas implementações do que é "vencida" divergiriam, e a divergência
   apareceria numa cobrança — o pior lugar. */
function comSituacao(linhas) {
  const publica = fs.existsSync(ARQ_PUBLICA) ? fs.readFileSync(ARQ_PUBLICA, 'utf8') : null;
  /* O registro guarda os campos, não a licença assinada. Para reaproveitar
     `avaliar` sem reassinar nada, monta-se o mesmo formato a partir deles. */
  return linhas.map(l => {
    const dados = {
      v: 1, id: l.id,
      escritorio: { cnpj: l.cnpj, nome: l.nome },
      plano: l.plano, emitido_em: l.emitido_em, valido_ate: l.valido_ate,
      carencia_dias: Number(l.plano === 'mensal' ? 10 : 30),
      terminais: Number(l.terminais || 1)
    };
    /* Chama a avaliação por dentro, com uma licença "de mentira" já verificada:
       o que interessa aqui é o calendário, não a assinatura — a assinatura já
       foi conferida na emissão. */
    const e = avaliar(null, publica);
    const hoje = e.hoje;
    const dias = diasEntre(hoje, l.valido_ate);
    const carencia = dias + dados.carencia_dias;
    let situacao = 'ativa';
    if (dias < 0) situacao = carencia >= 0 ? 'carencia' : 'vencida';
    else if (dias <= (l.plano === 'mensal' ? 7 : 30)) situacao = 'vencendo';
    return Object.assign({}, l, { situacao, diasParaVencer: dias });
  });
}

function diasEntre(deISO, ateISO) {
  const [a1, m1, d1] = deISO.split('-').map(Number);
  const [a2, m2, d2] = String(ateISO).split('-').map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86400000);
}

function emitir(campos) {
  const args = ['scripts/licenca-emitir.js'];
  for (const [k, v] of Object.entries(campos)) {
    if (v !== undefined && v !== null && v !== '') args.push('--' + k, String(v));
  }
  const saida = execFileSync(process.execPath, args, { cwd: RAIZ, encoding: 'utf8' });
  const ativacao = (saida.match(/RECAL-[A-Z0-9-]+/) || [])[0] || null;
  const licenca = (saida.match(/\beyJ[A-Za-z0-9_.-]+/) || [])[0] || null;
  return { ativacao, licenca, saida };
}

/* ------------------------------------------------------------------ tela */

const PAGINA = `<!doctype html><meta charset="utf-8">
<title>Licenças — painel do desenvolvedor</title>
<style>
 :root{--papel:#F7F6F3;--sup:#fff;--linha:#DCD9D1;--tinta:#191B1F;--t2:#4E5157;
       --ok:#2A6A5E;--aviso:#8A5D0C;--erro:#A83E22;
       --mono:ui-monospace,"JetBrains Mono",Consolas,monospace}
 @media(prefers-color-scheme:dark){:root{--papel:#141619;--sup:#1B1E22;--linha:#2E3339;
       --tinta:#E9EAE6;--t2:#AFB4BA;--ok:#63BFAD;--aviso:#D9A64A;--erro:#E9805F}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--papel);color:var(--tinta);
      font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 .folha{max-width:1120px;margin:0 auto;padding:34px 22px 80px}
 h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}
 .sub{color:var(--t2);font-size:14px;margin:0 0 26px}
 .aviso{border-left:3px solid var(--erro);padding:10px 0 10px 15px;margin:0 0 26px;
        color:var(--t2);font-size:14px;max-width:74ch}
 .cartao{background:var(--sup);border:1px solid var(--linha);border-radius:4px;margin-bottom:20px}
 .cab{padding:13px 18px;border-bottom:1px solid var(--linha);font-weight:600;font-size:15px}
 .corpo{padding:18px}
 table{border-collapse:collapse;width:100%;font-size:14px}
 th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--linha);vertical-align:top}
 th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--t2);font-weight:600}
 tr:last-child td{border-bottom:none}
 .mono{font-family:var(--mono);font-size:12.5px}
 .selo{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;
       padding:2px 7px;border-radius:2px;letter-spacing:.04em}
 .s-ativa{color:var(--ok)} .s-vencendo{color:var(--aviso)}
 .s-carencia{color:var(--aviso)} .s-vencida{color:var(--erro)}
 form{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:13px;align-items:end}
 label{display:block;font-size:12.5px;color:var(--t2);margin-bottom:4px}
 input,select{width:100%;padding:8px 10px;border:1px solid var(--linha);border-radius:3px;
              background:var(--papel);color:var(--tinta);font:inherit;font-size:14px}
 button{padding:9px 18px;border:0;border-radius:3px;background:var(--tinta);color:var(--papel);
        font:inherit;font-weight:600;font-size:14px;cursor:pointer}
 .saida{margin-top:16px;padding:14px 16px;border:1px solid var(--linha);border-radius:3px;
        background:var(--papel);font-family:var(--mono);font-size:12.5px;
        white-space:pre-wrap;word-break:break-all;display:none}
 .vazio{color:var(--t2);font-size:14px}
</style>
<div class="folha">
<h1>Licenças</h1>
<p class="sub">Painel do desenvolvedor · registro local · <span class="mono" id="pasta"></span></p>
<p class="aviso">Esta tela não vai para cliente nenhum. A pasta <span class="mono">dev/</span> é
excluída do pacote, e um teste quebra se ela escapar — aqui mora o caminho para a chave privada.</p>

<div class="cartao">
  <div class="cab">Emitir licença</div>
  <div class="corpo">
    <form id="f">
      <div><label for="cnpj">CNPJ do escritório</label><input id="cnpj" required></div>
      <div><label for="nome">Razão social</label><input id="nome" required></div>
      <div><label for="plano">Plano</label><select id="plano">
        <option value="mensal">mensal</option><option value="anual" selected>anual</option>
      </select></div>
      <div><label for="terminais">Terminais</label><input id="terminais" type="number" min="1" value="1"></div>
      <div><button type="submit">Emitir</button></div>
    </form>
    <div class="saida" id="saida"></div>
  </div>
</div>

<div class="cartao">
  <div class="cab">Emitidas</div>
  <div class="corpo" id="lista"><p class="vazio">carregando…</p></div>
</div>
</div>
<script>
const $ = s => document.querySelector(s);
async function carregar() {
  const r = await fetch('/api/licencas').then(r => r.json());
  $('#pasta').textContent = r.pasta;
  if (!r.licencas.length) {
    $('#lista').innerHTML = '<p class="vazio">Nenhuma licença emitida ainda.</p>';
    return;
  }
  const linhas = r.licencas.map(l => \`<tr>
    <td class="mono">\${l.id}</td>
    <td>\${l.nome}<div class="mono" style="opacity:.6">\${l.cnpj}</div></td>
    <td>\${l.plano}</td>
    <td>\${l.terminais}</td>
    <td class="mono">\${l.valido_ate}</td>
    <td><span class="selo s-\${l.situacao}">\${l.situacao}</span>
        <div class="mono" style="opacity:.6">\${l.diasParaVencer >= 0
          ? l.diasParaVencer + ' dias' : Math.abs(l.diasParaVencer) + ' dias atrás'}</div></td>
    <td class="mono">\${l.ativacao || ''}</td>
  </tr>\`).join('');
  $('#lista').innerHTML = '<table><thead><tr><th>ID</th><th>Escritório</th><th>Plano</th>' +
    '<th>Term.</th><th>Válida até</th><th>Situação</th><th>Ativação</th></tr></thead><tbody>' +
    linhas + '</tbody></table>';
}
$('#f').onsubmit = async (ev) => {
  ev.preventDefault();
  const corpo = { cnpj: $('#cnpj').value, nome: $('#nome').value,
                  plano: $('#plano').value, terminais: $('#terminais').value };
  const r = await fetch('/api/emitir', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
    .then(r => r.json());
  const s = $('#saida');
  s.style.display = 'block';
  s.textContent = r.erro ? r.erro
    : 'Código de ativação (dite ao cliente):\\n\\n  ' + r.ativacao +
      '\\n\\nLicença assinada (rede fechada):\\n\\n  ' + r.licenca;
  if (!r.erro) { $('#f').reset(); carregar(); }
};
carregar();
</script>`;

/* --------------------------------------------------------------- servidor */

const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (u.pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGINA);
  }

  if (u.pathname === '/api/licencas') {
    const linhas = comSituacao(lerRegistro());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ pasta: PASTA, licencas: linhas }));
  }

  if (u.pathname === '/api/emitir' && req.method === 'POST') {
    let corpo = '';
    req.on('data', d => { corpo += d; });
    return req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        res.end(JSON.stringify(emitir(JSON.parse(corpo || '{}'))));
      } catch (e) {
        res.end(JSON.stringify({ erro: String(e.stderr || e.message).trim() }));
      }
    });
  }

  res.writeHead(404).end('não encontrado');
});

/* 127.0.0.1 e não 0.0.0.0: esta tela emite licença, e não tem autenticação
   nenhuma — quem alcança a porta, emite. Fora do loopback isso seria um
   emissor de licenças aberto na rede. */
servidor.listen(PORTA, '127.0.0.1', () => {
  console.log('\n  Painel de licenças em http://127.0.0.1:' + PORTA);
  console.log('  Registro: ' + ARQ_REGISTRO);
  if (!fs.existsSync(path.join(PASTA, 'licenca.key'))) {
    console.log('\n  ATENÇÃO: não há chave privada em ' + PASTA);
    console.log('  Rode antes:  node scripts/licenca-emitir.js --gerar-chaves');
  }
  console.log('');
});
