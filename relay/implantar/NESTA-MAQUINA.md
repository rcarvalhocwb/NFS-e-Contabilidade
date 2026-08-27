# O WhatsApp rodando na própria máquina do escritório

Este é o caminho recomendado. Sem servidor alugado, sem `.env` noutro
computador, sem porta aberta no roteador: o gateway sobe o repassador e o túnel,
vigia os dois, e tudo se configura numa tela só.

Se você já tem um servidor e prefere separar as máquinas, o outro roteiro é
[LEIA-ME.md](LEIA-ME.md) — o repassador é o mesmo arquivo; muda só onde ele roda.

## O que muda, e o que não muda

A Meta exige um endereço público em HTTPS. O que dá esse endereço é o **túnel**:
uma conexão de **saída** desta máquina para a Cloudflare. É a Cloudflare que
recebe o webhook e empurra por dentro do túnel. Nada é aberto no roteador, e o
gateway continua invisível para a internet.

O que se **perde** em relação à VPS, dito às claras: o repassador passa a rodar
na mesma máquina que guarda os certificados A1. Ele continua um processo à
parte, sem senha do banco, sem acesso ao certificado, e atendendo só em
`127.0.0.1` — mas quem o invadisse ganharia um pé dentro desta máquina, em vez
de dentro de um servidor que não tem nada.

O que se **ganha**: some a peça que ninguém atualiza. Uma instalação, uma
atualização, um backup, um log. Num escritório sem quem cuide de servidor, VPS
esquecida é risco, não proteção — e essa é a troca que este roteiro faz.

## 1. Baixar o cloudflared

Uma vez, à mão. **O gateway não baixa programa sozinho**: numa máquina que
guarda certificado A1, isso não se faz.

<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

No Windows, ou instale o `.msi` (fica no PATH), ou salve o `cloudflared.exe` em
`C:\dev\nfse-gateway\ferramentas\`. Os dois funcionam — a tela procura nos dois
lugares.

## 2. Criar o túnel na Cloudflare

Precisa de um domínio na Cloudflare. Se o escritório já tem site, serve o mesmo.

1. **Zero Trust → Networks → Tunnels → Create a tunnel**
2. Tipo **Cloudflared**. Dê um nome (`nfse-escritorio`)
3. A tela mostra um comando com `--token eyJhIjoi…`. **Copie só o token** — quem
   roda o cloudflared é o gateway, não você
4. Em **Public Hostname**, aponte:
   - Subdomínio: `nfse` · Domínio: o seu
   - Service: **HTTP** · URL: `127.0.0.1:8080`

O `HTTP` aqui não é problema: esse trecho é dentro da própria máquina. O `https`
que a Meta enxerga é o da Cloudflare, e é ela quem cuida do certificado.

**Túnel nomeado, não o de teste.** O `cloudflared tunnel --url` imprime um
endereço aleatório que muda a cada reinício — e endereço de webhook que muda
sozinho quer dizer reconfigurar a Meta toda vez que faltar luz.

## 3. As credenciais da Meta

No [Meta for Developers](https://developers.facebook.com/):

1. **Criar app** → tipo *Business* → adicionar o produto **WhatsApp**
2. **WhatsApp → Configuração da API**: anote o `Phone number ID`
3. Gere um **token permanente** por um usuário do sistema — o que aparece na
   tela vence em 24 horas e é a causa mais comum de "parou de funcionar no dia
   seguinte"
4. **Configurações do app → Básico**: copie o **App Secret**
5. **Verificação do negócio**: obrigatória para sair do modo de teste. Leva dias
   e pede documento da empresa — comece por aqui, é o que demora

## 4. Preencher a tela

No gateway, **Portal do cliente**:

**Onde o WhatsApp atende**
- Ligue *Rodar o repassador nesta máquina*
- **App Secret**: o da Meta
- **Token de verificação**: clique em *Sortear* e **copie a frase** — ela vai
  igual no painel da Meta no passo 5
- Ligue *Manter o túnel no ar por aqui*
- **Token do túnel**: o `eyJhIjoi…` do passo 2
- **Endereço público**: `https://nfse.seudominio.com.br`
- **Salvar** — os dois processos sobem na hora, e o quadro *Os dois processos,
  agora* mostra se subiram

A chave da ponte é sorteada sozinha: com os dois lados no mesmo computador, não
há o que copiar de um lugar para outro.

**WhatsApp do escritório**
- Número, Phone number ID e o token permanente
- Marque *Atender pedidos por WhatsApp*
- *Enviar agora*, na caixa do cadastro

**Em cada empresa**, aba *Integração*: liberar o portal e cadastrar os números
que podem pedir nota.

## 5. Ligar o webhook na Meta

**WhatsApp → Configuração → Webhook**:

- URL: `https://nfse.seudominio.com.br/webhook`
- Token de verificação: a frase sorteada no passo 4
- **Assine o campo `messages`** — sem isso a Meta não entrega nada, e é o
  esquecimento mais comum

## 6. Conferir

Na mesma tela, **O que falta para funcionar** → *Conferir agora*. Ele percorre a
corrente inteira, inclusive dando a volta pela internet para provar que o
endereço público responde de fora — que é a única forma de responder "a Meta
consegue me alcançar?" sem esperar a primeira mensagem perdida.

Depois mande "oi" do seu celular para o número do escritório.

| O que a tela diz | O que é |
|---|---|
| *Programa não encontrado* | falta o cloudflared — passo 1 |
| *O túnel não está de pé* | token do túnel errado, ou o túnel foi apagado na Cloudflare |
| *O endereço público não respondeu* | o túnel subiu, mas o Public Hostname não aponta para `127.0.0.1:8080` |
| *Caiu 6 vezes seguidas* | a supervisão desistiu de propósito. Resolva o motivo e clique em *Reiniciar* |
| *App Secret não configurado* | passo 3, item 4 |
| responde às vezes | há dois endereços atendendo pelo mesmo número. Desligue o outro |

## Manutenção

Quase nada, que é o ponto:

- **O backup já leva tudo.** `config_nuvem` (número, App Secret, token de
  verificação, token do túnel — todos cifrados), os números autorizados por
  empresa, e a fila do repassador em `dados-relay/`. Trocar de computador é
  restaurar o backup e ligar a chave.
- **A atualização é a do gateway.** O repassador vem junto; o cloudflared não se
  atualiza sozinho de propósito (`--no-autoupdate`), porque um processo que se
  troca sozinho no meio do expediente é surpresa, e surpresa aqui é nota que não
  sai. Para atualizá-lo, baixe o novo e troque o arquivo.
- **O log é um só.** As linhas do repassador e do túnel saem no log do gateway,
  com prefixo `[repassador]` e `[túnel]`.
- O token permanente da Meta não vence, mas é revogável. Se alguém revogar, o
  sintoma é "o bot parou de responder" — troque na tela e salve.

## Antes de tudo isso: o ensaio

Dá para ver a conversa inteira funcionando sem Meta, sem túnel e sem gastar
nada:

```bash
node relay/ensaio.js
```

Abre em `http://127.0.0.1:8099`. É o mesmo `conversa.js` que roda em produção,
com o cadastro de verdade puxado do gateway. Se algo estiver errado no fluxo,
aparece aqui.
