/* DANFSe: conferência contra a Nota Técnica SE/CGNFS-e nº 008 v1.02.
 *
 * O que dá para afirmar sem um leitor de QR e sem rasterizar o PDF: a URL
 * codificada, a página única, o tamanho A4, a marca d'água e os campos lidos do
 * XML. A leitura do símbolo impresso foi conferida à parte, decodificando o PDF
 * renderizado a 300 dpi — o resultado está registrado no commit.
 */
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { gerarDanfse, dadosDoXml, URL_CONSULTA } = require('../src/nfse/danfse');
const { montarDps } = require('../src/nfse/dpsBuilder');

const CHAVE = '41069022215838540001180000100000000000000000000042';
const EMPRESA = {
  cnpj: '21583854000118', codigo_municipio: '4106902', op_simp_nac: 3, reg_esp_trib: 0,
  inscricao_municipal: '123456', email: 'contato@exemplo.com.br', telefone: '4199937241'
};

function nfseDeTeste({ tpAmb = '1', substituiu = null } = {}) {
  const dps = montarDps(EMPRESA, {
    dataCompetencia: '2026-08-01',
    tomador: { cnpj: '00000000000191', razaoSocial: 'BANCO DO BRASIL SA',
               endereco: { codigoMunicipio: '4106902', cep: '80010000',
                           logradouro: 'RUA JOSE LOUREIRO', numero: '337', bairro: 'CENTRO' } },
    servico: { codigoTributacaoNacional: '140101', descricao: 'Manutencao de equipamentos',
               codigoMunicipioPrestacao: '4106902' },
    valores: { valorServico: 1250.5, percentualTotalTributosSN: 10.43 },
    ...(substituiu ? { substituicao: { chaveSubstituida: substituiu, codigoMotivo: '99',
                                       motivo: 'Correcao do valor do servico' } } : {})
  }, { tpAmb, verAplic: 'nfse-gateway/1.0', idDps: 'DPS' + '4'.repeat(42), serie: '1', numero: 42 });

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">' +
    `<infNFSe Id="NFS${CHAVE}">` +
    '<xLocEmi>Curitiba</xLocEmi><xLocPrestacao>Curitiba</xLocPrestacao><nNFSe>42</nNFSe>' +
    '<xTribNac>Suporte tecnico em informatica</xTribNac>' +
    '<verAplic>SN-NFSe 1.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>' +
    '<dhProc>2026-08-20T10:15:00-03:00</dhProc><nDFSe>42</nDFSe>' +
    '<emit><CNPJ>21583854000118</CNPJ><IM>123456</IM><xNome>EMPRESA EXEMPLO LTDA</xNome>' +
    '<enderNac><cMun>4106902</cMun><UF>PR</UF><CEP>80240510</CEP></enderNac>' +
    '<xLgr>RUA EXEMPLO</xLgr><nro>337</nro><xBairro>CENTRO</xBairro></emit>' +
    '<valores><vBC>1250.50</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>25.01</vISSQN>' +
    '<vTotalRet>0</vTotalRet><vLiq>1250.50</vLiq></valores>' +
    dps.replace(/<\?xml[^>]*\?>/, '') +
    '</infNFSe></NFSe>';
}

/* Devolve o texto impresso na página.
   O PDFKit grava as strings em hexadecimal dentro de arrays TJ, e o kerning
   parte as palavras em pedaços — "CANCELADA" vira <43414e43454c4144> 40 <41>.
   Por isso não basta procurar a palavra no stream: é preciso decodificar os
   pedaços e emendá-los na ordem. */
