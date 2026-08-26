/* Portal de mentira: só para provar o laço de comunicação em desenvolvimento.
 *
 * Faz o papel do site do cliente — serve solicitações pendentes e recebe de
 * volta o desfecho. Não vai para a instalação; existe para o teste de ponta a
 * ponta ser feito com HTTP de verdade, e não com um fetch fingido.
 *
 *   node scripts/portal-de-mentira.js [porta]
 */
const http = require('http');

const PORTA = Number(process.argv[2] || 4599);
const CHAVE = process.env.PORTAL_CHAVE || 'chave-de-teste';

// A fila que o portal "tem para entregar", e o que voltou do gateway
const pendentes = new Map();
const resultados = [];
let cadastro = null;

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json',
                          'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

const servidor = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // O portal exige a chave da instalação, como o de verdade exigiria
  if ((req.headers.authorization || '') !== 'Bearer ' + CHAVE) {
    return json(res, 401, { erro: 'chave inválida' });
  }

  if (req.method === 'GET' && u.pathname === '/solicitacoes') {
    const limite = Number(u.searchParams.get('limite')) || 10;
    return json(res, 200, { solicitacoes: [...pendentes.values()].slice(0, limite) });
  }

  const m = u.pathname.match(/^\/solicitacoes\/([^/]+)\/resultado$/);
  if (req.method === 'POST' && m) {
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      const id = decodeURIComponent(m[1]);
      let dados = null;
      try { dados = JSON.parse(corpo); } catch (_) { dados = { bruto: corpo }; }
      resultados.push({ id, ...dados, em: new Date().toISOString() });
      // Desfecho recebido: o portal para de oferecer a solicitação
      pendentes.delete(id);
      json(res, 200, { ok: true });
    });
    return;
  }

  // Cadastro replicado: o portal guarda o retrato inteiro que chegou
  if (req.method === 'POST' && u.pathname === '/cadastro') {
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      try { cadastro = JSON.parse(corpo); } catch (_) { cadastro = { bruto: corpo }; }
      json(res, 200, { ok: true, versao: cadastro && cadastro.versao });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/_cadastro') {
    return json(res, 200, cadastro || {});
  }

  // Bocas de controle do teste (o portal de verdade não teria)
  if (req.method === 'POST' && u.pathname === '/_enfileirar') {
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      const s = JSON.parse(corpo);
      pendentes.set(s.id, s);
      json(res, 201, { enfileiradas: pendentes.size });
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/_resultados') {
    return json(res, 200, { resultados, pendentes: [...pendentes.keys()] });
  }

  json(res, 404, { erro: 'não existe' });
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log('portal de mentira em http://127.0.0.1:' + PORTA + ' (chave: ' + CHAVE + ')');
});
