# Instalador do NFS-e Gateway para Windows.
#
# Escrito para ser executado por quem não é técnico: cada passo explica o que
# está acontecendo, valida o que consegue e para com uma mensagem clara quando
# algo falta. Não instala nada fora da pasta do gateway, exceto os atalhos.
#
# Uso: clique direito neste arquivo > "Executar com o PowerShell"

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot

function Titulo($texto) {
    Write-Host ""
    Write-Host "  $texto" -ForegroundColor Cyan
    Write-Host "  $('-' * $texto.Length)" -ForegroundColor DarkGray
}
function Ok($texto)    { Write-Host "  [OK] $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "  [!]  $texto" -ForegroundColor Yellow }
function Erro($texto)  { Write-Host "  [X]  $texto" -ForegroundColor Red }

Clear-Host
Write-Host ""
Write-Host "  ===============================================" -ForegroundColor Cyan
Write-Host "     NFS-e Gateway - Instalacao" -ForegroundColor Cyan
Write-Host "  ===============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Este assistente prepara o gateway para emitir notas nesta maquina."
Write-Host "  Leva cerca de 2 minutos."

# --------------------------------------------------------------- 1. Node.js
Titulo "1 de 5 - Verificando o Node.js"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Erro "O Node.js nao esta instalado."
    Write-Host ""
    Write-Host "  O gateway precisa do Node.js para funcionar." -ForegroundColor White
    Write-Host "  Baixe a versao LTS em: " -NoNewline; Write-Host "https://nodejs.org" -ForegroundColor Cyan
    Write-Host "  Instale, feche esta janela e execute este arquivo novamente."
    Write-Host ""
    Read-Host "  Pressione Enter para sair"
    exit 1
}
$versao = (node --version) -replace 'v',''
$maior = [int]($versao -split '\.')[0]
if ($maior -lt 18) {
    Erro "Node.js $versao e muito antigo (o gateway precisa da versao 18 ou superior)."
    Write-Host "  Atualize em: " -NoNewline; Write-Host "https://nodejs.org" -ForegroundColor Cyan
    Read-Host "  Pressione Enter para sair"
    exit 1
}
Ok "Node.js $versao encontrado"

# ---------------------------------------------------------- 2. dependencias
Titulo "2 de 5 - Instalando os componentes"
Write-Host "  Isso pode levar um minuto..."

Push-Location $raiz
try {
    $saida = npm install --omit=dev --no-fund --no-audit 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $saida }
    Ok "Componentes instalados"
} catch {
    Erro "Falha ao instalar os componentes."
    Write-Host "  Verifique a conexao com a internet e tente de novo."
    Write-Host ""
    Write-Host $_ -ForegroundColor DarkGray
    Pop-Location
    Read-Host "  Pressione Enter para sair"
    exit 1
}
Pop-Location

# -------------------------------------------------------------- 3. .env
Titulo "3 de 5 - Configuracao"

$envPath = Join-Path $raiz '.env'
if (Test-Path $envPath) {
    Ok "Configuracao ja existe (.env) - mantida como esta"
} else {
    Write-Host "  Preciso do endereco do banco de dados."
    Write-Host "  Se voce nao tem essa informacao, pergunte a quem cuida da TI." -ForegroundColor DarkGray
    Write-Host ""
    $banco = Read-Host "  Endereco do banco (comeca com postgresql://)"

    if ($banco -notmatch '^postgres(ql)?://[^@]+@[^/]+/\w+') {
        Erro "Esse endereco nao parece valido."
        Write-Host "  Deve comecar com postgresql:// e conter usuario, senha e servidor."
        Read-Host "  Pressione Enter para sair"
        exit 1
    }

    # Chaves geradas localmente: nunca reutilizar valores de exemplo.
    $chaveApi   = -join ((1..48)  | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
    $chaveMestra= -join ((1..64)  | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })

    @"
PORT=3000
DATABASE_URL=$banco
GATEWAY_API_KEY=$chaveApi
MASTER_KEY=$chaveMestra
VER_APLIC=nfse-gateway/1.0
XML_SIG_ALG=sha1
GATEWAY_BASE_URL=http://localhost:3000
"@ | Set-Content -Path $envPath -Encoding ascii

    Ok "Configuracao criada"
    Write-Host ""
    Write-Host "  ATENCAO - guarde esta chave em local seguro:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "     $chaveApi" -ForegroundColor White
    Write-Host ""
    Write-Host "  E a senha de acesso ao gateway. Sem ela nao da para entrar." -ForegroundColor Yellow
    Write-Host "  Ela tambem fica no arquivo .env dentro da pasta do gateway."
    Write-Host ""
    Read-Host "  Anote a chave e pressione Enter para continuar"
}

# ---------------------------------------------------------- 4. banco
Titulo "4 de 5 - Preparando o banco de dados"

Push-Location $raiz
try {
    $saida = node scripts/migrate.js 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $saida }
    Ok "Banco de dados pronto"
} catch {
    Erro "Nao consegui conectar ao banco de dados."
    Write-Host "  Verifique se o endereco esta correto no arquivo .env"
    Write-Host ""
    Write-Host $_ -ForegroundColor DarkGray
    Pop-Location
    Read-Host "  Pressione Enter para sair"
    exit 1
}
Pop-Location

# ---------------------------------------------------------- 5. atalhos
Titulo "5 de 5 - Criando os atalhos"

$iniciar = Join-Path $PSScriptRoot 'Iniciar Gateway.bat'
$shell = New-Object -ComObject WScript.Shell

foreach ($destino in @([Environment]::GetFolderPath('Desktop'))) {
    $atalho = $shell.CreateShortcut((Join-Path $destino 'Emitir NFS-e.lnk'))
    $atalho.TargetPath = $iniciar
    $atalho.WorkingDirectory = $raiz
    $atalho.Description = 'Abre o gateway para emitir notas fiscais'
    $atalho.IconLocation = "$env:SystemRoot\System32\shell32.dll,70"
    $atalho.Save()
}
Ok "Atalho 'Emitir NFS-e' criado na area de trabalho"

# ------------------------------------------------------------------ fim
Write-Host ""
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host "     Instalacao concluida" -ForegroundColor Green
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Para emitir notas: clique no atalho " -NoNewline
Write-Host "'Emitir NFS-e'" -ForegroundColor White -NoNewline
Write-Host " na area de trabalho."
Write-Host ""
Write-Host "  Antes da primeira emissao, cadastre a empresa e o certificado"
Write-Host "  digital no painel (o atalho abre nele)."
Write-Host ""
Read-Host "  Pressione Enter para fechar"
