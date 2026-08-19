const test = require('node:test');
const assert = require('node:assert');
const { compararVersoes, extrairSha256, resumir } = require('../src/services/atualizacao');

/* Verificação de novas versões.
 *
 * A comparação de versões decide se aparece ou não o aviso de atualização na
 * tela da contabilidade. Errar para menos esconde uma correção fiscal; errar
 * para mais avisa de uma versão que não existe. */

test('compara versões parte a parte, não como texto', () => {
  // "1.10.0" < "1.9.0" em ordem alfabética, e é justamente ao contrário
  assert.ok(compararVersoes('1.10.0', '1.9.0') > 0);
  assert.ok(compararVersoes('2.0.0', '1.99.99') > 0);
  assert.ok(compararVersoes('1.2.0', '1.2.1') < 0);
  assert.equal(compararVersoes('1.2.3', '1.2.3'), 0);
});

test('o prefixo v das tags do git não atrapalha', () => {
  assert.equal(compararVersoes('v1.2.0', '1.2.0'), 0);
  assert.ok(compararVersoes('v1.3.0', 'v1.2.9') > 0);
});

test('versões com número de partes diferente', () => {
  assert.equal(compararVersoes('1.2', '1.2.0'), 0);
  assert.ok(compararVersoes('1.2.1', '1.2') > 0);
});

test('entrada ausente não quebra a comparação', () => {
  // Banco novo: nunca verificou, versao_disponivel é NULL
  assert.ok(compararVersoes(null, '1.0.0') < 0);
  assert.ok(compararVersoes('1.0.0', undefined) > 0);
});

/* O checksum é o que separa "instalar a atualização do autor" de "executar
   como administrador um arquivo qualquer que veio pela rede". */
test('lê o SHA-256 publicado nas notas da release', () => {
  const sha = 'a'.repeat(64);
  assert.equal(extrairSha256(`Correções diversas.\n\nSHA-256: ${sha}\n`), sha);
  assert.equal(extrairSha256(`SHA256=${sha}`), sha);
  assert.equal(extrairSha256('sha-256: `' + sha + '`'), sha);
});

test('não confunde outras somas com SHA-256', () => {
  assert.equal(extrairSha256('MD5: ' + 'b'.repeat(32)), null);
  assert.equal(extrairSha256('Sem soma nenhuma aqui'), null);
  assert.equal(extrairSha256(null), null);
  // Comprimento errado não é SHA-256
  assert.equal(extrairSha256('SHA-256: ' + 'c'.repeat(63)), null);
});

test('devolve o hash em minúsculas para comparar sem surpresa', () => {
  assert.equal(extrairSha256('SHA-256: ' + 'A'.repeat(64)), 'a'.repeat(64));
});

/* resumir() é o que a tela recebe. A regra: só é atualização se for MAIOR que
   a instalada — reinstalar a mesma versão, ou voltar para uma anterior, não é
   coisa que o gateway deva sugerir sozinho. */
const { versaoAtual } = require('../src/services/atualizacao');

test('versão igual à instalada não é atualização', () => {
  const r = resumir({ versao_disponivel: versaoAtual });
  assert.equal(r.temAtualizacao, false);
});

test('versão mais nova é atualização', () => {
  const r = resumir({ versao_disponivel: '99.0.0', notas: 'Corrige o E0712' });
  assert.equal(r.temAtualizacao, true);
  assert.equal(r.versaoAtual, versaoAtual);
  assert.match(r.notas, /E0712/);
});

test('versão mais antiga no repositório não vira aviso', () => {
  // Acontece ao despublicar uma release: a "última" passa a ser anterior
  assert.equal(resumir({ versao_disponivel: '0.0.1' }).temAtualizacao, false);
});

test('dispensar silencia o aviso sem esconder a versão', () => {
  const r = resumir({ versao_disponivel: '99.0.0', dispensada: '99.0.0' });
  assert.equal(r.temAtualizacao, true, 'a atualização continua existindo');
  assert.equal(r.dispensada, true, 'mas a tela não deve insistir');
});

test('dispensar uma versão não silencia a seguinte', () => {
  const r = resumir({ versao_disponivel: '99.1.0', dispensada: '99.0.0' });
  assert.equal(r.dispensada, false);
});

test('banco sem verificação alguma responde sem erro', () => {
  const r = resumir({});
  assert.equal(r.temAtualizacao, false);
  assert.equal(r.versaoDisponivel, null);
  assert.equal(r.versaoAtual, versaoAtual);
});

test('falha de rede aparece no resumo, sem virar exceção', () => {
  // Não saber a versão nova não pode impedir de emitir nota
  const r = resumir({ erro: 'getaddrinfo ENOTFOUND api.github.com', erro_em: new Date() });
  assert.match(r.erro, /ENOTFOUND/);
  assert.equal(r.temAtualizacao, false);
});
