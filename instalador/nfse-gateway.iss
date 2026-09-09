; ---------------------------------------------------------------------------
; Instalador do NFS-e Gateway.
;
; Gera um .exe unico que instala tudo — Node, PostgreSQL, o gateway — sem
; exigir nada previamente instalado na maquina. Quem opera e a contabilidade,
; nao alguem de TI: por isso todas as perguntas ficam em telas do Windows.
;
; TRES SITUACOES, E ELE DESCOBRE SOZINHO QUAL E:
;
;   nova          nao ha registro do produto. Formulario completo, e a
;                 pergunta que separa tudo: servidor ou terminal?
;   reinstalacao  ha registro, mas nao ha .env com MASTER_KEY. Alguem
;                 formatou, ou desinstalou. Procura a copia nos lugares
;                 padrao e so pergunta o que nao achar.
;   atualizacao   ha registro e ha .env. NENHUMA pergunta: copia de
;                 seguranca, troca, migra, e mostra o relatorio.
;
; Antes, ele tinha um modo so e nenhuma nocao do que ia encontrar — perguntava
; "onde os dados vao ficar guardados?" a quem so queria a versao nova. Uma
; resposta distraida ali apontava o gateway para outro banco.
;
; Monte o pacote antes:  .\preparar-pacote.ps1
; Depois compile:        ISCC.exe nfse-gateway.iss
; ---------------------------------------------------------------------------

#define Nome "NFS-e Gateway"
; A versao vem do package.json, gravada aqui por preparar-pacote.ps1.
#include "versao.iss"
#define Publicador "Grupo Recalcatti"
#define ExeAtalho "Iniciar Gateway.bat"
#define ChaveReg "Software\Grupo Recalcatti\NFS-e Gateway"

