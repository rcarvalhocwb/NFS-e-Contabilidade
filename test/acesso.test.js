const test = require('node:test');
const assert = require('node:assert');

const { gerarHash, conferirSenha, validarSenha, normalizarEmail } =
  require('../src/services/usuarios');
const { empresasVisiveis, empresaVisivel, filtroSqlEmpresas, notaNoEscopo } =
  require('../src/middleware/escopo');

/* Senhas ------------------------------------------------------------------ */

test('senha correta confere e senha errada não', async () => {
  const hash = await gerarHash('senha-de-teste-1');
  assert.equal(await conferirSenha('senha-de-teste-1', hash), true);
  assert.equal(await conferirSenha('senha-de-teste-2', hash), false);
});

test('mesma senha gera hashes diferentes (sal por usuário)', async () => {
  // Sem sal, dois usuários com a mesma senha teriam o mesmo hash e um
  // vazamento do banco revelaria isso de imediato.
  const a = await gerarHash('mesma-senha-aqui');
  const b = await gerarHash('mesma-senha-aqui');
  assert.notEqual(a, b);
  assert.equal(await conferirSenha('mesma-senha-aqui', a), true);
  assert.equal(await conferirSenha('mesma-senha-aqui', b), true);
});

test('hash corrompido é recusado sem estourar', async () => {
  for (const ruim of ['', 'qualquer-coisa', 'scrypt$1$2$3', null, undefined]) {
    assert.equal(await conferirSenha('x', ruim), false);
  }
});

test('senha curta ou só de números é recusada', () => {
  assert.throws(() => validarSenha('1234'), /8 caracteres/);
  assert.throws(() => validarSenha('12345678'), /só números/);
  assert.doesNotThrow(() => validarSenha('contabil2026'));
});

test('e-mail é normalizado para minúsculas e validado', () => {
  assert.equal(normalizarEmail('  Fulano@Empresa.COM '), 'fulano@empresa.com');
  assert.throws(() => normalizarEmail('sem-arroba'), /inválido/);
});

/* Escopo por empresa ------------------------------------------------------ */

const usuarioCom = (empresasIds, perfil = 'operador') =>
  ({ auth: { tipo: 'usuario', perfil, empresasIds } });

test('administrador sem vínculo enxerga todas as empresas', () => {
  /* null é "todas". Vale só para quem administra: é quem cadastra empresa, e
     sem isso não conseguiria enxergar a que acabou de criar. */
  const req = usuarioCom(null, 'admin');
  assert.equal(empresasVisiveis(req), null);
  assert.equal(empresaVisivel(req, 7), true);
  assert.equal(filtroSqlEmpresas(req, 'n.empresa_id', 2).sql, '');
});

test('operador sem vínculo não enxerga nenhuma empresa', () => {
  /* Mudou em 26/08/2026, a pedido: antes, vínculo vazio dava a ele a vida
     fiscal de todos os clientes do escritório, sem nenhum sinal na tela. */
  const req = usuarioCom(null);
  assert.deepEqual(empresasVisiveis(req), []);
  assert.equal(empresaVisivel(req, 7), false);
  assert.equal(filtroSqlEmpresas(req, 'n.empresa_id', 2).sql, ' AND FALSE');
});

test('usuário vinculado só enxerga as empresas marcadas', () => {
  const req = usuarioCom([3, 5]);
  assert.equal(empresaVisivel(req, 3), true);
  assert.equal(empresaVisivel(req, 4), false);

  const f = filtroSqlEmpresas(req, 'n.empresa_id', 2);
  assert.equal(f.sql, ' AND n.empresa_id = ANY($3::int[])');
  assert.deepEqual(f.params, [[3, 5]]);
});

test('token de empresa fica preso ao próprio CNPJ', () => {
  const req = { auth: { tipo: 'empresa', empresaId: 9 } };
  assert.equal(empresaVisivel(req, 9), true);
  assert.equal(empresaVisivel(req, 10), false);
});

test('chave de máquina enxerga tudo', () => {
  const req = { auth: { tipo: 'maquina' } };
  assert.equal(empresasVisiveis(req), null);
  assert.equal(empresaVisivel(req, 123), true);
});

test('sem autenticação não enxerga nada', () => {
  assert.deepEqual(empresasVisiveis({}), []);
  assert.equal(empresaVisivel({}, 1), false);
});

test('nota de outra empresa fica fora do escopo', () => {
  const req = usuarioCom([3]);
  assert.equal(notaNoEscopo(req, { empresa_id: 3 }), true);
  assert.equal(notaNoEscopo(req, { empresa_id: 4 }), false);
  assert.equal(notaNoEscopo(req, null), false);
});
