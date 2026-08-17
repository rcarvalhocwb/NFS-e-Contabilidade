const test = require('node:test');
const assert = require('node:assert');
const { montarDps } = require('../src/nfse/dpsBuilder');

const EMPRESA = {
  cnpj: '21583854000118', inscricao_municipal: null, codigo_municipio: '4106902',
  op_simp_nac: 1, reg_esp_trib: 0, ambiente: 'producao', email: null, telefone: null
};
const OPTS = { tpAmb: '1', verAplic: 'teste/1.0', idDps: 'DPS' + '0'.repeat(42), serie: '1', numero: 1 };

function dps(dados) {
  return montarDps(EMPRESA, Object.assign({
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico' },
    valores: { valorServico: 1000 }
  }, dados), OPTS);
}

/* Natureza da operação --------------------------------------------------- */

test('operação tributável continua sendo o padrão', () => {
  const x = dps({});
  assert.match(x, /<tribISSQN>1<\/tribISSQN>/);
  assert.ok(!x.includes('tpImunidade'));
  assert.ok(!x.includes('exigSusp'));
});

test('imunidade declara o tipo e não envia alíquota', () => {
  // Entidade imune não tem ISS a recolher: mandar pAliq seria declarar imposto
  // onde não há.
  const x = dps({ valores: { valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 4, tipoImunidade: 1 } });
  assert.match(x, /<tribISSQN>4<\/tribISSQN>/);
  assert.match(x, /<tpImunidade>1<\/tpImunidade>/);
  assert.ok(!x.includes('<pAliq>'), 'imunidade não pode declarar alíquota');
});

test('exportação de serviço leva o país e dispensa alíquota', () => {
  const x = dps({
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico', codigoPaisPrestacao: 'US' },
    valores: { valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 2 }
  });
  assert.match(x, /<tribISSQN>2<\/tribISSQN>/);
  assert.match(x, /<cPaisPrestacao>US<\/cPaisPrestacao>/);
  assert.ok(!x.includes('<pAliq>'));
});

test('exigibilidade suspensa carrega o número do processo', () => {
  const x = dps({ valores: {
    valorServico: 1000, tributacaoIssqn: 5, tipoSuspensao: 1, numeroProcesso: '0001234-56.2026.8.16.0001'
  } });
  assert.match(x, /<exigSusp>/);
  assert.match(x, /<tpSusp>1<\/tpSusp>/);
  assert.match(x, /<nProcesso>0001234-56\.2026\.8\.16\.0001<\/nProcesso>/);
});

/* Retenções federais ----------------------------------------------------- */

test('sem retenção federal o bloco não aparece', () => {
  // Retrocompatibilidade: a nota validada em produção não pode mudar de forma
  assert.ok(!dps({}).includes('<tribFed>'));
});

test('retenções federais entram com os valores informados', () => {
  const x = dps({ valores: {
    valorServico: 10000,
    retencoesFederais: {
      baseCalculo: 10000, valorPis: 65, valorCofins: 300,
      valorRetencaoIrrf: 150, valorRetencaoCsll: 100,
      valorRetencaoPrevidencia: 1100, retidoPeloTomador: true
    }
  } });
  assert.match(x, /<tribFed>/);
  assert.match(x, /<vPis>65\.00<\/vPis>/);
  assert.match(x, /<vCofins>300\.00<\/vCofins>/);
  assert.match(x, /<vRetIRRF>150\.00<\/vRetIRRF>/);
  assert.match(x, /<vRetCSLL>100\.00<\/vRetCSLL>/);
  assert.match(x, /<vRetCP>1100\.00<\/vRetCP>/);
  assert.match(x, /<tpRetPisCofins>2<\/tpRetPisCofins>/);
});

test('só IRRF não arrasta o bloco de PIS/COFINS', () => {
  const x = dps({ valores: {
    valorServico: 5000, retencoesFederais: { valorRetencaoIrrf: 75 }
  } });
  assert.match(x, /<vRetIRRF>75\.00<\/vRetIRRF>/);
  assert.ok(!x.includes('<piscofins>'));
});

/* Deduções e complementos ------------------------------------------------ */

test('dedução da base entra como valor ou percentual, não os dois', () => {
  const porValor = dps({ valores: { valorServico: 10000, valorDeducoes: 4000 } });
  assert.match(porValor, /<vDedRed><vDR>4000\.00<\/vDR><\/vDedRed>/);

  const porPercentual = dps({ valores: { valorServico: 10000, percentualDeducoes: 40 } });
  assert.match(porPercentual, /<pDR>40\.00<\/pDR>/);
  assert.ok(!porPercentual.includes('<vDR>'));
});

test('desconto condicionado acompanha o incondicionado', () => {
  const x = dps({ valores: { valorServico: 1000, descontoIncondicionado: 50, descontoCondicionado: 30 } });
  assert.match(x, /<vDescIncond>50\.00<\/vDescIncond>/);
  assert.match(x, /<vDescCond>30\.00<\/vDescCond>/);
});

test('informação complementar sai no bloco do serviço', () => {
  const x = dps({ servico: {
    codigoTributacaoNacional: '110201', descricao: 'Servico',
    informacoesComplementares: 'Contrato 123/2026 - medicao 4'
  } });
  assert.match(x, /<infoCompl><xInfComp>Contrato 123\/2026 - medicao 4<\/xInfComp><\/infoCompl>/);
});

test('benefício municipal declara tipo, número e redução', () => {
  const x = dps({ valores: {
    valorServico: 1000, aliquotaIss: 5,
    beneficioMunicipal: { tipo: 1, numero: 'LEI-4321', percentualReducao: 50 }
  } });
  assert.match(x, /<BM>/);
  assert.match(x, /<tpBM>1<\/tpBM>/);
  assert.match(x, /<nBM>LEI-4321<\/nBM>/);
  assert.match(x, /<pRedBCBM>50\.00<\/pRedBCBM>/);
});
