const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const termo = require('../wa/termo');

/* O WhatsApp por sessão própria — o segundo transporte.
 *
 * Ele existe porque ligar o WhatsApp pela Meta exige conta Business,
 * verificação da empresa, um número que sai do aplicativo e um endereço
 * público em HTTPS. Por sessão própria são dois minutos e um QR code.
 *
 * O que isso custa: é automação NÃO OFICIAL, o número pode ser banido, e quem
 * fornece o gateway não tem contrato nem canal com a Meta. Estes testes
 * existem para garantir que essa escolha seja informada, registrada, e que o
 * pior caso dela não alcance a emissão de nota fiscal.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8').replace(/\r\n/g, '\n');

const MOTOR = ler('wa', 'motor.js');
const SERVIDOR_WA = ler('wa', 'servidor.js');
const TRANSPORTE = ler('relay', 'transporte.js');
const SERVICO = ler('src', 'services', 'whatsappLocal.js');

/* ------------------------------------------------------------- o termo */

test('o termo diz as três coisas que importam', () => {
  /* Um termo que não diz isto não protege ninguém — protege menos ainda quem
     o escreveu, porque "estava no contrato" não sobrevive a um texto feito
     para não ser lido. */
  assert.match(termo.TEXTO, /não é a API oficial/i);
  assert.match(termo.TEXTO, /pode ser banido|banir o número/i);
  assert.match(termo.TEXTO, /não nos responsabilizamos/i);
  /* E a contrapartida, que é o que faz a escolha ser aceitável: */
  assert.match(termo.TEXTO, /emissão de notas fiscais NÃO depende/i);
});

test('o termo é versionado e o texto antigo nunca some', () => {
  /* "O cliente aceitou" só vale como resposta se for possível mostrar O QUE
     ele aceitou, dois anos depois, quando a conversa for outra. */
  assert.ok(termo.VERSAO);
  assert.equal(termo.texto(termo.VERSAO), termo.TEXTO);
  assert.ok(Object.keys(termo.HISTORICO).includes(termo.VERSAO));
  assert.equal(termo.texto('versao-que-nao-existe'), null);
});

test('o resumo cabe antes do texto inteiro', () => {
  /* Quem não ler nada precisa ao menos ter visto isto. */
  assert.ok(termo.RESUMO.length >= 3);
  assert.ok(termo.RESUMO.some(r => /banido/i.test(r)));
  assert.ok(termo.RESUMO.some(r => /não depende|continua funcionando/i.test(r)));
});

/* ---------------------------------------------------- sem aceite não liga */

test('a trava do aceite existe nos DOIS lados', () => {
  /* Uma trava que vive só no navegador não é trava: basta chamar a rota. */
  assert.match(SERVIDOR_WA, /b\.termoVersao !== termo\.VERSAO/,
    'o módulo precisa recusar ligar sem a versão aceita');
  assert.match(SERVIDOR_WA, /412/, 'e recusar com um código próprio, não 500');

  assert.match(SERVICO, /termo_aceito_em/,
    'e o gateway precisa recusar ativar sem aceite registrado');
  assert.match(SERVICO, /status: 412/);
});

test('quem aceitou fica gravado pelo nome, não só pelo id', () => {
  /* Se o usuário for removido depois, a prova de quem aceitou não pode sumir
     com ele. */
  assert.match(SERVICO, /termo_aceito_nome/);
  const sql = ler('migrations', '042_whatsapp_local.sql');
  assert.match(sql, /termo_aceito_nome/);
  assert.match(sql, /ON DELETE SET NULL/,
    'apagar o usuário não pode apagar o registro do aceite');
});

/* ------------------------------------------- o pior caso não alcança a nota */

test('nada no módulo emite, assina ou fala com a Sefin', () => {
  /* O módulo é transporte. Se ele soubesse assinar, uma queda dele viraria uma
     queda do sistema fiscal. */
  const proibido = /assinarXml|reservarNumeracao|certificado|sefin|emitir\(/i;
  for (const [nome, fonte] of [['motor.js', MOTOR], ['servidor.js', SERVIDOR_WA]]) {
    const semComentarios = fonte
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!proibido.test(semComentarios),
      nome + ' toca em emissão ou assinatura — ele é só transporte');
  }
});

test('a saída do repassador não sabe por onde vai', () => {
  /* É isto que torna o segundo transporte barato: não há uma segunda
     implementação da conversa, da fila nem da memória. */
  const servidorRelay = ler('relay', 'servidor.js');
  const i = servidorRelay.indexOf('async function responderAoCliente');
  assert.ok(i > 0);
  const corpo = servidorRelay.slice(i, servidorRelay.indexOf('\n}', i));
  assert.match(corpo, /transporte\.responder/,
    'responderAoCliente precisa delegar ao adaptador');
  assert.ok(!/meta\.enviarTexto/.test(corpo),
    'a Meta não pode mais estar soldada aqui');
});

