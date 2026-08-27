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
/* "quero falar com alguém" precisa levar a alguém.
   A pesquisa de conversa automatizada é unânime nisso: o cliente perdoa o robô
   não saber, e não perdoa ficar preso nele. */
const HUMANO = /^(atendente|humano|pessoa|falar com|contador|ajuda humana|nao consigo|não consigo)/i;
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
async function responder({ texto, telefone, vinculos, conversa, memoria, buscarCnpj }) {
  const estado = conversa ? conversa.estado : 'inicio';
  const dados = conversa ? Object.assign({}, conversa.dados) : {};
  const t = String(texto || '').trim();

  if (!vinculos || !vinculos.length) {
    return {
      resposta: 'Este número não está autorizado a pedir notas.\n\n' +
                'Se você é cliente do escritório, peça para cadastrarem seu WhatsApp.',
      estado: null
    };
  }

  /* A empresa escolhida vive no estado da conversa, e é reconferida contra o
     cadastro a cada passo. Guardar só o CNPJ e confiar nele depois deixaria uma
     conversa antiga continuar valendo depois de o escritório tirar o número
     daquela empresa. */
  let escolhido = dados.cnpj ? memoria.conferirEscolha(telefone, dados.cnpj) : null;
  if (dados.cnpj && !escolhido) {
    return {
      resposta: 'O acesso a essa empresa mudou. Vamos começar de novo.',
      estado: null
    };
  }
  const contato = escolhido ? escolhido.contato : vinculos[0].contato;
  const empresa = escolhido ? escolhido.empresa : null;

  // ---------------------------------------------------- comandos universais
  if (CANCELAR.test(t)) {
    return { resposta: 'Cancelado. É só chamar quando precisar.', estado: null };
  }
  if (HUMANO.test(t)) {
    const casa = memoria.escritorio() || {};
    return {
      resposta: 'Claro. Eu sou automático e só sei emitir nota — para o resto, ' +
        'fale direto com ' + (casa.nome || 'a contabilidade') + ':\n\n' +
        (casa.telefone ? '📞 ' + formatarTelefone(casa.telefone) + '\n' : '') +
        (casa.email ? '✉ ' + casa.email : '') +
        (!casa.telefone && !casa.email ? 'procure o escritório pelos canais de sempre.' : ''),
      estado: null
    };
  }
  /* A trava vem ANTES do menu, e não depois.
     Colocada depois, um "oi" recebia a lista de opções de uma empresa que não
     pode emitir, e a pessoa só descobria o bloqueio na mensagem seguinte —
     depois de já ter escolhido o que queria. */
  if (empresa && !empresa.liberado) {
    return {
      resposta: 'A emissão para *' + empresa.razaoSocial + '* está pausada.\n\n' +
                (empresa.motivoBloqueio || 'Fale com a contabilidade.'),
      estado: null
    };
  }

  /* "oi" no meio da conversa é alguém querendo recomeçar, não uma resposta à
     pergunta que está na tela. Antes caía no passo atual e recebia "não
     entendi", o que é a pior resposta possível para quem só quis cumprimentar. */
  if (VOLTAR.test(t) || AJUDA.test(t)) {
    const recomecando = estado !== 'inicio' && estado !== 'escolhendo_empresa';
    return escolherEmpresa(vinculos, telefone, memoria,
      VOLTAR.test(t) ? 'Sem problema, vamos do começo.'
        : recomecando ? 'Recomeçando — o pedido anterior não foi enviado.' : null);
  }

  switch (estado) {
    case 'escolhendo_empresa': return doEmpresa(t, vinculos, telefone, memoria, dados);
    case 'inicio':          return doInicio(t, empresa, contato, memoria, dados);
    case 'documento_novo': return doDocumento(t, empresa, memoria, dados, buscarCnpj);
    case 'conferindo_cliente': return doConferirCliente(t, empresa, memoria, dados);
    case 'nome_novo':       return doNomeNovo(t, empresa, memoria, dados);
    case 'escolhendo_valor':return doValor(t, empresa, contato, dados);
    case 'confirmando':     return doConfirmacao(t, empresa, contato, dados, memoria);
    case 'escolhendo_servico': return doServico(t, empresa, dados, memoria);
    default:                return escolherEmpresa(vinculos, telefone, memoria);
  }
}

