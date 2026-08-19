#!/usr/bin/env node
/**
 * Valida a DPS gerada contra o XSD oficial da Sefin.
 *
 * Toda vez que mexemos no dpsBuilder houve o risco de inventar um campo ou
 * trocar a ordem de dois elementos — e a Sefin só reclama depois de reservar
 * número e assinar. Este script pega isso antes.
 *
 * Precisa dos XSD em .notas-tecnicas/xsd/, baixados de
 * gov.br/nfse > documentação técnica > RTC.
 *
 * Uso: node scripts/validar-xsd.js
 *
 * Roda fora do `npm test` porque depende do Python com lxml e dos XSD baixados,
 * que não estão no repositório (nem devem: são material da Sefin, versionado
 * por eles).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const XSD = path.join(RAIZ, '.notas-tecnicas', 'xsd-validavel', 'DPS_v1.01.xsd');

if (!fs.existsSync(XSD)) {
  console.error('XSD não encontrado em', XSD);
  console.error('\nBaixe o pacote de esquemas do portal da NFS-e:');
  console.error('  https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc');
  console.error('e extraia em .notas-tecnicas/xsd/');
  console.error('\nO XSD oficial usa lookahead (?!...), que XML Schema 1.0 não aceita;');
  console.error('gere a cópia validável trocando esses patterns por ".*".');
  process.exit(2);
}

const { montarDps, gerarIdDps } = require('../src/nfse/dpsBuilder');

const EMPRESA = {
  cnpj: '21583854000118', inscricao_municipal: '1102709463', codigo_municipio: '4106902',
  op_simp_nac: 1, reg_esp_trib: 0, ambiente: 'producao',
  email: 'a@b.com', telefone: '4199999999'
};
// cNBS obrigatório no 1.01, que é o leiaute validado aqui
const SERVICO = { codigoTributacaoNacional: '110201', descricao: 'Servico prestado', codigoNbs: '123456789' };

const CASOS = {
  'básica': {},
  'simples nacional': { __sn: true },
  'IBS/CBS mínimo': { ibsCbs: { indicadorOperacao: '100301', indicadorDestinatario: 0,
    tributacao: { cst: '000', classificacaoTributaria: '000001' } } },
  'IBS/CBS com destinatário': { ibsCbs: {
    consumidorFinal: 1, indicadorOperacao: '100301', indicadorDestinatario: 1,
    destinatario: { cnpj: '14073521000183', nome: 'DEST LTDA',
      endereco: { codigoMunicipio: '4106902', cep: '80010000', logradouro: 'R A', numero: '1', bairro: 'C' } },
    tributacao: { cst: '000', classificacaoTributaria: '000001' } } },
  'IBS/CBS diferimento e estorno': { ibsCbs: { indicadorOperacao: '100301', indicadorDestinatario: 0,
    tributacao: { cst: '000', classificacaoTributaria: '000001',
      diferimento: { percentualUF: 10, percentualMunicipal: 5, percentualCBS: 2 },
      estornoCredito: { valorIBS: 30, valorCBS: 20 } } } },
  'retenções federais': { valores: { valorServico: 1000, aliquotaIss: 5,
    retencoesFederais: { baseCalculo: 1000, valorPis: 6.5, valorCofins: 30,
      valorRetencaoIrrf: 15, valorRetencaoCsll: 10 } } },
  'ajuste de base': { valores: { valorServico: 1000, aliquotaIss: 5, valorDeducoes: 300 } },
  'imunidade (2)': { valores: { valorServico: 1000, tributacaoIssqn: 2, tipoImunidade: 2 } },
  'exportação (3)': { valores: { valorServico: 1000, tributacaoIssqn: 3, paisResultado: 'US' } },
  'não incidência (4)': { valores: { valorServico: 1000, tributacaoIssqn: 4 } },
  'exigibilidade suspensa': { valores: { valorServico: 1000, aliquotaIss: 5,
    exigibilidadeSuspensa: { tipo: 1, numeroProcesso: '000123456202681600010000000000' } } },
  'obra': { servico: Object.assign({}, SERVICO, { codigoTributacaoNacional: '070201',
    obra: { codigoObra: 'OB-1', cep: '80010000', logradouro: 'Rua XV', numero: '100', bairro: 'Centro' },
    documentoTecnico: 'ART-99' }) },
  'tomador completo': { tomador: { cnpj: '14073521000183', razaoSocial: 'CLIENTE LTDA',
    email: 'c@d.com', telefone: '4133334444',
    endereco: { codigoMunicipio: '4106902', cep: '80010000', logradouro: 'Rua A', numero: '1', bairro: 'Centro' } } },
  'benefício municipal': { valores: { valorServico: 1000, aliquotaIss: 5,
    beneficioMunicipal: { numero: '12345678901234', percentualReducao: 50 } } },
  'descontos': { valores: { valorServico: 1000, aliquotaIss: 5,
    descontoIncondicionado: 50, descontoCondicionado: 30 } },
  // Tudo que o formulário de emissão pode preencher, de uma vez: é o caso que
  // pega uma combinação inválida entre campos que sozinhos passam.
  'formulário completo': {
    servico: { codigoTributacaoNacional: '070201', descricao: 'Construcao civil',
      codigoNbs: '123456789', documentoTecnico: 'ART-2026-99', pedido: 'PED-42',
      informacoesComplementares: 'Medicao 3',
      obra: { codigoObra: 'CNO-123456', inscricaoImobiliaria: 'IPTU-9' } },
    valores: { valorServico: 50000, aliquotaIss: 3, issRetido: true,
      descontoIncondicionado: 1000, descontoCondicionado: 500, valorDeducoes: 20000,
      beneficioMunicipal: { numero: '12345678901234', percentualReducao: 10 },
      retencoesFederais: { baseCalculo: 50000, valorPis: 325, valorCofins: 1500,
        valorRetencaoIrrf: 750, valorRetencaoCsll: 500, valorRetencaoPrevidencia: 5500,
        retidoPeloTomador: true } },
    ibsCbs: { indicadorOperacao: '100301', indicadorDestinatario: 0, consumidorFinal: 0,
      tributacao: { cst: '000', classificacaoTributaria: '000001' } },
    tomador: { cnpj: '14073521000183', razaoSocial: 'CLIENTE LTDA',
      endereco: { codigoMunicipio: '4106902' } }
  }
};

function gerar(extra) {
  const sn = extra.__sn === true;
  const empresa = Object.assign({}, EMPRESA, sn ? { op_simp_nac: 3 } : {});
  const dados = Object.assign({
    servico: SERVICO,
    valores: Object.assign({ valorServico: 1000 },
      sn ? { percentualTotalTributosSN: 4.17 } : { aliquotaIss: 5 })
  }, extra);
  delete dados.__sn;

  return montarDps(empresa, dados, {
    tpAmb: '1', verAplic: 'nfse-gateway/1.0', serie: '1', numero: 1,
    idDps: gerarIdDps({ codigoMunicipio: empresa.codigo_municipio, cnpj: empresa.cnpj, serie: '1', numero: 1 })
  });
}

/* A validação em si é feita pelo Python: Node não tem validador de XSD na
   biblioteca padrão, e trazer uma dependência nativa só para isso não se paga
   num projeto que roda numa máquina de contabilidade. */
