const https = require('https');
const sefin = require('./sefinClient');

/* Para onde a DPS assinada é transmitida.
 *
 * Até aqui só havia um destino: a Sefin Nacional. Município com emissor
 * próprio era bloqueado antes de reservar número.
 *
 * O que mudou o quadro: Fazenda Rio Grande manteve o Betha e-Nota, mas o
 * adaptou ao PADRÃO NACIONAL. É a mesma DPS que este gateway já monta e
 * assina, entregue noutro endereço. Não é outro documento — é outro carteiro.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: não monta DPS diferente, não assina diferente,
 * não conhece leiaute municipal. Se um dia aparecer um município com layout
 * ABRASF de verdade, ele não entra aqui — entra num construtor próprio, e essa
 * é uma obra maior.
 */

/* ---------------------------------------------------------------- Betha */

/* O provedor Betha, com o layout nacional.
 *
 * ATENÇÃO: o endereço veio de documentação de terceiros e NÃO foi testado
 * daqui com certificado e credenciamento. É por isso que o município carrega
 * `emissor_confirmado`, e é ele — não este código — que autoriza a primeira
 * emissão. Este projeto já assumiu dois endpoints da Sefin que não existiam:
 * o /eventos devolve 405 e o /parametros_municipais devolve 501, os dois
 * conferidos com certificado real.
 */
function credenciaisTls(cert) {
  if (cert && cert.keyPem && cert.certPem) {
    return { key: cert.keyPem, cert: cert.certPem };
  }
  return { pfx: cert.pfx, passphrase: cert.senha };
}

function postar({ url, corpo, cert, tipo }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tls = credenciaisTls(cert);
    const dados = Buffer.from(corpo, 'utf8');

    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': tipo,
        'Content-Length': dados.length,
        Accept: 'application/json, text/xml'
      },
      ...tls,
      agent: new https.Agent({ ...tls, keepAlive: false })
    }, res => {
      let texto = '';
      res.on('data', c => (texto += c));
      res.on('end', () => {
        let json = null;
        try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* pode ser XML */ }
        resolve({ status: res.statusCode, json, raw: texto });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('tempo esgotado')); });
    req.end(dados);
  });
}

const BETHA = {
  nome: 'Betha e-Nota',
  async enviarDps(municipio, _ambiente, dpsXmlAssinado, cert) {
    const base = (municipio.url_ws || '').replace(/\/+$/, '');
    if (!base) {
      throw Object.assign(new Error(
        'O município ' + (municipio.nome || municipio.codigo_municipio) +
        ' está marcado como provedor Betha, mas sem endereço de webservice. ' +
        'Preencha na tela de Municípios.'), { status: 400 });
    }
    return postar({
      url: base + '/v2/nfsen',
      corpo: dpsXmlAssinado,
      cert,
      tipo: 'application/xml; charset=utf-8'
    });
  }
};

const SEFIN = {
  nome: 'Sefin Nacional',
  enviarDps(_municipio, ambiente, dpsXmlAssinado, cert) {
    return sefin.enviarDps(ambiente, dpsXmlAssinado, cert);
  }
};

const PROVEDORES = { sefin: SEFIN, betha: BETHA };

/* Quem transmite por este município. Sem município cadastrado, a Sefin — que
   é como sempre funcionou e cobre a maioria. */
function transporte(municipio) {
  const p = (municipio && municipio.provedor) || 'sefin';
  return PROVEDORES[p] || SEFIN;
}

/* Pode emitir aqui?
 *
 * A checagem acontece ANTES de reservar número, e é isso que protege a
 * sequência fiscal: uma recusa depois da reserva deixaria buraco. */
function conferirPodeEmitir(municipio) {
  if (!municipio) return null;                       // desconhecido: segue pela Sefin

  const provedor = municipio.provedor || 'sefin';
  if (provedor === 'sefin') {
    if (municipio.modo_emissao === 'proprio') {
      /* Emissor próprio SEM provedor implementado: continua bloqueado, com o
         nome do lugar e para onde ir — deixar a pessoa com a nota na mão e sem
         saída é pior do que não emitir. */
      const onde = [
        municipio.emissor ? 'pelo ' + municipio.emissor : 'pelo sistema da prefeitura',
        municipio.url_portal ? '(' + municipio.url_portal + ')' : ''
      ].filter(Boolean).join(' ');
      return `${municipio.nome || 'Este município'} (${municipio.codigo_municipio}) ` +
             `não emite pelo Sistema Nacional: mantém emissor próprio. A nota ` +
             `desta empresa sai ${onde}. ` +
             (municipio.observacao || 'Confira o credenciamento junto à prefeitura.');
    }
    return null;
  }

  if (!municipio.emissor_confirmado) {
    return `${municipio.nome || 'Este município'} emite pelo ${PROVEDORES[provedor].nome}, ` +
           `e o gateway já sabe falar com ele — mas ninguém confirmou ainda que o ` +
           `credenciamento foi feito e que o endereço responde. Enquanto isso, a ` +
           `emissão fica travada de propósito: um endereço errado reservaria o ` +
           `número, assinaria a DPS e falharia, deixando buraco na numeração. ` +
           `Confirme na tela de Municípios depois de fazer o credenciamento ` +
           (municipio.url_portal ? `(${municipio.url_portal})` : 'na prefeitura') + '.';
  }
  return null;
}

module.exports = { transporte, conferirPodeEmitir, PROVEDORES };