test('um transporte de cada vez', () => {
  /* Dois escrevendo na mesma conversa dariam resposta dobrada ao cliente — e
     ele não faz ideia de que existem dois caminhos. */
  const sql = ler('migrations', '042_whatsapp_local.sql');
  assert.match(sql, /CHECK \(wa_transporte IN \('meta', 'local'\)\)/);
  assert.match(SERVICO, /wa_transporte = \$1/,
    'ligar o local precisa desligar a Meta no mesmo ato');
});

/* -------------------------------------------------- não virar tempestade */

test('reconectar tem espera crescente e teto', () => {
  /* Queda de rede é comum; tentar de novo em laço apertado é o caminho mais
     curto para o WhatsApp achar que isto é um robô abusivo e banir o número. */
  const { ESPERA_INICIAL_MS, ESPERA_MAXIMA_MS } = require('../wa/motor');
  assert.ok(ESPERA_INICIAL_MS >= 1000, 'esperar menos de um segundo é insistir');
  assert.ok(ESPERA_MAXIMA_MS >= 60000, 'sem teto alto, a espera nunca desacelera');
  assert.match(MOTOR, /Math\.min\(/, 'o teto precisa ser aplicado');
  assert.match(MOTOR, /Math\.pow\(2/, 'e a espera precisa crescer');
});

test('banido e caiu são tratados ao contrário', () => {
  /* Cair se resolve sozinho; banimento não se resolve nunca, e insistir
     piora. São códigos diferentes e comportamentos opostos. */
  assert.match(MOTOR, /DisconnectReason\.loggedOut/);
  const i = MOTOR.indexOf('DisconnectReason.loggedOut');
  const bloco = MOTOR.slice(i, i + 900);
  assert.match(bloco, /apagarSessao/, 'sessão recusada é apagada, não reusada');
  assert.match(bloco, /return;/, 'e NÃO se agenda reconexão');
});

test('grupo não vira conversa', () => {
  /* Responder dentro de um grupo exporia a conversa do escritório a todo
     mundo que estiver nele. */
  assert.match(MOTOR, /@g\.us/);
  const i = MOTOR.indexOf('@g.us');
  assert.match(MOTOR.slice(i, i + 120), /return null/);
});

test('mensagem própria e histórico não disparam resposta', () => {
  /* `append` é o histórico sendo sincronizado: reagir a ele responderia de
     novo a conversas antigas toda vez que a sessão reconectasse. */
  assert.match(MOTOR, /fromMe/);
  /* O filtro de `notify` mora no motor, junto do `messages.upsert` que o
     dispara — não no servidor, que só transporta o resultado. */
  assert.match(MOTOR, /m\.type !== 'notify'/);
});

/* --------------------------------------------------------- o isolamento */

test('o módulo atende só em 127.0.0.1 e exige token', () => {
  /* Quem alcança esta porta manda mensagem em nome do escritório. */
  assert.match(SERVIDOR_WA, /servidor\.listen\(PORTA, '127\.0\.0\.1'/);
  assert.match(SERVIDOR_WA, /x-wa-token/);
  assert.match(SERVIDOR_WA, /token novo|randomBytes/i);
  /* E o token some quando o processo sai: token que sobrevive ao processo é
     token que alguém encontra depois. */
  assert.match(SERVIDOR_WA, /process\.on\('exit', limparToken\)/);
});

test('a sessão fica fora do controle de versão', () => {
  /* Os arquivos da sessão SÃO o WhatsApp do escritório: quem os tiver, manda
     mensagem como ele. */
  const ignore = ler('.gitignore');
  assert.match(ignore, /wa\/sessao|wa\/node_modules/,
    'a pasta da sessão e as dependências do módulo precisam estar no .gitignore');
});

test('as dependências do módulo não vão no instalador', () => {
  /* São 113 MB, e só quem escolhe usar sessão própria precisa delas. Quem usa
     a API oficial, ou não usa WhatsApp, não carrega esse peso. */
  const bat = ler('WhatsApp.bat');
  assert.match(bat, /npm install/, 'o .bat baixa na primeira vez');
  assert.match(bat, /113 MB|MB/, 'e avisa o tamanho antes');
  const preparar = ler('instalador', 'preparar-pacote.ps1');
  assert.ok(!/'wa\/node_modules'|wa\\node_modules/.test(preparar) ||
            /wa\\node_modules/.test(preparar),
    'se wa/ entrar no pacote, node_modules precisa ficar de fora');
});
