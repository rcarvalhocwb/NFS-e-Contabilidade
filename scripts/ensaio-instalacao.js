#!/usr/bin/env node
/**
 * O ensaio: uma instalação inteira, do zero até a conversa do WhatsApp.
 *
 * POR QUE EXISTE. O instalador tem três modos, sete telas novas e três scripts
 * que gravam no banco. Cada peça tem teste; o que não tinha era a PERGUNTA QUE
 * IMPORTA — depois de instalar, o sistema emite? Ela só se responde percorrendo
 * o caminho inteiro, e percorrê-lo à mão exige uma máquina limpa e vinte
 * minutos. Ninguém faz isso três vezes por dia, então na prática ninguém fazia.
 *
 * O QUE ELE PROVA, nesta ordem:
 *
 *   1. as migrações sobem num banco vazio;
 *   2. os dados do escritório viram cadastro — inclusive telefone e e-mail,
 *      que o instalador não gravava e que a conversa usa;
 *   3. a primeira empresa, o primeiro serviço e o primeiro número autorizado
 *      nascem juntos;
 *   4. as palavras do robô ficam gravadas;
 *   5. o retrato que vai para o repassador leva tudo isso;
 *   6. e a conversa do WhatsApp, alimentada por esse retrato, se apresenta com
 *      o nome da casa, oferece o serviço cadastrado e chega a um pedido pronto.
 *
 * O passo 6 é o que nenhum teste de unidade alcançava: ele atravessa gateway,
 * réplica e repassador com os dados que a INSTALAÇÃO produziu, e não com os
 * dados que um teste inventou para si mesmo.
 *
 * O QUE ELE NÃO PROVA, e está dito para ninguém confundir:
 *   - não assina nota: isso exige o certificado A1 do cliente;
 *   - não fala com a Sefin: emissão de verdade tem valor fiscal;
 *   - não conecta WhatsApp nenhum: exige um celular e uma pessoa.
 *
 * SEGURANÇA. Banco descartável, com nome próprio, criado e destruído aqui. A
 * instalação de verdade não é tocada em momento nenhum — e `PERMITIR_PRODUCAO`
 * vai forçado em 'false', porque um ensaio que pudesse emitir em produção não
 * seria um ensaio.
 *
 *   node scripts/ensaio-instalacao.js
 *   node scripts/ensaio-instalacao.js --manter    (não apaga o banco no fim)
 */
require('dotenv').config();

const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const RAIZ = path.join(__dirname, '..');
const BANCO = 'nfse_ensaio';
const MANTER = process.argv.includes('--manter');

const urlBase = process.env.DATABASE_URL;
if (!urlBase) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}
const urlEnsaio = urlBase.replace(/\/[^/]+$/, '/' + BANCO);

/* Os dados que o assistente teria coletado. Um por campo que o instalador
   pergunta — se um deles parar de chegar ao banco, o ensaio acusa. */
const RESPOSTAS = {
  escritorio: {
    nome: 'Contabilidade do Ensaio',
    cnpj: '11222333000181',
    email: 'contato@ensaio.example',
    telefone: '4133332222',
    site: 'https://ensaio.example'
  },
  empresa: {
    cnpj: '11444777000161',
    razaoSocial: 'CLIENTE DO ENSAIO LTDA',
    municipio: '4106902',
    inscricaoMunicipal: '123456',
    regime: 3,
    apelido: 'Consultoria mensal',
    codigoTributacao: '010201',
    descricao: 'Consultoria tecnica mensal',
    valorPadrao: '1.500,00',
    whatsappNumero: '5541988887777'
  },
  chatbot: {
    saudacao: 'Emita sua nota por aqui, a qualquer hora.',
    atendente: 'Juliana',
    horario: 'seg a sex, 8h as 18h'
  }
};

/* ------------------------------------------------------------- relatório */

const passos = [];
let falhou = false;

function ok(o_que, detalhe) {
  passos.push({ ok: true, o_que, detalhe });
  console.log('  ✓ ' + o_que + (detalhe ? ' — ' + detalhe : ''));
}

function erro(o_que, detalhe) {
  passos.push({ ok: false, o_que, detalhe });
  falhou = true;
  console.log('  ✗ ' + o_que + (detalhe ? ' — ' + detalhe : ''));
}

function conferir(condicao, o_que, detalhe) {
  if (condicao) ok(o_que, detalhe); else erro(o_que, detalhe);
  return !!condicao;
}

function rodar(script, ambiente) {
  return execFileSync(process.execPath, [path.join(RAIZ, 'scripts', script)], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATABASE_URL: urlEnsaio,
      /* A trava que torna isto um ensaio. */
      PERMITIR_PRODUCAO: 'false',
      /* O cofre precisa de chave, e esta é descartável junto com o banco. */
      MASTER_KEY: 'e'.repeat(64)
    }, ambiente),
    encoding: 'utf8'
  });
}

