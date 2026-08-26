# Repassador WhatsApp → gateway

O que fica na internet para o WhatsApp funcionar, e nada além disso.

## Por que ele existe

A Meta entrega mensagem fazendo **POST num endereço público em HTTPS**. Alguém
precisa ter esse endereço, e não pode ser a máquina do escritório — ela guarda
os certificados A1 e as notas de todos os clientes.

Então este processo fica na nuvem, conversa com o cliente, monta o pedido e o
guarda. **O gateway continua puxando**, como já faz com o portal.

## O que ele NÃO faz

Não assina nada, não tem certificado, não distribui numeração fiscal, não guarda
XML nem PDF. Quando a nota sai, o cliente recebe o link da **consulta pública da
Sefin** — o mesmo endereço do QR Code impresso na nota, público por natureza.

Se este servidor for invadido, o que se perde é a fila de pedidos ainda não
buscados. Nada que já virou nota, e nada que assine coisa alguma.

## Instalação

Qualquer VPS pequena serve (1 vCPU, 1 GB). Node 20 ou mais novo.

```bash
cp .env.exemplo .env      # e preencha
npm start
```

Ponha um proxy com HTTPS na frente (Caddy resolve em três linhas e cuida do
certificado sozinho). A Meta não aceita HTTP.

### No painel da Meta

1. **Meta for Developers** → criar app do tipo *Business* → adicionar produto
   **WhatsApp**.
2. **WhatsApp → Configuração da API**: anote o `Phone number ID` e gere o token
   permanente por um usuário do sistema (o token de teste vence em 24h).
3. **Configuração do webhook**: endereço `https://seu-dominio/webhook`, e o
   *verify token* é o que você inventou no `META_VERIFY_TOKEN`.
4. Assine o campo **messages**. Sem isso a Meta não entrega nada.
5. **Configurações do app → Básico**: copie o *App Secret* para
   `META_APP_SECRET` — é o que valida a assinatura de cada POST.

### No gateway

Tela **Portal do cliente** → endereço `https://seu-dominio` e a mesma chave do
`CHAVE_GATEWAY`. Ligue, e mande o cadastro em *Enviar agora*.

Depois, na ficha de cada empresa → aba **Integração**: libere o portal e
cadastre os números de WhatsApp autorizados.

## A conversa

```
Cliente:  oi
Bot:      Olá, Maria! Emissão de notas de *ALFA*.
          1 — A nota de sempre — CLIENTE MENSAL LTDA, R$ 2.500,00
          2 — Outra nota
Cliente:  1
Bot:      A última foi assim: ... 1 — Mesmo valor  2 — Outro valor
Cliente:  1
Bot:      Confira antes de eu enviar: ... 1 — Confirmar  2 — Cancelar
Cliente:  1
Bot:      Pedido enviado. A contabilidade confere e eu te aviso aqui.
```

Três respostas para o caso normal. `cancelar`, `voltar` e `ajuda` funcionam em
qualquer ponto.

**Um número fala por uma empresa só.** No WhatsApp não existe barra mostrando
qual está selecionada — permitir duas traria de volta, pelo canal onde é pior, a
confusão que o painel resolve.

## Custo

Conversa iniciada pelo cliente é **gratuita e sem limite** desde 11/2024,
qualquer que seja o número de mensagens. Só se paga template iniciado pela
empresa — no fluxo daqui, apenas quando o aviso de "nota pronta" cai fora da
janela de 24 horas (~R$ 0,05).

## Manutenção

- Os dados ficam num JSON em `dados/`. Faça backup dele junto com o resto — se
  sumir, perdem-se os pedidos ainda não buscados e as conversas em andamento.
- `GET /saude` diz se o cadastro chegou e quantos pedidos estão na fila.
- Conversa parada mais de 30 minutos é esquecida.
- Desfecho já avisado some depois de uma semana.

## Testes

```bash
npm test
```

31 testes, sem WhatsApp nenhum: a conversa é função pura, e a assinatura do
webhook é testada com HMAC de verdade.
