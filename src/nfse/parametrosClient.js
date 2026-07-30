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

/* Mesma razão do sefinClient: OpenSSL 3 recusa o PKCS#12 legado dos A1
   brasileiros, então usamos key/cert em PEM extraídos pelo node-forge. */
function credenciaisTls(cert) {
  if (cert && cert.keyPem && cert.certPem) {
    return { key: cert.keyPem, cert: cert.certPem };
  }
  return { pfx: cert.pfx, passphrase: cert.senha };
}

function getJson({ url, cert }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tls = credenciaisTls(cert);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'application/json' },
      ...tls,
      agent: new https.Agent({ ...tls, keepAlive: false })
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

/* O caminho é "parametrosmunicipais" (sem separador). Confirmado sondando a
   produção restrita com certificado real: essa forma devolve 501 (rota
   reconhecida, não implementada naquele ambiente), enquanto
   "parametros_municipais" devolve 404 (rota inexistente). */
async function consultarParametros(ambiente, codigoMunicipio, cert) {
  return getJson({
    url: `${base(ambiente)}/parametrosmunicipais/${codigoMunicipio}`,
    cert
  });
}

async function consultarAliquotas(ambiente, codigoMunicipio, cert) {
  return getJson({
    url: `${base(ambiente)}/parametrosmunicipais/${codigoMunicipio}/aliquotas`,
    cert
  });
}

module.exports = { consultarParametros, consultarAliquotas };
