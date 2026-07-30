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

/**
 * Bloco <totTrib>, que muda conforme o regime.
 *
 * Optante do Simples Nacional usa <pTotTribSN>: um único percentual, o da
 * alíquota efetiva do PGDAS-D (ex.: 10.43). Os demais regimes detalham por
 * esfera em <pTotTrib>, ou declaram <indTotTrib>0</indTotTrib> quando não há
 * informação de tributos a declarar.
 */
function totalTributos(v, optanteSN) {
  if (optanteSN) {
    // Sem o percentual informado, declara ausência de informação em vez de
    // inventar um número — o valor tem efeito fiscal.
    return v.percentualTotalTributosSN !== undefined
      ? tag('pTotTribSN', dec(v.percentualTotalTributosSN))
      : tag('indTotTrib', '0');
  }
  if (v.percentualTotalTributos !== undefined) {
    return `<pTotTrib>` +
      tag('pTotTribFed', dec(v.percentualTotalTributos.federal || 0)) +
      tag('pTotTribEst', dec(v.percentualTotalTributos.estadual || 0)) +
      tag('pTotTribMun', dec(v.percentualTotalTributos.municipal || 0)) +
    `</pTotTrib>`;
  }
  return tag('indTotTrib', '0');
}

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
  // 2 = MEI, 3 = ME/EPP do Simples Nacional. Muda como os tributos são
  // declarados (ver totalTributos e o pAliq mais abaixo).
  const optanteSN = [2, 3].includes(Number(empresa.op_simp_nac));

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
  // Substituição: informar a chave da NFS-e a substituir faz a Sefin cancelar
  // a original (gerando o evento de cancelamento por substituição) e autorizar
  // esta no lugar. Não existe "alterar NFS-e" — substituir é o caminho.
  (dados.substituicao && dados.substituicao.chaveSubstituida ?
  `<subst>` +
    tag('chSubstda', dados.substituicao.chaveSubstituida) +
    tag('cMotivo', dados.substituicao.codigoMotivo || '99') +
    tag('xMotivo', dados.substituicao.motivo || 'Substituicao de NFS-e') +
  `</subst>` : '') +
  `<prest>` +
    tag('CNPJ', empresa.cnpj) +
    tag('IM', empresa.inscricao_municipal) +
    // O endereço do prestador NÃO vai na DPS quando o emitente é o próprio
    // prestador (tpEmit=1, nosso caso): a Sefin recusa com
    // "E0128: O endereço nacional do prestador do serviço não deve ser
    //  informado na DPS quando o próprio prestador for o emitente da DPS."
    // O endereço vem do cadastro nacional e aparece na NFS-e autorizada.
    // Os campos de endereço da empresa seguem úteis para o painel e para
    // eventual emissão por terceiro (tpEmit diferente de 1).
    tag('fone', (empresa.telefone || '').replace(/\D/g, '') || undefined) +
    tag('email', empresa.email) +
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
        // Optante do Simples Nacional não informa alíquota de ISS: o imposto é
        // recolhido no DAS, pela alíquota efetiva do PGDAS, não pela alíquota
        // municipal. Enviar pAliq aqui é incorreto para MEI/ME/EPP do SN.
        (!optanteSN && v.aliquotaIss !== undefined ? tag('pAliq', dec(v.aliquotaIss)) : '') +
      `</tribMun>` +
      `<totTrib>` +
        totalTributos(v, optanteSN) +
      `</totTrib>` +
    `</trib>` +
  `</valores>` +
`</infDPS>` +
`</DPS>`;

  return xml;
}

module.exports = { montarDps, gerarIdDps };
