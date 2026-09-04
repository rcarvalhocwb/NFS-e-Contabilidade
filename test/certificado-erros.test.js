const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { lerPfx } = require('../src/cert/certificado');

/* Subir o certificado é o primeiro ato de todo cliente novo, e é onde mais se
 * erra: arquivo errado na pasta, senha do e-CNPJ trocada com a do e-CPF,
 * arquivo do sócio em vez do da empresa.
 *
 * Antes, dois desses casos devolviam HTTP 500 e uma frase de biblioteca —
 * "Too few bytes to read ASN.1 value", "Unexpected field". Erro interno do
 * servidor manda a pessoa procurar ajuda; erro do arquivo manda ela olhar o
 * próprio formulário. A diferença decide se o cliente entra hoje ou semana que
 * vem.
 *
 * Verificado com o gateway no ar, subindo os quatro casos de verdade.
 */

function certificadoDeTeste(senha, opcoes = {}) {
  const par = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = par.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01');
  cert.validity.notAfter = new Date('2027-01-01');
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE:11222333000181' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(par.privateKey, forge.md.sha256.create());
  const p12 = opcoes.semChave
    ? forge.pkcs12.toPkcs12Asn1(null, [cert], senha, { algorithm: '3des' })
    : forge.pkcs12.toPkcs12Asn1(par.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

test('o .pfx certo com a senha certa é lido', () => {
  /* A contraprova: sem ela, "tudo recusado" também passaria. */
  const info = lerPfx(certificadoDeTeste('senhaCerta'), 'senhaCerta');
  assert.equal(info.cnpj, '11222333000181');
  assert.match(info.subject, /EMPRESA TESTE/);
  assert.ok(info.keyPem.includes('PRIVATE KEY'));
});

test('arquivo que não é certificado não vira erro de servidor', () => {
  /* Escolher o arquivo errado na pasta é problema de quem enviou, não do
     gateway — e a mensagem precisa dizer isso. */
  try {
    lerPfx(Buffer.from('isto aqui e um txt qualquer'), 'x');
    assert.fail('deveria ter recusado');
  } catch (e) {
    assert.equal(e.status, 400, 'erro do arquivo é 400, não 500');
    assert.match(e.message, /não parece um certificado/i);
    assert.ok(!/ASN\.1/.test(e.message), 'a frase da biblioteca fica no detalhe, não na mensagem');
    assert.match(e.causa || '', /ASN\.1/, 'mas continua disponível para diagnóstico');
  }
});

test('senha errada diz que é a senha', () => {
  try {
    lerPfx(certificadoDeTeste('senhaCerta'), 'senhaErrada');
    assert.fail('deveria ter recusado');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.match(e.message, /senha/i);
  }
});

test('a rota confia no status, não na frase do erro', () => {
  /* A classificação vivia na rota, por expressão regular sobre a mensagem:
     `/senha|password|PKCS|Invalid/`. Erro cuja frase não tivesse nenhuma
     dessas palavras escapava para 500 — e foi exatamente o que aconteceu. */
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'empresas.js'), 'utf8');
  const i = rota.indexOf("router.post('/:cnpj/certificado'");
  assert.ok(i > 0);
  const corpo = rota.slice(i, rota.indexOf('\n});', i));
  assert.match(corpo, /e\.status === 400/, 'a rota decide pelo status que a origem marcou');
  assert.ok(!/password\|PKCS\|Invalid/.test(corpo),
    'classificar pela mensagem deixa passar todo erro com outra redação');
});

test('erro de upload não vira erro de servidor', () => {
  /* Campo com outro nome, arquivo grande demais, arquivos a mais: tudo isso é
     o envio, não o servidor. Sem este ramo, o multer devolvia 500. */
  const servidor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = servidor.indexOf("err.name === 'MulterError'");
  assert.ok(i > 0, 'o tratador central precisa reconhecer erro do multer');
  const corpo = servidor.slice(i, i + 700);
  assert.match(corpo, /status\(400\)/);
  for (const codigo of ['LIMIT_FILE_SIZE', 'LIMIT_UNEXPECTED_FILE']) {
    assert.ok(corpo.includes(codigo), codigo + ' precisa de explicação própria');
  }
  /* E vem ANTES do ramo genérico, senão nunca é alcançado. */
  const generico = servidor.indexOf('err.status || 500');
  assert.ok(i < generico, 'o ramo do multer precisa vir antes do genérico');
});