/* ------------------------------------------------------ 1. banco limpo */

async function prepararBanco() {
  const admin = new Client({ connectionString: urlBase });
  await admin.connect();
  /* Derruba só as conexões DESTE banco, pelo nome. A instalação de verdade não
     é mencionada em lugar nenhum daqui. */
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [BANCO]);
  await admin.query('DROP DATABASE IF EXISTS ' + BANCO);
  await admin.query('CREATE DATABASE ' + BANCO);
  await admin.end();

  execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'migrate.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { DATABASE_URL: urlEnsaio }),
    stdio: 'ignore'
  });
  ok('as migrações sobem num banco vazio');
}

/* ------------------------------------------------ 2..4. a instalação */

function instalar() {
  rodar('configurar-escritorio.js', {
    NFSE_ESCRITORIO: JSON.stringify(RESPOSTAS.escritorio)
  });
  ok('configurar-escritorio.js rodou');

  const saidaEmpresa = rodar('primeira-empresa.js', {
    NFSE_PRIMEIRA_EMPRESA: JSON.stringify(RESPOSTAS.empresa)
  });
  const relatorio = JSON.parse(saidaEmpresa);
  ok('primeira-empresa.js rodou', relatorio.feito.length + ' etapa(s)');

  rodar('configurar-whatsapp.js', {
    NFSE_WHATSAPP: JSON.stringify(Object.assign(
      { transporte: 'local', numero: RESPOSTAS.empresa.whatsappNumero, porta: 3200 },
      RESPOSTAS.chatbot))
  });
  ok('configurar-whatsapp.js rodou');

  return relatorio;
}

/* --------------------------------------------- 5. o que ficou no banco */

async function conferirBanco() {
  const db = new Client({ connectionString: urlEnsaio });
  await db.connect();

  const ident = (await db.query(
    'SELECT nome, telefone, email, site FROM identidade LIMIT 1')).rows[0] || {};
  conferir(ident.nome === RESPOSTAS.escritorio.nome, 'o nome do escritório ficou gravado');
  /* O defeito que motivou tudo isto: os dois nasciam nulos porque o instalador
     só mandava o nome, e a conversa não tinha o que dizer a quem pedia
     atendente. */
  conferir(ident.telefone === RESPOSTAS.escritorio.telefone,
    'o telefone do escritório ficou gravado', 'o robô precisa dele para "falar com atendente"');
  conferir(ident.email === RESPOSTAS.escritorio.email, 'o e-mail do escritório ficou gravado');

  const emp = (await db.query(
    'SELECT id, razao_social, ambiente, op_simp_nac FROM empresas WHERE cnpj = $1',
    [RESPOSTAS.empresa.cnpj])).rows[0];
  conferir(!!emp, 'a primeira empresa foi cadastrada');
  conferir(emp && emp.ambiente === 'homologacao',
    'a empresa nasce em homologação', 'produção é decisão de gente, depois de uma nota de teste');
  /* O regime é de CADA empresa: a contabilidade atende enquadramentos
     diferentes, e ele decide PARA ONDE a nota vai. Se o campo parar de chegar
     do assistente ao banco, a nota de um ME do Simples iria para o município
     em vez do Emissor Nacional -- e isso não aparece em erro nenhum. */
  conferir(emp && emp.op_simp_nac === 3, 'o regime escolhido chegou ao cadastro',
    'respondeu ' + (emp && emp.op_simp_nac));

  const numeracao = (await db.query(
    'SELECT count(*)::int AS n FROM numeracao_dps WHERE empresa_id = $1',
    [emp ? emp.id : -1])).rows[0].n;
  conferir(numeracao === 2, 'a numeração dos dois ambientes nasceu junto');

  const servicos = (await db.query(
    'SELECT apelido, codigo_tributacao, valor_padrao FROM servicos WHERE empresa_id = $1',
    [emp ? emp.id : -1])).rows;
  conferir(servicos.length === 1, 'o primeiro serviço foi cadastrado',
    'sem ele o WhatsApp responde "fale com o escritório" e encerra');
  conferir(servicos[0] && Number(servicos[0].valor_padrao) === 1500,
    'o valor com vírgula virou número', '1.500,00 → 1500');

  const contatos = (await db.query(
    'SELECT telefone FROM contatos_whatsapp WHERE empresa_id = $1',
    [emp ? emp.id : -1])).rows;
  conferir(contatos.length === 1, 'o número autorizado foi cadastrado',
    'sem ele ninguém consegue pedir nota');

  const bot = (await db.query(
    'SELECT saudacao, atendente, horario FROM chatbot WHERE id = TRUE')).rows[0] || {};
  conferir(bot.saudacao === RESPOSTAS.chatbot.saudacao, 'a saudação escolhida ficou gravada');
  conferir(bot.atendente === RESPOSTAS.chatbot.atendente, 'o nome do atendente ficou gravado');

  /* Por onde a mensagem sai, conferido pelo SERVIÇO e não pela coluna.
     Ler a coluna direto daqui provaria só que o UPDATE rodou. Quem responde ao
     painel é `situacao()`, e era ela que mentia: a consulta usava `id = 1` numa
     coluna boolean, o erro era engolido e o padrão 'meta' saía como se fosse
     resposta. O painel jurava Meta com a sessão própria escolhida. */
  const whats = require(path.join(RAIZ, 'src', 'services', 'whatsappLocal'));
  const s = await whats.situacao();
  conferir(s.transporte === 'local', 'o serviço confirma o transporte escolhido',
    'respondeu "' + s.transporte + '"');
  conferir(s.porta === 3200, 'e a porta do módulo escolhida na instalação');
  conferir(!s.termo, 'o termo NÃO foi aceito pelo instalador',
    'aceite é ato de leitura, feito por uma pessoa no módulo');

  await db.end();
}

