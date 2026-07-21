/* Assinatura digital XMLDSig (enveloped) da DPS e do pedido de evento,
   no padrão usado pelos documentos fiscais eletrônicos brasileiros. */
const { SignedXml } = require('xml-crypto');
const config = require('../config');

const ALGS = {
  sha1: {
    signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1'
  },
  sha256: {
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256'
  }
};

/**
 * Assina o elemento informado (por local-name) dentro do XML.
 * A Signature é inserida como último filho do elemento raiz.
 */
function assinarXml(xml, elementoLocalName, { keyPem, certDerB64 }) {
  const alg = ALGS[config.xmlSigAlg] || ALGS.sha1;
  const sig = new SignedXml();

  sig.signingKey = keyPem;
  sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  sig.signatureAlgorithm = alg.signature;

  sig.addReference(
    `//*[local-name(.)='${elementoLocalName}']`,
    [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    ],
    alg.digest
  );

  sig.keyInfoProvider = {
    getKeyInfo: () => `<X509Data><X509Certificate>${certDerB64}</X509Certificate></X509Data>`
  };

  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${elementoLocalName}']`, action: 'after' }
  });

  return sig.getSignedXml();
}

module.exports = { assinarXml };
