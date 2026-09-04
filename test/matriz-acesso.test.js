const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Matriz rota x perfil.
 *
 * Cada rota do gateway tem um dono: quem pode chamar. Isso vivia espalhado --
 * um pouco no server.js (no app.use), um pouco num router.use no topo do
 * arquivo, um pouco no proprio router.get. Ler tres lugares para responder
 * "quem alcanca esta rota?" e como se descobre tarde que ninguem respondeu.
 *
 * A tabela abaixo e a resposta escrita uma vez. O teste compara com a pilha
 * REAL do Express -- as funcoes que estao instaladas, com nome -- e nao com o
 * texto do arquivo. Uma auditoria por expressao regular ja acusou 28 rotas
 * desprotegidas que estavam protegidas na montagem; foi por isso que aqui se
 * pergunta ao Express, nao ao editor de texto.
 *
 * Rota nova nao entra em silencio: sem linha na tabela, o teste quebra e
 * alguem precisa dizer de quem ela e.
 *
 * O que este teste NAO faz: provar o comportamento. Ele trava a forma. A prova
 * de que o operador so enxerga as empresas dele foi feita com o sistema no ar,
 * em banco separado, com as 125 rotas e seis credenciais -- esta em
 * scripts/matriz-acesso.js, que precisa de banco e por isso nao roda aqui.
 *
 * Os niveis:
 *   aberta       -- montada ANTES do app.use(auth): login, logout, estado
 *   admin        -- somenteAdmin: gestao do gateway, certificado, numeracao
 *   pessoa       -- exigirUsuario: a propria conta (chave de maquina nao tem)
 *   escopo-token -- fixarEscopoEmpresa: o CNPJ vem do token, nunca do corpo
 *   logado       -- qualquer usuario; o escopo e aplicado DENTRO da rota
 */