[Setup]
AppId={{8F3A6C21-4B7E-4D9A-9C2F-1E5D8B7A3C60}
AppName={#Nome}
AppVersion={#Versao}
AppPublisher={#Publicador}
DefaultDirName={autopf}\NFSe Gateway
DefaultGroupName={#Nome}
DisableProgramGroupPage=yes
OutputDir=saida
OutputBaseFilename=nfse-gateway-setup-{#Versao}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Precisa de admin para escrever em Arquivos de Programas, criar o servico do
; banco e abrir a porta no firewall.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#Nome}
LicenseFile=
SetupLogging=yes
; Numa atualizacao, a pasta ja e conhecida: perguntar de novo so daria chance
; de instalar a versao nova ao lado da antiga.
UsePreviousAppDir=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
; O pacote inteiro so vai no modo servidor. Terminal nao recebe gateway, nem
; Node, nem PostgreSQL: ele so precisa de atalhos, e um segundo gateway
; apontando para o mesmo banco reservaria a mesma numeracao fiscal.
Source: "pacote\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: EhServidor
Source: "Iniciar Gateway.bat"; DestDir: "{app}"; Flags: ignoreversion; Check: EhServidor
Source: "configurar.ps1"; DestDir: "{app}"; Flags: ignoreversion; Check: EhServidor
Source: "firewall.ps1"; DestDir: "{app}"; Flags: ignoreversion; Check: EhServidor
; O terminal leva so o script que cria os atalhos e testa a conexao.
Source: "terminal.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; O que identifica a instalacao para a PROXIMA execucao do instalador.
; Gravado depois da instalacao; lido antes dela, quando ainda tem o valor
; anterior — e e assim que a atualizacao sabe de onde veio.
Root: HKLM; Subkey: "{#ChaveReg}"; ValueType: string; ValueName: "Raiz"; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "{#ChaveReg}"; ValueType: string; ValueName: "Versao"; ValueData: "{#Versao}"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "{#ChaveReg}"; ValueType: string; ValueName: "Modo"; ValueData: "{code:ModoInstalado}"; Flags: uninsdeletevalue
Root: HKLM; Subkey: "{#ChaveReg}"; Flags: uninsdeletekeyifempty

[Icons]
Name: "{group}\Emitir NFS-e"; Filename: "{app}\{#ExeAtalho}"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70; Check: EhServidor
Name: "{group}\Painel de configuracao"; Filename: "http://localhost:{code:PortaEscolhida}/admin"; Check: EhServidor
Name: "{group}\Monitor do gateway"; Filename: "{app}\Monitor.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 22; Check: EhServidor
Name: "{autodesktop}\Monitor do gateway"; Filename: "{app}\Monitor.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 22; Tasks: atalhoDesktop; Check: EhServidor
Name: "{group}\Manutencao do sistema"; Filename: "{app}\Manutencao.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 21; Check: EhServidor
Name: "{group}\Desinstalar {#Nome}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Emitir NFS-e"; Filename: "{app}\{#ExeAtalho}"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70; Tasks: atalhoDesktop; Check: EhServidor

[Tasks]
Name: "atalhoDesktop"; Description: "Criar atalho na area de trabalho"; GroupDescription: "Atalhos:"
Name: "inicioAutomatico"; Description: "Iniciar o gateway junto com o Windows (recomendado)"; GroupDescription: "Funcionamento:"; Check: EhServidor
Name: "liberarFirewall"; Description: "Liberar a porta do painel para os terminais do escritorio"; GroupDescription: "Funcionamento:"; Check: EhServidor

[Dirs]
Name: "{app}\backups"; Permissions: users-modify; Check: EhServidor
Name: "{app}\logs"; Permissions: users-modify; Check: EhServidor
Name: "{app}\postgres"; Permissions: users-modify; Check: EhServidor

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\servico-windows.ps1"" instalar -Pasta ""{app}"" -Node ""{app}\node\node.exe"""; StatusMsg: "Configurando o inicio automatico..."; Flags: runhidden waituntilterminated; Tasks: inicioAutomatico; Check: EhServidor
Filename: "{app}\{#ExeAtalho}"; Description: "Abrir o gateway agora"; Flags: postinstall shellexec skipifsilent; Tasks: not inicioAutomatico; Check: EhServidor

[UninstallRun]
; Fecha a porta que este instalador abriu. Deixar regra de firewall apontando
; para um programa que nao existe mais e sujeira que ninguem vai achar depois.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\firewall.ps1"" fechar"; Flags: runhidden; RunOnceId: "FecharPorta"
; Para E DESREGISTRA o servico do banco. Antes, ele so era parado: depois de
; desinstalar, continuava subindo com o Windows para servir um programa que
; nao existe mais.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\servico-windows.ps1"" remover -Pasta ""{app}"""; Flags: runhidden; RunOnceId: "RemoverServicos"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command "". '{app}\postgres-local.ps1'; Stop-PostgresLocal '{app}' | Out-Null"""; Flags: runhidden; RunOnceId: "PararBanco"

[Code]
var
  { --- o que a maquina revelou --- }
  ModoDetectado: String;      { nova | reinstalacao | atualizacao }
  RaizAnterior: String;
  VersaoAnterior: String;
  EraTerminal: Boolean;

  { --- as paginas --- }
  PaginaPapel: TInputOptionWizardPage;
  PaginaServidorTerminal: TInputQueryWizardPage;
  PaginaEscritorio: TInputQueryWizardPage;
  PaginaBanco: TInputOptionWizardPage;
  PaginaBancoUrl: TInputQueryWizardPage;
  PaginaRede: TInputQueryWizardPage;
  CaixaMigracao: TInputOptionWizardPage;
  PaginaMigracao: TInputFileWizardPage;
  PaginaMigracaoSenha: TInputQueryWizardPage;
  PaginaUsuario: TInputQueryWizardPage;
  PaginaResumo: TOutputMsgWizardPage;

{ ------------------------------------------------------ o diagnostico }

{ Duas perguntas ao sistema decidem tudo. A chave de registro diz que o produto
  ja esteve aqui; o .env com MASTER_KEY diz que os dados ainda estao.

  A ORDEM IMPORTA: o .env e a fonte de verdade, nao o registro. E ele que
  carrega a MASTER_KEY, sem a qual o certificado A1 guardado no banco nao abre
  mais. Um instalador que confie so no registro pode achar que esta atualizando
  quando esta diante de uma pasta vazia — e sobrescrever a chave. }
function TemEnvComChave(Raiz: String): Boolean;
var
  Conteudo: AnsiString;
begin
  Result := False;
  if not FileExists(Raiz + '\.env') then Exit;
  if not LoadStringFromFile(Raiz + '\.env', Conteudo) then Exit;
  Result := Pos('MASTER_KEY=', Conteudo) > 0;
end;

procedure Diagnosticar;
begin
  ModoDetectado := 'nova';
  RaizAnterior := '';
  VersaoAnterior := '';
  EraTerminal := False;

  if RegQueryStringValue(HKLM, '{#ChaveReg}', 'Raiz', RaizAnterior) and (RaizAnterior <> '') then
  begin
    RegQueryStringValue(HKLM, '{#ChaveReg}', 'Versao', VersaoAnterior);
    EraTerminal := FileExists(RaizAnterior + '\terminal.json');

    if EraTerminal then
      { Terminal nao tem banco nem .env: reinstalar terminal e refazer os
        atalhos, o que e barato e nao arrisca nada. }
      ModoDetectado := 'atualizacao'
    else if TemEnvComChave(RaizAnterior) then
      ModoDetectado := 'atualizacao'
    else
      ModoDetectado := 'reinstalacao';
  end;
end;

function EhServidor: Boolean;
begin
  { Terminal so na instalacao nova; quem ja e terminal continua terminal. }
  if EraTerminal then Result := False
  else if ModoDetectado = 'nova' then
    Result := (PaginaPapel = nil) or (PaginaPapel.SelectedValueIndex = 0)
  else
    Result := True;
end;

function EhTerminal: Boolean;
begin
  Result := not EhServidor;
end;

function ModoInstalado(Param: String): String;
begin
  if EhTerminal then Result := 'terminal' else Result := 'servidor';
end;

function PortaEscolhida(Param: String): String;
begin
  Result := Trim(PaginaRede.Values[0]);
  if Result = '' then Result := '3000';
end;

function BancoLocal: Boolean;
begin
  Result := PaginaBanco.SelectedValueIndex = 0;
end;

function VaiMigrar: Boolean;
begin
  Result := CaixaMigracao.SelectedValueIndex = 1;
end;

{ --------------------------------------------------------- as telas }

procedure InitializeWizard;
var
  Texto: String;
begin
  Diagnosticar;

  { --- servidor ou terminal (so na instalacao nova) --- }
  PaginaPapel := CreateInputOptionPage(wpSelectTasks,
    'Servidor ou terminal',
    'Qual e o papel deste computador?',
    'O gateway roda em UM computador do escritorio — o servidor. Os outros abrem o painel pela rede.',
    True, False);
  PaginaPapel.Add('Servidor (recomendado para o primeiro computador)' + #13#10 +
    '     Instala o gateway, o banco de dados e emite as notas.');
  PaginaPapel.Add('Terminal' + #13#10 +
    '     So cria os atalhos para o servidor que ja existe. Nao instala banco.');
  PaginaPapel.SelectedValueIndex := 0;

  PaginaServidorTerminal := CreateInputQueryPage(PaginaPapel.ID,
    'Endereco do servidor',
    'Onde esta o gateway do escritorio?',
    'Pergunte a quem instalou o primeiro computador. Exemplo: 192.168.0.10');
  PaginaServidorTerminal.Add('Endereco do servidor:', False);
  PaginaServidorTerminal.Values[0] := '192.168.0.10:3000';

  { --- o escritorio --- }
  PaginaEscritorio := CreateInputQueryPage(PaginaServidorTerminal.ID,
    'O escritorio',
    'De quem e este sistema?',
    'Aparece na tela de acesso e nos relatorios. Da para mudar depois, no painel.');
  PaginaEscritorio.Add('Nome do escritorio:', False);
  PaginaEscritorio.Add('CNPJ:', False);
  PaginaEscritorio.Add('E-mail para avisos do sistema:', False);

  { --- onde ficam os dados --- }
  PaginaBanco := CreateInputOptionPage(PaginaEscritorio.ID,
    'Banco de dados',
    'Onde os dados do gateway vao ficar guardados?',
    'As notas emitidas, as empresas e os certificados precisam ser gravados em algum lugar.',
    True, False);
  PaginaBanco.Add('Nesta maquina (recomendado)' + #13#10 +
    '     Funciona sem internet. O instalador cuida de tudo.');
  PaginaBanco.Add('Em um servidor que voce ja tem' + #13#10 +
    '     Voce informa o endereco de conexao na proxima tela.');
  PaginaBanco.SelectedValueIndex := 0;

  PaginaBancoUrl := CreateInputQueryPage(PaginaBanco.ID,
    'Endereco do banco',
    'Informe a conexao com o seu servidor PostgreSQL',
    'Se voce nao tem essa informacao, pergunte a quem cuida da TI.');
  PaginaBancoUrl.Add('Endereco (postgresql://usuario:senha@servidor:5432/banco):', False);

  { --- rede e copia --- }
  PaginaRede := CreateInputQueryPage(PaginaBancoUrl.ID,
    'Rede e copia de seguranca',
    'Como os outros computadores alcancam este, e onde fica a copia',
    'A porta e liberada no firewall so para a rede local. O banco de dados nunca e exposto.');
  PaginaRede.Add('Porta do painel:', False);
  PaginaRede.Values[0] := '3000';
  PaginaRede.Add('Pasta para a copia de seguranca (deixe vazio para so aqui):', False);

  { --- migracao de outra maquina --- }
  CaixaMigracao := CreateInputOptionPage(PaginaRede.ID,
    'Instalacao nova ou mudanca de maquina',
    'Este gateway ja existe em outro computador?',
    'Se voce esta trocando de maquina, pode trazer as empresas, os certificados e o historico.',
    True, False);
  CaixaMigracao.Add('Instalacao nova' + #13#10 +
    '     Comecar do zero, cadastrando as empresas depois.');
  CaixaMigracao.Add('Trazer de outro computador' + #13#10 +
    '     Usar um arquivo de migracao (.nfsepkg) gerado la.');
  CaixaMigracao.SelectedValueIndex := 0;

  PaginaMigracao := CreateInputFilePage(CaixaMigracao.ID,
    'Arquivo de migracao',
    'Selecione o arquivo gerado no computador anterior',
    'No gateway antigo, use "Backup e migracao" no painel para gerar este arquivo.');
  PaginaMigracao.Add('Arquivo de migracao:', 'Pacote do gateway|*.nfsepkg|Todos os arquivos|*.*', '.nfsepkg');

  PaginaMigracaoSenha := CreateInputQueryPage(PaginaMigracao.ID,
    'Senha do arquivo',
    'Informe a senha usada ao gerar o arquivo',
    'Sem ela o arquivo nao abre — nem por nos, nem por ninguem.');
  PaginaMigracaoSenha.Add('Senha:', True);

  { --- primeiro acesso --- }
  PaginaUsuario := CreateInputQueryPage(PaginaMigracaoSenha.ID,
    'Acesso ao sistema',
    'Quem vai administrar o gateway?',
    'E com este e-mail e senha que se entra no sistema. Voce pode cadastrar mais pessoas depois.');
  PaginaUsuario.Add('Nome:', False);
  PaginaUsuario.Add('E-mail:', False);
  PaginaUsuario.Add('Senha (minimo 8 caracteres):', True);
  PaginaUsuario.Add('Repita a senha:', True);

  { --- o que vai acontecer, quando nao ha nada a perguntar --- }
  if ModoDetectado = 'atualizacao' then
  begin
    Texto := 'Encontrei o NFS-e Gateway';
    if VersaoAnterior <> '' then Texto := Texto + ' versao ' + VersaoAnterior;
    Texto := Texto + ' em:' + #13#10 + '    ' + RaizAnterior + #13#10 + #13#10 +
      'Vou atualizar para a versao {#Versao}. Nao preciso perguntar nada:' + #13#10 + #13#10 +
      '  1. copia de seguranca do banco ANTES de qualquer mudanca;' + #13#10 +
      '  2. paro o gateway e troco os arquivos;' + #13#10 +
      '  3. atualizo o banco e subo de volta;' + #13#10 +
      '  4. mostro o que mudou e o que aconteceu nesta maquina.' + #13#10 + #13#10 +
      'Suas empresas, certificados, notas e configuracoes ficam como estao. ' +
      'O arquivo .env nao e sobrescrito — se a versao nova precisar de alguma ' +
      'configuracao que ainda nao existe, ela e acrescentada ao lado das suas.';
  end
  else if ModoDetectado = 'reinstalacao' then
  begin
    Texto := 'Encontrei o registro de uma instalacao anterior em:' + #13#10 +
      '    ' + RaizAnterior + #13#10 + #13#10 +
      'Mas nao encontrei os dados dela (o arquivo .env com a chave que abre os ' +
      'certificados). Isso acontece quando a maquina foi formatada, ou quando o ' +
      'programa foi desinstalado.' + #13#10 + #13#10 +
      'Vou procurar uma copia de seguranca nos lugares de sempre. Se nao achar, ' +
      'peco o arquivo de migracao nas telas seguintes.';
  end
  else
    Texto := '';

  if Texto <> '' then
    PaginaResumo := CreateOutputMsgPage(wpSelectTasks,
      'O que vou fazer', 'Este computador ja tem o NFS-e Gateway', Texto);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;

  { Numa atualizacao nao se pergunta NADA. Era a falha central do instalador
    antigo: ele perguntava "onde os dados vao ficar guardados?" a quem so
    queria a versao nova. }
  if ModoDetectado = 'atualizacao' then
  begin
    if (PageID = PaginaPapel.ID) or (PageID = PaginaServidorTerminal.ID) or
       (PageID = PaginaEscritorio.ID) or (PageID = PaginaBanco.ID) or
       (PageID = PaginaBancoUrl.ID) or (PageID = PaginaRede.ID) or
       (PageID = CaixaMigracao.ID) or (PageID = PaginaMigracao.ID) or
       (PageID = PaginaMigracaoSenha.ID) or (PageID = PaginaUsuario.ID) then
    begin
      Result := True;
      Exit;
    end;
  end;

  { Na reinstalacao, papel e escritorio ja se sabem — o resto vem da copia. }
  if ModoDetectado = 'reinstalacao' then
  begin
    if (PageID = PaginaPapel.ID) or (PageID = PaginaServidorTerminal.ID) or
       (PageID = PaginaEscritorio.ID) then
    begin
      Result := True;
      Exit;
    end;
  end;

  { Terminal nao tem banco, nem rede para abrir, nem usuario para criar: ele
    so precisa saber onde esta o servidor. }
  if EhTerminal then
  begin
    if (PageID = PaginaEscritorio.ID) or (PageID = PaginaBanco.ID) or
       (PageID = PaginaBancoUrl.ID) or (PageID = PaginaRede.ID) or
       (PageID = CaixaMigracao.ID) or (PageID = PaginaMigracao.ID) or
       (PageID = PaginaMigracaoSenha.ID) or (PageID = PaginaUsuario.ID) then
      Result := True;
    Exit;
  end;

  { Servidor: o endereco do servidor nao se pergunta a ele mesmo. }
  if PageID = PaginaServidorTerminal.ID then Result := True;
  if (PageID = PaginaBancoUrl.ID) and BancoLocal then Result := True;
  if ((PageID = PaginaMigracao.ID) or (PageID = PaginaMigracaoSenha.ID)) and (not VaiMigrar) then
    Result := True;
  { Migrando, o usuario vem junto no pacote — nao ha o que criar. }
  if (PageID = PaginaUsuario.ID) and VaiMigrar then Result := True;
end;

function SoDigitos(S: String): String;
var
  i: Integer;
begin
  Result := '';
  for i := 1 to Length(S) do
    if (S[i] >= '0') and (S[i] <= '9') then Result := Result + S[i];
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Endereco, Email, Senha, Cnpj, Porta: String;
  P: Integer;
begin
  Result := True;

  if (CurPageID = PaginaServidorTerminal.ID) and EhTerminal then
  begin
    if Trim(PaginaServidorTerminal.Values[0]) = '' then
    begin
      MsgBox('Informe o endereco do servidor.', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaEscritorio.ID) and EhServidor and (ModoDetectado = 'nova') then
  begin
    if Trim(PaginaEscritorio.Values[0]) = '' then
    begin
      MsgBox('Informe o nome do escritorio.', mbError, MB_OK);
      Result := False; Exit;
    end;
    Cnpj := SoDigitos(PaginaEscritorio.Values[1]);
    if (Cnpj <> '') and (Length(Cnpj) <> 14) then
    begin
      MsgBox('O CNPJ tem 14 digitos. Voce informou ' + IntToStr(Length(Cnpj)) + '.', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaBancoUrl.ID) and (not BancoLocal) then
  begin
    Endereco := Trim(PaginaBancoUrl.Values[0]);
    if (Pos('postgresql://', Endereco) <> 1) and (Pos('postgres://', Endereco) <> 1) then
    begin
      MsgBox('O endereco deve comecar com postgresql://', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaRede.ID) and EhServidor then
  begin
    Porta := Trim(PaginaRede.Values[0]);
    P := StrToIntDef(Porta, 0);
    if (P < 1024) or (P > 65535) then
    begin
      MsgBox('A porta precisa ser um numero entre 1024 e 65535.', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaMigracao.ID) and VaiMigrar then
  begin
    if not FileExists(PaginaMigracao.Values[0]) then
    begin
      MsgBox('Selecione o arquivo de migracao.', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaMigracaoSenha.ID) and VaiMigrar then
  begin
    if Length(PaginaMigracaoSenha.Values[0]) < 1 then
    begin
      MsgBox('Informe a senha do arquivo de migracao.', mbError, MB_OK);
      Result := False; Exit;
    end;
  end;

  if (CurPageID = PaginaUsuario.ID) and (not VaiMigrar) and EhServidor then
  begin
    if Trim(PaginaUsuario.Values[0]) = '' then
    begin
      MsgBox('Informe o nome.', mbError, MB_OK); Result := False; Exit;
    end;
    Email := Trim(PaginaUsuario.Values[1]);
    if (Pos('@', Email) < 2) or (Pos('.', Email) = 0) then
    begin
      MsgBox('Informe um e-mail valido.', mbError, MB_OK); Result := False; Exit;
    end;
    Senha := PaginaUsuario.Values[2];
    if Length(Senha) < 8 then
    begin
      MsgBox('A senha precisa ter ao menos 8 caracteres.', mbError, MB_OK); Result := False; Exit;
    end;
    if Senha <> PaginaUsuario.Values[3] then
    begin
      MsgBox('As duas senhas nao sao iguais.', mbError, MB_OK); Result := False; Exit;
    end;
  end;
end;

{ ------------------------------------------------- as respostas, em arquivo }

function Escapar(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

{ As respostas vao para um ARQUIVO, nao para a linha de comando.
  Senha de administrador em linha de comando aparece no gerenciador de
  tarefas, no log de auditoria de processos e em qualquer antivirus com
  telemetria. O configurar.ps1 le e apaga o arquivo logo no comeco. }
function GravarRespostas: String;
var
  J: String;
  Caminho: String;
begin
  Caminho := ExpandConstant('{tmp}\respostas.json');

  J := '{' + #13#10;
  J := J + '  "Modo": "' + ModoDetectado + '",' + #13#10;
  J := J + '  "Porta": ' + PortaEscolhida('') + ',' + #13#10;
  if WizardIsTaskSelected('liberarFirewall') then
    J := J + '  "LiberarFirewall": true,' + #13#10
  else
    J := J + '  "LiberarFirewall": false,' + #13#10;

  if ModoDetectado = 'nova' then
  begin
    J := J + '  "EscritorioNome": "' + Escapar(Trim(PaginaEscritorio.Values[0])) + '",' + #13#10;
    J := J + '  "EscritorioCnpj": "' + SoDigitos(PaginaEscritorio.Values[1]) + '",' + #13#10;
    J := J + '  "EscritorioEmail": "' + Escapar(Trim(PaginaEscritorio.Values[2])) + '",' + #13#10;
    J := J + '  "PastaBackup": "' + Escapar(Trim(PaginaRede.Values[1])) + '",' + #13#10;
  end;

  if (ModoDetectado <> 'atualizacao') and (not BancoLocal) then
    J := J + '  "BancoUrl": "' + Escapar(Trim(PaginaBancoUrl.Values[0])) + '",' + #13#10;

  if (ModoDetectado <> 'atualizacao') and VaiMigrar then
  begin
    J := J + '  "ArquivoMigracao": "' + Escapar(PaginaMigracao.Values[0]) + '",' + #13#10;
    J := J + '  "SenhaMigracao": "' + Escapar(PaginaMigracaoSenha.Values[0]) + '",' + #13#10;
  end
  else if ModoDetectado = 'nova' then
  begin
    J := J + '  "NomeUsuario": "' + Escapar(Trim(PaginaUsuario.Values[0])) + '",' + #13#10;
    J := J + '  "EmailUsuario": "' + Escapar(Trim(PaginaUsuario.Values[1])) + '",' + #13#10;
    J := J + '  "SenhaUsuario": "' + Escapar(PaginaUsuario.Values[2]) + '",' + #13#10;
  end;

  J := J + '  "VersaoAnterior": "' + VersaoAnterior + '"' + #13#10 + '}' + #13#10;

  SaveStringToFile(Caminho, J, False);
  Result := Caminho;
end;

{ ------------------------------------------------------------ a execucao }

procedure CurStepChanged(CurStep: TSetupStep);
var
  Codigo: Integer;
  Respostas, Parametros: String;
begin
  { ANTES de trocar arquivo: parar o gateway.
    No Windows, arquivo em uso nao e substituido — a atualizacao terminaria
    "com sucesso" deixando uma mistura de duas versoes, que e o pior estado
    possivel: roda, e roda errado. }
  if (CurStep = ssInstall) and (ModoDetectado <> 'nova') and (RaizAnterior <> '') then
  begin
    WizardForm.StatusLabel.Caption := 'Parando o gateway antes de trocar os arquivos...';
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + RaizAnterior + '\scripts\servico-windows.ps1" parar -Pasta "' + RaizAnterior + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Codigo);
    { Um instante para o processo soltar os arquivos. }
    Sleep(2000);
  end;

  if CurStep = ssPostInstall then
  begin
    if EhTerminal then
    begin
      WizardForm.StatusLabel.Caption := 'Configurando o terminal...';
      Parametros := '-NoProfile -ExecutionPolicy Bypass -File "' +
        ExpandConstant('{app}\terminal.ps1') + '"' +
        ' -Servidor "' + Trim(PaginaServidorTerminal.Values[0]) + '"' +
        ' -Destino "' + ExpandConstant('{app}') + '"';
      if WizardIsTaskSelected('atalhoDesktop') then Parametros := Parametros + ' -AtalhoDesktop';

      Exec('powershell.exe', Parametros, '', SW_HIDE, ewWaitUntilTerminated, Codigo);
      if Codigo = 3 then
        MsgBox('Os atalhos foram criados, mas nao consegui falar com o servidor.' + #13#10#13#10 +
               'Confira, NO SERVIDOR:' + #13#10 +
               '  - se o gateway esta ligado;' + #13#10 +
               '  - se a porta foi liberada (Manutencao.bat > Liberar acesso da rede);' + #13#10 +
               '  - se o painel atende a rede (tela "Rede e conexao").' + #13#10 + #13#10 +
               'Detalhes em: ' + ExpandConstant('{app}\configuracao.log'),
               mbInformation, MB_OK)
      else if Codigo <> 0 then
        MsgBox('A configuracao do terminal nao terminou. Veja configuracao.log em ' +
               ExpandConstant('{app}'), mbError, MB_OK);
      Exit;
    end;

    WizardForm.StatusLabel.Caption := 'Preparando o banco de dados e o acesso...';
    Respostas := GravarRespostas;
    Parametros := '-NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\configurar.ps1') + '"' +
      ' -Raiz "' + ExpandConstant('{app}') + '"' +
      ' -Respostas "' + Respostas + '"';

    if not Exec('powershell.exe', Parametros, '', SW_HIDE, ewWaitUntilTerminated, Codigo) then
    begin
      MsgBox('Nao consegui executar a configuracao.' + #13#10 +
             'O gateway foi instalado, mas ainda precisa ser configurado.', mbError, MB_OK);
    end
    else if Codigo <> 0 then
    begin
      MsgBox('A configuracao nao terminou.' + #13#10#13#10 +
             'Veja o arquivo configuracao.log na pasta:' + #13#10 +
             ExpandConstant('{app}'), mbError, MB_OK);
    end;

    { Se o arquivo de respostas sobreviveu (o script devia te-lo apagado),
      apaga aqui: ele carrega a senha do administrador. }
    if FileExists(Respostas) then DeleteFile(Respostas);
  end;
end;

{ O relatorio da atualizacao, na ultima tela. }
procedure CurPageChanged(CurPageID: Integer);
var
  Conteudo: AnsiString;
begin
  if (CurPageID = wpFinished) and (ModoDetectado = 'atualizacao') then
  begin
    if LoadStringFromFile(ExpandConstant('{app}\configuracao.log'), Conteudo) then
      WizardForm.FinishedLabel.Caption :=
        'Atualizado para a versao {#Versao}.' + #13#10 + #13#10 +
        'O relatorio do que mudou e do que aconteceu nesta maquina esta em:' + #13#10 +
        ExpandConstant('{app}\ultima-atualizacao.json') + #13#10 + #13#10 +
        'O andamento completo esta em configuracao.log, na mesma pasta.';
  end;
end;

{ Na desinstalacao, os dados ficam. Apagar o banco de notas fiscais junto com o
  programa seria irreversivel — e sao documentos com valor fiscal. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(ExpandConstant('{app}\postgres\dados')) then
      MsgBox('O banco de dados e os backups NAO foram apagados.' + #13#10#13#10 +
             'Eles continuam em:' + #13#10 + ExpandConstant('{app}') + #13#10#13#10 +
             'Sao notas fiscais: apague manualmente so se tiver certeza.',
             mbInformation, MB_OK);
  end;
end;
