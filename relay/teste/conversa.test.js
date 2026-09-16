const test = require('node:test');
const assert = require('node:assert');

const conversa = require('../conversa');
const { Memoria } = require('../memoria');

/* A conversa do cliente, testada sem WhatsApp nenhum.
 *
 * `responder` é função pura: recebe a mensagem e o estado, devolve a resposta e
 * o estado seguinte. Não grava, não envia. É o que permite exercitar aqui os
 * caminhos que no WhatsApp exigiriam um número de verdade — inclusive os
 * caminhos de erro, que são justamente os que ninguém testa à mão.
 */

function memoriaFalsa(extra) {
  const m = new Memoria(require('path').join(
    require('os').tmpdir(), 'relay-teste-' + Math.random().toString(36).slice(2) + '.json'));
  m.dados.cadastro = Object.assign({
    versao: 'v1',
    whatsapp: [{ telefone: '5541999998888', cnpj: '11111111000191',
                 nome: 'Maria Financeiro', limiteValor: 5000 }],
    empresas: [{
      cnpj: '11111111000191', razaoSocial: 'ALFA COMERCIO LTDA',
      nomeFantasia: 'ALFA', ativo: true, liberado: true, motivoBloqueio: null,
      ultimoPedido: {
        tomador: { documento: '22222222000191', nome: 'CLIENTE MENSAL LTDA' },
        servico: { codigoTributacao: '010101', descricao: 'Manutencao mensal' },
        valor: 2500
      }
    }],
    servicos: [
      { id: 1, cnpj: '11111111000191', apelido: 'Consultoria',
        descricao: 'Consultoria tecnica', codigoTributacao: '010201', valorPadrao: null }
    ],
    acessos: []
  }, extra || {});
  m.salvar = () => {};           // não escreve em disco no teste
  return m;
}

/* A consulta pública entra por injeção: assim a conversa é exercitada sem
   rede nenhuma, e o teste controla o que a base "responde" — inclusive estar
   fora do ar. */
function buscaFalsa(resposta) {
  return async doc => (resposta === undefined ? {
    documento: doc, nome: 'CLIENTE DA RECEITA LTDA', situacao: 'ATIVA',
    logradouro: 'RUA TESTE', numero: '100', bairro: 'CENTRO',
    cep: '80010000', uf: 'PR', municipio: 'CURITIBA', codigoMunicipio: '4106902'
  } : resposta);
}

async function dialogo(memoria, tel, mensagens, buscarCnpj) {
  let estado = null;
  const saidas = [];
  for (const texto of mensagens) {
    const saida = await conversa.responder({
      texto, telefone: tel, vinculos: memoria.empresasDe(tel),
      conversa: estado, memoria, buscarCnpj: buscarCnpj || buscaFalsa()
    });
    saidas.push(saida);
    estado = saida.estado ? { estado: saida.estado, dados: saida.dados, em: new Date().toISOString() } : null;
  }
  return saidas;
}

/* Segunda empresa para o mesmo número, para exercitar a escolha. */
function comDuasEmpresas() {
  const m = memoriaFalsa();
  m.dados.cadastro.whatsapp.push({
    telefone: '5541999998888', cnpj: '33333333000191',
    nome: 'Maria Financeiro', limiteValor: 5000
  });
  m.dados.cadastro.empresas.push({
    cnpj: '33333333000191', razaoSocial: 'BETA SERVICOS ME',
    nomeFantasia: 'BETA', ativo: true, liberado: true, motivoBloqueio: null,
    ultimoPedido: {
      tomador: { documento: '44444444000191', nome: 'OUTRO CLIENTE SA' },
      servico: { codigoTributacao: '020202', descricao: 'Servico da BETA' },
      valor: 800
    }
  });
  return m;
}

/* --------------------------------------------------------- o caminho curto */

