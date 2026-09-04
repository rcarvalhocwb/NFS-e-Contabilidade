const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O painel dá para usar sem mouse, e dá para ler.
 *
 * Varrido com axe-core nas 18 telas, nos dois temas, com o gateway no ar sobre
 * banco separado: 601 violações no primeiro passe, zero depois. Este arquivo
 * NÃO repete a varredura — ela precisa de navegador e de banco. Ele trava as
 * causas, que são poucas e todas estruturais, para que a próxima tela não
 * reintroduza o mesmo problema em silêncio.
 *
 * Vale dizer por que isso importa aqui, e não é conformidade por conformidade:
 * quem opera este sistema passa o dia numa tabela de notas. Cabeçalho a 2,45:1
 * é leitura difícil às cinco da tarde, com ou sem deficiência. E a barra
 * lateral tem vinte links: sem um atalho, quem digita em série atravessava os
 * vinte a cada troca de tela.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'public', ...partes), 'utf8')
    .replace(/\r\n/g, '\n');
}
const HTML = fonte('admin.html');
const CSS = fonte('app.css');

/* ------------------------------------------------------- contraste medido */

/* WCAG 2.1, relação de contraste. Trabalha sobre os valores DECLARADOS, então
   pega a regressão no momento em que alguém clareia um token — sem navegador. */
function luminancia(hex) {
  const n = hex.replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contraste(a, b) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/* rgba sobre um fundo opaco: é assim que a barra lateral compõe as cores. */
function sobrepor(rgba, fundoHex) {
  const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
  const f = fundoHex.replace('#', '');
  const fundo = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16));
  const m = [r, g, b].map((v, i) => Math.round(fundo[i] + a * (v - fundo[i])));
  return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
}

function token(nome, dentroDeEscuro) {
  const corpo = dentroDeEscuro
    ? CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)'))
    : CSS.slice(0, CSS.indexOf('@media (prefers-color-scheme: dark)'));
  const m = corpo.match(new RegExp('--' + nome + ':\\s*([^;]+);'));
  assert.ok(m, 'token --' + nome + ' sumiu do CSS' + (dentroDeEscuro ? ' (modo escuro)' : ''));
  return m[1].trim();
}

test('o texto pequeno passa de 4,5:1 nos dois temas', () => {
  /* --texto-3 veste rótulo de métrica, cabeçalho de tabela e legenda. Media
     2,56:1 no claro e 3,46:1 no escuro. Os dois lados são conferidos porque a
     primeira varredura rodou só no claro e o escuro tinha falhas PRÓPRIAS —
     inclusive uma caixa de fundo fixo com 1,09:1, ilegível. */
  const casos = [
    ['claro', token('texto-3', false), token('superficie', false), 'superfície'],
    ['claro', token('texto-3', false), token('superficie-2', false), 'superfície-2'],
    ['escuro', token('texto-3', true), token('superficie', true), 'superfície'],
    ['escuro', token('texto-3', true), token('superficie-2', true), 'superfície-2']
  ];
  for (const [tema, cor, fundo, onde] of casos) {
    const r = contraste(cor, fundo);
    assert.ok(r >= 4.5, `--texto-3 (${cor}) sobre ${onde} (${fundo}) no tema ${tema}: ` +
      r.toFixed(2) + ':1, precisa de 4,5:1');
  }
});

test('o texto branco sobre o acento passa de 4,5:1 nos dois temas', () => {
  /* O botão primário e o item de menu ativo. No escuro o acento clareia para
     servir de texto e borda; se o FUNDO clarear junto, o branco em cima
     apagava — foi o que aconteceu, 3,67:1 em 38 lugares. Daí --acento-solido
     existir separado de --acento. */
  for (const escuro of [false, true]) {
    const solido = token('acento-solido', escuro);
    const r = contraste('#ffffff', solido);
    assert.ok(r >= 4.5, 'branco sobre --acento-solido (' + solido + ') no tema ' +
      (escuro ? 'escuro' : 'claro') + ': ' + r.toFixed(2) + ':1');
  }
});

