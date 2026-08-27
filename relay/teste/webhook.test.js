const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const meta = require('../meta');

/* A porta de entrada do relay.
 *
 * O endereço do webhook é público — é a razão de o relay existir. Qualquer um
 * que o descubra pode mandar um POST fingindo ser a Meta. Sem conferir a
 * assinatura, um estranho enfileira pedido de nota fiscal em nome de um cliente
 * do escritório. É a checagem mais importante deste programa.
 */

const SEGREDO = 'segredo-de-teste';

function assinar(corpo, segredo) {
  return 'sha256=' + crypto.createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex');
}

test('assinatura correta passa', () => {
  const corpo = JSON.stringify({ object: 'whatsapp_business_account' });
  assert.ok(meta.assinaturaConfere(corpo, assinar(corpo, SEGREDO), SEGREDO));
});

test('corpo adulterado não passa', () => {
  /* O caso que a assinatura existe para pegar: alguém intercepta e troca o
     valor da nota. */
  const original = JSON.stringify({ valor: 100 });
  const adulterado = JSON.stringify({ valor: 100000 });
  assert.ok(!meta.assinaturaConfere(adulterado, assinar(original, SEGREDO), SEGREDO));
});

test('assinatura de outro segredo não passa', () => {
  const corpo = '{"a":1}';
  assert.ok(!meta.assinaturaConfere(corpo, assinar(corpo, 'outro'), SEGREDO));
});

test('sem assinatura e sem segredo não passa', () => {
  /* Relay mal configurado não pode virar porta aberta: sem App Secret, a
     resposta é "não", nunca "tudo bem". */
  assert.ok(!meta.assinaturaConfere('{}', null, SEGREDO));
  assert.ok(!meta.assinaturaConfere('{}', assinar('{}', SEGREDO), ''));
});

test('a comparação é em tempo constante', () => {
  /* `a === b` em string vaza, pelo tempo de resposta, quantos bytes iniciais
     bateram — e com isso se descobre a assinatura byte a byte. */
  const fonte = require('fs').readFileSync(require.resolve('../meta.js'), 'utf8');
  const i = fonte.indexOf('function assinaturaConfere');
  const corpo = fonte.slice(i, fonte.indexOf('\n}', i));
  assert.match(corpo, /timingSafeEqual/);
  assert.ok(!/esperada === cabecalho|cabecalho === esperada/.test(corpo));
});

/* -------------------------------------------------------- verificação inicial */

test('o desafio só volta com o token certo', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'certo', 'hub.challenge': '12345' };
  assert.equal(meta.conferirDesafio(q, 'certo'), '12345');
  assert.equal(meta.conferirDesafio(q, 'errado'), null);
  assert.equal(meta.conferirDesafio({ 'hub.mode': 'outro' }, 'certo'), null);
});

/* ------------------------------------------------------ leitura do payload */

test('tira a mensagem de dentro da estrutura da Meta', () => {
  const corpo = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '999' },
      contacts: [{ wa_id: '5541999998888', profile: { name: 'Maria' } }],
      messages: [{ id: 'wamid.1', from: '5541999998888', type: 'text',
                   timestamp: '1700000000', text: { body: 'oi' } }]
    } }] }]
  };
  const [m] = meta.extrairMensagens(corpo);
  assert.equal(m.de, '5541999998888');
  assert.equal(m.texto, 'oi');
  assert.equal(m.nome, 'Maria');
  assert.equal(m.telefoneDestino, '999');
});

test('eventos de status não viram conversa', () => {
  /* A Meta manda "entregue" e "lido" no mesmo formato. Tratar isso como
     mensagem faria o bot responder ao próprio recibo. */
  const corpo = { entry: [{ changes: [{ value: {
    statuses: [{ id: 'wamid.1', status: 'delivered' }]
  } }] }] };
  assert.deepEqual(meta.extrairMensagens(corpo), []);
});

test('áudio e imagem chegam sem texto, e não quebram', () => {
  const corpo = { entry: [{ changes: [{ value: {
    messages: [{ id: 'x', from: '55419', type: 'audio', audio: { id: 'a' } }]
  } }] }] };
  const [m] = meta.extrairMensagens(corpo);
  assert.equal(m.texto, null);
  assert.equal(m.tipo, 'audio');
});

test('um POST com várias mensagens devolve todas', () => {
  const corpo = { entry: [{ changes: [{ value: { messages: [
    { id: '1', from: 'a', type: 'text', text: { body: 'um' } },
    { id: '2', from: 'b', type: 'text', text: { body: 'dois' } }
  ] } }] }] };
  assert.equal(meta.extrairMensagens(corpo).length, 2);
});

