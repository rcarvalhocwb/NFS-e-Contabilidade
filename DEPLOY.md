# Publicação do nfse-gateway

O gateway assina documentos fiscais com o certificado A1 das empresas e guarda
esses certificados cifrados. Isso muda o que é aceitável em produção — as
seções abaixo tratam disso antes das instruções de subida.

## Antes de publicar

### HTTPS não é opcional

A senha do certificado `.pfx` trafega no upload, e os tokens de API vão em todo
request. Sem TLS, qualquer intermediário lê ambos. O gateway não termina TLS por
conta própria: coloque um proxy reverso (nginx, Caddy, Traefik) ou uma
plataforma que já faça isso.

### A MASTER_KEY é insubstituível

Ela é o que decifra os certificados guardados no banco. **Perdê-la significa
perder o acesso a todos os certificados cadastrados** — o backup do banco
sozinho não resolve. Guarde-a em cofre de segredos (ou, no mínimo, num gerenciador
de senhas fora do servidor), separada do backup do banco.

Trocar a MASTER_KEY exige recadastrar todos os certificados: os dados antigos
foram cifrados com a chave anterior.

### O painel `/admin`

É por onde se cadastra empresa e se troca certificado. A página em si não expõe
dados (pede a chave de API no navegador), mas publicá-la na internet aberta
amplia a superfície de ataque sem necessidade.

Escolha uma:

- deixá-la atrás de VPN ou restrição de IP no proxy reverso (recomendado);
- desligá-la com `ADMIN_ATIVO=false` e administrar por túnel SSH.

### Ambiente das empresas

Uma empresa cadastrada com `ambiente: producao` emite **nota fiscal com valor
legal**. Cadastre em `homologacao` e mude só quando o fluxo estiver validado.

---

## Variáveis obrigatórias

```
DATABASE_URL=postgres://...        # banco (Supabase, RDS, Postgres próprio)
GATEWAY_API_KEY=<48+ chars>        # credencial administrativa
MASTER_KEY=<64 chars hex>          # cifra os certificados — ver acima
GATEWAY_BASE_URL=https://...       # URL pública; vai nos links do webhook
```

Gerar as chaves:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Opcionais relevantes: `TRUST_PROXY=true` (atrás de proxy), `ADMIN_ATIVO=false`
(desliga o painel), `SMTP_*` (e-mail ao tomador), `TZ` (padrão
`America/Sao_Paulo` — não mude sem necessidade, afeta `dhEmi` da DPS).

---

## Subindo com Docker

```bash
cp .env.example .env      # e preencha as variáveis acima
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f
```

As migrações rodam sozinhas no start e são idempotentes (`schema_migrations`
controla o que já foi aplicado), então reiniciar não repete nada.

A porta publica em `127.0.0.1:3000` de propósito: quem expõe à internet é o
proxy reverso, que termina o TLS.

### Proxy reverso (exemplo com nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name nfse.suaempresa.com.br;

    ssl_certificate     /etc/letsencrypt/live/nfse.suaempresa.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nfse.suaempresa.com.br/privkey.pem;

    # Upload de certificado .pfx (limite de 1 MB no gateway, com folga aqui)
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Painel restrito à rede interna/VPN — ajuste as faixas
    location /admin {
        allow 192.168.0.0/16;
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Com `TRUST_PROXY=true`, o gateway lê `X-Forwarded-Proto` e reconhece que a
conexão é HTTPS.

---

## Múltiplas instâncias

Subir várias réplicas é seguro: o estado das filas vive no banco e a
reivindicação usa `FOR UPDATE SKIP LOCKED` com lease temporal, então workers
concorrentes pegam trabalhos diferentes e um processo que morre no meio libera
o item ao fim do lease.

---

## Depois de publicar

1. `GET /health` responde `{"ok":true}`
2. Cadastre uma empresa em **homologação**
3. Anexe o certificado A1 e confira a validade exibida
4. Configure o webhook do sistema cliente
5. Emita uma nota de teste e confirme que o webhook chegou com os links de XML e PDF
6. Só então mude a empresa para `producao`

## Operação

- **Backup**: o banco guarda certificados cifrados, notas e XMLs. Se usa
  Supabase/RDS, confirme que o backup automático está ativo.
- **Retenção fiscal**: XMLs de NFS-e devem ser guardados pelo prazo legal. O
  `GET /nfse/export` baixa em lote por período.
- **Certificados vencendo**: o painel mostra alerta a partir de 30 dias. Um A1
  vencido derruba a emissão da empresa.