function conteudo(pdf) {
  const bruto = pdf.toString('latin1');
  const i = bruto.indexOf('stream\n') + 'stream\n'.length;
  const f = bruto.indexOf('\nendstream', i);
  const fluxo = zlib.inflateSync(Buffer.from(bruto.slice(i, f), 'latin1')).toString('latin1');
  return (fluxo.match(/<([0-9a-fA-F]+)>/g) || [])
    .map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

test('a URL do QR Code é a que a NT 008 fixa', () => {
  // Item 2.4.3: o QR aponta para a consulta pública, com a chave após o "=".
  assert.strictEqual(URL_CONSULTA, 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=');
});

test('DANFSe sai em página única e A4', async () => {
  // Item 2.2: página única é obrigatória, em A4 retrato. Uma descrição de
  // serviço longa não pode empurrar o documento para uma segunda folha.
  const xml = nfseDeTeste();
  const longa = xml.replace('Manutencao de equipamentos', 'Servico detalhado. '.repeat(100));
  for (const [nome, doc] of [['normal', xml], ['descrição longa', longa]]) {
    const pdf = await gerarDanfse(doc);
    assert.ok(pdf.slice(0, 4).toString() === '%PDF', `${nome}: não é PDF`);
    assert.match(pdf.toString('latin1'), /\/Count 1\b/, `${nome}: deveria ter uma única página`);
    assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/, `${nome}: não é A4`);
  }
});

test('homologação recebe o aviso exigido, produção não', async () => {
  // Item 2.4.3, observação: o texto é literal e só aparece com tpAmb = 2.
  const homolog = conteudo(await gerarDanfse(nfseDeTeste({ tpAmb: '2' })));
  const producao = conteudo(await gerarDanfse(nfseDeTeste({ tpAmb: '1' })));
  assert.ok(homolog.includes('SEM VALIDADE'), 'homologação deve trazer o aviso');
  assert.ok(!producao.includes('SEM VALIDADE'), 'produção não pode trazer o aviso');
});

test('marca d\'água de cancelamento e substituição', async () => {
  // Item 2.5: a nota que deixou de valer carrega a marca na diagonal.
  const semMarca = conteudo(await gerarDanfse(nfseDeTeste()));
  const cancelada = conteudo(await gerarDanfse(nfseDeTeste(), { marcaDagua: 'CANCELADA' }));
  const substituida = conteudo(await gerarDanfse(nfseDeTeste(), { marcaDagua: 'SUBSTITUÍDA' }));
  assert.ok(!semMarca.includes('CANCELADA'));
  assert.ok(cancelada.includes('CANCELADA'), 'faltou a marca CANCELADA');
  assert.ok(substituida.includes('SUBSTITU'), 'faltou a marca SUBSTITUÍDA');
});

test('o cabeçalho traz a identificação da NT', async () => {
  const c = conteudo(await gerarDanfse(nfseDeTeste()));
  assert.ok(c.includes('DANFSe v2.0'), 'falta a descrição "DANFSe v2.0"');
  assert.ok(c.includes('Documento Auxiliar da NFS-e'), 'falta a identificação do documento');
});

test('dadosDoXml lê a NFS-e e a DPS embutida', () => {
  const d = dadosDoXml(nfseDeTeste({ substituiu: '9'.repeat(50) }));
  assert.strictEqual(d.chave, CHAVE);
  assert.strictEqual(d.numero, '42');
  assert.strictEqual(d.emitente.nome, 'EMPRESA EXEMPLO LTDA');
  assert.strictEqual(d.emitente.cnpj, '21583854000118');
  assert.strictEqual(d.emitente.opSimpNac, '3', 'regime vem da DPS embutida');
  assert.strictEqual(d.tomador.doc, '00000000000191');
  assert.strictEqual(d.tomador.bairro, 'CENTRO');
  assert.strictEqual(d.cTribNac, '140101');
  assert.strictEqual(d.valorServico, '1250.50');
  assert.strictEqual(d.pTotTribSN, '10.43');
  assert.strictEqual(d.vLiq, '1250.50');
  assert.strictEqual(d.substituiu, '9'.repeat(50), 'a finalidade sai do bloco subst');
});

test('o total de tributos da Lei 12.741 aparece nas complementares', async () => {
  const c = conteudo(await gerarDanfse(nfseDeTeste()));
  assert.ok(c.includes('12.741'), 'falta o total aproximado dos tributos');
});
