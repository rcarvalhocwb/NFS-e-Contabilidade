/* Extração dos valores a partir do XML da DPS.
 *
 * Os valores da nota vivem no XML transmitido, não em colunas próprias — e é
 * assim que deve ser: guardar uma cópia em coluna criaria duas fontes da
 * verdade, e a que vale é a que foi assinada.
 *
 * Fica em módulo separado do relatório para poder ser testado: é aqui que um
 * erro vira ISS calculado errado no fechamento do mês.
 */

function tagDe(xml, nome) {
  const m = xml.match(new RegExp('<' + nome + '>([^<]*)</' + nome + '>'));
  return m ? m[1] : null;
}

function numeroDe(xml, nome) {
  const v = tagDe(xml, nome);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* O tomador aparece dentro de <toma>; procurar a tag solta pegaria o nome do
   prestador ou do destinatário do IBS/CBS. */
function blocoTomador(xml) {
  const m = xml.match(/<toma>([\s\S]*?)<\/toma>/);
  return m ? m[1] : '';
}

function extrairValores(xml) {
  if (!xml) return {};
  const toma = blocoTomador(xml);

  return {
    valorServico: numeroDe(xml, 'vServ'),
    aliquota: numeroDe(xml, 'pAliq'),
    issRetido: tagDe(xml, 'tpRetISSQN') === '2',
    desconto: numeroDe(xml, 'vDescIncond'),
    // vDR é o nome atual; vAjusteBCISSQN chega com a NT 009
    deducoes: numeroDe(xml, 'vDR') !== null ? numeroDe(xml, 'vDR') : numeroDe(xml, 'vAjusteBCISSQN'),
    retPis: numeroDe(xml, 'vPis'),
    retCofins: numeroDe(xml, 'vCofins'),
    retIrrf: numeroDe(xml, 'vRetIRRF'),
    retCsll: numeroDe(xml, 'vRetCSLL'),
    retInss: numeroDe(xml, 'vRetCP'),
    tomador: toma ? tagDe(toma, 'xNome') : null,
    docTomador: toma ? (tagDe(toma, 'CNPJ') || tagDe(toma, 'CPF')) : null,
    descricao: tagDe(xml, 'xDescServ'),
    tributacaoIssqn: tagDe(xml, 'tribISSQN')
  };
}

/* Base de cálculo do ISS: valor do serviço menos desconto incondicionado e
   deduções. Desconto condicionado não reduz a base — só é abatido se a
   condição se cumprir, e aí não é matéria da nota. */
function baseCalculo(v) {
  return Math.round(((v.valorServico || 0) - (v.desconto || 0) - (v.deducoes || 0)) * 100) / 100;
}

/* Valor do ISS. Nulo quando não há alíquota na nota — que é o caso do optante
   do Simples Nacional, cujo ISS sai no DAS pela alíquota efetiva do PGDAS.
   Mostrar um valor aqui faria o contador procurar uma guia municipal que não
   existe. */
function valorIss(v) {
  if (!v.aliquota) return null;
  // Operação não tributável não gera ISS mesmo que a alíquota venha preenchida
  if (v.tributacaoIssqn && v.tributacaoIssqn !== '1') return null;
  return Math.round(baseCalculo(v) * v.aliquota) / 100;
}

function totalRetencoesFederais(v) {
  return Math.round(((v.retPis || 0) + (v.retCofins || 0) + (v.retIrrf || 0) +
                     (v.retCsll || 0) + (v.retInss || 0)) * 100) / 100;
}

module.exports = { extrairValores, baseCalculo, valorIss, totalRetencoesFederais };
