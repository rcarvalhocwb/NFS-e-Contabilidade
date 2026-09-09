const { verificar } = require('./formato');

/* Em que situação está a licença, e o que isso permite.
 *
 * A REGRA QUE NÃO SE QUEBRA: licença nunca impede emitir nota. Nem vencida,
 * nem ausente, nem adulterada.
 *
 * Não é generosidade. Um gateway que para de emitir no dia 5 porque a licença
 * venceu significa contabilidade que não entrega, cliente dela que não fatura,
 * e a culpa com nome e telefone do fornecedor. Um episódio desses custa mais
 * do que um ano de licenças de quem burlou. Some-se que o certificado A1 é do
 * cliente e a Sefin é do governo: quem vende o gateway não está no caminho da
 * emissão, e se colocar nele para cobrar é assumir uma responsabilidade que
 * não é sua e não lhe rende nada.
 *
 * O que degrada é o que é conveniência ou custo do fornecedor — WhatsApp,
 * portal, atualizações. Devagar, com aviso, e só depois da carência.
 */

/* Recursos que a licença governa. Emitir, consultar, cancelar, substituir,
   baixar XML e fazer backup NÃO estão aqui, e é de propósito: são obrigação
   fiscal ou saída de dados. Cliente sem licença precisa conseguir levar
   embora o que é dele. */
const RECURSOS_LICENCIADOS = ['whatsapp', 'portal', 'atualizacoes'];

const SITUACOES = {
  ativa:      'Licença em dia.',
  vencendo:   'A licença vence em breve.',
  carencia:   'A licença venceu. O sistema segue completo durante a carência.',
  vencida:    'A licença venceu e a carência acabou.',
  invalida:   'A licença não confere.',
  ausente:    'Nenhuma licença instalada.'
};

/* Quantos dias antes do vencimento o painel começa a avisar. No plano mensal
   avisar com 60 dias seria avisar sempre — o aviso vira paisagem e ninguém
   mais o vê. */
const AVISO_DIAS = { mensal: 7, anual: 30 };

function hojeISO(agora) {
  const d = agora || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

/* Diferença em dias entre duas datas AAAA-MM-DD, pelo calendário e não pelo
   relógio: `Date` com fuso faz 30 dias virarem 29,96 e o arredondamento cai
   para o lado errado justamente no dia do vencimento. */
function diasEntre(deISO, ateISO) {
  const [a1, m1, d1] = deISO.split('-').map(Number);
  const [a2, m2, d2] = ateISO.split('-').map(Number);
  const u1 = Date.UTC(a1, m1 - 1, d1);
  const u2 = Date.UTC(a2, m2 - 1, d2);
  return Math.round((u2 - u1) / 86400000);
}

/**
 * @param licencaTexto   a licença como está guardada, ou null
 * @param chavePublicaPem
 * @param opcoes.agora   para teste; padrão é a data de hoje
 * @param opcoes.cnpjEscritorio  o CNPJ cadastrado nesta instalação, se houver
 */
function avaliar(licencaTexto, chavePublicaPem, opcoes = {}) {
  const hoje = opcoes.agora ? hojeISO(opcoes.agora) : hojeISO();

  if (!licencaTexto) {
    return montar('ausente', null, { hoje });
  }

  const r = verificar(licencaTexto, chavePublicaPem);
  if (!r.valida) {
    return montar('invalida', r.dados, { hoje, detalhe: r.motivo });
  }

  const d = r.dados;
  const carencia = Number(d.carencia_dias || 0);
  const diasParaVencer = diasEntre(hoje, d.valido_ate);
  const fimCarencia = diasParaVencer + carencia;

  let situacao;
  if (diasParaVencer >= 0) {
    situacao = diasParaVencer <= (AVISO_DIAS[d.plano] || 30) ? 'vencendo' : 'ativa';
  } else if (fimCarencia >= 0) {
    situacao = 'carencia';
  } else {
    situacao = 'vencida';
  }

  /* Licença de outro escritório: avisa, não bloqueia. É o caso mais fácil de
     resolver justamente porque é o mais visível — aparece na tela do cliente e
     no registro de quem emitiu, ao mesmo tempo. */
  let alerta = null;
  if (opcoes.cnpjEscritorio &&
      String(opcoes.cnpjEscritorio).replace(/\D/g, '') !== String(d.escritorio.cnpj)) {
    alerta = 'Esta licença foi emitida para outro CNPJ (' + d.escritorio.cnpj +
      '). Confira com quem forneceu.';
  }

  return montar(situacao, d, { hoje, diasParaVencer, diasDeCarenciaRestantes: fimCarencia, alerta });
}

function montar(situacao, dados, extra) {
  /* Emitir é sempre verdadeiro. Está escrito como constante, e não calculado,
     porque a próxima pessoa a mexer aqui precisa ver que não há caminho que
     torne isso falso. */
  const podeEmitir = true;

  const degradado = situacao === 'vencida' || situacao === 'invalida' || situacao === 'ausente';
  const recursos = {};
  for (const r of RECURSOS_LICENCIADOS) {
    const contratado = !dados || !Array.isArray(dados.recursos) || dados.recursos.includes(r);
    recursos[r] = contratado && !degradado;
  }

  return {
    situacao,
    texto: SITUACOES[situacao],
    detalhe: extra.detalhe || null,
    alerta: extra.alerta || null,
    podeEmitir,
    recursos,
    /* Terminais é limite CONTRATADO, não trava: passar dele gera cobrança,
       não bloqueio. Quem estoura o limite continua trabalhando e aparece no
       relatório de quem vende. */
    terminaisContratados: dados && dados.terminais != null ? Number(dados.terminais) : null,
    escritorio: dados ? dados.escritorio : null,
    plano: dados ? dados.plano : null,
    validoAte: dados ? dados.valido_ate : null,
    id: dados ? dados.id : null,
    diasParaVencer: extra.diasParaVencer != null ? extra.diasParaVencer : null,
    diasDeCarenciaRestantes: extra.diasDeCarenciaRestantes != null
      ? extra.diasDeCarenciaRestantes : null,
    hoje: extra.hoje
  };
}

module.exports = { avaliar, RECURSOS_LICENCIADOS, SITUACOES, AVISO_DIAS, diasEntre };
