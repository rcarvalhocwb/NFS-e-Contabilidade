# ---------------------------------------------------------------------------
# Instalacao em modo TERMINAL.
#
# O que ele faz: cria atalhos para o painel do servidor e confere que dali se
# alcanca o gateway.
#
# O QUE ELE NAO FAZ, E E O PONTO INTEIRO: nao instala gateway, nem Node, nem
# PostgreSQL. Um terminal que rodasse gateway apontando para o banco do
# servidor criaria um SEGUNDO processo reservando numero na mesma tabela
# `numeracao_dps`, e um segundo trabalhador de fila transmitindo as mesmas
# notas. A numeracao fiscal e uma sequencia sem buracos e sem repeticoes --
# dois emissores no mesmo banco quebram as duas coisas de uma vez.
#
# Por isso o terminal e leve: dois atalhos e um teste de conexao. O trabalho
# acontece no navegador, contra o gateway que ja existe.
#
# Uso:
#   .\terminal.ps1 -Servidor "http://192.168.0.10:3000" -Destino "C:\Program Files\NFS-e Gateway"
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory=$true)][string]$Servidor,
    [Parameter(Mandatory=$true)][string]$Destino,
    [string]$NomeAtalho = 'Emitir NFS-e',
    [switch]$AtalhoDesktop
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $Destino 'configuracao.log'

function Registrar($texto) {
    $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $texto"
    try { Add-Content -Path $log -Value $linha -Encoding utf8 } catch {}
    Write-Host $texto
}

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
Registrar "=== Instalando como TERMINAL ==="
Registrar "servidor: $Servidor"

# ------------------------------------------------------ 1. o endereco serve?

$url = $Servidor.TrimEnd('/')
if ($url -notmatch '^https?://') { $url = "http://$url" }

# Sem porta, assume a padrao do gateway: quem digita "192.168.0.10" quer o
# painel, e exigir ":3000" de quem nao sabe o que e porta so gera ligacao.
if ($url -notmatch '^https?://[^/]+:\d+') { $url = "$url`:3000" }

Registrar "Conferindo $url ..."

$alcancou = $false
$motivo = ''
try {
    # /health nao exige login e nao toca no banco: e a pergunta mais barata que
    # responde "o gateway esta de pe ai?".
    $r = Invoke-WebRequest -Uri "$url/health" -TimeoutSec 8 -UseBasicParsing
    if ($r.StatusCode -eq 200 -and $r.Content -match 'nfse-gateway') {
        $alcancou = $true
    } else {
        $motivo = "respondeu $($r.StatusCode), mas nao parece o gateway"
    }
} catch {
    $motivo = $_.Exception.Message
}

if (-not $alcancou) {
    Registrar "NAO ALCANCEI O SERVIDOR: $motivo"
    Registrar ""
    Registrar "Os atalhos foram criados assim mesmo, mas nao vao abrir enquanto isso"
    Registrar "nao for resolvido. As tres causas, em ordem de frequencia:"
    Registrar ""
    Registrar "  1. o gateway do servidor nao esta ligado;"
    Registrar "  2. a porta nao foi liberada no firewall DO SERVIDOR"
    Registrar "     (la, no Manutencao.bat, escolha 'Liberar acesso da rede');"
    Registrar "  3. o painel do servidor atende so nele mesmo -- na tela"
    Registrar "     'Rede e conexao' do gateway, troque para atender a rede."
    Registrar ""
    # Nao e falha de instalacao: os atalhos ficam prontos e o problema e do
    # outro lado. Encerrar com erro faria o instalador desfazer tudo por um
    # cabo de rede solto.
}
else {
    Registrar "Servidor respondeu. O terminal alcanca o gateway."
}

# ------------------------------------------------------------ 2. os atalhos

# O atalho e de INTERNET (.url): o terminal nao tem programa para apontar, tem
# endereco. E .url se escreve como texto, nao pelo WScript.Shell -- aquele
# objeto so aceita Description e IconLocation em .lnk, e num .url estoura com
# "a propriedade Description nao foi encontrada". Escrever o INI direto e mais
# curto e ainda deixa por o icone.
function CriarAtalho($caminho, $alvo, $icone, $indice) {
    $conteudo = "[InternetShortcut]`r`nURL=$alvo`r`n"
    if ($icone) { $conteudo += "IconIndex=$indice`r`nIconFile=$icone`r`n" }
    [System.IO.File]::WriteAllText($caminho, $conteudo,
        (New-Object System.Text.UTF8Encoding($false)))
}

$ICONE = Join-Path $env:SystemRoot 'System32\shell32.dll'

# ------------------------------------------- 3. o que este terminal E e NAO E
#
# A marca e gravada ANTES dos atalhos, e nao depois: atalho no menu de todos os
# usuarios exige administrador, e sem elevacao o script morria ali -- deixando
# a pasta sem a marca, e a proxima execucao do instalador sem saber que esta
# maquina ja e um terminal. O que identifica a instalacao vem primeiro; o que
# e conveniencia vem depois.
$marca = @{
    modo = 'terminal'
    servidor = $url
    instalado_em = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $Destino 'terminal.json'), $marca,
    (New-Object System.Text.UTF8Encoding($false)))

# ------------------------------------------------------------ 4. os atalhos

# Menu de todos os usuarios quando da; o do usuario quando nao da. Instalado
# pelo .exe ele roda elevado e cai no primeiro caso; rodado a mao, no segundo.
# Nos dois, o atalho existe -- que e o que importa para quem vai usar.
$menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'NFS-e Gateway'
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
try {
    New-Item -ItemType Directory -Force -Path $menu -ErrorAction Stop | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $menu '.escrita'), 'x')
    Remove-Item (Join-Path $menu '.escrita') -Force
} catch {
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'NFS-e Gateway'
    $desktop = [Environment]::GetFolderPath('Desktop')
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    Registrar "Sem permissao no menu de todos os usuarios: atalhos so para este usuario."
}

try {
    CriarAtalho (Join-Path $menu "$NomeAtalho.url") "$url/nota" $ICONE 70
    CriarAtalho (Join-Path $menu 'Painel do gateway.url') "$url/admin" $ICONE 21
    if ($AtalhoDesktop) {
        CriarAtalho (Join-Path $desktop "$NomeAtalho.url") "$url/nota" $ICONE 70
    }
    Registrar "Atalhos criados em: $menu"
} catch {
    # Atalho e conveniencia: o endereco do painel esta no terminal.json e no
    # log. Falhar a instalacao inteira por um icone seria desproporcional.
    Registrar "Nao consegui criar os atalhos ($($_.Exception.Message))."
    Registrar "O painel esta em: $url/admin"
}

# Nenhuma regra de firewall: terminal so faz conexao de SAIDA, e saida o
# Windows ja permite. Abrir porta aqui seria abrir porta que ninguem usa.
Registrar "Nenhuma porta foi aberta neste terminal: ele so faz conexao de saida."

Registrar "=== Terminal pronto ==="
if (-not $alcancou) { exit 3 }   # instalado, mas o servidor nao respondeu
exit 0
