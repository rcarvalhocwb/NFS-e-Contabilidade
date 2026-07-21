/* Monta o XML da DPS (Declaração de Prestação de Serviços) v1.00
   Namespace: http://www.sped.fazenda.gov.br/nfse

   Recebe um JSON simplificado do sistema e os dados da empresa cadastrada.
   Cobre o caso comum de prestação de serviço; valide contra o XSD oficial
   (gov.br/nfse > Documentação técnica) para casos especiais (exportação,
   obra, evento, deduções etc.). */

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function tag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${name}>${esc(value)}</${name}>`;
}
function dec(v) { return Number(v).toFixed(2); }

/* Id da DPS: "DPS" + cMun(7) + tipoInsc(1: 1=CPF 2=CNPJ) + inscrição(14) + série(5) + número(15) = 45 */
function gerarIdDps({ codigoMunicipio, cnpj, serie, numero }) {
  const insc = cnpj.padStart(14, '0');
  const tipo = cnpj.length === 11 ? '1' : '2';
  return 'DPS' + codigoMunicipio + tipo + insc +
    String(serie).padStart(5, '0') + String(numero).padStart(15, '0');
}

function fmtDataHoraLocal(d = new Date()) {
  // ISO com offset local (ex.: 2026-07-21T10:00:00-03:00)
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    sign + p(tz / 60) + ':' + p(tz % 60);
}

/**
 * @param empresa  registro da tabela empresas
 * @param dados    JSON enviado pelo sistema:
 * {
 *   numero, serie (opcionais - senão usa sequência da empresa),
 *   dataCompetencia: "2026-07-21",
 *   tomador: { cnpj|cpf, razaoSocial, email, telefone,
 *              endereco: { codigoMunicipio, cep, logradouro, numero, complemento, bairro } },
 *   servico: { codigoTributacaoNacional: "010101", codigoTributacaoMunicipal,
 *              descricao, codigoMunicipioPrestacao },
 *   valores: { valorServico, aliquotaIss, issRetido: false, descontoIncondicionado }
 * }
 * @param opts { tpAmb, verAplic, idDps, numero, serie }
 */
function montarDps(empresa, dados, opts) {
  const serie = opts.serie;
  const numero = opts.numero;
  const idDps = opts.idDps;
  const t = dados.tomador || {};
  const s = dados.servico || {};
  const v = dados.valores || {};
  const endereco = t.endereco || {};

  const docTomador = (t.cnpj || t.cpf || '').replace(/\D/g, '');
  const tagDocTomador = t.cnpj ? tag('CNPJ', docTomador) : (t.cpf ? tag('CPF', docTomador) : '');

  const issRetido = v.issRetido === true;

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>` +
`<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">` +
`<infDPS Id="${idDps}">` +
  tag('tpAmb', opts.tpAmb) +
  tag('dhEmi', fmtDataHoraLocal()) +
  tag('verAplic', opts.verAplic) +
  tag('serie', serie) +
  tag('nDPS', numero) +
  tag('dCompet', dados.dataCompetencia || new Date().toISOString().slice(0, 10)) +
  tag('tpEmit', '1') + // 1 = emissão pelo prestador
  tag('cLocEmi', empresa.codigo_municipio) +
  `<prest>` +
    tag('CNPJ', empresa.cnpj) +
    tag('IM', empresa.inscricao_municipal) +
    `<regTrib>` +
      tag('opSimpNac', empresa.op_simp_nac) +
      (Number(empresa.op_simp_nac) === 3 ? tag('regApTribSN', dados.regApTribSN || '1') : '') +
      tag('regEspTrib', empresa.reg_esp_trib) +
    `</regTrib>` +
  `</prest>` +
  (docTomador ?
  `<toma>` +
    tagDocTomador +
    tag('xNome', t.razaoSocial) +
    (endereco.logradouro ?
    `<end>` +
      `<endNac>` +
        tag('cMun', endereco.codigoMunicipio) +
        tag('CEP', (endereco.cep || '').replace(/\D/g, '')) +
      `</endNac>` +
      tag('xLgr', endereco.logradouro) +
      tag('nro', endereco.numero) +
      tag('xCpl', endereco.complemento) +
      tag('xBairro', endereco.bairro) +
    `</end>` : '') +
    tag('fone', t.telefone) +
    tag('email', t.email) +
  `</toma>` : '') +
  `<serv>` +
    `<locPrest>` +
      tag('cLocPrestacao', s.codigoMunicipioPrestacao || empresa.codigo_municipio) +
    `</locPrest>` +
    `<cServ>` +
      tag('cTribNac', s.codigoTributacaoNacional) +
      tag('cTribMun', s.codigoTributacaoMunicipal) +
      tag('xDescServ', s.descricao) +
    `</cServ>` +
  `</serv>` +
  `<valores>` +
    `<vServPrest>` +
      tag('vServ', dec(v.valorServico)) +
    `</vServPrest>` +
    (v.descontoIncondicionado ?
    `<vDescCondIncond>` +
      tag('vDescIncond', dec(v.descontoIncondicionado)) +
    `</vDescCondIncond>` : '') +
    `<trib>` +
      `<tribMun>` +
        tag('tribISSQN', '1') + // 1 = operação tributável
        tag('tpRetISSQN', issRetido ? '2' : '1') + // 1=não retido 2=retido pelo tomador
        (v.aliquotaIss !== undefined ? tag('pAliq', dec(v.aliquotaIss)) : '') +
      `</tribMun>` +
      `<totTrib>` +
        (v.percentualTotalTributos !== undefined
          ? `<pTotTrib>` +
              tag('pTotTribFed', dec(v.percentualTotalTributos.federal || 0)) +
              tag('pTotTribEst', dec(v.percentualTotalTributos.estadual || 0)) +
              tag('pTotTribMun', dec(v.percentualTotalTributos.municipal || 0)) +
            `</pTotTrib>`
          : tag('indTotTrib', '0')) +
      `</totTrib>` +
    `</trib>` +
  `</valores>` +
`</infDPS>` +
`</DPS>`;

  return xml;
}

module.exports = { montarDps, gerarIdDps };
