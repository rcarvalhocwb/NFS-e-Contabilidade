# Gerar o instalador — versão 1.9.0

O `.exe` só se compila no Windows: o empacotador é PowerShell, o Node embutido
é `win-x64`, e o compilador é o **Inno Setup 6** (`ISCC.exe`), que não existe
fora do Windows. Este arquivo é a receita para rodar na máquina onde o projeto
vive (`C:\DEV`).

## Antes de começar

Uma vez só, se ainda não tiver:

- **Inno Setup 6** — https://jrsoftware.org/isdl.php
- **Node.js** na máquina (o pacote embute o dele, mas o empacotador precisa de
  um para rodar `npm ci`)

## A receita

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
