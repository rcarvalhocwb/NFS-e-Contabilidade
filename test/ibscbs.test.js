const test = require('node:test');
const assert = require('node:assert');
const { montarDps } = require('../src/nfse/dpsBuilder');

/* Grupo IBSCBS — Reforma Tributária do Consumo.
   Estrutura conforme AnexoVI-LeiautesRN_RTC_IBSCBS v1.04.00 (NT 009/2026).

   Hoje é facultativo: a NT 004 v2.0 suspendeu a obrigatoriedade e documentos
   sem o grupo seguem autorizados. Mas quem informa tem tudo validado — daí os
   testes cobrirem tanto a ausência quanto o conteúdo mínimo exigido. */

const EMPRESA = {
  cnpj: '21583854000118', inscricao_municipal: null, codigo_municipio: '4106902',
  op_simp_nac: 1, reg_esp_trib: 0, ambiente: 'producao', email: null, telefone: null
};
const OPTS = { tpAmb: '1', verAplic: 'teste/1.0', idDps: 'DPS' + '0'.repeat(42), serie: '1', numero: 1 };

function dps(dados) {
  return montarDps(EMPRESA, Object.assign({
    // Informar IBS/CBS leva a DPS para o leiaute 1.01, onde o esquema torna
    // cNBS obrigatório
    servico: { codigoTributacaoNacional: '110201', descricao: 'Servico', codigoNbs: '123456789' },
    valores: { valorServico: 1000 }
  }, dados), OPTS);
}

test('sem o grupo informado, a DPS sai como antes', () => {
  // O que já está autorizado em produção não pode mudar de forma
  const x = dps({});
  assert.ok(!x.includes('<IBSCBS>'));
});

test('grupo mínimo: indDest, CST e cClassTrib', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 0,
    tributacao: { cst: '000', classificacaoTributaria: '000001' }
  } });
  assert.match(x, /<IBSCBS><finNFSe>0<\/finNFSe><cIndOp>000001<\/cIndOp><indDest>0<\/indDest>/);
  assert.match(x, /<valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS>/);
  // O grupo entra depois de </valores> da DPS, como manda o leiaute
  assert.match(x, /<\/valores><IBSCBS>/);
});

test('CST e cClassTrib são preenchidos com zeros à esquerda', () => {
  // O leiaute pede 3 e 6 dígitos; quem digita costuma omitir os zeros
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 0,
    tributacao: { cst: 0, classificacaoTributaria: 1 }
  } });
  assert.match(x, /<CST>000<\/CST>/);
  assert.match(x, /<cClassTrib>000001<\/cClassTrib>/);
});

test('campos obrigatórios do grupo são cobrados antes de assinar', () => {
  // Falhar aqui evita queimar número de DPS numa nota que a Sefin recusaria
  assert.throws(
    () => dps({ ibsCbs: { indicadorOperacao: '000001',
      tributacao: { cst: '000', classificacaoTributaria: '000001' } } }),
    /indicadorDestinatario/);
  assert.throws(
    () => dps({ ibsCbs: { indicadorDestinatario: 0,
      tributacao: { cst: '000', classificacaoTributaria: '000001' } } }),
    /indicadorOperacao/);
});

test('sem CST ou cClassTrib o grupo é recusado', () => {
  assert.throws(
    () => dps({ ibsCbs: { indicadorOperacao: '000001', indicadorDestinatario: 0 } }),
    /cst/);
  assert.throws(
    () => dps({ ibsCbs: { indicadorOperacao: '000001', indicadorDestinatario: 0,
      tributacao: { cst: '000' } } }),
    /classificacaoTributaria/);
});

test('indicadores opcionais entram na ordem do leiaute', () => {
  const x = dps({ ibsCbs: {
    consumidorFinal: 1,
    tipoOperacao: 1,
    indicadorOperacao: '000001',
    indicadorDestinatario: 1,
    tributacao: { cst: '000', classificacaoTributaria: '000001' }
  } });
  assert.match(x,
    /<IBSCBS><finNFSe>0<\/finNFSe><indFinal>1<\/indFinal><cIndOp>000001<\/cIndOp><tpOper>1<\/tpOper><indDest>1<\/indDest>/);
});

test('destinatário diferente do tomador entra em dest', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 1,
    destinatario: {
      cnpj: '21583854000118', nome: 'DESTINATARIO LTDA',
      endereco: { codigoMunicipio: '4106902', cep: '80010-000', logradouro: 'Rua XV',
                  numero: '100', bairro: 'Centro' }
    },
    tributacao: { cst: '000', classificacaoTributaria: '000001' }
  } });
  assert.match(x, /<dest><CNPJ>21583854000118<\/CNPJ><xNome>DESTINATARIO LTDA<\/xNome>/);
  assert.match(x, /<endNac><cMun>4106902<\/cMun><CEP>80010000<\/CEP><\/endNac>/);
});

test('destinatário no exterior usa endExt', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 1,
    destinatario: {
      nif: 'PT123456789', nome: 'CLIENTE EUROPA LDA',
      endereco: { codigoPais: 'PT', codigoPostal: '1000-001', cidade: 'Lisboa',
                  estado: 'Lisboa', logradouro: 'Rua A', numero: '1', bairro: 'Centro' }
    },
    tributacao: { cst: '000', classificacaoTributaria: '000001' }
  } });
  assert.match(x, /<NIF>PT123456789<\/NIF>/);
  assert.match(x, /<endExt><cPais>PT<\/cPais>/);
  assert.ok(!x.includes('<endNac>'));
});

test('tributação regular acompanha operação desonerada', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 0,
    tributacao: {
      cst: '200', classificacaoTributaria: '200001',
      tributacaoRegular: { cst: '000', classificacaoTributaria: '000001' }
    }
  } });
  assert.match(x, /<gTribRegular><CSTReg>000<\/CSTReg><cClassTribReg>000001<\/cClassTribReg><\/gTribRegular>/);
});

test('diferimento sai no próprio grupo; estorno espera o XSD da NT 009', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 0,
    tributacao: {
      cst: '000', classificacaoTributaria: '000001',
      diferimento: { percentualUF: 10, percentualMunicipal: 5, percentualCBS: 2 },
      estornoCredito: { valorIBS: 30, valorCBS: 20 }
    }
  } });
  assert.match(x, /<gDif><pDifUF>10\.00<\/pDifUF><pDifMun>5\.00<\/pDifMun><pDifCBS>2\.00<\/pDifCBS><\/gDif>/);
  // gEstornoCred consta da NT 009 mas não do esquema publicado
  assert.ok(!x.includes('gEstornoCred'));
});

test('nota de ajuste referencia as NFS-e originais', () => {
  const x = dps({ ibsCbs: {
    indicadorOperacao: '000001', indicadorDestinatario: 0,
    notasReferenciadas: ['1'.repeat(50), '2'.repeat(50)],
    ajuste: { valorIBS: 100, valorCBS: 50 },
    tributacao: { cst: '000', classificacaoTributaria: '000001' }
  } });
  assert.match(x, /<gRefNFSe><refNFSe>1{50}<\/refNFSe><refNFSe>2{50}<\/refNFSe><\/gRefNFSe>/);
  assert.match(x, /<gIBSCBSAjuste><vIBS>100\.00<\/vIBS><vCBS>50\.00<\/vCBS><\/gIBSCBSAjuste>/);
});
