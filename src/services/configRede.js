const os = require('os');
const forge = require('node-forge');
const db = require('../db');
const { encrypt, decrypt } = require('../secretbox');

/* De onde o painel aceita conexão, e se ela é criptografada.
 *
 * Isto vivia só na variável HOST do .env. Numa máquina de contabilidade,
 * mexer em arquivo de configuração à mão é onde o operador trava — e onde
 * alguém apaga uma linha sem querer. Agora é tela.
 *
 * O QUE ESTÁ EM JOGO: sem HTTPS, a senha de quem abre o painel de OUTRO
 * computador do escritório atravessa a rede em texto puro. Enquanto só esta
 * máquina opera, isso não existe. No dia em que a contadora abrir do
 * computador dela, passa a existir — e ninguém percebe.
 *
 * O QUE O CERTIFICADO PRÓPRIO RESOLVE E O QUE NÃO RESOLVE: ele criptografa a
 * conexão, e é isso que tira a senha do texto puro. Ele NÃO prova identidade
 * para o navegador, que vai avisar que não conhece quem assinou — alguém
 * aceita uma vez em cada computador. Para rede de escritório é a troca certa;
 * na internet não seria, mas o gateway não vai para a internet.
 */

const PADRAO = { escuta: 'rede', https_ativo: false, https_porta: 3443 };

async function ler() {
  const r = await db.query(
    `SELECT escuta, https_ativo, https_porta, cert_origem, cert_assunto,
            cert_nomes, cert_valido_ate, cert_gerado_em, atualizado_em,
            (cert_pem_cifrado IS NOT NULL) AS tem_certificado
       FROM config_rede WHERE id = TRUE`);
  return r.rows[0] || Object.assign({}, PADRAO, { tem_certificado: false });
}

/* Onde o servidor deve escutar. Lido na subida.
 *
 * A variável de ambiente continua vencendo: numa máquina em que o painel
 * ficou inalcançável por configuração errada, `HOST=127.0.0.1` na linha de
 * comando é o jeito de voltar a entrar sem precisar do painel — que é
 * justamente o que não abre. */
async function paraSubir() {
  if (process.env.HOST) {
    return { host: process.env.HOST, https: null, origem: 'HOST no ambiente' };
  }
  let c;
  try {
    c = await ler();
  } catch (e) {
    /* Sem banco, o gateway ainda precisa subir para mostrar o erro na tela. */
    return { host: '0.0.0.0', https: null, origem: 'padrão (banco indisponível)' };
  }

  const host = c.escuta === 'local' ? '127.0.0.1' : '0.0.0.0';
  if (!c.https_ativo || !c.tem_certificado) {
    return { host, https: null, origem: 'configuração' };
  }

  const cred = await credenciais();
  if (!cred) return { host, https: null, origem: 'configuração (certificado ilegível)' };
  return { host, https: { porta: c.https_porta, ...cred }, origem: 'configuração' };
}

async function credenciais() {
  const r = await db.query(
    'SELECT cert_pem_cifrado, chave_pem_cifrada FROM config_rede WHERE id = TRUE');
  const linha = r.rows[0];
  if (!linha || !linha.cert_pem_cifrado || !linha.chave_pem_cifrada) return null;
  try {
    return {
      cert: decrypt(linha.cert_pem_cifrado).toString('utf8'),
      key: decrypt(linha.chave_pem_cifrada).toString('utf8')
    };
  } catch (_) {
    /* MASTER_KEY trocada depois de o certificado ser guardado. */
    return null;
  }
}

/* Os endereços por onde esta máquina é alcançável.
   Entram no certificado como nomes alternativos: sem eles, o navegador recusa
   mesmo com o certificado aceito, porque o endereço digitado não bate. */
function enderecosDaMaquina() {
  const nomes = new Set(['localhost']);
  const ips = new Set(['127.0.0.1']);
  try { nomes.add(os.hostname()); } catch (_) { /* sem nome: os IPs bastam */ }
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family === 'IPv4' && !i.internal) ips.add(i.address);
    }
  }
  return { nomes: [...nomes], ips: [...ips] };
}

/* ------------------------------------------------------- gerar o certificado */

