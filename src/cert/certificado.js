/* Leitura de certificado A1 (.pfx/.p12) com node-forge:
   extrai chave privada, certificado, validade, subject e CNPJ. */
const forge = require('node-forge');

function lerPfx(pfxBuffer, senha) {
  const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

  let keyObj = null;
  let certObj = null;

  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        keyObj = safeBag.key;
      } else if (safeBag.type === forge.pki.oids.certBag) {
        // pega o certificado do titular (o que tem chave correspondente ou o primeiro)
        if (!certObj) certObj = safeBag.cert;
      }
    }
  }
  if (!keyObj || !certObj) throw new Error('Não foi possível extrair chave/certificado do PFX. Senha correta?');

  const subject = certObj.subject.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(', ');
  const cn = (certObj.subject.getField('CN') || {}).value || '';
  // Em e-CNPJ o CN normalmente é "RAZAO SOCIAL:CNPJ"
  const cnpjMatch = cn.match(/(\d{14})/);

  return {
    keyPem: forge.pki.privateKeyToPem(keyObj),
    certPem: forge.pki.certificateToPem(certObj),
    certDerB64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(certObj)).getBytes()
    ),
    subject,
    cnpj: cnpjMatch ? cnpjMatch[1] : null,
    validoAte: certObj.validity.notAfter
  };
}

module.exports = { lerPfx };
