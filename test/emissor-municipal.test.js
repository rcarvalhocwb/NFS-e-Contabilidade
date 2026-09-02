const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { transporte, conferirPodeEmitir } = require('../src/nfse/emissorMunicipal');

/* Para onde a DPS assinada é transmitida, por município.
 *
 * Antes havia um destino só. Fazenda Rio Grande mudou o quadro: manteve o
 * Betha e-Nota mas o adaptou ao PADRÃO NACIONAL — a mesma DPS que este gateway
 * monta e assina, entregue noutro endereço. Não é outro documento, é outro
 * carteiro.
 *
 * O que estes testes protegem é a trava, e ela existe por um motivo concreto:
 * um endereço de webservice não testado é palpite, e palpite errado reserva
 * número, assina a DPS e falha — deixando buraco na sequência fiscal. Este
 * projeto já assumiu dois endpoints da Sefin que não existiam.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const NACIONAL = { codigo_municipio: '4125506', nome: 'São José dos Pinhais',
                   modo_emissao: 'nacional', provedor: 'sefin' };
const BETHA = { codigo_municipio: '4107652', nome: 'Fazenda Rio Grande',
                modo_emissao: 'proprio', provedor: 'betha',
                url_ws: 'https://nota-eletronica.betha.cloud/',
                emissor: 'Betha e-Nota', url_portal: 'https://www.frg.pr.gov.br',
                emissor_confirmado: false };
const PROPRIO_SEM_PROVEDOR = { codigo_municipio: '9999999', nome: 'Cidade Exemplo',
                               modo_emissao: 'proprio', provedor: 'sefin',
                               emissor: 'Sistema da Prefeitura',
                               url_portal: 'https://exemplo.gov.br' };

/* -------------------------------------------------------- para onde vai */

test('município no Sistema Nacional segue pela Sefin', () => {
  assert.strictEqual(transporte(NACIONAL).nome, 'Sefin Nacional');
  assert.strictEqual(conferirPodeEmitir(NACIONAL), null);
});

test('município sem cadastro segue pela Sefin, como sempre foi', () => {
  /* A maioria dos municípios nunca vai estar nesta tabela. O padrão não pode
     ser bloquear. */
  assert.strictEqual(transporte(null).nome, 'Sefin Nacional');
  assert.strictEqual(conferirPodeEmitir(null), null);
  assert.strictEqual(transporte({}).nome, 'Sefin Nacional');
});

test('município com provedor próprio segue pelo provedor', () => {
  assert.strictEqual(transporte(BETHA).nome, 'Betha e-Nota');
});

/* ------------------------------------------------------------- a trava */

test('provedor próprio nasce bloqueado', () => {
  /* O endereço veio de documentação de terceiros e não foi testado daqui com
     certificado. Deixar emitir seria apostar a numeração fiscal nisso. */
  const i = conferirPodeEmitir(BETHA);
  assert.ok(i, 'precisa impedir enquanto ninguém confirmou');
  assert.match(i, /buraco na numera/);
  assert.match(i, /credenciamento/);
});

test('confirmado, emite — e continua indo pelo provedor', () => {
  const confirmado = Object.assign({}, BETHA, { emissor_confirmado: true });
  assert.strictEqual(conferirPodeEmitir(confirmado), null);
  assert.strictEqual(transporte(confirmado).nome, 'Betha e-Nota');
});

test('emissor próprio SEM provedor implementado continua bloqueado', () => {
  /* Nada foi afrouxado: o que não sabemos falar continua recusado, com o nome
     do lugar e para onde ir. Deixar a pessoa com a nota na mão e sem saída é
     pior do que não emitir. */
  const i = conferirPodeEmitir(PROPRIO_SEM_PROVEDOR);
  assert.ok(i);
  assert.match(i, /Cidade Exemplo/);
  assert.match(i, /exemplo\.gov\.br/);
  assert.match(i, /mantém emissor próprio/);
});

test('a conferência acontece ANTES de reservar número', () => {
  /* Recusar depois da reserva deixaria buraco na sequência fiscal — o mesmo
     tipo de dano que a trava existe para evitar. */
  const s = fonte('src', 'services', 'emissaoService.js');
  const guarda = s.indexOf('conferirPodeEmitir');
  const reserva = s.indexOf('reservarNumeracao(empresa.id');
  assert.ok(guarda > 0 && reserva > 0);
  assert.ok(guarda < reserva, 'a conferência vem antes da reserva');
});

/* ------------------------------------------------- o que NÃO foi mexido */

test('o provedor municipal recebe a MESMA DPS', () => {
  /* O Betha de Fazenda Rio Grande aceita o layout nacional. Se um dia aparecer
     um município com ABRASF de verdade, ele não entra aqui — entra num
     construtor próprio, e essa é uma obra maior. */
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  assert.ok(!/montarDps|dpsBuilder|assinarXml/.test(s),
    'este módulo não monta nem assina: só escolhe o destino');
  assert.match(s, /não monta DPS diferente/);
});

test('o transporte é escolhido na hora de transmitir, não na de montar', () => {
  const fila = fonte('src', 'services', 'filaEmissao.js');
  assert.match(fila, /emissorMunicipal'\)\.transporte\(mun\)/);
  assert.match(fila, /transporte\.enviarDps\(/);
});

/* --------------------------------------------------------- os municípios */

test('São José dos Pinhais entra como nacional', () => {
  /* Desligou o ISSonline municipal e migrou; obrigatório desde 01/01/2026.
     Não há integração a fazer: o gateway já emite lá. */
  const sql = fonte('migrations', '037_emissor_municipal.sql');
  assert.match(sql, /'4125506', 'São José dos Pinhais'/);
  assert.match(sql, /'nacional', 'sefin'/);
});

test('Fazenda Rio Grande entra como Betha, e não confirmada', () => {
  const sql = fonte('migrations', '037_emissor_municipal.sql');
  assert.match(sql, /provedor = 'betha'/);
  assert.match(sql, /nota-eletronica\.betha\.cloud/);
  assert.match(sql, /emissor_confirmado BOOLEAN NOT NULL DEFAULT FALSE/);
  /* O UPDATE não pode ligar a confirmação por engano. */
  const i = sql.indexOf("WHERE codigo_municipio = '4107652'");
  const bloco = sql.slice(sql.lastIndexOf('UPDATE municipios', i), i);
  assert.ok(!/emissor_confirmado\s*=\s*TRUE/.test(bloco));
});

test('quem confirma fica registrado', () => {
  /* Alguém está assumindo que o credenciamento foi feito. Se a primeira nota
     falhar, é preciso saber a quem perguntar. */
  const rota = fonte('src', 'routes', 'municipios.js');
  assert.match(rota, /emissor_confirmado_por/);
  assert.match(rota, /auditoria'\)\.registrar/);
});
