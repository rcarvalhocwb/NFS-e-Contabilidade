const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Todo módulo tem de carregar.
 *
 * `node --check` só valida sintaxe: um `require` que falta passa por ele e só
 * estoura quando o servidor sobe. Foi o que aconteceu ao trocar a limpeza de
 * CNPJ em cinco arquivos — o commit passou nos testes e no --check, e o gateway
 * não subia.
 *
 * Carregar cada arquivo pega isso em um segundo. */

const RAIZ = path.join(__dirname, '..', 'src');

function listarModulos(dir) {
  const achados = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      // public/ é código de navegador: require não se aplica
      if (entrada.name !== 'public' && entrada.name !== 'cert') {
        achados.push(...listarModulos(caminho));
      }
    } else if (entrada.name.endsWith('.js')) {
      achados.push(caminho);
    }
  }
  return achados;
}

const modulos = listarModulos(RAIZ).filter(m => !m.endsWith('server.js'));

test('todos os módulos carregam sem erro de require', () => {
  const falhas = [];
  for (const modulo of modulos) {
    try {
      require(modulo);
    } catch (e) {
      falhas.push(path.relative(RAIZ, modulo) + ': ' + e.message);
    }
  }
  assert.deepEqual(falhas, [], 'módulos que não carregam:\n  ' + falhas.join('\n  '));
});

test('há módulos suficientes para o teste valer alguma coisa', () => {
  // Guarda contra um refactor que mova os arquivos e faça o teste passar vazio
  assert.ok(modulos.length >= 20, 'esperava ao menos 20 módulos, achei ' + modulos.length);
});

test('as páginas do painel existem e referenciam scripts presentes', () => {
  const publico = path.join(RAIZ, 'public');
  for (const pagina of ['admin.html', 'emitir.html', 'nota.html']) {
    const caminho = path.join(publico, pagina);
    assert.ok(fs.existsSync(caminho), pagina + ' não existe');

    const html = fs.readFileSync(caminho, 'utf8');
    const scripts = [...html.matchAll(/<script src="\/assets\/([^"]+)"/g)].map(m => m[1]);
    for (const script of scripts) {
      assert.ok(fs.existsSync(path.join(publico, script)),
        pagina + ' referencia /assets/' + script + ', que não existe');
    }
  }
});
