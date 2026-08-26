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

function quemDe(memoria, tel) { return memoria.quemE(tel); }

function dialogo(memoria, tel, mensagens) {
  let estado = null;
  const saidas = [];
  for (const texto of mensagens) {
    const saida = conversa.responder({
      texto, quem: quemDe(memoria, tel), conversa: estado, memoria
    });
    saidas.push(saida);
    estado = saida.estado ? { estado: saida.estado, dados: saida.dados, em: new Date().toISOString() } : null;
  }
  return saidas;
}

/* --------------------------------------------------------- o caminho curto */

test('a nota de sempre sai em três respostas', () => {
  /* É o caso dominante no escritório: mesmo cliente, mesmo serviço, mesmo
     valor, todo mês. Se isso custar seis perguntas, o WhatsApp não vale a pena. */
  const m = memoriaFalsa();
  const [oi, sempre, valor, confirma] = dialogo(m, '5541999998888', ['oi', '1', '1', '1']);

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

test('o pedido leva o serviço e o tomador da nota anterior', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  const p = saidas[3].pedido;
  assert.equal(p.tomador.cnpj, '22222222000191');
  assert.equal(p.servico.codigoTributacaoNacional, '010101');
  assert.equal(p.servico.descricao, 'Manutencao mensal');
});

test('valor diferente do de sempre', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '2', '3.200,50', '1']);
  assert.match(saidas[2].resposta, /Qual o valor/);
  assert.match(saidas[3].resposta, /R\$ 3\.200,50/);
  assert.equal(saidas[4].pedido.valores.valorServico, 3200.5);
});

/* -------------------------------------------------------- quem não é ninguém */

test('número desconhecido não descobre nada do escritório', () => {
  /* Nem que empresas existem, nem que o serviço existe. */
  const m = memoriaFalsa();
  assert.equal(m.quemE('5511888887777'), null);
});

test('o número só fala pela empresa dele', () => {
  const m = memoriaFalsa();
  const quem = m.quemE('5541999998888');
  assert.equal(quem.empresa.cnpj, '11111111000191');
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '1', '1']);
  assert.equal(saidas[3].pedido.cnpjEmpresa, '11111111000191',
    'o CNPJ sai do cadastro, nunca do que a pessoa escreveu');
});

test('o nono dígito não separa a mesma pessoa', () => {
  const m = memoriaFalsa();
  assert.ok(m.quemE('554199998888'), 'sem o nono dígito, é a mesma Maria');
  assert.ok(m.quemE('5541999998888'), 'e com ele também');
});

/* --------------------------------------------------------- empresa travada */

test('empresa bloqueada devolve o motivo, não um erro seco', () => {
  const m = memoriaFalsa();
  m.dados.cadastro.empresas[0].liberado = false;
  m.dados.cadastro.empresas[0].motivoBloqueio = 'Falta conferir a lista de servicos.';
  const [r] = dialogo(m, '5541999998888', ['oi']);
  assert.match(r.resposta, /pausada/);
  assert.match(r.resposta, /Falta conferir a lista de servicos/);
  assert.equal(r.estado, null, 'e a conversa não segue');
});

/* ------------------------------------------------------------ quem erra */

test('resposta sem sentido mostra as opções de novo', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', 'banana']);
  assert.match(saidas[1].resposta, /A nota de sempre/,
    'repete o menu em vez de repetir "não entendi"');
});

test('três erros seguidos oferecem saída', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', 'x', 'y', 'z']);
  assert.match(saidas[3].resposta, /cancelar/);
});

test('valor ilegível e valor zero têm respostas diferentes', () => {
  const m = memoriaFalsa();
  const a = dialogo(m, '5541999998888', ['oi', '1', '2', 'muito dinheiro']);
  assert.match(a[3].resposta, /Não entendi o valor/);

  const b = dialogo(m, '5541999998888', ['oi', '1', '2', '0']);
  assert.match(b[3].resposta, /maior que zero/);
});

test('"cancelar" encerra em qualquer ponto', () => {
  const m = memoriaFalsa();
  for (const ponto of [['oi', 'cancelar'], ['oi', '1', 'cancelar'], ['oi', '1', '1', 'cancelar']]) {
    const saidas = dialogo(m, '5541999998888', ponto);
    const ultima = saidas[saidas.length - 1];
    assert.match(ultima.resposta, /Cancelado/);
    assert.equal(ultima.estado, null);
    assert.ok(!ultima.pedido, 'e nada é enviado');
  }
});

test('"voltar" leva ao começo sem emitir nada', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '1', 'voltar']);
  assert.match(saidas[3].resposta, /vamos do começo/);
  assert.ok(!saidas[3].pedido);
});

test('confirmar com "2" cancela e não manda pedido', () => {
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '1', '2']);
  assert.match(saidas[3].resposta, /Cancelado, nada foi enviado/);
  assert.ok(!saidas[3].pedido);
});

test('acima do teto avisa, mas deixa seguir', () => {
  /* O teto não barra: garante que a nota passe por gente. */
  const m = memoriaFalsa();
  const saidas = dialogo(m, '5541999998888', ['oi', '1', '2', '9.000,00']);
  assert.match(saidas[3].resposta, /Acima do combinado/);
  assert.match(saidas[3].resposta, /1 — Confirmar/);
});

/* ------------------------------------------------------------ o desfecho */

test('o aviso de nota autorizada leva o link da consulta pública', () => {
  /* É o mesmo endereço do QR Code impresso na nota — público por natureza. Por
     isso nenhum PDF precisa passar pelo relay. */
  const aviso = conversa.avisoDeDesfecho({
    situacao: 'emitida', chaveAcesso: '4106902...41', serie: '1', numero: '42'
  });
  assert.match(aviso, /autorizada/);
  assert.match(aviso, /Série 1, número 42/);
  assert.match(aviso, /nfse\.gov\.br\/ConsultaPublica\/\?tpc=1&chave=/);
});

test('recusa do contador chega com o motivo dele', () => {
  const aviso = conversa.avisoDeDesfecho({
    situacao: 'recusada', motivo: 'Valor nao confere com o contrato.'
  });
  assert.match(aviso, /não aprovou/);
  assert.match(aviso, /Valor nao confere com o contrato/);
});

test('rejeição da prefeitura não culpa o cliente', () => {
  const aviso = conversa.avisoDeDesfecho({ situacao: 'rejeitada', motivo: 'E1235' });
  assert.match(aviso, /prefeitura recusou/);
  assert.match(aviso, /contabilidade já foi avisada/);
});

/* --------------------------------------------------------------- dinheiro */

test('valor em português, nas duas formas', () => {
  assert.equal(conversa.lerValor('1.500,00'), 1500);
  assert.equal(conversa.lerValor('1500'), 1500);
  assert.equal(conversa.lerValor('3.200,50'), 3200.5);
  assert.equal(conversa.lerValor('R$ 2.500,00'), 2500);
  assert.ok(Number.isNaN(conversa.lerValor('muito')));
  assert.equal(conversa.lerValor(''), undefined);
});

test('dinheiro escrito como se lê', () => {
  assert.equal(conversa.dinheiro(2500), 'R$ 2.500,00');
  assert.equal(conversa.dinheiro(1234567.89), 'R$ 1.234.567,89');
  assert.equal(conversa.dinheiro(7), 'R$ 7,00');
});
