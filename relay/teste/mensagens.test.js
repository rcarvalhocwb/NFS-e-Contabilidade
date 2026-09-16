const test = require('node:test');
const assert = require('node:assert');

const conversa = require('../conversa');
const { Memoria } = require('../memoria');

/* As palavras do escritório, na boca do robô.
 *
 * O defeito que fez isto existir era silencioso: `identidade.telefone` e
 * `identidade.email` nasciam nulos porque o instalador só gravava o nome, e a
 * resposta de "quero falar com alguém" saía dizendo o nome da contabilidade e
 * mandando a pessoa "procurar pelos canais de sempre" — que é exatamente o que
 * ela estava tentando fazer ao escrever "atendente".
 *
 * Nada disso aparece em log nenhum. Só aparece na reclamação de um cliente,
 * meses depois, sem ligação com nada. Por isso está testado dos dois lados: com
 * os dados preenchidos e sem eles.
 */

function memoriaCom(escritorio, chatbot) {
  const m = new Memoria(require('path').join(
    require('os').tmpdir(), 'relay-msg-' + Math.random().toString(36).slice(2) + '.json'));
  m.dados.cadastro = {
    versao: 'v1',
    escritorio: escritorio || null,
    chatbot: chatbot || {},
    whatsapp: [{ telefone: '5541999998888', cnpj: '11111111000191',
                 nome: 'Maria Financeiro', limiteValor: 5000 }],
    empresas: [{ cnpj: '11111111000191', razaoSocial: 'ALFA COMERCIO LTDA',
                 nomeFantasia: 'ALFA', ativo: true, liberado: true }],
    servicos: [{ id: 1, cnpj: '11111111000191', apelido: 'Consultoria',
                 descricao: 'Consultoria tecnica', codigoTributacao: '010201' }],
    acessos: []
  };
  m.salvar = () => {};
  return m;
}

function responder(memoria, texto) {
  return conversa.responder({
    texto, telefone: '5541999998888',
    vinculos: memoria.empresasDe('5541999998888'),
    conversa: null, memoria, buscarCnpj: async () => null
  });
}

/* ------------------------------------------------- a saída para gente */

test('com telefone e e-mail cadastrados, o cliente recebe como falar', async () => {
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti',
                         telefone: '4133334444', email: 'contato@recalcatti.com.br' });
  const s = await responder(m, 'atendente');

  assert.match(s.resposta, /Contabilidade Recalcatti/);
  assert.match(s.resposta, /contato@recalcatti\.com\.br/);
  assert.match(s.resposta, /3333/, 'o telefone precisa aparecer');
  assert.ok(!/canais de sempre/.test(s.resposta),
    'com contato cadastrado, não se manda ninguém procurar por conta própria');
});

