const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { herdarDaOriginal } = require('../src/nfse/heranca');
const { lerDps } = require('../src/nfse/lerDps');

/* A nota substituta herda da nota original.
 *
 * "Corrigir" uma NFS-e é emitir outra em substituição — não existe alterar. O
 * comum é mudar um campo e manter o resto, e era o "resto" que se perdia: a
 * tela relia a DPS original no NAVEGADOR, mas só seis campos.
 *
 * Achado com knip, que apontou src/nfse/lerDps.js como arquivo nunca
 * importado. Ele não estava morto — estava desligado: foi escrito exatamente
 * para isto e a tela acabou com uma segunda leitura, mais pobre, dentro de si.
 *
 * (Das duas dezenas de "exports não usados" que a mesma ferramenta apontou,
 *  quase todas eram ruído de CommonJS. Este era o sinal.)
 */

/* Uma DPS como o gateway monta, com tomador completo e ISS retido pelo
   tomador — que é o campo cuja perda tem consequência de imposto. */
const DPS_ORIGINAL = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infDPS Id="DPS4106902112223330001810000010000000000001">
<tpAmb>1</tpAmb><dhEmi>2026-08-14T10:00:00-03:00</dhEmi><verAplic>nfse-gateway/1.7.0</verAplic>
<serie>1</serie><nDPS>7</nDPS><dCompet>2026-08-01</dCompet><tpEmit>1</tpEmit><cLocEmi>4106902</cLocEmi>
<prest><CNPJ>11222333000181</CNPJ></prest>
<toma><CNPJ>44555666000199</CNPJ><xNome>Cliente Exemplo Ltda</xNome>
  <end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac>
    <xLgr>Rua das Flores</xLgr><nro>123</nro><xCpl>Sala 4</xCpl><xBairro>Centro</xBairro></end>
  <fone>4133334444</fone><email>fiscal@cliente.com.br</email></toma>
<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest>
  <cServ><cTribNac>010101</cTribNac><cTribMun>101</cTribMun><xDescServ>Consultoria contabil mensal</xDescServ></cServ></serv>
<valores><vServPrest><vServ>2500.00</vServ></vServPrest>
  <trib><tribMun><tribISSQN>1</tribISSQN><pAliq>3.00</pAliq><tpRetISSQN>2</tpRetISSQN></tribMun>
    <totTrib><pTotTribSN>6.00</pTotTribSN></totTrib></trib></valores>