const ACESSO = {
  "GET /auth/estado": "aberta",
  "POST /auth/primeiro-acesso": "aberta",
  "POST /auth/login": "aberta",
  "POST /auth/logout": "aberta",
  "GET /webhooks": "admin",
  "POST /webhooks": "admin",
  "PUT /webhooks/:id": "admin",
  "DELETE /webhooks/:id": "admin",
  "GET /webhooks/entregas": "admin",
  "GET /municipios": "admin",
  "GET /municipios/:codigo": "admin",
  "POST /municipios/:codigo/classificar": "admin",
  "POST /municipios/:codigo/confirmar-emissor": "admin",
  "PUT /municipios/:codigo": "admin",
  "GET /integracao/:cnpj": "admin",
  "POST /integracao/:cnpj/tokens": "admin",
  "DELETE /integracao/:cnpj/tokens/:ambiente": "admin",
  "POST /empresas": "admin",
  "GET /empresas": "logado",
  "GET /empresas/:cnpj/prontidao": "logado",
  "GET /empresas/:cnpj": "logado",
  "PUT /empresas/:cnpj": "admin",
  "GET /empresas/:cnpj/resumo": "logado",
  "GET /empresas/:cnpj/whatsapp": "admin",
  "POST /empresas/:cnpj/whatsapp": "admin",
  "DELETE /empresas/:cnpj/whatsapp/:id": "admin",
  "PUT /empresas/:cnpj/portal": "admin",
  "PUT /empresas/:cnpj/ambiente": "admin",
  "GET /empresas/:cnpj/padroes-fiscais": "logado",
  "PUT /empresas/:cnpj/padroes-fiscais": "admin",
  "GET /empresas/:cnpj/historico": "logado",
  "GET /empresas/:cnpj/numeracao": "logado",
  "PUT /empresas/:cnpj/numeracao": "admin",
  "POST /empresas/:cnpj/certificado": "admin",
  "GET /consulta/cnpj/:cnpj": "logado",
  "GET /consulta/cep/:cep": "logado",
  "GET /emissor/contexto": "logado",
  "GET /emissor/tomador/:documento": "logado",
  "POST /emissor/tomador": "logado",
  "POST /emissor/servico": "logado",
  "DELETE /emissor/servico/:id": "logado",
  "POST /emissor/registrar-uso": "logado",
  "GET /emissor/indicadores-operacao": "logado",
  "GET /painel/resumo": "logado",
  "GET /atualizacao": "logado",
  "POST /atualizacao/verificar": "admin",
  "POST /atualizacao/baixar": "admin",
  "POST /atualizacao/dispensar": "admin",
  "GET /obrigacoes/agenda": "logado",
  "GET /obrigacoes/modelos": "logado",
  "POST /obrigacoes/modelos": "admin",
  "PUT /obrigacoes/modelos/:id": "admin",
  "POST /obrigacoes/modelos/sugestoes": "admin",
  "GET /obrigacoes/empresa/:id": "logado",
  "PUT /obrigacoes/empresa/:id/modelo/:modeloId": "admin",
  "PUT /obrigacoes/:id": "logado",
  "POST /obrigacoes/gerar": "admin",
  "GET /identidade": "logado",
  "PUT /identidade": "admin",
  "POST /identidade/logo": "admin",
  "DELETE /identidade/logo": "admin",
  "GET /email": "admin",
  "PUT /email": "admin",
  "POST /email/testar": "admin",
  "POST /email/resumo": "admin",
  "GET /ponte/config": "admin",
  "PUT /ponte/config": "admin",
  "GET /ponte/repassador": "admin",
  "POST /ponte/repassador/reiniciar": "admin",
  "POST /ponte/sincronizar": "admin",
  "POST /ponte/cadastro": "admin",
  "GET /ponte/cadastro/previa": "admin",
  "GET /ponte/diagnostico": "admin",
  "GET /ponte/solicitacoes": "logado",
  "POST /ponte/solicitacoes/:id/aprovar": "logado",
  "POST /ponte/solicitacoes/:id/recusar": "logado",
  "GET /usuarios/eu": "pessoa",
  "PUT /usuarios/eu/empresa-padrao": "pessoa",
  "POST /usuarios/eu/senha": "pessoa",
  "GET /usuarios": "admin",
  "POST /usuarios": "admin",
  "PUT /usuarios/:id": "admin",
  "DELETE /usuarios/:id": "admin",
  "POST /usuarios/:id/encerrar-sessoes": "admin",
  "GET /manutencao": "admin",
  "POST /manutencao/backup": "admin",
  "GET /manutencao/sistema": "admin",
  "POST /manutencao/sistema/reiniciar": "admin",
  "GET /manutencao/rede/config": "admin",
  "PUT /manutencao/rede/config": "admin",
  "POST /manutencao/rede/certificado": "admin",
  "GET /manutencao/rede": "admin",
  "GET /manutencao/copias": "admin",
  "POST /manutencao/copias": "admin",
  "DELETE /manutencao/copias/:id": "admin",
  "POST /manutencao/copias/copiar": "admin",
  "POST /manutencao/migracao": "admin",
  "GET /manutencao/arquivo/:nome": "admin",
  "DELETE /manutencao/arquivo/:nome": "admin",
  "GET /lote/modelo": "logado",
  "POST /lote/conferir": "logado",
  "POST /lote": "logado",
  "GET /lote": "logado",
  "GET /lote/:id": "logado",
  "GET /relatorios/fechamento": "logado",
  "GET /relatorios/fechamento.pdf": "logado",
  "GET /relatorios/notas": "logado",
  "GET /relatorios/notas.csv": "logado",
  "GET /notas-entrada": "logado",
  "GET /notas-entrada/fornecedores": "logado",
  "GET /notas-entrada/:id/xml": "logado",
  "POST /notas-entrada/importar": "admin",
  "POST /notas-entrada/importar-pasta": "admin",
  "POST /nfse": "escopo-token",
  "GET /nfse": "escopo-token",
  "GET /nfse/export": "escopo-token",
  "GET /nfse/export-pdf": "escopo-token",
  "GET /nfse/pacote": "escopo-token",
  "GET /nfse/local/:id": "escopo-token",
  "GET /nfse/:idOuChave/xml": "escopo-token",
  "GET /nfse/:idOuChave/xml-dps": "escopo-token",
  "GET /nfse/:idOuChave/danfse": "escopo-token",
  "GET /nfse/:chaveAcesso": "escopo-token",
  "GET /nfse/:chaveAcesso/eventos": "escopo-token",
  "POST /nfse/:chaveAcesso/cancelamento": "escopo-token",
};

