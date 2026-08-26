const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A ponte entre o portal do cliente e o gateway do escritório.
 *
 * O portal fica na internet e recebe pedidos de nota; o gateway roda na
 * máquina da contabilidade, com os certificados A1 e as notas de todos os
 * clientes. Duas decisões sustentam a ligação, e as duas são testadas aqui:
 *
 *   1. QUEM PROCURA É O GATEWAY. Se o portal alcançasse esta máquina, o
 *      escritório precisaria abrir uma porta no roteador — expondo justamente
 *      o computador que guarda os certificados.
 *   2. A EMPRESA VEM DO ID JÁ RESOLVIDO, não do payload. É a mesma regra do
 *      certificado, e é o que impede um pedido vindo da web de sair na
 *      empresa errada.
 */

const ponte = require('../src/services/ponteNuvem');

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', ...partes), 'utf8');
}

/* ------------------------------------------------------ endereço do portal */

test('recusa endereço que não seja https', () => {
  assert.throws(() => ponte.validarUrl('http://portal.exemplo.com.br'),
    /https/, 'CNPJ, valores e serviço não trafegam em claro');
});

test('recusa endereço da rede interna', () => {
  /* A URL é digitada por quem configura. Sem esta trava, um endereço interno
     transformaria o gateway num scanner da rede da contabilidade — e o
     169.254.169.254 alcançaria os metadados de qualquer nuvem. */
  for (const alvo of ['https://localhost/api', 'https://127.0.0.1/api',
                      'https://10.0.0.5/api', 'https://192.168.1.10/api',
                      'https://172.20.3.4/api', 'https://169.254.169.254/latest',
                      'https://roteador.localhost/api']) {
    assert.throws(() => ponte.validarUrl(alvo), /interna/,
      alvo + ' deveria ser recusado');
  }
});

test('aceita um portal de verdade e tira a barra do fim', () => {
  assert.equal(ponte.validarUrl('https://portal.exemplo.com.br/api/'),
    'https://portal.exemplo.com.br/api');
});

test('recusa texto que não é endereço', () => {
  assert.throws(() => ponte.validarUrl('portal.exemplo.com.br'), /https/);
  assert.throws(() => ponte.validarUrl(''), /inválido|https/);
});

/* --------------------------------------------------- direção da conexão */