/* Por qual empresa?
 *
 * Com um vínculo só, não há o que perguntar — mas a empresa aparece escrita na
 * abertura e de novo na conferência, porque no WhatsApp não existe barra fixa
 * mostrando onde a pessoa está. Com dois ou mais, a pergunta é obrigatória e
 * vem antes de tudo: emitir no CNPJ errado é nota fiscal no cliente errado.
 */
function escolherEmpresa(vinculos, telefone, memoria, prefixo) {
  if (vinculos.length === 1) {
    const { contato, empresa } = vinculos[0];
    if (!empresa.liberado) {
      return {
        resposta: 'A emissão para *' + empresa.razaoSocial + '* está pausada.\n\n' +
                  (empresa.motivoBloqueio || 'Fale com a contabilidade.'),
        estado: null
      };
    }
    const inicio = abertura(empresa, contato, memoria, prefixo);
    return Object.assign(inicio, {
      dados: Object.assign({}, inicio.dados, { cnpj: empresa.cnpj })
    });
  }

  const lista = vinculos.map((v, i) =>
    (i + 1) + ' — ' + (v.empresa.nomeFantasia || v.empresa.razaoSocial) +
    '\n     ' + formatarCnpj(v.empresa.cnpj)).join('\n');

  const casa = (memoria.escritorio() || {}).nome;
  return {
    resposta: (prefixo ? prefixo + '\n\n' : '') +
      (casa ? '*' + casa + '*\nEmissão de notas fiscais.\n\n' : '') +
      'Você emite por mais de uma empresa. Por qual será esta nota?\n\n' + lista +
      '\n\n_Responda com o número, ou digite o CNPJ._',
    estado: 'escolhendo_empresa',
    dados: {}
  };
}

function doEmpresa(t, vinculos, telefone, memoria, dados) {
  const limpo = String(t).replace(/[^0-9A-Za-z]/g, '');
  let alvo = null;

  // Pelo número da lista
  const n = Number(String(t).trim());
  if (Number.isInteger(n) && n >= 1 && n <= vinculos.length) {
    alvo = vinculos[n - 1];
  } else if (limpo.length === 14) {
    /* CNPJ digitado: conferido contra o cadastro DESTE número. Um CNPJ que
       existe no escritório mas não está vinculado aqui recebe a mesma resposta
       de um CNPJ inventado — senão a conversa vira um jeito de descobrir quais
       empresas o escritório atende. */
    alvo = memoria.conferirEscolha(telefone, limpo);
  }

  if (!alvo) {
    return naoEntendi(dados, () => escolherEmpresa(vinculos, telefone, memoria,
      'Não encontrei essa empresa entre as suas.'));
  }
  if (!alvo.empresa.liberado) {
    return {
      resposta: 'A emissão para *' + alvo.empresa.razaoSocial + '* está pausada.\n\n' +
                (alvo.empresa.motivoBloqueio || 'Fale com a contabilidade.'),
      estado: null
    };
  }

  const inicio = abertura(alvo.empresa, alvo.contato, memoria);
  return Object.assign(inicio, {
    dados: Object.assign({}, inicio.dados, { cnpj: alvo.empresa.cnpj })
  });
}

function formatarCnpj(c) {
  const d = String(c || '');
  return d.length === 14
    ? d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' +
      d.slice(8, 12) + '-' + d.slice(12)
    : d;
}

/* As opções do menu, montadas num lugar só.
 *
 * Estavam duplicadas — uma cópia para escrever o menu, outra para ler a
 * resposta — e divergiram na primeira alteração: o menu ganhou "cliente novo" e
 * a leitura continuou com duas opções, então escolher a terceira devolvia o
 * menu de novo, sem erro nenhum aparente. */
