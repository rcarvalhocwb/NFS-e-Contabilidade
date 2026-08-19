const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Toda função chamada no navegador precisa existir.
 *
 * Escrito depois de um estrago silencioso: ao reescrever trocarAmbiente por
 * substituição de trecho, o corte levou junto carregarVisaoGeral e
 * montarBlocoAmbiente. As chamadas continuaram lá. `node --check` passou (a
 * sintaxe estava certa), os testes passaram, e a Visão geral da empresa ficou
 * quebrada por três commits — o erro só aparece quando alguém clica na aba.
 *
 * É o mesmo tipo de falha do teste de imports, um nível abaixo: lá era módulo
 * não importado, aqui é função não declarada. Ambos passam despercebidos porque
 * JavaScript só resolve o nome na hora da chamada. */

const PASTA = path.join(__dirname, '..', 'src', 'public');

/* Nomes que vêm do navegador ou de bibliotecas, não do arquivo. */
const DE_FORA = new Set([
  'require', 'fetch', 'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON',
  'RegExp', 'Error', 'Promise', 'Map', 'Set', 'Function', 'Intl', 'Blob', 'URL',
  'FormData', 'FileReader', 'Image', 'Event', 'CustomEvent', 'AbortController',
  'queueMicrotask', 'requestAnimationFrame', 'structuredClone', 'BigInt', 'Symbol'
]);

/* Declarações que valem como "esta função existe aqui":
     function nome(          var nome = function(       var nome = (a) =>
     const nome = ...        nome: function(            catch (nome)
   Parâmetros de função também contam — podem ser chamados como callback. */
function nomesDeclarados(fonte) {
  const nomes = new Set();
  const guarda = (r, g) => {
    let m;
    while ((m = r.exec(fonte))) nomes.add(m[g]);
  };
  guarda(/\bfunction\s+([A-Za-z_$][\w$]*)/g, 1);
  guarda(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g, 1);
  guarda(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:function\b|\([^)]*\)\s*=>)/g, 1);
  guarda(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, 1);
  // Parâmetros: tudo entre os parênteses de qualquer function
  const params = /\bfunction\s*[\w$]*\s*\(([^)]*)\)/g;
  let m;
  while ((m = params.exec(fonte))) {
    m[1].split(',').forEach(p => {
      const nome = p.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nome)) nomes.add(nome);
    });
  }
  return nomes;
}

/* `if (` parece uma chamada e nao e. */
const PALAVRAS_CHAVE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'delete', 'void', 'in', 'of', 'instanceof', 'do', 'else', 'with',
  'yield', 'await', 'throw', 'case', 'super', 'this'
]);

/* Um `/` abre uma regex quando o que veio antes não pode terminar um valor.
   Depois de `)` ou de um nome, é divisão. Grosseiro, mas suficiente aqui. */
function abreRegex(anterior) {
  const t = anterior.replace(/\s+$/, '');
  if (!t) return true;
  const ultimo = t[t.length - 1];
  if ('([{,;:=!&|?+-*%~^<>'.indexOf(ultimo) >= 0) return true;
  return /\b(return|typeof|case|in|of|instanceof|new|delete|void|do|else)$/.test(t);
}

/* Apaga comentários e o conteúdo de strings e regexes, preservando as quebras
   de linha para que o número da linha continue certo. Varredura caractere a
   caractere: uma regex pode conter aspas (/[&<>"']/ existe neste projeto) e um
   comentário pode conter apóstrofo — regex sobre o texto não distingue os dois
   e desalinha o resto do arquivo. */
