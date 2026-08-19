-- Trilha de auditoria: quem fez o quê, em qual cliente.
--
-- O escritório responde por documento fiscal de terceiros. Quando o cliente
-- pergunta "quem cancelou a nota 1231?", a resposta precisa existir — e é
-- exatamente nessa hora que ela costuma não existir. A emissão já registrava o
-- usuário; cancelamento, troca de certificado e mudança de ambiente não
-- registravam nada.
--
-- Também é o histórico do cliente na tela de gestão: as duas coisas são a mesma
-- lista, lida de ângulos diferentes.

CREATE TABLE IF NOT EXISTS auditoria (
  id            BIGSERIAL PRIMARY KEY,
  ocorrido_em   timestamptz NOT NULL DEFAULT now(),

  -- Quem. O e-mail fica desnormalizado de propósito: a trilha precisa
  -- sobreviver à exclusão do usuário, senão o registro mais importante é
  -- justamente o que some junto com quem saiu do escritório.
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  autor         varchar(160) NOT NULL,
  origem        varchar(12)  NOT NULL DEFAULT 'painel',  -- painel | api | sistema
  ip            varchar(45),

  -- Sobre qual cliente. NULL para ações que não são de uma empresa só.
  empresa_id    INTEGER REFERENCES empresas(id) ON DELETE CASCADE,

  acao          varchar(48) NOT NULL,   -- nota.cancelada, empresa.ambiente, ...
  descricao     text        NOT NULL,   -- frase pronta para a tela
  referencia    varchar(60),            -- chave de acesso, série/número, e-mail
  detalhe       jsonb                   -- o que mudou, quando couber
);

CREATE INDEX IF NOT EXISTS idx_auditoria_empresa ON auditoria (empresa_id, ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_data    ON auditoria (ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_acao    ON auditoria (acao, ocorrido_em DESC);

COMMENT ON TABLE auditoria IS
  'Quem fez o quê em cada cliente. Só cresce: registro de auditoria não se edita nem se apaga.';
