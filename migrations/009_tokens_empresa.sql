-- Tokens de API por empresa e ambiente.
--
-- Até aqui havia uma única GATEWAY_API_KEY global: quem a tivesse podia operar
-- qualquer empresa. Para o gateway atender vários CNPJs do grupo, cada empresa
-- precisa da própria credencial, separada por ambiente — do contrário um
-- sistema cliente configurado para uma empresa poderia emitir por outra, e um
-- token de teste serviria em produção.
--
-- A chave global continua válida como credencial administrativa (painel e
-- gestão); os tokens por empresa são o que vai para os sistemas clientes.

-- gen_random_bytes() vem do pgcrypto. O Supabase já entregava a extensão
-- habilitada, então isso passou despercebido até o banco passar a rodar num
-- PostgreSQL comum, onde a migração parava aqui. O cadastro de empresa também
-- depende dela (routes/empresas.js gera os tokens no INSERT).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS empresa_tokens (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER     NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ambiente    VARCHAR(12) NOT NULL CHECK (ambiente IN ('producao','homologacao')),
  token       TEXT        NOT NULL UNIQUE,
  descricao   VARCHAR(150),
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  ultimo_uso  TIMESTAMPTZ,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, ambiente)
);

-- Busca no caminho quente da autenticação.
CREATE INDEX IF NOT EXISTS idx_token_busca ON empresa_tokens (token) WHERE ativo;

ALTER TABLE empresa_tokens ENABLE ROW LEVEL SECURITY;

-- Gera os dois tokens para as empresas já cadastradas, para que nenhuma fique
-- sem credencial após a migração.
INSERT INTO empresa_tokens (empresa_id, ambiente, token, descricao)
SELECT e.id, a.ambiente,
       encode(gen_random_bytes(24), 'hex'),
       'Gerado na migração 009'
FROM empresas e
CROSS JOIN (VALUES ('homologacao'), ('producao')) AS a(ambiente)
ON CONFLICT (empresa_id, ambiente) DO NOTHING;
