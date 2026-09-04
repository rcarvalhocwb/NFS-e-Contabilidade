#!/usr/bin/env node
/**
 * Matriz de acesso, ao vivo: dispara TODA rota do gateway com TODA credencial.
 *
 * Por que ao vivo, se já existe test/matriz-acesso.test.js? Porque aquele
 * teste trava a FORMA — quais guardas o Express instalou — e boa parte do
 * escopo não está em guarda nenhuma: está dentro da rota, no filtro do SQL.
 * Análise estática não enxerga isso. Numa auditoria por expressão regular, 28
 * rotas apareceram desprotegidas e todas estavam protegidas na montagem; no
 * mesmo dia, uma rota que parecia certa entregava dado de outra empresa. Só
 * perguntando ao sistema no ar dá para saber.
 *
 * NADA disso toca a instalação de verdade. O script cria um banco separado
 * (nfse_matriz), roda as migrações nele, semeia duas empresas e sobe uma
 * segunda cópia do gateway numa porta própria. Ao terminar, derruba tudo.
 *
 * Uso:  node scripts/matriz-acesso.js
 *       node scripts/matriz-acesso.js --manter    (não derruba o banco no fim)
 *
 * O desenho do teste, que é o que importa quando alguém for mexer nele:
 *
 *  - a empresa A leva uma marca ("SEGREDODAEMPRESAA") que não existe em mais
 *    lugar nenhum. Se a marca aparecer numa resposta dada a quem só enxerga a
 *    B, o vazamento é literal — não há o que interpretar. Status 200 sozinho
 *    não prova nada: uma listagem corretamente filtrada também devolve 200;
 *
 *  - toda rota que passa é conferida NOS DOIS SENTIDOS. "Bloqueado" só vale
 *    junto com a contraprova de que a mesma pessoa alcança o que é dela —
 *    senão um sistema quebrado passaria com louvor;
 *
 *  - rotas irreversíveis (reiniciar o gateway, sincronizar com a nuvem, mandar
 *    e-mail) são disparadas só para as credenciais fracas, onde a afirmação
 *    interessante é "foi recusado", e a recusa acontece no middleware, antes
 *    do corpo da rota rodar. Para admin e máquina não há disparo, e isso sai
 *    no relatório como não-disparado — nunca como aprovado;
 *
 *  - o perfil 'cliente' é barrado no próprio /auth/login: ele existe para ser
 *    replicado ao portal, não para entrar no painel. A sessão dele é criada
 *    por dentro, de propósito, para responder à pergunta seguinte: se uma
 *    sessão dessas escapasse, o escopo continuaria de pé?
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Client } = require('pg');

const RAIZ = path.join(__dirname, '..');
const BANCO = 'nfse_matriz';
const PORTA = Number(process.env.PORTA_MATRIZ || 3999);
const SENHA = 'Matriz#' + crypto.randomBytes(6).toString('hex');
const MARCA_A = 'SEGREDODAEMPRESAA';
const MARCA_B = 'DADODAEMPRESAB';
const MANTER = process.argv.includes('--manter');

const urlBase = process.env.DATABASE_URL;
if (!urlBase) { console.error('DATABASE_URL não configurada.'); process.exit(1); }
const urlMatriz = urlBase.replace(/\/[^/]+$/, '/' + BANCO);

/* --------------------------------------------------------------- utilidades */

function pedir(metodo, caminho, cabecalhos, dados) {
  return new Promise(resolve => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, cabecalhos);
    if (dados) h['Content-Length'] = Buffer.byteLength(dados);
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: caminho,
      method: metodo, headers: h }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: b.slice(0, 20000) }));
    });
    req.on('error', e => resolve({ status: 0, corpo: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: -1, corpo: 'timeout' }); });
    if (dados) req.write(dados);
    req.end();
  });
}

