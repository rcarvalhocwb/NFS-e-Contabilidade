/* Aplicação do escopo nas rotas.
   O middleware de auth identifica quem chamou; aqui decidimos o que pode. */

/* Rotas de gestão (cadastro de empresas, certificados, numeração, tokens,
   municípios, webhooks, usuários) exigem perfil administrativo.

   Passa: a chave global (credencial de máquina/instalação) e o usuário com
   perfil admin. Não passa: operador — quem só emite nota não troca o
   certificado A1 nem mexe na numeração de produção — nem token de empresa. */
function somenteAdmin(req, res, next) {
  if (req.auth && req.auth.tipo === 'maquina') return next();
  if (req.auth && req.auth.tipo === 'usuario' && req.auth.perfil === 'admin') return next();

  if (req.auth && req.auth.tipo === 'usuario') {
    return res.status(403).json({
      erro: 'Seu perfil é de operador. Esta ação é do administrador do gateway.'
    });
  }
  return res.status(403).json({
    erro: 'Esta rota exige credencial administrativa. O token da empresa dá acesso apenas às rotas de NFS-e.'
  });
}

/* Rotas da própria conta (trocar senha, ver quem sou) só fazem sentido para uma
   pessoa logada — chave de máquina não tem conta. */
function exigirUsuario(req, res, next) {
  if (req.auth && req.auth.tipo === 'usuario') return next();
  return res.status(403).json({ erro: 'Esta rota exige um usuário logado no painel' });
}

/* Empresas que quem chamou pode enxergar.
   `null` = todas. O chamador PRECISA distinguir null de lista vazia: um usuário
   sem vínculo enxerga tudo, e tratar isso como "nenhuma" esconderia o sistema
   inteiro de quem deveria ver tudo. */
function empresasVisiveis(req) {
  if (!req.auth) return [];
  if (req.auth.tipo === 'empresa') return [req.auth.empresaId];
  if (req.auth.tipo === 'usuario') return req.auth.empresasIds; // null = todas
  return null; // máquina
}

function empresaVisivel(req, empresaId) {
  const ids = empresasVisiveis(req);
  if (ids === null) return true;
  return ids.map(Number).includes(Number(empresaId));
}

/* Fragmento SQL para filtrar listagens pelas empresas visíveis.
   Devolve `{ sql, params }` já com os placeholders numerados a partir do total
   de parâmetros que a consulta chamadora já tem. */
function filtroSqlEmpresas(req, coluna, paramsExistentes) {
  const ids = empresasVisiveis(req);
  if (ids === null) return { sql: '', params: [] };
  if (!ids.length) return { sql: ' AND FALSE', params: [] };
  return { sql: ` AND ${coluna} = ANY($${paramsExistentes + 1}::int[])`, params: [ids] };
}

/* Para tokens de empresa, o CNPJ e o ambiente vêm SEMPRE do token — nunca do
   corpo ou da query. Assim um cliente não emite por outro CNPJ do grupo, e um
   token de homologação não emite em produção, mesmo que o payload peça. */
function fixarEscopoEmpresa(req, _res, next) {
  if (req.auth && req.auth.tipo === 'empresa') {
    if (req.body && typeof req.body === 'object') {
      req.body.cnpjEmpresa = req.auth.cnpj;
      req.body.ambiente = req.auth.ambiente;
    }
    req.query.cnpjEmpresa = req.auth.cnpj;
    req.query.ambiente = req.auth.ambiente;
  }
  next();
}

/* Confere que uma nota está no escopo de quem pediu. Devolve 404 (e não 403)
   quando não está: para quem chamou, uma nota fora do seu escopo simplesmente
   não existe — não vale revelar que existe e é de outro. */
function notaNoEscopo(req, nota) {
  if (!req.auth) return false;
  if (!nota) return false;
  return empresaVisivel(req, nota.empresa_id);
}

module.exports = {
  somenteAdmin, exigirUsuario, fixarEscopoEmpresa, notaNoEscopo,
  empresasVisiveis, empresaVisivel, filtroSqlEmpresas
};
