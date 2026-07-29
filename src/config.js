try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }

const AMBIENTES = {
  producao: {
    tpAmb: '1',
    sefinBaseUrl: 'https://sefin.nfse.gov.br/sefinnacional',
    adnBaseUrl: 'https://adn.nfse.gov.br',
    // Base dos endpoints de parâmetros municipais. Assumida igual à do Sefin
    // Nacional; confirmar contra o Manual dos Contribuintes (gov.br/nfse) com
    // um certificado real. Sobrescrevível por PARAMETROS_BASE_URL_PROD.
    parametrosBaseUrl: process.env.PARAMETROS_BASE_URL_PROD || 'https://sefin.nfse.gov.br/sefinnacional'
  },
  homologacao: {
    tpAmb: '2',
    sefinBaseUrl: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adnBaseUrl: 'https://adn.producaorestrita.nfse.gov.br',
    parametrosBaseUrl: process.env.PARAMETROS_BASE_URL_HOMOLOG || 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional'
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
