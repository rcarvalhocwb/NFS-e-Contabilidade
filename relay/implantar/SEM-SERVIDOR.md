# Testar o WhatsApp de verdade, sem contratar servidor

A Meta precisa de um endereço público em HTTPS para entregar as mensagens. Isso
normalmente significa VPS, domínio e Caddy — mas para **ver funcionando** existe
um atalho: um túnel.

O túnel abre uma conexão **de saída** da sua máquina para a Cloudflare, e é a
Cloudflare quem recebe o webhook da Meta e empurra pelo túnel. Nenhuma porta é
aberta no roteador.

## Para testar — sim. Para produção — não

Nesse arranjo o repassador roda na **mesma máquina que guarda os certificados
A1**. O processo dele não tem acesso a eles (é outro processo, com outros
dados), mas quem invadir o repassador ganha um pé dentro da máquina que os
guarda. Numa VPS separada, ganha uma máquina que não tem nada.

Use o túnel para chegar ao primeiro "oi" respondido em uma tarde. Depois mude
para a VPS, que é a mesma coisa com o repassador noutro lugar.

## Passo a passo

**1. Instale o cloudflared**

Em <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
— no Windows é um `.msi`.

**2. Suba o repassador local**

```bash
cd relay
cp .env.exemplo .env      # preencha META_APP_SECRET, META_VERIFY_TOKEN, CHAVE_GATEWAY
node servidor.js
```

**3. Abra o túnel**

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Ele imprime um endereço do tipo `https://algo-aleatorio.trycloudflare.com`.
**Esse endereço muda toda vez que o túnel reinicia** — é o preço de não ter
domínio. Para um teste, serve; para o dia a dia, não.

**4. Confira antes de mexer no painel da Meta**

```bash
node conferir.js https://algo-aleatorio.trycloudflare.com
```

Percorre a corrente inteira e para na primeira peça que falta. Só vá ao painel
da Meta quando as seções 1 a 3 estiverem verdes — cadastrar webhook com o
repassador meio configurado só rende erro difícil de ler.

**5. Cadastre o webhook na Meta**

`https://algo-aleatorio.trycloudflare.com/webhook`, com o mesmo
`META_VERIFY_TOKEN`, e **assine o campo `messages`**.

**6. Mande "oi"**

Do seu próprio celular, para o número de teste que a Meta dá enquanto a
verificação do negócio não sai. Ele só responde a números que você cadastrar
como destinatários de teste no painel — e no gateway, como WhatsApp autorizado
de alguma empresa.

## Quando trocar pela VPS

Quando parar de querer reabrir o túnel toda vez. Aí é
[o roteiro de sempre](LEIA-ME.md): servidor, domínio, Caddy, systemd. O
repassador é o mesmo arquivo; muda só onde ele roda.

E aí desligue o túnel — deixar os dois no ar significa dois endereços atendendo
pelo mesmo número, e a Meta entrega para um só. O sintoma é "às vezes responde".
