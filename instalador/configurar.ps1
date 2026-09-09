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
    # As respostas do assistente vem num ARQUIVO, nao na linha de comando.
    # Senha de administrador e senha de pacote de migracao em linha de comando
    # aparecem no gerenciador de tarefas, no log de auditoria de processos e em
    # qualquer antivirus com telemetria. O arquivo e criado pelo instalador com
    # ACL restrita e apagado assim que lido, logo no comeco daqui.
    [string]$Respostas,
    [ValidateSet('nova','reinstalacao','atualizacao')][string]$Modo = 'nova',
    # Continuam existindo para quem chamar o script a mao (suporte, diagnostico).
    [string]$BancoUrl,
    [string]$NomeUsuario,
    [string]$EmailUsuario,
    [string]$SenhaUsuario,
    [string]$ArquivoMigracao,
    [string]$SenhaMigracao,
    [string]$EscritorioNome,
    [string]$EscritorioCnpj,
    [string]$EscritorioEmail,
    [string]$PastaBackup,
    [int]$Porta = 3000,
    [switch]$LiberarFirewall
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

# ------------------------------------------ 0. as respostas do assistente
#
# Lidas do arquivo e apagadas na hora. Um arquivo com a senha do administrador
# esquecido em disco e pior do que uma instalacao interrompida.
if (-not [string]::IsNullOrWhiteSpace($Respostas) -and (Test-Path $Respostas)) {
    $r = Get-Content $Respostas -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($campo in @('BancoUrl','NomeUsuario','EmailUsuario','SenhaUsuario',
                         'ArquivoMigracao','SenhaMigracao','EscritorioNome',
                         'EscritorioCnpj','EscritorioEmail','PastaBackup')) {
        if ($r.PSObject.Properties.Name -contains $campo -and $r.$campo) {
            Set-Variable -Name $campo -Value $r.$campo
        }
    }
    if ($r.PSObject.Properties.Name -contains 'Porta' -and $r.Porta) { $Porta = [int]$r.Porta }
    if ($r.PSObject.Properties.Name -contains 'Modo' -and $r.Modo) { $Modo = $r.Modo }
    if ($r.PSObject.Properties.Name -contains 'LiberarFirewall') {
        $LiberarFirewall = [bool]$r.LiberarFirewall
    }

    # Apagado AQUI, e nao num `finally` no fim: os valores ja estao em memoria,
    # e o arquivo carrega a senha do administrador. Quanto menos tempo ele
    # existir em disco, melhor -- e um `finally` la embaixo o deixaria vivo
    # durante toda a instalacao, que e a parte demorada.
    try {
        Remove-Item $Respostas -Force -ErrorAction Stop
    } catch {
        # Se nao deu para apagar, pelo menos nao deixa o conteudo legivel.
        try { [System.IO.File]::WriteAllText($Respostas, '{}') } catch {}
        Registrar "AVISO: nao consegui apagar o arquivo de respostas ($Respostas)."
    }
}

Registrar "=== Configurando o NFS-e Gateway ==="
Registrar "pasta: $Raiz"
Registrar "modo: $Modo"

