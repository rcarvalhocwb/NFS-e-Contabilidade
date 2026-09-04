const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lerNfse } = require('../src/services/notasEntrada');

/* As notas que a empresa recebe, e o motor de busca sobre elas.
 *
 * Duas coisas aqui não podem escorregar, e por motivos diferentes:
 *
 *   - o VÍNCULO. A nota é de quem a recebeu, e isso sai do CNPJ do tomador
 *     dentro do XML. Se saísse de quem está importando, bastaria escolher a
 *     empresa errada na tela para a nota de um cliente entrar na apuração de
 *     outro.
 *   - o ESCOPO. Uma nota de entrada diz quanto um cliente pagou a quem. É
 *     exatamente o tipo de dado que não pode vazar de um cliente para outro.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVICO = fonte('src', 'services', 'notasEntrada.js');
const ROTA = fonte('src', 'routes', 'notasEntrada.js');
const SQL = fonte('migrations', '035_notas_entrada.sql');

/* ------------------------------------------------------------- o vínculo */

test('a empresa dona sai do XML, nunca de quem importa', () => {
  assert.match(SERVICO, /const docTomador = limparDocumento\(d\.tomador\.doc \|\| ''\)/);
  assert.match(SERVICO, /SELECT id, razao_social FROM empresas WHERE cnpj = \$1/);
  /* Nenhuma rota de importação aceita empresaId do chamador. */
  assert.ok(!/empresaId/.test(ROTA), 'a rota não pode deixar escolher a empresa');
});

test('nota de CNPJ não cadastrado é recusada com o motivo', () => {
  assert.match(SERVICO, /não é uma empresa cadastrada aqui/);
});

