const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { montarDps } = require('../src/nfse/dpsBuilder');

/* Validação do documento montado contra os esquemas oficiais da Sefin.
 *
 * Por que separado dos demais testes: aqui não se afirma nada sobre o leiaute.
 * Um teste que verifica "o XML contém <pAliq>" passa com o elemento no lugar
 * errado; o esquema não passa.
 *
 * AS DUAS VERSÕES SÃO VALIDADAS, e essa é a razão deste arquivo existir. A
 * ordem dos elementos dentro de tribMun muda entre 1.00 e 1.01:
 *
 *   1.00  tribISSQN, cPaisResult, BM, exigSusp, tpImunidade, pAliq, tpRetISSQN
 *   1.01  tribISSQN, cPaisResult, tpImunidade, exigSusp, BM, tpRetISSQN, pAliq
 *
 * O gateway emitia na ordem do 1.01 mandando versao="1.00". Ninguém percebeu
 * porque a validação só rodava contra o 1.01, e porque o erro só aparece fora
 * do Simples Nacional — o único caso em que pAliq é enviado.
 *
 * Depende do xmllint (libxml2). Sem ele os casos são pulados com aviso em vez
 * de falharem: não faz sentido quebrar o `npm test` de quem mexeu no painel.
 */

const SCHEMAS = path.join(__dirname, '..', 'schemas');

/* Dois validadores possíveis, porque nenhum está em toda máquina: xmllint vem
   com o libxml2 (Linux e macOS), lxml vem com o Python (comum no Windows).
   Qualquer um serve; sem nenhum, os casos são pulados. */
function detectarValidador() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return 'xmllint';
  } catch (_) { /* tenta o outro */ }
  for (const python of ['python', 'python3']) {
    try {
      execFileSync(python, ['-c', 'import lxml.etree'], { stdio: 'ignore' });
      return python;
    } catch (_) { /* segue */ }
  }
  return null;
}
const VALIDADOR = detectarValidador();

const EMPRESA = {
  cnpj: '21583854000118', inscricao_municipal: '1102709463',
  codigo_municipio: '4106902', uf: 'PR', op_simp_nac: 1, reg_esp_trib: 0,
  email: 'financeiro@exemplo.com.br', telefone: '4133334444'
};

const BASE = {
  tomador: { cnpj: '14073521000183', razaoSocial: 'CLIENTE LTDA' },
  servico: { codigoTributacaoNacional: '110201', descricao: 'Servico prestado',
             codigoNbs: '123456789', codigoMunicipioPrestacao: '4106902' },
  valores: { valorServico: 1000 }
};

/* Id da DPS tem forma fixa (DPS + 42 dígitos); um id de brinquedo faz o
   esquema reclamar do id, escondendo o que se quer testar. */
const ID_VALIDO = 'DPS' + '4106902'.padStart(7, '0') + '2' +
                  '21583854000118' + '00001'.padStart(5, '0') +
                  '1'.padStart(15, '0');

function gerar(extra, versao) {
  const dados = Object.assign({}, BASE, extra, {
    valores: Object.assign({}, BASE.valores, extra.valores || {}),
    servico: Object.assign({}, BASE.servico, extra.servico || {})
  });
  const empresa = Object.assign({}, EMPRESA, extra.__empresa || {});
  const anterior = process.env.DPS_VERSAO;
  process.env.DPS_VERSAO = versao;
  try {
    return montarDps(empresa, dados, {
      tpAmb: '1', verAplic: 'teste/1.0', idDps: ID_VALIDO, serie: '1', numero: 1
    });
  } finally {
    if (anterior === undefined) delete process.env.DPS_VERSAO;
    else process.env.DPS_VERSAO = anterior;
  }
}

/* Dois defeitos do XSD publicado atrapalham qualquer validador de XML Schema
   1.0, e a cópia usada aqui os contorna:

   1. patterns com lookahead (?!...), que o XML Schema 1.0 não tem;
   2. patterns escritos com âncoras ^ e $ — em XML Schema o pattern já é
      ancorado, então ^ e $ valem como caracteres literais. O 1.01 traz
      value="^0{0,4}\d{1,5}$" na série, o que exigiria a série "^1$".

   Nenhum dos dois é problema do nosso XML: são erros do esquema. A conferência
   de formato desses campos é feita nos testes de leiaute. */
