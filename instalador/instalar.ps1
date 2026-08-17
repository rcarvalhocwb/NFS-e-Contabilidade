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
Titulo "1 de 6 - Verificando o Node.js"

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
Titulo "2 de 6 - Instalando os componentes"
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
Titulo "3 de 6 - Configuracao"

$envPath = Join-Path $raiz '.env'
if (Test-Path $envPath) {
    Ok "Configuracao ja existe (.env) - mantida como esta"
} else {
    Write-Host "  Onde os dados do gateway vao ficar guardados?"
    Write-Host ""
    Write-Host "    1. Nesta maquina (recomendado)" -ForegroundColor White
    Write-Host "       Funciona sem internet e nada depende de servico de fora."
    Write-Host "       Baixa o banco de dados uma vez, cerca de 300 MB."
    Write-Host ""
    Write-Host "    2. Em um servidor que voce ja tem"
    Write-Host "       Voce informa o endereco de conexao."
    Write-Host ""

    $escolha = Read-Host "  Digite 1 ou 2"
    while ($escolha -ne '1' -and $escolha -ne '2') { $escolha = Read-Host "  Digite 1 ou 2" }

    if ($escolha -eq '1') {
        . (Join-Path $PSScriptRoot 'postgres-local.ps1')

        if (-not (Install-PostgresLocal $PSScriptRoot)) {
            Erro "Nao consegui instalar o banco nesta maquina."
            Read-Host "  Pressione Enter para sair"
            exit 1
        }

        $senhaBanco = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
        if (-not (Initialize-PostgresLocal $PSScriptRoot $senhaBanco)) {
            Read-Host "  Pressione Enter para sair"
            exit 1
        }
        if (-not (Start-PostgresLocal $PSScriptRoot)) {
            Erro "O banco foi instalado mas nao quis iniciar."
            Write-Host "  Veja o arquivo instalador\postgres\postgres.log" -ForegroundColor DarkGray
            Read-Host "  Pressione Enter para sair"
            exit 1
        }
        if (-not (New-BancoNfse $PSScriptRoot $senhaBanco)) {
            Erro "Nao consegui criar o banco de dados do gateway."
            Read-Host "  Pressione Enter para sair"
            exit 1
        }

        $banco = Get-UrlBancoLocal $senhaBanco
        Ok "Banco de dados instalado nesta maquina"
    } else {
        Write-Host "  Se voce nao tem essa informacao, pergunte a quem cuida da TI." -ForegroundColor DarkGray
        Write-Host ""
        $banco = Read-Host "  Endereco do banco (comeca com postgresql://)"

        if ($banco -notmatch '^postgres(ql)?://[^@]+@[^/]+/\w+') {
            Erro "Esse endereco nao parece valido."
            Write-Host "  Deve comecar com postgresql:// e conter usuario, senha e servidor."
            Read-Host "  Pressione Enter para sair"
            exit 1
        }
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
    Write-Host "  As chaves tecnicas ficaram no arquivo .env, dentro da pasta"
    Write-Host "  do gateway. Voce nao precisa decora-las: o acesso ao sistema"
    Write-Host "  e por email e senha, criados no proximo passo." -ForegroundColor DarkGray
    Write-Host ""
}

# ---------------------------------------------------------- 4. banco
Titulo "4 de 6 - Preparando o banco de dados"

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

# ---------------------------------------------------------- 5. primeiro acesso
Titulo "5 de 6 - Criando o acesso ao sistema"

Push-Location $raiz
$temUsuario = $false
try {
    $temUsuario = (node -e "require('dotenv').config();require('./src/services/usuarios').existeAlgum().then(t=>{console.log(t?'sim':'nao');process.exit(0)}).catch(()=>{console.log('nao');process.exit(0)})" | Out-String).Trim() -eq 'sim'
} catch { $temUsuario = $false }

if ($temUsuario) {
    Ok "Ja existem usuarios cadastrados - nada a fazer aqui"
} else {
    Write-Host "  Vamos criar o acesso do responsavel pelo sistema."
    Write-Host "  E com esse email e senha que se entra no gateway." -ForegroundColor DarkGray
    Write-Host ""

    $nomeUsuario = Read-Host "  Nome do responsavel"
    while (-not $nomeUsuario.Trim()) { $nomeUsuario = Read-Host "  Nome do responsavel" }

    $emailUsuario = Read-Host "  Email"
    while ($emailUsuario -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        Write-Host "  Email invalido." -ForegroundColor Yellow
        $emailUsuario = Read-Host "  Email"
    }

    $senhaOk = $false
    while (-not $senhaOk) {
        $s1 = Read-Host "  Senha (minimo 8 caracteres)" -AsSecureString
        $s2 = Read-Host "  Repita a senha" -AsSecureString
        $t1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
        $t2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))
        if ($t1 -ne $t2) { Write-Host "  As senhas nao sao iguais." -ForegroundColor Yellow; continue }
        if ($t1.Length -lt 8) { Write-Host "  A senha precisa ter ao menos 8 caracteres." -ForegroundColor Yellow; continue }
        if ($t1 -match '^\d+$') { Write-Host "  A senha nao pode ser so numeros." -ForegroundColor Yellow; continue }
        $senhaUsuario = $t1
        $senhaOk = $true
    }

    try {
        # Senha por variavel de ambiente: como argumento apareceria na
        # lista de processos da maquina.
        $env:NFSE_SENHA = $senhaUsuario
        $saida = node scripts/criar-usuario.js --nome $nomeUsuario --email $emailUsuario 2>&1 | Out-String
        $env:NFSE_SENHA = $null
        if ($LASTEXITCODE -ne 0) { throw $saida }
        Ok "Acesso criado para $emailUsuario"
    } catch {
        Erro "Nao consegui criar o acesso."
        Write-Host $_ -ForegroundColor DarkGray
        Write-Host "  Voce ainda pode criar o acesso na primeira vez que abrir o painel."
    }
}
Pop-Location

# ---------------------------------------------------------- 6. atalhos
Titulo "6 de 6 - Criando os atalhos"

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
Write-Host "  Entre com o email e a senha que voce acabou de criar."
Write-Host ""
Write-Host "  Antes da primeira emissao, cadastre a empresa e o certificado"
Write-Host "  digital no painel (o atalho abre nele)."
Write-Host ""
Read-Host "  Pressione Enter para fechar"
