const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A réplica do cadastro para o portal.
 *
 * O escritório é a fonte de verdade: empresas, serviços e quem acessa cada CNPJ
 * são escritos no gateway. O portal recebe um retrato e não escreve de volta.
 *
 * Duas coisas precisam estar certas, e nenhuma é opcional: o retrato não pode
 * levar segredo nenhum, e uma pessoa do cliente não pode acabar enxergando
 * empresa que não é dela.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', ...partes), 'utf8');
}

test('o retrato não leva certificado nem senha de ninguém', () => {
  /* O portal precisa saber quem entra e o que a pessoa vê. O segredo que prova
     a identidade dela é dele, definido lá pelo convite — assim uma invasão do
     portal não expõe credencial do escritório.

     UMA EXCEÇÃO, e só uma: o token de envio da Meta. Ele não é segredo do
     escritório nem de cliente nenhum — é a credencial do próprio canal, e o
     repassador não consegue mandar uma única mensagem sem ela. Guardá-la só no
     .env significaria o contador entrar num servidor por SSH para configurar o
     WhatsApp, que é o oposto do que este sistema faz. Quem invadir o
     repassador teria essa credencial de todo jeito, porque ela mora lá para
     funcionar. */
  const servico = fonte('services', 'replicaCadastro.js');
  const i = servico.indexOf('async function montar');
  const corpo = servico.slice(i, servico.indexOf('\nasync function enviar', i));

  for (const proibido of ['pfx_cifrado', 'senha_cifrada', 'senha_hash',
                          'chave_cifrada', 'certificado']) {
    assert.ok(!new RegExp(proibido, 'i').test(corpo),
      proibido + ' não pode entrar na consulta do retrato');
  }
  assert.ok(!/FROM certificados/i.test(corpo) && !/FROM empresa_tokens/i.test(corpo),
    'as tabelas de segredo não são lidas');

  /* O que o canal PROVA continua fora: App Secret e verify token são o que
     autentica a Meta e o webhook. Mandá-los pelo canal que eles protegem
     fecharia o círculo — esses ficam no .env do repassador. */
  assert.ok(!/appSecret|app_secret|verifyToken|verify_token/i.test(servico),
    'o que autentica o canal não viaja por ele');

  // E a única credencial presente é a de envio, nomeada como tal
  const tokens = corpo.match(/\btoken\w*/gi) || [];
  assert.deepEqual([...new Set(tokens.map(t => t.toLowerCase()))], ['token'],
    'só o token de envio da Meta: ' + tokens.join(', '));
});

