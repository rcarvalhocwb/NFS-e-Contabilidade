const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A nota emitida duas vezes.
 *
 * A idempotência por `referencia` já existia e pega o reenvio do MESMO pedido:
 * dois POSTs da mesma requisição, o webhook repetido, o clique duplo. Ela não
 * pega o caso mais comum de todos — a pessoa achou que não tinha ido e pediu de
 * novo, com referência nova. Para o sistema são dois pedidos legítimos; para a
 * empresa são duas notas fiscais do mesmo serviço, dois números que não se
 * reaproveitam, e um cancelamento para desfazer que nem todo município aceita.
 *
 * O que este arquivo trava: que a conferência exista, que ela seja estreita o
 * bastante para não barrar trabalho legítimo, e que ela PERGUNTE em vez de
 * impedir.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');
const SERVICO = ler('src', 'services', 'emissaoService.js');
const ROTA = ler('src', 'routes', 'nfse.js');

/* ------------------------------------------------ o recorte da busca */

test('a conferência acontece antes de reservar número', () => {
  /* Reservar e depois descobrir que era duplicata deixaria um buraco na
     sequência fiscal por causa de uma nota que nem chegou a existir. */
  const i = SERVICO.indexOf('async function emitir');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Consulta NFS-e', i));

  const confere = corpo.indexOf('procurarSemelhante');
  const reserva = corpo.indexOf('reservarNumeracao');
  assert.ok(confere > 0, 'a conferência de duplicata sumiu de emitir()');
  assert.ok(reserva > 0);
  assert.ok(confere < reserva,
    'conferir depois de reservar queima número numa nota que não vai existir');
});

test('a busca é estreita: mesma empresa, mesmo tomador, mesmo valor, minutos', () => {
  /* Alargar isto barraria trabalho legítimo. Quem presta o mesmo serviço pelo
     mesmo preço a dez clientes num dia tem toda razão de fazê-lo — o que não
     pode é a MESMA nota sair duas vezes. */
  const i = SERVICO.indexOf('async function procurarSemelhante');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Idempotência', i));

  assert.match(corpo, /empresa_id = \$1/, 'preso à empresa');
  assert.match(corpo, /criado_em > now\(\) - /, 'e a uma janela de tempo');
  assert.match(corpo, /docDela === doc/, 'o tomador precisa ser o mesmo');
  assert.match(corpo, /Math\.abs\(valorDela - valor\) < 0\.005/,
    'e o valor também — com tolerância de centavo, porque ponto flutuante');

  /* Sem o documento do tomador ou sem valor, não há o que comparar: não se
     inventa semelhança a partir de meio critério. */
  assert.match(corpo, /if \(!doc \|\| !isFinite\(valor\) \|\| valor <= 0\) return null/);
});

test('nota recusada não conta como duplicata', () => {
  /* Reemitir depois de uma rejeição é exatamente o que se espera que a pessoa
     faça. Contar a recusada como semelhante barraria a correção. */
  const i = SERVICO.indexOf('async function procurarSemelhante');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Idempotência', i));
  for (const morta of ['cancelada', 'rejeitada', 'erro', 'substituida']) {
    assert.ok(corpo.includes("'" + morta + "'"),
      morta + ' precisa ficar de fora da busca por semelhante');
  }
});

/* --------------------------------------------- pergunta, não impede */

test('duplicata pergunta; não barra em silêncio', () => {
  /* Barrar em silêncio trocaria um problema visível (nota duplicada, que dá
     para cancelar) por um invisível (a nota que não saiu e ninguém sabe por
     quê). */
  const i = SERVICO.indexOf('async function emitir');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Consulta NFS-e', i));

  assert.match(corpo, /codigo: 'possivel_duplicata'/,
    'o chamador precisa distinguir isto de qualquer outro 409');
  assert.match(corpo, /semelhante \}/,
    'e receber O QUE foi achado, não só o aviso de que achou');
  assert.match(corpo, /!contexto\.confirmaDuplicata/,
    'e precisa haver um caminho para seguir mesmo assim');
});

test('a rota devolve a nota anterior, não só o código', () => {
  const i = ROTA.indexOf("e.codigo === 'possivel_duplicata'");
  assert.ok(i > 0, 'a rota precisa tratar a duplicata à parte');
  const bloco = ROTA.slice(i, i + 420);
  assert.match(bloco, /status\(409\)/);
  assert.match(bloco, /semelhante: e\.semelhante/,
    'a tela mostra a nota anterior; sem ela, a pessoa fica adivinhando');
  assert.match(bloco, /confirmaDuplicata/,
    'e a resposta diz como seguir');
});

test('quem confirma é a pessoa, não o sistema', () => {
  /* O sistema não tem como saber se dois serviços iguais no mesmo dia para o
     mesmo cliente são engano ou rotina. Quem sabe é quem emite. */
  const i = ROTA.indexOf('confirmaDuplicata: b.confirmaDuplicata');
  assert.ok(i > 0, 'a confirmação precisa vir do corpo da requisição');
  assert.match(ROTA.slice(i, i + 80), /=== true/,
    'só o booleano verdadeiro confirma — string vazia ou "false" não podem passar');
});

/* ------------------------------------------------- a leitura da DPS */

test('a comparação lê a DPS, não procura texto no XML', () => {
  /* "esse número aparece em algum lugar do documento" não é a mesma pergunta
     que "o tomador é este". Um valor que calhe de aparecer no CEP ou no código
     do serviço daria falso positivo, e falso positivo aqui é emissão barrada. */
  const i = SERVICO.indexOf('async function procurarSemelhante');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Idempotência', i));
  assert.match(corpo, /lerDps\(nota\.dps_xml\)/);
  assert.ok(!/LIKE/.test(corpo),
    'busca por texto dentro do XML responde a pergunta errada');

  /* E lerDps precisa estar importado — sem isso a função só quebraria na hora
     de emitir, que é o pior momento possível para descobrir. */
  assert.match(SERVICO, /const \{ lerDps \} = require\('\.\.\/nfse\/lerDps'\)/);
});

test('DPS ilegível não derruba a emissão', () => {
  /* Uma nota antiga com XML de outro formato não pode impedir a emissão de
     hoje. Ela é pulada: deixa de ser candidata, e só. */
  const i = SERVICO.indexOf('async function procurarSemelhante');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n/* Idempotência', i));
  assert.match(corpo, /catch \(_\) \{ continue; \}/);
});
