/* Leitura de uma DPS assinada de volta para o JSON que a originou.
 *
 * Para quê: substituir uma NFS-e é emitir outra apontando para a anterior — não
 * existe "alterar". O gateway guarda a DPS transmitida, mas não guarda o JSON
 * que o sistema (ou a tela) enviou, então sem isto o operador teria que
 * redigitar cliente, serviço e valores só para corrigir uma linha.
 *
 * Extração por regex com escopo, como no gerador do DANFSe: a DPS é montada
 * pelo próprio gateway, com estrutura fixa e sem namespaces por elemento —
 * trazer um parser XML completo só para isto não se paga.
 */

/* `(\\s[^>]*)?` porque nem toda tag é nua: <infDPS Id="DPS..."> carrega o Id, e
   sem isso o bloco inteiro deixava de casar — a leitura voltava tudo nulo. */
function dentro(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[2] : '';
}
function valor(xml, tag) {
  if (!xml) return null;
  const m = xml.match(new RegExp(`<${tag}(\\s[^>]*)?>([^<]*)</${tag}>`));
  return m ? m[2] : null;
}
function numero(xml, tag) {
  const v = valor(xml, tag);
  return v === null || v === '' ? null : Number(v);
}

/**
 * @param {string} dpsXml  XML da DPS (assinada ou não)
 * @returns dados no mesmo formato que o corpo de POST /nfse aceita, mais
 *          o que a tela precisa para exibir. Campos ausentes vêm null.
 */
function lerDps(dpsXml) {
  const xml = String(dpsXml || '');
  const inf = dentro(xml, 'infDPS');
  const prest = dentro(inf, 'prest');
  const toma = dentro(inf, 'toma');
  const end = dentro(toma, 'end');
  const endNac = dentro(end, 'endNac');
  const serv = dentro(inf, 'serv');
  const cServ = dentro(serv, 'cServ');
  const valores = dentro(inf, 'valores');
  const trib = dentro(valores, 'trib');
  const tribMun = dentro(trib, 'tribMun');
  const totTrib = dentro(trib, 'totTrib');
  const pTotTrib = dentro(totTrib, 'pTotTrib');

  const docTomador = valor(toma, 'CNPJ') || valor(toma, 'CPF');

  return {
    cnpjEmpresa: valor(prest, 'CNPJ'),
    serie: valor(inf, 'serie'),
    numero: valor(inf, 'nDPS'),
    dataCompetencia: valor(inf, 'dCompet'),
    tomador: docTomador ? {
      documento: docTomador,
      tipo: valor(toma, 'CNPJ') ? 'cnpj' : 'cpf',
      razaoSocial: valor(toma, 'xNome'),
      telefone: valor(toma, 'fone'),
      email: valor(toma, 'email'),
      endereco: end ? {
        codigoMunicipio: valor(endNac, 'cMun'),
        cep: valor(endNac, 'CEP'),
        logradouro: valor(end, 'xLgr'),
        numero: valor(end, 'nro'),
        complemento: valor(end, 'xCpl'),
        bairro: valor(end, 'xBairro')
      } : null
    } : null,
    servico: {
      codigoTributacaoNacional: valor(cServ, 'cTribNac'),
      codigoTributacaoMunicipal: valor(cServ, 'cTribMun'),
      descricao: valor(cServ, 'xDescServ'),
      codigoMunicipioPrestacao: valor(dentro(serv, 'locPrest'), 'cLocPrestacao')
    },
    valores: {
      valorServico: numero(dentro(valores, 'vServPrest'), 'vServ'),
      // tpRetISSQN: 1 = não retido, 2 = retido pelo tomador
      issRetido: valor(tribMun, 'tpRetISSQN') === '2',
      aliquotaIss: numero(tribMun, 'pAliq'),
      percentualTotalTributosSN: numero(totTrib, 'pTotTribSN'),
      percentualTotalTributos: pTotTrib ? {
        federal: numero(pTotTrib, 'pTotTribFed'),
        estadual: numero(pTotTrib, 'pTotTribEst'),
        municipal: numero(pTotTrib, 'pTotTribMun')
      } : null
    }
  };
}

module.exports = { lerDps };