function opcoesDoInicio(empresa) {
  const anterior = empresa.ultimoPedido;
  const opcoes = [];
  if (anterior) {
    opcoes.push({ rotulo: 'A nota de sempre — ' + (anterior.tomador.nome || 'mesmo cliente') +
                          ', ' + dinheiro(anterior.valor), chave: 'sempre',
                  sinonimos: ['sempre', 'mesma', 'de sempre', 'igual'] });
  }
  opcoes.push({ rotulo: 'Outra nota', chave: 'outra',
                sinonimos: ['outra', 'nova', 'diferente'] });
  opcoes.push({ rotulo: 'Nota para um cliente novo', chave: 'novo',
                sinonimos: ['novo', 'cliente novo', 'outro cliente'] });
  return opcoes;
}

function abertura(empresa, contato, memoria, prefixo) {
  const opcoes = opcoesDoInicio(empresa);

  /* QUEM ESTÁ FALANDO vem antes de tudo.
     Do outro lado é uma janela de WhatsApp e um número que a pessoa não
     conhece. Sem o nome do escritório, a primeira mensagem parece golpe — e
     alguém que emite nota fiscal por um sistema que parece golpe não emite. */
  /* Dizer que é automático é a primeira regra de conversa por robô, e a que
     mais evita frustração: a pessoa calibra o que pedir. Junto vai a saída para
     gente, porque ninguém perdoa ficar preso num bot. */
  const casa = (memoria.escritorio() || {}).nome;
  const apresentacao = casa
    ? '*' + casa + '*\n_Atendimento automático para emissão de notas._\n\n'
    : '';

  /* A empresa vai escrita por extenso, com CNPJ, e volta na conferência. É o
     que substitui a barra fixa do painel: no WhatsApp a pessoa rola a tela e
     perde a referência, e emitir no CNPJ errado é nota no cliente errado. */
  const cabeca = (prefixo ? prefixo + '\n\n' : '') + apresentacao +
    'Olá' + (contato.nome ? ', ' + contato.nome.split(' ')[0] : '') + '! ' +
    'Nota por *' + (empresa.nomeFantasia || empresa.razaoSocial) + '*' +
    '\n' + formatarCnpj(empresa.cnpj) + '.';

  return {
    resposta: cabeca + '\n\n' + menu(opcoes) +
      '\n\n_Responda com o número. "cancelar" encerra; "atendente" chama uma pessoa._',
    estado: 'inicio',
    /* O CNPJ escolhido acompanha TODA resposta a partir daqui. Sem ele, uma
       recusa no meio ("nao entendi") devolvia o menu sem a empresa, e a
       conversa recomecava do zero perdendo a escolha e a contagem de erros. */
    dados: { cnpj: empresa.cnpj, opcoes: opcoes.map(o => o.chave) }
  };
}

