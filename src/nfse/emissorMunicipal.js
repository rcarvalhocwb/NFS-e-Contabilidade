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

/* O provedor Betha.
 *
 * O ENDEREÇO E O PROTOCOLO FORAM CONFERIDOS contra o serviço real, com o
 * certificado A1, em 03/09/2026: o serviço aceitou o mTLS e respondeu com
 * validação de esquema de verdade. O que falta para a primeira nota não é mais
 * saber falar com ele — é a DPS ser montada no namespace dele, o que este
 * módulo agora pede ao construtor.
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

/* O envelope SOAP do Betha — CONFERIDO contra o serviço real em 03/09/2026.
 *
 * O que a sondagem respondeu, e que a documentação de terceiros errava:
 *
 *   endereço   /dps/ws                                     (era /v2/nfsen)
 *   protocolo  SOAP 1.1, text/xml, SOAPAction RecepcionarDps
 *              — SOAP 1.2 devolve 500 "Unable to internalize message"
 *   namespace  http://www.betha.com.br/e-nota-dps          (o do XSD, não o
 *              do WSDL, que é ...-dps-service)
 *   a DPS vai INLINE, não compactada. O gzip+base64 que eu tinha suposto,
 *              copiando o padrão da Sefin, estava errado.
 *
 * E o achado que só apareceu enviando: o Betha recusa a DPS no namespace
 * NACIONAL. Ele quer {http://www.betha.com.br/e-nota-dps}infDPS. Como a
 * assinatura cobre o infDPS, a DPS precisa ser MONTADA E ASSINADA no namespace
 * dele — não dá para trocar o xmlns depois.
 */
const NS_BETHA = 'http://www.betha.com.br/e-nota-dps';

function envelopeRecepcionarDps(dpsXmlAssinado) {
  /* A DPS entra inteira, com a assinatura. O prólogo <?xml?> sai: um envelope
     SOAP não aceita declaração XML no meio do corpo. */
  const dps = dpsXmlAssinado.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soapenv:Body>' +
        '<RecepcionarDpsEnvio xmlns="' + NS_BETHA + '">' + dps + '</RecepcionarDpsEnvio>' +
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
      /* SOAP 1.1. O 1.2 (application/soap+xml) devolve 500 neste serviço. */
      tipo: 'text/xml; charset=utf-8',
      soapAction: 'RecepcionarDps'
    });
  },
  /* O construtor precisa saber disto ANTES de assinar: a assinatura cobre o
     infDPS, então trocar qualquer um dos dois depois quebraria a assinatura.

     A caixa do `id` foi descoberta enviando: com `Id`, o Betha responde
     "cvc-complex-type.3.2.2: O atributo 'Id' não pode aparecer no elemento
     'infDPS'". Com `id`, a validação de esquema passa inteira. */
  namespaceDps: NS_BETHA,
  atributoId: 'id'
};

/* ------------------------------------------------------------- Fiorilli
 *
 * CONFERIDO contra o serviço real (Assis/SP) em 03/09/2026, com o certificado
 * A1. Mais simples que o Betha, e por um motivo que importa: o Fiorilli aceita
 * a DPS NO NAMESPACE NACIONAL, sem alterar nada. O WSDL dele importa
 * http://www.sped.fazenda.gov.br/nfse e usa esse tipo direto.
 *
 * Ou seja: a mesma DPS que vai para a Sefin vai para cá. Muda só o envelope.
 * Enviando uma DPS sem assinatura, ele respondeu "E172: Arquivo enviado com
 * erro na assinatura" — o que prova que toda a estrutura passou e só faltava o
 * que eu tinha omitido de propósito.
 *
 * O ENDEREÇO É POR MUNICÍPIO: cada prefeitura tem o seu host
 * (nfsews.<cidade>.<uf>.gov.br). Por isso ele vem de `municipios.url_ws`, e
 * não de uma constante.
 *
 * O Fiorilli mantém também um webservice ABRASF antigo. Não é usado aqui: o
 * proprio Fiorilli documenta que emissoes em ABRASF deixaram de ser aceitas em
 * 01/08/2026, e que o nacional deve ser priorizado nas integrações.
 */
const NS_FIORILLI = 'http://www.fiorilli.com.br/nfse-nacional';

const FIORILLI = {
  nome: 'Fiorilli IssWeb',
  /* Namespace nacional: a DPS não muda. */
  namespaceDps: 'http://www.sped.fazenda.gov.br/nfse',
  atributoId: 'Id',

  async enviarDps(municipio, _ambiente, dpsXmlAssinado, cert) {
    const url = (municipio.url_ws || '').replace(/\/+$/, '');
    if (!url) {
      throw Object.assign(new Error(
        'O município ' + (municipio.nome || municipio.codigo_municipio) +
        ' está marcado como Fiorilli, mas sem endereço de webservice. Cada ' +
        'prefeitura tem o seu: preencha na tela de Municípios.'), { status: 400 });
    }
    const dps = dpsXmlAssinado.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
    return postar({
      url,
      corpo: '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
          '<soapenv:Body><RecepcionarDpsEnvio xmlns="' + NS_FIORILLI + '">' +
            dps +
          '</RecepcionarDpsEnvio></soapenv:Body></soapenv:Envelope>',
      cert,
      tipo: 'text/xml; charset=utf-8',
      /* A ação difere da operação na caixa: a operação é `recepcionarDps` e o
         soapAction é `recepcionarDPS`. Está assim no WSDL. */
      soapAction: 'recepcionarDPS'
    });
  }
};

const SEFIN = {
  nome: 'Sefin Nacional',
  namespaceDps: 'http://www.sped.fazenda.gov.br/nfse',
  atributoId: 'Id',
  enviarDps(_municipio, ambiente, dpsXmlAssinado, cert) {
    return sefin.enviarDps(ambiente, dpsXmlAssinado, cert);
  }
};

const PROVEDORES = { sefin: SEFIN, betha: BETHA, fiorilli: FIORILLI };

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
