-- Calendário de obrigações por cliente.
--
-- O escritório acompanha, para cada cliente, um conjunto de compromissos que se
-- repetem: DAS todo dia 20, ISS na data do município, EFD-Reinf, DCTFWeb,
-- fechamento interno. Hoje isso vive numa planilha à parte do sistema que
-- conhece o movimento do cliente.
--
-- DECISÃO IMPORTANTE: os prazos NÃO vêm embutidos no sistema. Quem cadastra é o
-- escritório. Prazo de obrigação acessória muda por lei, portaria e calendário
-- municipal, e um prazo desatualizado dentro do software vira multa para o
-- cliente — com o agravante de parecer confiável por estar na tela. O sistema
-- oferece modelos como ponto de partida e deixa claro que a conferência é de
-- quem cadastra.

-- O que o escritório acompanha. Um modelo vale para vários clientes.
CREATE TABLE IF NOT EXISTS obrigacao_modelos (
  id             SERIAL PRIMARY KEY,
  nome           varchar(80)  NOT NULL,
  descricao      text,
  -- mensal | trimestral | anual | unica
  periodicidade  varchar(12)  NOT NULL DEFAULT 'mensal'
                 CHECK (periodicidade IN ('mensal','trimestral','anual','unica')),
  -- Dia do vencimento dentro do período. 20 = dia 20; 31 = último dia do mês,
  -- ajustado para meses curtos na geração.
  dia_vencimento SMALLINT     NOT NULL DEFAULT 20
                 CHECK (dia_vencimento BETWEEN 1 AND 31),
  -- Para anual: mês do vencimento (1-12). Ignorado nas demais.
  mes_vencimento SMALLINT     CHECK (mes_vencimento BETWEEN 1 AND 12),
  -- Quantos meses depois da competência o prazo cai. O DAS de agosto vence em
  -- setembro: competência 08, vencimento 20/09 → deslocamento 1.
  desloca_meses  SMALLINT     NOT NULL DEFAULT 1,
  alerta_dias    SMALLINT     NOT NULL DEFAULT 5,
  ativo          BOOLEAN      NOT NULL DEFAULT TRUE,
  criado_em      timestamptz  NOT NULL DEFAULT now()
);

-- Quais clientes têm qual obrigação.
CREATE TABLE IF NOT EXISTS empresa_obrigacoes (
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  modelo_id   INTEGER NOT NULL REFERENCES obrigacao_modelos(id) ON DELETE CASCADE,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  observacao  text,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, modelo_id)
);

-- As ocorrências: uma linha por cliente, obrigação e competência.
CREATE TABLE IF NOT EXISTS obrigacoes (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  modelo_id      INTEGER REFERENCES obrigacao_modelos(id) ON DELETE SET NULL,
  -- Nome copiado do modelo: a ocorrência de 2026-03 precisa continuar dizendo
  -- o que era, mesmo que o modelo seja renomeado ou removido depois.
  nome           varchar(80) NOT NULL,
  competencia    varchar(7)  NOT NULL,             -- 2026-08
  vencimento     date        NOT NULL,
  -- pendente | concluida | dispensada
  situacao       varchar(12) NOT NULL DEFAULT 'pendente'
                 CHECK (situacao IN ('pendente','concluida','dispensada')),
  responsavel_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  concluida_em   timestamptz,
  concluida_por  varchar(160),
  observacao     text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, modelo_id, competencia)
);

CREATE INDEX IF NOT EXISTS idx_obrigacoes_agenda
  ON obrigacoes (vencimento) WHERE situacao = 'pendente';
CREATE INDEX IF NOT EXISTS idx_obrigacoes_empresa
  ON obrigacoes (empresa_id, vencimento DESC);

COMMENT ON TABLE obrigacao_modelos IS
  'Obrigações que o escritório acompanha. Prazos cadastrados e conferidos pelo escritório, não embutidos no sistema.';
