/* Monta o XML da DPS (Declaração de Prestação de Serviços) v1.00
   Namespace: http://www.sped.fazenda.gov.br/nfse

   Recebe um JSON simplificado do sistema e os dados da empresa cadastrada.
   Cobre o caso comum de prestação de serviço; valide contra o XSD oficial
   (gov.br/nfse > Documentação técnica) para casos especiais (exportação,
   obra, evento, deduções etc.). */

const { limparDocumento } = require('../util/documento');

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
/**
 * Bloco do ISSQN.
 *
 * `tributacaoIssqn` diz qual é a natureza da operação — e muda o que mais pode
 * ir no bloco:
 *   1 operação tributável (padrão)
 *   2 exportação de serviço      → ISS não incide, exige país de destino
 *   3 não incidência
 *   4 imunidade                  → exige o tipo de imunidade
 *   5 exigibilidade suspensa por decisão judicial → exige o processo
 *   6 exigibilidade suspensa por processo administrativo
 *
 * Sem isso o gateway só emitia operação tributável, o que deixa de fora
 * entidades imunes, exportação de serviço e quem tem liminar.
 */
function tributoMunicipal(v, optanteSN, issRetido) {
  const tipo = String(v.tributacaoIssqn || '1');
  const suspensa = ['5', '6'].includes(tipo);

  return `<tribMun>` +
    tag('tribISSQN', tipo) +
    // Imunidade exige dizer qual: livro/jornal, templo, partido, entidade...
    (tipo === '4' ? tag('tpImunidade', v.tipoImunidade) : '') +
    (suspensa ?
    `<exigSusp>` +
      tag('tpSusp', v.tipoSuspensao) +
      tag('nProcesso', v.numeroProcesso) +
    `</exigSusp>` : '') +
    // Benefício municipal (redução de base ou isenção concedida por lei local)
    (v.beneficioMunicipal ?
    `<BM>` +
      tag('tpBM', v.beneficioMunicipal.tipo) +
      tag('nBM', v.beneficioMunicipal.numero) +
      (v.beneficioMunicipal.percentualReducao !== undefined
        ? tag('pRedBCBM', dec(v.beneficioMunicipal.percentualReducao))
        : (v.beneficioMunicipal.valorReducao !== undefined
            ? tag('vRedBCBM', dec(v.beneficioMunicipal.valorReducao)) : '')) +
    `</BM>` : '') +
    tag('tpRetISSQN', issRetido ? '2' : '1') + // 1=não retido 2=retido pelo tomador
    // Optante do Simples Nacional não informa alíquota de ISS: o imposto é
    // recolhido no DAS, pela alíquota efetiva do PGDAS, não pela alíquota
    // municipal. Enviar pAliq aqui é incorreto para MEI/ME/EPP do SN.
    // Também não se informa alíquota quando o ISS não incide.
    (!optanteSN && tipo === '1' && v.aliquotaIss !== undefined
      ? tag('pAliq', dec(v.aliquotaIss)) : '') +
  `</tribMun>`;
}

/**
 * Retenções federais.
 *
 * Rotina em nota de serviço para pessoa jurídica: PIS, COFINS, IRRF, CSLL e a
 * contribuição previdenciária. Sem este bloco a nota sai sem as retenções, e o
 * tomador teria de calculá-las por fora — que é justamente o que a nota deveria
 * documentar.
 *
 * Só entra no XML quando algum valor é informado: nota sem retenção continua
 * saindo exatamente como antes.
 */
function tributosFederais(v) {
  const r = v.retencoesFederais;
  if (!r) return '';

  const temPisCofins = r.valorPis !== undefined || r.valorCofins !== undefined ||
                       r.cst !== undefined;
  const outros = ['valorRetencaoIrrf', 'valorRetencaoCsll', 'valorRetencaoPrevidencia']
    .some(k => r[k] !== undefined);
  if (!temPisCofins && !outros) return '';

  return `<tribFed>` +
    (temPisCofins ?
    `<piscofins>` +
      // CST 00 = operação tributável; a Sefin exige o código mesmo quando os
      // valores são zero.
      tag('CST', r.cst || '00') +
      (r.baseCalculo !== undefined ? tag('vBCPisCofins', dec(r.baseCalculo)) : '') +
      (r.aliquotaPis !== undefined ? tag('pAliqPis', dec(r.aliquotaPis)) : '') +
      (r.aliquotaCofins !== undefined ? tag('pAliqCofins', dec(r.aliquotaCofins)) : '') +
      (r.valorPis !== undefined ? tag('vPis', dec(r.valorPis)) : '') +
      (r.valorCofins !== undefined ? tag('vCofins', dec(r.valorCofins)) : '') +
      // 1 = não retido, 2 = retido pelo tomador
      tag('tpRetPisCofins', r.retidoPeloTomador ? '2' : '1') +
    `</piscofins>` : '') +
    (r.valorRetencaoPrevidencia !== undefined ? tag('vRetCP', dec(r.valorRetencaoPrevidencia)) : '') +
    (r.valorRetencaoIrrf !== undefined ? tag('vRetIRRF', dec(r.valorRetencaoIrrf)) : '') +
    (r.valorRetencaoCsll !== undefined ? tag('vRetCSLL', dec(r.valorRetencaoCsll)) : '') +
  `</tribFed>`;
}

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

  // CNPJ pode ser alfanumérico desde julho/2026; CPF continua só dígitos.
  const docTomador = t.cnpj ? limparDocumento(t.cnpj) : (t.cpf || '').replace(/\D/g, '');
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
      // Serviço prestado no exterior: o país entra aqui e a tributação do ISS
      // passa a ser exportação (tribISSQN = 2).
      tag('cPaisPrestacao', s.codigoPaisPrestacao) +
    `</locPrest>` +
    `<cServ>` +
      tag('cTribNac', s.codigoTributacaoNacional) +
      tag('cTribMun', s.codigoTributacaoMunicipal) +
      tag('xDescServ', s.descricao) +
      tag('cNBS', s.codigoNbs) +
    `</cServ>` +
    // Texto livre que sai impresso na nota: número do contrato, da OS, da
    // medição. O contador costuma precisar disso para amarrar nota e documento.
    (s.informacoesComplementares ?
    `<infoCompl>` +
      tag('xInfComp', s.informacoesComplementares) +
    `</infoCompl>` : '') +
  `</serv>` +
  `<valores>` +
    `<vServPrest>` +
      tag('vServ', dec(v.valorServico)) +
    `</vServPrest>` +
    (v.descontoIncondicionado !== undefined || v.descontoCondicionado !== undefined ?
    `<vDescCondIncond>` +
      (v.descontoIncondicionado !== undefined ? tag('vDescIncond', dec(v.descontoIncondicionado)) : '') +
      (v.descontoCondicionado !== undefined ? tag('vDescCond', dec(v.descontoCondicionado)) : '') +
    `</vDescCondIncond>` : '') +
    // Dedução da base de cálculo: material aplicado e subempreitada na
    // construção civil, entre outros casos previstos em lei municipal.
    (v.valorDeducoes !== undefined || v.percentualDeducoes !== undefined ?
    `<vDedRed>` +
      (v.percentualDeducoes !== undefined
        ? tag('pDR', dec(v.percentualDeducoes))
        : tag('vDR', dec(v.valorDeducoes))) +
    `</vDedRed>` : '') +
    `<trib>` +
      tributoMunicipal(v, optanteSN, issRetido) +
      tributosFederais(v) +
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
