# Faz o gateway subir sozinho com o Windows.
#
# Ate 27/08/2026 o gateway era um atalho na area de trabalho. Quem operava
# precisava lembrar de abri-lo, e as consequencias eram silenciosas:
#
#   - o WhatsApp so respondia enquanto alguem deixava a janela aberta. Maquina
#     reiniciada de madrugada por atualizacao do Windows, cliente manda "oi" as
#     8h, e nada acontece. Sem erro, sem aviso, sem registro.
#   - o backup diario so rodava nos dias em que o gateway estava aberto. Da para
#     ver na pasta backups/: existem em 19, 20 e 26 de agosto, faltam em 21, 23,
#     25 e 27.
#   - o tunel cai junto, e a Meta nao alcanca mais o webhook.
#
# Sao DUAS pecas, e as duas fazem falta:
#
#   1. o Postgres portatil vira servico do Windows. Quem o subia era o
#      `garantir-banco.js`, um hook de `prestart` do npm que a tarefa nao
#      executa -- depois de um reinicio o gateway subia sem banco, em silencio.
#      Servico e nao "a tarefa sobe o banco" porque no Windows o postgres.exe
#      se recusa a rodar sob conta administrativa, e a excecao e justamente
#      quando quem inicia e o Gerenciador de Servicos.
#
#   2. o gateway vira tarefa agendada. O Node nao vira servico sozinho, e um
#      servico de verdade exigiria um programa a mais so para embrulhar o
#      processo -- a peca extra que este projeto vem tirando do caminho. A
#      tarefa faz o mesmo com o que ja vem no Windows: sobe na inicializacao,
#      roda sem ninguem logado, e reinicia se cair. Ela chama
#      `scripts\iniciar.js`, que espera o banco atender antes de subir.
#
# Uso (PowerShell como Administrador):
#   .\scripts\servico-windows.ps1 instalar
#   .\scripts\servico-windows.ps1 situacao
#   .\scripts\servico-windows.ps1 parar
#   .\scripts\servico-windows.ps1 iniciar
#   .\scripts\servico-windows.ps1 remover

param(
    [Parameter(Position = 0)]
    [ValidateSet('instalar', 'remover', 'situacao', 'iniciar', 'parar')]
    [string]$Acao = 'situacao',

    # Pasta do gateway. Por padrao, a pasta acima desta.
    [string]$Pasta,

    # Node a usar. Por padrao, o do PATH; o instalador passa o que vem no pacote.
    [string]$Node
)

$ErrorActionPreference = 'Stop'
$NomeTarefa = 'NFS-e Gateway'
$NomeServicoBanco = 'nfse-postgres'

if (-not $Pasta) { $Pasta = Split-Path -Parent $PSScriptRoot }
if (-not $Node) {
    $doPacote = Join-Path $Pasta 'node\node.exe'
    if (Test-Path $doPacote) { $Node = $doPacote }
    else {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $cmd) { throw "Nao encontrei o node.exe. Passe -Node com o caminho completo." }
        $Node = $cmd.Source
    }
}

