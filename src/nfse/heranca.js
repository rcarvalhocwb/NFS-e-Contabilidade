const { lerDps } = require('./lerDps');

/* O que a nota substituta herda da nota que ela substitui.
 *
 * Substituir uma NFS-e é emitir outra apontando para a anterior — não existe
 * "alterar". O comum, então, é mudar UM campo e manter todo o resto. Era o que
 * a tela prometia e não entregava: ela relê a DPS original no navegador, mas
 * só seis campos. O que não estava nesses seis sumia, e os buracos eram
 * fechados pelo padrão da EMPRESA — que não é a mesma coisa que o valor da
 * nota original.
 *
 * Medido sobre uma DPS com tomador completo e ISS retido, comparando o leitor
 * do navegador com este:
 *
 *   endereço, telefone e e-mail do tomador  — sumiam
 *   data de competência                     — voltava para o mês corrente
 *   ISS retido, código municipal, %tributos — vinham do padrão da empresa
 *
 * Os três primeiros são perda de dado. Os três últimos são piores, porque
 * parecem preenchidos: se o tomador daquela nota retinha o ISS e a empresa não
 * retém por padrão, a substituta sai sem retenção — e quem recolhe o imposto
 * muda, em silêncio.
 *
 * A competência é do mesmo tipo: substituir em setembro uma nota de agosto
 * jogava a receita para setembro.
 *
 * A ordem de precedência é a única que faz sentido para "corrigir uma linha":
 *
 *   1. o que o chamador mandou      — é a correção que ele veio fazer
 *   2. a nota original              — "manter o resto" quer dizer isto
 *   3. o padrão da empresa          — só onde a original também não diz
 *
 * Fica no serviço, e não na tela, porque a substituição também chega por
 * `POST /nfse`. Foi a lição do padrão fiscal: regra que mora no navegador vale
 * só para quem passa pelo navegador.
 */

/* Copia de `origem` para `alvo` apenas as chaves que o alvo não tem.
   `undefined` é "não falei nada"; `null` é uma escolha e é respeitada. */
function preencherBuracos(alvo, origem) {
  if (!origem || typeof origem !== 'object') return alvo;
  const saida = Object.assign({}, alvo);
  for (const [chave, valor] of Object.entries(origem)) {
    if (valor === undefined || valor === null) continue;
    if (saida[chave] === undefined) {
      saida[chave] = valor;
    } else if (valor && typeof valor === 'object' && !Array.isArray(valor) &&
               saida[chave] && typeof saida[chave] === 'object' && !Array.isArray(saida[chave])) {
      saida[chave] = preencherBuracos(saida[chave], valor);
    }
  }
  return saida;
}

/**
 * @param dados     o que chegou do chamador, já com o bloco `substituicao`
 * @param dpsOriginal  o XML da DPS que está sendo substituída
 * @returns os mesmos dados, com os buracos preenchidos pela nota original
 */
function herdarDaOriginal(dados, dpsOriginal) {
  if (!dpsOriginal) return dados;

  let original;
  try {
    original = lerDps(dpsOriginal);
  } catch (_) {
    /* DPS antiga, de leiaute que este leitor não conhece, ou gravada pela
       metade: herdar é uma comodidade, não uma etapa obrigatória. Falhar aqui
       impediria a substituição — que é justamente a forma de corrigir uma nota
       errada, e a hora em que a pessoa menos precisa de um obstáculo. */
    return dados;
  }
  if (!original) return dados;

  const saida = Object.assign({}, dados);

  if (original.dataCompetencia && saida.dataCompetencia === undefined) {
    saida.dataCompetencia = original.dataCompetencia;
  }

  /* O tomador só é herdado quando é O MESMO. Trocar o tomador é uma correção
     legítima, e completar o endereço do novo com o do antigo produziria uma
     nota que aponta para a rua de outra empresa. */
  if (original.tomador) {
    const doc = (d) => String((d && (d.cnpj || d.cpf || d.documento)) || '').replace(/\D/g, '');
    const mesmo = !saida.tomador || !doc(saida.tomador) ||
                  doc(saida.tomador) === String(original.tomador.documento || '').replace(/\D/g, '');
    if (mesmo) {
      const base = {
        razaoSocial: original.tomador.razaoSocial,
        telefone: original.tomador.telefone,
        email: original.tomador.email,
        endereco: original.tomador.endereco
      };
      if (original.tomador.tipo === 'cnpj') base.cnpj = original.tomador.documento;
      else base.cpf = original.tomador.documento;
      saida.tomador = preencherBuracos(saida.tomador || {}, base);
    }
  }

  saida.servico = preencherBuracos(saida.servico || {}, original.servico);
  saida.valores = preencherBuracos(saida.valores || {}, original.valores);

  return saida;
}

module.exports = { herdarDaOriginal, preencherBuracos };