test('a nota de sempre sai em três respostas', async () => {
  /* É o caso dominante no escritório: mesmo cliente, mesmo serviço, mesmo
     valor, todo mês. Se isso custar seis perguntas, o WhatsApp não vale a pena. */
  const m = memoriaFalsa();
  const [oi, sempre, valor, confirma] = await dialogo(m, '5541999998888', ['oi', '1', '1', '1']);

  assert.match(oi.resposta, /A nota de sempre/);
  assert.match(oi.resposta, /CLIENTE MENSAL LTDA/);
  assert.match(sempre.resposta, /Manutencao mensal/);
  assert.match(sempre.resposta, /R\$ 2\.500,00/);
  assert.match(valor.resposta, /Confira antes de eu enviar/);
  assert.ok(confirma.pedido, 'a confirmação precisa produzir o pedido');
  assert.equal(confirma.pedido.cnpjEmpresa, '11111111000191');
  assert.equal(confirma.pedido.valores.valorServico, 2500);
  assert.equal(confirma.pedido.origem, 'whatsapp');
  assert.equal(confirma.pedido.remetente, '5541999998888');
});

test('o pedido leva o serviço e o tomador da nota anterior', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  const p = saidas[3].pedido;
  assert.equal(p.tomador.cnpj, '22222222000191');
  assert.equal(p.servico.codigoTributacaoNacional, '010101');
  assert.equal(p.servico.descricao, 'Manutencao mensal');
});

test('valor diferente do de sempre', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '2', '3.200,50', '1']);
  assert.match(saidas[2].resposta, /Qual o valor/);
  assert.match(saidas[3].resposta, /R\$ 3\.200,50/);
  assert.equal(saidas[4].pedido.valores.valorServico, 3200.5);
});

/* -------------------------------------------------------- quem não é ninguém */

test('número desconhecido não descobre nada do escritório', async () => {
  /* Nem que empresas existem, nem que o serviço existe. */
  const m = memoriaFalsa();
  assert.deepEqual(m.empresasDe('5511888887777'), []);
  const [r] = await dialogo(m, '5511888887777', ['oi']);
  assert.match(r.resposta, /não está autorizado/);
  assert.ok(!/ALFA|CLIENTE MENSAL|11111111/.test(r.resposta),
    'sem revelar empresa nem cliente');
});

test('mensagem repetida não vira dois pedidos', async () => {
  /* A assinatura da Meta continua válida para sempre; quem capturar um POST
     assinado pode reenviá-lo. O wamid visto uma vez não vale de novo. */
  const m = memoriaFalsa();
  assert.equal(m.jaVi('wamid.abc'), false, 'primeira vez passa');
  assert.equal(m.jaVi('wamid.abc'), true, 'segunda é ignorada');
  assert.equal(m.jaVi('wamid.xyz'), false, 'outra mensagem passa normalmente');
});

test('o número só fala pelas empresas dele', async () => {
  const m = memoriaFalsa();
  const lista = m.empresasDe('5541999998888');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].empresa.cnpj, '11111111000191');
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  assert.equal(saidas[3].pedido.cnpjEmpresa, '11111111000191',
    'o CNPJ sai do cadastro, nunca do que a pessoa escreveu');
});

/* ------------------------------------------- o número que atende várias */

test('com duas empresas, a primeira pergunta é qual delas', async () => {
  /* Emitir no CNPJ errado é nota fiscal no cliente errado. No WhatsApp não há
     barra fixa mostrando onde a pessoa está, então a escolha vem antes de tudo
     e o CNPJ aparece escrito. */
  const m = comDuasEmpresas();
  const [r] = await dialogo(m, '5541999998888', ['oi']);
  assert.equal(r.estado, 'escolhendo_empresa');
  assert.match(r.resposta, /mais de uma empresa/);
  assert.match(r.resposta, /ALFA/);
  assert.match(r.resposta, /BETA/);
  assert.match(r.resposta, /11\.111\.111\/0001-91/, 'com o CNPJ à vista');
});

test('escolher pelo número da lista', async () => {
  const m = comDuasEmpresas();
  const saidas = await dialogo(m, '5541999998888', ['oi', '2', '1', '1', '1']);
  assert.match(saidas[1].resposta, /Nota por \*BETA\*/);
  assert.equal(saidas[4].pedido.cnpjEmpresa, '33333333000191');
  assert.equal(saidas[4].pedido.valores.valorServico, 800);
});

test('escolher digitando o CNPJ', async () => {
  const m = comDuasEmpresas();
  const saidas = await dialogo(m, '5541999998888', ['oi', '33.333.333/0001-91', '1', '1', '1']);
  assert.match(saidas[1].resposta, /BETA/);
  assert.equal(saidas[4].pedido.cnpjEmpresa, '33333333000191');
});

