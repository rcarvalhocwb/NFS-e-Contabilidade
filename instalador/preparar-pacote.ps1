# ---------------------------------------------------------------------------
# Monta a pasta que o instalador .exe vai empacotar.
#
# Junta tudo que o gateway precisa para rodar numa maquina limpa:
#   - o codigo e as dependencias (node_modules de producao)
#   - o Node.js portatil, para nao exigir que a contabilidade instale nada
#   - o PostgreSQL portatil, pelo mesmo motivo
#
# O resultado vai para instalador\pacote\, e o Inno Setup compila a partir dali.
#
# Uso:  .\preparar-pacote.ps1              (baixa o que faltar)
#       .\preparar-pacote.ps1 -SemBanco    (sem PostgreSQL; o instalador baixa)
# ---------------------------------------------------------------------------
param([switch]$SemBanco)

$ErrorActionPreference = 'Stop'

$raizInstalador = $PSScriptRoot
$raizProjeto    = Split-Path $raizInstalador -Parent
$pacote         = Join-Path $raizInstalador 'pacote'

$NODE_VERSAO = '22.11.0'   # LTS

function Titulo($t) { Write-Host ""; Write-Host "  $t" -ForegroundColor Cyan; Write-Host ("  " + ("-" * $t.Length)) -ForegroundColor DarkGray }
function Ok($t)     { Write-Host "  [ok] $t" -ForegroundColor Green }

# ---------------------------------------------------------------- 1. limpeza

Titulo "1. Preparando a pasta"
if (Test-Path $pacote) { Remove-Item $pacote -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pacote | Out-Null
Ok "pacote/ limpo"

# ------------------------------------------------------------------ 2. app

Titulo "2. Copiando o gateway"

$incluir = @('src', 'migrations', 'scripts', 'package.json', 'package-lock.json', '.env.example')
foreach ($item in $incluir) {
    $origem = Join-Path $raizProjeto $item
    if (-not (Test-Path $origem)) { throw "nao encontrei $item" }
    Copy-Item $origem -Destination $pacote -Recurse -Force
}

# node_modules so de producao: as de desenvolvimento nao vao para a maquina
# da contabilidade e o instalador fica bem menor.
Titulo "3. Instalando dependencias de producao"
$temp = Join-Path $env:TEMP ("nfse-build-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
    Copy-Item (Join-Path $raizProjeto 'package.json') $temp
    Copy-Item (Join-Path $raizProjeto 'package-lock.json') $temp -ErrorAction SilentlyContinue
    Push-Location $temp
    npm install --omit=dev --no-fund --no-audit --silent 2>&1 | Out-Null
    Pop-Location
    Copy-Item (Join-Path $temp 'node_modules') -Destination $pacote -Recurse -Force
    $qtd = (Get-ChildItem (Join-Path $pacote 'node_modules') -Directory).Count
    Ok "$qtd pacotes"
} finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ 4. node

Titulo "4. Node.js portatil"
$nodeDestino = Join-Path $pacote 'node'
$nodeZip = Join-Path $env:TEMP "node-v$NODE_VERSAO-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NODE_VERSAO/node-v$NODE_VERSAO-win-x64.zip"

if (-not (Test-Path $nodeZip)) {
    Write-Host "  Baixando Node $NODE_VERSAO (cerca de 30 MB)..."
    $anterior = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing -TimeoutSec 900
    $ProgressPreference = $anterior
}
$tempNode = Join-Path $env:TEMP ("node-extract-" + [guid]::NewGuid().ToString('N').Substring(0,8))
Expand-Archive -Path $nodeZip -DestinationPath $tempNode -Force
New-Item -ItemType Directory -Force -Path $nodeDestino | Out-Null
# So o runtime: npm e docs nao sao usados em producao e pesam mais que o resto
Copy-Item (Join-Path $tempNode "node-v$NODE_VERSAO-win-x64\node.exe") $nodeDestino
Remove-Item $tempNode -Recurse -Force
Ok "node.exe embutido ($([math]::Round((Get-Item (Join-Path $nodeDestino 'node.exe')).Length / 1MB, 1)) MB)"

# --------------------------------------------------------------- 5. postgres

if ($SemBanco) {
    Titulo "5. PostgreSQL"
    Write-Host "  Pulado (-SemBanco): o instalador vai baixar na maquina de destino." -ForegroundColor DarkGray
} else {
    Titulo "5. PostgreSQL portatil"
    . (Join-Path $raizInstalador 'postgres-local.ps1')
    $pgOrigem = Join-Path $raizInstalador 'postgres\pgsql'
    if (-not (Test-Path $pgOrigem)) {
        Write-Host "  Baixando..."
        if (-not (Install-PostgresLocal $raizInstalador)) { throw "falha ao baixar o PostgreSQL" }
    }
    $pgDestino = Join-Path $pacote 'postgres'
    New-Item -ItemType Directory -Force -Path $pgDestino | Out-Null
    # So o necessario para rodar: doc, include e pgAdmin dobrariam o tamanho
    foreach ($sub in @('bin', 'lib', 'share')) {
        $o = Join-Path $pgOrigem $sub
        if (Test-Path $o) { Copy-Item $o -Destination (Join-Path $pgDestino 'pgsql') -Recurse -Force }
    }
    Ok "PostgreSQL embutido"
}

# ------------------------------------------------------------- 6. auxiliares

Titulo "6. Arquivos de apoio"
Copy-Item (Join-Path $raizInstalador 'postgres-local.ps1') $pacote -Force
Copy-Item (Join-Path $raizInstalador 'LEIA-ME.txt') $pacote -Force
Ok "copiados"

# ------------------------------------------------------------- 7. versao

# A versao vem do package.json e de nenhum outro lugar. Mantida a mao nos dois,
# ela diverge: o instalador ja anunciou 1.1.0 enquanto o sistema se dizia
# 1.0.0 — e e a versao do sistema que o verificador de atualizacoes compara
# com a release publicada. Divergir ali significa avisar de atualizacao que
# nao existe, ou nao avisar da que existe.
Titulo "7. Versao"
$versao = (Get-Content (Join-Path $raizProjeto 'package.json') -Raw | ConvertFrom-Json).version
if (-not $versao) { throw "package.json sem campo version" }
"#define Versao `"$versao`"" | Out-File (Join-Path $raizInstalador 'versao.iss') -Encoding utf8
Ok "versao $versao gravada em versao.iss"

$tamanho = [math]::Round((Get-ChildItem $pacote -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ""
Write-Host "  Pacote pronto: $pacote ($tamanho MB)" -ForegroundColor Green
Write-Host "  Agora compile o instalador:" -ForegroundColor DarkGray
Write-Host "     & '${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe' '$raizInstalador\nfse-gateway.iss'" -ForegroundColor DarkGray
Write-Host ""
