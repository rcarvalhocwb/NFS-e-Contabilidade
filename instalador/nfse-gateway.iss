; ---------------------------------------------------------------------------
; Instalador do NFS-e Gateway.
;
; Gera um .exe unico que instala tudo — Node, PostgreSQL, o gateway — sem
; exigir nada previamente instalado na maquina. Quem opera e a contabilidade,
; nao alguem de TI: por isso todas as perguntas ficam em telas do Windows, e
; nao em console.
;
; Monte o pacote antes:  .\preparar-pacote.ps1
; Depois compile:        ISCC.exe nfse-gateway.iss
; ---------------------------------------------------------------------------

#define Nome "NFS-e Gateway"
; A versao vem do package.json, gravada aqui por preparar-pacote.ps1.
; Mantida a mao nos dois lugares ela diverge — e e a versao do sistema
; que o verificador de atualizacoes compara com a release publicada.
#include "versao.iss"
#define Publicador "Grupo Recalcatti"
#define ExeAtalho "Iniciar Gateway.bat"

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
; Precisa de admin para escrever em Arquivos de Programas e criar o servico
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#Nome}
LicenseFile=
SetupLogging=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "pacote\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "Iniciar Gateway.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "configurar.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Emitir NFS-e"; Filename: "{app}\{#ExeAtalho}"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70
Name: "{group}\Painel de configuracao"; Filename: "http://localhost:3000/admin"
; O monitor: programa separado, icone separado. Ve tudo o que esta
; acontecendo e liga/desliga o gateway -- inclusive quando ele esta fora do
; ar, que e quando mais importa.
Name: "{group}\Monitor do gateway"; Filename: "{app}\Monitor.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 22
Name: "{autodesktop}\Monitor do gateway"; Filename: "{app}\Monitor.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 22; Tasks: atalhoDesktop
; Manutencao: instalar/reiniciar/parar sem ninguem digitar comando. Ele mesmo
; pede elevacao ao Windows, que e o que uma pagina no navegador nao consegue.
Name: "{group}\Manutencao do sistema"; Filename: "{app}\Manutencao.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 21
Name: "{group}\Desinstalar {#Nome}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Emitir NFS-e"; Filename: "{app}\{#ExeAtalho}"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70; Tasks: atalhoDesktop

[Tasks]
Name: "atalhoDesktop"; Description: "Criar atalho na area de trabalho"; GroupDescription: "Atalhos:"
; Marcado por padrao, e de proposito: sem isto o gateway so roda quando alguem
; abre o atalho -- e um cliente que manda mensagem depois de um reinicio nao
; recebe resposta, sem erro e sem aviso. O backup diario tambem so acontece
; nos dias em que alguem abriu o programa.
Name: "inicioAutomatico"; Description: "Iniciar o gateway junto com o Windows (recomendado)"; GroupDescription: "Funcionamento:"

[Dirs]
; Dados e backups ficam graváveis por quem usa: sem isso o gateway instalado em
; Arquivos de Programas nao consegue gravar o backup diario.
Name: "{app}\backups"; Permissions: users-modify
Name: "{app}\logs"; Permissions: users-modify
Name: "{app}\postgres"; Permissions: users-modify

[Run]
; Registra o servico do banco e a tarefa do gateway. O instalador ja roda
; elevado, entao e aqui que isso custa zero para quem instala.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\servico-windows.ps1"" instalar -Pasta ""{app}"" -Node ""{app}\node\node.exe"""; StatusMsg: "Configurando o inicio automatico..."; Flags: runhidden waituntilterminated; Tasks: inicioAutomatico
Filename: "{app}\{#ExeAtalho}"; Description: "Abrir o gateway agora"; Flags: postinstall shellexec skipifsilent; Tasks: not inicioAutomatico

[UninstallRun]
; Para o banco antes de apagar os arquivos, senao o Windows recusa a remocao
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command "". '{app}\postgres-local.ps1'; Stop-PostgresLocal '{app}' | Out-Null"""; Flags: runhidden; RunOnceId: "PararBanco"

