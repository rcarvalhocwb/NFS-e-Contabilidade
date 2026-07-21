/* Monta o XML do Pedido de Registro de Evento (cancelamento - e101101). */

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function tag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${name}>${esc(value)}</${name}>`;
}

function fmtDataHoraLocal(d = new Date()) {
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    sign + p(tz / 60) + ':' + p(tz % 60);
}

/**
 * Pedido de cancelamento (evento e101101).
 * Id do pedido: "PRE" + chaveAcesso(50) + código do evento(6) + seq(3) = 62
 * @param opts { tpAmb, verAplic, chaveAcesso, cnpjAutor, codigoMotivo, motivo, nSeqEvento }
 *   codigoMotivo: 1=Erro na emissão, 2=Serviço não prestado, 9=Outros (exige motivo)
 */
function montarPedidoCancelamento(opts) {
  const nPedRegEvento = String(opts.nSeqEvento || 1).padStart(3, '0');
  const id = 'PRE' + opts.chaveAcesso + '101101' + nPedRegEvento;

  return `<?xml version="1.0" encoding="UTF-8"?>` +
`<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">` +
`<infPedReg Id="${id}">` +
  tag('tpAmb', opts.tpAmb) +
  tag('verAplic', opts.verAplic) +
  tag('dhEvento', fmtDataHoraLocal()) +
  tag('CNPJAutor', opts.cnpjAutor) +
  tag('chNFSe', opts.chaveAcesso) +
  tag('nPedRegEvento', nPedRegEvento) +
  `<e101101>` +
    tag('xDesc', 'Cancelamento de NFS-e') +
    tag('cMotivo', opts.codigoMotivo || 1) +
    (Number(opts.codigoMotivo) === 9 ? tag('xMotivo', opts.motivo) : '') +
  `</e101101>` +
`</infPedReg>` +
`</pedRegEvento>`;
}

module.exports = { montarPedidoCancelamento };
