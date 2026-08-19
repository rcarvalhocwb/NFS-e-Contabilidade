/* Monta o XML da DPS (Declaração de Prestação de Serviços) v1.00
   Namespace: http://www.sped.fazenda.gov.br/nfse

   Recebe um JSON simplificado do sistema e os dados da empresa cadastrada.
   Cobre o caso comum de prestação de serviço; valide contra o XSD oficial
   (gov.br/nfse > Documentação técnica) para casos especiais (exportação,
   obra, evento, deduções etc.). */

const { limparDocumento } = require('../util/documento');
const { dataLocalISO } = require('../util/data');

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
function tributoMunicipal(v, optanteSN, issRetido, versao) {
  const tipo = String(v.tributacaoIssqn || '1');
  const suspensa = ['5', '6'].includes(tipo);

  /* O XSD publicado aceita tribISSQN de 1 a 4. A exigibilidade suspensa (5 e 6)
     aparece na planilha do AnexoVI da NT 009, cujo XSD ainda não saiu — mandar
     agora seria recusado. Falhar aqui evita queimar número de DPS. */
  if (suspensa) {
    throw Object.assign(
      new Error('tributacaoIssqn 5 e 6 (exigibilidade suspensa) constam da NT 009 ' +
                'mas ainda não são aceitos pelo esquema publicado da Sefin. ' +
                'Use 1 a 4 até a publicação do XSD correspondente.'),
      { status: 400 });
  }

  return `<tribMun>` +
    tag('tribISSQN', tipo) +
    // Exportação: país onde o resultado do serviço se verifica
    (tipo === '2' ? tag('cPaisResult', v.paisResultado) : '') +
    // Imunidade exige dizer qual: livro/jornal, templo, partido, entidade...
    (tipo === '4' ? tag('tpImunidade', v.tipoImunidade) : '') +
    (suspensa ?
    `<exigSusp>` +
      tag('tpSusp', v.tipoSuspensao) +
      tag('nProcesso', v.numeroProcesso) +
    `</exigSusp>` : '') +
    // Benefício municipal: nBM é o número do benefício no cadastro do
    // município (numérico, 14 posições), acompanhado da redução em valor OU
    // em percentual.
    (v.beneficioMunicipal ?
    `<BM>` +
      tag('nBM', v.beneficioMunicipal.numero) +
      (v.beneficioMunicipal.valorReducao !== undefined
        ? tag('vRedBCBM', dec(v.beneficioMunicipal.valorReducao))
        : (v.beneficioMunicipal.percentualReducao !== undefined
            ? tag('pRedBCBM', dec(v.beneficioMunicipal.percentualReducao)) : '')) +
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

/**
 * Grupo IBSCBS — Reforma Tributária do Consumo (EC 132/2023, LC 214/2025).
 *
 * Estrutura conforme AnexoVI-LeiautesRN_RTC_IBSCBS v1.04.00 (NT 009/2026).
 *
 * FACULTATIVO no momento: a NT 004 v2.0 suspendeu a regra de obrigatoriedade,
 * e documentos sem o grupo continuam sendo autorizados. Mas a mesma nota avisa
 * que, uma vez informado, TODO o conteúdo do grupo passa a ser validado — por
 * isso ele só é montado quando o chamador pede explicitamente, e nunca por
 * inferência.
 *
 * O mínimo exigido pelo leiaute quando o grupo existe:
 *   indDest (1-1) e valores/trib/gIBSCBS com CST (1-1) e cClassTrib (1-1).
 *
 * CST (3 dígitos) e cClassTrib (6 dígitos) vêm das tabelas da LC 214/2025 —
 * quem emite informa; o gateway não os deduz, porque errar aqui muda o imposto.
 */
/* A NT 009/2026 traz campos que o esquema publicado ainda não aceita —
   vAjusteBC no lugar de vDedRed, gEstornoCred, exigibilidade suspensa. Emiti-los
   antes do XSD correspondente faria a Sefin recusar a nota inteira.
   DPS_LEIAUTE_NT009=true os liga, para testar assim que o esquema sair. */
function leiauteNT009() {
  return process.env.DPS_LEIAUTE_NT009 === 'true';
}

function grupoIbsCbs(dados) {
  const g = dados.ibsCbs;
  if (!g) return '';

  // Sequência conforme TCRTCInfoIBSCBS (tiposComplexos_v1.01). Elemento fora de
  // ordem é recusado pelo esquema, então a ordem aqui não é estética.
  const trib = g.tributacao || {};
  const faltando = [];
  if (g.indicadorOperacao === undefined) faltando.push('indicadorOperacao (cIndOp, tabela do Anexo VII)');
  if (g.indicadorDestinatario === undefined) faltando.push('indicadorDestinatario (0 = o tomador; 1 = outra pessoa)');
  if (trib.cst === undefined) faltando.push('tributacao.cst');
  if (trib.classificacaoTributaria === undefined) faltando.push('tributacao.classificacaoTributaria');
  if (faltando.length) {
    throw Object.assign(
      new Error('Grupo IBS/CBS incompleto. Falta: ' + faltando.join(', ')),
      { status: 400 });
  }

  const d = g.destinatario;

  return `<IBSCBS>` +
    // 0 = NFS-e regular. Os códigos de nota de ajuste chegam com a NT 009.
    tag('finNFSe', g.finalidade !== undefined ? g.finalidade : 0) +
    tag('indFinal', g.consumidorFinal) +
    tag('cIndOp', g.indicadorOperacao) +
    tag('tpOper', g.tipoOperacao) +
    (Array.isArray(g.notasReferenciadas) && g.notasReferenciadas.length ?
    `<gRefNFSe>` +
      g.notasReferenciadas.map(c => tag('refNFSe', c)).join('') +
    `</gRefNFSe>` : '') +
    tag('tpEnteGov', g.tipoEnteGovernamental) +
    // 0 = destinatário é o próprio tomador; 1 = é outra pessoa, e aí <dest>
    // identifica quem recebeu o serviço.
    tag('indDest', g.indicadorDestinatario) +
    (d ?
    `<dest>` +
      (d.cnpj ? tag('CNPJ', limparDocumento(d.cnpj))
              : (d.cpf ? tag('CPF', String(d.cpf).replace(/\D/g, ''))
                       : (d.nif ? tag('NIF', d.nif) : tag('cNaoNIF', d.codigoNaoNif)))) +
      tag('xNome', d.nome) +
      (d.endereco ?
      `<end>` +
        (d.endereco.codigoPais ?
        `<endExt>` +
          tag('cPais', d.endereco.codigoPais) +
          tag('cEndPost', d.endereco.codigoPostal) +
          tag('xCidade', d.endereco.cidade) +
          tag('xEstProvReg', d.endereco.estado) +
        `</endExt>` :
        `<endNac>` +
          tag('cMun', d.endereco.codigoMunicipio) +
          tag('CEP', (d.endereco.cep || '').replace(/\D/g, '')) +
        `</endNac>`) +
        tag('xLgr', d.endereco.logradouro) +
        tag('nro', d.endereco.numero) +
        tag('xCpl', d.endereco.complemento) +
        tag('xBairro', d.endereco.bairro) +
      `</end>` : '') +
      tag('fone', d.telefone) +
      tag('email', d.email) +
    `</dest>` : '') +
    `<valores>` +
      `<trib>` +
        `<gIBSCBS>` +
          tag('CST', String(trib.cst).padStart(3, '0')) +
          tag('cClassTrib', String(trib.classificacaoTributaria).padStart(6, '0')) +
          tag('cCredPres', trib.creditoPresumido) +
          // Tributação que incidiria sem o benefício, quando há desoneração
          (trib.tributacaoRegular ?
          `<gTribRegular>` +
            tag('CSTReg', String(trib.tributacaoRegular.cst).padStart(3, '0')) +
            tag('cClassTribReg', String(trib.tributacaoRegular.classificacaoTributaria).padStart(6, '0')) +
          `</gTribRegular>` : '') +
          (trib.diferimento ?
          `<gDif>` +
            tag('pDifUF', dec(trib.diferimento.percentualUF)) +
            tag('pDifMun', dec(trib.diferimento.percentualMunicipal)) +
            tag('pDifCBS', dec(trib.diferimento.percentualCBS)) +
          `</gDif>` : '') +
          // gEstornoCred entra com a NT 009; o esquema publicado ainda não o
          // aceita, e mandá-lo antes faria a Sefin recusar a nota inteira.
          (trib.estornoCredito && leiauteNT009() ?
          `<gEstornoCred>` +
            tag('vIBSEstCred', dec(trib.estornoCredito.valorIBS)) +
            tag('vCBSEstCred', dec(trib.estornoCredito.valorCBS)) +
          `</gEstornoCred>` : '') +
        `</gIBSCBS>` +
        (g.ajuste ?
        `<gIBSCBSAjuste>` +
          tag('vIBS', dec(g.ajuste.valorIBS)) +
          tag('vCBS', dec(g.ajuste.valorCBS)) +
        `</gIBSCBSAjuste>` : '') +
      `</trib>` +
    `</valores>` +
  `</IBSCBS>`;
}

function totalTributos(v, optanteSN) {
  if (optanteSN) {
    /* ME/EPP não pode declarar indTotTrib:
       "E0712: Para ME/EPP o indicador de informação de valor total de tributos
        não pode ser informado."
       Para quem está no Simples só existe uma resposta válida — a alíquota
       efetiva do PGDAS-D em pTotTribSN. Sem ela, o bloco não vai; declarar
       ausência é justamente o que a Sefin recusa.
       O percentual chega como número: para o optante do Simples não há
       repartição por esfera, que é a forma dos demais regimes. */
    const p = v.percentualTotalTributosSN !== undefined
      ? v.percentualTotalTributosSN
      : (typeof v.percentualTotalTributos === 'number' ? v.percentualTotalTributos : undefined);
    return p !== undefined ? tag('pTotTribSN', dec(p)) : '';
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

/* O grupo <totTrib> exige uma das três formas (pTotTrib, pTotTribSN ou
   indTotTrib). Vazio, seria <totTrib></totTrib> e o esquema recusa — então
   quando não há nada a declarar, o grupo inteiro fica de fora. */
function blocoTotalTributos(v, optanteSN) {
  const conteudo = totalTributos(v, optanteSN);
  return conteudo ? `<totTrib>${conteudo}</totTrib>` : '';
}

/* Id da DPS: "DPS" + cMun(7) + tipoInsc(1: 1=CPF 2=CNPJ) + inscrição(14) + série(5) + número(15) = 45 */
function gerarIdDps({ codigoMunicipio, cnpj, serie, numero }) {
  const insc = cnpj.padStart(14, '0');
  const tipo = cnpj.length === 11 ? '1' : '2';
  return 'DPS' + codigoMunicipio + tipo + insc +
    String(serie).padStart(5, '0') + String(numero).padStart(15, '0');
}

/* Margem de segurança do dhEmi.
 *
 * A DPS é montada, assinada e transmitida em menos de um segundo. Se o relógio
 * da máquina estiver adiantado em relação ao da Sefin — bastam décimos —, a
 * data de emissão fica "no futuro" e a nota volta com E0008:
 *   "A data de emissão da DPS não pode ser posterior à data do seu processamento."
 *
 * Aconteceu com 0,3s de diferença. Recuar alguns segundos não muda nada
 * fiscalmente (a competência é por data) e elimina a corrida.
 */
const MARGEM_EMISSAO_S = parseInt(process.env.DPS_MARGEM_SEGUNDOS || '5', 10);

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

  /* Versão do leiaute.
     1.00 é o que está autorizado em produção hoje e segue sendo o padrão.
     1.01 é o leiaute da Reforma Tributária (XSD DPS_v1.01), onde o grupo
     IBSCBS existe — informá-lo em 1.00 geraria XML inválido, então a versão
     sobe sozinha nesse caso. DPS_VERSAO força o valor quando a Sefin exigir
     1.01 para todos. */
  const versao = process.env.DPS_VERSAO || (dados.ibsCbs ? '1.01' : '1.00');

  /* No leiaute 1.01 o XSD publicado torna cNBS obrigatório (a planilha do
     AnexoVI da NT 009 diz 0-1, mas quem valida é o XSD). Recusar aqui evita
     queimar número de DPS numa nota que a Sefin devolveria. */
  if (versao === '1.01' && !s.codigoNbs) {
    throw Object.assign(
      new Error('servico.codigoNbs é obrigatório no leiaute 1.01 (IBS/CBS). ' +
                'É o código NBS de 9 dígitos do serviço prestado.'),
      { status: 400 });
  }

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>` +
`<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${versao}">` +
`<infDPS Id="${idDps}">` +
  tag('tpAmb', opts.tpAmb) +
  tag('dhEmi', fmtDataHoraLocal(new Date(Date.now() - MARGEM_EMISSAO_S * 1000))) +
  tag('verAplic', opts.verAplic) +
  tag('serie', serie) +
  tag('nDPS', numero) +
  tag('dCompet', dados.dataCompetencia || dataLocalISO()) +
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
    // A IM só vai quando o município a exige NESTE ambiente. A Sefin valida
    // contra o CNC do município emissor e recusa nos dois sentidos:
    //   E0116 "A IM deve ser informada" — quando falta
    //   E0120 "A IM não deve ser informado, pois não existem informações
    //          complementares registradas no CNC" — quando sobra
    // Curitiba exige em produção restrita e proíbe em produção. Quem decide é
    // a tabela regra_im_dps; sem regra conhecida, envia (comportamento antigo).
    tag('IM', empresa.omitir_im ? undefined : empresa.inscricao_municipal) +
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
      // cLocPrestacao e cPaisPrestacao sao alternativos no leiaute (CE): o
      // serviço é prestado num município brasileiro OU no exterior.
      (s.codigoPaisPrestacao
        ? tag('cPaisPrestacao', String(s.codigoPaisPrestacao).toUpperCase())
        : tag('cLocPrestacao', s.codigoMunicipioPrestacao || empresa.codigo_municipio)) +
    `</locPrest>` +
    // Ordem conforme o XSD publicado (tiposComplexos_v1.01): xDescServ vem
    // antes de cNBS. A planilha do AnexoVI da NT 009 lista outra ordem, mas o
    // XSD é o que valida de fato — e um elemento fora de ordem é recusado.
    `<cServ>` +
      tag('cTribNac', s.codigoTributacaoNacional) +
      tag('cTribMun', s.codigoTributacaoMunicipal) +
      tag('xDescServ', s.descricao) +
      tag('cNBS', s.codigoNbs) +
      tag('cIntContrib', s.codigoInterno) +
    `</cServ>` +
    // Obra: construção civil informa a obra a que o serviço se refere, o que
    // define o município de incidência do ISS.
    (s.obra ?
    `<obra>` +
      tag('inscImobFisc', s.obra.inscricaoImobiliaria) +
      // cObra, cCIB e end são ALTERNATIVOS no XSD (xs:choice): identifica-se a
      // obra pelo CNO/CEI, pelo CIB, ou pelo endereço — nunca por mais de um.
      (s.obra.codigoObra ? tag('cObra', s.obra.codigoObra)
        : (s.obra.codigoCIB ? tag('cCIB', s.obra.codigoCIB)
        : `<end>` +
            tag('CEP', (s.obra.cep || '').replace(/\D/g, '')) +
            tag('xLgr', s.obra.logradouro) +
            tag('nro', s.obra.numero) +
            tag('xCpl', s.obra.complemento) +
            tag('xBairro', s.obra.bairro) +
          `</end>`)) +
    `</obra>` : '') +
    // Evento: shows, feiras e congressos declaram nome e período
    (s.evento ?
    `<atvEvento>` +
      tag('xNome', s.evento.nome) +
      tag('dtIni', s.evento.dataInicio) +
      tag('dtFim', s.evento.dataFim) +
      tag('idAtvEvt', s.evento.identificador) +
    `</atvEvento>` : '') +
    // Amarra a nota aos documentos que a originaram: ART/RRT, contrato, pedido.
    (s.informacoesComplementares || s.documentoTecnico || s.documentoReferencia || s.pedido ?
    `<infoCompl>` +
      tag('idDocTec', s.documentoTecnico) +
      tag('docRef', s.documentoReferencia) +
      tag('xPed', s.pedido) +
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
    //
    // A NT 009/2026 renomeia este grupo para vAjusteBC (unificando-o com
    // gReeRepRes), mas o XSD publicado ainda espera vDedRed — e é o XSD que
    // valida. O nome acompanha a versão do leiaute para não quebrar quando o
    // esquema novo sair.
    (v.valorDeducoes !== undefined || v.percentualDeducoes !== undefined ?
      (leiauteNT009()
        ? `<vAjusteBC>` +
            (v.percentualDeducoes !== undefined
              ? tag('pAjusteBCISSQN', dec(v.percentualDeducoes))
              : tag('vAjusteBCISSQN', dec(v.valorDeducoes))) +
          `</vAjusteBC>`
        : `<vDedRed>` +
            (v.percentualDeducoes !== undefined
              ? tag('pDR', dec(v.percentualDeducoes))
              : tag('vDR', dec(v.valorDeducoes))) +
          `</vDedRed>`) : '') +
    `<trib>` +
      tributoMunicipal(v, optanteSN, issRetido, versao) +
      tributosFederais(v) +
      blocoTotalTributos(v, optanteSN) +
    `</trib>` +
  `</valores>` +
  grupoIbsCbs(dados) +
`</infDPS>` +
`</DPS>`;

  return xml;
}

module.exports = { montarDps, gerarIdDps };
