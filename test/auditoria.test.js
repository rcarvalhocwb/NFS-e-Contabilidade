const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { autorDe } = require('../src/services/auditoria');

/* Trilha de auditoria.
 *
 * Duas coisas precisam continuar verdadeiras neste módulo, e as duas são
 * fáceis de quebrar sem perceber:
 *
 * 1. Registrar nunca derruba a ação. A nota já foi cancelada quando chega aqui;
 *    estourar agora não desfaz nada e ainda apaga o rastro do que aconteceu.
 * 2. Segredo não entra no detalhe. A trilha é lida por mais gente do que os
 *    dados que ela descreve. */

test('identifica a pessoa pelo e-mail', () => {
  const q = autorDe({ auth: { tipo: 'usuario', usuarioId: 7, email: 'ana@escritorio.com.br' } });
  assert.equal(q.autor, 'ana@escritorio.com.br');
  assert.equal(q.origem, 'painel');
  assert.equal(q.usuarioId, 7);
});

test('usuário sem e-mail ainda é identificável', () => {
  const q = autorDe({ auth: { tipo: 'usuario', usuarioId: 12 } });
  assert.match(q.autor, /12/);
});

test('integração aparece como integração, com o CNPJ', () => {
  // Emissão por sistema cliente não tem pessoa; o rastro é do token
  const q = autorDe({ auth: { tipo: 'empresa', cnpj: '21583854000118' } });
  assert.match(q.autor, /integração/);
  assert.match(q.autor, /21583854000118/);
  assert.equal(q.origem, 'api');
  assert.equal(q.usuarioId, null, 'token de empresa não é uma conta de pessoa');
});

test('a chave de instalação é distinguível de uma pessoa', () => {
  const q = autorDe({ auth: { tipo: 'maquina' } });
  assert.match(q.autor, /chave/);
  assert.equal(q.usuarioId, null);
});

test('ação sem requisição é do sistema', () => {
  // Geração automática de obrigações, worker da fila
  assert.equal(autorDe(null).autor, 'sistema');
  assert.equal(autorDe({}).origem, 'sistema');
});

/* A limpeza do detalhe vive dentro do módulo; o teste lê a fonte para checar
   que a lista de proibidos continua cobrindo o que importa. */
const FONTE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'auditoria.js'), 'utf8');

test('senha, token e certificado nunca entram no detalhe', () => {
  const linha = FONTE.match(/const PROIBIDOS = ([^;]+);/);
  assert.ok(linha, 'a lista de campos proibidos precisa existir');
  for (const termo of ['senha', 'token', 'certificad', 'chave', 'secret']) {
    assert.match(linha[1], new RegExp(termo),
      `"${termo}" precisa estar entre os campos que não vão para a trilha`);
  }
});

test('falha ao registrar não derruba a ação', () => {
  // A ação já aconteceu quando o registro é chamado
  const registrar = FONTE.slice(FONTE.indexOf('async function registrar'));
  const corpo = registrar.slice(0, registrar.indexOf('\n}\n'));
  assert.match(corpo, /try\s*\{/, 'o registro precisa estar protegido');
  assert.match(corpo, /catch/, 'e o erro, engolido com log');
  assert.ok(!/throw/.test(corpo), 'registrar não pode relançar o erro');
});

test('a trilha não tem rota de exclusão nem de edição', () => {
  // Registro de auditoria que se apaga não serve de auditoria
  assert.ok(!/DELETE FROM auditoria/i.test(FONTE));
  assert.ok(!/UPDATE auditoria/i.test(FONTE));
});
