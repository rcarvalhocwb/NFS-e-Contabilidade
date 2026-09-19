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

/* Descrição padrão por motivo, usada quando o chamador não informa uma.
   xMotivo é obrigatório em qualquer motivo (não só no 9), e a tabela mora em
   regrasDps para não haver duas — a daqui foi a que errou. */
const { TEXTO_PADRAO_CANCELAMENTO, LIMITE_MOTIVO } = require('./regrasDps');

/**
 * Pedido de cancelamento (evento e101101).
 *
 * Formato descoberto validando contra a Sefin em produção — três detalhes que
 * a documentação não deixa claros e que causam "E1235 falha no esquema":
 *
 *   1. Id = "PRE" + chaveAcesso(50) + "101101" = 59 caracteres.
 *      NÃO leva número sequencial no fim (com ele vira 62 e o pattern
 *      TSIdPedRegEvt falha).
 *   2. nPedRegEvento NÃO é elemento de infPedReg — incluí-lo invalida o schema.
 *   3. xMotivo é obrigatório para qualquer cMotivo, não apenas para o 9.
 *
 * A versão do leiaute do pedido é 1.01.
 *
 * @param opts { tpAmb, verAplic, chaveAcesso, cnpjAutor, codigoMotivo, motivo }
 *   codigoMotivo: 1=Erro na emissão, 2=Serviço não prestado, 9=Outros
 */
function montarPedidoCancelamento(opts) {
  const cMotivo = Number(opts.codigoMotivo) || 1;
  const id = 'PRE' + opts.chaveAcesso + '101101';
  const xMotivo = opts.motivo || TEXTO_PADRAO_CANCELAMENTO[cMotivo];

  /* Última conferência antes de assinar.
     O padrão do motivo 9 já foi 'Outros' — seis caracteres, e TSMotivo exige
     quinze. O evento saía assinado e voltava "E1235 falha no esquema", com a
     nota seguindo válida e ninguém sabendo por quê. A regra está em
     conferirCancelamento, que a rota chama; esta linha existe para o caminho
     que não passa pela rota. */
  if (!xMotivo || String(xMotivo).length < LIMITE_MOTIVO.min) {
    throw Object.assign(new Error(
      `xMotivo precisa de ao menos ${LIMITE_MOTIVO.min} caracteres ` +
      `(motivo ${cMotivo}${xMotivo ? `, recebido "${xMotivo}"` : ', nenhum informado'})`
    ), { status: 400 });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>` +
`<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">` +
`<infPedReg Id="${id}">` +
  tag('tpAmb', opts.tpAmb) +
  tag('verAplic', opts.verAplic) +
  tag('dhEvento', fmtDataHoraLocal()) +
  tag('CNPJAutor', opts.cnpjAutor) +
  tag('chNFSe', opts.chaveAcesso) +
  `<e101101>` +
    tag('xDesc', 'Cancelamento de NFS-e') +
    tag('cMotivo', cMotivo) +
    tag('xMotivo', xMotivo) +
  `</e101101>` +
`</infPedReg>` +
`</pedRegEvento>`;
}

module.exports = { montarPedidoCancelamento };