test('CNPJ de empresa que não é dele recebe a mesma recusa de um inventado', async () => {
  /* Distinguir transformaria a conversa num jeito de descobrir quais empresas o
     escritório atende. */
  const m = comDuasEmpresas();
  const real = await dialogo(m, '5541999998888', ['oi', '99.999.999/0001-91']);
  const inventado = await dialogo(m, '5541999998888', ['oi', '12.345.678/0001-99']);
  assert.match(real[1].resposta, /Não encontrei essa empresa entre as suas/);
  assert.equal(real[1].resposta, inventado[1].resposta,
    'as duas respostas precisam ser idênticas');
});

test('o CNPJ digitado não vira autorização sozinho', async () => {
  /* O texto vem do cliente; a autorização sai do cadastro. */
  const m = comDuasEmpresas();
  assert.ok(m.conferirEscolha('5541999998888', '33333333000191'));
  assert.equal(m.conferirEscolha('5541999998888', '99999999000191'), null);
  assert.equal(m.conferirEscolha('5511777776666', '11111111000191'), null,
    'outro número não alcança a empresa nem sabendo o CNPJ');
});

test('perder o vínculo no meio da conversa interrompe o pedido', async () => {
  /* O escritório tira o número da empresa enquanto a pessoa responde. A
     conversa guarda o CNPJ, mas reconfere a cada passo — senão ela seguiria
     valendo com uma autorização que já não existe. */
  const m = comDuasEmpresas();
  let estado = null;
  const passo = async texto => {
    const saida = await conversa.responder({
      texto, telefone: '5541999998888', vinculos: m.empresasDe('5541999998888'),
      conversa: estado, memoria: m, buscarCnpj: buscaFalsa()
    });
    estado = saida.estado ? { estado: saida.estado, dados: saida.dados, em: new Date().toISOString() } : null;
    return saida;
  };
  await passo('oi'); await passo('2'); await passo('1');

  m.dados.cadastro.whatsapp = m.dados.cadastro.whatsapp
    .filter(w => w.cnpj !== '33333333000191');

  const depois = await passo('1');
  assert.match(depois.resposta, /acesso a essa empresa mudou/);
  assert.ok(!depois.pedido, 'e nenhum pedido sai');
});

test('a empresa aparece escrita na conferência, com CNPJ', async () => {
  const m = comDuasEmpresas();
  // com duas empresas, o primeiro '1' escolhe a ALFA
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  assert.match(saidas[3].resposta, /\*Empresa:\* ALFA — 11\.111\.111\/0001-91/);
});

test('o nono dígito não separa a mesma pessoa', async () => {
  const m = memoriaFalsa();
  assert.equal(m.empresasDe('554199998888').length, 1, 'sem o nono dígito');
  assert.equal(m.empresasDe('5541999998888').length, 1, 'e com ele');
});

/* --------------------------------------------------------- empresa travada */

test('empresa bloqueada devolve o motivo, não um erro seco', async () => {
  const m = memoriaFalsa();
  m.dados.cadastro.empresas[0].liberado = false;
  m.dados.cadastro.empresas[0].motivoBloqueio = 'Falta conferir a lista de servicos.';
  const [r] = await dialogo(m, '5541999998888', ['oi']);
  assert.match(r.resposta, /pausada/);
  assert.match(r.resposta, /Falta conferir a lista de servicos/);
  assert.equal(r.estado, null, 'e a conversa não segue');
});

/* ------------------------------------------------------------ quem erra */

test('resposta sem sentido mostra as opções de novo', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', 'banana']);
  assert.match(saidas[1].resposta, /A nota de sempre/,
    'repete o menu em vez de repetir "não entendi"');
});

test('três erros seguidos oferecem saída', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', 'x', 'y', 'z']);
  assert.match(saidas[3].resposta, /cancelar/);
});

test('valor ilegível e valor zero têm respostas diferentes', async () => {
  const m = memoriaFalsa();
  const a = await dialogo(m, '5541999998888', ['oi', '1', '2', 'muito dinheiro']);
  assert.match(a[3].resposta, /Não entendi o valor/);

  const b = await dialogo(m, '5541999998888', ['oi', '1', '2', '0']);
  assert.match(b[3].resposta, /maior que zero/);
});

