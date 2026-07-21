try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }

const AMBIENTES = {
  producao: {
    tpAmb: '1',
    sefinBaseUrl: 'https://sefin.nfse.gov.br/sefinnacional',
    adnBaseUrl: 'https://adn.nfse.gov.br'
  },
  homologacao: {
    tpAmb: '2',
    sefinBaseUrl: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adnBaseUrl: 'https://adn.producaorestrita.nfse.gov.br'
  }
};

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  apiKey: process.env.GATEWAY_API_KEY,
  masterKey: process.env.MASTER_KEY,
  verAplic: process.env.VER_APLIC || 'nfse-gateway/1.0',
  xmlSigAlg: (process.env.XML_SIG_ALG || 'sha1').toLowerCase(),
  ambientes: AMBIENTES
};
