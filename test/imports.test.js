const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Identificador usado sem estar importado.
 *
 * `node --check` valida sintaxe, e o teste de carga pega o que falta no topo do
 * módulo. Mas um `require` faltando cujo uso está DENTRO de uma função passa
 * pelos dois: o módulo carrega, e só estoura quando aquela rota é chamada.
 *
 * Aconteceu duas vezes ao trocar a limpeza de CNPJ — a segunda só apareceu no
 * teste de emissão, com o gateway já rodando. Este teste custa milissegundos e
 * teria pegado as duas.
 */

const RAIZ = path.join(__dirname, '..', 'src');

/* Nomes exportados pelos utilitários do projeto. Não vale para tudo: só o que
   vem dos nossos módulos, onde o erro de import é plausível. */
const EXPORTADOS = [
  'limparDocumento', 'validarDocumento', 'validarCnpj', 'validarCpf', 'soDigitos',
  'cnpjAlfanumerico',
  'empresaVisivel', 'empresasVisiveis', 'filtroSqlEmpresas', 'notaNoEscopo',
  'somenteAdmin', 'exigirUsuario', 'fixarEscopoEmpresa',
  'extrairValores', 'baseCalculo', 'valorIss', 'totalRetencoesFederais',
  'lerCsv', 'lerNumero', 'gerarCsv', 'criarZip', 'gerarDanfse',
  'montarDps', 'gerarIdDps', 'emitir', 'consultar', 'cancelar'
];

function listarModulos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entrada => {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      return ['public', 'cert'].includes(entrada.name) ? [] : listarModulos(caminho);
    }
    return entrada.name.endsWith('.js') ? [caminho] : [];
  });
}

/* Chamado como função em algum ponto do arquivo. O `[^.\w]` antes evita casar
   com `obj.nome(` — método de outro objeto, que não precisa de import. */
function usaComoFuncao(codigo, nome) {
  return new RegExp('(^|[^.\\w])' + nome + '\\s*\\(').test(codigo);
}

/* Está disponível no escopo do módulo: importado, declarado ou recebido como
   parâmetro de uma função que o define. */
function estaDisponivel(codigo, nome) {
  const padroes = [
    new RegExp('\\bfunction\\s+' + nome + '\\b'),
    new RegExp('\\b(const|let|var)\\s+' + nome + '\\b'),
    new RegExp('\\{[^}]*\\b' + nome + '\\b[^}]*\\}\\s*=\\s*require'),
    new RegExp('\\b' + nome + '\\s*=\\s*require')
  ];
  return padroes.some(p => p.test(codigo));
}

test('nenhum módulo usa função de outro sem importá-la', () => {
  const problemas = [];
  for (const modulo of listarModulos(RAIZ)) {
    const codigo = fs.readFileSync(modulo, 'utf8');
    for (const nome of EXPORTADOS) {
      if (usaComoFuncao(codigo, nome) && !estaDisponivel(codigo, nome)) {
        problemas.push(`${path.relative(RAIZ, modulo)} usa ${nome}() sem importar`);
      }
    }
  }
  assert.deepEqual(problemas, [],
    'imports faltando:\n  ' + problemas.join('\n  '));
});

test('o teste enxerga os módulos que deveria', () => {
  // Sem isto, um refactor que mova src/ faria o teste passar sem checar nada
  const modulos = listarModulos(RAIZ);
  assert.ok(modulos.length >= 20, `esperava ao menos 20 módulos, achei ${modulos.length}`);
  assert.ok(modulos.some(m => m.endsWith('nfse.js')), 'não achei routes/nfse.js');
});
