const config = require('../config');

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

/* Rotas do SERVIDOR, não do escritório.
 *
 * Enquanto uma instalação atendia um escritório, administrador do escritório e
 * operador do servidor eram a mesma pessoa: a contabilidade rodava o gateway na
 * própria máquina, e quem trocava o certificado TLS era quem emitia as notas.
 * `somenteAdmin` cobria os dois papéis porque eram um.
 *
 * Num servidor com vários escritórios eles se separam, e a diferença passa a
 * importar muito: `config_rede` é o endereço e o certificado TLS do servidor
 * inteiro, `backup_destinos` são caminhos de disco da máquina, e reiniciar
 * derruba o painel de TODAS as casas. Deixar isso com o administrador de um
 * escritório é deixar um cliente mexer na infraestrutura dos outros.
 *
 * O modo é explícito (MULTI_ESCRITORIO), e não deduzido da quantidade de
 * escritórios no banco: autorização que muda sozinha quando alguém cadastra
 * uma linha é autorização que ninguém consegue prever. Para não ficar
 * esquecido, o servidor avisa alto na inicialização se houver mais de um
 * escritório com o modo desligado — ver src/server.js.
 */
function somenteOperador(req, res, next) {
  // Credencial de máquina: quem tem a GATEWAY_API_KEY está no servidor.
  if (req.auth && req.auth.tipo === 'maquina') return next();

  /* Instalação de um escritório só: o administrador É o operador, e tirar
     dele essas telas quebraria o produto de mesa sem proteger ninguém. */
  if (!config.multiEscritorio) return somenteAdmin(req, res, next);

  return res.status(403).json({
    erro: 'Esta ação é do operador do servidor, não do escritório. ' +
          'Ela afeta todos os escritórios desta instalação.'
  });
}

/* Rotas da própria conta (trocar senha, ver quem sou) só fazem sentido para uma
   pessoa logada — chave de máquina não tem conta. */
function exigirUsuario(req, res, next) {
  if (req.auth && req.auth.tipo === 'usuario') return next();
  return res.status(403).json({ erro: 'Esta rota exige um usuário logado no painel' });
}

/* Empresas que quem chamou pode enxergar.
   `null` = todas; lista vazia = nenhuma. O chamador PRECISA distinguir os dois.

   QUEM ENXERGA TUDO É SÓ QUEM ADMINISTRA. Até 26/08/2026 um usuário sem vínculo
   enxergava todas as empresas, qualquer que fosse o perfil — regra pensada para
   uma instalação de um CNPJ só. Num escritório com dezenas de clientes, criar um
   operador e esquecer de vincular dava a ele a vida fiscal da casa inteira, sem
   nenhum sinal na tela. Agora o vínculo vazio significa o que parece significar:
   nenhuma empresa.

   admin    → todas (é quem cadastra empresa; sem isso não conseguiria criar a
              primeira nem enxergar o que acabou de criar)
   operador → só as vinculadas
   cliente  → só as vinculadas, e o vínculo é obrigatório no cadastro */
function empresasVisiveis(req) {
  if (!req.auth) return [];
  if (req.auth.tipo === 'empresa') return [req.auth.empresaId];
  if (req.auth.tipo === 'usuario') {
    if (req.auth.perfil === 'admin') return null;
    return req.auth.empresasIds || [];
  }
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
  somenteAdmin, somenteOperador, exigirUsuario, fixarEscopoEmpresa, notaNoEscopo,
  empresasVisiveis, empresaVisivel, filtroSqlEmpresas
};
