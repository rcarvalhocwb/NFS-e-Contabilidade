const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../db');

const scrypt = promisify(crypto.scrypt);

/* scrypt em vez de bcrypt/argon: vem no Node, e uma dependência a menos é uma
   dependência a menos para manter atualizada numa máquina de contabilidade que
   ninguém vai auditar. Parâmetros acima do padrão do Node (N=16384). */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const derivada = await scrypt(senha, sal, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    sal.toString('base64'), derivada.toString('base64')].join('$');
}

async function conferirSenha(senha, hashGuardado) {
  const partes = String(hashGuardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, N, r, p, sal, esperada] = partes;
  const alvo = Buffer.from(esperada, 'base64');
  const derivada = await scrypt(senha, Buffer.from(sal, 'base64'), alvo.length,
    { N: Number(N), r: Number(r), p: Number(p) });

  // timingSafeEqual exige mesmo comprimento; hash corrompido não deve estourar
  return derivada.length === alvo.length && crypto.timingSafeEqual(derivada, alvo);
}

/* Regras mínimas de senha. Curtas demais não protegem nada; exigir símbolo e
   caixa alta faz a contabilidade anotar a senha em post-it, o que é pior. */
function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw Object.assign(new Error('A senha precisa ter ao menos 8 caracteres'), { status: 400 });
  }
  if (/^\d+$/.test(senha)) {
    throw Object.assign(new Error('A senha não pode ser só números'), { status: 400 });
  }
}

function normalizarEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
    throw Object.assign(new Error('E-mail inválido'), { status: 400 });
  }
  return e;
}

const CAMPOS = 'id, nome, email, perfil, ativo, trocar_senha, ultimo_acesso, criado_em';

async function existeAlgum() {
  const r = await db.query('SELECT 1 FROM usuarios LIMIT 1');
  return r.rows.length > 0;
}

async function criar({ nome, email, senha, perfil, empresasIds, trocarSenha }) {
  if (!nome || !String(nome).trim()) {
    throw Object.assign(new Error('nome é obrigatório'), { status: 400 });
  }
  const emailNorm = normalizarEmail(email);
  validarSenha(senha);
  const perfilNorm = perfil === 'admin' ? 'admin' : 'operador';

  const cliente = await db.pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, trocar_senha)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${CAMPOS}`,
      [String(nome).trim(), emailNorm, await gerarHash(senha), perfilNorm, !!trocarSenha]);

    await vincularEmpresas(cliente, r.rows[0].id, empresasIds);
    await cliente.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await cliente.query('ROLLBACK');
    if (e.code === '23505') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail'), { status: 409 });
    }
    throw e;
  } finally {
    cliente.release();
  }
}

/* Lista vazia ou ausente = acesso a todas as empresas. */
async function vincularEmpresas(cliente, usuarioId, empresasIds) {
  await cliente.query('DELETE FROM usuario_empresas WHERE usuario_id = $1', [usuarioId]);
  if (!Array.isArray(empresasIds) || !empresasIds.length) return;
  await cliente.query(
    `INSERT INTO usuario_empresas (usuario_id, empresa_id)
     SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
    [usuarioId, empresasIds.map(Number).filter(Number.isInteger)]);
}

async function listar() {
  const r = await db.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.trocar_senha,
            u.ultimo_acesso, u.criado_em,
            coalesce(array_agg(ue.empresa_id)
                     FILTER (WHERE ue.empresa_id IS NOT NULL), '{}') AS empresas_ids
       FROM usuarios u
       LEFT JOIN usuario_empresas ue ON ue.usuario_id = u.id
      GROUP BY u.id ORDER BY u.nome`);
  return r.rows;
}

async function porEmail(email) {
  const r = await db.query('SELECT * FROM usuarios WHERE email = $1', [normalizarEmail(email)]);
  return r.rows[0] || null;
}

/* Empresas visíveis ao usuário. `null` = todas — o chamador precisa distinguir
   isso de "nenhuma", senão um usuário sem vínculo deixaria de ver tudo. */
async function empresasDoUsuario(usuarioId) {
  const r = await db.query(
    'SELECT empresa_id FROM usuario_empresas WHERE usuario_id = $1', [usuarioId]);
  return r.rows.length ? r.rows.map(x => x.empresa_id) : null;
}

async function atualizar(id, { nome, email, perfil, ativo, empresasIds, senha, trocarSenha }) {
  const cliente = await db.pool.connect();
  try {
    await cliente.query('BEGIN');

    const campos = [];
    const valores = [];
    const põe = (sql, v) => { valores.push(v); campos.push(`${sql} = $${valores.length}`); };

    if (nome !== undefined) põe('nome', String(nome).trim());
    if (email !== undefined) põe('email', normalizarEmail(email));
    if (perfil !== undefined) põe('perfil', perfil === 'admin' ? 'admin' : 'operador');
    if (ativo !== undefined) põe('ativo', !!ativo);
    if (trocarSenha !== undefined) põe('trocar_senha', !!trocarSenha);
    if (senha !== undefined && senha !== '') {
      validarSenha(senha);
      põe('senha_hash', await gerarHash(senha));
      // Senha trocada pelo administrador vem como provisória
      if (trocarSenha === undefined) põe('trocar_senha', true);
    }

    let usuario;
    if (campos.length) {
      valores.push(id);
      const r = await cliente.query(
        `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $${valores.length}
         RETURNING ${CAMPOS}`, valores);
      if (!r.rows.length) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
      usuario = r.rows[0];
    } else {
      const r = await cliente.query(`SELECT ${CAMPOS} FROM usuarios WHERE id = $1`, [id]);
      if (!r.rows.length) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
      usuario = r.rows[0];
    }

    if (empresasIds !== undefined) await vincularEmpresas(cliente, id, empresasIds);

    // Senha nova ou acesso revogado: as sessões abertas param de valer
    if (senha || ativo === false) {
      await cliente.query('DELETE FROM sessoes WHERE usuario_id = $1', [id]);
    }

    await cliente.query('COMMIT');
    return usuario;
  } catch (e) {
    await cliente.query('ROLLBACK');
    if (e.code === '23505') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail'), { status: 409 });
    }
    throw e;
  } finally {
    cliente.release();
  }
}

/* Troca feita pelo próprio usuário: exige a senha atual, senão qualquer sessão
   esquecida aberta viraria uma troca de dono da conta. */
async function trocarPropriaSenha(usuarioId, senhaAtual, senhaNova) {
  const r = await db.query('SELECT senha_hash FROM usuarios WHERE id = $1', [usuarioId]);
  if (!r.rows.length) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
  if (!await conferirSenha(senhaAtual, r.rows[0].senha_hash)) {
    throw Object.assign(new Error('Senha atual incorreta'), { status: 400 });
  }
  validarSenha(senhaNova);
  await db.query(
    'UPDATE usuarios SET senha_hash = $1, trocar_senha = FALSE WHERE id = $2',
    [await gerarHash(senhaNova), usuarioId]);
}

async function remover(id) {
  const r = await db.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
  if (!r.rows.length) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
}

async function contarAdminsAtivos(exceto) {
  const r = await db.query(
    `SELECT count(*)::int AS total FROM usuarios
      WHERE perfil = 'admin' AND ativo AND ($1::int IS NULL OR id <> $1)`, [exceto || null]);
  return r.rows[0].total;
}

module.exports = {
  gerarHash, conferirSenha, validarSenha, normalizarEmail,
  existeAlgum, criar, listar, porEmail, empresasDoUsuario,
  atualizar, trocarPropriaSenha, remover, contarAdminsAtivos
};
