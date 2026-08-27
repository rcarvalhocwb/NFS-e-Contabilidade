const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O histórico do que foi pedido, e o número do escritório.
 *
 * A conversa vivia só na memória do repassador e sumia ao terminar. Guardava-se
 * o pedido pronto — não o que foi perguntado, o que a pessoa respondeu, nem em
 * que ordem. É o que falta no dia em que um cliente diz "eu não pedi essa
 * nota": o pedido sozinho não prova nada, o diálogo prova.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

/* ------------------------------------------------------------- transcrição */

test('a conversa fica gravada junto com o pedido', () => {
  const sql = fonte('migrations', '031_whatsapp_escritorio.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS transcricao jsonb/);

  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /transcricao\)/, 'a coluna precisa entrar no INSERT');
  assert.match(ponte, /s\.transcricao \? JSON\.stringify\(s\.transcricao\.slice\(-60\)\)/,
    'com teto: um cliente falante não pode inchar o banco');
});

test('a mensagem do cliente é anotada ANTES de ser respondida', () => {
  /* Anotar só depois perderia justamente a que quebrou a conversa. */
  const servidor = fonte('relay', 'servidor.js');
  const anota = servidor.indexOf("de: 'cliente'");
  const responde = servidor.indexOf('conversa.responder({');
  assert.ok(anota > 0 && anota < responde,
    'a anotação vem antes da chamada que pode quebrar');
});

test('a resposta do sistema também entra no registro', () => {
  const servidor = fonte('relay', 'servidor.js');
  assert.match(servidor, /de: 'sistema'/);
  assert.match(servidor, /saida\.pedido\.transcricao = completa/,
    'e a conversa completa acompanha o pedido');
});

test('o teto da transcrição vale nos dois lados', () => {
  /* Sem teto no relay, o payload cresce sem limite antes mesmo de chegar. */
  assert.match(fonte('relay', 'servidor.js'), /\.slice\(-60\)/);
  assert.match(fonte('relay', 'conversa.js'), /transcricao \|\| \[\]\)\.slice\(-60\)/);
  assert.match(fonte('src', 'services', 'ponteNuvem.js'), /transcricao\.slice\(-60\)/);
});

test('a fila devolve a transcrição para a tela', () => {
  const rotas = fonte('src', 'routes', 'ponte.js');
  assert.match(rotas, /s\.transcricao/);
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /function verTranscricao/);
  assert.match(painel, /data-conversa="/, 'e há como abrir a partir da fila');
});

test('a linha de auditoria fecha do pedido até a aprovação', () => {
  /* Quem pediu (transcrição + remetente), quem liberou (auditoria), o que a
     Sefin devolveu (mensagens da nota). Os três já existem; o que faltava era
     o primeiro. */
  const rotas = fonte('src', 'routes', 'ponte.js');
  assert.match(rotas, /auditoria\.registrar\(req, s\.empresa_id, 'solicitacao\.aprovada'/);
  assert.match(rotas, /auditoria\.registrar\(req, s\.empresa_id, 'solicitacao\.recusada'/);
  assert.match(rotas, /referencia: s\.id_externo/,
    'a auditoria aponta para o mesmo pedido');
});

/* ------------------------------------------------- o número do escritório */

test('o token da Meta é guardado cifrado', () => {
  const sql = fonte('migrations', '031_whatsapp_escritorio.sql');
  assert.match(sql, /wa_token_cifrado\s+bytea/);
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /põe\('wa_token_cifrado', encrypt\(String\(dados\.waToken\)\)\)/);
});

test('o token nunca volta pela API', () => {
  /* A tela só precisa saber se existe. Devolvê-lo colocaria a senha do número
     do escritório em toda resposta de configuração. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('async function ler');
  const corpo = ponte.slice(i, ponte.indexOf('\n}\n', i));
  assert.match(corpo, /wa_token_cifrado IS NOT NULL\) AS tem_wa_token/);
  assert.ok(!/SELECT[\s\S]*\bwa_token_cifrado,/.test(corpo),
    'o token cifrado não pode sair na leitura');
});

test('App Secret e verify token NÃO viajam para o repassador', () => {
  /* São eles que provam que a mensagem veio da Meta e que o canal é o certo.
     Mandá-los PELO canal que protegem fecharia o círculo. */
  const replica = fonte('src', 'services', 'replicaCadastro.js');
  assert.ok(!/appSecret|app_secret|verifyToken|verify_token/i.test(replica),
    'nem o segredo do app nem o token de verificação entram no retrato');
  assert.match(replica, /token: waToken/, 'só o token de envio vai');

  const sql = fonte('migrations', '031_whatsapp_escritorio.sql');
  assert.match(sql, /continuam no \.env do repassador/,
    'e a razão fica escrita onde alguém vai ler');
});

test('o repassador prefere o cadastro e cai no .env como reserva', () => {
  const servidor = fonte('relay', 'servidor.js');
  const i = servidor.indexOf('function credenciais');
  const corpo = servidor.slice(i, servidor.indexOf('\n}', i));
  assert.match(corpo, /canal\.phoneNumberId \|\| CFG\.phoneNumberId/);
  assert.match(corpo, /canal\.token \|\| CFG\.token/);
});

test('sem número configurado, a falha é dita e não engolida', () => {
  const servidor = fonte('relay', 'servidor.js');
  assert.match(servidor, /sem número configurado/);
  assert.match(servidor, /Portal do cliente" do gateway/,
    'e a mensagem diz onde resolver');
});

/* -------------------------------------------------------------- a tela */

test('a tela não vem mais do cache do navegador', () => {
  /* Depois de uma atualização, o navegador servia a versão antiga por conta
     própria e o escritório continuava vendo a tela de ontem. */
  const servidor = fonte('src', 'server.js');
  assert.match(servidor, /Cache-Control', 'no-cache, must-revalidate/);
  assert.match(servidor, /\['\/admin', '\/emitir', '\/nota'\]/);
});

test('vários números na mesma empresa continuam possíveis', () => {
  /* A unicidade é do par: o mesmo número em várias empresas, e várias pessoas
     na mesma empresa. */
  const sql = fonte('migrations', '030_whatsapp_multi_empresa.sql');
  assert.match(sql, /UNIQUE \(telefone, empresa_id\)/);
  const servico = fonte('src', 'services', 'contatosWhatsapp.js');
  const i = servico.indexOf('async function listar');
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.match(corpo, /c\.empresa_id = \$1/, 'a listagem é por empresa');
  assert.ok(!/LIMIT 1/.test(corpo), 'e não corta em um');
});
