# Gerar o instalador — versão 1.9.0

Há dois caminhos: o do Windows, na máquina onde o projeto vive (`C:\DEV`), e
o do Linux, com Wine. Os dois produzem o mesmo `.exe` — o do Linux foi usado
para gerar a 1.9.0.

## Antes de começar

Uma vez só, se ainda não tiver:

- **Inno Setup 6** — https://jrsoftware.org/isdl.php
- **Node.js** na máquina (o pacote embute o dele, mas o empacotador precisa de
  um para rodar `npm ci`)

## No Windows

```powershell
cd C:\DEV\nfse-gateway          # ou onde estiver o clone
git fetch origin
git checkout claude/multi-escritorio
git pull

npm install                      # dependências do projeto
npm test                         # conferir antes de empacotar

.\instalador\preparar-pacote.ps1
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" .\instalador\nfse-gateway.iss
```

O resultado sai em `instalador\saida\nfse-gateway-setup-1.9.0.exe`.

`preparar-pacote.ps1` baixa o Node portátil (~30 MB) e o PostgreSQL portátil
(~130 MB) na primeira vez. Com `-SemBanco` ele monta sem o Postgres e o
instalador baixa na máquina do cliente.

## No Linux, com Wine

O Inno Setup roda bem sob Wine; o que não roda é o empacotador PowerShell.
`preparar-pacote.sh` é o espelho dele em bash, e `test/pacote-limpo.test.js`
compara as duas listas e falha se divergirem.

Uma vez só:

```bash
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y wine wine32 xvfb unzip
export WINEPREFIX=$HOME/.wine32 WINEARCH=win32
# Inno Setup 6.3.3 (o 7 recusa instalar sob Wine); extraído com innoextract
# >= 1.10 para dentro de "$WINEPREFIX/drive_c/InnoSetup6".
```

**O ajuste que não é opcional:**

```bash
WINEPREFIX=$HOME/.wine32 wine reg add 'HKCU\Software\Wine' \
  /v ShowDotFiles /t REG_SZ /d Y /f
```

Sem ele o Wine marca todo arquivo começado em ponto como oculto, e
`Source: "pacote\*"` do Inno pula arquivo oculto. O primeiro `.exe` gerado
aqui saiu **sem 87 arquivos** — entre eles o `.env.example` — e compilou com
sucesso, sem um aviso sequer. Só apareceu na conferência abaixo.

A cada build:

```bash
./instalador/preparar-pacote.sh
WINEPREFIX=$HOME/.wine32 xvfb-run -a wine 'C:\InnoSetup6\ISCC.exe' \
  "$(winepath -w instalador/nfse-gateway.iss)"
```

### Conferir o que entrou no .exe

Compilar sem erro não prova que o conteúdo está lá. Compare o que saiu com o
que devia sair:

```bash
innoextract -s -d /tmp/verif instalador/saida/nfse-gateway-setup-*.exe
cd instalador/pacote && find . -type f | sort | xargs sha256sum > /tmp/a.txt
cd /tmp/verif/app && find . -type f | sort | xargs sha256sum > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt
```

Esperado: as únicas diferenças são os cinco arquivos que o `.iss` acrescenta
por fora do pacote (`Iniciar Gateway.bat`, `configurar.ps1`, `firewall.ps1`,
`whatsapp.ps1`, `terminal.ps1`). Qualquer outra linha é arquivo faltando.

## O que conferir antes de instalar num cliente

O ensaio percorre uma instalação inteira num banco descartável — migrações,
cadastro do escritório, primeira empresa, e a conversa do WhatsApp até um
pedido pronto. Ele **cria e apaga** um banco chamado `nfse_ensaio`:

```powershell
node scripts\ensaio-instalacao.js
```

Esperado: `OK: 32/32 conferências.`

Foi este ensaio que pegou, em 19/09/2026, a instalação limpa quebrando na
segunda etapa — `primeira-empresa.js` gravava sem inquilino amarrado e a
instalação terminava sem empresa, sem serviço e sem conversa. Rode antes de
cada release.

Para conferir o controle de acesso (145 rotas × 6 credenciais, em banco
separado que também é derrubado no fim):

```powershell
node scripts\matriz-acesso.js
```

## O que muda da 1.8.0 para a 1.9.0

Para quem instala na máquina do escritório, **nada muda**: o sistema continua
de um escritório só, o administrador continua sendo o operador, e as telas de
rede e backup seguem onde estavam.

Por baixo, o banco passou a separar escritórios (migrações 045 a 049) e a
proteção entre eles vive em policy de banco. Numa instalação de mesa essa
separação fica inerte — há um escritório só, e a aplicação conecta como dona
do banco, que ignora policy.

Correções que valem para todo mundo:

- sete validações fiscais que só existiam na tela passaram para o servidor
  (valor zero, tomador sem nome, exportação sem país, exigibilidade suspensa
  sem processo, NBS com tamanho errado, benefício municipal sem tipo,
  intermediário inválido). Pela integração (`X-API-Key`) elas não existiam —
  e uma recusa da Sefin depois da reserva de número deixa buraco na sequência
  fiscal;
- cancelamento por motivo 9 ("Outros") saía inválido: o texto padrão tinha
  seis caracteres e o leiaute exige quinze;
- Fazenda Rio Grande voltou a ser semeada em banco novo — três migrações a
  editavam e nenhuma a criava;
- contraste da cor do escritório agora é calculado pela norma, não por
  heurística de brilho: cores claras de marca produziam barra lateral
  ilegível;
- foco visível que não depende da cor da marca;
- campos numéricos pedem teclado numérico no celular, e o erro de emissão
  aponta para o campo que o causou.

## Só para o servidor SaaS

Duas ferramentas ficam **fora** do pacote de propósito — são de quem opera o
servidor, não de quem usa o gateway:

- `scripts/papel-app.js` — cria o papel restrito de banco. Sem ele a aplicação
  conecta como dona e a separação entre escritórios não vale;
- `scripts/criar-escritorio.js` — abre um escritório novo.

Elas continuam no repositório. Ver a seção
**Vários escritórios no mesmo servidor** no `README.md`.