function gerarAutoAssinado(anos = 3) {
  const { nomes, ips } = enderecosDaMaquina();
  const par = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = par.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + anos);

  const quem = [
    { name: 'commonName', value: nomes[1] || 'nfse-gateway' },
    { name: 'organizationName', value: 'NFS-e Gateway' },
    { shortName: 'OU', value: 'Painel do escritorio' },
    { name: 'countryName', value: 'BR' }
  ];
  cert.setSubject(quem);
  cert.setIssuer(quem);            // auto-assinado: emissor é o próprio

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      /* type 2 = DNS, type 7 = IP. O navegador confere o endereço digitado
         contra esta lista, e não contra o commonName — sem os IPs aqui, abrir
         por http://192.168.x.x seria recusado mesmo com o certificado aceito. */
      altNames: [
        ...nomes.map(n => ({ type: 2, value: n })),
        ...ips.map(ip => ({ type: 7, ip }))
      ]
    }
  ]);

  cert.sign(par.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    chavePem: forge.pki.privateKeyToPem(par.privateKey),
    assunto: quem[0].value,
    nomes: [...nomes, ...ips].join(', '),
    validoAte: cert.validity.notAfter
  };
}

async function gerarCertificado() {
  const g = gerarAutoAssinado();
  await db.query(
    `UPDATE config_rede SET
       cert_pem_cifrado = $1, chave_pem_cifrada = $2, cert_origem = 'gerado',
       cert_assunto = $3, cert_nomes = $4, cert_valido_ate = $5,
       cert_gerado_em = now(), atualizado_em = now()
     WHERE id = TRUE`,
    [encrypt(g.certPem), encrypt(g.chavePem), g.assunto, g.nomes, g.validoAte]);
  return { assunto: g.assunto, nomes: g.nomes, validoAte: g.validoAte };
}

/* Certificado do escritório, quando existe um de verdade — de uma autoridade
   interna, por exemplo. Aí o navegador não reclama. */
async function guardarCertificado(certPem, chavePem) {
  let cert;
  try {
    cert = forge.pki.certificateFromPem(certPem);
    forge.pki.privateKeyFromPem(chavePem);
  } catch (e) {
    throw Object.assign(new Error(
      'Não consegui ler o certificado ou a chave. Os dois precisam estar em ' +
      'PEM — o texto que começa com "-----BEGIN". ' + e.message), { status: 400 });
  }

  const cn = (cert.subject.getField('CN') || {}).value || 'certificado enviado';
  await db.query(
    `UPDATE config_rede SET
       cert_pem_cifrado = $1, chave_pem_cifrada = $2, cert_origem = 'enviado',
       cert_assunto = $3, cert_nomes = $4, cert_valido_ate = $5,
       cert_gerado_em = now(), atualizado_em = now()
     WHERE id = TRUE`,
    [encrypt(certPem), encrypt(chavePem), cn, cn, cert.validity.notAfter]);
  return { assunto: cn, validoAte: cert.validity.notAfter };
}

/* ------------------------------------------------------------------ salvar */

async function salvar(dados = {}) {
  const campos = [];
  const valores = [];
  const põe = (col, v) => { valores.push(v); campos.push(col + ' = $' + valores.length); };

  if (dados.escuta !== undefined) {
    if (!['local', 'rede'].includes(dados.escuta)) {
      throw Object.assign(new Error('Escolha "local" ou "rede".'), { status: 400 });
    }
    põe('escuta', dados.escuta);
  }
  if (dados.httpsPorta !== undefined) {
    const p = Number(dados.httpsPorta);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      throw Object.assign(new Error('A porta vai de 1024 a 65535.'), { status: 400 });
    }
    põe('https_porta', p);
  }
  if (dados.httpsAtivo !== undefined) {
    /* Ligar HTTPS sem certificado deixaria o painel sem subir em HTTPS e sem
       dizer por quê. Melhor recusar aqui, com o caminho. */
    if (dados.httpsAtivo) {
      const c = await ler();
      if (!c.tem_certificado) {
        throw Object.assign(new Error(
          'Antes de ligar o HTTPS é preciso ter um certificado. Clique em ' +
          '"Gerar certificado próprio" logo abaixo, ou envie o do escritório.'),
          { status: 400 });
      }
    }
    põe('https_ativo', !!dados.httpsAtivo);
  }

  if (campos.length) {
    valores.push(true);
    await db.query(
      `UPDATE config_rede SET ${campos.join(', ')}, atualizado_em = now()
        WHERE id = $${valores.length}`, valores);
  }
  return ler();
}

/* O que muda só depois de reiniciar. A porta em que um servidor escuta não se
   troca com ele no ar — e prometer que trocou seria pior do que avisar. */
function precisaReiniciar(antes, depois) {
  return antes.escuta !== depois.escuta ||
         antes.https_ativo !== depois.https_ativo ||
         antes.https_porta !== depois.https_porta;
}

module.exports = {
  ler, salvar, paraSubir, credenciais, gerarCertificado, guardarCertificado,
  enderecosDaMaquina, precisaReiniciar
};
