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

/* Natureza da operação ---------------------------------------------------
 *
 * Os valores vêm de TSTribISSQN (tiposSimples_v1.01.xsd):
 *   1 tributável · 2 imunidade · 3 exportação · 4 não incidência
 *
 * Estes testes já afirmaram o contrário — 2=exportação, 4=imunidade — porque o
 * código estava assim. Uma nota de exportação saía declarada como imunidade, e
 * o teste confirmava o erro em vez de pegá-lo. Se for mexer aqui, confira
 * contra o XSD, não contra o código. */

test('operação tributável continua sendo o padrão', () => {
  const x = dps({});
  assert.match(x, /<tribISSQN>1<\/tribISSQN>/);
  assert.ok(!x.includes('tpImunidade'));
  assert.ok(!x.includes('exigSusp'));
});

test('imunidade é o tipo 2 e declara qual imunidade', () => {
  // Entidade imune não tem ISS a recolher: mandar pAliq seria declarar imposto
  // onde não há.
  const x = dps({ valores: { valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 2, tipoImunidade: 1 } });
  assert.match(x, /<tribISSQN>2<\/tribISSQN>/);
  assert.match(x, /<tpImunidade>1<\/tpImunidade>/);
  assert.ok(!x.includes('<pAliq>'), 'imunidade não pode declarar alíquota');
});

test('não incidência é o tipo 4, sem campo extra', () => {
  const x = dps({ valores: { valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 4 } });
  assert.match(x, /<tribISSQN>4<\/tribISSQN>/);
  assert.ok(!x.includes('<tpImunidade>'), 'não incidência não é imunidade');
  assert.ok(!x.includes('<cPaisResult>'));
  assert.ok(!x.includes('<pAliq>'));
});

test('exportação de serviço é o tipo 3 e leva o país', () => {
  const x = dps({
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico', codigoPaisPrestacao: 'US' },
    valores: { valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 3 }
  });
  assert.match(x, /<tribISSQN>3<\/tribISSQN>/);
  assert.match(x, /<cPaisPrestacao>US<\/cPaisPrestacao>/);
  assert.ok(!x.includes('<tpImunidade>'), 'exportação não é imunidade');
  assert.ok(!x.includes('<pAliq>'));
});

test('exigibilidade suspensa é um grupo à parte, não uma natureza', () => {
  /* O esquema tem exigSusp (tpSusp + nProcesso) dentro de tribMun, ao lado da
     natureza — não como valor dela. Uma operação tributável com liminar segue
     sendo tributável; o que muda é a exigibilidade. */
  const x = dps({ valores: {
    valorServico: 1000, aliquotaIss: 5, tributacaoIssqn: 1,
    // 30 dígitos, que é o que o esquema pede em nProcesso
    exigibilidadeSuspensa: { tipo: 1, numeroProcesso: '000123456202681600010000000000' }
  } });
  assert.match(x, /<tribISSQN>1<\/tribISSQN>/);
  assert.match(x, /<exigSusp><tpSusp>1<\/tpSusp><nProcesso>000123456202681600010000000000<\/nProcesso><\/exigSusp>/);
});

test('processo com pontuação do padrão CNJ tem os separadores removidos', () => {
  // O número aparece pontuado na decisão; colar assim é o caminho natural
  const x = dps({ valores: { valorServico: 1000, tributacaoIssqn: 1,
    exigibilidadeSuspensa: { tipo: 2, numeroProcesso: '0001.2345.6202.6816.0001.0000.0000.00' } } });
  assert.match(x, /<nProcesso>000123456202681600010000000000<\/nProcesso>/);
});

test('processo com quantidade errada de dígitos é recusado', () => {
  assert.throws(() => dps({ valores: { valorServico: 1000,
    exigibilidadeSuspensa: { tipo: 1, numeroProcesso: '12345' } } }),
    /30 dígitos/);
});

test('tipo de suspensão fora de 1 e 2 é recusado', () => {
  assert.throws(() => dps({ valores: { valorServico: 1000,
    exigibilidadeSuspensa: { tipo: 9, numeroProcesso: '000123456202681600010000000000' } } }),
    /1 \(decisão judicial\)/);
});