test('sem contato cadastrado, a resposta não inventa um', async () => {
  /* O estado em que o sistema ficava. Continua aceitável — o que não pode é
     fingir que há um telefone. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti', telefone: null, email: null });
  const s = await responder(m, 'atendente');
  assert.match(s.resposta, /canais de sempre/);
  assert.ok(!/📞/.test(s.resposta), 'nada de telefone vazio na tela');
});

test('o nome do atendente entra na frase, quando há um', async () => {
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti', telefone: '4133334444' },
                       { atendente: 'Juliana' });
  const s = await responder(m, 'atendente');
  assert.match(s.resposta, /Juliana/,
    'quem pede atendente precisa sair com um nome para pedir no telefone');
  assert.match(s.resposta, /Contabilidade Recalcatti/);
});

test('o horário é informativo e não desliga o robô', async () => {
  /* Recusar de madrugada para "parecer humano" seria piorar o serviço de
     propósito: emitir nota às duas da manhã é exatamente o que um robô faz
     melhor que gente. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti', telefone: '4133334444' },
                       { horario: 'seg a sex, 8h às 18h' });
  const s = await responder(m, 'atendente');
  assert.match(s.resposta, /seg a sex/);

  const oi = await responder(m, 'oi');
  assert.match(oi.resposta, /Consultoria|serviço|Nota/i,
    'fora do horário, o atendimento automático continua');
});

/* ------------------------------------------------------ a apresentação */

test('a saudação escolhida substitui a padrão', async () => {
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' },
                       { saudacao: 'Emita sua nota por aqui, 24 horas.' });
  const s = await responder(m, 'oi');
  assert.match(s.resposta, /Emita sua nota por aqui, 24 horas\./);
  assert.ok(!/Atendimento automático para emissão de notas/.test(s.resposta),
    'a padrão não pode sobrar junto da escolhida');
});

test('sem saudação escolhida, a padrão continua valendo', async () => {
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' }, {});
  const s = await responder(m, 'oi');
  assert.match(s.resposta, /Contabilidade Recalcatti/);
  assert.match(s.resposta, /Atendimento automático/);
});

test('sem escritório cadastrado, a conversa não quebra', async () => {
  /* Cadastro ainda não replicado, ou instalação que pulou o comissionamento. */
  const m = memoriaCom(null, null);
  const s = await responder(m, 'oi');
  assert.ok(s.resposta.length > 0);
  const h = await responder(m, 'atendente');
  assert.match(h.resposta, /contabilidade/i);
});

/* -------------------------------------------- o limite da personalização */

test('o texto configurável não decide nada da conversa', async () => {
  /* A separação que impede o campo de texto de virar programação por acidente:
     mensagens.js recebe o retrato e devolve string. Se um dia ele passar a
     mexer em estado, pedido ou valor, deixou de ser texto e virou regra —
     escrita por quem não sabe que está programando. */
  const fonte = require('fs').readFileSync(require.resolve('../mensagens.js'), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  /* A primeira versão deste teste procurava as palavras "emitir", "valor" e
     "pedido" no arquivo — e falhou, porque elas estão no texto que o robô FALA
     ("só sei emitir nota"). Procurar palavras num arquivo cheio de frases
     acusa a frase, não o comportamento.

     O que separa formatação de regra não é vocabulário: é não ter como
     alcançar nada. Um módulo que não importa ninguém e não espera nada não
     consulta banco, não chama rede e não avança conversa — não por disciplina,
     por falta de meio. */
  assert.ok(!/\brequire\s*\(/.test(codigo),
    'mensagens.js não importa nada: sem importação não há banco, rede nem fila a alcançar');
  assert.ok(!/\b(async|await)\b/.test(codigo),
    'formatar texto é síncrono; um await aqui significa que algo foi buscado');

  /* E o retorno é string, não decisão. */
  const mensagens = require('../mensagens');
  const memoriaVazia = { escritorio: () => null, chatbot: () => ({}) };
  assert.equal(typeof mensagens.apresentacao(memoriaVazia), 'string');
  assert.equal(typeof mensagens.falarComGente(memoriaVazia, t => t), 'string');
});

/* ------------------------------------------- a primeira mensagem qualquer */

test('primeira mensagem que não é saudação não quebra a conversa', async () => {
  /* `inicio` é o estado padrão de quem não tem conversa aberta, e aí nenhuma
     empresa foi escolhida ainda. Quem escrevia "1", "quero uma nota" ou "bom
     dia pessoal" como PRIMEIRA mensagem caía em `empresa.ultimoPedido` com
     empresa nula. O repassador engolia a exceção e o cliente não recebia
     resposta nenhuma — sem erro para ele, sem pista para quem investigasse.
     Encontrado com um número real conectado, não em teste. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti', telefone: '4133334444' },
                       { atendente: 'Juliana' });

  for (const primeira of ['1', 'quero uma nota', 'bom dia pessoal', '...', '2']) {
    const s = await responder(m, primeira);
    assert.ok(s && typeof s.resposta === 'string' && s.resposta.length > 0,
      '"' + primeira + '" como primeira mensagem precisa ter resposta');
    assert.match(s.resposta, /Contabilidade Recalcatti/,
      '"' + primeira + '" deveria começar a conversa, não morrer');
  }
});

test('sem pedido anterior, o menu não oferece o que não dá para fazer', async () => {
  /* "Outra nota" significa MESMO cliente de sempre, serviço ou valor
     diferentes — e herda o cliente do último pedido. Sem pedido anterior não há
     de onde herdar: a conversa escolhia serviço, perguntava o valor e só então
     desistia com "faltam dados", depois de gastar três mensagens da pessoa.

     E era o caminho garantido de TODA instalação nova: na primeira nota que um
     cliente pede, nunca existe pedido anterior. Encontrado com um número real
     conectado, seguindo o menu como um cliente seguiria. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' });
  const s = await responder(m, 'oi');

  assert.ok(!/Outra nota/.test(s.resposta),
    'sem pedido anterior, "Outra nota" não pode ser oferecida');
  assert.match(s.resposta, /Emitir uma nota/,
    'e o caminho que funciona precisa estar na lista');

  /* E seguir por ele chega ao documento do cliente, que é onde a nota começa
     de verdade. */
  const seguir = { estado: s.estado, dados: s.dados, em: new Date().toISOString() };
  const proximo = await conversa.responder({
    texto: '1', telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: seguir, memoria: m, buscarCnpj: async () => null
  });
  assert.match(proximo.resposta, /CNPJ|CPF|documento/i,
    'o caminho ofertado precisa levar a algum lugar');
});

/* ------------------------------- as notas do próprio cliente */

test('o cliente consulta as notas dele e pede a segunda via', async () => {
  /* "Me manda de novo aquela nota" era a ligação mais comum ao escritório, e
     não havia caminho para ela na conversa — virava trabalho de gente para
     reenviar um PDF que o sistema tinha à mão. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' });
  const notas = [
    { chave_acesso: 'CHAVE-1', criado_em: '2026-09-01T12:00:00Z',
      valor: '1500', tomador: 'CLIENTE UM LTDA', servico: 'Consultoria' },
    { chave_acesso: 'CHAVE-2', criado_em: '2026-08-01T12:00:00Z',
      valor: '900', tomador: 'CLIENTE DOIS ME', servico: 'Manutencao' }
  ];

  const dizer = (texto, anterior, extra) => conversa.responder(Object.assign({
    texto, telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: anterior, memoria: m, buscarCnpj: async () => null,
    notasDoCliente: async () => notas,
    documentoDoCliente: async (tel, chave) => ({
      chave, nome: 'NFSe-1-7', pdf: 'JVBERi0x', xml: 'PHhtbD4='
    })
  }, extra || {}));

  const seguir = s => (s.estado ? { estado: s.estado, dados: s.dados } : null);

  const oi = await dizer('oi', null);
  assert.match(oi.resposta, /Minhas notas/, 'o caminho precisa estar no menu');

  /* A opção é a última da lista; responde-se pelo número. */
  const qual = oi.dados.opcoes.indexOf('notas') + 1;
  const lista = await dizer(String(qual), seguir(oi));
  assert.match(lista.resposta, /CLIENTE UM LTDA/);
  assert.match(lista.resposta, /1\.500,00/, 'o valor sai formatado');
  assert.equal(lista.estado, 'escolhendo_nota');

  const doc = await dizer('1', seguir(lista));
  assert.ok(doc.documento, 'a conversa devolve o documento para o transporte enviar');
  assert.equal(doc.documento.tipo, 'application/pdf');
  assert.match(doc.documento.nome, /\.pdf$/);
});

test('sem gateway alcançável, a conversa não promete o que não cumpre', async () => {
  /* Repassador na nuvem, ou gateway fora do ar. Dizer "já te mando" faria a
     pessoa esperar por algo que não vem — pior que dizer a verdade. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' });
  const dizer = (texto, anterior) => conversa.responder({
    texto, telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: anterior, memoria: m, buscarCnpj: async () => null,
    notasDoCliente: async () => null        // é o que gateway.js devolve sem URL
  });

  const oi = await dizer('oi', null);
  const qual = oi.dados.opcoes.indexOf('notas') + 1;
  const r = await dizer(String(qual), { estado: oi.estado, dados: oi.dados });
  assert.match(r.resposta, /Peça ao escritório|Não consigo consultar/);
  assert.equal(r.estado, null, 'e não deixa a pessoa esperando num estado morto');
});

test('a chave de outra pessoa não vira documento', async () => {
  /* O gateway confere que a chave pertence a um pedido DAQUELE telefone e
     responde 404. A conversa precisa transformar isso em frase, e na MESMA
     frase de "não existe" — distinguir as duas diria a quem tentasse que
     aquela chave existe em algum lugar. */
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' });
  const negado = Object.assign(new Error('Não encontrei essa nota entre as suas.'),
    { status: 404 });

  const r = await conversa.responder({
    texto: '1', telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: { estado: 'escolhendo_nota',
                dados: { cnpj: '11111111000191', notas: [{ chave: 'DE-OUTRO' }] } },
    memoria: m, buscarCnpj: async () => null,
    documentoDoCliente: async () => { throw negado; }
  });
  assert.match(r.resposta, /Não encontrei essa nota entre as suas/);
  assert.ok(!r.documento, 'e nada de documento junto');
});

/* --------------------------------- ajustar o pedido antes de confirmar */

function memoriaComLocal() {
  const m = memoriaCom({ nome: 'Contabilidade Recalcatti' });
  m.dados.cadastro.empresas[0].codigoMunicipio = '4106902';
  m.dados.cadastro.empresas[0].municipio = 'Curitiba';
  m.dados.cadastro.empresas[0].uf = 'PR';
  return m;
}

const buscaComEndereco = async doc => ({
  documento: doc, nome: 'CLIENTE DA BASE LTDA', situacao: 'ATIVA',
  logradouro: 'RUA TESTE', numero: '100', bairro: 'CENTRO',
  cep: '01310100', uf: 'SP', municipio: 'SAO PAULO', codigoMunicipio: '3550308'
});

async function ateAConfirmacao(m) {
  const seguir = s => (s.estado ? { estado: s.estado, dados: s.dados } : null);
  const diga = (texto, ant) => conversa.responder({
    texto, telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: ant, memoria: m, buscarCnpj: buscaComEndereco
  });
  let s = await diga('oi', null);
  s = await diga('1', seguir(s));                    // emitir uma nota
  s = await diga('11444777000161', seguir(s));       // documento
  if (/Responda \*1\*|est(a|á) certo/i.test(s.resposta)) s = await diga('1', seguir(s));
  if (/servi(c|ç)o/i.test(s.resposta)) s = await diga('1', seguir(s));
  if (/valor/i.test(s.resposta)) s = await diga('1500,00', seguir(s));
  return { s, diga, seguir };
}

test('a conferência mostra onde o serviço foi prestado', async () => {
  /* O local da prestação decide para qual prefeitura o ISS vai. O padrão
     (município da empresa) sempre esteve certo — mas ficava invisível, e o que
     não aparece na conferência não é conferido. */
  const { s } = await ateAConfirmacao(memoriaComLocal());
  assert.equal(s.estado, 'confirmando');
  assert.match(s.resposta, /Onde foi prestado/);
  assert.match(s.resposta, /Curitiba/, 'com o nome da cidade, não o código');
  assert.match(s.resposta, /Ajustar outra coisa/);
  assert.match(s.resposta, /2 — Corrigir o valor/,
    'corrigir o valor continua a UM toque: e de longe o erro mais comum');
});

test('o cliente troca o local da prestação, e isso chega no pedido', async () => {
  const m = memoriaComLocal();
  const { s, diga, seguir } = await ateAConfirmacao(m);

  const ajuste = await diga('3', seguir(s));               // ajustar outra coisa
  assert.equal(ajuste.estado, 'ajustando');
  assert.match(ajuste.resposta, /Onde o serviço foi prestado/);

  const locais = await diga('2', seguir(ajuste));          // o local
  assert.equal(locais.estado, 'escolhendo_local');
  assert.match(locais.resposta, /Curitiba/);
  assert.match(locais.resposta, /SAO PAULO/, 'a cidade do cliente também é opção');

  const volta = await diga('2', seguir(locais));           // onde o cliente fica
  assert.equal(volta.estado, 'confirmando', 'volta para a conferência');
  assert.match(volta.resposta, /SAO PAULO/, 'e mostra o local novo');
  assert.match(volta.resposta, /1\.500,00/, 'sem pedir o valor de novo');

  const fim = await diga('1', seguir(volta));              // confirmar
  assert.ok(fim.pedido, 'o pedido foi montado');
  assert.equal(fim.pedido.servico.codigoMunicipioPrestacao, '3550308',
    'o local escolhido precisa CHEGAR no pedido — senão o ajuste não muda nada');
});

test('sem trocar o local, o campo não viaja', async () => {
  /* O gateway aplica o padrão dele (município da empresa) quando o campo não
     vem. Mandar o padrão daqui seria manter a mesma regra em dois lugares, e
     dois lugares divergem. */
  const m = memoriaComLocal();
  const { s, diga, seguir } = await ateAConfirmacao(m);
  const fim = await diga('1', seguir(s));
  assert.ok(fim.pedido);
  assert.equal(fim.pedido.servico.codigoMunicipioPrestacao, undefined,
    'sem escolha explícita, o campo não pode ir');
});

test('cliente na mesma cidade da empresa não recebe escolha falsa', async () => {
  /* Oferecer duas opções que levam ao mesmo lugar é fazer a pessoa escolher
     entre iguais. */
  const m = memoriaComLocal();
  const mesmaCidade = async doc => Object.assign(await buscaComEndereco(doc),
    { municipio: 'CURITIBA', uf: 'PR', codigoMunicipio: '4106902' });

  const seguir = x => (x.estado ? { estado: x.estado, dados: x.dados } : null);
  const diga = (texto, ant) => conversa.responder({
    texto, telefone: '5541999998888',
    vinculos: m.empresasDe('5541999998888'),
    conversa: ant, memoria: m, buscarCnpj: mesmaCidade
  });
  let s = await diga('oi', null);
  s = await diga('1', seguir(s));
  s = await diga('11444777000161', seguir(s));
  if (/Responda \*1\*|est(a|á) certo/i.test(s.resposta)) s = await diga('1', seguir(s));
  if (/servi(c|ç)o/i.test(s.resposta)) s = await diga('1', seguir(s));
  if (/valor/i.test(s.resposta)) s = await diga('1500,00', seguir(s));

  const ajuste = await diga('3', seguir(s));
  const local = await diga('2', seguir(ajuste));
  assert.match(local.resposta, /Só conheço um lugar/);
  assert.match(local.resposta, /atendente/,
    'e precisa dizer o que fazer quando foi em outra cidade');
  assert.equal(local.estado, 'confirmando');
});
