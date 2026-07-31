-- Memória do emissor: tomadores e serviços já usados.
--
-- O emissor local é operado por quem não conhece o leiaute fiscal. Pedir
-- código de tributação nacional e endereço completo a cada nota seria lento e
-- fonte de erro. Guardando o que já foi usado, a emissão seguinte vira
-- "escolher o cliente, escolher o serviço, informar o valor".

CREATE TABLE IF NOT EXISTS tomadores (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  documento      VARCHAR(14) NOT NULL,          -- CNPJ ou CPF, só dígitos
  razao_social   VARCHAR(300) NOT NULL,
  email          VARCHAR(255),
  telefone       VARCHAR(20),
  codigo_municipio VARCHAR(7),
  cep            VARCHAR(8),
  logradouro     VARCHAR(255),
  numero         VARCHAR(20),
  complemento    VARCHAR(150),
  bairro         VARCHAR(150),
  uf             CHAR(2),
  vezes_usado    INTEGER NOT NULL DEFAULT 0,
  ultimo_uso     TIMESTAMPTZ,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, documento)
);

-- Ordenação da lista de sugestões: mais usados e mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_tomadores_uso
  ON tomadores (empresa_id, vezes_usado DESC, ultimo_uso DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS servicos (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  apelido           VARCHAR(100) NOT NULL,      -- nome curto que o operador reconhece
  codigo_tributacao VARCHAR(6) NOT NULL,        -- cTribNac
  descricao         TEXT NOT NULL,              -- vai na nota
  valor_padrao      NUMERIC(15,2),              -- sugestão, editável na emissão
  aliquota_iss      NUMERIC(5,2),               -- usada fora do Simples Nacional
  iss_retido        BOOLEAN NOT NULL DEFAULT FALSE,
  vezes_usado       INTEGER NOT NULL DEFAULT 0,
  ultimo_uso        TIMESTAMPTZ,
  ativo             BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, apelido)
);

CREATE INDEX IF NOT EXISTS idx_servicos_uso
  ON servicos (empresa_id, vezes_usado DESC, ultimo_uso DESC NULLS LAST) WHERE ativo;

ALTER TABLE tomadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicos  ENABLE ROW LEVEL SECURITY;