test('"cancelar" encerra em qualquer ponto', async () => {
  const m = memoriaFalsa();
  for (const ponto of [['oi', 'cancelar'], ['oi', '1', 'cancelar'], ['oi', '1', '1', 'cancelar']]) {
    const saidas = await dialogo(m, '5541999998888', ponto);
    const ultima = saidas[saidas.length - 1];
    assert.match(ultima.resposta, /Cancelado/);
    assert.equal(ultima.estado, null);
    assert.ok(!ultima.pedido, 'e nada é enviado');
  }
});

test('"voltar" leva ao começo sem emitir nada', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', 'voltar']);
  assert.match(saidas[3].resposta, /vamos do começo/);
  assert.ok(!saidas[3].pedido);
});

test('na conferência, "2" corrige o valor sem recomeçar tudo', async () => {
  /* Valor errado custava as quatro respostas de novo: só dava para cancelar e
     refazer. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', '2', '3.000,00', '1']);
  assert.match(saidas[3].resposta, /Qual o valor correto/);
  assert.match(saidas[4].resposta, /R\$ 3\.000,00/, 'volta para a conferência');
  assert.equal(saidas[5].pedido.valores.valorServico, 3000);
});

test('cancelar na conferência não manda nada', async () => {
  /* Era o "3"; virou "4" quando "Ajustar outra coisa" entrou entre corrigir o
     valor e cancelar. O número mudou, a garantia não: sair da conferência não
     pode enviar pedido nenhum.
     A palavra também cancela — e é por isso que a mudança de número é
     suportável: quem digitava "3" de cor erra uma vez, lê o menu que vem junto
     de toda resposta, e quem escreve "cancelar" nunca foi afetado. */
  const m = memoriaFalsa();
  const porNumero = await dialogo(m, '5541999998888', ['oi', '1', '1', '4']);
  assert.match(porNumero[3].resposta, /Cancelado, nada foi enviado/);
  assert.ok(!porNumero[3].pedido);

  const porPalavra = await dialogo(memoriaFalsa(), '5541999998888',
    ['oi', '1', '1', 'cancelar']);
  assert.ok(!porPalavra[3].pedido, 'a palavra cancela em qualquer numeração');
});

