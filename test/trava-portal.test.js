const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A trava que segura o cliente até a parametrização estar pronta.
 *
 * Nota emitida com código de tributação errado sai VÁLIDA — a Sefin aceita, o
 * imposto é apurado, e desfazer exige cancelamento dentro do prazo. Por isso a
 * empresa nasce bloqueada no portal: o cliente só emite depois de o contador
 * conferir código, alíquota e a lista de serviços.
 *
 * E a trava é conferida no gateway, não no portal. O portal pode esconder o
 * botão, mas quem responde pela nota é este lado.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', ...partes), 'utf8');
}
function migracao(nome) {
  return fs.readFileSync(path.join(__dirname, '..', 'migrations', nome), 'utf8');
}

test('a empresa nasce bloqueada no portal', () => {
  const sql = migracao('024_modo_emissao.sql');
  assert.match(sql, /portal_liberado\s+boolean NOT NULL DEFAULT FALSE/,
    'liberar tem de ser ato do contador, não o padrão');
});

test('o modo de emissão é um dos dois, e só um', () => {
  /* Quem guarda o certificado e quem distribui a numeração têm de ser o mesmo
     lugar: dois emissores para o mesmo CNPJ produzem número repetido. */
  const sql = migracao('024_modo_emissao.sql');
  assert.match(sql, /modo_emissao varchar\(10\) NOT NULL DEFAULT 'gateway'/);
  assert.match(sql, /CHECK \(modo_emissao IN \('gateway', 'portal'\)\)/);
});

test('a solicitação de empresa bloqueada é recusada na chegada', () => {
  const servico = fonte('services', 'ponteNuvem.js');
  const i = servico.indexOf('async function guardar');
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.match(corpo, /portal_liberado/,
    'a trava precisa ser lida junto com a empresa');
  assert.match(corpo, /!e\.portal_liberado/);
  assert.match(corpo, /situacao = 'recusada'/,
    'recusada, e não aguardando: não pode ficar na fila para alguém aprovar sem ver');
});

test('a recusa por bloqueio sempre tem motivo escrito', () => {
  /* Motivo em branco vira "bloqueado" sem explicação na tela do cliente — a
     queixa que mais aparece nas reclamações de contabilidade. */
  const servico = fonte('services', 'ponteNuvem.js');
  const i = servico.indexOf('async function guardar');
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.match(corpo, /portal_motivo \|\|/,
    'sem motivo salvo, entra um texto padrão');
  assert.match(corpo, /ainda não liberou/);
});

test('liberar o portal é rota própria e vai para a auditoria', () => {
  /* Não sai de carona no PUT de cadastro: muda o que o cliente consegue fazer
     lá fora, como a troca de ambiente. */
  const rotas = fonte('routes', 'empresas.js');
  assert.match(rotas, /router\.put\('\/:cnpj\/portal',\s*somenteAdmin,\s*exigirEmpresaVisivel/);
  const i = rotas.indexOf("'/:cnpj/portal'");
  const corpo = rotas.slice(i, rotas.indexOf('\n});', i));
  assert.match(corpo, /auditoria\.registrar/);
  assert.ok(!/portal_liberado/.test(rotas.slice(rotas.indexOf('UPDATE empresas SET'),
    rotas.indexOf("'/:cnpj/portal'"))),
    'o PUT de cadastro não pode tocar na trava');
});

test('o modo "portal" é recusado enquanto o portal não existe', () => {
  /* Trocar o lado que emite move junto a numeração e o certificado. Aceitar o
     campo antes disso deixaria a empresa sem emissor nenhum. */
  const rotas = fonte('routes', 'empresas.js');
  const i = rotas.indexOf("'/:cnpj/portal'");
  const corpo = rotas.slice(i, rotas.indexOf('\n});', i));
  assert.match(corpo, /modoEmissao === 'portal'/);
  assert.match(corpo, /status\(422\)/);
});