async function entrar(email) {
  const dados = JSON.stringify({ email, senha: SENHA });
  const r = await new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: '/auth/login',
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados) } },
      res => {
        let b = '';
        res.on('data', d => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie'], corpo: b }));
      });
    req.on('error', () => resolve({ status: 0, corpo: 'sem conexão' }));
    req.write(dados); req.end();
  });
  if (!r.cookie) throw new Error('login falhou para ' + email + ': ' + r.status + ' ' + r.corpo);
  return r.cookie.map(c => c.split(';')[0]).join('; ');
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------------------- inventário de rotas */

const ARQUIVOS = { empresas: 'empresas', nfse: 'nfse', webhooks: 'webhooks',
  municipios: 'municipios', consulta: 'consulta', integracao: 'integracao',
  painel: 'painel', atualizacao: 'atualizacao', identidade: 'identidade',
  email: 'email', ponte: 'ponte', obrigacoes: 'obrigacoes', emissor: 'emissor',
  auth: 'auth', usuarios: 'usuarios', manutencao: 'manutencao', lote: 'lote',
  relatorios: 'relatorios', notasEntrada: 'notasEntrada' };

function inventario() {
  const src = require('fs').readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const rotas = [];
  const re = /app\.use\(\s*(?:\[([^\]]+)\]|'([^']+)')\s*,([^;]*?)\);/g;
  let m;
  while ((m = re.exec(src))) {
    const alvo = m[3].match(/(\w+)Router/);
    if (!alvo) continue;
    const prefixos = m[1] ? m[1].split(',').map(s => s.trim().replace(/'/g, '')) : [m[2]];
    for (const prefixo of prefixos) {
      const router = require(path.join(RAIZ, 'src', 'routes', ARQUIVOS[alvo[1]]));
      for (const camada of router.stack) {
        if (!camada.route) continue;
        for (const metodo of Object.keys(camada.route.methods)) {
          rotas.push({ metodo: metodo.toUpperCase(),
            padrao: prefixo + (camada.route.path === '/' ? '' : camada.route.path) });
        }
      }
    }
  }
  return rotas;
}

/* Onde couber, o identificador da EMPRESA A — a que o operador não enxerga.
   É o alvo que interessa: um 404 por "não existe" não prova nada. */
function concretizar(padrao, dados) {
  if (padrao.startsWith('/usuarios/:id')) {
    /* Nunca o admin: numa primeira rodada este :id apontou para ele, e
       POST /usuarios/1/encerrar-sessoes derrubou a sessão que estava medindo.
       As 40 linhas seguintes vieram 401 e o relatório parecia um sistema
       recusando o próprio administrador. */
    return padrao.replace(':id', String(dados.descartavelId));
  }
  return padrao
    .replace(':cnpj', dados.empresaA)
    .replace(':chaveAcesso', '41260311222333000181000000000000000000000000001')
    .replace(':idOuChave', String(dados.notaA))
    .replace(':codigo', '4106902')
    .replace(':modeloId', '1')
    .replace(':cep', '80010000')
    .replace(':documento', dados.empresaA)
    .replace(':nome', 'copia.bkp')
    .replace(':ambiente', 'homologacao')
    .replace(':id', String(dados.entradaA));
}

const PERIGOSAS = new Set([
  'POST /manutencao/sistema/reiniciar',   // derruba a tarefa do Windows: a instalação de produção
  'POST /manutencao/migracao',
  'POST /manutencao/backup',
  'POST /manutencao/copias',
  'POST /manutencao/copias/copiar',
  'POST /manutencao/rede/certificado',
  'PUT /manutencao/rede/config',
  'POST /atualizacao/baixar',
  'POST /atualizacao/verificar',
  'POST /ponte/sincronizar',
  'POST /ponte/repassador/reiniciar',
  'POST /ponte/cadastro',
  'POST /email/testar',
  'POST /email/resumo',
  'POST /nfse',                            // emitiria documento fiscal
  'POST /auth/logout',
  'POST /notas-entrada/importar-pasta'
]);

/* ------------------------------------------------------------------ preparo */

async function prepararBanco() {
  const admin = new Client({ connectionString: urlBase.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  /* Uma rodada interrompida deixa a cópia do gateway segurando conexão, e o
     DROP falha com "está sendo acessado por outros usuários" — o que faria a
     ferramenta de conferência exigir conferência. Derruba só as conexões DESTE
     banco de teste, pelo nome; a instalação de verdade nem é mencionada. */
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [BANCO]);
  await admin.query('DROP DATABASE IF EXISTS ' + BANCO);
  await admin.query('CREATE DATABASE ' + BANCO);
  await admin.end();
  execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'migrate.js')],
    { cwd: RAIZ, env: Object.assign({}, process.env, { DATABASE_URL: urlMatriz }), stdio: 'ignore' });
}

