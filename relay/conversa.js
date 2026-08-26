/* A conversa do cliente no WhatsApp.
 *
 * Roda AQUI e não no gateway, e o motivo é o relógio: o gateway busca de tempos
 * em tempos, então cada pergunta que dependesse dele teria quinze segundos de
 * espera entre uma mensagem e a próxima. No WhatsApp isso é uma conversa morta.
 * Aqui a resposta é imediata, e só o pedido pronto vai para a fila.
 *
 * O ATALHO É O DESENHO. No escritório, a nota do mês é quase sempre igual à do
 * mês passado — mesmo cliente, mesmo serviço, às vezes até o mesmo valor. Então
 * o caminho curto ("a de sempre") é o primeiro, e o caminho longo existe para
 * a exceção. Quem foge muito do padrão cai na fila do contador, que tem a tela
 * boa para resolver.
 *
 * QUEM ERRA. Toda pergunta aceita "voltar", "cancelar" e "ajuda", digitados ou
 * pelo número. Resposta que não dá para entender não repete a pergunta seca:
 * mostra as opções de novo. Três tentativas e a conversa se oferece para
 * recomeçar, em vez de prender a pessoa num canto.
 */

const dinheiro = v => 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/* Leitura de valor em português. Mesma regra do gateway: vírgula é decimal,
   ponto é milhar quando separa três dígitos. */
function lerValor(texto) {
  let v = String(texto == null ? '' : texto).trim().replace(/\s|R\$|reais/gi, '');
  if (v === '') return undefined;
  if (!/^[\d.,]+$/.test(v)) return NaN;
  if (v.indexOf(',') >= 0) {
    if (v.split(',').length > 2) return NaN;
    v = v.replace(/\./g, '').replace(',', '.');
  } else if (v.indexOf('.') >= 0) {
    const grupos = v.split('.');
    const ultimo = grupos[grupos.length - 1];
    if (ultimo.length === 3 && (grupos.length > 2 || grupos[0].length <= 3)) {
      v = grupos.join('');
    }
  }
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

const CANCELAR = /^(cancelar|cancela|sair|parar|nao quero|não quero)$/i;
const VOLTAR = /^(voltar|volta|corrigir|errei|anterior)$/i;
const AJUDA = /^(ajuda|help|\?|menu|oi|ola|olá|bom dia|boa tarde|boa noite)$/i;

/* Escolha por número ou por texto. A pessoa responde "1" tanto quanto
   "sim, é esse" — as duas precisam funcionar. */
function escolher(texto, opcoes) {
  const t = String(texto || '').trim().toLowerCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= opcoes.length) return opcoes[n - 1];
  return opcoes.find(o => (o.sinonimos || []).some(s => t === s || t.includes(s))) || null;
}

function menu(opcoes) {
  return opcoes.map((o, i) => (i + 1) + ' — ' + o.rotulo).join('\n');
}

/* -------------------------------------------------------------- a conversa */

/* Recebe a mensagem e devolve { resposta, estado, dados, pedido? }.
 * Função pura: não grava nem envia nada. Quem chama decide o que fazer com o
 * resultado — o que torna a conversa inteira testável sem WhatsApp nenhum. */
function responder({ texto, quem, conversa, memoria }) {
  const { contato, empresa } = quem;
  const estado = conversa ? conversa.estado : 'inicio';
  const dados = conversa ? Object.assign({}, conversa.dados) : {};
  const t = String(texto || '').trim();

  // ---------------------------------------------------- comandos universais
  if (CANCELAR.test(t)) {
    return { resposta: 'Cancelado. É só chamar quando precisar.', estado: null };
  }
  /* A trava vem ANTES do menu, e não depois.
     Colocada depois, um "oi" recebia a lista de opções de uma empresa que não
     pode emitir, e a pessoa só descobria o bloqueio na mensagem seguinte —
     depois de já ter escolhido o que queria. */
  if (!empresa.liberado) {
    return {
      resposta: 'A emissão para *' + empresa.razaoSocial + '* está pausada.\n\n' +
                (empresa.motivoBloqueio || 'Fale com a contabilidade.'),
      estado: null
    };
  }

  if (AJUDA.test(t) && estado === 'inicio') {
    return abertura(empresa, contato, memoria);
  }
  if (VOLTAR.test(t)) {
    return abertura(empresa, contato, memoria, 'Sem problema, vamos do começo.');
  }

  switch (estado) {
    case 'inicio':          return doInicio(t, empresa, contato, memoria, dados);
    case 'escolhendo_valor':return doValor(t, empresa, contato, dados);
    case 'confirmando':     return doConfirmacao(t, empresa, contato, dados, memoria);
    case 'escolhendo_servico': return doServico(t, empresa, dados, memoria);
    default:                return abertura(empresa, contato, memoria);
  }
}

