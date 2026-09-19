const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { ehIpPrivado, lookupSeguro } = require('../src/util/rede-segura');

/* SSRF pelo destino do webhook.
 *
 * O webhook é uma URL que o cliente escolhe e o servidor chama sozinho. Sem
 * filtro, um administrador de escritório aponta para 169.254.169.254 (metadados
 * da nuvem), 127.0.0.1:5432 (o banco) ou um serviço interno — e usa o gateway
 * como proxy para dentro da infraestrutura. A barreira valida o IP realmente
 * resolvido, no caminho que o socket usa, o que fecha também DNS rebinding. */

test('classifica endereços internos e externos', () => {
  const internos = ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.0.1',
    '172.16.0.1', '172.31.255.255', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fd00::abcd', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  const externos = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1',
    '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of internos) assert.equal(ehIpPrivado(ip), true, `${ip} devia ser interno`);
  for (const ip of externos) assert.equal(ehIpPrivado(ip), false, `${ip} devia ser externo`);
});

test('validarUrl recusa IP interno literal e aceita destino público', () => {
  const { validarUrl } = require('../src/services/webhooks');
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/',
                   'http://10.0.0.5/hook', 'http://[::1]:8080/x']) {
    assert.throws(() => validarUrl(u), /interno/, `devia recusar ${u}`);
  }
  assert.doesNotThrow(() => validarUrl('https://webhook.cliente.com.br/nfse'));
  // protocolo continua barrado
  assert.throws(() => validarUrl('file:///etc/passwd'), /http/);
});

test('lookupSeguro bloqueia nome que resolve para interno (anti-rebinding)', (_, done) => {
  lookupSeguro('localhost', {}, (err, addr) => {
    assert.ok(err && err.code === 'SSRF_BLOQUEADO',
      'localhost resolve para 127.0.0.1 e tem de ser bloqueado, não ' + addr);
    done();
  });
});

test('a entrega real a um serviço em 127.0.0.1 é recusada', (_, done) => {
  const alvo = http.createServer((req, res) => res.end('interno'));
  alvo.listen(0, '127.0.0.1', () => {
    const porta = alvo.address().port;
    const req = http.request(
      { method: 'POST', hostname: 'localhost', port: porta, path: '/', lookup: lookupSeguro, timeout: 3000 },
      () => { alvo.close(); done(new Error('alcançou o serviço interno — SSRF não bloqueado')); });
    req.on('error', (e) => {
      alvo.close();
      assert.equal(e.code, 'SSRF_BLOQUEADO');
      done();
    });
    req.end('{}');
  });
});