async function semear() {
  process.env.DATABASE_URL = urlMatriz;
  const db = require(path.join(RAIZ, 'src', 'db'));
  const usuarios = require(path.join(RAIZ, 'src', 'services', 'usuarios'));

  const empresas = [];
  for (const [cnpj, nome] of [['11222333000181', 'Empresa A'], ['44555666000199', 'Empresa B']]) {
    const r = await db.query(
      `INSERT INTO empresas (cnpj, razao_social, codigo_municipio, ambiente, ativo)
       VALUES ($1,$2,'4106902','homologacao',TRUE) RETURNING id`, [cnpj, nome]);
    empresas.push({ id: r.rows[0].id, cnpj });
  }
  const [A, B] = empresas;

  const admin = await usuarios.criar({ nome: 'Admin', email: 'admin@matriz.teste',
    senha: SENHA, perfil: 'admin', empresasIds: [] });
  const operador = await usuarios.criar({ nome: 'Operador', email: 'op@matriz.teste',
    senha: SENHA, perfil: 'operador', empresasIds: [B.id] });
  const cliente = await usuarios.criar({ nome: 'Cliente', email: 'cli@matriz.teste',
    senha: SENHA, perfil: 'cliente', empresasIds: [B.id] });
  const descartavel = await usuarios.criar({ nome: 'Descartavel',
    email: 'descartavel@matriz.teste', senha: SENHA, perfil: 'operador', empresasIds: [B.id] });

  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO empresa_tokens (empresa_id, ambiente, token_hash, descricao)
     VALUES ($1,'homologacao',$2,'matriz')`,
    [B.id, crypto.createHash('sha256').update(token).digest('hex')]);

  const dados = { empresaA: A.cnpj, empresaB: B.cnpj, empresaAId: A.id, empresaBId: B.id,
    clienteId: cliente.id, operadorId: operador.id, adminId: admin.id,
    descartavelId: descartavel.id, tokenEmpresa: token };

  for (const [id, marca] of [[A.id, MARCA_A], [B.id, MARCA_B]]) {
    for (let i = 1; i <= 3; i++) {
      const r = await db.query(
        `INSERT INTO notas (empresa_id, id_dps, serie, numero, status, ambiente,
                            chave_acesso, referencia, criado_em)
         VALUES ($1,$2,'1',$3,'autorizada','homologacao',$4,$5, now()) RETURNING id`,
        [id, marca + '-DPS-' + i, i,
         String(id).padStart(2, '0') + '9'.repeat(42) + i, marca + '-REF-' + i]);
      if (id === A.id && i === 1) dados.notaA = r.rows[0].id;
    }
    const e = await db.query(
      `INSERT INTO notas_entrada (empresa_id, chave_acesso, xml, prestador_doc,
                                  prestador_nome, descricao, valor_servico, emitido_em, competencia)
       VALUES ($1,$2,$3,'',$4,$5,1000,now(),date_trunc('month', now())) RETURNING id`,
      [id, marca + '-ENT-1', '<n>' + marca + '</n>', marca + ' Prestador', 'servico ' + marca]);
    if (id === A.id) dados.entradaA = e.rows[0].id;
    if (id === B.id) dados.entradaB = e.rows[0].id;
    const s = await db.query(
      `INSERT INTO solicitacoes (id_externo, empresa_id, cnpj_informado, payload, situacao)
       VALUES ($1,$2,$3,$4,'aguardando') RETURNING id`,
      [marca + '-SOL-1', id, id === A.id ? A.cnpj : B.cnpj, JSON.stringify({ marca })]);
    if (id === A.id) dados.solicitacaoA = s.rows[0].id;
  }
  /* O pool NAO e encerrado aqui: sessoes.criar() usa o mesmo modulo db mais
     adiante, para montar a sessao do perfil 'cliente'. Encerrar cedo dava
     "Cannot use a pool after calling end on the pool" no meio do preparo. */
  return dados;
}

function subirGateway() {
  const filho = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATABASE_URL: urlMatriz, PORT: String(PORTA),
      PERMITIR_PRODUCAO: 'false',      // nenhuma nota com valor fiscal, nunca
      ATUALIZACAO_VERIFICAR: 'false'
    }),
    stdio: 'ignore'
  });
  return filho;
}

async function esperarNoAr() {
  for (let i = 0; i < 60; i++) {
    const r = await pedir('GET', '/auth/estado', {});
    if (r.status === 200) return true;
    await esperar(500);
  }
  return false;
}

/* ------------------------------------------------------------------- medidas */

async function matriz(identidades, dados) {
  const FRACAS = ['anonimo', 'tokenEmpresa', 'cliente', 'operador'];
  const linhas = [];
  for (const rota of inventario()) {
    const chave = rota.metodo + ' ' + rota.padrao;
    const caminho = concretizar(rota.padrao, dados);
    const perigosa = PERIGOSAS.has(chave);
    const linha = { rota: chave, perigosa, por: {}, vazou: [] };
    for (const [nome, cab] of Object.entries(identidades)) {
      if (perigosa && !FRACAS.includes(nome)) { linha.por[nome] = 'nao-disparado'; continue; }
      const d = ['GET', 'DELETE'].includes(rota.metodo) ? null : '{}';
      const r = await pedir(rota.metodo, caminho, cab, d);
      linha.por[nome] = r.status;
      if (r.status < 400 && r.corpo.includes(MARCA_A) && !['admin', 'maquina'].includes(nome)) {
        linha.vazou.push({ quem: nome, trecho: r.corpo.slice(0, 200) });
      }
      if (perigosa && r.status < 400) {
        linha.por[nome] = String(r.status) + '!';
        for (const outro of Object.keys(identidades)) {
          if (!(outro in linha.por)) linha.por[outro] = 'nao-disparado';
        }
        break;
      }
    }
    linhas.push(linha);
  }
  return linhas;
}

/* As listagens: 200 é esperado para todo mundo. O que separa certo de errado é
   o CONTEÚDO — e a contraprova de que o operador recebe o que é dele. */
const LISTAGENS = ['/empresas', '/nfse', '/relatorios/notas', '/relatorios/fechamento',
  '/notas-entrada', '/notas-entrada/fornecedores', '/ponte/solicitacoes', '/painel/resumo'];

async function conteudo(identidades, dados) {
  const achados = [];
  for (const rota of LISTAGENS) {
    for (const quem of ['tokenEmpresa', 'cliente', 'operador']) {
      const r = await pedir('GET', rota, identidades[quem]);
      const temA = r.corpo.includes(MARCA_A) || r.corpo.includes(dados.empresaA) || r.corpo.includes('Empresa A');
      const temB = r.corpo.includes(MARCA_B) || r.corpo.includes(dados.empresaB) || r.corpo.includes('Empresa B');
      achados.push({ rota, quem, status: r.status, temA, temB });
    }
  }
  return achados;
}

/* Ids que EXISTEM e são da empresa A: aqui um 404 não pode ser confundido com
   "não existe". É o ataque de trocar o número na barra de endereço. */
async function idsAlheios(identidades, dados) {
  const alvos = [
    ['GET', '/notas-entrada/' + dados.entradaA + '/xml', null, 'XML de nota de entrada alheia'],
    ['GET', '/nfse/local/' + dados.notaA, null, 'nota emitida alheia'],
    ['GET', '/nfse/' + dados.notaA + '/xml', null, 'XML da DPS alheia'],
    ['GET', '/nfse/' + dados.notaA + '/xml-dps', null, 'DPS assinada alheia'],
    ['GET', '/nfse/' + dados.notaA + '/danfse', null, 'DANFSe alheia'],
    ['POST', '/ponte/solicitacoes/' + dados.solicitacaoA + '/aprovar', '{}',
      'APROVAR pedido alheio (emitiria nota em nome de outra empresa)'],
    ['POST', '/ponte/solicitacoes/' + dados.solicitacaoA + '/recusar',
      JSON.stringify({ motivo: 'matriz' }), 'recusar pedido alheio'],
    ['GET', '/obrigacoes/empresa/' + dados.empresaAId, null, 'obrigações da empresa alheia'],
    ['GET', '/empresas/' + dados.empresaA, null, 'cadastro da empresa alheia'],
    ['GET', '/empresas/' + dados.empresaA + '/numeracao', null, 'numeração fiscal alheia'],
    ['GET', '/empresas/' + dados.empresaA + '/historico', null, 'histórico alheio']
  ];
  const achados = [];
  for (const [metodo, caminho, corpo, oque] of alvos) {
    for (const quem of ['operador', 'tokenEmpresa']) {
      const r = await pedir(metodo, caminho, identidades[quem], corpo);
      achados.push({ quem, rota: metodo + ' ' + caminho, oque, status: r.status,
        marca: r.corpo.includes(MARCA_A) || r.corpo.includes(dados.empresaA),
        passou: r.status < 400 });
    }
  }
  /* Contraprova: o mesmo caminho com o id da própria empresa precisa funcionar.
     "Tudo bloqueado" também é o que um sistema quebrado devolve. */
  const c = await pedir('GET', '/notas-entrada/' + dados.entradaB + '/xml', identidades.operador);
  return { achados, contraprova: c.status };
}

/* ---------------------------------------------------------------- relatório */

function relatorio(linhas, listagens, alheios) {
  const ID = ['anonimo', 'tokenEmpresa', 'cliente', 'operador', 'admin', 'maquina'];
  const recusa = s => s === 401 || s === 403;
  let falhas = 0;

  console.log('\n=============== MATRIZ DE ACESSO ===============\n');
  console.log('ROTA'.padEnd(46) + ID.map(i => i.slice(0, 6).padStart(8)).join(''));
  for (const l of linhas) {
    console.log(l.rota.padEnd(46) +
      ID.map(i => String(l.por[i] === 'nao-disparado' ? '--' : l.por[i]).padStart(8)).join('') +
      (l.perigosa ? '  *' : ''));
  }
  console.log('\n(*) rota irreversível: não disparada para admin/máquina. "--" = não disparado.');

  console.log('\n--- anônimo alcançou alguma rota fora de /auth?');
  const abertas = linhas.filter(l => !recusa(l.por.anonimo) && !l.rota.includes('/auth/'));
  if (abertas.length) { falhas += abertas.length; abertas.forEach(l => console.log('  FALHA', l.rota, l.por.anonimo)); }
  else console.log('  não.');

  console.log('\n--- marca da empresa A numa resposta de quem só enxerga a B?');
  const vazamentos = linhas.filter(l => l.vazou.length);
  if (vazamentos.length) {
    falhas += vazamentos.length;
    vazamentos.forEach(l => l.vazou.forEach(v =>
      console.log('  VAZOU', l.rota, '->', v.quem, '|', v.trecho.slice(0, 120))));
  } else console.log('  não.');

  console.log('\n--- listagens: cada um vê o seu?');
  for (const a of listagens) {
    const certo = !a.temA && (a.temB || a.status >= 400);
    if (!certo) falhas++;
    console.log('  ' + (certo ? 'ok  ' : 'XX  ') + a.quem.padEnd(13) + a.rota.padEnd(32) +
      a.status + '  A:' + (a.temA ? 'SIM' : 'não') + '  B:' + (a.temB ? 'SIM' : 'não'));
  }

  console.log('\n--- id REAL da empresa A na barra de endereço:');
  for (const a of alheios.achados) {
    const mau = a.passou || a.marca;
    if (mau) falhas++;
    console.log('  ' + (mau ? 'XX  ' : 'ok  ') + a.quem.padEnd(13) +
      a.rota.padEnd(46) + a.status + '  ' + a.oque);
  }
  const contra = alheios.contraprova < 400;
  if (!contra) falhas++;
  console.log('  contraprova (id da PRÓPRIA empresa): ' + alheios.contraprova +
    (contra ? ' — o operador alcança o que é dele' : ' — FALHOU: bloqueio por sistema quebrado, não por escopo'));

  console.log('\n=============== ' + linhas.length + ' rotas x ' + ID.length +
    ' credenciais | ' + (falhas ? falhas + ' PROBLEMA(S)' : 'nenhum problema') + ' ===============\n');
  return falhas;
}

/* ---------------------------------------------------------------- principal */

(async () => {
  let filho = null;
  try {
    console.log('preparando banco separado (' + BANCO + ')...');
    await prepararBanco();
    console.log('semeando duas empresas, quatro usuários e um token...');
    const dados = await semear();

    console.log('subindo uma cópia do gateway na porta ' + PORTA + '...');
    filho = subirGateway();
    if (!await esperarNoAr()) throw new Error('a cópia do gateway não subiu na porta ' + PORTA);

    /* Do mais fraco para o mais forte: é nessa ordem que uma rota irreversível
       é sondada, e o disparo para na primeira credencial que passar. */
    const sessoes = require(path.join(RAIZ, 'src', 'services', 'sessoes'));
    const identidades = {
      anonimo: {},
      tokenEmpresa: { 'X-API-Key': dados.tokenEmpresa },
      cliente: { Cookie: 'nfse_sessao=' +
        await sessoes.criar(dados.clienteId, { ip: '127.0.0.1', get: () => 'matriz' }) },
      operador: { Cookie: await entrar('op@matriz.teste') },
      admin: { Cookie: await entrar('admin@matriz.teste') },
      maquina: { 'X-API-Key': process.env.GATEWAY_API_KEY }
    };

    console.log('medindo...\n');
    const linhas = await matriz(identidades, dados);
    const listagens = await conteudo(identidades, dados);
    const alheios = await idsAlheios(identidades, dados);
    const falhas = relatorio(linhas, listagens, alheios);

    if (filho) filho.kill();
    await require(path.join(RAIZ, 'src', 'db')).pool.end();
    if (!MANTER) {
      const admin = new Client({ connectionString: urlBase.replace(/\/[^/]+$/, '/postgres') });
      await admin.connect();
      /* Uma rodada interrompida deixa a cópia do gateway segurando conexão, e o
     DROP falha com "está sendo acessado por outros usuários" — o que faria a
     ferramenta de conferência exigir conferência. Derruba só as conexões DESTE
     banco de teste, pelo nome; a instalação de verdade nem é mencionada. */
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [BANCO]);
  await admin.query('DROP DATABASE IF EXISTS ' + BANCO);
      await admin.end();
      console.log('banco de teste derrubado. A instalação de verdade não foi tocada.');
    } else {
      /* Com --manter, o banco fica de pé para alguém abrir o painel e olhar —
         acessibilidade, escalas do Windows, o que for. Sem a senha, que é
         sorteada a cada rodada, o banco mantido não serve para nada. */
      console.log('\nbanco ' + BANCO + ' mantido (--manter). Para abrir o painel:');
      console.log('  node src/server.js  com DATABASE_URL apontando para ' + BANCO +
        ', PORT=' + PORTA + ' e PERMITIR_PRODUCAO=false');
      console.log('  admin@matriz.teste / ' + SENHA + '   (empresas A e B)');
      console.log('  op@matriz.teste    / ' + SENHA + '   (só a empresa B)');
      console.log('\nSão credenciais de um banco descartável. Derrube com --manter ausente.');
    }
    process.exit(falhas ? 1 : 0);
  } catch (e) {
    if (filho) filho.kill();
    console.error('\nfalhou:', e.message);
    process.exit(1);
  }
})();