function Titulo($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  [!]  $t" -ForegroundColor Yellow }

function EhAdministrador {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ExigirAdministrador {
    if (-not (EhAdministrador)) {
        throw "Esta acao precisa de PowerShell aberto como Administrador. " +
              "Clique com o botao direito no PowerShell e escolha 'Executar como administrador'."
    }
}

function TarefaAtual { Get-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue }

# ------------------------------------------------------------------ instalar

<#
  O Postgres portatil do gateway como servico.

  Sem isto, depois de um reinicio o banco simplesmente nao esta rodando: quem o
  subia era o `garantir-banco.js`, um hook de `prestart` do npm que a tarefa nao
  executa. O gateway subia sem banco, em silencio.

  Servico e nao "a tarefa sobe o banco": no Windows o postgres.exe se recusa a
  rodar sob conta administrativa, e a tarefa roda como SYSTEM. A excecao e
  quando quem inicia e o Gerenciador de Servicos -- que e como as outras
  instalacoes de Postgres desta maquina ja funcionam.
#>
function InstalarBanco {
    $raizPg = Join-Path $Pasta 'instalador\postgres'
    if (-not (Test-Path (Join-Path $raizPg 'pgsql\bin\pg_ctl.exe'))) {
        $raizPg = Join-Path $Pasta 'postgres'
    }
    $pgCtl = Join-Path $raizPg 'pgsql\bin\pg_ctl.exe'
    $dados = Join-Path $raizPg 'dados'

    if (-not (Test-Path $pgCtl)) {
        Aviso "sem Postgres portatil nesta pasta - banco externo, nada a registrar"
        return
    }
    if (-not (Test-Path $dados)) { throw "Achei o pg_ctl mas nao a pasta de dados em $dados." }

    if (Get-Service -Name $NomeServicoBanco -ErrorAction SilentlyContinue) {
        Ok "servico do banco '$NomeServicoBanco' ja existe"
    } else {
        # A porta escolhida na instalacao fica ao lado dos dados.
        $arqPorta = Join-Path $raizPg 'porta.txt'
        $porta = if (Test-Path $arqPorta) { (Get-Content $arqPorta -Raw).Trim() } else { '5433' }

        Titulo "Registrando o banco como servico"
        Write-Host "  dados: $dados"
        Write-Host "  porta: $porta"
        & $pgCtl register -N $NomeServicoBanco -D $dados -S auto -w -o "-p $porta"
        if ($LASTEXITCODE -ne 0) { throw "pg_ctl register falhou (codigo $LASTEXITCODE)." }
        Ok "servico '$NomeServicoBanco' registrado (inicio automatico)"
    }

    $svc = Get-Service -Name $NomeServicoBanco
    if ($svc.Status -ne 'Running') {
        # Se o Postgres ja estiver de pe pelo garantir-banco.js, a porta esta
        # ocupada e o servico nao sobe. Para o avulso antes.
        & $pgCtl status -D $dados > $null 2>&1
        if ($LASTEXITCODE -eq 0) {
            Aviso "havia um Postgres avulso rodando; parando para o servico assumir"
            & $pgCtl stop -D $dados -m fast -w > $null 2>&1
            Start-Sleep -Seconds 2
        }
        Start-Service -Name $NomeServicoBanco
        Ok "servico do banco iniciado"
    } else {
        Ok "servico do banco ja estava rodando"
    }
}

function Instalar {
    ExigirAdministrador

    InstalarBanco

    $servidor = Join-Path $Pasta 'scripts\iniciar.js'
    if (-not (Test-Path $servidor)) { throw "Nao achei $servidor. Use -Pasta com a pasta do gateway." }
    if (-not (Test-Path $Node))     { throw "Nao achei o node em $Node." }

    Titulo "Registrando a tarefa"
    Write-Host "  pasta: $Pasta"
    Write-Host "  node:  $Node"

    if (TarefaAtual) {
        Aviso "ja existia; substituindo"
        Unregister-ScheduledTask -TaskName $NomeTarefa -Confirm:$false
    }

    # scripts\iniciar.js e nao src\server.js: ele espera o banco atender antes
    # de subir. A tarefa e o servico do Postgres disparam juntos na
    # inicializacao e nao ha garantia de quem chega primeiro -- gateway sem
    # banco fica inutil em silencio, que e o que se quer evitar aqui.
    $acaoTarefa = New-ScheduledTaskAction -Execute $Node `
        -Argument 'scripts\iniciar.js' -WorkingDirectory $Pasta

    # Na inicializacao do Windows, sem depender de alguem fazer login.
    $gatilho = New-ScheduledTaskTrigger -AtStartup

    # SYSTEM: nao guarda senha de ninguem, e sobrevive a troca de senha do
    # usuario -- que numa maquina de escritorio acontece.
    $conta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount `
        -RunLevel Highest

    <#
      ExecutionTimeLimit 0: e um processo que fica de pe, nao uma rotina que
      termina. Sem isso o Windows o mata depois de 3 dias.
      RestartCount/RestartInterval: caiu, sobe de novo em 1 minuto.
      DontStopOnIdleEnd / DontStopIfGoingOnBatteries: notebook do escritorio
      nao pode parar de emitir nota porque saiu da tomada.
    #>
    $opcoes = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $NomeTarefa -Action $acaoTarefa `
        -Trigger $gatilho -Principal $conta -Settings $opcoes `
        -Description ('Mantem o gateway NFS-e no ar: emissao, backup diario, ' +
                      'repassador do WhatsApp e tunel.') | Out-Null
    Ok "tarefa '$NomeTarefa' registrada"

    Start-ScheduledTask -TaskName $NomeTarefa
    Ok "iniciada"

    Titulo "Conferindo"
    $fim = (Get-Date).AddSeconds(40)
    do {
        Start-Sleep -Seconds 2
        try {
            $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) {
                Ok "o gateway respondeu em http://127.0.0.1:3000"
                Write-Host "`n  A partir de agora ele sobe junto com o Windows." -ForegroundColor Green
                Write-Host "  Reinicie a maquina uma vez para confirmar: e o unico teste que vale.`n"
                return
            }
        } catch { }
    } while ((Get-Date) -lt $fim)

    Aviso "a tarefa foi registrada, mas o gateway nao respondeu em 40s."
    Write-Host "  Veja o log em $Pasta\logs e rode: .\scripts\servico-windows.ps1 situacao"
}

# ------------------------------------------------------------------- remover

function Remover {
    ExigirAdministrador
    if (TarefaAtual) {
        Stop-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $NomeTarefa -Confirm:$false
        Ok "tarefa removida. O gateway volta a depender de alguem abrir o atalho."
    } else { Aviso "nao havia tarefa registrada" }

    # O servico do banco fica: remove-lo apagaria o acesso aos dados de quem
    # ainda quiser abrir o gateway pelo atalho. Quem quiser tirar:
    #   pg_ctl unregister -N nfse-postgres
    if (Get-Service -Name $NomeServicoBanco -ErrorAction SilentlyContinue) {
        Write-Host "  o servico '$NomeServicoBanco' foi mantido (o banco continua acessivel)."
    }
}

# ------------------------------------------------------------------ situacao

function Situacao {
    Titulo "A tarefa"
    $t = TarefaAtual
    if (-not $t) {
        Aviso "NAO registrada - o gateway so roda quando alguem abre o atalho"
        Write-Host "     Isso significa: WhatsApp mudo depois de um reinicio, e backup"
        Write-Host "     diario so nos dias em que alguem abriu o programa."
        Write-Host "     Para resolver:  .\scripts\servico-windows.ps1 instalar"
    } else {
        Ok "registrada - estado: $($t.State)"
        $i = Get-ScheduledTaskInfo -TaskName $NomeTarefa
        Write-Host "     ultima execucao: $($i.LastRunTime)  (resultado $($i.LastTaskResult))"
        Write-Host "     proxima:         $($i.NextRunTime)"
    }

    Titulo "O banco"
    $svc = Get-Service -Name $NomeServicoBanco -ErrorAction SilentlyContinue
    if (-not $svc) {
        Aviso "o Postgres do gateway NAO e um servico"
        Write-Host "     Depois de um reinicio ele nao sobe, e o gateway fica sem banco."
        Write-Host "     Para resolver:  .\scripts\servico-windows.ps1 instalar"
    } elseif ($svc.Status -ne 'Running') {
        Aviso "servico '$NomeServicoBanco' registrado, mas parado ($($svc.Status))"
    } else {
        Ok "servico '$NomeServicoBanco' rodando"
    }

    Titulo "O gateway"
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -TimeoutSec 4 -UseBasicParsing
        Ok "respondendo (HTTP $($r.StatusCode))"
    } catch {
        Aviso "nao respondeu em http://127.0.0.1:3000/health"
    }

    Titulo "O backup"
    $pastaBkp = Join-Path $Pasta 'backups'
    if (Test-Path $pastaBkp) {
        $ultimo = Get-ChildItem $pastaBkp -Filter 'nfse-backup-*.json' |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($ultimo) {
            $dias = [int]((Get-Date) - $ultimo.LastWriteTime).TotalDays
            if ($dias -le 1) { Ok "ultimo em $($ultimo.LastWriteTime)" }
            else { Aviso "ultimo backup tem $dias dia(s): $($ultimo.LastWriteTime)" }
        } else { Aviso "nenhum backup na pasta" }
    } else { Aviso "pasta backups/ nao existe" }
    Write-Host ""
}

function Iniciar { ExigirAdministrador; Start-ScheduledTask -TaskName $NomeTarefa; Ok "iniciada" }
function Parar   { ExigirAdministrador; Stop-ScheduledTask  -TaskName $NomeTarefa; Ok "parada" }

switch ($Acao) {
    'instalar' { Instalar }
    'remover'  { Remover }
    'situacao' { Situacao }
    'iniciar'  { Iniciar }
    'parar'    { Parar }
}
