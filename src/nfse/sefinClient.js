/* Cliente HTTP da API Sefin Nacional (Portal Nacional NFS-e).
   Autenticação mTLS com o certificado A1 (.pfx) da empresa.
   Payloads XML trafegam comprimidos (gzip) e codificados em base64. */
const https = require('https');
const zlib = require('zlib');
const config = require('../config');

function gzipB64(xml) {
  return zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}
function gunzipB64(b64) {
  return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
}

function request({ method, url, body, pfx, passphrase }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      pfx,
      passphrase,
      // agente dedicado para não vazar o certificado entre empresas
      agent: new https.Agent({ pfx, passphrase, keepAlive: false })
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* resposta não-JSON */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function baseUrl(ambiente) {
  return config.ambientes[ambiente].sefinBaseUrl;
}

/* Envia a DPS assinada. Resposta síncrona: chaveAcesso + nfseXmlGZipB64. */
async function enviarDps(ambiente, dpsXmlAssinado, cert) {
  const r = await request({
    method: 'POST',
    url: `${baseUrl(ambiente)}/nfse`,
    body: { dpsXmlGZipB64: gzipB64(dpsXmlAssinado) },
    pfx: cert.pfx, passphrase: cert.senha
  });
  if (r.json && r.json.nfseXmlGZipB64) r.json.nfseXml = gunzipB64(r.json.nfseXmlGZipB64);
  return r;
}

async function consultarNfse(ambiente, chaveAcesso, cert) {
  const r = await request({
    method: 'GET',
    url: `${baseUrl(ambiente)}/nfse/${chaveAcesso}`,
    pfx: cert.pfx, passphrase: cert.senha
  });
  if (r.json && r.json.nfseXmlGZipB64) r.json.nfseXml = gunzipB64(r.json.nfseXmlGZipB64);
  return r;
}

/* Consulta DPS por id: útil para verificar se uma DPS já virou NFS-e (idempotência). */
async function consultarDps(ambiente, idDps, cert) {
  return request({
    method: 'GET',
    url: `${baseUrl(ambiente)}/dps/${idDps}`,
    pfx: cert.pfx, passphrase: cert.senha
  });
}

/* Registra evento (ex.: cancelamento) para uma NFS-e. */
async function enviarEvento(ambiente, chaveAcesso, eventoXmlAssinado, cert) {
  const r = await request({
    method: 'POST',
    url: `${baseUrl(ambiente)}/nfse/${chaveAcesso}/eventos`,
    body: { pedidoRegistroEventoXmlGZipB64: gzipB64(eventoXmlAssinado) },
    pfx: cert.pfx, passphrase: cert.senha
  });
  if (r.json && r.json.eventoXmlGZipB64) r.json.eventoXml = gunzipB64(r.json.eventoXmlGZipB64);
  return r;
}

/* DANFSe (PDF) via ADN. */
function urlDanfse(ambiente, chaveAcesso) {
  return `${config.ambientes[ambiente].adnBaseUrl}/danfse/${chaveAcesso}`;
}

module.exports = { enviarDps, consultarNfse, consultarDps, enviarEvento, urlDanfse, gzipB64, gunzipB64 };