const VALIDADOR = `
import sys, json
from lxml import etree
schema = etree.XMLSchema(etree.parse(sys.argv[1]))
casos = json.load(open(sys.argv[2], encoding='utf-8'))
falhas = 0
for nome, xml in casos.items():
    try:
        schema.assertValid(etree.fromstring(xml.encode('utf-8')))
        print('  OK    %s' % nome)
    except etree.DocumentInvalid as e:
        print('  FALHA %s: %s' % (nome, str(e).split(chr(10))[0]))
        falhas += 1
sys.exit(1 if falhas else 0)
`;

const gerados = {};
let erroGeracao = 0;
for (const [nome, extra] of Object.entries(CASOS)) {
  try {
    gerados[nome] = gerar(JSON.parse(JSON.stringify(extra)));
  } catch (e) {
    console.error(`  ERRO  ${nome}: ${e.message}`);
    erroGeracao++;
  }
}

const tmp = path.join(require('os').tmpdir(), 'nfse-xsd-casos.json');
fs.writeFileSync(tmp, JSON.stringify(gerados), 'utf8');

console.log(`Validando ${Object.keys(gerados).length} casos contra ${path.basename(XSD)}:\n`);
try {
  const saida = execFileSync('python', ['-c', VALIDADOR, XSD, tmp], { encoding: 'utf8' });
  process.stdout.write(saida);
  console.log('\nTodos os casos válidos.');
  process.exit(erroGeracao ? 1 : 0);
} catch (e) {
  process.stdout.write(e.stdout || '');
  process.stderr.write(e.stderr || '');
  console.error('\nHá casos inválidos — corrija antes de emitir.');
  process.exit(1);
} finally {
  fs.unlinkSync(tmp);
}
