-- Webhooks: avisar o sistema emissor quando a nota chega a um estado final,
-- em vez de obrigá-lo a ficar consultando.
--
-- São duas tabelas por um motivo: a configuração (webhooks) muda raramente,
-- enquanto cada disparo (webhook_entregas) precisa de fila, retentativa e
-- histórico. Guardar a entrega no banco garante que um endpoint fora do ar
-- não faça a notificação se perder — ela fica pendente e é reenviada.

CREATE TABLE IF NOT EXISTS webhooks (
  id                 SERIAL PRIMARY KEY,
  -- NULL = vale para todas as empresas
  empresa_id         INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  evento             VARCHAR(40) NOT NULL DEFAULT 'nfse',
  url                TEXT NOT NULL,
  -- NULL = vale para os dois ambientes
  ambiente           VARCHAR(12) CHECK (ambiente IN ('producao','homologacao')),
  -- Segredo compartilhado enviado no header indicado, para o receptor
  -- confirmar que a chamada veio deste gateway.
  header_autorizacao VARCHAR(100),
  chave_autorizacao  TEXT,
  ativo              BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_busca
  ON webhooks (evento, empresa_id, ambiente) WHERE ativo;

CREATE TABLE IF NOT EXISTS webhook_entregas (
  id             SERIAL PRIMARY KEY,
  webhook_id     INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  nota_id        INTEGER REFERENCES notas(id) ON DELETE CASCADE,
  evento         VARCHAR(40) NOT NULL,
  payload        JSONB NOT NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','entregue','erro')),
  tentativas     INTEGER NOT NULL DEFAULT 0,
  processar_apos TIMESTAMPTZ,
  bloqueado_ate  TIMESTAMPTZ,
  http_status    INTEGER,
  ultimo_erro    TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fila de entrega (mesmo padrão da fila de emissão).
CREATE INDEX IF NOT EXISTS idx_entregas_fila
  ON webhook_entregas (processar_apos NULLS FIRST, id)
  WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS idx_entregas_nota ON webhook_entregas (nota_id);

-- Uma entrega por webhook e nota: evita notificar duas vezes o mesmo desfecho
-- caso o worker reprocesse a nota.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_unica
  ON webhook_entregas (webhook_id, nota_id, evento) WHERE nota_id IS NOT NULL;

-- RLS pela mesma razão da migração 002: a chave_autorizacao é um segredo e a
-- Data API do provedor não pode alcançar estas tabelas.
ALTER TABLE webhooks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_entregas ENABLE ROW LEVEL SECURITY;
