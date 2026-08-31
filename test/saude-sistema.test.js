const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O sistema por baixo, dentro do sistema.
 *
 * Isto morava num script de PowerShell. Funcionava para quem escreve comandos e
 * não para quem opera a contabilidade — que é justamente quem vai olhar às oito
 * da manhã, quando um cliente disser que mandou mensagem e ninguém respondeu.
 *
 * O que estes testes protegem é a parte que é fácil de estragar sem perceber:
 * a tela dizer o contrário da verdade, e o operador comum voltar a depender de
 * digitar comando.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVICO = fonte('src', 'services', 'saudeSistema.js');

/* --------------------------------------------- não mentir sobre o estado */

test('"acesso negado" não é lido como "não existe"', () => {
  /* A tarefa roda como SYSTEM: um gateway aberto pelo atalho não consegue
     consultá-la. Tratar isso como ausência faria a tela dizer que o gateway
     não sobe sozinho justamente quando ele sobe — e dizer o contrário da
     verdade é pior do que não conferir. */
  assert.match(SERVICO, /negado\|denied/);
  assert.match(SERVICO, /estado: 'sem_permissao'/);
});

test('o serviço do banco tem estado próprio', () => {
  /* Foi o defeito que quase passou: a tarefa subia o gateway e o banco não
     estava lá. Sem uma linha só para ele, isso volta a ser invisível. */
  assert.match(SERVICO, /NOME_SERVICO_BANCO = 'nfse-postgres'/);
  assert.match(SERVICO, /1060\|does not exist/);
});

test('a tela sabe se pode agir ou se precisa do arquivo', () => {
  /* Uma página web não dispara o UAC. Fingir que o botão funciona e falhar
     depois é pior do que já dizer onde está o arquivo de duplo clique. */
  assert.match(SERVICO, /podeAgir: priv/);
  assert.match(SERVICO, /arquivoManutencao/);
  assert.match(SERVICO, /async function elevado/);
});

test('reiniciar recusa com explicação quando não tem privilégio', () => {
  const i = SERVICO.indexOf('async function reiniciar');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  assert.match(corpo, /if \(!await elevado\(\)\)/);
  assert.match(corpo, /Manutencao\.bat|ARQUIVO_MANUTENCAO/);
  assert.match(corpo, /status: 409/);
});

test('a resposta sai antes de o processo se matar', () => {
  /* O `/end` mata quem está respondendo. Sem o adiamento, o navegador recebe
     uma conexão cortada e a tela não sabe dizer se deu certo. */
  const i = SERVICO.indexOf('async function reiniciar');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}\n', i));
  assert.match(corpo, /setTimeout\(\(\) => \{[\s\S]{0,200}schtasks/);
});

/* ------------------------------------------- o operador comum não digita */

test('existe um arquivo de duplo clique, e ele mesmo pede elevação', () => {
  const bat = fonte('Manutencao.bat');
  assert.match(bat, /net session/, 'confere se já está elevado');
  assert.match(bat, /Verb RunAs/, 'e pede elevação ao Windows quando não está');
  assert.match(bat, /janela azul/, 'em português de gente, não de terminal');
  /* Um menu por número: é o que alguém sem prática consegue usar. */
  assert.match(bat, /set \/p "op=/);
  for (const acao of ['situacao', 'instalar', 'iniciar']) {
    assert.ok(bat.includes(acao), 'o menu precisa cobrir: ' + acao);
  }
});

test('parar o gateway pede confirmação escrita', () => {
  /* Parar deixa o escritório sem emitir e o WhatsApp mudo. Não pode ser um
     número digitado por engano no menu. */
  const bat = fonte('Manutencao.bat');
  const i = bat.indexOf(':parar');
  const corpo = bat.slice(i);
  assert.match(corpo, /Digite SIM/);
  assert.match(corpo, /nenhuma nota e emitida/);
});

test('o instalador leva o arquivo e configura o início automático', () => {
  /* É onde isso custa zero: o instalador já roda elevado. Deixar para depois
     é deixar para nunca. */
  const iss = fonte('instalador', 'nfse-gateway.iss');
  assert.match(iss, /Manutencao\.bat/, 'atalho no menu iniciar');
  assert.match(iss, /Name: "inicioAutomatico"/);
  assert.match(iss, /servico-windows\.ps1[\s\S]{0,80}instalar/);
  assert.match(iss, /Tasks: inicioAutomatico/);

  const pacote = fonte('instalador', 'preparar-pacote.ps1');
  assert.match(pacote, /'Manutencao\.bat'/);
});

/* ----------------------------------------------------------- a tela */

test('a tela está registrada e no menu', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /sistema:\s*\{ titulo:'O gateway no ar'/);
  assert.match(painel, /function carregarSistema/);

  const html = fonte('src', 'public', 'admin.html');
  assert.match(html, /data-tela="sistema"/);
  assert.match(html, /data-tela-conteudo="sistema"/);
});

test('cada linha diz o que acontece se aquela peça faltar', () => {
  /* "Tarefa não registrada" não significa nada para quem opera. "Depois de um
     reinício o WhatsApp não responde" significa. As frases de consequência
     moram no serviço, que é quem sabe o estado; a tela só as mostra. */
  assert.match(SERVICO, /Depois de um reinício/);
  assert.match(SERVICO, /o WhatsApp não responde/);
  assert.match(SERVICO, /abre sem banco e nada funciona/);
  assert.match(SERVICO, /trafega em claro/);

  const painel = fonte('src', 'public', 'painel.js');
  const i = painel.indexOf('function carregarSistema');
  const corpo = painel.slice(i, painel.indexOf("el('btnSisAtualizar')", i));
  assert.match(corpo, /disco que falhar leva os dois/);
  assert.match(corpo, /também não atende o WhatsApp/);
});

test('o selo do menu não espera alguém abrir a tela', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /el\('seloSistema'\)/);
});

test('o botão de reiniciar some quando não pode agir', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /el\('btnSisReiniciar'\)\.disabled = !d\.podeAgir/);
});

test('os textos da tela são acentuados', () => {
  /* O painel inteiro é escrito em português com acento; uma tela sem acento
     denuncia que foi colada de outro lugar. */
  const painel = fonte('src', 'public', 'painel.js');
  const i = painel.indexOf('function carregarSistema');
  const corpo = painel.slice(i, painel.indexOf("el('btnSisAtualizar')", i));
  /* Conferir a AUSÊNCIA de formas sem acento pegava caminho de rota
     (/manutencao/sistema) e nome de chave de tela. O que interessa é a
     presença das formas certas nos textos que a pessoa lê. */
  for (const certo of ['Última cópia', 'Válido até', 'Backup só neste computador',
                       'início automático', 'versão ']) {
    assert.ok(corpo.includes(certo), 'faltou o texto acentuado: ' + certo);
  }
});