test('um arquivo torto não derruba o lote', () => {
  /* Quem importa uma pasta com trinta XMLs precisa saber quais entraram. Uma
     exceção levaria os vinte e nove bons junto. */
  const i = SERVICO.indexOf('async function guardar');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\nasync function importar', i));
  assert.match(corpo, /try \{\s*d = lerNfse\(xml\);\s*\} catch \(e\) \{/);
  assert.match(corpo, /return \{ arquivo, ok: false, motivo: e\.message \}/);
});

test('reimportar a mesma nota atualiza, não duplica', () => {
  /* A pasta do escritório é importada mais de uma vez: é assim que se descobre
     o que chegou de novo. Nota dobrada é apuração dobrada. */
  assert.match(SQL, /chave_acesso\s+TEXT NOT NULL UNIQUE/);
  assert.match(SERVICO, /ON CONFLICT \(chave_acesso\) DO UPDATE/);
});

test('nota cancelada não entra como se valesse', () => {
  assert.match(SERVICO, /\['101', '135'\]\.includes\(String\(d\.cStat\)\)/);
});

/* -------------------------------------------------------------- o escopo */

test('toda rota passa pelo escopo', () => {
  const rotas = ROTA.match(/router\.(get|post)\('[^']*'/g) || [];
  assert.ok(rotas.length >= 4, 'esperava as rotas de busca e importação');
  /* Nenhuma consulta pode ficar de fora: as três de leitura passam
     empresasVisiveis, e as de escrita são de administrador. */
  const leituras = (ROTA.match(/empresasVisiveis\(req\)/g) || []).length;
  assert.strictEqual(leituras, 3, 'busca, fornecedores e XML precisam do escopo');
  assert.strictEqual((ROTA.match(/somenteAdmin/g) || []).length, 3,
    'as duas rotas de importação são do administrador');
});

test('lista vazia de empresas não vira "sem filtro"', () => {
  /* O erro clássico: `if (ids.length)` trata [] como "não filtrar", e quem não
     enxerga nenhuma empresa passa a enxergar todas. */
  assert.match(SERVICO, /if \(empresasVisiveis !== null\) \{\s*if \(!empresasVisiveis\.length\) return \{ total: 0/);
  const i = SERVICO.indexOf('async function xmlDe');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  assert.match(corpo, /if \(!empresasVisiveis\.length\) return null;/);
});

test('o escopo entra antes de qualquer outro filtro', () => {
  const i = SERVICO.indexOf('async function buscar');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('const q = preparar', i));
  assert.match(corpo, /empresasVisiveis/);
});

test('nota de outro cliente responde 404, não 403', () => {
  /* "Existe, mas você não pode" já entrega que ela existe. */
  assert.match(ROTA, /if \(!n\) return res\.status\(404\)/);
  assert.match(ROTA, /simplesmente não existe/);
});

/* -------------------------------------------------------- o motor de busca */

test('o índice é em português, e não em "simple"', () => {
  /* É o que faz "serviço" achar "serviços". Com `simple`, procurar no plural
     não acha o singular — e ninguém lembra em qual dos dois digitou. */
  assert.match(SQL, /to_tsvector\('portuguese'/);
  assert.match(SQL, /USING GIN \(busca\)/);
});

test('o texto indexado é coluna gerada, não índice de expressão', () => {
  /* Assim o que a consulta enxerga é o mesmo que foi indexado: não há como um
     ficar velho em relação ao outro. */
  assert.match(SQL, /busca tsvector GENERATED ALWAYS AS/);
  assert.match(SQL, /STORED/);
});

test('quem emitiu pesa mais que a descrição', () => {
  assert.match(SQL, /setweight\(to_tsvector\('portuguese', coalesce\(prestador_nome, ''\)\), 'A'\)/);
  assert.match(SQL, /coalesce\(descricao, ''\)\), 'B'\)/);
});

test('a busca aceita o que a pessoa digita, sem estourar', () => {
  /* `to_tsquery` quebra com pontuação solta e derrubaria a tela.
     `websearch_to_tsquery` entende aspas e -palavra, que é como as pessoas já
     procuram em qualquer buscador. */
  assert.match(SERVICO, /websearch_to_tsquery/);
  assert.ok(!/[^_]to_tsquery\(/.test(SERVICO), 'to_tsquery cru não pode aparecer');
});

test('número e documento são filtro próprio, não texto', () => {
  /* Quem digita 21583854000118 quer aquele documento, não algo parecido. */
  assert.match(SERVICO, /digitos: digitos\.length >= 3 \? digitos : null/);
  assert.match(SERVICO, /n\.numero LIKE/);
  assert.match(SERVICO, /n\.chave_acesso LIKE/);
});

test('o placeholder do ranking é guardado, não procurado depois', () => {
  /* `p.indexOf(valor)` acha a PRIMEIRA ocorrência: bastaria buscar por um
     texto igual a outro filtro para o ranking ordenar pelo parâmetro errado. */
  assert.match(SERVICO, /const pTexto = add\(q\.texto\)/);
  /* Sem os comentários: o texto que explica por que NÃO fazer isso menciona a
     construção, e conferir o arquivo cru acusaria a própria explicação. */
  const semComentario = SERVICO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/p\.indexOf\(/.test(semComentario),
    'o índice do parâmetro não pode ser procurado por valor');
});

test('sem termo, a ordem é a mais recente primeiro', () => {
  /* Relevância sem termo de busca não significa nada. */
  assert.match(SERVICO, /let ordem = 'n\.emitido_em DESC NULLS LAST'/);
  assert.match(SERVICO, /ordem = 'relevancia DESC/);
});

/* --------------------------------------------------- ler o XML de verdade */

test('lê a NFS-e nacional e recusa o que não é', () => {
  assert.throws(() => lerNfse('<xml>qualquer coisa</xml>'),
    /Não parece uma NFS-e do Sistema Nacional/);
});

test('reaproveita o leitor da DANFSe em vez de escrever outro', () => {
  /* Dois leitores do mesmo XML divergem com o tempo, e o que está em produção
     já foi conferido contra as NT 008 e 009. */
  assert.match(SERVICO, /require\('\.\.\/nfse\/danfse'\)/);
  assert.match(SERVICO, /dadosDoXml/);
});

/* ------------------------------------------------------------------ a tela */

test('a tela está registrada e no menu', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /entradas:\s*\{ titulo:'Notas de entrada'/);
  assert.match(painel, /function carregarNotasEntrada/);

  const html = fonte('src', 'public', 'admin.html');
  assert.match(html, /data-tela="entradas"/);
  assert.match(html, /data-tela-conteudo="entradas"/);
});

test('cada arquivo importado tem seu desfecho na tela', () => {
  /* "23 importadas, 2 recusadas" obriga a pessoa a descobrir sozinha QUAIS
     duas — e por quê. */
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /function mostrarImportacao/);
  assert.match(painel, /x\.motivo/);
  assert.match(painel, /já estava aqui/);
});

test('prestador sem documento no XML não se mistura com outro', () => {
  /* GROUP BY prestador_doc junta pelo documento, que é quem identifica o
     prestador de verdade — o nome muda entre notas do mesmo CNPJ. Mas quando o
     documento NÃO veio no XML, todos ficam com o mesmo "" e viram uma linha só:
     o nome de um, o dinheiro de todos.

     Reproduzido em banco separado antes da correção: duas notas de entrada,
     dois prestadores distintos, uma linha de R$ 1.777 — e o segundo prestador
     não aparecia em lugar nenhum. Numa apuração, é o contador conferindo um
     fornecedor que não existe.

     Acontece com prestador de fora (NIF em vez de CNPJ/CPF) e com XML fora do
     leiaute — pouco, e justamente onde a conferência importa. */
  const fn = SERVICO.slice(SERVICO.indexOf('async function fornecedores'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));

  assert.match(corpo, /GROUP BY prestador_doc,/,
    'o documento continua sendo o agrupador principal');
  assert.match(corpo, /CASE WHEN coalesce\(prestador_doc, ''\) = ''\s*THEN prestador_nome END/,
    'sem documento, o nome passa a ser a identidade — é o único dado que resta');
});
