const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { enderecosDaMaquina, precisaReiniciar } = require('../src/services/configRede');

/* De onde o painel aceita conexão, e se ela é criptografada.
 *
 * Isto vivia na variável HOST do .env, editada no bloco de notas. Numa máquina
 * de contabilidade, mexer em arquivo de configuração à mão é onde o operador
 * trava — e onde alguém apaga uma linha sem querer.
 *
 * O que não pode escorregar: a senha de quem abre o painel de outro computador
 * do escritório não pode atravessar a rede em texto puro sem ninguém ter dito
 * isso em voz alta.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVICO = fonte('src', 'services', 'configRede.js');
const SERVER = fonte('src', 'server.js');
const SQL = fonte('migrations', '036_config_rede.sql');

/* ------------------------------------------------------- a porta de saída */

test('a variável de ambiente vence a tela', () => {
  /* É a saída de emergência: numa máquina em que o painel ficou inalcançável
     por configuração errada, HOST=127.0.0.1 na linha de comando é o jeito de
     voltar a entrar sem precisar do painel — que é justamente o que não abre. */
  const i = SERVICO.indexOf('async function paraSubir');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  const usaAmbiente = corpo.indexOf('process.env.HOST');
  const leConfig = corpo.indexOf('await ler()');
  assert.ok(usaAmbiente > 0 && usaAmbiente < leConfig,
    'o ambiente é conferido ANTES de ler a configuração');
});

test('sem banco, o gateway ainda sobe', () => {
  /* Um gateway que não abre por causa do banco não consegue nem mostrar o
     erro. Subir em 0.0.0.0 é o comportamento de sempre. */
  assert.match(SERVICO, /banco indisponível/);
  assert.match(SERVER, /subir\(\)\.catch\(e => \{/);
  assert.match(SERVER, /servidor = app\.listen\(config\.port, process\.env\.HOST \|\| '0\.0\.0\.0', aoSubir\)/);
});

/* --------------------------------------------------------- o certificado */

test('o certificado cobre os endereços por onde a máquina é alcançada', () => {
  /* O navegador confere o endereço digitado contra o subjectAltName, e não
     contra o commonName: sem os IPs ali, abrir por http://192.168.x.x seria
     recusado mesmo com o certificado aceito. */
  const e = enderecosDaMaquina();
  assert.ok(e.nomes.includes('localhost'));
  assert.ok(e.ips.includes('127.0.0.1'));
  assert.match(SERVICO, /type: 7, ip/);
  assert.match(SERVICO, /type: 2, value: n/);
});

test('a chave privada é guardada cifrada', () => {
  /* Não é documento fiscal, mas quem a tiver consegue se passar pelo painel
     dentro da rede. */
  assert.match(SQL, /chave_pem_cifrada\s+BYTEA/);
  assert.match(SERVICO, /encrypt\(g\.chavePem\)/);
});

test('a chave privada não sai pela API', () => {
  const i = SERVICO.indexOf('async function ler()');
  const consulta = SERVICO.slice(i, SERVICO.indexOf('}', i));
  assert.ok(!/cert_pem_cifrado,|chave_pem_cifrada,/.test(consulta),
    'ler() só pode dizer SE existe certificado, não devolvê-lo');
  assert.match(consulta, /\(cert_pem_cifrado IS NOT NULL\) AS tem_certificado/);
});

test('MASTER_KEY trocada não derruba a subida', () => {
  /* O certificado fica ilegível, e o certo é subir sem HTTPS avisando — não
     deixar a máquina sem painel nenhum. */
  const i = SERVICO.indexOf('async function credenciais');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  assert.match(corpo, /catch \(_\) \{/);
  assert.match(SERVICO, /certificado ilegível/);
});

/* ------------------------------------------------------------- as travas */

test('não dá para ligar HTTPS sem certificado', () => {
  /* Ligaria, não subiria em HTTPS, e não diria por quê. */
  assert.match(SERVICO, /Antes de ligar o HTTPS é preciso ter um certificado/);
});

test('o HTTP continua no ar ao lado do HTTPS', () => {
  /* Derrubá-lo tiraria do ar o atalho da área de trabalho e todo endereço já
     anotado — inclusive o do repassador e o do monitor. */
  assert.match(SERVER, /HTTP e HTTPS juntos, em portas diferentes/);
  const i = SERVER.indexOf('async function subir');
  const corpo = SERVER.slice(i, SERVER.indexOf('\nfunction aoSubir', i));
  assert.match(corpo, /servidor = app\.listen\(config\.port, rede\.host, aoSubir\)/);
  assert.match(corpo, /if \(rede\.https\)/);
});

test('o encerramento fecha os dois, e tolera que não existam', () => {
  /* Um sinal que chegue antes de a configuração ser lida encontraria
     `servidor` indefinido e mataria o encerramento com TypeError. */
  const i = SERVER.indexOf('function encerrar');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}', i));
  assert.match(corpo, /if \(servidorHttps\) servidorHttps\.close\(\)/);
  assert.match(corpo, /if \(servidor\) servidor\.close\(fecharBanco\); else fecharBanco\(\)/);
});

test('o certificado que sobe não derruba o gateway se o sistema recusar', () => {
  const i = SERVER.indexOf('if (rede.https)');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}', i));
  assert.match(corpo, /try \{/);
  assert.match(corpo, /catch \(e\)/);
});

/* ------------------------------------------------- o que muda no reinício */

test('trocar escuta ou porta pede reinício; o resto não', () => {
  /* A porta em que um servidor escuta não se troca com ele no ar, e prometer
     que trocou seria pior do que avisar. */
  const base = { escuta: 'rede', https_ativo: false, https_porta: 3443 };
  assert.ok(precisaReiniciar(base, Object.assign({}, base, { escuta: 'local' })));
  assert.ok(precisaReiniciar(base, Object.assign({}, base, { https_ativo: true })));
  assert.ok(precisaReiniciar(base, Object.assign({}, base, { https_porta: 8443 })));
  assert.ok(!precisaReiniciar(base, Object.assign({}, base)));
});

test('o padrão não muda o comportamento de quem já usa', () => {
  /* Uma migração que trancasse o painel em 127.0.0.1 tiraria o acesso de quem
     o abre de outra máquina, sem ter pedido nada. */
  assert.match(SQL, /escuta TEXT NOT NULL DEFAULT 'rede'/);
  assert.match(SQL, /https_ativo BOOLEAN NOT NULL DEFAULT FALSE/);
});

/* ------------------------------------------------------------------ a tela */

test('a tela diz o que o certificado próprio não resolve', () => {
  /* Ele criptografa e não prova identidade. Deixar a pessoa descobrir isso
     pelo aviso do navegador é deixá-la achar que quebrou. */
  const html = fonte('src', 'public', 'admin.html');
  assert.match(html, /O que ele não resolve/);
  assert.match(html, /aceita uma vez em cada computador/);
  assert.match(html, /atravessa a rede em texto puro/);
});

test('a tela avisa quando o .env está mandando', () => {
  /* Sem isso, mudar na tela e nada acontecer viraria "o sistema não funciona". */
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /hostDoAmbiente/);
  assert.match(painel, /vence esta tela/);
});

test('a tela avisa que só vale depois de reiniciar', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /precisaReiniciar/);
  assert.match(painel, /depois de reiniciar o gateway/);
});
