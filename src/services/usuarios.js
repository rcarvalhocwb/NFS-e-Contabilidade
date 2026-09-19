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

const CAMPOS = 'id, nome, email, perfil, ativo, trocar_senha, ultimo_acesso, criado_em, cliente_cargo';

/* Três perfis, e o terceiro não entra aqui.
   'cliente' identifica uma pessoa da empresa cliente: existe para ser
   replicada ao portal, com os CNPJs que ela enxerga, e é barrada no login
   do painel. A senha dela não mora no gateway — quem guarda o segredo é o
   portal, onde a pessoa define a própria pelo convite. */
const PERFIS = ['admin', 'operador', 'cliente'];
function normalizarPerfil(p) { return PERFIS.includes(p) ? p : 'operador'; }

/* Vínculo vazio significa "enxerga todas as empresas" — regra antiga, pensada
   para o pessoal do escritório. Para o perfil de cliente ela seria desastrosa:
   uma pessoa da empresa X cadastrada sem vínculo enxergaria a vida fiscal de
   todos os clientes da casa, E ESSE CADASTRO É REPLICADO PARA UM PORTAL NA
   INTERNET. Então aqui o vínculo é obrigatório. */
function conferirVinculoDeCliente(perfil, empresasIds) {
  if (perfil !== 'cliente') return;
  if (!Array.isArray(empresasIds) || !empresasIds.length) {
    throw Object.assign(new Error(
      'Uma pessoa do cliente precisa estar vinculada a pelo menos uma empresa. ' +
      'Sem vínculo, ela enxergaria todas as empresas do escritório.'), { status: 400 });
  }
}

/* Senha impossível de adivinhar e que ninguém conhece — nem quem cadastrou.
   O perfil de cliente não entra no painel do gateway, e a senha do portal é
   definida lá pela própria pessoa, pelo convite. A coluna existe porque é NOT
   NULL; o valor não serve para nada, e é assim que tem de ser. */
function senhaInutilizavel() {
  return require('crypto').randomBytes(32).toString('hex');
}

async function existeAlgum() {
  const r = await db.query('SELECT 1 FROM usuarios LIMIT 1');
  return r.rows.length > 0;
}

async function criar({ nome, email, senha, perfil, empresasIds, trocarSenha, clienteCargo }) {
  if (!nome || !String(nome).trim()) {
    throw Object.assign(new Error('nome é obrigatório'), { status: 400 });
  }
  const emailNorm = normalizarEmail(email);
  const perfilNorm = normalizarPerfil(perfil);
  conferirVinculoDeCliente(perfilNorm, empresasIds);

  if (perfilNorm === 'cliente') {
    senha = senhaInutilizavel();
  } else {
    validarSenha(senha);
  }

  /* Via db.transacao, não db.pool.connect direto: a transação amarra o
     inquilino na conexão antes da primeira consulta. Pegar a conexão crua do
     pool a herdava suja — com o `app.escritorio` de quem a usou antes — e a
     RLS respondia por aquele escritório, não por este: o INSERT gravava no
     inquilino errado. Ver o cabeçalho de src/db.js. */
  try {
    return await db.transacao(async (cliente) => {
      const r = await cliente.query(
        `INSERT INTO usuarios (nome, email, senha_hash, perfil, trocar_senha, cliente_cargo)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${CAMPOS}`,
        [String(nome).trim(), emailNorm, await gerarHash(senha), perfilNorm,
         perfilNorm === 'cliente' ? false : !!trocarSenha,
         perfilNorm === 'cliente' ? (clienteCargo || null) : null]);

      await vincularEmpresas(cliente, r.rows[0].id, empresasIds);
      return r.rows[0];
    });
  } catch (e) {
    if (e.code === '23505') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail'), { status: 409 });
    }
    throw e;
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

async function atualizar(id, { nome, email, perfil, ativo, empresasIds, senha, trocarSenha, clienteCargo }) {
  /* Via db.transacao pela mesma razão de `criar`: a conexão crua do pool traz
     o inquilino de quem a usou antes, e um UPDATE assim editava a conta de um
     usuário de OUTRO escritório. Ver o cabeçalho de src/db.js. */
  try {
    return await db.transacao(async (cliente) => {
      const campos = [];
      const valores = [];
      const põe = (sql, v) => { valores.push(v); campos.push(`${sql} = $${valores.length}`); };

      if (nome !== undefined) põe('nome', String(nome).trim());
      if (email !== undefined) põe('email', normalizarEmail(email));
      if (clienteCargo !== undefined) põe('cliente_cargo', clienteCargo || null);
      if (perfil !== undefined) {
        const p = normalizarPerfil(perfil);
        /* Virar cliente sem vínculo abriria todas as empresas para alguém que
           acessa pela internet — a mesma regra do cadastro vale na edição. */
        conferirVinculoDeCliente(p, empresasIds !== undefined ? empresasIds : await empresasDoUsuario(id));
        põe('perfil', p);
      }
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

      return usuario;
    });
  } catch (e) {
    if (e.code === '23505') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail'), { status: 409 });
    }
    throw e;
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
