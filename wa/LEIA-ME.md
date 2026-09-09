# Módulo do WhatsApp — sessão própria

Programa separado, com ícone próprio, que mantém a sessão do WhatsApp e
conversa com o repassador.

## Por que é um programa à parte

A sessão do WhatsApp cai, reconecta, pede QR de novo e às vezes morre por
decisão de terceiro. Dentro do gateway, cada um desses acidentes seria um
acidente do sistema de nota fiscal.

É o mesmo desenho do monitor, pelo mesmo motivo: dois programas, duas vidas.

## O que ele NÃO faz

Não emite nota, não assina, não fala com a Sefin, não guarda XML e não conhece
a conversa. Ele mantém a sessão, entrega o texto ao repassador e envia o que o
repassador mandar enviar.

**A emissão de notas não depende dele.** Se o WhatsApp parar, por qualquer
motivo, o painel continua emitindo, consultando, cancelando e baixando XML.

## O risco, dito por escrito

Isto é automação **não oficial** do WhatsApp, apoiada no Baileys. O número pode
ser bloqueado ou banido pelo WhatsApp, a qualquer momento, sem aviso — e não há
a quem recorrer. O escritório aceita um termo antes de ligar, e o aceite fica
registrado com nome, data e a versão do texto.

A alternativa oficial (API do WhatsApp Business, da Meta) continua implementada
e é o caminho recomendado para quem depende do WhatsApp.

## Como usar

Dois cliques em `WhatsApp.bat`, na pasta do gateway.

Na primeira vez ele baixa as bibliotecas (~113 MB, alguns minutos, precisa de
internet). Elas **não vão no instalador** de propósito: só quem escolhe usar
sessão própria carrega esse peso.

## Arquivos

| arquivo | o que é |
|---|---|
| `servidor.js` | o processo: porta local, token por abertura, a tela |
| `motor.js` | o Baileys embrulhado: sessão, QR, reconexão, envio |
| `termo.js` | o termo de aceite, versionado — o texto antigo nunca some |
| `janela.html`/`janela.js` | a tela: QR, estado e últimas mensagens |
| `sessao/` | **as credenciais do WhatsApp.** Trate como o certificado A1 |
| `token.txt` | token de abertura, sorteado a cada subida |

`sessao/`, `token.txt` e `node_modules/` estão no `.gitignore` e são removidos
do pacote do instalador.

## Portas

| porta | quem |
|---|---|
| 3200 | este módulo, só em 127.0.0.1 |
| 8080 | o repassador, para onde as mensagens vão |
| 3000 | o gateway, que recebe a situação da sessão |

Nenhuma delas é aberta no firewall: o módulo só faz conexão de saída.