test('a réplica anda num sentido só', () => {
  /* Dois sentidos seriam duas verdades, e "quem tem acesso à empresa X?"
     passaria a ter duas respostas possíveis. */
  const servico = fonte('services', 'replicaCadastro.js');
  assert.match(servico, /POST \{url\}\/cadastro/, 'o gateway é quem envia');
  const rotas = fonte('routes', 'ponte.js');
  assert.ok(!/router\.(post|put)\('\/cadastro\/receber/.test(rotas),
    'não existe rota para o portal escrever cadastro aqui');
});

test('o retrato é inteiro, não um fluxo de diferenças', () => {
  /* Retrato completo se conserta sozinho: portal que perdeu um envio, ficou
     fora do ar ou foi restaurado de backup velho volta ao normal no próximo.
     Fila de diferenças só funciona se ninguém perder nada. */
  const servico = fonte('services', 'replicaCadastro.js');
  const i = servico.indexOf('async function montar');
  const corpo = servico.slice(i, servico.indexOf('\nasync function enviar', i));

  /* Casava com `FROM empresas ORDER BY cnpj` — a GRAFIA da consulta, não o que
     ela garante. Bastou um LEFT JOIN entrar (para trazer o nome do município)
     e o teste acusou uma consulta que continuava mandando todas as empresas.
     O que precisa valer é: a consulta das empresas não filtra linha nenhuma. */
  const empresas = corpo.slice(corpo.indexOf('FROM empresas'),
                               corpo.indexOf('ORDER BY', corpo.indexOf('FROM empresas')));
  assert.ok(empresas.length > 0, 'a consulta das empresas sumiu');
  assert.ok(!/\bWHERE\b/i.test(empresas),
    'a consulta das empresas não pode ter WHERE: retrato é tudo, não uma seleção');
  assert.ok(!/atualizado_em\s*>/.test(corpo),
    'não filtra por "mudou desde"; manda tudo');
});

test('a impressão digital ignora a data de geração', () => {
  /* Senão todo retrato seria "novo" e o gateway reenviaria o cadastro inteiro
     a cada rodada de 15 segundos. */
  const servico = fonte('services', 'replicaCadastro.js');
  assert.match(servico, /delete semData\.geradoEm/);
  assert.match(servico, /createHash\('sha256'\)/);
});

test('só reenvia quando o cadastro muda', () => {
  const servico = fonte('services', 'replicaCadastro.js');
  assert.match(servico, /c\.cadastro_hash === retrato\.versao/);
  assert.match(servico, /forcar/, 'e dá para forçar, depois de o portal ser restaurado');
});

test('a trava de liberação viaja junto', () => {
  /* O portal esconde o botão; o gateway continua conferindo na chegada. As duas
     coisas, não uma. */
  const servico = fonte('services', 'replicaCadastro.js');
  assert.match(servico, /liberado: e\.portal_liberado/);
  assert.match(servico, /motivoBloqueio/);
  const ponte = fonte('services', 'ponteNuvem.js');
  assert.match(ponte, /!e\.portal_liberado/,
    'a conferência na chegada continua existindo');
});

/* ------------------------------------------- o perfil de cliente */

test('uma pessoa do cliente precisa de empresa vinculada', () => {
  /* Vínculo vazio significa "enxerga todas" — regra pensada para o pessoal do
     escritório. Para quem acessa pela internet seria a vida fiscal de todos os
     clientes da casa. */
  const usuarios = fonte('services', 'usuarios.js');
  assert.match(usuarios, /function conferirVinculoDeCliente/);
  const i = usuarios.indexOf('function conferirVinculoDeCliente');
  const corpo = usuarios.slice(i, usuarios.indexOf('\n}\n', i));
  assert.match(corpo, /perfil !== 'cliente'/);
  assert.match(corpo, /status: 400/);

  // e é chamada nos dois caminhos
  assert.match(usuarios, /conferirVinculoDeCliente\(perfilNorm, empresasIds\)/,
    'no cadastro');
  assert.match(usuarios, /conferirVinculoDeCliente\(p, empresasIds !== undefined/,
    'e na edição, inclusive quando o vínculo não vem no corpo');
});

test('o perfil de cliente não entra no painel do gateway', () => {
  const auth = fonte('routes', 'auth.js');
  assert.match(auth, /usuario\.perfil !== 'cliente'/,
    'o login do painel precisa barrar o perfil de cliente');
  // e a resposta é a mesma das outras falhas, para não revelar quem tem conta
  const i = auth.indexOf("usuario.perfil !== 'cliente'");
  const trecho = auth.slice(i, i + 400);
  assert.match(trecho, /E-mail ou senha incorretos/);
});

test('a senha do portal não é guardada no gateway', () => {
  const usuarios = fonte('services', 'usuarios.js');
  assert.match(usuarios, /function senhaInutilizavel/);
  assert.match(usuarios, /senha = senhaInutilizavel\(\)/,
    'cliente nasce com senha que ninguém conhece');
  const servico = fonte('services', 'replicaCadastro.js');
  assert.ok(!/senha/i.test(servico.slice(servico.indexOf('acessos: acessos.rows'),
    servico.indexOf('};', servico.indexOf('acessos: acessos.rows')))),
    'e nada de senha vai no retrato');
});
