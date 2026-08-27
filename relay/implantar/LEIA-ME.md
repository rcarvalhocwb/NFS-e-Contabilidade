# Colocar o repassador no ar, num servidor separado

Do zero até o primeiro "oi" respondido. Cerca de uma hora de trabalho, mais o
tempo que a Meta leva para verificar o negócio — que não depende de você.

> **Provavelmente você não precisa deste roteiro.**
> O caminho recomendado é [NESTA-MAQUINA.md](NESTA-MAQUINA.md): o gateway sobe o
> repassador e o túnel na própria máquina do escritório, e tudo se configura
> numa tela. Sem servidor, sem `.env`, sem porta aberta no roteador.
>
> Este aqui é para quem **quer** separar as máquinas: o repassador numa VPS que
> não guarda certificado nenhum, onde uma invasão dele não põe pé na máquina do
> escritório. É mais seguro e é mais uma coisa para manter — e num escritório
> sem quem cuide de servidor, servidor esquecido é risco, não proteção.

## Conferir a qualquer momento

```bash
cd relay && node conferir.js https://seu-dominio.com.br
```

Percorre a corrente inteira -- configuracao, gateway, Meta, endereco publico --
e para na primeira peca que falta, dizendo o que fazer. O mesmo esta na tela
"Portal do cliente" do gateway, em "O que falta para funcionar".

Use antes de mexer no painel da Meta: cadastrar webhook com o repassador meio
configurado so rende erro dificil de ler.

## Sem servidor

O tunel resolve o endereco publico sem VPS e sem abrir porta, e o gateway sabe
manter os dois processos: [NESTA-MAQUINA.md](NESTA-MAQUINA.md).

## Antes de gastar com servidor

Rode o **ensaio** e veja a conversa funcionando na sua máquina:

```bash
CHAVE_GATEWAY=a-mesma-da-tela node relay/ensaio.js
```

Abre em `http://127.0.0.1:8099`. É o mesmo `conversa.js` que roda em produção,
com o cadastro de verdade puxado do gateway — só não fala com a Meta nem com a
fila. Se algo estiver errado no fluxo, aparece aqui, de graça.

## 1. O servidor

Qualquer VPS pequena serve: **1 vCPU, 1 GB, 20 GB**. O repassador guarda fila de
pedidos e conversas em andamento — nada que cresça. Ubuntu LTS.

```bash
# no servidor, como root
adduser --system --group --home /opt/nfse-relay nfse
apt update && apt install -y nodejs npm caddy rsync
node --version    # precisa ser 20 ou mais novo
```

## 2. O domínio

Aponte um subdomínio (`nfse.seudominio.com.br`) para o IP do servidor, registro
A. Espere propagar — o Caddy só consegue o certificado depois disso.

```bash
cp Caddyfile /etc/caddy/Caddyfile   # troque o domínio antes
systemctl reload caddy
curl https://nfse.seudominio.com.br/saude    # deve responder JSON
```

## 3. As credenciais da Meta

No [Meta for Developers](https://developers.facebook.com/):

1. **Criar app** → tipo *Business* → adicionar o produto **WhatsApp**
2. **WhatsApp → Configuração da API**: anote o `Phone number ID`
3. Gere um **token permanente** por um usuário do sistema — o token de teste que
   aparece na tela vence em 24 horas e é a causa mais comum de "parou de
   funcionar no dia seguinte"
4. **Configurações do app → Básico**: copie o **App Secret**
5. **Verificação do negócio**: obrigatória para sair do modo de teste. Leva dias
   e pede documento da empresa — comece por aqui, é o que demora

## 4. O `.env` do servidor

```bash
mkdir -p /opt/nfse-relay/dados && chown -R nfse:nfse /opt/nfse-relay
cat > /opt/nfse-relay/.env <<'FIM'
PORT=8080
META_VERIFY_TOKEN=invente-uma-frase-qualquer
META_APP_SECRET=cole-o-app-secret
CHAVE_GATEWAY=a-mesma-da-tela-portal-do-cliente
ARQUIVO_DADOS=/opt/nfse-relay/dados/relay.json
FIM
chmod 600 /opt/nfse-relay/.env
```

O **token de envio** e o **phone number ID** não vão aqui: são configurados na
tela do gateway e chegam com o cadastro. O que fica no `.env` é só o que
autentica o canal — mandá-lo pelo canal que ele protege fecharia o círculo.

## 5. Subir

```bash
./implantar.sh root@seu-servidor
```

Na primeira vez, instale o serviço:

```bash
cp nfse-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nfse-relay
journalctl -u nfse-relay -f
```

## 6. Ligar o webhook

De volta ao painel da Meta, **WhatsApp → Configuração → Webhook**:

- URL: `https://nfse.seudominio.com.br/webhook`
- Token de verificação: o mesmo `META_VERIFY_TOKEN`
- **Assine o campo `messages`** — sem isso a Meta não entrega nada, e é o
  esquecimento mais comum

## 7. Ligar o gateway

Na tela **Portal do cliente**:

- Endereço: `https://nfse.seudominio.com.br`, chave: a do `CHAVE_GATEWAY`
- **WhatsApp do escritório**: número, phone number ID e token permanente
- *Enviar agora* para mandar o cadastro
- Em cada empresa, aba **Integração**: liberar o portal e cadastrar os números

## 8. Conferir

Mande "oi" do seu celular para o número do escritório. Se não responder:

```bash
journalctl -u nfse-relay -n 50      # o webhook chegou?
curl https://nfse.seudominio.com.br/saude
```

| O que aparece | O que é |
|---|---|
| `assinatura não confere` | `META_APP_SECRET` errado |
| `sem número configurado` | falta o token na tela do gateway, ou o cadastro não foi enviado |
| nada nos logs | a Meta não está entregando — confira a assinatura do campo `messages` |
| `janela de 24h fechada` | normal se o cliente sumiu; ele precisa escrever primeiro |

## Manutenção

- `dados/relay.json` tem a fila de pedidos ainda não buscados. **Entre no
  backup.** Se sumir, perdem-se os pedidos que o gateway ainda não pegou.
- O token permanente da Meta não vence, mas é revogável. Se alguém revogar,
  o sintoma é "o bot parou de responder" — troque na tela do gateway.
- `systemctl status nfse-relay` e `/saude` respondem se está de pé.
