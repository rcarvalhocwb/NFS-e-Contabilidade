const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Todo campo que o JavaScript procura precisa existir no HTML.
 *
 * `el('fDocInterm')` devolve null quando o id não está na página, e a linha
 * seguinte estoura com "Cannot read properties of null". Não é erro de sintaxe,
 * não é função inexistente — é o mesmo tipo de falha um nível ao lado, e os
 * testes existentes não a pegavam.
 *
 * Aconteceu ao acrescentar o intermediário: o JS passou a ler três campos e a
 * edição do HTML falhou sem que eu percebesse. O formulário inteiro quebraria
 * na primeira emissão.
 *
 * Cada arquivo de script é conferido contra o HTML que o carrega. */

const PUBLICO = path.join(__dirname, '..', 'src', 'public');

/* Qual HTML carrega qual script. Um script pode servir a mais de uma página —
   então o id vale se existir em QUALQUER uma delas. */
function paginasDe(script) {
  return fs.readdirSync(PUBLICO)
    .filter(f => f.endsWith('.html'))
    .filter(f => fs.readFileSync(path.join(PUBLICO, f), 'utf8').includes(script));
}

function idsNoHtml(paginas) {
  const ids = new Set();
  for (const pagina of paginas) {
    const html = fs.readFileSync(path.join(PUBLICO, pagina), 'utf8');
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  }
  return ids;
}

/* Ids que o próprio script cria em tempo de execução não estão no HTML. */
function idsCriadosNoJs(fonte) {
  const ids = new Set();
  for (const m of fonte.matchAll(/\bid\s*=\s*['"]([\w-]+)['"]/g)) ids.add(m[1]);
  for (const m of fonte.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]/g)) ids.add(m[1]);
  return ids;
}

for (const script of fs.readdirSync(PUBLICO).filter(f => f.endsWith('.js'))) {
  test(`${script}: todo el('id') existe no HTML`, () => {
    const paginas = paginasDe(script);
    assert.ok(paginas.length, `nenhum HTML carrega ${script}`);

    const fonte = fs.readFileSync(path.join(PUBLICO, script), 'utf8');
    const disponiveis = idsNoHtml(paginas);
    const criados = idsCriadosNoJs(fonte);

    const faltando = [];
    for (const m of fonte.matchAll(/\bel\(\s*'([\w-]+)'\s*\)/g)) {
      const id = m[1];
      if (disponiveis.has(id) || criados.has(id)) continue;
      if (faltando.includes(id)) continue;
      const linha = fonte.slice(0, m.index).split('\n').length;
      faltando.push(`${id} (linha ${linha})`);
    }

    assert.deepEqual(faltando, [],
      `${script} procura campo que não existe em ${paginas.join(', ')}:\n  ` +
      faltando.join('\n  '));
  });
}

test('o detector acusa um id que não existe', () => {
  /* Sem isto, a varredura poderia quebrar e ficar verde para sempre — foi
     exatamente o que aconteceu com o teste de escopo antes de ganhar seu
     próprio caso de controle. */
  const fonte = "el('fValor'); el('fCampoQueNaoExiste');";
  const disponiveis = new Set(['fValor']);
  const achados = [];
  for (const m of fonte.matchAll(/\bel\(\s*'([\w-]+)'\s*\)/g)) {
    if (!disponiveis.has(m[1])) achados.push(m[1]);
  }
  assert.deepEqual(achados, ['fCampoQueNaoExiste']);
});