test('acima do teto avisa, mas deixa seguir', async () => {
  /* O teto não barra: garante que a nota passe por gente. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '2', '9.000,00']);
  assert.match(saidas[3].resposta, /Acima do combinado/);
  assert.match(saidas[3].resposta, /1 — Confirmar/);
});

/* ------------------------------------------------------------ o desfecho */

test('sem documentos, o aviso leva o link da consulta pública', async () => {
  /* É o mesmo endereço do QR Code impresso na nota — público por natureza. */
  const aviso = conversa.avisoDeDesfecho({
    situacao: 'emitida', chaveAcesso: '4106902...41', serie: '1', numero: '42'
  });
  assert.match(aviso, /autorizada/);
  assert.match(aviso, /série 1, número 42/);
  assert.match(aviso, /PDF e XML em:/);
  assert.match(aviso, /nfse\.gov\.br\/ConsultaPublica\/\?tpc=1&chave=/);
});

test('com documentos, o link vira segunda via', async () => {
  /* Os arquivos chegam em seguida; o link fica para o dia em que a pessoa
     apagar a conversa. */
  const aviso = conversa.avisoDeDesfecho({
    situacao: 'emitida', chaveAcesso: '4106902...41', serie: '1', numero: '42',
    documentos: { pdf: 'x', xml: 'y', nome: 'NFSe-1-42' }
  });
  assert.match(aviso, /Mando o PDF e o XML aqui em seguida/);
  assert.match(aviso, /Segunda via/);
});

test('recusa do contador chega com o motivo dele', async () => {
  const aviso = conversa.avisoDeDesfecho({
    situacao: 'recusada', motivo: 'Valor nao confere com o contrato.'
  });
  assert.match(aviso, /não aprovou/);
  assert.match(aviso, /Valor nao confere com o contrato/);
});

test('rejeição da prefeitura não culpa o cliente', async () => {
  const aviso = conversa.avisoDeDesfecho({ situacao: 'rejeitada', motivo: 'E1235' });
  assert.match(aviso, /prefeitura recusou/);
  assert.match(aviso, /contabilidade já foi avisada/);
});

/* --------------------------------------------------------------- dinheiro */

test('valor em português, nas duas formas', async () => {
  assert.equal(conversa.lerValor('1.500,00'), 1500);
  assert.equal(conversa.lerValor('1500'), 1500);
  assert.equal(conversa.lerValor('3.200,50'), 3200.5);
  assert.equal(conversa.lerValor('R$ 2.500,00'), 2500);
  assert.ok(Number.isNaN(conversa.lerValor('muito')));
  assert.equal(conversa.lerValor(''), undefined);
});

test('dinheiro escrito como se lê', async () => {
  assert.equal(conversa.dinheiro(2500), 'R$ 2.500,00');
  assert.equal(conversa.dinheiro(1234567.89), 'R$ 1.234.567,89');
  assert.equal(conversa.dinheiro(7), 'R$ 7,00');
});

/* ------------------------------------ apresentação, cliente novo, e o fim */

function comEscritorio() {
  const m = memoriaFalsa();
  m.dados.cadastro.escritorio = { nome: 'Contabilidade Silva', telefone: '4130000000' };
  return m;
}

test('a primeira mensagem diz quem está falando', async () => {
  /* Do outro lado é um número desconhecido numa janela de WhatsApp. Sem o nome
     do escritório, a mensagem parece golpe — e quem acha que é golpe não emite
     nota fiscal. */
  const m = comEscritorio();
  const [r] = await dialogo(m, '5541999998888', ['oi']);
  assert.match(r.resposta, /\*Contabilidade Silva\*/);
  /* Dizer que é automático é a primeira regra de conversa por robô: a pessoa
     calibra o que pedir, e não fica esperando alguém do outro lado. */
  assert.match(r.resposta, /Atendimento automático/);
  assert.match(r.resposta, /"atendente" chama uma pessoa/,
    'e a saída para gente aparece já na abertura');
  const casa = r.resposta.indexOf('Contabilidade Silva');
  const cliente = r.resposta.indexOf('ALFA');
  assert.ok(casa < cliente, 'o escritório vem antes da empresa do cliente');
});

test('sem identidade cadastrada, a conversa não quebra', async () => {
  const m = memoriaFalsa();
  const [r] = await dialogo(m, '5541999998888', ['oi']);
  assert.match(r.resposta, /ALFA/);
  assert.ok(!/undefined|null/.test(r.resposta));
});

test('"oi" no meio da conversa recomeça, e avisa', async () => {
  /* Antes caía no passo atual e recebia "não entendi", que é a pior resposta
     possível para quem só quis cumprimentar. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', 'oi']);
  assert.match(saidas[3].resposta, /Recomeçando/);
  assert.match(saidas[3].resposta, /não foi enviado/,
    'e deixa claro que nada saiu');
  assert.ok(!saidas[3].pedido);
});

test('o fim da conversa é dito, com o convite para a próxima', async () => {
  /* Sem isso a pessoa fica olhando a tela sem saber se acabou, se pode mandar
     outro, ou se está esperando alguma coisa. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  const fim = saidas[3];
  assert.match(fim.resposta, /Pedido enviado/);
  assert.match(fim.resposta, /escrever "oi"/, 'e diz como pedir a próxima');
  assert.equal(fim.estado, null, 'a conversa fecha de verdade');
});

test('cliente novo: os dados aparecem e podem ser conferidos', async () => {
  /* A consulta acontecia depois da conversa, do outro lado, e a pessoa nunca
     via o resultado — se a base estivesse desatualizada, ninguém percebia até a
     nota sair com o nome errado. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888',
    ['oi', '3', '11.222.333/0001-81', '1', '1', '1.500,00', '1']);

  assert.match(saidas[1].resposta, /Qual o CNPJ do cliente/);
  assert.match(saidas[2].resposta, /CLIENTE DA RECEITA LTDA/, 'mostra o que achou');
  assert.match(saidas[2].resposta, /RUA TESTE, 100/, 'com o endereço');
  assert.match(saidas[2].resposta, /Está certo/, 'e pergunta se confere');

  const p = saidas[6].pedido;
  assert.ok(p, 'o pedido sai');
  assert.equal(p.tomador.cnpj, '11222333000181');
  assert.equal(p.tomador.razaoSocial, 'CLIENTE DA RECEITA LTDA');
  assert.equal(p.tomador.endereco.codigoMunicipio, '4106902',
    'e o endereço vai junto, já resolvido');
});

test('a pessoa corrige o nome quando a base está atrasada', async () => {
  /* A Receita atrasa: empresa que mudou de nome há dois meses ainda aparece com
     o antigo. Quem pede a nota conhece o cliente melhor que a base. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888',
    ['oi', '3', '11.222.333/0001-81', 'NOVA RAZAO SOCIAL LTDA', '1', '1.500,00', '1']);
  assert.equal(saidas[6].pedido.tomador.razaoSocial, 'NOVA RAZAO SOCIAL LTDA');
  assert.equal(saidas[6].pedido.tomador.cnpj, '11222333000181',
    'o documento continua sendo o digitado');
});

test('base fora do ar não trava a conversa', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888',
    ['oi', '3', '11.222.333/0001-81', 'CLIENTE DIGITADO LTDA', '1', '900,00', '1'],
    async () => null);
  assert.match(saidas[2].resposta, /Não consegui os dados/);
  assert.match(saidas[2].resposta, /Qual a razão social/);
  assert.equal(saidas[6].pedido.tomador.razaoSocial, 'CLIENTE DIGITADO LTDA');
});

test('CPF é perguntado passo a passo', async () => {
  /* Pessoa física não tem consulta pública aberta — e não deveria ter. O nome é
     o único campo que a DPS exige além do documento. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888',
    ['oi', '3', '111.444.777-35', 'Joao da Silva', '1', '450,00', '1']);
  assert.match(saidas[2].resposta, /111\.444\.777-35/, 'confirma o CPF formatado');
  assert.match(saidas[2].resposta, /nome completo/);
  assert.match(saidas[2].resposta, /não tem consulta pública/, 'e explica por quê');

  const p = saidas[6].pedido;
  assert.equal(p.tomador.cpf, '11144477735', 'vai como CPF, não como CNPJ');
  assert.equal(p.tomador.cnpj, undefined);
  assert.equal(p.tomador.razaoSocial, 'Joao da Silva');
});

test('situação irregular na Receita é mostrada', async () => {
  /* Emitir para empresa baixada é problema que aparece depois. */
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '3', '11.222.333/0001-81'],
    async doc => ({ documento: doc, nome: 'EMPRESA BAIXADA LTDA', situacao: 'BAIXADA' }));
  assert.match(saidas[2].resposta, /Situação na Receita: \*BAIXADA\*/);
});

