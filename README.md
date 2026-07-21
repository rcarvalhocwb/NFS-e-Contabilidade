# nfse-gateway

Gateway de comunicação entre o seu sistema emissor e o **Portal Nacional NFS-e** (API Sefin Nacional).

O que ele faz: você cadastra as empresas e os certificados digitais A1 (.pfx) no gateway; o seu sistema envia os dados da nota em JSON via API REST; o gateway monta a DPS, assina com o certificado da empresa, transmite à Sefin Nacional (mTLS) e devolve a NFS-e autorizada (chave de acesso + XML). Também consulta e cancela notas.

## Ambientes da Sefin Nacional

| Ambiente | URL base |
|---|---|
| Produção | `https://sefin.nfse.gov.br/sefinnacional` |
| Homologação (produção restrita) | `https://sefin.producaorestrita.nfse.gov.br/SefinNacional` |

Documentação oficial: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica

## Como rodar

```bash
cp .env.example .env
# edite o .env: gere a MASTER_KEY e defina GATEWAY_API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # gera MASTER_KEY

docker compose up -d db     # sobe o PostgreSQL
npm install
npm run migrate             # cria as tabelas
npm start                   # gateway em http://localhost:3000
```

Ou tudo via Docker: `docker compose up --build`.

## Autenticação

Todas as rotas (exceto `/health`) exigem o header `X-API-Key` com o valor de `GATEWAY_API_KEY`.

## Rotas

### 1. Cadastrar empresa

```bash
curl -X POST http://localhost:3000/empresas \
  -H "X-API-Key: SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{
    "cnpj": "12345678000199",
    "razaoSocial": "Empresa Exemplo LTDA",
    "inscricaoMunicipal": "123456",
    "codigoMunicipio": "4106902",
    "opSimpNac": 3,
    "regEspTrib": 0,
    "serieDps": "1",
    "ambiente": "homologacao"
  }'
```

- `codigoMunicipio`: código IBGE de 7 dígitos do município emissor
- `opSimpNac`: 1 = não optante, 2 = MEI, 3 = ME/EPP Simples Nacional
- `ambiente`: `homologacao` ou `producao` (por empresa)

Outras: `GET /empresas`, `GET /empresas/{cnpj}`, `PUT /empresas/{cnpj}`.

### 2. Cadastrar certificado digital A1 (.pfx)

```bash
curl -X POST http://localhost:3000/empresas/12345678000199/certificado \
  -H "X-API-Key: SUA_CHAVE" \
  -F "certificado=@/caminho/certificado.pfx" \
  -F "senha=senha-do-pfx"
```

O gateway valida a senha, extrai validade/CNPJ e grava o arquivo e a senha **criptografados (AES-256-GCM)** no banco. Um novo upload desativa o certificado anterior.

### 3. Emitir NFS-e

```bash
curl -X POST http://localhost:3000/nfse \
  -H "X-API-Key: SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{
    "cnpjEmpresa": "12345678000199",
    "dataCompetencia": "2026-07-21",
    "tomador": {
      "cnpj": "98765432000188",
      "razaoSocial": "Cliente Exemplo SA",
      "email": "financeiro@cliente.com",
      "endereco": {
        "codigoMunicipio": "4106902",
        "cep": "80010000",
        "logradouro": "Rua Exemplo",
        "numero": "100",
        "bairro": "Centro"
      }
    },
    "servico": {
      "codigoTributacaoNacional": "010101",
      "descricao": "Desenvolvimento de software sob encomenda",
      "codigoMunicipioPrestacao": "4106902"
    },
    "valores": {
      "valorServico": 1500.00,
      "aliquotaIss": 2.00,
      "issRetido": false
    }
  }'
```

Resposta (autorizada): `status`, `chaveAcesso`, `nfseXml`, `urlDanfse`, `numero`, `idDps`.
A numeração da DPS é sequencial por empresa e controlada pelo gateway (pode ser sobrescrita enviando `numero`/`serie`).

### 4. Consultar / listar

- `GET /nfse/{chaveAcesso}?cnpjEmpresa=...` — consulta na Sefin Nacional
- `GET /nfse?cnpjEmpresa=...&status=autorizada` — lista notas no banco local
- `GET /nfse/local/{id}` — detalhe local com XMLs (DPS assinada e NFS-e)

### 5. Cancelar

```bash
curl -X POST http://localhost:3000/nfse/{chaveAcesso}/cancelamento \
  -H "X-API-Key: SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{ "cnpjEmpresa": "12345678000199", "codigoMotivo": 1 }'
```

`codigoMotivo`: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros (exige `motivo`).

## Arquitetura

```
Seu sistema ──JSON/REST──▶ nfse-gateway ──DPS assinada (gzip+b64, mTLS)──▶ Sefin Nacional
                              │
                        PostgreSQL
              (empresas, certificados cifrados, notas)
```

- `src/nfse/dpsBuilder.js` — monta o XML da DPS v1.00 (namespace `http://www.sped.fazenda.gov.br/nfse`)
- `src/nfse/assinador.js` — assinatura XMLDSig enveloped (RSA-SHA1 padrão; configurável p/ SHA256)
- `src/nfse/sefinClient.js` — mTLS + gzip/base64 + endpoints `/nfse`, `/dps/{id}`, `/nfse/{chave}/eventos`
- `src/secretbox.js` — AES-256-GCM para certificados/senhas em repouso

## Avisos importantes

1. **Valide a DPS contra o XSD oficial** (gov.br/nfse → Documentação técnica). O builder cobre o caso comum de prestação de serviço; casos especiais (exportação, obra, deduções, reduções de base) exigem campos adicionais.
2. **Homologue primeiro na produção restrita** com o certificado real da empresa.
3. Proteja o `.env` (MASTER_KEY e GATEWAY_API_KEY) e use HTTPS entre seu sistema e o gateway em produção.
4. O leiaute nacional evolui (ver "Atualizações e Implantações" no portal). Acompanhe as notas técnicas.