/* -------------------------------------- 6. a conversa, com esses dados */

async function conferirConversa() {
  /* O retrato é montado pelo MESMO código que o gateway usa para alimentar o
     repassador. Montar um à mão aqui provaria que a conversa funciona com dados
     inventados — que não é a pergunta. */
  const replica = require(path.join(RAIZ, 'src', 'services', 'replicaCadastro'));
  const retrato = await replica.montar();

  conferir(retrato.escritorio && retrato.escritorio.telefone === RESPOSTAS.escritorio.telefone,
    'o telefone viaja no retrato para o repassador');
  conferir(retrato.chatbot && retrato.chatbot.atendente === RESPOSTAS.chatbot.atendente,
    'as palavras do robô viajam no retrato');
  conferir(Array.isArray(retrato.servicos) && retrato.servicos.length === 1,
    'o serviço viaja no retrato');

  const { Memoria } = require(path.join(RAIZ, 'relay', 'memoria'));
  const conversa = require(path.join(RAIZ, 'relay', 'conversa'));

  const m = new Memoria(path.join(require('os').tmpdir(), 'ensaio-' + Date.now() + '.json'));
  m.dados.cadastro = retrato;
  m.salvar = () => {};

  const tel = RESPOSTAS.empresa.whatsappNumero;
  const vinculos = m.empresasDe(tel);
  conferir(vinculos.length === 1, 'o número autorizado alcança a empresa');

  /* A conversa que volta para `responder` é o OBJETO inteiro, não só o nome do
     estado: é em `dados.opcoes` que está o que "1" e "2" significam naquela
     tela. Passando só o estado, toda resposta numérica cai em "não entendi" e o
     menu se repete — que foi exatamente o que aconteceu na primeira versão
     deste ensaio, e parecia defeito do produto. É o mesmo encadeamento que o
     `servidor.js` faz ao gravar e devolver a conversa. */
  /* A consulta pública entra por injeção, e aqui ela é falsa de propósito: o
     ensaio precisa rodar numa máquina sem internet e dar sempre o mesmo
     resultado. Depender da Receita faria o ensaio falhar por motivo alheio ao
     que ele mede. */
  const buscaFalsa = async doc => ({
    documento: doc, nome: 'CLIENTE DA BASE PUBLICA LTDA', situacao: 'ATIVA',
    logradouro: 'RUA TESTE', numero: '100', bairro: 'CENTRO',
    cep: '80010000', uf: 'PR', municipio: 'CURITIBA', codigoMunicipio: '4106902'
  });

  const diga = (texto, anterior) => conversa.responder({
    texto, telefone: tel, vinculos, conversa: anterior, memoria: m,
    buscarCnpj: buscaFalsa
  });

  const seguir = s => (s.estado
    ? { estado: s.estado, dados: s.dados, em: new Date().toISOString() }
    : null);

  const oi = await diga('oi', null);
  conferir(oi.resposta.includes(RESPOSTAS.escritorio.nome),
    'a conversa se apresenta com o nome da casa');
  conferir(oi.resposta.includes(RESPOSTAS.chatbot.saudacao),
    'e com a saudação que o escritório escolheu');
  conferir(oi.resposta.includes('CLIENTE DO ENSAIO'),
    'e diz por qual empresa a nota sairia');

  const humano = await diga('atendente', null);
  conferir(humano.resposta.includes(RESPOSTAS.chatbot.atendente),
    'quem pede atendente recebe um nome');
  conferir(humano.resposta.includes('3333'),
    'e o telefone de verdade', 'era aqui que saía "procure pelos canais de sempre"');

  /* O caminho que leva a uma nota. Sem pedido anterior o menu oferece uma
     opção só — "Emitir uma nota" — porque "Outra nota" herdaria o cliente de
     um pedido que não existe, e terminaria em "faltam dados" três mensagens
     depois. */
  const doc = await diga('1', seguir(oi));
  conferir(/CNPJ|CPF|documento/i.test(doc.resposta),
    'a conversa pede o documento do cliente');

  const achou = await diga('11444777000161', seguir(doc));
  conferir(achou.resposta.length > 0, 'e aceita um CNPJ');

  /* Pode haver uma confirmação de razão social antes do serviço. */
  let passo = achou;
  if (/Responda *1*|est(a|á) certo/i.test(passo.resposta)) {
    passo = await diga('1', seguir(passo));
  }
  conferir(passo.resposta.includes(RESPOSTAS.empresa.apelido) ||
           /servi(c|ç)o/i.test(passo.resposta),
    'e chega ao serviço cadastrado',
    'com servicos: 0 aqui sairia "fale com o escritório" e encerraria');

  const valor = await diga('1', seguir(passo));
  conferir(/valor/i.test(valor.resposta), 'e avança para o valor da nota');
}