function abertura(empresa, contato, memoria, prefixo) {
  const anterior = empresa.ultimoPedido;
  const opcoes = [];
  if (anterior) {
    opcoes.push({ rotulo: 'A nota de sempre — ' + (anterior.tomador.nome || 'mesmo cliente') +
                          ', ' + dinheiro(anterior.valor), chave: 'sempre',
                  sinonimos: ['sempre', 'mesma', 'de sempre', 'igual'] });
  }
  opcoes.push({ rotulo: 'Outra nota', chave: 'outra', sinonimos: ['outra', 'nova', 'diferente'] });

  const cabeca = (prefixo ? prefixo + '\n\n' : '') +
    'Olá' + (contato.nome ? ', ' + contato.nome.split(' ')[0] : '') + '! ' +
    'Emissão de notas de *' + (empresa.nomeFantasia || empresa.razaoSocial) + '*.';

  return {
    resposta: cabeca + '\n\n' + menu(opcoes) +
      '\n\n_Responda com o número. "cancelar" encerra a qualquer momento._',
    estado: 'inicio',
    dados: { opcoes: opcoes.map(o => o.chave) }
  };
}

function doInicio(t, empresa, contato, memoria, dados) {
  const anterior = empresa.ultimoPedido;
  const opcoes = [];
  if (anterior) opcoes.push({ chave: 'sempre', sinonimos: ['sempre', 'mesma', 'de sempre', 'igual'] });
  opcoes.push({ chave: 'outra', sinonimos: ['outra', 'nova', 'diferente'] });

  const escolha = escolher(t, opcoes);
  if (!escolha) return naoEntendi(dados, () => abertura(empresa, contato, memoria));

  if (escolha.chave === 'sempre') {
    return {
      resposta: 'A última foi assim:\n\n' +
        '*Cliente:* ' + (anterior.tomador.nome || anterior.tomador.documento) + '\n' +
        '*Serviço:* ' + anterior.servico.descricao + '\n' +
        '*Valor:* ' + dinheiro(anterior.valor) + '\n\n' +
        '1 — Mesmo valor, ' + dinheiro(anterior.valor) + '\n' +
        '2 — Outro valor (digite quanto)',
      estado: 'escolhendo_valor',
      dados: { base: anterior }
    };
  }

  const servicos = memoria.servicosDa(empresa.cnpj);
  if (!servicos.length) {
    return {
      resposta: 'Para uma nota diferente eu preciso do serviço já cadastrado pela ' +
                'contabilidade, e ainda não há nenhum para esta empresa.\n\n' +
                'Fale com o escritório — assim que cadastrarem, aparece aqui.',
      estado: null
    };
  }
  return {
    resposta: 'Qual serviço?\n\n' +
      servicos.slice(0, 8).map((s, i) => (i + 1) + ' — ' + (s.apelido || s.descricao)).join('\n'),
    estado: 'escolhendo_servico',
    dados: { servicos: servicos.slice(0, 8).map(s => s.id) }
  };
}

function doServico(t, empresa, dados, memoria) {
  const servicos = memoria.servicosDa(empresa.cnpj)
    .filter(s => (dados.servicos || []).includes(s.id));
  const n = Number(String(t).trim());
  const s = Number.isInteger(n) && n >= 1 && n <= servicos.length ? servicos[n - 1] : null;
  if (!s) {
    return naoEntendi(dados, () => ({
      resposta: 'Responda com o número do serviço:\n\n' +
        servicos.map((x, i) => (i + 1) + ' — ' + (x.apelido || x.descricao)).join('\n'),
      estado: 'escolhendo_servico',
      dados
    }));
  }

  /* Sem o tomador não dá para emitir, e pedir CNPJ, nome e endereço por
     WhatsApp é onde a conversa vira formulário e a pessoa desiste. O caminho é
     o pedido chegar incompleto e o contador completar no painel — que é onde
     ele já faz isso todo dia. */
  const anterior = empresa.ultimoPedido;
  return {
    resposta: '*' + (s.apelido || s.descricao) + '*. Qual o valor?\n\n' +
      '_Digite como 1.500,00_' +
      (anterior ? '\n\nO cliente será ' + (anterior.tomador.nome || 'o mesmo da última nota') +
                  '. Para outro cliente, peça pela contabilidade.' : ''),
    estado: 'escolhendo_valor',
    dados: {
      base: {
        tomador: anterior ? anterior.tomador : null,
        servico: { codigoTributacao: s.codigoTributacao, descricao: s.descricao },
        valor: s.valorPadrao || null
      },
      servicoEscolhido: true
    }
  };
}

