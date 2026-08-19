const test = require('node:test');
const assert = require('node:assert');
const { montarDps } = require('../src/nfse/dpsBuilder');

/* A Inscrição Municipal do prestador na DPS.
 *
 * A Sefin valida a IM contra o CNC do município emissor e recusa nos dois
 * sentidos, o que torna o campo condicional em vez de opcional:
 *
 *   E0116  "A IM deve ser informada"                    — quando falta
 *   E0120  "A IM não deve ser informado, pois não        — quando sobra
 *           existem informações complementares no CNC"
 *
 * Mesmo CNPJ, mesmo município (Curitiba), ambientes diferentes: produção
 * restrita devolveu E0116 e produção devolveu E0120. Cada uma dessas rejeições
 * queima um número da sequência fiscal, que não se reaproveita.
 *
 * Quem decide é emissaoService.omitirIm, consultando regra_im_dps; o builder
 * só obedece. Estes testes cobrem o builder — a parte que produz o XML que a
 * Sefin vai julgar. */

const EMPRESA = {
  cnpj: '21583854000118',
  inscricao_municipal: '1102709463',
  codigo_municipio: '4106902',
  uf: 'PR',
  email: 'financeiro@exemplo.com.br',
  telefone: '41999372241',
  op_simp_nac: 3,
  reg_esp_trib: 0
};

const DADOS = {
  tomador: { cnpj: '14073521000183', razaoSocial: 'RAYZER SERVICOS E TECNOLOGIA LTDA' },
  servico: {
    codigoTributacaoNacional: '110201',
    descricao: 'Prestacao de servicos de vigilancia patrimonial',
    codigoMunicipioPrestacao: '4106902'
  },
  valores: { valorServico: 3.0 },
  tributacaoIssqn: 1
};

const OPCOES = { tpAmb: '1', verAplic: 'teste', idDps: 'DPS1', serie: '2', numero: 6 };

function montar(omitirIm) {
  return montarDps(Object.assign({}, EMPRESA, { omitir_im: omitirIm }), DADOS, OPCOES);
}

test('sem omitir, a IM vai na DPS', () => {
  assert.match(montar(false), /<IM>1102709463<\/IM>/);
});

test('omitindo, a tag IM não aparece', () => {
  // Não basta ir vazia: <IM></IM> também é "informar a IM" para o esquema
  const xml = montar(true);
  assert.ok(!/<IM>/.test(xml), 'a tag IM não pode existir no XML');
});

test('omitir a IM não mexe no resto do prestador', () => {
  const xml = montar(true);
  assert.match(xml, /<CNPJ>21583854000118<\/CNPJ>/);
  assert.match(xml, /<fone>41999372241<\/fone>/);
  assert.match(xml, /<opSimpNac>3<\/opSimpNac>/);
});

test('empresa sem IM cadastrada não gera tag vazia', () => {
  // O caminho antigo: quem nunca teve IM já emitia sem ela
  const semIm = Object.assign({}, EMPRESA, { inscricao_municipal: null });
  assert.ok(!/<IM>/.test(montarDps(semIm, DADOS, OPCOES)));
});

/* A decisão de omitir vive no serviço. Reproduzida aqui para fixar a regra:
   regra gravada vence; sem regra, produção omite e homologação envia. */
function omitirIm(regra, ambiente) {
  if (regra) return !regra.exige_im;
  return ambiente === 'producao';
}

test('a regra gravada tem a palavra final', () => {
  // Município que exige a IM em produção: existe, e a tabela é para ele
  assert.equal(omitirIm({ exige_im: true }, 'producao'), false);
  assert.equal(omitirIm({ exige_im: false }, 'homologacao'), true);
});

test('sem regra conhecida, produção omite e homologação envia', () => {
  assert.equal(omitirIm(null, 'producao'), true);
  assert.equal(omitirIm(null, 'homologacao'), false);
});
