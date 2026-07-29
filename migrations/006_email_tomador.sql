-- E-mail ao tomador quando a NFS-e é autorizada.
--
-- Opt-in por empresa: só envia se a empresa habilitar. O e-mail do tomador é
-- capturado na nota no momento da emissão (o mesmo que vai na DPS), para que a
-- notificação não dependa de reprocessar o XML depois.
--
-- A entrega tem fila própria, com retentativa e histórico, pela mesma razão
-- dos webhooks: um SMTP indisponível não pode fazer o e-mail se perder.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS email_tomador_ativo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE notas
  ADD COLUMN IF NOT EXISTS tomador_email VARCHAR(255);

CREATE TABLE IF NOT EXISTS email_entregas (
  id             SERIAL PRIMARY KEY,
  nota_id        INTEGER NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
  destinatario   VARCHAR(255) NOT NULL,
  assunto        TEXT NOT NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','enviado','erro')),
  tentativas     INTEGER NOT NULL DEFAULT 0,
  processar_apos TIMESTAMPTZ,
  bloqueado_ate  TIMESTAMPTZ,
  ultimo_erro    TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_fila
  ON email_entregas (processar_apos NULLS FIRST, id)
  WHERE status = 'pendente';

-- Um e-mail por nota: não notificar o tomador duas vezes se a nota reprocessar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unico ON email_entregas (nota_id);

ALTER TABLE email_entregas ENABLE ROW LEVEL SECURITY;
