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

function postar({ url, corpo, cert, tipo, soapAction }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tls = credenciaisTls(cert);
    const dados = Buffer.from(corpo, 'utf8');

    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: Object.assign({
        'Content-Type': tipo,
        'Content-Length': dados.length,
        Accept: 'application/json, text/xml'
      }, soapAction ? { SOAPAction: soapAction } : {}),
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

/* O envelope SOAP do Betha.
 *
 * Da documentação do próprio Betha (o WSDL em /dps/ws/service.wsdl):
 *   namespace  http://www.betha.com.br/e-nota-dps-service
 *   operação   RecepcionarDps  (soapAction: RecepcionarDps)
 *   entrada    RecepcionarDpsEnvio
 *
 * O QUE AINDA NÃO SEI: como a DPS vai DENTRO do envelope. O WSDL aponta para
 * schemas/nfse_dps_v01.xsd, que não consegui ler. A Sefin Nacional manda o XML
 * compactado em gzip e codificado em base64, e o Betha adotou o layout
 * nacional — então é o palpite mais provável, e é só isso: um palpite. É por
 * ele que a trava do município existe.
 */
const NS_BETHA = 'http://www.betha.com.br/e-nota-dps-service';

function envelopeRecepcionarDps(dpsXmlAssinado) {
  const zlib = require('zlib');
  const compactado = zlib.gzipSync(Buffer.from(dpsXmlAssinado, 'utf8')).toString('base64');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
      'xmlns:dps="' + NS_BETHA + '">' +
      '<soapenv:Header/><soapenv:Body>' +
        '<dps:RecepcionarDpsEnvio>' +
          '<dpsXmlGZipB64>' + compactado + '</dpsXmlGZipB64>' +
        '</dps:RecepcionarDpsEnvio>' +
      '</soapenv:Body></soapenv:Envelope>';
}

const BETHA = {
  nome: 'Betha e-Nota',
  async enviarDps(municipio, _ambiente, dpsXmlAssinado, cert) {
    const url = (municipio.url_ws || '').replace(/\/+$/, '');
    if (!url) {
      throw Object.assign(new Error(
        'O município ' + (municipio.nome || municipio.codigo_municipio) +
        ' está marcado como provedor Betha, mas sem endereço de webservice. ' +
        'Preencha na tela de Municípios.'), { status: 400 });
    }
    return postar({
      url,
      corpo: envelopeRecepcionarDps(dpsXmlAssinado),
      cert,
      tipo: 'text/xml; charset=utf-8',
      soapAction: 'RecepcionarDps'
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

/* Pode emitir aqui, e por esta empresa?
 *
 * São DUAS perguntas diferentes, e as duas precisam ser sim:
 *
 *   o gateway fala o protocolo deste provedor?  -> município, uma vez
 *   esta empresa tem autorização da prefeitura? -> empresa, uma por CNPJ
 *
 * A segunda foi corrigida depois de alguém perguntar se o credenciamento era
 * do sistema ou da empresa. Em Fazenda Rio Grande cada prestador pede a sua à
 * Secretaria de Finanças: dez clientes do escritório ali são dez
 * credenciamentos. Com a trava só no município, confirmar por causa do
 * primeiro faria os outros nove tentarem emitir sem autorização — cada
 * tentativa reservando número e falhando.
 *
 * A checagem acontece ANTES de reservar número, e é isso que protege a
 * sequência fiscal: uma recusa depois da reserva deixaria buraco. */
function conferirPodeEmitir(municipio, empresa) {
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

  /* Primeira pergunta: o gateway fala mesmo com este provedor?
     O endereço e o protocolo do Betha vieram da documentação dele, e o formato
     do que vai dentro do envelope ainda é palpite. Enquanto ninguém conferir,
     a emissão fica travada — um envio malformado reservaria o número, assinaria
     a DPS e falharia, deixando buraco na numeração. */
  if (!municipio.emissor_confirmado) {
    return `${municipio.nome || 'Este município'} emite pelo ${PROVEDORES[provedor].nome}. ` +
           `O gateway já sabe o endereço, mas ninguém confirmou ainda que a conversa ` +
           `com ele funciona. Enquanto isso a emissão fica travada de propósito: um ` +
           `envio malformado reservaria o número, assinaria a DPS e falharia, deixando ` +
           `buraco na numeração. Confirme na tela de Municípios depois de conferir com ` +
           `uma nota de valor baixo.`;
  }

  /* Segunda pergunta: ESTA empresa está credenciada?
     É por CNPJ. O escritório com dez clientes em Fazenda Rio Grande faz dez
     pedidos de autorização, um por prestador. */
  if (municipio.exige_credenciamento && empresa && !empresa.emissor_credenciado) {
    return `${empresa.razao_social || 'Esta empresa'} ainda não está credenciada na ` +
           `prefeitura de ${municipio.nome || municipio.codigo_municipio} para emitir. ` +
           `O credenciamento é POR EMPRESA, não do sistema: cada prestador pede a ` +
           `autorização à Secretaria de Finanças, que responde por e-mail. ` +
           `Depois disso, marque na ficha da empresa, aba Integração` +
           (municipio.url_portal ? ` (${municipio.url_portal})` : '') + '.';
  }
  return null;
}

module.exports = { transporte, conferirPodeEmitir, PROVEDORES };
