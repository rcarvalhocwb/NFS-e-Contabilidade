# ---------------------------------------------------------------------------
# Configuracao pos-instalacao, chamada pelo instalador .exe.
#
# Recebe tudo por parametro e nao faz pergunta nenhuma: quem pergunta e o
# assistente do instalador, com as telas do Windows. Aqui so se executa.
#
# Escreve o andamento em configuracao.log, dentro da pasta do gateway: se algo
# falhar, e nesse arquivo que esta o motivo.
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory=$true)][string]$Raiz,
    [string]$BancoUrl,                  # vazio = instalar o banco local
    [string]$NomeUsuario,
    [string]$EmailUsuario,
    [string]$SenhaUsuario,
    [string]$ArquivoMigracao,
    [string]$SenhaMigracao
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $Raiz 'configuracao.log'

function Registrar($texto) {
    $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $texto"
    Add-Content -Path $log -Value $linha -Encoding utf8
    Write-Host $texto
}

function Falhar($texto) {
    Registrar "ERRO: $texto"
    exit 1
}

$node = Join-Path $Raiz 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

Registrar "=== Configurando o NFS-e Gateway ==="
Registrar "pasta: $Raiz"

# ------------------------------------------------------------ 1. banco

$instalarLocal = [string]::IsNullOrWhiteSpace($BancoUrl)

if ($instalarLocal) {
    Registrar "Banco: nesta maquina"
    . (Join-Path $Raiz 'postgres-local.ps1')

    if (-not (Test-PgInstalado $Raiz)) {
        Registrar "Baixando o PostgreSQL..."
        if (-not (Install-PostgresLocal $Raiz)) { Falhar "nao consegui obter o PostgreSQL" }
    }

    $senhaBanco = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
    if (-not (Initialize-PostgresLocal $Raiz $senhaBanco)) { Falhar "falha ao preparar o banco" }
    if (-not (Start-PostgresLocal $Raiz)) { Falhar "o banco nao quis iniciar (veja postgres\postgres.log)" }
    if (-not (New-BancoNfse $Raiz $senhaBanco)) { Falhar "falha ao criar o banco 'nfse'" }

    $BancoUrl = Get-UrlBancoLocal $Raiz $senhaBanco
    Registrar "Banco local pronto na porta $(Get-PgPorta $Raiz)"
} else {
    Registrar "Banco: servidor informado pelo usuario"
}

# -------------------------------------------------------------- 2. .env

$envPath = Join-Path $Raiz '.env'
if (Test-Path $envPath) {
    Registrar ".env ja existe - mantido"
} else {
    # Chaves geradas nesta maquina. A MASTER_KEY cifra o certificado A1: se ela
    # se perder, o certificado guardado nao abre mais.
    $chaveApi = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
    $chaveMestra = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })

    $conteudo = @"
# Gerado pelo instalador em $(Get-Date -Format 'dd/MM/yyyy HH:mm')
PORT=3000
DATABASE_URL=$BancoUrl
GATEWAY_API_KEY=$chaveApi
MASTER_KEY=$chaveMestra
VER_APLIC=nfse-gateway/1.0
XML_SIG_ALG=sha1
GATEWAY_BASE_URL=http://localhost:3000
"@
    # UTF8 sem BOM: o dotnet grava BOM por padrao e o dotenv leria a primeira
    # chave com lixo no nome.
    [System.IO.File]::WriteAllText($envPath, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
    Registrar ".env criado"
}

# --------------------------------------------------------- 3. migrations

Push-Location $Raiz
try {
    Registrar "Preparando as tabelas..."
    $saida = & $node scripts/migrate.js 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Falhar "migracao do banco falhou: $saida" }
    Registrar "Tabelas prontas"
} finally { Pop-Location }

# ------------------------------------------------- 4. migracao ou usuario

Push-Location $Raiz
try {
    if (-not [string]::IsNullOrWhiteSpace($ArquivoMigracao)) {
        Registrar "Importando dados de outra instalacao..."
        $env:NFSE_SENHA_MIGRACAO = $SenhaMigracao
        $saida = & $node scripts/importar-migracao.js "$ArquivoMigracao" 2>&1 | Out-String
        $env:NFSE_SENHA_MIGRACAO = $null
        if ($LASTEXITCODE -ne 0) { Falhar "importacao falhou: $saida" }
        Registrar "Dados importados - use o mesmo email e senha da maquina anterior"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($EmailUsuario)) {
        Registrar "Criando o acesso de $EmailUsuario..."
        $env:NFSE_SENHA = $SenhaUsuario
        $saida = & $node scripts/criar-usuario.js --nome "$NomeUsuario" --email "$EmailUsuario" 2>&1 | Out-String
        $env:NFSE_SENHA = $null
        if ($LASTEXITCODE -ne 0) { Falhar "nao consegui criar o acesso: $saida" }
        Registrar "Acesso criado"
    }
} finally { Pop-Location }

Registrar "=== Concluido ==="
exit 0
