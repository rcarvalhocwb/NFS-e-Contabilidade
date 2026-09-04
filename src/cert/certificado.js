/* Leitura de certificado A1 (.pfx/.p12) com node-forge:
   extrai chave privada, certificado, validade, subject e CNPJ. */
const forge = require('node-forge');

function lerPfx(pfxBuffer, senha) {
  /* Ler o arquivo que a pessoa mandou é sempre problema DELA, nunca do
     servidor — e o `status` diz isso a quem responde a requisição.

     Sem ele, a rota classificava pela mensagem do erro (`/senha|password|PKCS|
     Invalid/`), e a senha errada caía certo, em 400, mas um arquivo que nem é
     PFX escapava: "Too few bytes to read ASN.1 value" não casa com nenhuma
     daquelas palavras, virava 500 e a tela mostrava um erro de servidor para
     quem só escolheu o arquivo errado na pasta.

     Aqui a origem é conhecida, então o julgamento é feito aqui. */
  let p12Asn1, p12;
  try {
    p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
  } catch (e) {
    throw Object.assign(
      new Error('Este arquivo não parece um certificado .pfx/.p12. ' +
                'Confira se escolheu o arquivo certo.'),
      { status: 400, causa: e.message });
  }
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);
  } catch (e) {
    throw Object.assign(
      new Error('Não foi possível abrir o certificado. A senha confere?'),
      { status: 400, causa: e.message });
  }

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
  if (!keyObj || !certObj) {
    throw Object.assign(
      new Error('O arquivo abriu, mas não tem chave e certificado dentro. ' +
                'Confira se é o .pfx do e-CNPJ da empresa.'),
      { status: 400 });
  }

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