/* ------------------------------------------------------------- execução */

async function limpar() {
  /* O passo 6 carregou `src/db`, que abre um pool e o mantém aberto. Derrubar o
     banco por baixo dele faz o pg emitir um 'error' sem ouvinte, e o Node
     derruba o processo — o ensaio terminava com pilha de erro DEPOIS de todas
     as conferências passarem, que é a forma mais eficiente de fazer alguém
     desconfiar de um resultado correto. */
  try {
    const db = require(path.join(RAIZ, 'src', 'db'));
    if (db.pool && !db.pool.ended) await db.pool.end();
  } catch (_) { /* não foi carregado: nada a fechar */ }

  if (MANTER) {
    console.log('\n  banco mantido: ' + BANCO + ' (--manter)');
    return;
  }
  const admin = new Client({ connectionString: urlBase });
  await admin.connect();
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [BANCO]);
  await admin.query('DROP DATABASE IF EXISTS ' + BANCO);
  await admin.end();
}

async function principal() {
  console.log('\nEnsaio de instalação — banco descartável "' + BANCO + '"\n');

  /* ANTES de qualquer `require` de src/: `src/db` monta o pool na primeira vez
     que é carregado, lendo esta variável naquele instante. Definindo-a só no
     passo 6, um serviço exigido no passo 5 já teria aberto conexão com o banco
     de PRODUÇÃO — e foi o que aconteceu enquanto este ensaio era escrito: a
     conferência de transporte leu a configuração da instalação de verdade e
     respondeu "meta" com toda a convicção. Leitura apenas, mas a instalação de
     produção não pode ser tocada nem para ler.
     Também é o que torna `PERMITIR_PRODUCAO=false` mais que decoração: ele vale
     para o processo inteiro, e não só para os filhos. */
  process.env.DATABASE_URL = urlEnsaio;
  process.env.PERMITIR_PRODUCAO = 'false';
  process.env.MASTER_KEY = 'e'.repeat(64);

  console.log('1. banco limpo');
  await prepararBanco();

  console.log('\n2. a instalação, como o assistente a faria');
  const relatorio = instalar();

  console.log('\n3. o que ficou no banco');
  await conferirBanco();

  console.log('\n4. a conversa do WhatsApp com esses dados');
  await conferirConversa();

  if (relatorio.pendencias.length) {
    console.log('\n5. pendências que a instalação REPORTOU (esperado, não é falha)');
    for (const p of relatorio.pendencias) console.log('  · ' + p.item + ': ' + p.motivo);
  }

  await limpar();

  const bons = passos.filter(p => p.ok).length;
  console.log('\n' + (falhou ? 'FALHOU' : 'OK') + ': ' + bons + '/' + passos.length +
    ' conferências.\n');

  if (!falhou) {
    console.log('O sistema sai da instalação cadastrado e conversando. Falta, e');
    console.log('depende de gente: o certificado A1, e conectar o WhatsApp.\n');
  }

  process.exit(falhou ? 1 : 0);
}

principal().catch(async e => {
  console.error('\nensaio interrompido: ' + e.message);
  try { await limpar(); } catch (_) { /* o banco fica; --manter explica onde */ }
  process.exit(1);
});
