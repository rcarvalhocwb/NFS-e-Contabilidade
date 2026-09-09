const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O instalador de três estados.
 *
 * Antes ele tinha um modo só e nenhuma noção do que ia encontrar: rodava igual
 * numa máquina virgem e numa que emite nota há seis meses, e perguntava — à
 * contadora, no meio de uma atualização — onde ela queria o banco de dados.
 * Uma resposta distraída ali aponta o gateway para outro banco.
 *
 * Isto aqui não compila nem instala nada. Trava as decisões do assistente, que
 * são as que não se veem sem executar o .exe numa máquina de verdade — e é
 * caro executar o .exe numa máquina de verdade três vezes por dia.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8').replace(/\r\n/g, '\n');

const ISS = ler('instalador', 'nfse-gateway.iss');
const CONFIGURAR = ler('instalador', 'configurar.ps1');
const TERMINAL = ler('instalador', 'terminal.ps1');
const FIREWALL = ler('instalador', 'firewall.ps1');

/* ------------------------------------------------------ o diagnóstico */

test('o instalador descobre em que situação está antes de perguntar', () => {
  /* As duas perguntas ao sistema: o registro diz que o produto já esteve aqui,
     o .env com MASTER_KEY diz que os dados ainda estão. */
  assert.match(ISS, /RegQueryStringValue\(HKLM, '\{#ChaveReg\}', 'Raiz'/,
    'o registro precisa ser consultado');
  assert.match(ISS, /MASTER_KEY=/,
    'a presença da MASTER_KEY é o que separa atualização de reinstalação');
  for (const modo of ['nova', 'reinstalacao', 'atualizacao']) {
    assert.ok(ISS.includes("'" + modo + "'"), 'o modo ' + modo + ' precisa existir');
  }
});

test('numa atualização o assistente não pergunta nada', () => {
  /* A falha central do instalador antigo. Todas as páginas que coletam algo
     precisam ser puladas — se uma escapar, ela pergunta na pior hora. */
  const i = ISS.indexOf("if ModoDetectado = 'atualizacao' then");
  assert.ok(i > 0, 'o desvio da atualização sumiu do ShouldSkipPage');
  const bloco = ISS.slice(i, ISS.indexOf('end;', ISS.indexOf('Exit;', i)));
  for (const pagina of ['PaginaBanco', 'PaginaBancoUrl', 'PaginaUsuario',
                        'PaginaEscritorio', 'PaginaRede', 'CaixaMigracao']) {
    assert.ok(bloco.includes(pagina + '.ID'),
      pagina + ' não está sendo pulada numa atualização — ela vai perguntar');
  }
});

/* ------------------------------------------------- servidor x terminal */

test('terminal não recebe gateway, nem banco, nem Node', () => {
  /* O ponto inteiro. Um terminal rodando gateway apontado para o banco do
     servidor cria um segundo processo reservando número na mesma
     `numeracao_dps` — e a numeração fiscal é uma sequência sem buracos e sem
     repetições. */
  const arquivos = ISS.slice(ISS.indexOf('[Files]'), ISS.indexOf('[Registry]'));
  const linhaPacote = arquivos.split('\n').find(l => l.includes('Source: "pacote\\*"'));
  assert.ok(linhaPacote, 'a linha que copia o pacote sumiu');
  assert.match(linhaPacote, /Check: EhServidor/,
    'o pacote inteiro (gateway, Node, PostgreSQL) só pode ir no modo servidor');

  /* E o inverso: o script do terminal vai para os dois, porque é ele que
     cria os atalhos. */
  assert.ok(arquivos.includes('terminal.ps1'));
});

test('o terminal confere que alcança o servidor antes de terminar', () => {
  /* Sem isso, o instalador termina com sucesso e deixa um atalho quebrado na
     área de trabalho — o pior resultado possível, porque parece que funcionou. */
  assert.match(TERMINAL, /\/health/, 'o teste de conexão usa /health');
  assert.match(TERMINAL, /exit 3/, 'instalado-mas-sem-servidor precisa de código próprio');
  assert.match(ISS, /Codigo = 3/, 'e o instalador precisa tratar esse código');
  /* A mensagem tem que dizer o que fazer, não só que falhou. */
  assert.match(ISS, /Manutencao\.bat > Liberar acesso da rede/);
});

test('o terminal não abre porta nenhuma', () => {
  assert.ok(!/New-NetFirewallRule/.test(TERMINAL),
    'terminal só faz conexão de saída — abrir porta nele é abrir porta que ninguém usa');
});

/* ------------------------------------------------------------ firewall */

test('o firewall abre o painel e nunca o banco', () => {
  assert.match(FIREWALL, /New-NetFirewallRule/);
  assert.match(FIREWALL, /-Profile Private,Domain/,
    'perfil público fica de fora: o notebook do escritório vai à cafeteria');
  /* A porta do PostgreSQL não pode aparecer em regra nenhuma. Terminal fala
     com o gateway por HTTP; abrir 5434 daria acesso direto ao banco de notas
     fiscais, com o certificado A1 cifrado dentro, sem passar por login. */
  const semComentarios = FIREWALL.replace(/^\s*#.*$/gm, '');
  assert.ok(!/5432|5434/.test(semComentarios),
    'a porta do banco não pode ser liberada em hipótese nenhuma');
});

test('a porta liberada é a que a pessoa escolheu', () => {
  assert.match(ISS, /PortaEscolhida/, 'a porta do assistente precisa chegar ao firewall');
  assert.match(CONFIGURAR, /firewall\.ps1'\s*\r?\n?.*abrir -Porta \$Porta|abrir -Porta \$Porta/,
    'o configurar.ps1 precisa repassar a porta escolhida');
});

/* --------------------------------------------------- os cinco defeitos */

test('o .env não fixa mais a versão do aplicativo', () => {
  /* VER_APLIC vai dentro de TODA DPS. Escrito no .env, ele vence o
     package.json e congela: uma instalação feita hoje declararia
     "nfse-gateway/1.0" à Sefin para sempre. */
  const geraEnv = CONFIGURAR.slice(CONFIGURAR.indexOf('$conteudo = @"'));
  const bloco = geraEnv.slice(0, geraEnv.indexOf('"@'));
  assert.ok(!/VER_APLIC/.test(bloco),
    'VER_APLIC de volta no .env gerado — toda DPS desta instalação vai mentir a versão');
});

test('chave nova chega a quem já tem .env', () => {
  /* Manter o .env está certo. Só manter estava errado: uma versão que passe a
     depender de variável nova subia sem ela e falhava longe da causa. */
  assert.match(CONFIGURAR, /acrescentar/,
    'a atualização precisa fazer união, não só manter');
  assert.match(CONFIGURAR, /MASTER_KEY/,
    'e o comentário precisa dizer por que o que existe nunca é tocado');
});

test('não se atualiza sem cópia de segurança', () => {
  /* A única trava inegociável: migração de banco não tem "desfazer", tem
     restauração — e restauração precisa de uma cópia que exista. */
  const i = CONFIGURAR.indexOf("if ($Modo -eq 'atualizacao')");
  assert.ok(i > 0, 'o bloco da cópia antes de atualizar sumiu');
  const bloco = CONFIGURAR.slice(i, i + 900);
  assert.match(bloco, /backup\.js/);
  assert.match(bloco, /Falhar/, 'cópia que falha precisa ABORTAR, não avisar');

  /* E vem antes de mexer no banco. */
  const migra = CONFIGURAR.indexOf('scripts/migrate.js');
  assert.ok(i < migra, 'a cópia tem que vir antes da migração');
});

test('o gateway é parado antes de trocar os arquivos', () => {
  /* No Windows, arquivo em uso não é substituído: a atualização terminaria
     "com sucesso" deixando uma mistura de duas versões — roda, e roda errado. */
  const i = ISS.indexOf('CurStep = ssInstall');
  assert.ok(i > 0, 'nada para o gateway antes da instalação');
  const bloco = ISS.slice(i, i + 700);
  assert.match(bloco, /servico-windows\.ps1" parar/);
});

test('desinstalar não deixa o serviço do banco para trás', () => {
  /* Antes ele só era parado: depois de desinstalar, continuava subindo com o
     Windows para servir um programa que não existe mais. */
  /* `""` e não `"`: dentro de uma string do .iss as aspas são dobradas, e o
     regex com aspa simples não casava com nada — o teste falhava apontando
     para uma linha que estava lá. */
  const bloco = ISS.slice(ISS.indexOf('[UninstallRun]'), ISS.indexOf('[Code]'));
  assert.match(bloco, /servico-windows\.ps1"" remover/);
  assert.match(bloco, /firewall\.ps1"" fechar/,
    'a regra de firewall também precisa sair');
});

/* ------------------------------------------------------- os segredos */

test('senha não viaja na linha de comando', () => {
  /* Linha de comando aparece no gerenciador de tarefas, no log de auditoria de
     processos e em qualquer antivírus com telemetria. */
  const chamada = ISS.slice(ISS.indexOf('configurar.ps1'), ISS.indexOf('if not Exec'));
  for (const proibido of ['-SenhaUsuario', '-SenhaMigracao', '-EmailUsuario']) {
    assert.ok(!chamada.includes(proibido),
      proibido + ' de volta na linha de comando do PowerShell');
  }
  assert.match(chamada, /-Respostas/, 'as respostas vão por arquivo');
});

test('o arquivo de respostas é apagado assim que lido', () => {
  const i = CONFIGURAR.indexOf('$Respostas');
  const bloco = CONFIGURAR.slice(i, CONFIGURAR.indexOf('=== Configurando'));
  assert.match(bloco, /Remove-Item \$Respostas/,
    'o arquivo com a senha do administrador precisa sumir na hora');
  /* E o instalador confere de novo, caso o script tenha morrido antes. */
  assert.match(ISS, /if FileExists\(Respostas\) then DeleteFile\(Respostas\)/);
});

/* ------------------------------------------------------- o relatório */

test('a atualização termina mostrando o que aconteceu', () => {
  assert.match(CONFIGURAR, /relatorio-atualizacao\.js/);
  assert.match(ISS, /ultima-atualizacao\.json/, 'e a última tela precisa apontar para ele');

  const rel = ler('scripts', 'relatorio-atualizacao.js');
  /* As duas metades. A segunda é a que só o sistema atualizado sabe montar. */
  assert.match(rel, /migracoesRecentes/);
  assert.match(rel, /copiaAnterior/);
  assert.match(rel, /empresasQueNaoEmitem/,
    'dizer que a atualização terminou sem dizer quem ainda não emite é meio relatório');
});