test('o texto da barra lateral passa de 4,5:1 sobre a marca', () => {
  /* Estava em quatro rgba() soltos — .42, .5, .55, .82 — e três falhavam.
     Virou token para não voltarem a divergir um do outro. */
  const marca = token('marca', false);
  for (const nome of ['sobre-marca', 'sobre-marca-2']) {
    const composta = sobrepor(token(nome, false), marca);
    const r = contraste(composta, marca);
    assert.ok(r >= 4.5, '--' + nome + ' sobre --marca dá ' + r.toFixed(2) + ':1 (composta ' +
      composta + '), precisa de 4,5:1');
  }
  assert.ok(!/color:\s*rgba\(232,238,247/.test(CSS),
    'cor da barra lateral escrita à mão de novo — use --sobre-marca ou --sobre-marca-2');
});

/* ----------------------------------------------------------- estrutura */

test('existe um e só um marco principal', () => {
  /* Sem <main>, o leitor de tela não tem para onde pular e TODO o conteúdo
     conta como fora de marco: eram 295 nós acusados por causa de um elemento. */
  assert.equal((HTML.match(/<main\b/g) || []).length, 1);
  assert.match(HTML, /<main class="pagina" id="conteudoPrincipal" tabindex="-1">/);
  assert.equal((HTML.match(/<\/main>/g) || []).length, 1);
});

test('dá para pular a barra lateral', () => {
  /* Vinte links antes do primeiro campo, a cada troca de tela. */
  assert.match(HTML, /class="pular-para-conteudo" href="#conteudoPrincipal"/);
  assert.match(CSS, /\.pular-para-conteudo:focus\s*\{[^}]*top:/,
    'o atalho precisa aparecer quando recebe foco');
  const i = HTML.indexOf('pular-para-conteudo');
  assert.ok(i > 0 && i < HTML.indexOf('<aside class="sidebar"'),
    'o atalho precisa vir ANTES da barra lateral, senão não adianta');
});

test('todo select e todo campo de arquivo tem nome', () => {
  /* Sem nome, o leitor de tela anuncia "caixa de seleção" e nada mais — a
     pessoa não descobre o que está escolhendo. */
  const semNome = [];
  const re = /<(select|input[^>]*type="file")\b([^>]*)>/g;
  let m;
  while ((m = re.exec(HTML))) {
    const atributos = m[0];
    const id = (atributos.match(/id="([^"]+)"/) || [])[1];
    const temAria = /aria-label=|aria-labelledby=/.test(atributos);
    const temLabel = id && new RegExp('<label[^>]*for="' + id + '"').test(HTML);
    if (!temAria && !temLabel) semNome.push(id || atributos.slice(0, 60));
  }
  assert.deepEqual(semNome, [],
    'controle sem nome acessível:\n  ' + semNome.join('\n  '));
});

test('coluna de ação tem cabeçalho para quem não vê', () => {
  /* O cabeçalho é vazio de propósito no desenho; o texto existe só para o
     leitor de tela, senão a coluna vira "coluna 7". */
  assert.ok(!/<th>\s*<\/th>/.test(HTML), 'cabeçalho de tabela vazio');
  assert.match(CSS, /\.so-leitor\s*\{[^}]*position:\s*absolute/);
});

test('os títulos não pulam de nível fora dos diálogos', () => {
  /* h2 seguido de h4 quebra a navegação por título, que é como quem usa leitor
     de tela varre a tela. Dentro do <dialog> o h4 é subtítulo de um h3 e está
     certo — por isso o corte. */
  const corte = HTML.indexOf('DIÁLOGOS');
  assert.ok(corte > 0, 'a fronteira dos diálogos sumiu do arquivo');
  const painel = HTML.slice(0, corte);
  assert.ok(!/<h4\b/.test(painel),
    'h4 no painel: com h1 no topo e h2 no cartão, o nível seguinte é h3');
});

test('nenhuma cor depende de um token que não existe', () => {
  /* `var(--fundo-alt, #f2f4f3)` não era um fallback: --fundo-alt nunca existiu,
     então o cinza claro valia nos DOIS temas. No escuro dava texto #e8eaed
     sobre #f2f4f3 — 1,09:1, e a caixa mostrava justamente o arquivo que a
     pessoa precisa abrir para fazer manutenção. */
  /* /nota e /emitir são páginas soltas, com <style> e vocabulário próprios
     (--fg, --muted, --accent) — não compartilham o app.css. Então cada arquivo
     é conferido contra os tokens do app.css MAIS os que ele define em si. */
  const doSistema = new Set([...CSS.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const fantasmas = [];
  for (const arquivo of ['admin.html', 'app.css', 'nota.html', 'emitir.html']) {
    const txt = fonte(arquivo);
    const definidos = new Set([...doSistema,
      ...[...txt.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1])]);
    for (const m of txt.matchAll(/var\(\s*--([a-z0-9-]+)\s*(,[^)]*)?\)/g)) {
      if (!definidos.has(m[1])) fantasmas.push(arquivo + ': ' + m[0]);
    }
  }
  assert.deepEqual(fantasmas, [],
    'token inexistente — o fallback vale sempre, inclusive no tema errado:\n  ' +
    fantasmas.join('\n  '));
});

test('os diálogos prendem o foco', () => {
  /* show() apenas mostra a caixa: o teclado continua passeando pela página de
     trás, que segue clicável. showModal() é o que torna o resto inerte. */
  const js = fonte('painel.js');
  assert.ok(!/\.show\(\)/.test(js), 'diálogo aberto com show() em vez de showModal()');
  assert.match(js, /\.showModal\(\)/);
});