# ------------------------------- 0b. copia de seguranca ANTES de qualquer coisa
#
# Migracao de banco nao tem "desfazer" -- tem restauracao, e restauracao precisa
# de uma copia que exista. Numa atualizacao esta e a unica trava inegociavel: se
# a copia falha, nao se atualiza.
if ($Modo -eq 'atualizacao') {
    $env:PGPASSWORD = $null
    Push-Location $Raiz
    try {
        Registrar "Copia de seguranca antes de atualizar..."
        $saida = & $node scripts/backup.js --rotulo "antes-de-atualizar" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Falhar ("nao consegui fazer a copia de seguranca, entao nao vou " +
                    "mexer no banco. Motivo: $saida")
        }
        Registrar "Copia feita"
    } finally { Pop-Location }
}

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
    # Manter esta certo. So MANTER estava errado: uma versao que passe a
    # depender de uma variavel nova subia sem ela e falhava em runtime, longe
    # da causa. A atualizacao faz UNIAO -- acrescenta o que falta, nunca toca
    # no que existe (e o que existe inclui a MASTER_KEY, que cifra o
    # certificado A1: sobrescreve-la e perder o certificado de todo mundo).
    $atual = Get-Content $envPath -Raw -Encoding utf8
    $temChave = { param($k) $atual -match "(?m)^\s*$k\s*=" }

    $acrescentar = @()
    foreach ($par in @(
        @{ chave = 'PORT';             valor = "$Porta" },
        @{ chave = 'GATEWAY_BASE_URL'; valor = "http://localhost:$Porta" },
        @{ chave = 'XML_SIG_ALG';      valor = 'sha1' }
    )) {
        if (-not (& $temChave $par.chave)) {
            $acrescentar += "$($par.chave)=$($par.valor)"
        }
    }

    if ($acrescentar.Count -gt 0) {
        $novo = $atual.TrimEnd() + "`n`n# Acrescentado pelo instalador em $(Get-Date -Format 'dd/MM/yyyy HH:mm')`n" +
                ($acrescentar -join "`n") + "`n"
        [System.IO.File]::WriteAllText($envPath, $novo, (New-Object System.Text.UTF8Encoding($false)))
        Registrar ".env mantido; $($acrescentar.Count) chave(s) nova(s) acrescentada(s): $(($acrescentar | ForEach-Object { ($_ -split '=')[0] }) -join ', ')"
    } else {
        Registrar ".env ja existe e esta completo - mantido"
    }
} else {
    # Chaves geradas nesta maquina. A MASTER_KEY cifra o certificado A1: se ela
    # se perder, o certificado guardado nao abre mais.
    $chaveApi = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
    $chaveMestra = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })

    # VER_APLIC NAO e escrito aqui, e e de proposito.
    #
    # Ele vai dentro de TODA DPS e identifica o aplicativo emissor. Escrito no
    # .env, ele vence o valor do package.json e congela: uma instalacao feita
    # hoje declararia "nfse-gateway/1.0" a Sefin para sempre, mesmo depois de
    # dez atualizacoes. E exatamente o defeito que o comentario no config.js
    # diz ter sido corrigido -- a correcao foi no codigo e o instalador
    # continuava reintroduzindo em cada cliente novo.
    #
    # Fora do .env, o config.js usa a versao do package.json, que a
    # atualizacao mantem em dia sozinha.
    $conteudo = @"
# Gerado pelo instalador em $(Get-Date -Format 'dd/MM/yyyy HH:mm')
PORT=$Porta
DATABASE_URL=$BancoUrl
GATEWAY_API_KEY=$chaveApi
MASTER_KEY=$chaveMestra
XML_SIG_ALG=sha1
GATEWAY_BASE_URL=http://localhost:$Porta
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

# ------------------------------------------- 5. cadastro do escritorio

# Numa instalacao nova, o que o assistente coletou vira cadastro. Nao e
# capricho: sem identidade e sem e-mail de avisos, o escritorio so descobre que
# faltava configurar na primeira nota rejeitada.
if ($Modo -eq 'nova' -and -not [string]::IsNullOrWhiteSpace($EscritorioNome)) {
    Push-Location $Raiz
    try {
        Registrar "Gravando os dados do escritorio..."
        $env:NFSE_ESCRITORIO = @{
            nome  = $EscritorioNome
            cnpj  = $EscritorioCnpj
            email = $EscritorioEmail
            pastaBackup = $PastaBackup
        } | ConvertTo-Json -Compress
        $saida = & $node scripts/configurar-escritorio.js 2>&1 | Out-String
        $env:NFSE_ESCRITORIO = $null
        if ($LASTEXITCODE -ne 0) {
            # Nao e fatal: da para preencher no painel. Falhar a instalacao
            # inteira por um campo de identidade seria desproporcional.
            Registrar "AVISO: nao consegui gravar os dados do escritorio: $saida"
        } else {
            Registrar "Escritorio cadastrado"
        }
    } finally { Pop-Location }
}

# ------------------------------------------------------- 6. firewall

# So o servidor abre porta, e so a do painel. O banco nunca: terminal fala com
# o gateway por HTTP, nao com o PostgreSQL. Abrir 5434 na rede daria a qualquer
# maquina do escritorio acesso direto ao banco de notas fiscais, sem login.
if ($LiberarFirewall) {
    $fw = Join-Path $Raiz 'firewall.ps1'
    if (Test-Path $fw) {
        $saida = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fw abrir -Porta $Porta 2>&1 | Out-String
        Registrar ("Firewall: " + $saida.Trim())
    } else {
        Registrar "AVISO: firewall.ps1 nao encontrado; porta nao liberada."
    }
}

# ------------------------------------------------- 7. relatorio da atualizacao

if ($Modo -eq 'atualizacao') {
    Push-Location $Raiz
    try {
        $destino = Join-Path $Raiz 'ultima-atualizacao.json'
        $saida = & $node scripts/relatorio-atualizacao.js --saida "$destino" 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { Registrar "Relatorio da atualizacao em ultima-atualizacao.json" }
        else { Registrar "AVISO: nao consegui montar o relatorio: $saida" }
    } finally { Pop-Location }
}

Registrar "=== Concluido ==="
exit 0
