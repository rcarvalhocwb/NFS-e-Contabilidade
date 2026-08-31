/* Os padrões fiscais da empresa, aplicados a QUALQUER caminho de emissão.
 *
 * Até 27/08/2026 estes valores eram preenchidos pelas páginas do painel —
 * `nota.js` e `emitir.js`, no navegador. O serviço de emissão não aplicava
 * padrão nenhum. Quem emitia por outro caminho mandava só o que tinha em mãos,
 * e o resultado apareceu em produção:
 *
 *   nota 8, formulário:   <totTrib><pTotTribSN>6.00</pTotTribSN></totTrib>  → autorizada
 *   nota 9, solicitação:  (nada)                                           → E1235
 *
 * "Falha no esquema XML: o elemento 'trib' tem conteúdo incompleto. Esperados:
 * tribFed, totTrib." A diferença entre a nota que valeu e a recusada era um
 * elemento — justamente o que a tela preenchia sozinha.
 *
 * Como quase todo cliente de escritório contábil é do Simples, isso derrubava
 * o canal inteiro do WhatsApp, o portal e a API pública `POST /nfse`.
 *
 * A regra aqui é uma só: **o que o chamador informou vence sempre**. Este
 * módulo só preenche buraco. Um padrão que sobrescreve o que a pessoa digitou
 * seria pior que padrão nenhum.
 */

/* Optante do Simples Nacional: 2 = ME/EPP optante, 3 = ME/EPP optante com
   excesso de sublimite. É a mesma leitura que as telas fazem. */
function optanteSimples(empresa) {
  return [2, 3].includes(Number(empresa.op_simp_nac));
}

function numeroOuNulo(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Preenche `dados` com o que a empresa tem cadastrado e o chamador não mandou.
 *
 * Devolve uma cópia: o chamador pode ter guardado o objeto original (a
 * solicitação do portal fica no banco), e alterá-lo por baixo mudaria o que
 * ficou registrado como pedido do cliente. */
function aplicarPadroes(empresa, dados = {}) {
  const saida = Object.assign({}, dados);
  const servico = Object.assign({}, dados.servico);
  const valores = Object.assign({}, dados.valores);
  const sn = optanteSimples(empresa);

  /* ------------------------------------------------------------ serviço */
  if (servico.codigoTributacaoNacional === undefined && empresa.cod_tributacao_padrao) {
    servico.codigoTributacaoNacional = empresa.cod_tributacao_padrao;
  }
  if (servico.codigoTributacaoMunicipal === undefined && empresa.cod_tributacao_municipal) {
    servico.codigoTributacaoMunicipal = empresa.cod_tributacao_municipal;
  }
  if (servico.codigoNbs === undefined && empresa.cod_nbs_padrao) {
    servico.codigoNbs = empresa.cod_nbs_padrao;
  }
  if (servico.descricao === undefined && empresa.descricao_padrao) {
    servico.descricao = empresa.descricao_padrao;
  }

  /* ------------------------------------------------------------ valores */
  if (valores.issRetido === undefined && empresa.iss_retido_padrao !== null &&
      empresa.iss_retido_padrao !== undefined) {
    valores.issRetido = empresa.iss_retido_padrao;
  }

  /* Natureza da tributação do ISSQN. 1 é "operação tributável", que é o que o
     construtor já assume — só vale mandar quando a empresa é outra coisa
     (imune, isenta, exportação). Mandar 1 explicitamente não muda o XML, mas
     mandar só o que altera o resultado deixa a DPS mais fácil de conferir. */
  const naturezaPadrao = numeroOuNulo(empresa.tributacao_issqn_padrao);
  if (valores.tributacaoIssqn === undefined && naturezaPadrao !== null && naturezaPadrao !== 1) {
    valores.tributacaoIssqn = naturezaPadrao;
  }

  /* A alíquota de ISS é de quem NÃO está no Simples: o optante recolhe pelo
     DAS e declarar alíquota aqui é justamente o que a Sefin recusa. */
  const aliquota = numeroOuNulo(empresa.aliquota_iss_padrao);
  if (!sn && valores.aliquotaIss === undefined && aliquota !== null) {
    valores.aliquotaIss = aliquota;
  }

  /* ------------------------------------------- o total de tributos (o B1)
   *
   * Para o optante do Simples só existe uma resposta válida: a alíquota
   * efetiva do PGDAS-D em pTotTribSN. Sem ela o grupo <totTrib> não vai, e o
   * <trib> fica incompleto — que é exatamente o E1235 da nota 9.
   *
   * Para os demais regimes a declaração é repartida por esfera, e um número
   * solto não se reparte: nesse caso o padrão da empresa não é aplicado, e o
   * construtor declara indTotTrib=0 ("sem informação"), que é honesto e o
   * esquema aceita. */
  const totTrib = numeroOuNulo(empresa.perc_total_tributos);
  if (sn && valores.percentualTotalTributosSN === undefined && totTrib !== null) {
    valores.percentualTotalTributosSN = totTrib;
  }

  saida.servico = servico;
  saida.valores = valores;
  return saida;
}

/* O que falta para esta empresa emitir sem depender de quem preenche.
 *
 * Existe para a tela de diagnóstico e para o cadastro: uma empresa do Simples
 * sem `perc_total_tributos` emite pelo formulário (onde alguém digita) e falha
 * por todos os outros caminhos. Sem esta conferência, isso só aparece quando o
 * cliente manda a primeira mensagem. */
function faltaParaEmitirSemFormulario(empresa) {
  const falta = [];
  if (!empresa.cod_tributacao_padrao) {
    falta.push('código de tributação nacional padrão');
  }
  if (!empresa.descricao_padrao) {
    falta.push('descrição padrão do serviço');
  }
  if (optanteSimples(empresa) && numeroOuNulo(empresa.perc_total_tributos) === null) {
    falta.push('percentual total de tributos do Simples (PGDAS-D)');
  }
  return falta;
}

module.exports = { aplicarPadroes, optanteSimples, faltaParaEmitirSemFormulario };
