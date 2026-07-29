/* Cliente das APIs de parâmetros municipais do Sistema Nacional NFS-e.
   Autenticação mTLS com o certificado A1, como o sefinClient.

   Endpoints (Manual dos Contribuintes / Municípios, gov.br/nfse):
     GET /parametros_municipais/{codMun}            -> convênio/parametrização
     GET /parametros_municipais/{codMun}/aliquotas  -> alíquotas de ISS

   A base é config.ambientes[amb].parametrosBaseUrl — assumida igual à do Sefin
   Nacional e a confirmar com um certificado real. Todo o resto do módulo já
   funciona; só a URL exata e o formato da resposta dependem dessa confirmação. */
const https = require('https');
const config = require('../config');

function getJson({ url, pfx, passphrase }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'application/json' },
      pfx,
      passphrase,
      agent: new https.Agent({ pfx, passphrase, keepAlive: false })
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* não-JSON */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function base(ambiente) {
  const amb = config.ambientes[ambiente] || config.ambientes.homologacao;
  return amb.parametrosBaseUrl;
}

async function consultarParametros(ambiente, codigoMunicipio, cert) {
  return getJson({
    url: `${base(ambiente)}/parametros_municipais/${codigoMunicipio}`,
    pfx: cert.pfx, passphrase: cert.senha
  });
}

async function consultarAliquotas(ambiente, codigoMunicipio, cert) {
  return getJson({
    url: `${base(ambiente)}/parametros_municipais/${codigoMunicipio}/aliquotas`,
    pfx: cert.pfx, passphrase: cert.senha
  });
}

module.exports = { consultarParametros, consultarAliquotas };
