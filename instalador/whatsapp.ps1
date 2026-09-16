# ---------------------------------------------------------------------------
# A primeira configuracao do WhatsApp, chamada pelo configurar.ps1.
#
# Dois caminhos, uma conversa so. O que muda aqui e o MEIO:
#
#   meta  - plataforma oficial. Precisa de um endereco publico em HTTPS para a
#           Meta entregar as mensagens, e e por isso que o cloudflared entra:
#           sem tunel, o webhook nao tem por onde chegar numa maquina de
#           escritorio atras de um roteador domestico.
#
#   local - sessao propria por QR. Nao precisa de endereco publico nenhum: o
#           modulo conecta de dentro para fora. Precisa das dependencias do
#           Baileys, que sao 113 MB e por isso nao viajam no instalador.
#
# NAO se aceita termo por aqui, e NAO se liga o transporte local. O termo diz
# que o numero pode ser banido e que nao respondemos por isso -- aceite embutido
# em "Avancar" nao e aceite. Quem le e marca e uma pessoa, na tela do modulo.
#
# ARMADILHA DO POWERSHELL, ja paga uma vez neste repositorio: `Write-Output`
# dentro de uma funcao vira o VALOR DE RETORNO dela. Por isso tudo que e recado
# sai por Write-Host, e as funcoes devolvem so o que interessa.
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory=$true)][string]$Raiz,
    [ValidateSet('meta','local','nenhum')][string]$Transporte = 'nenhum',
    [string]$Numero,
    [int]$Porta = 3200,
    [int]$RelayPorta = 8080,
    [string]$PhoneNumberId,
    [string]$Saudacao,
    [string]$Atendente,
    [string]$Horario
)

$ErrorActionPreference = 'Stop'

$node = Join-Path $Raiz 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function Recado($texto) { Write-Host $texto }

# ------------------------------------------------ o tunel (so para a Meta)
#
# Baixado da URL oficial da Cloudflare e conferido por ASSINATURA, nao por
# checksum fixo. Um checksum gravado aqui venceria na proxima versao do
# cloudflared e transformaria uma atualizacao de terceiro em instalacao
# quebrada; a assinatura Authenticode continua valendo em todas elas, e e ela
# que responde a pergunta que importa -- "isto veio mesmo da Cloudflare?".
function BaixarTunel($destinoPasta) {
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    $destino = Join-Path $destinoPasta 'cloudflared.exe'

    if (Test-Path $destino) {
        Recado "  cloudflared ja estava em ferramentas\; mantido."
        return $destino
    }

    New-Item -ItemType Directory -Force -Path $destinoPasta | Out-Null
    $temp = Join-Path $env:TEMP ("cloudflared-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".exe")

    try {
        Recado "  baixando o cloudflared..."
        # TLS 1.2 explicito: o Windows Server mais antigo ainda negocia 1.0 por
        # padrao e o GitHub recusa a conexao sem dizer por que.
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing -TimeoutSec 120
    } catch {
        Recado "  nao consegui baixar o cloudflared: $($_.Exception.Message)"
        if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
        return $null
    }

    $assinatura = Get-AuthenticodeSignature $temp
    $assinante = ''
    if ($assinatura.SignerCertificate) { $assinante = $assinatura.SignerCertificate.Subject }

    if ($assinatura.Status -ne 'Valid' -or $assinante -notmatch 'Cloudflare') {
        # Baixar um executavel e rodar sem conferir de quem e seria colocar um
        # binario desconhecido para falar com a internet de dentro da maquina
        # que guarda os certificados A1 do escritorio.
        Recado "  o arquivo baixado nao esta assinado pela Cloudflare (status: $($assinatura.Status)). Descartado."
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
        return $null
    }

    Move-Item $temp $destino -Force
    $mb = [math]::Round((Get-Item $destino).Length / 1MB, 1)
    Recado "  cloudflared instalado ($mb MB), assinado por Cloudflare."
    return $destino
}

# ----------------------------------- as dependencias do modulo (so local)
#
# 113 MB que so quem escolhe sessao propria precisa. O WhatsApp.bat ja as baixa
# na primeira abertura; fazer aqui evita que a primeira abertura seja uma espera
# de varios minutos sem explicacao -- e evita descobrir, na hora de conectar,
# que aquela maquina nao tem internet liberada para o registro do npm.
function InstalarModulo($pastaWa) {
    if (Test-Path (Join-Path $pastaWa 'node_modules')) {
        Recado "  dependencias do modulo ja estavam instaladas."
        return $true
    }
    if (-not (Test-Path (Join-Path $pastaWa 'package.json'))) {
        Recado "  wa\package.json nao encontrado; modulo nao preparado."
        return $false
    }

    Push-Location $pastaWa
    try {
        Recado "  instalando as dependencias do modulo (pode levar alguns minutos)..."
        & npm install --omit=dev --no-fund --no-audit --silent 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Recado "  npm install falhou. O modulo tentara de novo na primeira abertura."
            return $false
        }
        Recado "  dependencias do modulo instaladas."
        return $true
    } catch {
        Recado "  nao consegui instalar as dependencias: $($_.Exception.Message)"
        return $false
    } finally { Pop-Location }
}

# --------------------------------------------------------------- execucao

if ($Transporte -eq 'nenhum') {
    Recado "nenhum transporte escolhido; nada a fazer."
    exit 0
}

$tunel = $null

if ($Transporte -eq 'meta') {
    $tunel = BaixarTunel (Join-Path $Raiz 'ferramentas')
}

if ($Transporte -eq 'local') {
    InstalarModulo (Join-Path $Raiz 'wa') | Out-Null
}

# A configuracao vai para o banco por um script Node: e la que estao a
# criptografia da MASTER_KEY e as regras de cada campo. Repetir isso em
# PowerShell seria manter duas implementacoes do mesmo cofre.
$dados = @{
    transporte    = $Transporte
    numero        = $Numero
    porta         = $Porta
    relayPorta    = $RelayPorta
    phoneNumberId = $PhoneNumberId
    # O token vem do ambiente, nao de parametro: quem chamou o colocou la pelo
    # mesmo motivo que as respostas do assistente vao em arquivo.
    token         = $env:NFSE_META_TOKEN
    tunelBinario  = $tunel
    saudacao      = $Saudacao
    atendente     = $Atendente
    horario       = $Horario
}

Push-Location $Raiz
try {
    $env:NFSE_WHATSAPP = $dados | ConvertTo-Json -Compress
    $saida = & $node scripts/configurar-whatsapp.js 2>&1 | Out-String
    $codigo = $LASTEXITCODE
} finally {
    $env:NFSE_WHATSAPP = $null
    Pop-Location
}

Recado $saida.Trim()
exit $codigo
