const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O monitor: programa separado, com ícone próprio.
 *
 * A razão de existir é uma só, e é ela que estes testes protegem: um monitor
 * que morre junto com o que ele monitora não serve para nada. É justamente
 * quando o gateway cai que alguém quer olhar — e é nessa hora que ele precisa
 * estar de pé para dizer o que houve e para religar.
 *
 * Daí decorrem as travas: ele não pode depender do gateway, não pode ficar sem
 * senha (ele desliga a emissão do escritório), e não pode atender a rede.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVIDOR = fonte('monitor', 'servidor.js');
const TELA = fonte('monitor', 'monitor.js');
const BAT = fonte('Monitor.bat');

/* ------------------------------------------ não depender do que ele observa */

test('o monitor lê o banco e o log direto, não o gateway', () => {
  /* Perguntar ao gateway seria inútil na única hora que importa. */
  assert.match(SERVIDOR, /require\(path\.join\(RAIZ, 'src', 'db'\)\)/);
  assert.match(SERVIDOR, /function novasLinhas/);
  /* Do gateway ele só quer saber uma coisa: se está vivo. */
  const usos = SERVIDOR.match(/GATEWAY \+ '[^']*'/g) || [];
  assert.deepStrictEqual(usos, ["GATEWAY + '/health'"],
    'o monitor não deve buscar dado no gateway, só o pulso');
});

test('sem banco, o monitor ainda sobe', () => {
  /* Se o Postgres estiver fora, o monitor é quem vai dizer isso. Cair junto
     seria o pior momento possível para cair. */
  assert.match(SERVIDOR, /catch \(_\) \{ \/\* sem banco: o resto ainda serve \*\/ \}/);
  assert.match(SERVIDOR, /if \(!db\) return null;/);
});

test('a tela fala com o monitor, nunca com o gateway', () => {
  /* "3000" sozinho casava com um setTimeout(…, 3000). O que importa é o ALVO
     das requisições: todas relativas ao próprio monitor. */
  const alvos = TELA.match(/(?:fetch|EventSource)\(\s*'[^']*'/g) || [];
  assert.ok(alvos.length >= 2, 'esperava as chamadas do monitor');
  alvos.forEach(a => assert.match(a, /\('\//,
    'toda requisição da tela é relativa ao monitor, nunca ao gateway: ' + a));
  assert.ok(!/https?:\/\/[^']*3000/.test(TELA), 'a tela não pode apontar para o gateway');
});

/* ------------------------------------------------------------- o acesso */

test('atende só em 127.0.0.1', () => {
  /* Ele liga e desliga a emissão do escritório. Não há motivo para outra
     máquina da rede alcançá-lo. */
  assert.match(SERVIDOR, /servidor\.listen\(PORTA, '127\.0\.0\.1'/);
});

test('exige token, e o token é sorteado a cada subida', () => {
  assert.match(SERVIDOR, /crypto\.randomBytes\(24\)/);
  assert.match(SERVIDOR, /function autorizado/);
  assert.match(SERVIDOR, /if \(!autorizado\(u\)\)/,
    'a conferência vem antes de qualquer rota');
  /* A conferência precisa estar ANTES do tratamento das rotas, senão alguma
     escapa. */
  const guarda = SERVIDOR.indexOf('if (!autorizado(u))');
  const primeiraRota = SERVIDOR.indexOf("u.pathname === '/'");
  assert.ok(guarda > 0 && guarda < primeiraRota);
});

test('o token chega às requisições da própria página', () => {
  /* Sem isto o <script> voltaria 403 e a tela ficaria em branco — falha que
     só aparece no navegador, nunca no teste de rota. */
  const html = fonte('monitor', 'monitor.html');
  assert.match(html, /monitor\.js\?t=__TOKEN__/);
  assert.match(SERVIDOR, /split\('__TOKEN__'\)\.join\(TOKEN\)/);
  assert.match(TELA, /URLSearchParams\(location\.search\)\.get\('t'\)/);
});

/* -------------------------------------------------------------- as ações */

test('ligar e desligar exige privilégio, e explica quando não tem', () => {
  const i = SERVIDOR.indexOf('async function acao');
  const corpo = SERVIDOR.slice(i, SERVIDOR.indexOf('\n}', i));
  assert.match(corpo, /net.*session/s);
  assert.match(corpo, /ícone "Monitor do gateway"/);
});

test('parar avisa o que para junto', () => {
  /* "Parado" não diz nada. "Nenhuma nota é emitida e o WhatsApp não responde"
     diz. */
  assert.match(SERVIDOR, /nenhuma nota é emitida e o WhatsApp não responde/);
  assert.match(TELA, /nenhuma nota é emitida e o WhatsApp não responde a ninguém/);
});

/* ---------------------------------------------------- o icone e o navegador */

test('o .bat eleva o monitor mas abre o navegador sem elevação', () => {
  /* Elevar e o monitor precisa, para mexer na tarefa. Navegar como
     administrador por causa de um painel local, nao. O explorer.exe roda com a
     conta normal e resolve isso. */
  assert.match(BAT, /Verb RunAs/, 'o monitor sobe elevado');
  assert.match(BAT, /explorer\.exe "http:\/\/127\.0\.0\.1:3100/,
    'o navegador abre com a conta normal');
});

test('o .bat espera a porta antes de abrir o navegador', () => {
  /* Abrir antes mostraria "nao foi possivel acessar" e a pessoa acharia que
     quebrou. */
  assert.match(BAT, /TcpClient\('127\.0\.0\.1',3100\)/);
  assert.match(BAT, /if not defined PRONTO/);
});

test('abrir duas vezes não quebra', () => {
  /* Segunda porta ocupada nao pode virar erro na cara de quem clicou. */
  assert.match(SERVIDOR, /EADDRINUSE/);
  assert.match(SERVIDOR, /já estava aberto/);
  /* E o token valido passa a ser o que o monitor de antes gravou. */
  assert.match(SERVIDOR, /ARQUIVO_SESSAO/);
  assert.match(BAT, /sessao\.txt/);
});

test('o instalador leva o monitor e cria o icone', () => {
  const iss = fonte('instalador', 'nfse-gateway.iss');
  assert.match(iss, /Monitor do gateway"; Filename: "\{app\}\\Monitor\.bat"/);

  const pacote = fonte('instalador', 'preparar-pacote.ps1');
  assert.match(pacote, /'monitor'/);
  assert.match(pacote, /'Monitor\.bat'/);
  assert.match(pacote, /monitor\\sessao\.txt/,
    'o token de uma instalação não pode viajar dentro do pacote');
});

test('o token de sessão não vai para o repositório', () => {
  const ignore = fonte('.gitignore');
  assert.match(ignore, /monitor\/sessao\.txt/);
});
