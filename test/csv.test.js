const test = require('node:test');
const assert = require('node:assert');
const { lerCsv, lerNumero, gerarCsv } = require('../src/util/csv');

test('detecta ponto e vírgula, o separador do Excel em português', () => {
  const r = lerCsv('documento;nome;valor\n14073521000183;CLIENTE LTDA;1500,00');
  assert.equal(r.separador, ';');
  assert.equal(r.registros[0].documento, '14073521000183');
  assert.equal(r.registros[0].nome, 'CLIENTE LTDA');
});

test('detecta vírgula quando é o separador', () => {
  const r = lerCsv('documento,nome,valor\n14073521000183,CLIENTE LTDA,1500.00');
  assert.equal(r.separador, ',');
  assert.equal(r.registros[0].nome, 'CLIENTE LTDA');
});

test('campo entre aspas mantém o separador interno', () => {
  const r = lerCsv('nome;descricao\nACME;"Consultoria, com relatório"');
  assert.equal(r.registros[0].descricao, 'Consultoria, com relatório');
});

test('aspas duplicadas viram uma aspa só', () => {
  const r = lerCsv('descricao\n"Servico ""especial"" contratado"');
  assert.equal(r.registros[0].descricao, 'Servico "especial" contratado');
});

test('quebra de linha dentro de aspas não parte o registro', () => {
  // Descrição de serviço com várias linhas é comum
  const r = lerCsv('nome;descricao\nACME;"Linha 1\nLinha 2"');
  assert.equal(r.registros.length, 1);
  assert.match(r.registros[0].descricao, /Linha 1\nLinha 2/);
});

test('BOM do Excel não gruda no nome da primeira coluna', () => {
  const r = lerCsv('﻿documento;nome\n123;ACME');
  assert.equal(r.registros[0].documento, '123');
});

test('cabeçalho é normalizado: acento, espaço e caixa não importam', () => {
  const r = lerCsv('Razão Social;CNPJ do Cliente;Valor Total\nACME;123;100');
  assert.deepEqual(r.colunas, ['razaosocial', 'cnpjdocliente', 'valortotal']);
});

test('a linha informada é a da planilha, contando o cabeçalho', () => {
  const r = lerCsv('a\nx\ny');
  assert.equal(r.registros[0].__linha, 2);
  assert.equal(r.registros[1].__linha, 3);
});

test('número em formato brasileiro é convertido', () => {
  assert.equal(lerNumero('1.234,56'), 1234.56);
  assert.equal(lerNumero('1234,56'), 1234.56);
  assert.equal(lerNumero('1234.56'), 1234.56);
  assert.equal(lerNumero('1500'), 1500);
  assert.equal(lerNumero(''), undefined);
  assert.equal(lerNumero('abc'), undefined);
});

test('CSV gerado sai com BOM e escapa o que precisa', () => {
  const csv = gerarCsv(
    [{ titulo: 'Nome', campo: 'nome' }, { titulo: 'Obs', campo: 'obs' }],
    [{ nome: 'ACME', obs: 'tem ; e "aspas"' }]);
  assert.ok(csv.startsWith('﻿'), 'BOM para o Excel abrir acentuado');
  assert.match(csv, /"tem ; e ""aspas"""/);
});
