# ---------------------------------------------------------------------------
# Regras de firewall do gateway.
#
# O QUE ABRE, E SO ISSO: a porta HTTP do painel, para os terminais do
# escritorio alcancarem o servidor.
#
# O QUE NAO ABRE, DE PROPOSITO: o PostgreSQL. Terminal nao fala com o banco --
# fala com o gateway, por HTTP. Abrir 5434 na rede daria a qualquer maquina do
# escritorio acesso direto ao banco de notas fiscais, com certificado A1
# cifrado dentro, sem passar por login nenhum. E um caminho que o sistema nao
# usa e que nao deve existir.
#
# O monitor (3100) tambem nao: ele atende so em 127.0.0.1 e exige um token
# sorteado a cada abertura. Abrir na rede seria expor o painel de controle do
# gateway a quem estiver no mesmo wi-fi.
#
# Escopo: rede PRIVADA e de DOMINIO. Perfil publico fica de fora -- se alguem
# levar o notebook do escritorio para uma cafeteria, a porta nao vai junto.
#
# Uso:
#   .\firewall.ps1 abrir   -Porta 3000
#   .\firewall.ps1 fechar
#   .\firewall.ps1 situacao
# ---------------------------------------------------------------------------
param(
    [Parameter(Position=0)][ValidateSet('abrir','fechar','situacao')][string]$Acao = 'situacao',
    [int]$Porta = 3000
)

$ErrorActionPreference = 'Stop'
$NOME_REGRA = 'NFS-e Gateway (painel)'

function EhAdministrador {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Mensagem vai por Write-Host, nao Write-Output: em PowerShell, Write-Output
# dentro de funcao entra no VALOR DE RETORNO dela. Misturado com `exit (Func)`,
# o codigo de saida virava um array e as mensagens sumiam -- o script parecia
# funcionar em silencio, que e o pior jeito de nao funcionar.
function Dizer($t) { Write-Host $t }

$codigo = 0

if ($Acao -eq 'abrir') {
    if (-not (EhAdministrador)) {
        Dizer "SEM PERMISSAO: abrir porta no firewall exige administrador."
        Dizer "O gateway funciona nesta maquina do mesmo jeito; so os terminais"
        Dizer "nao vao alcancar. Rode o Manutencao.bat como administrador e"
        Dizer "escolha 'Liberar acesso da rede'."
        exit 2
    }

    # Remove antes de criar: a porta pode ter mudado na tela "Rede e conexao",
    # e duas regras com a mesma finalidade e portas diferentes deixam aberta a
    # que ninguem lembra que existe.
    try {
        Get-NetFirewallRule -DisplayName $NOME_REGRA -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
    } catch {}

    New-NetFirewallRule `
        -DisplayName $NOME_REGRA `
        -Description "Permite que os terminais do escritorio abram o painel do gateway. Criada pelo instalador do NFS-e Gateway." `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Porta `
        -Profile Private,Domain `
        -Group 'NFS-e Gateway' | Out-Null

    Dizer "Porta $Porta liberada para a rede local (perfis privado e de dominio)."
    Dizer "O banco NAO foi exposto: terminal fala com o gateway, nao com o banco."
    exit 0
}

if ($Acao -eq 'fechar') {
    if (-not (EhAdministrador)) { Dizer "SEM PERMISSAO: preciso de administrador."; exit 2 }
    $r = Get-NetFirewallRule -DisplayName $NOME_REGRA -ErrorAction SilentlyContinue
    if (-not $r) { Dizer "Nao havia regra para remover."; exit 0 }
    $r | Remove-NetFirewallRule
    Dizer "Regra removida. O painel volta a atender so nesta maquina."
    exit 0
}

# situacao: a primeira palavra e lida por quem chama, entao vem sozinha na linha
$r = Get-NetFirewallRule -DisplayName $NOME_REGRA -ErrorAction SilentlyContinue
if (-not $r) {
    Dizer "fechada|A porta do painel nao esta liberada no firewall."
    exit 0
}
$p = $r | Get-NetFirewallPortFilter
$estado = if ($r.Enabled -eq 'True') { 'aberta' } else { 'desligada' }
Dizer "$estado|Porta $($p.LocalPort), perfis: $($r.Profile)"
exit 0