test('corpo vazio ou estranho não quebra', () => {
  assert.deepEqual(meta.extrairMensagens({}), []);
  assert.deepEqual(meta.extrairMensagens(null), []);
  assert.deepEqual(meta.extrairMensagens({ entry: [{}] }), []);
});

/* ---------------------------------------------------- o que o relay guarda */

test('o relay não guarda nem toca em documento fiscal', () => {
  /* Se um dia alguém acrescentar XML ou PDF aqui, este teste cai — e é para
     cair: o desenho inteiro depende de nada fiscal passar por esta máquina. */
  const fs = require('fs');
  const path = require('path');
  for (const arquivo of ['memoria.js', 'servidor.js', 'conversa.js', 'meta.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
    for (const proibido of ['pfx', 'certificado', 'senha_cifrada', 'dps_xml', 'nfse_xml']) {
      assert.ok(!new RegExp(proibido, 'i').test(s.replace(/\/\*[\s\S]*?\*\//g, '')),
        arquivo + ' não pode mexer com ' + proibido);
    }
  }
});

test('a boca de teste não existe sem RELAY_TESTE', () => {
  /* Ela enfileira pedido direto, sem conversa. Num servidor de verdade seria a
     porta que o resto do desenho fecha. */
  const s = require('fs').readFileSync(require.resolve('../servidor.js'), 'utf8');
  const i = s.indexOf("u.pathname === '/_injetar'");
  assert.ok(i > 0);
  const corpo = s.slice(i, i + 400);
  assert.match(corpo, /process\.env\.RELAY_TESTE !== 'true'/);
  assert.match(corpo, /404/);
});

test('o estado só avança depois de a resposta sair', () => {
  /* Era o contrário, e isso quebrava a conversa em silêncio: falhando o envio
     (janela de 24h fechada, Meta fora do ar, token vencido), o estado avançava
     de um passo que a pessoa nunca viu, e a próxima mensagem dela seria lida
     contra uma pergunta que nunca chegou. */
  const s = require('fs').readFileSync(require.resolve('../servidor.js'), 'utf8');
  const envio = s.indexOf('const entregue = await responderAoCliente');
  const salva = s.indexOf('memoria.guardarConversa(m.de, saida.estado');
  assert.ok(envio > 0 && envio < salva, 'a entrega vem antes de gravar o estado');
  assert.match(s.slice(envio, salva), /if \(!entregue\)[\s\S]*return;/,
    'e não gravando nada quando a entrega falha');
  assert.match(s, /return true;/, 'responderAoCliente diz se conseguiu');
});

test('conversa expirada avisa em vez de sumir', () => {
  /* A pessoa volta uma hora depois, responde "1" ao que estava na tela, e
     recebia o menu sem entender por quê. */
  const s = require('fs').readFileSync(require.resolve('../servidor.js'), 'utf8');
  assert.match(s, /const expirou = tinhaConversa && !anterior/);
  assert.match(s, /expirou por inatividade/);
});

test('a consulta pública entra por injeção, não por acoplamento', () => {
  /* A conversa não sabe de onde os dados vêm — o que a mantém testável sem
     rede, e deixa a base pública trocável sem tocar na lógica. */
  const conv = require('fs').readFileSync(require.resolve('../conversa.js'), 'utf8');
  assert.match(conv, /buscarCnpj/);
  assert.ok(!/brasilapi|fetch\(/i.test(conv),
    'a conversa não chama a rede direto');
});

test('base fora do ar devolve null, não explode', () => {
  /* Timeout ou 500 num serviço que não é nosso não pode derrubar a conversa. */
  const r = require('fs').readFileSync(require.resolve('../receita.js'), 'utf8');
  assert.match(r, /catch \(_\) \{[\s\S]{0,200}return null;/);
  assert.match(r, /AbortController/);
});

test('o ensaio não fala com a Meta nem com a fila', () => {
  /* Ele existe para ver a conversa antes de haver servidor e número. Se um dia
     encostar na Meta ou enfileirar de verdade, deixa de ser ensaio. */
  const s = require('fs').readFileSync(require.resolve('../ensaio.js'), 'utf8');
  const semComentarios = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!/graph\.facebook|enviarTexto|meta\./i.test(semComentarios),
    'o ensaio não pode mandar mensagem de verdade');
  assert.match(s, /127\.0\.0\.1/, 'e só ouve em localhost');
});

test('o ensaio usa o cadastro de verdade', () => {
  /* Ensaiar com cadastro inventado mostraria uma conversa que não é a que vai
     acontecer. */
  const s = require('fs').readFileSync(require.resolve('../ensaio.js'), 'utf8');
  assert.match(s, /previa-ensaio/);
  assert.match(s, /CHAVE_GATEWAY/, 'autenticado com a chave da ponte');
});
