const test = require('node:test');
const assert = require('node:assert');

/* Rate-limit do login em duas camadas.
 *
 * Por IP+e-mail freia força bruta contra UMA conta. Mas pulverização — uma
 * senha comum tentada contra muitos e-mails do mesmo IP — deixa cada balde
 * (IP,e-mail) com uma tentativa só, e nenhum chega ao limite de 8. Por isso
 * existe o segundo contador, por IP, que conta o total de falhas do endereço
 * e trava mais alto (50 em 15 min). */

function fresh() {
  delete require.cache[require.resolve('../src/middleware/protecao')];
  return require('../src/middleware/protecao');
}
const req = (ip, email) => ({ ip, body: { email }, get: () => '' });
const res = () => ({ statusCode: 200, status(c){this.statusCode=c;return this;}, json(){return this;} });

function tentativaFalha(p, ip, email) {
  const q = req(ip, email), s = res();
  let passou = false;
  p.limitarLogin(q, s, () => { passou = true; });
  if (passou) p.registrarFalhaLogin(q);
  return passou;
}

test('força bruta contra UMA conta trava em 8 tentativas', () => {
  const p = fresh();
  let passaram = 0;
  for (let i = 0; i < 12; i++) if (tentativaFalha(p, '203.0.113.1', 'vitima@x.test')) passaram++;
  assert.equal(passaram, 8, 'devia deixar passar 8 e travar o balde do e-mail');
});

test('pulverização (muitos e-mails, um IP) trava pelo teto do IP', () => {
  const p = fresh();
  let passaram = 0;
  for (let i = 0; i < 60; i++) if (tentativaFalha(p, '203.0.113.2', `alvo${i}@x.test`)) passaram++;
  assert.equal(passaram, 50, 'o teto por IP devia cortar em 50, não deixar as 60 passarem');
});

test('IP legítimo diferente não é atingido pelo varredor de outro IP', () => {
  const p = fresh();
  for (let i = 0; i < 60; i++) tentativaFalha(p, '203.0.113.3', `alvo${i}@x.test`);
  const q = req('198.51.100.9', 'gerente@x.test'), s = res();
  let passou = false;
  p.limitarLogin(q, s, () => { passou = true; });
  assert.ok(passou, 'quem vem de outro IP não pode herdar o bloqueio do varredor');
});

test('acerto limpa o balde do e-mail mas não o teto do IP', () => {
  const p = fresh();
  // 49 falhas pulverizadas + 1 acerto no meio não zeram o contador de IP
  for (let i = 0; i < 49; i++) tentativaFalha(p, '203.0.113.4', `alvo${i}@x.test`);
  p.limparFalhasLogin(req('203.0.113.4', 'alvo0@x.test')); // "acertou" uma conta
  // a 50ª e 51ª falhas de qualquer e-mail ainda contam para o IP
  tentativaFalha(p, '203.0.113.4', 'novo@x.test'); // 50ª -> trava
  const q = req('203.0.113.4', 'outro@x.test'), s = res();
  let passou = false;
  p.limitarLogin(q, s, () => { passou = true; });
  assert.ok(!passou, 'o teto do IP não pode ser zerado por um acerto no meio da varredura');
});
