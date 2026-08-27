const http = require('http');
const path = require('path');
const os = require('os');

const conversa = require('./conversa');
const receita = require('./receita');
const { Memoria } = require('./memoria');

/* Ensaio: a conversa do WhatsApp numa página, sem WhatsApp.
 *
 * Existe para ver o atendimento funcionando ANTES de contratar servidor e
 * passar pela verificação da Meta — que leva dias e custa dinheiro. Aqui o
 * mesmo conversa.js que roda em produção responde numa tela de chat, com o
 * cadastro de verdade puxado do gateway.
 *
 * NÃO é o servidor de produção: processo separado, porta separada, e não fala
 * com a Meta nem com a fila. Nada do que acontece aqui vira nota.
 *
 *   node ensaio.js
 *   depois abra http://127.0.0.1:8099
 */

const PORTA = Number(process.env.ENSAIO_PORT || 8099);
const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const CHAVE = process.env.CHAVE_GATEWAY || '';

/* Memória própria, em arquivo temporário: o ensaio não pode encostar nos dados
   de um repassador de verdade que esteja rodando na mesma máquina. */
const memoria = new Memoria(path.join(os.tmpdir(), 'nfse-ensaio.json'));
const conversas = new Map();      // telefone -> estado
const pedidos = [];               // o que teria ido para a fila

/* O cadastro vem do gateway pela mesma rota que o repassador usa. Ensaiar com
   cadastro inventado mostraria uma conversa que não é a que vai acontecer. */
async function puxarCadastro() {
  if (!CHAVE) {
    console.error('\nFalta CHAVE_GATEWAY — a mesma que está na tela "Portal do cliente".');
    console.error('Exemplo:  CHAVE_GATEWAY=sua-chave node ensaio.js\n');
    process.exit(1);
  }
  const r = await fetch(GATEWAY + '/ponte/cadastro/previa-ensaio', {
    headers: { authorization: 'Bearer ' + CHAVE }
  }).catch(() => null);

  if (!r || !r.ok) {
    console.error('\nNão consegui o cadastro em ' + GATEWAY + '.');
    console.error('O gateway está no ar? A chave confere?\n');
    process.exit(1);
  }
  memoria.guardarCadastro(await r.json());
  const c = memoria.dados.cadastro;
  console.log('cadastro: ' + (c.empresas || []).length + ' empresa(s), ' +
              (c.whatsapp || []).length + ' número(s) autorizado(s)');
  return c;
}

const PAGINA = `<title>Ensaio do WhatsApp</title>
<style>
  :root { --fundo:#0b141a; --bolha-bot:#202c33; --bolha-eu:#005c4b; --texto:#e9edef;
          --suave:#8696a0; --linha:#2a3942; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--fundo); color:var(--texto); height:100vh;
         display:flex; flex-direction:column;
         font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif }
  header { background:#202c33; padding:11px 18px; display:flex; align-items:center;
           gap:12px; border-bottom:1px solid var(--linha) }
  header b { font-size:15px } header small { color:var(--suave); font-size:12.5px }
  header .aviso { margin-left:auto; font-size:12px; color:#f0b429;
                  border:1px solid #f0b429; padding:3px 10px; border-radius:20px }
  #tela { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:8px }
  .b { max-width:min(600px,80%); padding:9px 13px; border-radius:9px;
       white-space:pre-wrap; word-break:break-word }
  .bot { background:var(--bolha-bot); align-self:flex-start; border-top-left-radius:2px }
  .eu  { background:var(--bolha-eu);  align-self:flex-end;  border-top-right-radius:2px }
  .sis { align-self:center; color:var(--suave); font-size:12.5px; text-align:center;
         background:#182229; padding:6px 14px; border-radius:8px; max-width:80% }
  .b b { font-weight:600 } .b i { color:var(--suave); font-style:italic }
  footer { padding:12px 18px; background:#202c33; display:flex; gap:10px;
           border-top:1px solid var(--linha) }
  input { flex:1; background:#2a3942; border:0; color:var(--texto); padding:11px 15px;
          border-radius:9px; font:inherit; outline:none }
  button { background:#00a884; border:0; color:#fff; padding:11px 20px;
           border-radius:9px; font:inherit; font-weight:600; cursor:pointer }
  button:disabled { opacity:.5; cursor:default }
  select { background:#2a3942; border:0; color:var(--texto); padding:8px 11px;
           border-radius:8px; font:inherit }
</style>
<header>
  <div><b id="quem">Ensaio</b><br><small id="sub">carregando…</small></div>
  <span class="aviso">ensaio — nada vira nota</span>
</header>
<div id="tela"></div>
<footer>
  <select id="numero"></select>
  <input id="campo" placeholder="Escreva como o cliente escreveria…" autocomplete="off">
  <button id="enviar">Enviar</button>
</footer>
<script src="/ensaio.js"></script>`;

