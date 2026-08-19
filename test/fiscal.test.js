/* Testes dos pontos onde um bug vira erro fiscal.
 *
 * Cada caso aqui corresponde a algo que a Sefin recusou (ou aceitou) num teste
 * real em produção — o comentário indica o código do erro quando aplicável.
 * Rodar: npm test  (usa o runner nativo do Node, sem dependência extra) */
const test = require('node:test');
const assert = require('node:assert');

const { montarDps, gerarIdDps } = require('../src/nfse/dpsBuilder');
const { montarPedidoCancelamento } = require('../src/nfse/eventoBuilder');
const { validarCnpj, validarCpf, validarDocumento } = require('../src/util/documento');
const { criarZip, crc32 } = require('../src/util/zip');

const EMPRESA_SN = {
  cnpj: '21583854000118', codigo_municipio: '4106902',
  op_simp_nac: 3, reg_esp_trib: 0,
  cep: '80240510', logradouro: 'RUA EXEMPLO', numero: '337', bairro: 'CENTRO',
  telefone: '(41) 99937-2241', email: 'teste@exemplo.com'
};
const OPTS = { tpAmb: '1', verAplic: 'nfse-gateway/1.0', idDps: 'X', serie: '2', numero: 1 };
const DADOS_MIN = {
  servico: { codigoTributacaoNacional: '110201', descricao: 'Servico' },
  valores: { valorServico: 100 }
};

// ---------------------------------------------------------------- documentos

test('CNPJ válido é aceito e inválido é recusado', () => {
  assert.ok(validarCnpj('21583854000118'), 'CNPJ real da Recalcatti');
  assert.ok(validarCnpj('00000000000191'), 'CNPJ do Banco do Brasil');
  // Foi este que a Sefin recusou com E0188 num teste real.
  assert.ok(!validarCnpj('12345678000199'), 'dígito verificador não confere');
  assert.ok(!validarCnpj('11111111111111'), 'sequência repetida');
  assert.ok(!validarCnpj('123'), 'tamanho errado');
});

test('CPF é validado pelo dígito verificador', () => {
  assert.ok(validarCpf('52998224725'));
  assert.ok(!validarCpf('11111111111'));
  assert.ok(!validarCpf('52998224726'));
});

test('validarDocumento aceita CPF e CNPJ pelo comprimento', () => {
  assert.ok(validarDocumento('21.583.854/0001-18'), 'CNPJ com máscara');
  assert.ok(validarDocumento('529.982.247-25'), 'CPF com máscara');
  assert.ok(!validarDocumento('123456'));
});

// ---------------------------------------------------------------------- DPS

test('Id da DPS tem 45 caracteres no formato do leiaute', () => {
  const id = gerarIdDps({ codigoMunicipio: '4106902', cnpj: '21583854000118', serie: '2', numero: 1 });
  assert.strictEqual(id.length, 45);
  assert.ok(id.startsWith('DPS4106902'), 'prefixo + município');
  assert.ok(id.endsWith('000000000000001'), 'número com 15 dígitos');
});

test('Simples Nacional não envia pAliq e usa pTotTribSN', () => {
  // Enviar pAliq para optante do SN é incorreto: o ISS sai no DAS.
  const xml = montarDps(EMPRESA_SN, {
    ...DADOS_MIN,
    valores: { valorServico: 100, aliquotaIss: 5, percentualTotalTributosSN: 10.4288 }
  }, OPTS);
  assert.ok(!/<pAliq>/.test(xml), 'não deve enviar alíquota de ISS');
  assert.match(xml, /<pTotTribSN>10\.43<\/pTotTribSN>/);
});

test('não optante mantém pAliq', () => {
  const xml = montarDps({ ...EMPRESA_SN, op_simp_nac: 1 }, {
    ...DADOS_MIN, valores: { valorServico: 100, aliquotaIss: 5 }
  }, OPTS);
  assert.match(xml, /<pAliq>5\.00<\/pAliq>/);
});

test('SN sem percentual informado omite o grupo de total de tributos', () => {
  /* Este teste já exigiu o contrário — <indTotTrib>0</indTotTrib>, declarando
     ausência de informação. A Sefin recusou em produção:
       "E0712: Para ME/EPP o indicador de informação de valor total de tributos
        não pode ser informado."
     Para quem está no Simples a única forma aceita é pTotTribSN; não havendo
     percentual, o grupo inteiro fica de fora. */
  const xml = montarDps(EMPRESA_SN, DADOS_MIN, OPTS);
  assert.ok(!/<indTotTrib>/.test(xml), 'ME/EPP não pode declarar indTotTrib');
  assert.ok(!/<totTrib>/.test(xml), 'grupo vazio seria recusado pelo esquema');
});