/* ------------------------------------------------- a pilha real do Express */

const ARQUIVOS = { empresas: 'empresas', nfse: 'nfse', webhooks: 'webhooks',
  municipios: 'municipios', consulta: 'consulta', integracao: 'integracao',
  painel: 'painel', atualizacao: 'atualizacao', identidade: 'identidade',
  email: 'email', ponte: 'ponte', obrigacoes: 'obrigacoes', emissor: 'emissor',
  auth: 'auth', usuarios: 'usuarios', manutencao: 'manutencao', lote: 'lote',
  relatorios: 'relatorios', notasEntrada: 'notasEntrada' };

function inventario() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const posAuth = src.indexOf('app.use(auth)');
  assert.ok(posAuth > 0, 'o middleware de auth precisa continuar sendo montado no server.js');

  const rotas = {};
  const re = /app\.use\(\s*(?:\[([^\]]+)\]|'([^']+)')\s*,([^;]*?)\);/g;
  let m;
  while ((m = re.exec(src))) {
    const alvo = m[3].match(/(\w+)Router/);
    if (!alvo) continue;
    const prefixos = m[1] ? m[1].split(',').map(s => s.trim().replace(/'/g, '')) : [m[2]];
    const naMontagem = m[3].match(/somenteAdmin|exigirUsuario|fixarEscopoEmpresa/g) || [];
    const antesDoAuth = m.index < posAuth;

    for (const prefixo of prefixos) {
      const router = require(path.join(__dirname, '..', 'src', 'routes', ARQUIVOS[alvo[1]]));
      /* router.use so alcanca o que foi declarado DEPOIS dele. Somando a
         pilha inteira, /usuarios/eu apareceria como admin -- e nao e: o
         router.use(somenteAdmin) do arquivo vem depois dele, de proposito. */
      const acumuladas = [];
      for (const camada of router.stack) {
        const nome = camada.name || (camada.handle && camada.handle.name);
        if (!camada.route) {
          if (nome && nome !== '<anonymous>' && nome !== 'router') acumuladas.push(nome);
          continue;
        }
        const daRota = camada.route.stack
          .map(s => s.name || (s.handle && s.handle.name))
          .filter(n => n && n !== '<anonymous>');
        const guardas = [...new Set([...naMontagem, ...acumuladas, ...daRota])];
        for (const metodo of Object.keys(camada.route.methods)) {
          const chave = metodo.toUpperCase() + ' ' + prefixo +
            (camada.route.path === '/' ? '' : camada.route.path);
          rotas[chave] = { guardas, antesDoAuth };
        }
      }
    }
  }
  return rotas;
}

function nivelObservado(r) {
  if (r.antesDoAuth) return 'aberta';
  if (r.guardas.includes('somenteAdmin')) return 'admin';
  if (r.guardas.includes('exigirUsuario')) return 'pessoa';
  if (r.guardas.includes('fixarEscopoEmpresa')) return 'escopo-token';
  return 'logado';
}

const ROTAS = inventario();

/* ---------------------------------------------------------------- os testes */

test('toda rota do gateway tem dono declarado', () => {
  const semDono = Object.keys(ROTAS).filter(r => !(r in ACESSO));
  assert.deepEqual(semDono, [],
    'rota sem linha na tabela ACESSO -- decida quem pode chamar antes de subir:\n  ' +
    semDono.join('\n  '));
});

test('a tabela nao guarda rota que deixou de existir', () => {
  /* Linha orfa e pior do que linha faltando: parece que alguem decidiu. */
  const orfas = Object.keys(ACESSO).filter(r => !(r in ROTAS));
  assert.deepEqual(orfas, [], 'rota na tabela que nao existe mais:\n  ' + orfas.join('\n  '));
});

test('o que a tabela declara e o que o Express instalou', () => {
  const divergentes = [];
  for (const [rota, esperado] of Object.entries(ACESSO)) {
    if (!ROTAS[rota]) continue;
    const obtido = nivelObservado(ROTAS[rota]);
    if (obtido !== esperado) {
      divergentes.push(rota + ': tabela diz "' + esperado + '", pilha diz "' + obtido +
        '" (' + (ROTAS[rota].guardas.join(', ') || 'nenhuma guarda') + ')');
    }
  }
  assert.deepEqual(divergentes, [], divergentes.join('\n  '));
});

test('so as rotas de login ficam antes do auth', () => {
  /* Uma rota montada acima do app.use(auth) e publica para quem alcancar a
     porta -- na rede do escritorio, qualquer maquina. */
  const abertas = Object.entries(ROTAS).filter(([, r]) => r.antesDoAuth).map(([k]) => k);
  for (const r of abertas) {
    assert.ok(r.includes(' /auth/'),
      'rota fora de /auth montada antes da autenticacao: ' + r);
  }
});

test('nenhuma rota de gestao caiu para "logado"', () => {
  /* O erro que este teste existe para pegar: uma rota de certificado, token,
     numeracao ou usuario perdendo o somenteAdmin numa refatoracao. */
  const GESTAO = /\/(webhooks|municipios|integracao|manutencao|usuarios)\b/;
  /* Pergunta a PILHA, nao a tabela: se as duas fossem editadas juntas, o teste
     concordaria consigo mesmo e nao veria nada. */
  const frouxas = Object.entries(ROTAS)
    .filter(([rota, r]) => GESTAO.test(rota) && nivelObservado(r) === 'logado')
    .map(([rota]) => rota);
  assert.deepEqual(frouxas, [],
    'rota de gestao sem exigencia de admin:\n  ' + frouxas.join('\n  '));
});

test('as rotas de NFS-e passam pela fixacao de escopo', () => {
  /* Sem fixarEscopoEmpresa, um token de empresa emitiria em nome de outra: o
     CNPJ viria do corpo da requisicao. */
  const nfse = Object.keys(ACESSO).filter(r => / \/nfse/.test(r));
  assert.ok(nfse.length >= 10, 'esperava as rotas de NFS-e na tabela');
  for (const r of nfse) {
    assert.equal(nivelObservado(ROTAS[r]), 'escopo-token',
      r + ' precisa continuar com escopo fixado');
  }
});

test('a propria conta nao aceita chave de maquina', () => {
  /* Trocar a senha "de quem?" nao tem resposta para uma credencial que nao e
     de ninguem. Sao as unicas rotas em que a chave global vale MENOS. */
  for (const r of ['GET /usuarios/eu', 'PUT /usuarios/eu/empresa-padrao', 'POST /usuarios/eu/senha']) {
    assert.equal(nivelObservado(ROTAS[r]), 'pessoa', r + ' precisa exigir usuario logado');
  }
});

test('as listagens do dia a dia continuam abertas a quem opera', () => {
  /* O contrapeso: se tudo virasse admin, o operador nao conseguiria trabalhar
     e alguem daria perfil de admin para ele -- que e como o isolamento morre
     na pratica. Estas precisam continuar alcancaveis, com escopo por dentro. */
  for (const r of ['GET /nfse', 'GET /empresas', 'GET /relatorios/notas',
                   'GET /notas-entrada', 'GET /painel/resumo']) {
    assert.ok(['logado', 'escopo-token'].includes(nivelObservado(ROTAS[r])),
      r + ' precisa continuar acessivel ao operador');
  }
});