</infDPS></DPS>`;

/* O que a tela manda hoje ao substituir: seis campos e o motivo. */
function pedidoDaTela(mudanca = {}) {
  return Object.assign({
    cnpjEmpresa: '11222333000181',
    referencia: 'SUBST-1-123456',
    substituicao: { chaveSubstituida: '41260811222333000181...', codigoMotivo: 99, motivo: 'valor errado' },
    tomador: { cnpj: '44555666000199', razaoSocial: 'Cliente Exemplo Ltda' },
    servico: { codigoTributacaoNacional: '010101', descricao: 'Consultoria contabil mensal' },
    valores: { valorServico: 2800, aliquotaIss: 3 }
  }, mudanca);
}

test('o ISS retido não vira "não retido" em silêncio', () => {
  /* O pior dos sete campos perdidos. Sem herança, `issRetido` chegava vazio ao
     serviço e era preenchido pelo padrão da EMPRESA — que não é o da nota. Se
     aquele tomador retinha e a empresa não retém por padrão, a substituta saía
     sem retenção: muda quem recolhe o imposto, e nada na tela avisa. */
  const semHeranca = pedidoDaTela();
  assert.equal(semHeranca.valores.issRetido, undefined, 'a tela realmente não manda');

  const com = herdarDaOriginal(pedidoDaTela(), DPS_ORIGINAL);
  assert.equal(com.valores.issRetido, true, 'a retenção da nota original precisa sobreviver');
});

test('a competência não pula para o mês corrente', () => {
  /* Substituir em setembro uma nota de agosto jogava a receita para setembro,
     porque o construtor da DPS usa a data de hoje quando ninguém informa. */
  const com = herdarDaOriginal(pedidoDaTela(), DPS_ORIGINAL);
  assert.equal(com.dataCompetencia, '2026-08-01');
});

test('o tomador chega inteiro, não só CNPJ e nome', () => {
  const com = herdarDaOriginal(pedidoDaTela(), DPS_ORIGINAL);
  assert.equal(com.tomador.email, 'fiscal@cliente.com.br');
  assert.equal(com.tomador.telefone, '4133334444');
  assert.equal(com.tomador.endereco.logradouro, 'Rua das Flores');
  assert.equal(com.tomador.endereco.cep, '80010000');
  assert.equal(com.tomador.endereco.bairro, 'Centro');
});

test('o código de tributação municipal acompanha', () => {
  const com = herdarDaOriginal(pedidoDaTela(), DPS_ORIGINAL);
  assert.equal(com.servico.codigoTributacaoMunicipal, '101');
});

test('a correção que a pessoa veio fazer vence a herança', () => {
  /* É o ponto inteiro da substituição. Herdar não pode desfazer a mudança. */
  const com = herdarDaOriginal(pedidoDaTela(), DPS_ORIGINAL);
  assert.equal(com.valores.valorServico, 2800, 'o valor NOVO, não os 2500 da original');

  const outroServico = herdarDaOriginal(
    pedidoDaTela({ servico: { codigoTributacaoNacional: '020202', descricao: 'Outro serviço' } }),
    DPS_ORIGINAL);
  assert.equal(outroServico.servico.codigoTributacaoNacional, '020202');
  assert.equal(outroServico.servico.descricao, 'Outro serviço');
  assert.equal(outroServico.servico.codigoTributacaoMunicipal, '101', 'o que não mudou, herda');
});

test('trocar o tomador não traz o endereço do antigo junto', () => {
  /* Corrigir o tomador é uma substituição legítima — e completar o endereço do
     novo com o do antigo produziria uma nota apontando para a rua de outra
     empresa. */
  const com = herdarDaOriginal(
    pedidoDaTela({ tomador: { cnpj: '99888777000166', razaoSocial: 'Outro Cliente SA' } }),
    DPS_ORIGINAL);
  assert.equal(com.tomador.cnpj, '99888777000166');
  assert.equal(com.tomador.email, undefined, 'e-mail do tomador antigo não pode vazar');
  assert.equal(com.tomador.endereco, undefined, 'nem o endereço');
});

test('null é escolha e é respeitado; undefined é omissão', () => {
  /* Quem manda `email: null` está dizendo "sem e-mail", e a herança não pode
     ressuscitar o antigo. */
  const p = pedidoDaTela();
  p.tomador.email = null;
  const com = herdarDaOriginal(p, DPS_ORIGINAL);
  assert.equal(com.tomador.email, null);
});

test('DPS ilegível não impede a substituição', () => {
  /* Herdar é comodidade. Falhar aqui travaria justamente a forma de corrigir
     uma nota errada — a hora em que a pessoa menos precisa de um obstáculo. */
  for (const ruim of [null, '', '<lixo/>', '<DPS><infDPS>quebrado']) {
    const com = herdarDaOriginal(pedidoDaTela(), ruim);
    assert.equal(com.valores.valorServico, 2800, 'com DPS ' + JSON.stringify(ruim));
  }
});

test('a herança acontece antes dos padrões da empresa', () => {
  /* A ordem é o que dá sentido a tudo: o chamador, depois a nota original,
     depois o cadastro. Invertida, o padrão da empresa venceria a nota — que é
     exatamente o defeito que isto corrige. */
  const servico = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'emissaoService.js'), 'utf8');
  const heranca = servico.indexOf('herdarDaOriginal(dadosRecebidos');
  const padroes = servico.indexOf('aplicarPadroes(empresa, comHeranca)');
  assert.ok(heranca > 0 && padroes > 0, 'as duas etapas precisam existir');
  assert.ok(heranca < padroes, 'herdar da original vem antes de aplicar o padrão da empresa');
});

test('a DPS original é buscada dentro do escopo da empresa', () => {
  /* Sem empresa_id no WHERE, uma chave de acesso de outra empresa traria os
     dados DELA para dentro desta nota — vazamento pela porta da substituição. */
  const servico = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'emissaoService.js'), 'utf8');
  const i = servico.indexOf('async function dpsDaChave');
  assert.ok(i > 0);
  const corpo = servico.slice(i, servico.indexOf('\n}\n', i));
  assert.match(corpo, /empresa_id = \$1 AND chave_acesso = \$2/);
});

test('o leitor tolera atributo na tag', () => {
  /* `<infDPS Id="DPS...">` carrega o Id. Um regex de tag nua não casa o bloco
     e a leitura volta tudo nulo — sem erro nenhum, que é o pior jeito de
     falhar. */
  const lido = lerDps(DPS_ORIGINAL);
  assert.ok(lido, 'a DPS com Id no infDPS precisa ser lida');
  assert.equal(lido.valores.valorServico, 2500);
});
