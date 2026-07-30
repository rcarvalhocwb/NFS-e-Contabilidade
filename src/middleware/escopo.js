/* Aplicação do escopo do token nas rotas.
   O middleware de auth identifica quem chamou; aqui decidimos o que pode. */

/* Rotas de gestão (cadastro de empresas, certificados, municípios, webhooks,
   consultas externas) só respondem à credencial administrativa. Um token de
   cliente não pode cadastrar empresa nem trocar certificado. */
function somenteAdmin(req, res, next) {
  if (req.auth && req.auth.tipo === 'admin') return next();
  return res.status(403).json({
    erro: 'Esta rota exige a credencial administrativa do gateway. O token da empresa dá acesso apenas às rotas de NFS-e.'
  });
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

/* Confere que uma nota pertence à empresa do token. Devolve 404 (e não 403)
   quando não pertence: para o cliente, uma nota de outra empresa simplesmente
   não existe — não vale revelar que existe e é de outro. */
function notaNoEscopo(req, nota) {
  if (!req.auth || req.auth.tipo === 'admin') return true;
  return nota && Number(nota.empresa_id) === Number(req.auth.empresaId);
}

module.exports = { somenteAdmin, fixarEscopoEmpresa, notaNoEscopo };
