# nfse-gateway

Gateway entre os sistemas do grupo e o **Portal Nacional NFS-e** (Sefin Nacional).

Você cadastra as empresas e os certificados A1 (.pfx); o sistema cliente envia a
nota em JSON; o gateway monta a DPS, assina com o certificado da empresa,
transmite à Sefin (mTLS) e devolve a NFS-e autorizada. Também consulta, cancela,
substitui e entrega XML e DANFSe.

> **Status:** validado em produção — emissão, cancelamento e substituição
> confirmados com notas fiscais reais (`cStat 100`).

## Sumário

- [Como rodar](#como-rodar)
- [Autenticação](#autenticação)
- [Painel](#painel)
- [API para o sistema cliente](#api-para-o-sistema-cliente)
- [Webhook](#webhook)
- [Administração](#administração)
- [Publicação](#publicação)

---

## Como rodar

```bash
cp .env.example .env
# gere as chaves e edite o .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # MASTER_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # GATEWAY_API_KEY

npm install
npm run migrate     # cria/atualiza o schema
npm start           # http://localhost:3000
npm test            # testes dos pontos fiscais
```

Com Postgres local: `docker compose up -d db` antes do migrate.
Em produção, veja [DEPLOY.md](DEPLOY.md).

## Para escritórios contábeis

O gateway foi feito para quem emite pelos clientes, não pela própria empresa.

### Emissão em lote

Uma planilha, uma linha por nota:

```bash
GET  /lote/modelo      # baixa o modelo já preenchido com um exemplo
POST /lote/conferir    # valida sem emitir nada
POST /lote             # emite as linhas válidas
```

**Confira antes de emitir.** Uma nota transmitida só sai por cancelamento, e
cada linha errada consome um número da sequência fiscal. A conferência mostra,
linha por linha, o que passou e o que não passou.

As colunas aceitam apelidos: `cnpj`, `documento` e `cnpj_do_cliente` são a mesma
coisa, e acento, espaço e caixa não importam. Valor pode vir como `1.234,56`.
Linhas com erro ficam registradas no lote, sem impedir as demais.

### Relatórios

```bash
GET /relatorios/fechamento    # totais por empresa no período
GET /relatorios/notas         # uma linha por nota
GET /relatorios/notas.csv     # o mesmo em CSV, para o sistema contábil
```

O fechamento separa o que é ISS a recolher do que ficou retido pelo tomador, e
lista à parte as notas do período que **não** foram autorizadas — elas não
entram nos totais, e é o tipo de coisa que passa despercebida no fim do mês.

Empresa optante do Simples aparece como "no DAS" em vez de um valor de ISS:
mostrar número ali faria procurar uma guia municipal que não existe.

## Banco de dados e backup

O banco pode ficar **na própria máquina** (recomendado) ou num servidor externo.
O instalador pergunta e, na primeira opção, baixa os binários portáteis do
PostgreSQL para dentro da pasta do gateway — sem instalador do sistema, sem
privilégio de administrador, e o `Iniciar Gateway.bat` sobe e desce o banco
junto com o gateway.

Local é a opção recomendada porque o gateway já roda na máquina da contabilidade
e não é exposto na internet: um banco remoto era a única peça que exigia conexão
para emitir uma nota — e que podia sumir sem aviso.

### Backup

O gateway grava uma cópia por dia em `backups/`, sem ninguém precisar lembrar:

```bash
node scripts/backup.js                 # cópia sob demanda
node scripts/backup.js --sem-notas     # só cadastro, arquivo pequeno
node scripts/restaurar-backup.js backups/nfse-backup-....json --conferir
node scripts/restaurar-backup.js backups/nfse-backup-....json
```

Desligue com `BACKUP_ATIVO=false`; mude a pasta com `BACKUP_PASTA`.

O certificado A1 sai cifrado no backup, do jeito que está no banco. Sem a
`MASTER_KEY` do `.env` ele não abre — **guarde as duas coisas separadas**, e nem
uma nem outra no repositório (`backups/` está no `.gitignore`).

> Em 17/08/2026 o projeto Supabase que hospedava o banco desapareceu e não havia
> cópia nenhuma: empresa, numeração fiscal, tokens e histórico se foram juntos.
> Backup automático do provedor não protege contra o provedor sumir.

## Autenticação

Três credenciais, cada uma com um dono claro:

| Credencial | Para quem | Alcance |
|---|---|---|
| **login de usuário** (cookie de sessão) | pessoas que operam o painel | conforme perfil e empresas vinculadas |
| **token da empresa** (`X-API-Key`) | sistema cliente | uma empresa, um ambiente |
| `GATEWAY_API_KEY` (`X-API-Key`) | máquina / instalação | tudo |

Pessoas entram com **e-mail e senha**, não com a chave de API. A chave é a mesma
para todo mundo, não diz quem agiu e revogá-la derrubaria as integrações junto —
por isso ela ficou restrita a chamadas de sistema e à criação do primeiro acesso.

### Perfis

| Perfil | Pode |
|---|---|
| **operador** | emitir, consultar, cancelar; cadastrar cliente e serviço |
| **administrador** | tudo isso e mais: empresas, certificado, numeração, tokens, webhooks, municípios, usuários |

Cada usuário pode ser vinculado a empresas específicas; sem vínculo, enxerga
todas. O escopo é aplicado no banco, não só na tela: uma nota de empresa fora do
escopo responde 404.

A sessão dura 12 horas e se renova a cada uso. Senha guardada com `scrypt`
(sal por usuário). Trocar a senha ou desativar a conta encerra as sessões abertas.

### Primeiro acesso

O instalador cria o usuário administrador ao final da instalação. Fora dele:

```bash
node scripts/criar-usuario.js --nome "Maria" --email maria@empresa.com --senha "..."
```

O mesmo script redefine a senha do administrador com `--redefinir`, caso ninguém
mais consiga entrar. Alternativamente, com o sistema ainda sem nenhum usuário, o
painel oferece a tela de primeiro acesso, autorizada pela `GATEWAY_API_KEY`.

O token **define** a empresa e o ambiente: o cliente não precisa (nem consegue)
informar `cnpjEmpresa` ou `ambiente` — o gateway usa os do token. Isso impede que
um sistema emita por outro CNPJ do grupo, ou que um token de teste emita em
produção.

Os tokens são criados junto com a empresa. Para vê-los:
`GET /integracao/{cnpj}` (credencial administrativa).

## Painel

`http://localhost:3000/admin` — a raiz `/` redireciona para lá.

Empresas (cadastro em abas, com autopreenchimento por CNPJ e CEP), certificados,
numeração por ambiente, notas com filtros e XMLs, municípios e a aba
**Integração / API** com os tokens e exemplos prontos para entregar ao cliente.

---

## API para o sistema cliente

Todas exigem `X-API-Key` com o token da empresa.

### Emitir

```bash
curl -X POST http://localhost:3000/nfse \
  -H "X-API-Key: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "referencia": "PEDIDO-123",
    "dataCompetencia": "2026-07-01",
    "tomador": {
      "cnpj": "00000000000191",
      "razaoSocial": "Cliente Exemplo SA",
      "endereco": { "codigoMunicipio": "4106902", "cep": "80010000",
                    "logradouro": "Rua Exemplo", "numero": "100", "bairro": "Centro" }
    },
    "servico": {
      "codigoTributacaoNacional": "110201",
      "descricao": "Descricao do servico prestado",
      "codigoMunicipioPrestacao": "4106902"
    },
    "valores": { "valorServico": 1000.00, "percentualTotalTributosSN": 10.43 }
  }'
```

Responde **202** — a nota entra na fila e é transmitida em seguida:

```json
{ "notaId": 12, "serie": "2", "numero": 5, "status": "processando",
  "acompanhe": "/nfse/local/12" }
```

O resultado chega pelo [webhook](#webhook), ou por consulta.

**`referencia`** é a chave de idempotência: repetir a mesma emissão devolve
**200** com a nota original, em vez de emitir outra. Use o identificador do
pedido no seu sistema.

**Tributos:** empresa do Simples Nacional informa `percentualTotalTributosSN`
(a alíquota efetiva do PGDAS). Fora do Simples, informe `valores.aliquotaIss`.

### Consultar e obter documentos

```bash
GET /nfse/{chaveAcesso}            # consulta na Sefin
GET /nfse?status=autorizada        # lista as notas da empresa
GET /nfse/local/{id}               # detalhe, com XMLs
GET /nfse/{chaveAcesso}/xml        # XML da NFS-e (documento fiscal)
GET /nfse/{chaveAcesso}/xml-dps    # DPS assinada (auditoria)
GET /nfse/{chaveAcesso}/danfse     # DANFSe em PDF
GET /nfse/export?inicio=2026-07-01&fim=2026-07-31   # XMLs em .zip
```

### Cancelar

```bash
curl -X POST http://localhost:3000/nfse/{chaveAcesso}/cancelamento \
  -H "X-API-Key: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{ "codigoMotivo": 1, "motivo": "Erro na emissao" }'
```

`codigoMotivo`: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros
(exige `motivo`).

### Substituir

NFS-e não pode ser alterada. Para corrigir, emita uma nova apontando para a
anterior — a Sefin cancela a original automaticamente:

```json
{
  "...": "demais campos da nota",
  "substituicao": {
    "chaveSubstituida": "4106902...",
    "codigoMotivo": "99",
    "motivo": "Correcao de dados do servico"
  }
}
```

### Status possíveis

| Status | Significado |
|---|---|
| `processando` | na fila, aguardando transmissão |
| `autorizada` | NFS-e emitida — XML e DANFSe disponíveis |
| `rejeitada` | a Sefin analisou e recusou (ver `mensagens`) |
| `erro` | falha de comunicação ou credencial (ver `ultimo_erro`) |
| `cancelada` | cancelada por evento |
| `substituida` | substituída por outra nota |

---

## Webhook

Ao chegar a estado final, o gateway envia POST ao endpoint configurado:

```json
{
  "evento": "nfse",
  "referencia": "PEDIDO-123",
  "status": "autorizada",
  "chaveAcesso": "4106902...",
  "documentos": {
    "xmlNfse":   "https://.../nfse/{chave}/xml",
    "xmlDps":    "https://.../nfse/{chave}/xml-dps",
    "danfsePdf": "https://.../nfse/{chave}/danfse"
  },
  "ocorridoEm": "2026-07-29T16:00:34.000Z"
}
```

Os links usam o mesmo token da emissão. A entrega é enfileirada com retentativa
(backoff até 6 tentativas), então um endpoint fora do ar não perde a
notificação. Configure em `POST /webhooks`, com `headerAutorizacao` e
`chaveAutorizacao` para o receptor confirmar a origem.

---

## Administração

Exigem perfil de administrador (ou a `GATEWAY_API_KEY`):

```bash
POST   /empresas                        # cadastra e já devolve os tokens
GET    /empresas/{cnpj}/numeracao       # série e próximo número por ambiente
PUT    /empresas/{cnpj}/numeracao       # ajusta a numeração de um ambiente
POST   /empresas/{cnpj}/certificado     # upload do .pfx (multipart)
GET    /integracao/{cnpj}               # pacote de integração do cliente
POST   /integracao/{cnpj}/tokens        # gera novo token (invalida o anterior)
GET    /municipios                      # Nacional vs. emissor próprio
POST   /webhooks                        # cadastra destino de notificação
GET    /usuarios                        # quem acessa o painel
POST   /usuarios                        # cadastra usuário
PUT    /usuarios/{id}                   # perfil, empresas, senha, situação
POST   /usuarios/{id}/encerrar-sessoes  # derruba as sessões abertas
```

Qualquer usuário logado acessa a própria conta:

```bash
GET    /usuarios/eu                     # perfil e empresas do usuário atual
POST   /usuarios/eu/senha               # troca a própria senha
```

### Numeração por ambiente

Homologação e produção têm série e sequência **independentes**. Emitir em
homologação não consome números da produção. Ao migrar de outro emissor, ajuste
o próximo número em `PUT /empresas/{cnpj}/numeracao` — ou use uma série própria
para o gateway, evitando colisão.

### Municípios

Sob a LC 214/2025 os municípios migram para o Sistema Nacional, mas alguns ainda
usam emissor próprio (padrão ABRASF). O gateway só fala o Nacional: municípios
marcados como `proprio` têm a emissão bloqueada com aviso, em vez de falharem na
Sefin. Classifique em `PUT /municipios/{codigoIbge}`.

---

## Publicação

Veja [DEPLOY.md](DEPLOY.md). Em resumo: HTTPS é obrigatório (a senha do `.pfx`
trafega no upload), a `MASTER_KEY` é insubstituível e precisa de backup próprio,
e o painel `/admin` deve ficar atrás de VPN/IP restrito ou desligado com
`ADMIN_ATIVO=false`.

## Avisos

1. **Valide a DPS contra o XSD oficial** para casos especiais (exportação, obra,
   deduções, retenções federais). O builder cobre a prestação de serviço comum.
2. **Homologue antes de produzir.** Empresa com `ambiente: producao` emite nota
   com valor legal.
3. O leiaute nacional evolui — acompanhe as notas técnicas em
   [gov.br/nfse](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica).
