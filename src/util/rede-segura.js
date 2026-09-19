/* Barreira contra SSRF: impede o gateway de ser usado para alcançar a rede
 * interna do servidor.
 *
 * O webhook é uma URL que o cliente escolhe e o servidor chama sozinho quando
 * uma nota muda de estado. Sem filtro, um administrador de escritório aponta o
 * webhook para `http://169.254.169.254/...` (metadados da nuvem),
 * `http://127.0.0.1:5432` (o banco) ou um serviço interno que só o servidor
 * alcança — e transforma o gateway num proxy para dentro da infraestrutura.
 *
 * A defesa não é conferir a URL no cadastro: um nome que resolve para IP
 * público no cadastro pode resolver para 127.0.0.1 na hora da entrega (DNS
 * rebinding). A defesa é validar o IP REALMENTE resolvido, no momento de
 * conectar. `lookupSeguro` faz isso e serve como a opção `lookup` do
 * http/https.request — o mesmo caminho que o socket usa para resolver o nome.
 */
const dns = require('dns');

/* IPv4 que não devem ser alcançados a partir do servidor. */
function ipv4Privado(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // 10/8 privado
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + metadados da nuvem
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 privado
  if (a === 192 && b === 168) return true;         // 192.168/16 privado
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true;                       // multicast/reservado + 255.255.255.255
  return false;
}

/* IPv6, incluindo o IPv4 embutido (::ffff:1.2.3.4). */
function ipv6Privado(ip) {
  const x = ip.toLowerCase().split('%')[0];        // tira zona (fe80::1%eth0)
  if (x === '::1' || x === '::') return true;       // loopback / não especificado
  const mapv4 = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapv4) return ipv4Privado(mapv4[1]);          // IPv4 mapeado
  if (x.startsWith('fe8') || x.startsWith('fe9') ||
      x.startsWith('fea') || x.startsWith('feb')) return true; // fe80::/10 link-local
  if (x.startsWith('fc') || x.startsWith('fd')) return true;   // fc00::/7 ULA
  return false;
}

function ehIpPrivado(ip) {
  return ip.includes(':') ? ipv6Privado(ip) : ipv4Privado(ip);
}

/* Substituta de dns.lookup que recusa endereço interno. Compatível com a opção
   `lookup` de http/https.request: mesma assinatura, mesmo comportamento —
   exceto que estoura em vez de entregar um endereço da rede interna. */
function lookupSeguro(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, options || {}, (err, address, family) => {
    if (err) return callback(err);
    const lista = Array.isArray(address) ? address : [{ address, family }];
    for (const e of lista) {
      if (ehIpPrivado(e.address)) {
        return callback(Object.assign(
          new Error(`destino recusado: ${hostname} aponta para endereço interno (${e.address})`),
          { code: 'SSRF_BLOQUEADO', status: 400 }));
      }
    }
    callback(null, address, family);
  });
}

module.exports = { ehIpPrivado, lookupSeguro };