test('"atendente" leva ao escritório, não a um beco', async () => {
  /* O cliente perdoa o robô não saber; não perdoa ficar preso nele. */
  const m = comEscritorio();
  m.dados.cadastro.escritorio.telefone = '554130000000';
  m.dados.cadastro.escritorio.email = 'contato@exemplo.com.br';
  const saidas = await dialogo(m, '5541999998888', ['oi', 'atendente']);
  assert.match(saidas[1].resposta, /sou automático/);
  assert.match(saidas[1].resposta, /\(41\) 3000-0000/);
  assert.match(saidas[1].resposta, /contato@exemplo\.com\.br/);
  assert.equal(saidas[1].estado, null);
});

test('documento com tamanho errado é recusado antes de sair', async () => {
  const m = memoriaFalsa();
  const saidas = await dialogo(m, '5541999998888', ['oi', '3', '123']);
  assert.match(saidas[2].resposta, /não parece certo/);
  assert.match(saidas[2].resposta, /você mandou 3/);
});

test('o dígito verificador NÃO é conferido aqui', async () => {
  /* A regra mudou em julho/2026 (CNPJ alfanumérico). Duas cópias dela seriam
     uma divergindo da outra — o gateway é quem confere, e a recusa volta com o
     motivo até esta conversa. */
  const fonte = require('fs').readFileSync(require.resolve('../conversa.js'), 'utf8');
  assert.ok(!/digitoModulo11|validarCnpj|PESOS_CNPJ/.test(fonte),
    'o cálculo do DV não pode ser duplicado no relay');
  assert.match(fonte, /dígito verificador fica com/i);
});