const SCRIPT = `
var tela = document.getElementById('tela');
var campo = document.getElementById('campo');
var seletor = document.getElementById('numero');

function bolha(classe, texto) {
  var d = document.createElement('div');
  d.className = 'b ' + classe;
  // negrito e itálico do WhatsApp, para a mensagem sair como o cliente vê
  d.innerHTML = String(texto)
    .replace(/[&<>]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;' }[c]; })
    .replace(/\\*([^*\\n]+)\\*/g, '<b>$1</b>')
    .replace(/_([^_\\n]+)_/g, '<i>$1</i>');
  tela.appendChild(d);
  tela.scrollTop = tela.scrollHeight;
}

function sistema(texto) {
  var d = document.createElement('div');
  d.className = 'sis'; d.textContent = texto;
  tela.appendChild(d); tela.scrollTop = tela.scrollHeight;
}

fetch('/numeros').then(function (r) { return r.json(); }).then(function (lista) {
  if (!lista.length) {
    sistema('Nenhum número autorizado no cadastro. Cadastre um na ficha da empresa, aba Integração.');
    campo.disabled = true; document.getElementById('enviar').disabled = true;
    return;
  }
  lista.forEach(function (n) {
    var o = document.createElement('option');
    o.value = n.telefone;
    o.textContent = (n.nome || 'sem nome') + ' — ' + n.telefone;
    seletor.appendChild(o);
  });
  document.getElementById('quem').textContent = lista[0].nome || lista[0].telefone;
  document.getElementById('sub').textContent = 'falando como este número';
  sistema('Escreva "oi" para começar.');
});

seletor.onchange = function () {
  tela.innerHTML = '';
  document.getElementById('quem').textContent =
    seletor.options[seletor.selectedIndex].textContent.split(' — ')[0];
  sistema('Trocou de número. Escreva "oi" para começar.');
};

function enviar() {
  var t = campo.value.trim();
  if (!t) return;
  campo.value = '';
  bolha('eu', t);
  fetch('/dizer', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ de: seletor.value, texto: t })
  }).then(function (r) { return r.json(); }).then(function (d) {
    bolha('bot', d.resposta);
    if (d.pedido) {
      sistema('→ pedido na fila: ' + d.pedido.tomador.razaoSocial +
              ' · R$ ' + Number(d.pedido.valores.valorServico).toFixed(2).replace('.', ','));
    }
  }).catch(function (e) { sistema('erro: ' + e.message); });
}

document.getElementById('enviar').onclick = enviar;
campo.onkeydown = function (ev) { if (ev.key === 'Enter') enviar(); };
campo.focus();
`;

function json(res, corpo) {
  const t = JSON.stringify(corpo);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(t);
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGINA);
  }
  if (u.pathname === '/ensaio.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(SCRIPT);
  }
  if (u.pathname === '/numeros') {
    return json(res, (memoria.dados.cadastro || {}).whatsapp || []);
  }

  if (req.method === 'POST' && u.pathname === '/dizer') {
    let bruto = '';
    req.on('data', p => { bruto += p; });
    req.on('end', async () => {
      const { de, texto } = JSON.parse(bruto);
      try {
        const saida = await conversa.responder({
          texto, telefone: de, vinculos: memoria.empresasDe(de),
          conversa: conversas.get(de) || null, memoria,
          buscarCnpj: receita.consultarCnpj
        });
        if (saida.estado) {
          conversas.set(de, { estado: saida.estado, dados: saida.dados,
                              em: new Date().toISOString() });
        } else {
          conversas.delete(de);
        }
        if (saida.pedido) {
          pedidos.push(saida.pedido);
          console.log('[ensaio] pedido que iria para a fila:',
            JSON.stringify({ empresa: saida.pedido.cnpjEmpresa,
                             cliente: saida.pedido.tomador.razaoSocial,
                             valor: saida.pedido.valores.valorServico }));
        }
        json(res, { resposta: saida.resposta, pedido: saida.pedido || null });
      } catch (e) {
        console.error('[ensaio] a conversa quebrou:', e.stack);
        json(res, { resposta: 'A conversa quebrou: ' + e.message });
      }
    });
    return;
  }

  res.writeHead(404); res.end('não existe');
});

(async () => {
  await puxarCadastro();
  servidor.listen(PORTA, '127.0.0.1', () => {
    console.log('\nEnsaio em http://127.0.0.1:' + PORTA);
    console.log('Nada aqui vira nota — é a mesma conversa, sem WhatsApp e sem fila.\n');
  });
})();
