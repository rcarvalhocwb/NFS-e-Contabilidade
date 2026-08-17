# ---------------------------------------------------------------------------
# Postgres local para o NFS-e Gateway.
#
# Escrito sem acentos de proposito: o console do Windows le em codepage legada
# e caracteres acentuados podem quebrar a execucao.
#
# Usa os binarios portateis oficiais do PostgreSQL, sem instalador e sem
# privilegio de administrador: tudo fica dentro da pasta do gateway, e
# desinstalar e apagar a pasta.
#
# Porta 5433 de proposito: se a maquina ja tiver um Postgres em 5432, os dois
# convivem sem conflito.
# ---------------------------------------------------------------------------

$PG_VERSAO   = '16.4-1'
$PG_PORTA    = 5433
$PG_BANCO    = 'nfse'
$PG_USUARIO  = 'nfse'

function Get-PgRaiz    { param($raiz) Join-Path $raiz 'postgres' }
function Get-PgBin     { param($raiz) Join-Path (Get-PgRaiz $raiz) 'pgsql\bin' }
function Get-PgDados   { param($raiz) Join-Path (Get-PgRaiz $raiz) 'dados' }
function Get-PgLog     { param($raiz) Join-Path (Get-PgRaiz $raiz) 'postgres.log' }

function Test-PgInstalado {
    param($raiz)
    Test-Path (Join-Path (Get-PgBin $raiz) 'pg_ctl.exe')
}

function Test-PgRodando {
    param($raiz)
    if (-not (Test-PgInstalado $raiz)) { return $false }
    $pgCtl = Join-Path (Get-PgBin $raiz) 'pg_ctl.exe'
    & $pgCtl -D (Get-PgDados $raiz) status *> $null
    return ($LASTEXITCODE -eq 0)
}

# --------------------------------------------------------------- instalacao

function Install-PostgresLocal {
    param($raiz)

    $pgRaiz = Get-PgRaiz $raiz
    if (Test-PgInstalado $raiz) {
        Write-Host "  Postgres local ja esta instalado." -ForegroundColor DarkGray
        return $true
    }

    New-Item -ItemType Directory -Force -Path $pgRaiz | Out-Null
    $zip = Join-Path $pgRaiz 'postgres.zip'
    $url = "https://get.enterprisedb.com/postgresql/postgresql-$PG_VERSAO-windows-x64-binaries.zip"

    Write-Host "  Baixando o banco de dados (cerca de 300 MB, so desta vez)..."
    Write-Host "  Isso pode levar alguns minutos." -ForegroundColor DarkGray
    try {
        # ProgressPreference silencioso: a barra do Invoke-WebRequest deixa o
        # download varias vezes mais lento em arquivos grandes.
        $anterior = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 1800
        $ProgressPreference = $anterior
    } catch {
        Write-Host "  [X] Nao consegui baixar o PostgreSQL." -ForegroundColor Red
        Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray
        return $false
    }

    Write-Host "  Extraindo..."
    try {
        Expand-Archive -Path $zip -DestinationPath $pgRaiz -Force
        Remove-Item $zip -Force
    } catch {
        Write-Host "  [X] Nao consegui extrair o arquivo baixado." -ForegroundColor Red
        return $false
    }

    if (-not (Test-PgInstalado $raiz)) {
        Write-Host "  [X] Os binarios nao apareceram onde eu esperava." -ForegroundColor Red
        return $false
    }
    return $true
}

function Initialize-PostgresLocal {
    param($raiz, $senha)

    $dados = Get-PgDados $raiz
    if (Test-Path (Join-Path $dados 'PG_VERSION')) {
        Write-Host "  Banco de dados ja inicializado." -ForegroundColor DarkGray
        return $true
    }

    $bin = Get-PgBin $raiz
    # A senha vai por arquivo temporario: como argumento ficaria visivel na
    # lista de processos da maquina.
    $arquivoSenha = Join-Path $env:TEMP ("pgsenha-" + [guid]::NewGuid().ToString('N') + ".txt")
    try {
        Set-Content -Path $arquivoSenha -Value $senha -Encoding ascii -NoNewline

        Write-Host "  Preparando o banco de dados..."
        & (Join-Path $bin 'initdb.exe') `
            -D $dados -U $PG_USUARIO --pwfile=$arquivoSenha `
            -E UTF8 --locale=C --auth-local=scram-sha-256 --auth-host=scram-sha-256 *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [X] Falha ao preparar o banco." -ForegroundColor Red
            return $false
        }
    } finally {
        if (Test-Path $arquivoSenha) { Remove-Item $arquivoSenha -Force }
    }

    # So aceita conexao da propria maquina. O gateway nao e exposto na rede e
    # o banco tambem nao precisa ser.
    Set-Content -Path (Join-Path $dados 'postgresql.conf') -Encoding ascii -Value @"
listen_addresses = '127.0.0.1'
port = $PG_PORTA
max_connections = 50
shared_buffers = 128MB
log_destination = 'stderr'
logging_collector = off
datestyle = 'iso, dmy'
timezone = 'America/Sao_Paulo'
"@

    Set-Content -Path (Join-Path $dados 'pg_hba.conf') -Encoding ascii -Value @"
# Somente localhost, sempre com senha.
local   all   all                  scram-sha-256
host    all   all   127.0.0.1/32   scram-sha-256
host    all   all   ::1/128        scram-sha-256
"@

    return $true
}

# ------------------------------------------------------------------ controle

function Start-PostgresLocal {
    param($raiz)

    if (-not (Test-PgInstalado $raiz)) { return $false }
    if (Test-PgRodando $raiz) { return $true }

    $pgCtl = Join-Path (Get-PgBin $raiz) 'pg_ctl.exe'
    & $pgCtl -D (Get-PgDados $raiz) -l (Get-PgLog $raiz) -w -t 30 start *> $null
    return (Test-PgRodando $raiz)
}

function Stop-PostgresLocal {
    param($raiz)

    if (-not (Test-PgRodando $raiz)) { return $true }
    $pgCtl = Join-Path (Get-PgBin $raiz) 'pg_ctl.exe'
    # -m fast: encerra conexoes abertas mas conclui o que esta gravando. O
    # modo 'immediate' exigiria recuperacao no proximo start.
    & $pgCtl -D (Get-PgDados $raiz) -m fast -w -t 30 stop *> $null
    return ($LASTEXITCODE -eq 0)
}

function New-BancoNfse {
    param($raiz, $senha)

    $env:PGPASSWORD = $senha
    try {
        $psql = Join-Path (Get-PgBin $raiz) 'psql.exe'
        $existe = & $psql -h 127.0.0.1 -p $PG_PORTA -U $PG_USUARIO -d postgres -tAc `
                  "SELECT 1 FROM pg_database WHERE datname='$PG_BANCO'" 2>$null
        if ($existe -ne '1') {
            & $psql -h 127.0.0.1 -p $PG_PORTA -U $PG_USUARIO -d postgres -c `
                    "CREATE DATABASE $PG_BANCO" *> $null
            if ($LASTEXITCODE -ne 0) { return $false }
        }
        return $true
    } finally {
        $env:PGPASSWORD = $null
    }
}

function Get-UrlBancoLocal {
    param($senha)
    # A senha vai codificada: caracteres como @ e : quebrariam a URL.
    $senhaUrl = [uri]::EscapeDataString($senha)
    return "postgresql://${PG_USUARIO}:${senhaUrl}@127.0.0.1:${PG_PORTA}/${PG_BANCO}"
}