function doInicio(t, empresa, contato, memoria, dados) {
  const anterior = empresa.ultimoPedido;
  const escolha = escolher(t, opcoesDoInicio(empresa));
  if (!escolha) return naoEntendi(dados, () => abertura(empresa, contato, memoria));

  if (escolha.chave === 'novo') {
    /* Só o documento. Pedir razão social, endereço e CEP por WhatsApp é onde a
       conversa vira formulário e a pessoa desiste — o resto o gateway busca na
       base pública, que é onde esse acesso existe. */
    return {
      resposta: 'Qual o CNPJ do cliente?\n\n' +
        '_Só o número. Eu busco a razão social e o endereço na base da Receita._',
      estado: 'documento_novo',
      dados: { cnpj: empresa.cnpj }
    };
  }

  if (escolha.chave === 'sempre') {
    return {
      resposta: 'A última foi assim:\n\n' +
        '*Cliente:* ' + (anterior.tomador.nome || anterior.tomador.documento) + '\n' +
        '*Serviço:* ' + anterior.servico.descricao + '\n' +
        '*Valor:* ' + dinheiro(anterior.valor) + '\n\n' +
        '1 — Mesmo valor, ' + dinheiro(anterior.valor) + '\n' +
        '2 — Outro valor (digite quanto)',
      estado: 'escolhendo_valor',
      dados: { cnpj: empresa.cnpj, base: anterior }
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
    dados: { cnpj: empresa.cnpj, servicos: servicos.slice(0, 8).map(s => s.id) }
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
  /* Cliente novo já vem com o nome conferido pela pessoa; senão, é o mesmo da
     última nota. */
  const tomador = dados.documentoNovo
    ? { documento: dados.documentoNovo, nome: dados.nomeNovo || null, novo: true,
        endereco: dados.dadosDaReceita || null }
    : (anterior ? anterior.tomador : null);

  return {
    resposta: '*' + (s.apelido || s.descricao) + '*. Qual o valor?\n\n' +
      '_Digite como 1.500,00_' +
      (dados.documentoNovo
        ? '\n\nCliente: ' + (dados.nomeNovo || formatarCnpj(dados.documentoNovo))
        : anterior ? '\n\nO cliente será ' + (anterior.tomador.nome || 'o mesmo da última nota') + '.'
        : ''),
    estado: 'escolhendo_valor',
    dados: {
      cnpj: empresa.cnpj,
      documentoNovo: dados.documentoNovo,
      nomeNovo: dados.nomeNovo,
      base: {
        tomador: tomador,
        servico: { codigoTributacao: s.codigoTributacao, descricao: s.descricao },
        valor: s.valorPadrao || null
      },
      servicoEscolhido: true
    }
  };
}

/* O documento do cliente novo.
 *
 * Aqui só se confere a FORMA — 11 ou 14 dígitos. O dígito verificador fica com
 * o gateway: a regra mudou em julho/2026 (CNPJ alfanumérico) e manter duas
 * cópias dela seria uma divergindo da outra. Documento com dígito errado volta
 * como recusa, com o motivo, até esta mesma conversa.
 */
async function doDocumento(t, empresa, memoria, dados, buscarCnpj) {
  const doc = String(t).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (doc.length !== 14 && doc.length !== 11) {
    return naoEntendi(dados, () => ({
      resposta: 'Esse documento não parece certo.\n\n' +
        'CNPJ tem 14 caracteres e CPF tem 11 — você mandou ' + doc.length + '.',
      estado: 'documento_novo', dados
    }));
  }

  if (!memoria.servicosDa(empresa.cnpj).length) {
    return {
      resposta: 'Para uma nota nova eu preciso do serviço já cadastrado pela ' +
                'contabilidade, e ainda não há nenhum para esta empresa.\n\n' +
                'Fale com o escritório.',
      estado: null
    };
  }

  const base = Object.assign({}, dados, { documentoNovo: doc });

  /* CPF a base pública não devolve — não existe consulta de pessoa física
     aberta, e não deveria existir. Então o nome é perguntado, que é o único
     campo que a DPS exige além do documento. */
  if (doc.length === 11) {
    return {
      resposta: 'CPF ' + formatarCpf(doc) + '.\n\n' +
        'Qual o nome completo da pessoa?\n\n' +
        '_Pessoa física não tem consulta pública, então preciso perguntar._',
      estado: 'nome_novo',
      dados: base
    };
  }

  /* CNPJ: busca e MOSTRA. Antes a consulta acontecia depois da conversa, do
     outro lado, e o cliente nunca via o resultado — se a base estivesse
     desatualizada, ninguém percebia até a nota sair com o nome errado. */
  const achado = buscarCnpj ? await buscarCnpj(doc) : null;
  if (!achado) {
    return {
      resposta: 'Não consegui os dados desse CNPJ na base pública agora.\n\n' +
        'Qual a razão social do cliente?',
      estado: 'nome_novo',
      dados: base
    };
  }

  const endereco = require('./receita').enderecoEmUmaLinha(achado);
  return {
    resposta: 'Achei:\n\n' +
      '*' + achado.nome + '*\n' +
      formatarCnpj(doc) + '\n' +
      (endereco ? endereco + '\n' : '') +
      (achado.situacao && achado.situacao.toUpperCase() !== 'ATIVA'
        ? '\n⚠ Situação na Receita: *' + achado.situacao + '*\n' : '') +
      '\n1 — Está certo\n' +
      '2 — O nome está diferente (digite o certo)',
    estado: 'conferindo_cliente',
    dados: Object.assign({}, base, { achado })
  };
}

/* A pessoa confere o que a base devolveu.
   A Receita atrasa: empresa que mudou de nome há dois meses ainda aparece com o
   antigo. Quem pede a nota conhece o cliente melhor do que a base — então a
   correção dela vale, e o contador confere na aprovação de todo jeito. */
function doConferirCliente(t, empresa, memoria, dados) {
  const escolha = escolher(t, [
    { chave: 'certo', sinonimos: ['certo', 'sim', 'confirmo', 'ok', 'isso'] },
    { chave: 'corrigir', sinonimos: ['nao', 'não', 'errado', 'diferente', 'corrigir'] }
  ]);

  if (escolha && escolha.chave === 'certo') {
    return seguirParaServico(empresa, memoria, Object.assign({}, dados, {
      nomeNovo: dados.achado.nome, dadosDaReceita: dados.achado
    }));
  }
  if (escolha && escolha.chave === 'corrigir') {
    return {
      resposta: 'Sem problema. Qual a razão social correta?',
      estado: 'nome_novo', dados
    };
  }

  /* Quem responde direto com o nome novo, em vez de "2", está corrigindo —
     obrigar a passar pelo menu seria burocracia sem motivo. */
  if (t.length >= 3 && !/^\d+$/.test(t)) {
    return seguirParaServico(empresa, memoria, Object.assign({}, dados, {
      nomeNovo: t.slice(0, 300), nomeCorrigido: true,
      dadosDaReceita: dados.achado
    }));
  }

  return naoEntendi(dados, () => ({
    resposta: 'Responda *1* se está certo, ou escreva a razão social correta.',
    estado: 'conferindo_cliente', dados
  }));
}

function doNomeNovo(t, empresa, memoria, dados) {
  if (t.length < 3) {
    return naoEntendi(dados, () => ({
      resposta: 'O nome ficou curto demais. Escreva como deve sair na nota.',
      estado: 'nome_novo', dados
    }));
  }
  return seguirParaServico(empresa, memoria, Object.assign({}, dados, {
    nomeNovo: t.slice(0, 300)
  }));
}

function seguirParaServico(empresa, memoria, dados) {
  const servicos = memoria.servicosDa(empresa.cnpj);
  return {
    resposta: 'Certo. Qual serviço?\n\n' +
      servicos.slice(0, 8).map((x, i) => (i + 1) + ' — ' + (x.apelido || x.descricao)).join('\n'),
    estado: 'escolhendo_servico',
    dados: Object.assign({}, dados, { servicos: servicos.slice(0, 8).map(x => x.id) })
  };
}

function formatarCpf(d) {
  const c = String(d || '');
  return c.length === 11
    ? c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9)
    : c;
}

function formatarTelefone(d) {
  const c = String(d || '').replace(/\D/g, '');
  if (c.length === 13 && c.startsWith('55')) {
    return '(' + c.slice(2, 4) + ') ' + c.slice(4, 9) + '-' + c.slice(9);
  }
  if (c.length === 12 && c.startsWith('55')) {
    return '(' + c.slice(2, 4) + ') ' + c.slice(4, 8) + '-' + c.slice(8);
  }
  if (c.length === 11) return '(' + c.slice(0, 2) + ') ' + c.slice(2, 7) + '-' + c.slice(7);
  if (c.length === 10) return '(' + c.slice(0, 2) + ') ' + c.slice(2, 6) + '-' + c.slice(6);
  return c;
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
      '*Empresa:* ' + (empresa.nomeFantasia || empresa.razaoSocial) +
        ' — ' + formatarCnpj(empresa.cnpj) + '\n' +
      '*Cliente:* ' + (base.tomador.nome ||
        formatarCnpj(base.tomador.documento) +
        (base.tomador.novo ? ' _(novo — a contabilidade confere)_' : '')) + '\n' +
      '*Serviço:* ' + base.servico.descricao + '\n' +
      '*Valor:* ' + dinheiro(valor) + '\n\n' +
      (acimaDoTeto
        ? '_Acima do combinado para este número — a contabilidade vai conferir._\n\n'
        : '') +
      '1 — Confirmar\n2 — Corrigir o valor\n3 — Cancelar',
    estado: 'confirmando',
    dados: Object.assign({}, dados, { valorEscolhido: valor })
  };
}

