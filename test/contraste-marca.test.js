const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A cor da casa não pode tornar o painel ilegível.
 *
 * Cada escritório escolhe a cor de acento, e o painel decide sozinho se o
 * texto sobre ela é branco ou escuro. Isso era um corte de brilho YIQ em 150
 * — a heurística de sempre. Medido contra a razão de contraste da WCAG,
 * quatro de doze cores testadas ficavam abaixo de 4,5:1, e não eram cores
 * exóticas: cinza médio, verde e ciano de marca. Com #00CED1 o painel
 * escolhia branco e entregava 1,95:1. Reproduzido no sistema rodando.
 */

function rgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }
function luminancia(c) {
  const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
}
function razao(a, b) {
  const x = luminancia(rgb(a)), y = luminancia(rgb(b));
  const [alto, baixo] = x > y ? [x, y] : [y, x];
  return (alto + 0.05) / (baixo + 0.05);
}

const PAINEL = () => fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'painel.js'), 'utf8');

/* Extrai a decisão do fonte para medir o código real, não uma cópia que pode
   divergir dele com o tempo. */
function textoEscolhidoPeloPainel(cor) {
  const src = PAINEL();
  const i = src.indexOf('function textoSobre(');
  assert.ok(i > 0, 'painel.js precisa expor textoSobre()');
  const corpo = src.slice(i, src.indexOf('\n  }', i) + 4);
  return new Function('corParaRgb', 'razaoContraste', corpo + '; return textoSobre;')(rgb, razao)(cor);
}

const CORES = ['#2563eb', '#1f6feb', '#8250df', '#FFFF00', '#00FF00', '#FFA500',
               '#7f7f7f', '#808080', '#00CED1', '#FF69B4', '#000000', '#FFFFFF'];

test('nenhuma cor de marca deixa o texto abaixo de 4,5:1', () => {
  const ruins = [];
  for (const cor of CORES) {
    const fg = textoEscolhidoPeloPainel(cor);
    const r = razao(cor, fg);
    if (r < 4.5) ruins.push(`${cor} -> ${fg} = ${r.toFixed(2)}:1`);
  }
  assert.deepStrictEqual(ruins, [], 'cores que produzem texto ilegível na barra lateral');
});

test('as quatro que o YIQ errava agora acertam', () => {
  for (const [cor, esperado] of [['#00FF00', '#10161f'], ['#7f7f7f', '#10161f'],
                                 ['#808080', '#10161f'], ['#00CED1', '#10161f']]) {
    assert.strictEqual(textoEscolhidoPeloPainel(cor), esperado,
      `${cor} precisa de texto escuro; o corte YIQ escolhia branco`);
  }
});

test('o painel não decide contraste por brilho YIQ', () => {
  const src = PAINEL();
  const trecho = src.slice(src.indexOf('function luminancia'), src.indexOf('function carregarMarca'));
  assert.ok(!/\b299\b|\b587\b|\b114\b/.test(trecho),
    'os pesos 299/587/114 são a fórmula YIQ — ela erra em cor saturada');
  assert.match(trecho, /0\.2126/, 'a luminância relativa da WCAG usa 0.2126/0.7152/0.0722');
});

test('o foco visível não depende da cor da marca', () => {
  /* O anel antigo era `--acento-suave`, o acento clareado em 90%: medido,
     1,07–1,15:1 sobre o branco. Decorativo. O sinal ficava só na borda, que
     some quando o acento é claro. */
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.css'), 'utf8');
  assert.match(css, /outline:\s*2px solid var\(--foco\)/,
    'o indicador de foco precisa de outline próprio');
  assert.match(css, /--foco:\s*#0b1220/, 'token do tema claro');
  assert.match(css, /--foco:\s*#e8eef7/, 'token do tema escuro');
  assert.ok(razao('#0b1220', '#ffffff') >= 3, 'foco claro precisa de 3:1');
  assert.ok(razao('#e8eef7', '#171b21') >= 3, 'foco escuro precisa de 3:1');
});

test('os campos numéricos pedem teclado numérico no celular', () => {
  /* O cliente final do escritório abre isso no telefone. Sem inputmode ele
     recebe teclado alfabético para digitar CNPJ, valor e alíquota.
     O padrão usa limite de palavra: "empPortalMotivo" contém "Porta" e é
     campo de texto — pegá-lo seria falso positivo. */
  const pub = path.join(__dirname, '..', 'src', 'public');
  const NUMERICO = /id="[^"]*(?:aliquota|Aliquota|valor|Valor|telefone|Telefone|Porta"|Porta[A-Z_])/;
  for (const arq of ['admin.html', 'nota.html']) {
    const html = fs.readFileSync(path.join(pub, arq), 'utf8');
    const semModo = (html.match(/<input[^>]*>/g) || []).filter(t =>
      NUMERICO.test(t) && !/type="checkbox"/.test(t) && !/inputmode=/.test(t));
    assert.deepStrictEqual(semModo.map(t => (t.match(/id="([^"]+)"/) || [])[1]), [],
      `${arq}: campo numérico sem inputmode`);
  }
});

test('o erro de emissão aponta para o campo que o causou', () => {
  /* Sem aria-describedby, quem usa leitor de tela ouve o campo, erra, e a
     mensagem nunca chega: ela não está associada a nada. */
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'nota.js'), 'utf8');
  assert.match(js, /function avisoNoCampo/);
  assert.match(js, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(js, /setAttribute\('aria-describedby', 'aviso'\)/);
  assert.match(js, /avisoNoCampo\(problema\.campo, problema\.msg\)/,
    'o botão de emitir precisa usar o aviso com campo');

  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'nota.html'), 'utf8');
  assert.match(html, /id="aviso"[^>]*role="alert"/,
    'a faixa precisa ser região viva, senão o leitor não anuncia');
});
