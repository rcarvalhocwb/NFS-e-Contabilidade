const db = require('../db');
const { faltaParaEmitirSemFormulario, optanteSimples } = require('../nfse/padroesEmpresa');
const emissorMunicipal = require('../nfse/emissorMunicipal');
const municipios = require('./municipiosService');

/* Esta empresa está pronta para emitir?
 *
 * Os campos todos existem no cadastro. O que não existia era alguém dizer
 * QUANDO ele está completo — as conferências viviam espalhadas: a lista de
 * empresas acusava padrão fiscal faltando, o diagnóstico cobria a cadeia do
 * WhatsApp, e nenhuma respondia a pergunta que o contador faz de verdade, que
 * é "posso soltar este cliente?".
 *
 * Sem isso, a resposta chegava pela nota recusada — que é o pior lugar para
 * descobrir que faltava o certificado.
 *
 * A ordem é a da dependência: sem certificado nada emite, e cobrar o número do
 * WhatsApp antes disso seria mandar a pessoa arrumar o telhado antes da
 * parede.
 */

function item(estado, o_que, detalhe, resolver) {
  return { estado, o_que, detalhe: detalhe || null, resolver: resolver || null };
}

async function conferir(cnpj) {
  const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1', [cnpj]);
  const e = r.rows[0];
  if (!e) throw Object.assign(new Error('Empresa não encontrada'), { status: 404 });

  const itens = [];

  /* ------------------------------------------------------- o certificado */
  const cert = await db.query(
    `SELECT valido_ate, EXTRACT(day FROM valido_ate - now())::int AS dias
       FROM certificados WHERE empresa_id = $1 AND ativo
      ORDER BY criado_em DESC LIMIT 1`, [e.id]);
  const c = cert.rows[0];
  if (!c) {
    itens.push(item('falta', 'Sem certificado A1', null,
      'Aba Certificado. Sem ele nenhuma nota sai, nem em homologação — e o ' +
      'certificado é da própria empresa, não do escritório.'));
  } else if (c.dias < 0) {
    itens.push(item('falta', 'Certificado VENCIDO',
      'venceu em ' + new Date(c.valido_ate).toLocaleDateString('pt-BR'),
      'Renove na certificadora e suba o novo na aba Certificado.'));
  } else if (c.dias <= 30) {
    itens.push(item('atencao', 'Certificado vence em ' + c.dias + ' dia(s)',
      new Date(c.valido_ate).toLocaleDateString('pt-BR'),
      'Renovar leva alguns dias. Comece agora, não no dia.'));
  } else {
    itens.push(item('ok', 'Certificado válido',
      'até ' + new Date(c.valido_ate).toLocaleDateString('pt-BR')));
  }

  /* ------------------------------------------------------ onde ela emite */
  const mun = await municipios.obter(e.codigo_municipio);
  const destino = emissorMunicipal.transporte(mun, e);
  const impedimento = emissorMunicipal.conferirPodeEmitir(mun, e);

  itens.push(impedimento
    ? item('falta', 'Emissão bloqueada em ' + (mun && mun.nome || e.codigo_municipio),
        null, impedimento)
    : item('ok', 'Emite por ' + destino.nome,
        (mun && mun.nome ? mun.nome + ' · ' : '') +
        (optanteSimples(e)
          ? 'optante do Simples: vai pelo Nacional por obrigação (CGSN 189/2026)'
          : 'fora do Simples')));

  /* ---------------------------------------------------- os padrões fiscais */
  const falta = faltaParaEmitirSemFormulario(e);
  itens.push(falta.length
    ? item('falta', 'Padrões fiscais incompletos', 'falta ' + falta.join(' e '),
        'Aba Documentos Fiscais. Sem eles a nota sai pelo formulário, onde ' +
        'alguém digita, e é recusada pelo WhatsApp.')
    : item('ok', 'Padrões fiscais completos',
        e.cod_tributacao_padrao + ' · ' + (e.descricao_padrao || '')));

  /* ------------------------------------------------------ a numeração */
  const num = await db.query(
    'SELECT serie, prox_numero FROM numeracao_dps WHERE empresa_id = $1 AND ambiente = $2',
    [e.id, e.ambiente]);
  itens.push(num.rows.length
    ? item('ok', 'Numeração definida',
        'série ' + num.rows[0].serie + ', próximo ' + num.rows[0].prox_numero +
        ' (' + e.ambiente + ')')
    : item('falta', 'Sem numeração no ambiente ' + e.ambiente, null,
        'Aba Documentos Fiscais, no fim.'));

  /* --------------------------------------------------------- o WhatsApp */
  const svc = await db.query('SELECT count(*)::int n FROM servicos WHERE empresa_id = $1', [e.id]);
  const wa = await db.query(
    'SELECT count(*)::int n FROM contatos_whatsapp WHERE empresa_id = $1 AND ativo', [e.id]);

  if (!e.portal_liberado) {
    itens.push(item('atencao', 'Não liberada para pedir nota', null,
      'Aba Integração. Enquanto isso ela emite só pelo painel, aqui dentro — ' +
      'nem WhatsApp nem portal.'));
  } else {
    itens.push(item('ok', 'Liberada para pedir nota'));
    itens.push(svc.rows[0].n
      ? item('ok', svc.rows[0].n + ' serviço(s) cadastrado(s)')
      : item('falta', 'Nenhum serviço cadastrado', null,
          'Tela Serviços. A conversa do WhatsApp pede para escolher um; sem ' +
          'lista, ela encerra na primeira pergunta.'));
    itens.push(wa.rows[0].n
      ? item('ok', wa.rows[0].n + ' número(s) de WhatsApp autorizado(s)')
      : item('atencao', 'Nenhum número de WhatsApp autorizado', null,
          'Aba Integração. Sem número, ninguém desta empresa consegue pedir ' +
          'pelo WhatsApp — mas ela continua emitindo pelo painel.'));
  }

  /* ---------------------------------------------------------- o ambiente */
  if (e.ambiente === 'homologacao') {
    itens.push(item('atencao', 'Está em homologação',
      'as notas não têm valor fiscal',
      'Quando terminar de conferir, troque para produção na lista de Empresas.'));
  }

  const faltas = itens.filter(i => i.estado === 'falta').length;
  const atencoes = itens.filter(i => i.estado === 'atencao').length;

  return {
    cnpj: e.cnpj,
    razaoSocial: e.razao_social,
    /* "Pronta" é sobre EMITIR. Um aviso de homologação ou de WhatsApp sem
       número não impede a nota de sair — impede outra coisa, e dizer que ela
       não está pronta seria exagerar. */
    pronta: faltas === 0,
    resumo: faltas
      ? faltas + ' coisa(s) faltando' + (atencoes ? ' e ' + atencoes + ' para olhar' : '')
      : atencoes
        ? 'Pronta para emitir; ' + atencoes + ' ponto(s) para olhar'
        : 'Pronta para emitir',
    itens
  };
}

module.exports = { conferir };