function doConfirmacao(t, empresa, contato, dados, memoria) {
  const escolha = escolher(t, [
    { chave: 'sim', sinonimos: ['sim', 'confirmar', 'confirmo', 'ok', 'pode'] },
    { chave: 'valor', sinonimos: ['corrigir', 'valor errado', 'outro valor', 'mudar'] },
    { chave: 'nao', sinonimos: ['nao', 'não', 'cancelar', 'errado'] }
  ]);
  if (!escolha) {
    return naoEntendi(dados, () => ({
      resposta: 'Responda *1* para confirmar, *2* para corrigir o valor ou ' +
                '*3* para cancelar.',
      estado: 'confirmando', dados
    }));
  }
  if (escolha.chave === 'nao') {
    return { resposta: 'Cancelado, nada foi enviado. É só chamar de novo.', estado: null };
  }
  /* Valor errado não deveria custar recomeçar tudo. Era o caminho antes: só
     cancelar e refazer as quatro respostas. */
  if (escolha.chave === 'valor') {
    return {
      resposta: 'Qual o valor correto?\n\n_Digite como 1.500,00_',
      estado: 'escolhendo_valor',
      dados: Object.assign({}, dados, { servicoEscolhido: true, valorEscolhido: null })
    };
  }

  const base = dados.base;
  const pedido = {
    id: 'wa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    origem: 'whatsapp',
    remetente: contato.telefone,
    /* A conversa inteira vai junto. É o que responde "eu não pedi essa nota":
       o pedido pronto não prova nada, o diálogo prova. Fica no gateway, ao lado
       da solicitação, e some daqui quando o pedido é buscado. */
    transcricao: (dados.transcricao || []).slice(-60),
    cnpjEmpresa: empresa.cnpj,
    /* O nome vai como a pessoa confirmou — ela conhece o cliente dela melhor
       que uma base pública que pode estar meses atrasada. O gateway confere o
       documento e o contador aprova de todo jeito. */
    tomador: Object.assign(
      { razaoSocial: base.tomador.nome },
      String(base.tomador.documento || '').length === 11
        ? { cpf: base.tomador.documento }
        : { cnpj: base.tomador.documento },
      base.tomador.endereco && base.tomador.endereco.codigoMunicipio ? {
        endereco: {
          codigoMunicipio: base.tomador.endereco.codigoMunicipio,
          cep: base.tomador.endereco.cep,
          logradouro: base.tomador.endereco.logradouro,
          numero: base.tomador.endereco.numero,
          complemento: base.tomador.endereco.complemento,
          bairro: base.tomador.endereco.bairro
        }
      } : {}),
    servico: {
      codigoTributacaoNacional: base.servico.codigoTributacao,
      descricao: base.servico.descricao
    },
    valores: { valorServico: dados.valorEscolhido }
  };

  return {
    /* O fim precisa ser dito. Sem isso a pessoa fica olhando a tela sem saber
       se acabou, se pode mandar outro, ou se está esperando alguma coisa. */
    resposta: '✓ Pedido enviado.\n\n' +
              'A contabilidade confere e eu te aviso aqui assim que a nota sair.\n\n' +
              '_Precisa de outra? É só escrever "oi"._',
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
