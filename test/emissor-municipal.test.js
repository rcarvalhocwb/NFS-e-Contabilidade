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
  /* O endereço e o protocolo vieram de documentação, e o formato do que vai
     dentro do envelope ainda é palpite. Deixar emitir seria apostar a
     numeração fiscal nisso.

     Esta mensagem fala do PROTOCOLO, e não do credenciamento: são coisas
     diferentes, e misturá-las foi o erro da primeira versão. O credenciamento
     é da empresa, e tem mensagem própria. */
  const i = conferirPodeEmitir(BETHA);
  assert.ok(i, 'precisa impedir enquanto ninguém confirmou');
  assert.match(i, /buraco na numera/);
  assert.match(i, /a conversa com ele funciona/);
  assert.ok(!/POR EMPRESA/.test(i), 'a trava do município não fala de credenciamento');
});

test('confirmado, emite — e continua indo pelo provedor', () => {
  /* Sem exigência de credenciamento por empresa, confirmar o protocolo basta. */
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
  /* A empresa entrou na escolha quando a CGSN 189/2026 passou a mandar o
     optante do Simples pela Sefin, mesmo em município com provedor próprio. */
  assert.match(fila, /emissorMunicipal'\)\.transporte\(mun, empresa\)/);
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

/* ------------------------------------ credenciamento: do sistema ou da empresa? */

/* A pergunta foi feita e corrigiu o desenho. Na primeira versão a confirmação
   ficou toda no MUNICÍPIO, como se credenciar fosse uma coisa só, feita uma
   vez. Não é: em Fazenda Rio Grande cada prestador pede autorização à
   Secretaria de Finanças, que responde por e-mail. Dez clientes do escritório
   ali são dez credenciamentos. */

const BETHA_OK = Object.assign({}, BETHA, {
  emissor_confirmado: true, exige_credenciamento: true,
  url_ws: 'https://nota-eletronica.betha.cloud/dps/ws'
});
const CREDENCIADA = { razao_social: 'CLIENTE A LTDA', emissor_credenciado: true };
const SEM_CREDENCIAL = { razao_social: 'CLIENTE B LTDA', emissor_credenciado: false };

test('são duas perguntas, e as duas precisam ser sim', () => {
  const protocoloNaoConferido = Object.assign({}, BETHA_OK, { emissor_confirmado: false });
  assert.ok(conferirPodeEmitir(protocoloNaoConferido, CREDENCIADA),
    'empresa credenciada não basta se o gateway não sabe falar com o provedor');
  assert.ok(conferirPodeEmitir(BETHA_OK, SEM_CREDENCIAL),
    'protocolo conferido não basta se a empresa não tem autorização');
  assert.strictEqual(conferirPodeEmitir(BETHA_OK, CREDENCIADA), null);
});

test('confirmar por causa de um cliente não libera os outros', () => {
  /* É o cenário que motivou a correção. Com a trava só no município, os outros
     nove passariam a tentar emitir sem autorização — cada tentativa reservando
     número e falhando. */
  const clientes = Array.from({ length: 10 }, (_, n) => ({
    razao_social: 'CLIENTE ' + (n + 1), emissor_credenciado: n === 0
  }));
  const liberados = clientes.filter(c => conferirPodeEmitir(BETHA_OK, c) === null);
  assert.strictEqual(liberados.length, 1);
  assert.strictEqual(liberados[0].razao_social, 'CLIENTE 1');
});

test('a mensagem diz que o credenciamento é por empresa', () => {
  /* "Não credenciado" faria a pessoa procurar uma configuração do sistema. */
  const i = conferirPodeEmitir(BETHA_OK, SEM_CREDENCIAL);
  assert.match(i, /POR EMPRESA/);
  assert.match(i, /CLIENTE B LTDA/);
  assert.match(i, /Secretaria de Finanças/);
});

test('onde o provedor não exige credenciamento, a trava por empresa não aparece', () => {
  const semExigencia = Object.assign({}, BETHA_OK, { exige_credenciamento: false });
  assert.strictEqual(conferirPodeEmitir(semExigencia, SEM_CREDENCIAL), null);
});

test('o endereço e o protocolo são os da documentação do próprio Betha', () => {
  /* A primeira versão usou /v2/nfsen por POST de XML puro, de documentação de
     terceiros. O WSDL do Betha diz outra coisa: /dps/ws, SOAP, operação
     RecepcionarDps. */
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  /* O namespace é o do XSD (e-nota-dps), NÃO o do WSDL (e-nota-dps-service).
     Com o do WSDL o serviço devolve 404; com o do XSD, responde. Conferido
     enviando, em 03/09/2026. */
  assert.match(s, /NS_BETHA = 'http:\/\/www\.betha\.com\.br\/e-nota-dps'/);
  assert.match(s, /RecepcionarDpsEnvio/);
  assert.match(s, /soapAction: 'RecepcionarDps'/);
  assert.match(s, /SOAPAction: soapAction/);
  /* Sem os comentários: o texto que registra o caminho errado o menciona, e
     conferir o arquivo cru acusaria a própria explicação. */
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/v2\/nfsen/.test(codigo), 'o caminho de terceiros não pode voltar');
  /* A DPS vai inline. O gzip+base64 que eu supus, copiando a Sefin, era falso. */
  assert.ok(!/gzipSync/.test(codigo), 'a DPS não vai compactada para o Betha');

  const sql = fonte('migrations', '038_credenciamento_empresa.sql');
  assert.match(sql, /nota-eletronica\.betha\.cloud\/dps\/ws/);
});

test('a DPS é montada no formato do destino, antes de assinar', () => {
  /* A assinatura cobre o infDPS: trocar o namespace ou a caixa do atributo id
     depois de assinar quebraria a assinatura. O Betha quer o namespace dele e
     `id` minúsculo — as duas coisas descobertas enviando, não lendo. */
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  assert.match(s, /namespaceDps: NS_BETHA/);
  assert.match(s, /atributoId: 'id'/);
  assert.match(s, /namespaceDps: 'http:\/\/www\.sped\.fazenda\.gov\.br\/nfse'/);

  const emissao = fonte('src', 'services', 'emissaoService.js');
  const monta = emissao.indexOf('montarDps(');
  const assina = emissao.indexOf('assinarXml(');
  assert.ok(monta > 0 && assina > monta, 'monta antes de assinar');
  assert.match(emissao, /namespace: destino\.namespaceDps, atributoId: destino\.atributoId/);
});

test('a caixa do atributo id é parametrizada, e o padrão continua o nacional', () => {
  const b = fonte('src', 'nfse', 'dpsBuilder.js');
  assert.match(b, /opts\.atributoId \|\| 'Id'/);
  assert.match(b, /opts\.namespace \|\| 'http:\/\/www\.sped\.fazenda\.gov\.br\/nfse'/);
});

/* ------------------------------------------------------------- Fiorilli */

/* Conferido contra o serviço real (Assis/SP) em 03/09/2026. A diferença que
   importa em relação ao Betha: o Fiorilli aceita a DPS NO NAMESPACE NACIONAL,
   sem alterar nada. Enviando uma sem assinatura, respondeu "E172: Arquivo
   enviado com erro na assinatura" — toda a estrutura passou. */

const FIORILLI_MUN = {
  codigo_municipio: '3504206', nome: 'Assis', modo_emissao: 'proprio',
  provedor: 'fiorilli', exige_credenciamento: true,
  url_ws: 'https://nfsews.assis.sp.gov.br/IssWeb-ejb/IssWebWSNacional/IssWebWSNacionalPortType',
  emissor_confirmado: true
};

test('Fiorilli usa a DPS nacional sem alterar nada', () => {
  /* É o que o torna barato: a mesma DPS que vai para a Sefin vai para lá.
     O Betha exige o namespace dele e `id` minúsculo; o Fiorilli, não. */
  const t = transporte(FIORILLI_MUN);
  assert.strictEqual(t.nome, 'Fiorilli IssWeb');
  assert.strictEqual(t.namespaceDps, 'http://www.sped.fazenda.gov.br/nfse');
  assert.strictEqual(t.atributoId, 'Id');
});

test('o envelope do Fiorilli é o dele, a DPS é a nacional', () => {
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  assert.match(s, /NS_FIORILLI = 'http:\/\/www\.fiorilli\.com\.br\/nfse-nacional'/);
  assert.match(s, /RecepcionarDpsEnvio xmlns=" \+ NS_FIORILLI|NS_FIORILLI \+ '">/);
  /* A caixa do soapAction difere da operação, e está assim no WSDL. */
  assert.match(s, /soapAction: 'recepcionarDPS'/);
});

test('o endereço do Fiorilli é por município', () => {
  /* Cada prefeitura tem o seu host. Uma constante única emitiria tudo para a
     cidade errada. */
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  const i = s.indexOf('const FIORILLI');
  const corpo = s.slice(i, s.indexOf('\n};', i));
  assert.match(corpo, /municipio\.url_ws/);
  assert.match(corpo, /Cada.*prefeitura tem o seu/s);

  const sem = Object.assign({}, FIORILLI_MUN, { url_ws: null });
  assert.rejects(() => transporte(sem).enviarDps(sem, 'producao', '<x/>', {}),
    /sem endereço de webservice/);
});

test('o ABRASF antigo do Fiorilli não é usado', () => {
  /* O próprio Fiorilli documenta que emissões em ABRASF deixaram de ser
     aceitas em 01/08/2026. Integrar o legado seria construir um segundo
     construtor de documento para algo que já saiu de uso. */
  const s = fonte('src', 'nfse', 'emissorMunicipal.js');
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/IssWebWS\/IssWebWS|abrasf/i.test(codigo));
});

test('os três provedores convivem, e a Sefin continua o padrão', () => {
  assert.strictEqual(transporte({ provedor: 'fiorilli' }).nome, 'Fiorilli IssWeb');
  assert.strictEqual(transporte({ provedor: 'betha' }).nome, 'Betha e-Nota');
  assert.strictEqual(transporte({ provedor: 'sefin' }).nome, 'Sefin Nacional');
  /* Provedor desconhecido não pode virar erro no meio de uma emissão. */
  assert.strictEqual(transporte({ provedor: 'inexistente' }).nome, 'Sefin Nacional');
});

test('a trava vale para o Fiorilli também', () => {
  const naoConfirmado = Object.assign({}, FIORILLI_MUN, { emissor_confirmado: false });
  assert.ok(conferirPodeEmitir(naoConfirmado, { emissor_credenciado: true }));
  assert.ok(conferirPodeEmitir(FIORILLI_MUN, { razao_social: 'X', emissor_credenciado: false }));
  assert.strictEqual(conferirPodeEmitir(FIORILLI_MUN, { emissor_credenciado: true }), null);
});

/* ------------------------------ o regime vence o município (CGSN 189/2026) */

/* Em vigor desde 01/09/2026: optantes do Simples Nacional emitem
   EXCLUSIVAMENTE pelo Emissor Nacional, mesmo em municípios com sistema
   próprio. Continuam no municipal: Lucro Real, Lucro Presumido, órgãos
   públicos, e emissões feitas pelo tomador ou intermediário.

   Sem isto, um cliente do Simples em Fazenda Rio Grande sairia pelo Betha —
   emitindo fora da regra, e em silêncio. */

const SIMPLES = { razao_social: 'CLIENTE SIMPLES', op_simp_nac: 3,
                  emissor_credenciado: false };
const PRESUMIDO = { razao_social: 'CLIENTE PRESUMIDO', op_simp_nac: 1,
                    emissor_credenciado: true };

test('optante do Simples vai pela Sefin, mesmo com provedor municipal', () => {
  assert.strictEqual(transporte(BETHA_OK, SIMPLES).nome, 'Sefin Nacional');
  assert.strictEqual(transporte(FIORILLI_MUN, SIMPLES).nome, 'Sefin Nacional');
});

test('fora do Simples continua indo pelo provedor do município', () => {
  assert.strictEqual(transporte(BETHA_OK, PRESUMIDO).nome, 'Betha e-Nota');
  assert.strictEqual(transporte(FIORILLI_MUN, PRESUMIDO).nome, 'Fiorilli IssWeb');
});

test('op_simp_nac 2 e 3 são os dois optantes', () => {
  assert.strictEqual(transporte(BETHA_OK, { op_simp_nac: 2 }).nome, 'Sefin Nacional');
  assert.strictEqual(transporte(BETHA_OK, { op_simp_nac: 3 }).nome, 'Sefin Nacional');
  assert.strictEqual(transporte(BETHA_OK, { op_simp_nac: 1 }).nome, 'Betha e-Nota');
});

test('as travas do provedor não bloqueiam quem nem passa por ele', () => {
  /* O optante do Simples vai pela Sefin: exigir credenciamento municipal ou
     confirmação de protocolo dele seria travar uma emissão que não usa nada
     disso. */
  const naoConfirmado = Object.assign({}, BETHA_OK, { emissor_confirmado: false });
  assert.strictEqual(conferirPodeEmitir(naoConfirmado, SIMPLES), null);
  assert.strictEqual(conferirPodeEmitir(BETHA_OK, SIMPLES), null);
  /* E continuam valendo para quem de fato passa pelo provedor. */
  assert.ok(conferirPodeEmitir(naoConfirmado, PRESUMIDO));
});

test('sem empresa informada, o município decide — como antes', () => {
  /* Nenhum caminho antigo muda de comportamento por causa desta regra. */
  assert.strictEqual(transporte(BETHA_OK).nome, 'Betha e-Nota');
  assert.strictEqual(transporte(NACIONAL).nome, 'Sefin Nacional');
});

test('a decisão do destino recebe a empresa nos dois pontos', () => {
  /* Montar a DPS e transmiti-la são momentos diferentes; se só um souber do
     regime, a DPS sairia num formato e iria para outro destino. */
  const emissao = fonte('src', 'services', 'emissaoService.js');
  assert.match(emissao, /transporte\(mun, empresa\)/);
  const fila = fonte('src', 'services', 'filaEmissao.js');
  assert.match(fila, /transporte\(mun, empresa\)/);
});
