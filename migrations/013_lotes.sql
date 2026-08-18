-- Emissão em lote.
--
-- O escritório contábil não emite uma nota: emite as trinta do mês, mesmas
-- descrições, clientes diferentes. Fazer isso uma a uma na tela é a tarefa mais
-- cara do fluxo, e é onde erra — pula um cliente, repete outro.
--
-- O lote guarda o arquivo importado e o resultado de cada linha, para que dê
-- para reprocessar só o que falhou sem reemitir o que já saiu.

CREATE TABLE IF NOT EXISTS lotes (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  descricao     VARCHAR(200),
  ambiente      VARCHAR(12) NOT NULL CHECK (ambiente IN ('producao','homologacao')),
  total         INTEGER NOT NULL DEFAULT 0,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lote_itens (
  id         SERIAL PRIMARY KEY,
  lote_id    INTEGER NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  linha      INTEGER NOT NULL,
  -- Dados como vieram da planilha: permite reprocessar sem o arquivo original
  dados      JSONB   NOT NULL,
  nota_id    INTEGER REFERENCES notas(id) ON DELETE SET NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'pendente'
             CHECK (status IN ('pendente','enviado','erro')),
  erro       TEXT,
  UNIQUE (lote_id, linha)
);

CREATE INDEX IF NOT EXISTS idx_lote_itens_lote ON lote_itens (lote_id, linha);
CREATE INDEX IF NOT EXISTS idx_lotes_empresa ON lotes (empresa_id, criado_em DESC);

ALTER TABLE lotes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_itens ENABLE ROW LEVEL SECURITY;
