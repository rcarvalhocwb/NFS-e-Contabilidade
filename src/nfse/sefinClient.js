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

/* Credenciais TLS a partir do certificado carregado.
   Usa key/cert em PEM, e não o .pfx: o OpenSSL 3 (Node 20+) recusa PKCS#12 com
   criptografia legada (RC2/3DES) — padrão dos certificados A1 brasileiros — com
   "Unsupported PKCS12 PFX data". O node-forge extrai chave e certificado, que o
   OpenSSL aceita sem ressalva. Mantém o .pfx como alternativa para certificados
   em formato moderno. */
function credenciaisTls(cert) {
  if (cert && cert.keyPem && cert.certPem) {
    return { key: cert.keyPem, cert: cert.certPem };
  }
  return { pfx: cert.pfx, passphrase: cert.senha };
}

function request({ method, url, body, cert }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const tls = credenciaisTls(cert);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      ...tls,
      // agente dedicado para não vazar o certificado entre empresas
      agent: new https.Agent({ ...tls, keepAlive: false })
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
    cert
  });
  if (r.json && r.json.nfseXmlGZipB64) r.json.nfseXml = gunzipB64(r.json.nfseXmlGZipB64);
  return r;
}

async function consultarNfse(ambiente, chaveAcesso, cert) {
  const r = await request({
    method: 'GET',
    url: `${baseUrl(ambiente)}/nfse/${chaveAcesso}`,
    cert
  });
  if (r.json && r.json.nfseXmlGZipB64) r.json.nfseXml = gunzipB64(r.json.nfseXmlGZipB64);
  return r;
}

/* Eventos registrados numa NFS-e: cancelamento, substituição, e o que mais a
   Sefin tiver anotado. É a versão dela da história — o gateway conhece só os
   eventos que ele mesmo enviou, e uma nota pode ser cancelada por outro
   caminho. */
async function consultarEventos(ambiente, chaveAcesso, cert) {
  const r = await request({
    method: 'GET',
    url: `${baseUrl(ambiente)}/nfse/${chaveAcesso}/eventos`,
    cert
  });
  // Cada evento vem com o XML gzipado; devolve também decodificado.
  if (r.json && Array.isArray(r.json.eventos)) {
    r.json.eventos = r.json.eventos.map(ev => {
      if (!ev || !ev.eventoXmlGZipB64) return ev;
      try { return Object.assign({}, ev, { eventoXml: gunzipB64(ev.eventoXmlGZipB64) }); }
      catch (_) { return ev; }   // evento ilegível não invalida os demais
    });
  }
  return r;
}

/* Consulta DPS por id: útil para verificar se uma DPS já virou NFS-e (idempotência). */
async function consultarDps(ambiente, idDps, cert) {
  return request({
    method: 'GET',
    url: `${baseUrl(ambiente)}/dps/${idDps}`,
    cert
  });
}

/* Registra evento (ex.: cancelamento) para uma NFS-e. */
async function enviarEvento(ambiente, chaveAcesso, eventoXmlAssinado, cert) {
  const r = await request({
    method: 'POST',
    url: `${baseUrl(ambiente)}/nfse/${chaveAcesso}/eventos`,
    body: { pedidoRegistroEventoXmlGZipB64: gzipB64(eventoXmlAssinado) },
    cert
  });
  if (r.json && r.json.eventoXmlGZipB64) r.json.eventoXml = gunzipB64(r.json.eventoXmlGZipB64);
  return r;
}

/* DANFSe (PDF) via ADN. */
function urlDanfse(ambiente, chaveAcesso) {
  return `${config.ambientes[ambiente].adnBaseUrl}/danfse/${chaveAcesso}`;
}

module.exports = { enviarDps, consultarNfse, consultarDps, enviarEvento, urlDanfse, gzipB64, gunzipB64, consultarEventos};