test('natureza fora de 1 a 4 é recusada antes de gastar número', () => {
  // Recusar aqui evita queimar um número de DPS numa nota que voltaria rejeitada
  assert.throws(() => dps({ valores: { valorServico: 1000, tributacaoIssqn: 5 } }),
    /tributacaoIssqn deve ser 1/);
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

test('dedução da base usa o nome que o esquema publicado espera', () => {
  // A NT 009 renomeia vDedRed para vAjusteBC, mas o XSD publicado ainda pede
  // vDedRed — e é ele que valida. O nome novo fica atrás de DPS_LEIAUTE_NT009.
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

test('benefício municipal no leiaute 1.00 exige o tipo', () => {
  /* tpBM existe no esquema 1.00 e foi removido no 1.01. O teste anterior
     afirmava que "tpBM não existe no leiaute" — verdade no 1.01, falso no 1.00,
     que é justamente a versão que o gateway emite por padrão. Sem ele, a Sefin
     recusa com "Expected is tpBM". */
  const x = dps({ valores: {
    valorServico: 1000, aliquotaIss: 5,
    beneficioMunicipal: { tipo: 2, numero: '12345678901234', percentualReducao: 50 }
  } });
  assert.match(x, /<BM><tpBM>2<\/tpBM><nBM>12345678901234<\/nBM>/);
  assert.match(x, /<pRedBCBM>50\.00<\/pRedBCBM>/);
});

test('benefício municipal sem tipo é recusado antes de gastar número', () => {
  assert.throws(() => dps({ valores: { valorServico: 1000,
    beneficioMunicipal: { numero: '12345678901234', percentualReducao: 50 } } }),
    /beneficioMunicipal\.tipo/);
});

test('tipo do benefício fora de 1 a 3 é recusado', () => {
  // 1 alíquota diferenciada · 2 redução da base · 3 isenção
  assert.throws(() => dps({ valores: { valorServico: 1000,
    beneficioMunicipal: { tipo: 9, numero: '12345678901234' } } }),
    /1 \(alíquota diferenciada\)/);
});

test('exportação declara o país de resultado em cPaisResult', () => {
  // Exportação é o tipo 3, e cPaisResult vem logo depois no esquema
  const x = dps({ valores: { valorServico: 1000, tributacaoIssqn: 3, paisResultado: 'US' } });
  assert.match(x, /<tribISSQN>3<\/tribISSQN><cPaisResult>US<\/cPaisResult>/);
});

test('cPaisResult não sai em natureza que não é exportação', () => {
  const x = dps({ valores: { valorServico: 1000, tributacaoIssqn: 2,
                             tipoImunidade: 1, paisResultado: 'US' } });
  assert.ok(!x.includes('cPaisResult'), 'país de resultado é campo de exportação');
});

test('serviço no exterior troca cLocPrestacao por cPaisPrestacao', () => {
  // São alternativos no leiaute (CE): um ou outro, nunca os dois
  const x = dps({ servico: {
    codigoTributacaoNacional: '110201', descricao: 'Servico', codigoPaisPrestacao: 'pt'
  } });
  assert.match(x, /<cPaisPrestacao>PT<\/cPaisPrestacao>/);
  assert.ok(!x.includes('cLocPrestacao'));
});

test('obra identifica-se pelo código OU pelo endereço, nunca por ambos', () => {
  // cObra, cCIB e end são alternativos no esquema (xs:choice)
  const porCodigo = dps({ servico: {
    codigoTributacaoNacional: '070201', descricao: 'Construcao',
    obra: { codigoObra: 'OBRA-2026-01', cep: '80010000', logradouro: 'Rua XV' },
    documentoTecnico: 'ART-123456'
  } });
  assert.match(porCodigo, /<obra><cObra>OBRA-2026-01<\/cObra><\/obra>/);
  assert.match(porCodigo, /<idDocTec>ART-123456<\/idDocTec>/);

  const porEndereco = dps({ servico: {
    codigoTributacaoNacional: '070201', descricao: 'Construcao',
    obra: { cep: '80010000', logradouro: 'Rua XV', numero: '100', bairro: 'Centro' }
  } });
  assert.match(porEndereco, /<obra><end><CEP>80010000<\/CEP>/);
  assert.ok(!porEndereco.includes('cObra'));
});