function esquemaValidavel(versao) {
  const destino = path.join(os.tmpdir(), `nfse-schemas-${versao}`);
  if (!fs.existsSync(destino)) {
    fs.mkdirSync(destino, { recursive: true });
    for (const nome of fs.readdirSync(path.join(SCHEMAS, versao))) {
      const conteudo = fs.readFileSync(path.join(SCHEMAS, versao, nome), 'utf8')
        .replace(/value="[^"]*\(\?![^"]*"/g, 'value=".*"')
        .replace(/(<xs:pattern value=")\^([^"]*)\$(")/g, '$1$2$3');
      fs.writeFileSync(path.join(destino, nome), conteudo, 'utf8');
    }
  }
  return path.join(destino, `DPS_v${versao}.xsd`);
}

function validar(xml, versao) {
  const arquivo = path.join(os.tmpdir(), `dps-${versao}-${process.pid}-${Date.now()}.xml`);
  fs.writeFileSync(arquivo, xml, 'utf8');
  const xsd = esquemaValidavel(versao);
  try {
    if (VALIDADOR === 'xmllint') {
      execFileSync('xmllint', ['--noout', '--schema', xsd, arquivo],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      return null;
    }
    const saida = execFileSync(VALIDADOR, ['-c',
      'import sys;from lxml import etree;' +
      'e=etree.XMLSchema(etree.parse(sys.argv[1]));d=etree.parse(sys.argv[2]);' +
      'print("" if e.validate(d) else " | ".join(x.message for x in e.error_log))',
      xsd, arquivo], { encoding: 'utf8' }).trim();
    return saida || null;
  } catch (e) {
    return String(e.stderr || e.stdout || e.message).slice(0, 300);
  } finally {
    fs.unlinkSync(arquivo);
  }
}

/* Casos que exercitam os elementos cuja ordem difere entre as versões. */
const CASOS = {
  'básica': {},
  'fora do Simples, com alíquota': { valores: { aliquotaIss: 5 } },
  'optante do Simples': { __empresa: { op_simp_nac: 3 },
                          valores: { percentualTotalTributosSN: 6 } },
  'benefício municipal': { valores: { aliquotaIss: 5,
    beneficioMunicipal: { tipo: 2, numero: '12345678901234', percentualReducao: 50 } } },
  'imunidade': { valores: { tributacaoIssqn: 2, tipoImunidade: 1 } },
  'exportação': { valores: { tributacaoIssqn: 3, paisResultado: 'US' } },
  'não incidência': { valores: { tributacaoIssqn: 4 } },
  'exigibilidade suspensa': { valores: { aliquotaIss: 5,
    exigibilidadeSuspensa: { tipo: 1, numeroProcesso: '000123456202681600010000000000' } } },
  'tudo junto': { valores: { aliquotaIss: 5, issRetido: true,
    descontoIncondicionado: 50, valorDeducoes: 100,
    beneficioMunicipal: { tipo: 2, numero: '12345678901234', percentualReducao: 10 },
    exigibilidadeSuspensa: { tipo: 2, numeroProcesso: '000123456202681600010000000000' },
    retencoesFederais: { baseCalculo: 1000, valorPis: 6.5, valorCofins: 30 } } }
};

for (const versao of ['1.00', '1.01']) {
  for (const [nome, extra] of Object.entries(CASOS)) {
    test(`esquema ${versao}: ${nome}`, { skip: !VALIDADOR && 'sem xmllint nem python+lxml' }, () => {
      const erro = validar(gerar(extra, versao), versao);
      assert.equal(erro, null, `documento inválido no esquema ${versao}: ${erro}`);
    });
  }
}

/* A ordem é conferida diretamente, para o defeito ter um teste que o nomeia
   mesmo em máquina sem xmllint. */
test('1.00 põe pAliq antes de tpRetISSQN', () => {
  const x = gerar({ valores: { aliquotaIss: 5 } }, '1.00');
  const tribMun = x.match(/<tribMun>.*?<\/tribMun>/)[0];
  assert.ok(tribMun.indexOf('<pAliq>') < tribMun.indexOf('<tpRetISSQN>'),
    'no esquema 1.00 a alíquota vem antes da retenção: ' + tribMun);
});

test('1.01 põe pAliq depois de tpRetISSQN', () => {
  const x = gerar({ valores: { aliquotaIss: 5 } }, '1.01');
  const tribMun = x.match(/<tribMun>.*?<\/tribMun>/)[0];
  assert.ok(tribMun.indexOf('<pAliq>') > tribMun.indexOf('<tpRetISSQN>'),
    'no esquema 1.01 a alíquota vem depois da retenção: ' + tribMun);
});

test('1.00 e 1.01 ordenam o benefício municipal em posições diferentes', () => {
  const dados = { valores: { aliquotaIss: 5,
    beneficioMunicipal: { tipo: 2, numero: '12345678901234', percentualReducao: 50 } } };
  const v100 = gerar(dados, '1.00').match(/<tribMun>.*?<\/tribMun>/)[0];
  const v101 = gerar(dados, '1.01').match(/<tribMun>.*?<\/tribMun>/)[0];
  assert.ok(v100.indexOf('<BM>') < v100.indexOf('<tpRetISSQN>'));
  assert.ok(v101.indexOf('<BM>') < v101.indexOf('<tpRetISSQN>'));
  assert.notEqual(v100, v101, 'as duas versões não produzem o mesmo bloco');
});