[Code]
var
  PaginaBanco: TInputOptionWizardPage;
  PaginaBancoUrl: TInputQueryWizardPage;
  PaginaUsuario: TInputQueryWizardPage;
  PaginaMigracao: TInputFileWizardPage;
  PaginaMigracaoSenha: TInputQueryWizardPage;
  CaixaMigracao: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  { --- Onde ficam os dados --- }
  PaginaBanco := CreateInputOptionPage(wpSelectTasks,
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

  { --- Migracao de outra maquina --- }
  CaixaMigracao := CreateInputOptionPage(PaginaBancoUrl.ID,
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

  { --- Primeiro acesso --- }
  PaginaUsuario := CreateInputQueryPage(PaginaMigracaoSenha.ID,
    'Acesso ao sistema',
    'Quem vai administrar o gateway?',
    'E com este e-mail e senha que se entra no sistema. Voce pode cadastrar mais pessoas depois.');
  PaginaUsuario.Add('Nome:', False);
  PaginaUsuario.Add('E-mail:', False);
  PaginaUsuario.Add('Senha (minimo 8 caracteres):', True);
  PaginaUsuario.Add('Repita a senha:', True);
end;

function BancoLocal: Boolean;
begin
  Result := PaginaBanco.SelectedValueIndex = 0;
end;

function VaiMigrar: Boolean;
begin
  Result := CaixaMigracao.SelectedValueIndex = 1;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { Endereco do banco so importa se nao for local }
  if PageID = PaginaBancoUrl.ID then
    Result := BancoLocal;
  { Arquivo e senha so quando esta migrando }
  if (PageID = PaginaMigracao.ID) or (PageID = PaginaMigracaoSenha.ID) then
    Result := not VaiMigrar;
  { Migrando, o usuario vem junto no pacote — nao ha o que criar }
  if PageID = PaginaUsuario.ID then
    Result := VaiMigrar;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Endereco, Email, Senha: String;
begin
  Result := True;

  if (CurPageID = PaginaBancoUrl.ID) and not BancoLocal then
  begin
    Endereco := Trim(PaginaBancoUrl.Values[0]);
    if (Pos('postgresql://', Endereco) <> 1) and (Pos('postgres://', Endereco) <> 1) then
    begin
      MsgBox('O endereco deve comecar com postgresql://', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if (CurPageID = PaginaMigracao.ID) and VaiMigrar then
  begin
    if not FileExists(PaginaMigracao.Values[0]) then
    begin
      MsgBox('Selecione o arquivo de migracao.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if (CurPageID = PaginaMigracaoSenha.ID) and VaiMigrar then
  begin
    if Length(PaginaMigracaoSenha.Values[0]) < 1 then
    begin
      MsgBox('Informe a senha do arquivo de migracao.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if (CurPageID = PaginaUsuario.ID) and not VaiMigrar then
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

{ Monta a linha de comando do configurar.ps1 com o que foi respondido. }
function ParametrosConfiguracao: String;
var
  P: String;
begin
  P := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\configurar.ps1') + '"' +
       ' -Raiz "' + ExpandConstant('{app}') + '"';

  if not BancoLocal then
    P := P + ' -BancoUrl "' + PaginaBancoUrl.Values[0] + '"';

  if VaiMigrar then
    P := P + ' -ArquivoMigracao "' + PaginaMigracao.Values[0] + '"' +
             ' -SenhaMigracao "' + PaginaMigracaoSenha.Values[0] + '"'
  else
    P := P + ' -NomeUsuario "' + PaginaUsuario.Values[0] + '"' +
             ' -EmailUsuario "' + PaginaUsuario.Values[1] + '"' +
             ' -SenhaUsuario "' + PaginaUsuario.Values[2] + '"';

  Result := P;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Codigo: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Preparando o banco de dados e o acesso...';
    if not Exec('powershell.exe', ParametrosConfiguracao, '', SW_HIDE, ewWaitUntilTerminated, Codigo) then
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