test('o gateway busca; não existe rota que o portal chame', () => {
  /* Se um dia alguém acrescentar um endpoint público para o portal empurrar
     solicitações, este teste cai — e é para cair. A máquina que guarda os
     certificados não recebe conexão de fora. */
  const servico = fonte('services', 'ponteNuvem.js');
  assert.match(servico, /fetch\(/, 'a ponte precisa ser quem chama');
  const rotas = fonte('routes', 'ponte.js');
  assert.ok(!/router\.(post|put)\('\/(receber|entrada|webhook|push)/.test(rotas),
    'nenhuma rota de entrada para o portal');
});

test('a chamada ao portal não segue redirecionamento', () => {
  /* Seguir um redirecionamento levaria o Bearer da instalação para um
     endereço que ninguém configurou. */
  const servico = fonte('services', 'ponteNuvem.js');
  assert.match(servico, /redirect:\s*'error'/);
});

test('a chamada ao portal tem prazo', () => {
  const servico = fonte('services', 'ponteNuvem.js');
  assert.match(servico, /AbortController/);
  assert.match(servico, /signal:\s*controle\.signal/);
});

/* ------------------------------------------------- isolamento das empresas */

test('a emissão usa o CNPJ da empresa resolvida, não o do payload', () => {
  /* O empresa_id foi determinado quando a solicitação chegou, e é o que o
     contador viu na tela ao aprovar. Reler o CNPJ do payload aqui faria a
     nota sair numa empresa diferente da que foi aprovada. */
  const servico = fonte('services', 'ponteNuvem.js');
  const i = servico.indexOf('async function emitirSolicitacao');
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.match(corpo, /FROM empresas WHERE id = \$1/,
    'a empresa precisa ser relida pelo id');
  assert.match(corpo, /emitir\(emp\.rows\[0\]\.cnpj/,
    'o CNPJ da emissão sai da empresa lida do banco');
  assert.ok(!/emitir\(\s*(payload|dados)\.cnpjEmpresa/.test(corpo),
    'nada do payload pode escolher a empresa');
});

test('o portal não escolhe numeração nem substituição', () => {
  /* numero/serie posicionariam a nota na sequência fiscal da empresa;
     substituicao cancelaria um documento que já existe. */
  const servico = fonte('services', 'ponteNuvem.js');
  const lista = servico.match(/const CAMPOS_DO_PORTAL = \[([^\]]+)\]/);
  assert.ok(lista, 'a lista fechada de campos precisa existir');
  for (const proibido of ['numero', 'serie', 'substituicao', 'referencia', 'cnpjEmpresa']) {
    assert.ok(!new RegExp("'" + proibido + "'").test(lista[1]),
      proibido + ' não pode vir do portal');
  }
});

test('a fila respeita o escopo de quem está olhando', () => {
  const rotas = fonte('routes', 'ponte.js');
  assert.match(rotas, /empresasVisiveis\(req\)/,
    'a listagem filtra pelas empresas do operador');
  const aprovar = rotas.slice(rotas.indexOf("'/solicitacoes/:id/aprovar'"));
  const corpo = aprovar.slice(0, aprovar.indexOf('\n});'));
  assert.match(corpo, /empresaVisivel\(req, s\.empresa_id\)/);
  assert.match(corpo, /status\(404\)/,
    'quem não tem acesso não distingue "não existe" de "não é seu"');
});

test('só administrador mexe na ligação', () => {
  const rotas = fonte('routes', 'ponte.js');
  for (const rota of ["'/config'", "'/sincronizar'"]) {
    const i = rotas.indexOf(rota);
    assert.ok(i > 0, rota + ' não encontrada');
    const linha = rotas.slice(i, rotas.indexOf('\n', i));
    assert.match(linha, /somenteAdmin/, rota + ' precisa exigir administrador');
  }
});

/* ------------------------------------------------------------ idempotência */

test('a mesma solicitação não vira duas notas', () => {
  /* Duas travas em série: o id do portal é UNIQUE na tabela, então uma
     reentrega não cria linha nova; e a referência da nota é derivada desse
     id, então mesmo que a linha fosse recriada a emissão devolveria a nota
     que já existe em vez de emitir outra. */
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '023_ponte_nuvem.sql'), 'utf8');
  assert.match(sql, /id_externo\s+varchar\(80\)\s+NOT NULL UNIQUE/);

  const servico = fonte('services', 'ponteNuvem.js');
  assert.match(servico, /ON CONFLICT \(id_externo\) DO NOTHING/);
  assert.match(servico, /referencia:\s*'portal-' \+ solicitacao\.id_externo/);
});

/* -------------------------------------------------------- padrão de fábrica */

test('a emissão automática vem desligada', () => {
  /* Nota fiscal emitida sem ninguém olhar, a partir de um pedido que veio da
     internet, é decisão que o escritório toma de propósito. */
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '023_ponte_nuvem.sql'), 'utf8');
  assert.match(sql, /emitir_automatico boolean\s+NOT NULL DEFAULT FALSE/);
  assert.match(sql, /ativo\s+boolean\s+NOT NULL DEFAULT FALSE/);
});

test('a chave do portal é guardada cifrada', () => {
  const servico = fonte('services', 'ponteNuvem.js');
  assert.match(servico, /encrypt\(String\(dados\.chave\)\)/);
  // e nunca volta pela API: o GET só informa se existe
  const i = servico.indexOf('async function ler');
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.ok(!/chave_cifrada,/.test(corpo.replace(/\(chave_cifrada IS NOT NULL\)/, '')),
    'a chave não pode sair na leitura da configuração');
  assert.match(corpo, /chave_cifrada IS NOT NULL\) AS tem_chave/);
});