function semTextoLiteral(fonte) {
  const BARRA = 92;   // \
  const saida = [];
  let i = 0;
  while (i < fonte.length) {
    const c = fonte[i];
    if (c === '/' && fonte[i + 1] !== '*' && fonte[i + 1] !== '/' &&
        abreRegex(saida.join('').slice(-40))) {
      saida.push(' ');
      i++;
      let classe = false;
      while (i < fonte.length && fonte[i] !== '\n') {
        if (fonte.charCodeAt(i) === BARRA) { saida.push(' '); i += 2; continue; }
        if (fonte[i] === '[') classe = true;
        else if (fonte[i] === ']') classe = false;
        else if (fonte[i] === '/' && !classe) break;
        saida.push(' ');
        i++;
      }
      saida.push(' ');
      i++;
      while (i < fonte.length && /[gimsuyd]/.test(fonte[i])) { saida.push(' '); i++; }
    } else if (c === '/' && fonte[i + 1] === '*') {
      const fim = fonte.indexOf('*/', i + 2);
      const trecho = fonte.slice(i, fim < 0 ? fonte.length : fim + 2);
      saida.push(trecho.replace(/[^\n]/g, ' '));
      i += trecho.length;
    } else if (c === '/' && fonte[i + 1] === '/') {
      while (i < fonte.length && fonte[i] !== '\n') { saida.push(' '); i++; }
    } else if (c === '"' || c === "'" || c === '`') {
      saida.push('"');
      i++;
      while (i < fonte.length && fonte[i] !== c) {
        if (fonte.charCodeAt(i) === BARRA) i++;          // pula o escapado
        saida.push(fonte[i] === '\n' ? '\n' : ' ');
        i++;
      }
      saida.push('"');
      i++;
    } else {
      saida.push(c);
      i++;
    }
  }
  return saida.join('');
}

/* Chamadas diretas: `nome(`. Ignora `.metodo(` e `new Nome(`, que dependem de
   objeto e não de declaração no arquivo. */
function nomesChamados(fonte) {
  const limpa = semTextoLiteral(fonte);
  const chamadas = new Map();
  const r = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = r.exec(limpa))) {
    if (PALAVRAS_CHAVE.has(m[2])) continue;
    if (!chamadas.has(m[2])) {
      chamadas.set(m[2], limpa.slice(0, m.index).split('\n').length);
    }
  }
  return chamadas;
}

/* O detector precisa acusar. Um teste de estrutura que só sabe dizer "está
   tudo bem" fica verde para sempre no dia em que a varredura quebra. */
function faltantes(fonte) {
  const declarados = nomesDeclarados(fonte);
  return [...nomesChamados(fonte).keys()]
    .filter(n => !declarados.has(n) && !DE_FORA.has(n) && typeof globalThis[n] !== 'function');
}

test('o detector acusa a função que não existe', () => {
  // Exatamente o estrago real: a chamada ficou, a declaração foi cortada
  assert.deepEqual(faltantes('function aba(n) { carregarVisaoGeral(n); }'),
    ['carregarVisaoGeral']);
});

test('o detector não acusa o que está declarado', () => {
  assert.deepEqual(faltantes(
    'function carregarVisaoGeral(n) { return n; }\nfunction aba(n) { carregarVisaoGeral(n); }'), []);
  assert.deepEqual(faltantes('var f = function () { return 1; };\nf();'), []);
  assert.deepEqual(faltantes('var o = { m: function () { return 1; } };\no.m();'), []);
});

test('o detector ignora texto e regex, não código', () => {
  // 'var(--cor)' numa string e /[&<>"']/ numa regex já geraram falso positivo
  assert.deepEqual(faltantes('function e(s) { return s.replace(/[&<>"\']/g, \' \'); }\n' +
    'function t() { return "<td style=\\"color:var(--x)\\">" + e("a") + "nota(s)"; }'), []);
  // e o código depois da regex continua sendo lido
  assert.deepEqual(faltantes('function e(s) { return s.replace(/[&<>"\']/g, \' \'); }\nsumiu();'),
    ['sumiu']);
});

for (const arquivo of fs.readdirSync(PASTA).filter(f => f.endsWith('.js'))) {
  test(`${arquivo}: toda função chamada está declarada`, () => {
    const fonte = fs.readFileSync(path.join(PASTA, arquivo), 'utf8');
    const declarados = nomesDeclarados(fonte);
    const faltando = [];

    for (const [nome, linha] of nomesChamados(fonte)) {
      if (declarados.has(nome) || DE_FORA.has(nome)) continue;
      if (typeof globalThis[nome] === 'function') continue;  // API do runtime
      faltando.push(`${nome}() — chamada na linha ~${linha}`);
    }

    assert.deepEqual(faltando, [],
      `${arquivo} chama função que não existe:\n  ` + faltando.join('\n  '));
  });
}
