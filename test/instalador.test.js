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

/* Recorta ShouldSkipPage inteira. A âncora antiga era a string
   `if ModoDetectado = 'atualizacao' then`, que aparece DUAS vezes no .iss: a
   primeira dentro de InitializeWizard, montando o texto da tela de resumo. O
   `indexOf` pegava essa, e a fatia só alcançava a regra de verdade por ser
   larga o bastante para atravessar as duas — passava por acidente de distância.
   Bastou um `Exit;` novo entrar no meio para a fatia encurtar e o teste acusar
   uma página que estava sendo pulada corretamente. Agora se recorta a função
   pelo nome dela, que é o que a asserção sempre quis dizer. */
function shouldSkipPage() {
  const i = ISS.indexOf('function ShouldSkipPage');
  assert.ok(i > 0, 'ShouldSkipPage sumiu do .iss');
  const fim = ISS.indexOf('\nfunction ', i + 1);
  return ISS.slice(i, fim > 0 ? fim : ISS.length);
}

test('numa atualização o assistente não pergunta nada', () => {
  /* A falha central do instalador antigo. Todas as páginas que coletam algo
     precisam ser puladas — se uma escapar, ela pergunta na pior hora. */
  const corpo = shouldSkipPage();
  const i = corpo.indexOf("if ModoDetectado = 'atualizacao' then");
  assert.ok(i > 0, 'o desvio da atualização sumiu do ShouldSkipPage');
  const bloco = corpo.slice(i, corpo.indexOf('end;', corpo.indexOf('Exit;', i)));
  for (const pagina of ['PaginaBanco', 'PaginaBancoUrl', 'PaginaUsuario',
                        'PaginaEscritorio', 'PaginaRede', 'CaixaMigracao']) {
    assert.ok(bloco.includes(pagina + '.ID'),
      pagina + ' não está sendo pulada numa atualização — ela vai perguntar');
  }
});

test('as telas de comissionamento só aparecem numa instalação nova', () => {
  /* Elas cadastram a primeira empresa e o primeiro serviço. Aparecer numa
     atualização seria perguntar de novo o que já está no banco; aparecer numa
     migração criaria uma empresa duplicada ao lado da que vai ser importada. */
  /* O grupo é declarado num lugar só, para não virar três listas que divergem
     na próxima página acrescentada. */
  const grupo = ISS.slice(ISS.indexOf('function EhPaginaComissionamento'),
                          ISS.indexOf('function ShouldSkipPage'));
  for (const pagina of ['PaginaEmpresa', 'PaginaCertificado', 'PaginaCertSenha',
                        'PaginaServico', 'PaginaWhatsapp', 'PaginaWhatsappDados',
                        'PaginaChatbot']) {
    assert.ok(grupo.includes(pagina + '.ID'),
      pagina + ' não é reconhecida como página de comissionamento');
  }

  /* E consultado de dentro de ShouldSkipPage, senão o grupo não pula nada. */
  assert.match(shouldSkipPage(), /EhPaginaComissionamento\(PageID\)/);

  /* A condição que governa todas elas, num lugar só. */
  const guarda = ISS.slice(ISS.indexOf('function VaiComissionar'),
                           ISS.indexOf('function TransporteWa'));
  assert.match(guarda, /ModoDetectado = 'nova'/);
  assert.match(guarda, /EhServidor/);
  assert.match(guarda, /not VaiMigrar/);
});

test('pular o comissionamento não impede de instalar', () => {
  /* Instalação que trava porque alguém não tem o certificado em mãos é pior que
     instalação incompleta: a pessoa desiste no meio e fica sem as duas coisas. */
  const i = ISS.indexOf('CaixaComissionar := CreateInputOptionPage');
  assert.ok(i > 0, 'a escolha de comissionar sumiu');
  assert.match(ISS.slice(i, i + 900), /Nao, faco tudo depois no painel/,
    'precisa haver uma saída explícita');

  /* E o certificado, dentro do comissionamento, também é opcional. */
  const cert = ISS.slice(ISS.indexOf('PaginaCertificado := CreateInputFilePage'),
                         ISS.indexOf('PaginaCertSenha := CreateInputQueryPage'));
  assert.match(cert, /Pode deixar em/,
    'a tela do certificado precisa dizer que dá para pular');
});

