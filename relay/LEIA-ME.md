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
Bot:      *Contabilidade Silva*
          _Atendimento automático para emissão de notas._

          Olá, Maria! Nota por *ALFA*
          11.111.111/0001-91.

          1 — A nota de sempre — CLIENTE MENSAL, R$ 2.500,00
          2 — Outra nota
          3 — Nota para um cliente novo
Cliente:  1
Bot:      A última foi assim: ... 1 — Mesmo valor  2 — Outro valor
Cliente:  1
Bot:      Confira antes de eu enviar: ...
          1 — Confirmar  2 — Corrigir o valor  3 — Cancelar
Cliente:  1
Bot:      ✓ Pedido enviado. ... Precisa de outra? É só escrever "oi".
```

Três respostas para o caso normal.

**Cliente novo:** a conversa pede só o CNPJ, consulta a base pública e **mostra
o que achou** para a pessoa conferir ou corrigir — a Receita atrasa, e quem pede
a nota conhece o cliente melhor. Para CPF não existe consulta pública, então o
nome é perguntado (é o único campo que a DPS exige além do documento).

**Em qualquer ponto:** `cancelar` encerra, `voltar` refaz, `oi` recomeça, e
`atendente` devolve o telefone e o e-mail do escritório — ninguém fica preso no
robô. Conversa parada 30 minutos expira, e a próxima mensagem avisa que
expirou.

**Um número pode servir várias empresas.** Quando serve mais de uma, a conversa
pergunta por qual antes de tudo — por número da lista ou digitando o CNPJ — e a
empresa aparece escrita, com CNPJ, na abertura e de novo na conferência. É o que
substitui a barra fixa do painel: no WhatsApp a pessoa rola a tela e perde a
referência, e emitir no CNPJ errado é nota no cliente errado.

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

57 testes, sem WhatsApp nenhum e sem rede. A conversa é função pura e a consulta
pública entra por injeção, então dá para exercitar até os caminhos de erro — base
fora do ar, dado desatualizado, resposta que a pessoa corrige. A assinatura do
webhook é testada com HMAC de verdade.
