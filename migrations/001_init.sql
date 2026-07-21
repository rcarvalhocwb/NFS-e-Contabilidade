CREATE TABLE IF NOT EXISTS empresas (
  id                  SERIAL PRIMARY KEY,
  cnpj                VARCHAR(14) NOT NULL UNIQUE,
  razao_social        VARCHAR(300) NOT NULL,
  inscricao_municipal VARCHAR(15),
  codigo_municipio    VARCHAR(7) NOT NULL,          -- código IBGE (7 dígitos) do município emissor
  op_simp_nac         SMALLINT NOT NULL DEFAULT 1,  -- 1=Não optante 2=MEI 3=ME/EPP Simples Nacional
  reg_esp_trib        SMALLINT NOT NULL DEFAULT 0,  -- 0=Nenhum ... conforme leiaute
  serie_dps           VARCHAR(5) NOT NULL DEFAULT '1',
  prox_num_dps        BIGINT NOT NULL DEFAULT 1,
  ambiente            VARCHAR(12) NOT NULL DEFAULT 'homologacao' CHECK (ambiente IN ('producao','homologacao')),
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificados (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pfx_cifrado     BYTEA NOT NULL,      -- arquivo .pfx criptografado (AES-256-GCM)
  senha_cifrada   BYTEA NOT NULL,      -- senha do pfx criptografada (AES-256-GCM)
  subject         TEXT,
  cnpj_cert       VARCHAR(14),
  valido_ate      TIMESTAMPTZ,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cert_empresa ON certificados (empresa_id) WHERE ativo;

CREATE TABLE IF NOT EXISTS notas (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL REFERENCES empresas(id),
  id_dps        VARCHAR(45) NOT NULL,
  chave_acesso  VARCHAR(50),
  serie         VARCHAR(5) NOT NULL,
  numero        BIGINT NOT NULL,
  status        VARCHAR(15) NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente','autorizada','rejeitada','cancelada','erro')),
  dps_xml       TEXT,
  nfse_xml      TEXT,
  mensagens     JSONB,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notas_iddps ON notas (id_dps);
CREATE INDEX IF NOT EXISTS idx_notas_chave ON notas (chave_acesso);
CREATE INDEX IF NOT EXISTS idx_notas_empresa ON notas (empresa_id);