test('SN aceita o percentual como número simples', () => {
  // O formulário e os padrões da empresa guardam um percentual só: para o
  // Simples não há repartição por esfera, é a alíquota efetiva do PGDAS
  const xml = montarDps(EMPRESA_SN, {
    ...DADOS_MIN, valores: { valorServico: 100, percentualTotalTributos: 6 }
  }, OPTS);
  assert.match(xml, /<pTotTribSN>6\.00<\/pTotTribSN>/);
});

test('não optante segue detalhando por esfera', () => {
  const xml = montarDps({ ...EMPRESA_SN, op_simp_nac: 1 }, {
    ...DADOS_MIN,
    valores: { valorServico: 100, percentualTotalTributos: { federal: 4, municipal: 2 } }
  }, OPTS);
  assert.match(xml, /<pTotTribFed>4\.00<\/pTotTribFed>/);
  assert.match(xml, /<pTotTribMun>2\.00<\/pTotTribMun>/);
});

test('endereço do prestador não vai na DPS (E0128)', () => {
  // A Sefin recusa: "O endereço nacional do prestador do serviço não deve ser
  // informado na DPS quando o próprio prestador for o emitente".
  const xml = montarDps(EMPRESA_SN, DADOS_MIN, OPTS);
  const prest = xml.match(/<prest>[\s\S]*?<\/prest>/)[0];
  assert.ok(!/<end>/.test(prest), 'bloco de endereço não pode estar em <prest>');
  assert.match(prest, /<fone>41999372241<\/fone>/, 'telefone segue, só dígitos');
});

test('substituição inclui o bloco subst apenas quando solicitada', () => {
  const chave = '4'.repeat(50);
  const comSubst = montarDps(EMPRESA_SN, {
    ...DADOS_MIN,
    substituicao: { chaveSubstituida: chave, codigoMotivo: '99', motivo: 'Correcao' }
  }, OPTS);
  assert.match(comSubst, new RegExp(`<chSubstda>${chave}</chSubstda>`));
  assert.match(comSubst, /<cLocEmi>[^<]*<\/cLocEmi><subst>/, 'subst vem logo após cLocEmi');

  const semSubst = montarDps(EMPRESA_SN, DADOS_MIN, OPTS);
  assert.ok(!/<subst>/.test(semSubst));
});

test('valores monetários saem com duas casas', () => {
  const xml = montarDps(EMPRESA_SN, { ...DADOS_MIN, valores: { valorServico: 1 } }, OPTS);
  assert.match(xml, /<vServ>1\.00<\/vServ>/);
});

// ------------------------------------------------------------------- evento

test('Id do pedido de cancelamento tem 59 caracteres, sem sequencial', () => {
  // Com sequencial no fim vira 62 e a Sefin recusa: "Id ... TSIdPedRegEvt -
  // The Pattern constraint failed" (E1235).
  const chave = '4'.repeat(50);
  const xml = montarPedidoCancelamento({
    tpAmb: '1', verAplic: 'v', chaveAcesso: chave, cnpjAutor: '21583854000118', codigoMotivo: 1
  });
  const id = xml.match(/Id="([^"]+)"/)[1];
  assert.strictEqual(id.length, 59);
  assert.strictEqual(id, 'PRE' + chave + '101101');
});

test('cancelamento usa leiaute 1.01, sem nPedRegEvento e com xMotivo', () => {
  const xml = montarPedidoCancelamento({
    tpAmb: '1', verAplic: 'v', chaveAcesso: '4'.repeat(50),
    cnpjAutor: '21583854000118', codigoMotivo: 1
  });
  assert.match(xml, /versao="1\.01"/);
  assert.ok(!/<nPedRegEvento>/.test(xml), 'não pertence a infPedReg');
  // xMotivo é obrigatório em qualquer motivo, não só no 9.
  assert.match(xml, /<xMotivo>[^<]+<\/xMotivo>/);
});

test('motivo informado prevalece sobre o texto padrão', () => {
  const xml = montarPedidoCancelamento({
    tpAmb: '1', verAplic: 'v', chaveAcesso: '4'.repeat(50),
    cnpjAutor: '21583854000118', codigoMotivo: 9, motivo: 'Motivo especifico'
  });
  assert.match(xml, /<xMotivo>Motivo especifico<\/xMotivo>/);
});

// ---------------------------------------------------------------------- zip

test('CRC32 bate com o valor canônico', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('ZIP gerado tem assinatura e diretório central válidos', () => {
  const zip = criarZip([{ nome: 'a.xml', conteudo: '<x/>' }, { nome: 'b.xml', conteudo: '<y/>' }]);
  assert.strictEqual(zip.slice(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(zip.includes(Buffer.from('PK\x05\x06', 'latin1')), 'end of central directory');
  assert.ok(zip.includes(Buffer.from('a.xml')) && zip.includes(Buffer.from('b.xml')));
});
