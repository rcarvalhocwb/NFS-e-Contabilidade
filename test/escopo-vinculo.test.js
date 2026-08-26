const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { empresasVisiveis, empresaVisivel, filtroSqlEmpresas } =
  require('../src/middleware/escopo');

/* Quem enxerga qual empresa.
 *
 * Até 26/08/2026 um usuário sem vínculo enxergava TODAS as empresas, qualquer
 * que fosse o perfil — regra pensada para uma instalação de um CNPJ só. Num
 * escritório com dezenas de clientes, criar um operador e esquecer de vincular
 * dava a ele a vida fiscal da casa inteira, sem nenhum sinal na tela.
 *
 * A regra agora: só quem administra enxerga tudo. Operador e pessoa do cliente
 * enxergam o que está vinculado, e nada mais.
 */

function req(auth) { return { auth }; }

test('admin enxerga todas as empresas', () => {
  /* É quem cadastra empresa. Sem isso não conseguiria criar a primeira nem
     enxergar o que acabou de criar. */
  assert.equal(empresasVisiveis(req({ tipo: 'usuario', perfil: 'admin', empresasIds: null })), null);
  assert.equal(empresasVisiveis(req({ tipo: 'usuario', perfil: 'admin', empresasIds: [7] })), null);
});

test('operador sem vínculo não enxerga nenhuma', () => {
  const ids = empresasVisiveis(req({ tipo: 'usuario', perfil: 'operador', empresasIds: null }));
  assert.deepEqual(ids, [], 'lista vazia, e não null');
  assert.notEqual(ids, null, 'null significaria "todas" — era exatamente o bug');
});

test('operador enxerga só as vinculadas', () => {
  const auth = { tipo: 'usuario', perfil: 'operador', empresasIds: [3, 5] };
  assert.deepEqual(empresasVisiveis(req(auth)), [3, 5]);
  assert.ok(empresaVisivel(req(auth), 3));
  assert.ok(empresaVisivel(req(auth), 5));
  assert.ok(!empresaVisivel(req(auth), 4), 'empresa de outro cliente do escritório');
});

test('pessoa do cliente enxerga só a empresa dela', () => {
  const auth = { tipo: 'usuario', perfil: 'cliente', empresasIds: [9] };
  assert.deepEqual(empresasVisiveis(req(auth)), [9]);
  assert.ok(!empresaVisivel(req(auth), 8));
  assert.ok(!empresaVisivel(req(auth), 10));
});

test('token de empresa continua preso ao próprio CNPJ', () => {
  assert.deepEqual(empresasVisiveis(req({ tipo: 'empresa', empresaId: 2 })), [2]);
});

test('sem autenticação, nenhuma empresa', () => {
  assert.deepEqual(empresasVisiveis({}), []);
});

test('o filtro SQL de quem não tem vínculo não devolve nada', () => {
  /* `AND FALSE` e não um filtro ausente: filtro ausente devolveria a casa
     inteira. */
  const semVinculo = filtroSqlEmpresas(
    req({ tipo: 'usuario', perfil: 'operador', empresasIds: null }), 'n.empresa_id', 0);
  assert.equal(semVinculo.sql, ' AND FALSE');

  const admin = filtroSqlEmpresas(
    req({ tipo: 'usuario', perfil: 'admin', empresasIds: null }), 'n.empresa_id', 0);
  assert.equal(admin.sql, '', 'admin não recebe filtro');

  const operador = filtroSqlEmpresas(
    req({ tipo: 'usuario', perfil: 'operador', empresasIds: [1, 2] }), 'n.empresa_id', 3);
  assert.equal(operador.sql, ' AND n.empresa_id = ANY($4::int[])');
  assert.deepEqual(operador.params, [[1, 2]]);
});

test('as consultas tratam lista vazia como "nenhuma"', () => {
  /* Todas usam `$n::int[] IS NULL OR coluna = ANY($n::int[])`. Com lista vazia
     o IS NULL é falso e o ANY não casa com nada — que é o desejado. Se alguma
     consulta usasse só `IS NULL OR`, a lista vazia abriria tudo. */
  const raiz = path.join(__dirname, '..', 'src', 'routes');
  for (const arquivo of fs.readdirSync(raiz).filter(f => f.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    if (!/empresasVisiveis/.test(s)) continue;
    /* Só o filtro de ESCOPO, que é int[]. O `$n::int IS NULL OR col = $n`
       escalar é outra coisa: o empresaId que a pessoa escolheu na tela para
       estreitar o relatório, e ele convive com o filtro de escopo. Comentário
       citando a regra também não é a regra. */
    const linhas = s.split('\n').filter(l =>
      /::int\[\][^)]*IS NULL OR/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    for (const l of linhas) {
      assert.match(l, /ANY\(/,
        arquivo + ': o filtro precisa combinar IS NULL com ANY — ' + l.trim());
    }
  }
});
