const test = require('node:test');
const assert = require('node:assert');
const { montarDps } = require('../src/nfse/dpsBuilder');
const { extrairValores, baseCalculo, valorIss, totalRetencoesFederais } =
  require('../src/nfse/extrairValores');

/* Extração dos valores para o fechamento.
   Um erro aqui vira ISS errado no relatório do mês — e o contador só descobre
   quando confere contra a guia. Os testes partem do XML gerado pelo próprio
   builder, para que builder e leitura não se separem sem quebrar. */

const EMPRESA = {
  cnpj: '21583854000118', inscricao_municipal: null, codigo_municipio: '4106902',
  op_simp_nac: 1, reg_esp_trib: 0, ambiente: 'producao', email: null, telefone: null
};
const OPTS = { tpAmb: '1', verAplic: 't/1.0', idDps: 'DPS' + '0'.repeat(42), serie: '1', numero: 1 };

function xml(dados) {
  return montarDps(EMPRESA, Object.assign({
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico prestado' },
    valores: { valorServico: 1000 }
  }, dados), OPTS);
}

test('lê o essencial de uma nota simples', () => {
  const v = extrairValores(xml({ valores: { valorServico: 1000, aliquotaIss: 5 } }));
  assert.equal(v.valorServico, 1000);
  assert.equal(v.aliquota, 5);
  assert.equal(v.issRetido, false);
  assert.equal(v.descricao, 'Servico prestado');
});

test('base de cálculo desconta o incondicionado e as deduções', () => {
  const v = extrairValores(xml({ valores: {
    valorServico: 10000, aliquotaIss: 5, descontoIncondicionado: 500, valorDeducoes: 2000
  } }));
  assert.equal(baseCalculo(v), 7500);
  assert.equal(valorIss(v), 375);   // 5% de 7500
});

test('desconto condicionado não reduz a base', () => {
  // Ele só é abatido se a condição se cumprir, e aí não é matéria da nota
  const v = extrairValores(xml({ valores: {
    valorServico: 1000, aliquotaIss: 5, descontoCondicionado: 300
  } }));
  assert.equal(baseCalculo(v), 1000);
});

test('ISS retido é reconhecido', () => {
  const v = extrairValores(xml({ valores: { valorServico: 1000, aliquotaIss: 5, issRetido: true } }));
  assert.equal(v.issRetido, true);
});

test('sem alíquota não há ISS — é o caso do Simples Nacional', () => {
  const sn = montarDps(Object.assign({}, EMPRESA, { op_simp_nac: 3 }), {
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico' },
    valores: { valorServico: 1000, aliquotaIss: 5, percentualTotalTributosSN: 4.17 }
  }, OPTS);
  const v = extrairValores(sn);
  assert.equal(v.aliquota, null, 'o builder não declara alíquota para optante do SN');
  assert.equal(valorIss(v), null, 'sem alíquota, o ISS sai no DAS e não aqui');
});

test('operação imune não gera ISS mesmo com alíquota no XML', () => {
  const v = extrairValores(xml({ valores: {
    valorServico: 1000, tributacaoIssqn: 4, tipoImunidade: 2
  } }));
  assert.equal(v.tributacaoIssqn, '4');
  assert.equal(valorIss(v), null);
});

test('retenções federais são somadas', () => {
  const v = extrairValores(xml({ valores: {
    valorServico: 10000, aliquotaIss: 5,
    retencoesFederais: { baseCalculo: 10000, valorPis: 65, valorCofins: 300,
      valorRetencaoIrrf: 150, valorRetencaoCsll: 100, valorRetencaoPrevidencia: 1100 }
  } }));
  assert.equal(totalRetencoesFederais(v), 1715);
});

test('sem retenção o total é zero, não NaN', () => {
  assert.equal(totalRetencoesFederais(extrairValores(xml({}))), 0);
});

test('o nome lido é o do tomador, não o do prestador', () => {
  // Prestador e tomador têm campos homônimos; procurar a tag solta pegaria o
  // primeiro que aparecesse no XML
  const v = extrairValores(xml({ tomador: {
    cnpj: '14073521000183', razaoSocial: 'CLIENTE TOMADOR LTDA'
  } }));
  assert.equal(v.tomador, 'CLIENTE TOMADOR LTDA');
  assert.equal(v.docTomador, '14073521000183');
});

test('nota sem tomador não inventa nome', () => {
  const v = extrairValores(xml({}));
  assert.equal(v.tomador, null);
  assert.equal(v.docTomador, null);
});

test('XML ausente devolve objeto vazio em vez de estourar', () => {
  assert.deepEqual(extrairValores(null), {});
  assert.equal(baseCalculo({}), 0);
  assert.equal(valorIss({}), null);
});

test('arredonda para centavos, sem sobra de ponto flutuante', () => {
  const v = extrairValores(xml({ valores: { valorServico: 333.33, aliquotaIss: 3 } }));
  assert.equal(valorIss(v), 10);   // 3% de 333.33 = 9.9999
});