function doValor(t, empresa, contato, dados) {
  const base = dados.base;
  let valor = null;

  if (/^1$/.test(t.trim()) && base && base.valor && !dados.servicoEscolhido) {
    valor = base.valor;
  } else if (/^2$/.test(t.trim()) && !dados.servicoEscolhido) {
    return { resposta: 'Qual o valor?\n\n_Digite como 1.500,00_',
             estado: 'escolhendo_valor',
             dados: Object.assign({}, dados, { servicoEscolhido: true }) };
  } else {
    const v = lerValor(t);
    if (v === undefined || !isFinite(v)) {
      return naoEntendi(dados, () => ({
        resposta: 'Não entendi o valor. Digite só o número, como *1.500,00*.',
        estado: 'escolhendo_valor', dados
      }));
    }
    if (v <= 0) {
      return naoEntendi(dados, () => ({
        resposta: 'O valor precisa ser maior que zero.',
        estado: 'escolhendo_valor', dados
      }));
    }
    valor = v;
  }

  if (!base || !base.tomador || !base.servico) {
    return {
      resposta: 'Faltam dados para montar esta nota. Vou avisar a contabilidade — ' +
                'eles entram em contato.',
      estado: null
    };
  }

  const acimaDoTeto = contato.limiteValor != null && valor > contato.limiteValor;
  return {
    resposta: 'Confira antes de eu enviar:\n\n' +
      '*Empresa:* ' + (empresa.nomeFantasia || empresa.razaoSocial) + '\n' +
      '*Cliente:* ' + (base.tomador.nome || base.tomador.documento) + '\n' +
      '*Serviço:* ' + base.servico.descricao + '\n' +
      '*Valor:* ' + dinheiro(valor) + '\n\n' +
      (acimaDoTeto
        ? '_Acima do combinado para este número — a contabilidade vai conferir._\n\n'
        : '') +
      '1 — Confirmar\n2 — Cancelar',
    estado: 'confirmando',
    dados: Object.assign({}, dados, { valorEscolhido: valor })
  };
}

function doConfirmacao(t, empresa, contato, dados, memoria) {
  const escolha = escolher(t, [
    { chave: 'sim', sinonimos: ['sim', 'confirmar', 'confirmo', 'ok', 'pode'] },
    { chave: 'nao', sinonimos: ['nao', 'não', 'cancelar', 'errado'] }
  ]);
  if (!escolha) {
    return naoEntendi(dados, () => ({
      resposta: 'Responda *1* para confirmar ou *2* para cancelar.',
      estado: 'confirmando', dados
    }));
  }
  if (escolha.chave === 'nao') {
    return { resposta: 'Cancelado, nada foi enviado. É só chamar de novo.', estado: null };
  }

  const base = dados.base;
  const pedido = {
    id: 'wa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    origem: 'whatsapp',
    remetente: contato.telefone,
    cnpjEmpresa: empresa.cnpj,
    tomador: { cnpj: base.tomador.documento, razaoSocial: base.tomador.nome },
    servico: {
      codigoTributacaoNacional: base.servico.codigoTributacao,
      descricao: base.servico.descricao
    },
    valores: { valorServico: dados.valorEscolhido }
  };

  return {
    resposta: 'Pedido enviado. A contabilidade confere e eu te aviso aqui assim ' +
              'que a nota sair.',
    estado: null,
    pedido
  };
}

/* Três recusas na mesma pergunta é o sistema prendendo a pessoa. */
function naoEntendi(dados, refazer) {
  const erros = (dados.erros || 0) + 1;
  const r = refazer();
  if (erros >= 3) {
    return {
      resposta: r.resposta + '\n\n_Se preferir, digite "cancelar" e me chame de novo._',
      estado: r.estado,
      dados: Object.assign({}, r.dados || dados, { erros: 0 })
    };
  }
  return {
    resposta: r.resposta,
    estado: r.estado,
    dados: Object.assign({}, r.dados || dados, { erros })
  };
}

/* O aviso de desfecho, quando o gateway devolve. O link é o da consulta pública
   da Sefin — o mesmo endereço do QR Code impresso na nota. Público por
   natureza, e por isso nenhum documento fiscal precisa passar por aqui. */
function avisoDeDesfecho(desfecho) {
  if (desfecho.situacao === 'emitida' && desfecho.chaveAcesso) {
    return 'Nota autorizada! Série ' + desfecho.serie + ', número ' + desfecho.numero +
      '.\n\nPDF e XML em:\nhttps://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=' +
      desfecho.chaveAcesso;
  }
  if (desfecho.situacao === 'recusada') {
    return 'A contabilidade não aprovou este pedido.\n\n' +
      (desfecho.motivo || 'Fale com o escritório para entender.');
  }
  if (desfecho.situacao === 'rejeitada') {
    return 'A prefeitura recusou a nota.\n\n' + (desfecho.motivo || '') +
      '\n\nA contabilidade já foi avisada e vai resolver.';
  }
  return 'Houve um problema com o pedido.\n\n' + (desfecho.motivo || '') +
    '\n\nA contabilidade foi avisada.';
}

module.exports = { responder, avisoDeDesfecho, lerValor, dinheiro, escolher };