test('o módulo do WhatsApp não pode nascer na porta do painel', () => {
  /* São dois processos. Na mesma porta, o segundo não sobe — e não sobe em
     silêncio, que é como se descobre três dias depois. */
  const i = ISS.indexOf('if (CurPageID = PaginaWhatsappDados.ID)');
  assert.ok(i > 0, 'a validação da página de WhatsApp sumiu');
  const bloco = ISS.slice(i, ISS.indexOf('\nend;', i));
  assert.match(bloco, /Porta = PortaEscolhida/,
    'a colisão com a porta do painel precisa ser barrada no assistente');
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

/* ------------------------------------------------ o comissionamento */

const PRIMEIRA = ler('scripts', 'primeira-empresa.js');
const WA_CONFIG = ler('scripts', 'configurar-whatsapp.js');
const WA_PS = ler('instalador', 'whatsapp.ps1');

test('a primeira empresa nasce em homologação', () => {
  /* Instalação recém-feita, certificado recém-enviado e município ainda não
     conferido: emitir direto em produção é como se descobre, pela via cara,
     que o código do município estava errado. Nota em produção tem valor fiscal
     e numeração que não se reaproveita. */
  assert.match(PRIMEIRA, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,'homologacao'\)/,
    'o ambiente precisa ser homologação no INSERT, não configurável');
  assert.ok(!/ambiente.*=.*d\.ambiente/.test(PRIMEIRA),
    'não pode haver caminho que faça a instalação nascer em produção');
});

test('o instalador NÃO aceita o termo do WhatsApp por sessão própria', () => {
  /* O termo diz que o número pode ser banido e que quem fornece o gateway não
     responde por isso. Aceite embutido em "Avançar" não é aceite de ninguém —
     e o registro com nome e data perderia justamente o que lhe dá valor.
     Quem lê e marca é uma pessoa, na tela do módulo. */
  for (const [nome, fonte] of [['configurar-whatsapp.js', WA_CONFIG],
                               ['whatsapp.ps1', WA_PS],
                               ['configurar.ps1', CONFIGURAR]]) {
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/^\s*(\/\/|#).*$/gm, '');
    assert.ok(!/aceitarTermo|termo_aceito|aceitarTermoWhatsapp/.test(codigo),
      nome + ' não pode registrar aceite de termo em nome de ninguém');
  }
  /* E não liga o transporte local, porque ligar depende do aceite. */
  const codigo = WA_CONFIG.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/definirAtivo\s*\(\s*true/.test(codigo),
    'ligar a sessão própria exige o aceite; o instalador só deixa pronto');
});

test('a empresa só é liberada quando alguém foi autorizado a pedir', () => {
  /* `portal_liberado` nasce FALSE de propósito: liberar é ato do contador, e o
     padrão fechado impede que credenciar um cliente credencie os outros nove.
     Autorizar um número em nome da empresa É esse ato — mas sem número
     autorizado a empresa continua fechada, como sempre esteve. */
  const i = PRIMEIRA.indexOf('async function autorizarNumero');
  assert.ok(i > 0, 'a função que autoriza o número sumiu');
  const corpo = PRIMEIRA.slice(i, PRIMEIRA.indexOf('\n/* ---', i));

  assert.match(corpo, /if \(!d\.whatsappNumero\) return;/,
    'sem número informado, nada é liberado');
  assert.match(corpo, /portal_liberado = TRUE/);
  assert.match(corpo, /portal_decidido_por = 'instalação'/,
    'a decisão precisa ficar assinada para a auditoria');

  /* E em lugar nenhum fora daí. */
  const fora = PRIMEIRA.slice(0, i) + PRIMEIRA.slice(PRIMEIRA.indexOf('\n/* ---', i));
  assert.ok(!/portal_liberado = TRUE/.test(fora),
    'liberar fora da autorização abriria a empresa sem ninguém ter pedido');
});

test('o cloudflared só entra se estiver assinado pela Cloudflare', () => {
  /* Baixar um executável e rodá-lo sem conferir de quem é seria colocar um
     binário desconhecido para falar com a internet de dentro da máquina que
     guarda os certificados A1 do escritório. */
  const i = WA_PS.indexOf('function BaixarTunel');
  assert.ok(i > 0);
  const corpo = WA_PS.slice(i, WA_PS.indexOf('\n# ---', i));
  assert.match(corpo, /Get-AuthenticodeSignature/);
  assert.match(corpo, /Status -ne 'Valid'/);
  assert.match(corpo, /notmatch 'Cloudflare'/);
  assert.match(corpo, /Remove-Item \$temp -Force/,
    'o arquivo recusado precisa sumir, não ficar em disco para alguém rodar');
});

test('as pendências chegam à última tela', () => {
  /* Instalação que termina dizendo só "concluído" quando o certificado não
     entrou está mentindo por omissão: a pessoa só descobre na primeira nota
     que não sai, sem ligação nenhuma com o que aconteceu ali. */
  assert.match(CONFIGURAR, /pendencias\.json/);
  assert.match(ISS, /LerPendencias/);
  assert.match(ISS, /FALTA ISTO para o sistema emitir/);
});

test('config_nuvem é consultada pelo tipo certo de chave', () => {
  /* `config_nuvem.id` é BOOLEAN — a linha única mora em `id = TRUE`. Escrito
     `id = 1`, o Postgres responde "operador não existe: boolean = integer".
     Isso passou despercebido porque `whatsappLocal.situacao()` engolia o erro
     e caía no padrão 'meta': o painel afirmava que o WhatsApp saía pela Meta
     mesmo com a sessão própria escolhida. Não havia erro em log nenhum — só
     uma resposta errada com cara de certa, sobre POR ONDE a nota sai. */
  const fs2 = require('fs');
  const alvos = ['src/services/whatsappLocal.js', 'src/services/ponteNuvem.js',
                 'src/services/replicaCadastro.js', 'scripts/configurar-whatsapp.js'];
  for (const rel of alvos) {
    /* Sem comentários: o comentário que explica este defeito CITA `id = 1`, e a
       primeira versão deste teste acusou a explicação em vez do código. Duas
       vezes no mesmo dia procurando palavra em arquivo cheio de frases. */
    const s = fs2.readFileSync(path.join(RAIZ, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const trecho of s.match(/config_nuvem[\s\S]{0,200}?(?:id = \w+)/g) || []) {
      assert.ok(!/id = 1\b/.test(trecho),
        rel + ' consulta config_nuvem com `id = 1`; a coluna é boolean');
    }
  }
});

/* ------------------------------------- o repassador e o transporte local */

const REPASSADOR = ler('src', 'services', 'repassadorLocal.js');

test('o repassador sobe sem credenciais da Meta quando o transporte é local', () => {
  /* App Secret e verify token provam que um POST veio da Meta e respondem ao
     desafio do webhook. Na sessão própria não existe webhook nenhum: a mensagem
     chega do módulo desta máquina, pelo /wa/entrada, autenticada pela chave da
     ponte. Exigi-los sempre travava o caminho inteiro — quem escolhia sessão
     própria via o repassador recusar-se a subir pedindo credenciais de um
     serviço que nunca ia usar, sem nada na tela ligando uma coisa à outra. */
  const i = REPASSADOR.indexOf('function ambienteDoRelay');
  assert.ok(i > 0);
  const corpo = REPASSADOR.slice(i, REPASSADOR.indexOf('\n/* ---', i));

  assert.match(corpo, /if \(!chave\) faltando\.push/,
    'a chave da ponte é sempre necessária: é ela que autentica o módulo');
  assert.match(corpo, /c\.wa_transporte !== 'local'/,
    'App Secret e verify token só podem ser exigidos no transporte da Meta');

  /* E o transporte precisa estar na consulta, senão a condição acima é sempre
     verdadeira e nada muda — que foi como este defeito quase escapou de novo. */
  const cfg = REPASSADOR.slice(REPASSADOR.indexOf('async function configuracao'),
                               REPASSADOR.indexOf('function abrir'));
  assert.match(cfg, /wa_transporte/,
    'configuracao() precisa trazer wa_transporte, senão a condição não decide nada');
});

test('o repassador é avisado por onde a resposta sai', () => {
  /* `relay/transporte.js` lê WA_TRANSPORTE e, sem a variável, assume 'meta'.
     Faltava passá-la: o escritório escolhia sessão própria na tela, o módulo
     conectava, a conversa rodava certa — e a resposta morria em "sem número da
     Meta configurado". Tudo aparentemente de pé, e o cliente sem resposta.
     Encontrado com um número real conectado. */
  const i = REPASSADOR.indexOf('function ambienteDoRelay');
  const corpo = REPASSADOR.slice(i, REPASSADOR.indexOf('\n/* ---', i));
  assert.match(corpo, /WA_TRANSPORTE:/, 'o repassador precisa saber o transporte');
  assert.match(corpo, /WA_MODULO_URL:/, 'e onde o módulo atende');

  const t = ler('relay', 'transporte.js');
  assert.match(t, /process\.env\.WA_TRANSPORTE/,
    'e é essa variável que o transporte lê');
});

test('o token do módulo é lido na hora, não guardado', () => {
  /* Ele é sorteado a cada subida do módulo. Lido uma vez na partida, o
     repassador ficaria com um token velho assim que o módulo reiniciasse — e
     reiniciar é o que a pessoa faz quando o WhatsApp trava. Cada resposta viraria
     403, sem relação visível com o reinício. */
  const t = ler('relay', 'transporte.js');
  assert.match(t, /function tokenDoModulo/);
  assert.ok(!/const MODULO_TOKEN\s*=/.test(t),
    'token em constante de módulo envelhece junto com o processo');
  assert.match(t, /'X-WA-Token': tokenDoModulo\(\)/,
    'as chamadas precisam pedir o token no momento de usar');
});
