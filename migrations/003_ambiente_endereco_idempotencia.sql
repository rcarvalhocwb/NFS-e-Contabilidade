-- Fase 1: numeração por ambiente, endereço do emitente, idempotência e novos status.
--
-- Motivação (comparação com gateways em produção, ex. Focus NFe):
--   1. Série e numeração da DPS são independentes por ambiente. Mantê-las numa
--      coluna única faz o contador de homologação avançar a numeração que será
--      usada em produção, quebrando a sequência fiscal.
--   2. A DPS pode exigir o endereço do prestador conforme o caso; hoje só
--      guardamos o código do município.
--   3. Sem chave de idempotência, um timeout seguido de retry do sistema
--      emissor gera nota duplicada — problema fiscal caro de desfazer.
--   4. O ciclo de vida real tem mais estados que os 5 atuais, e o envio
--      assíncrono precisa distinguir "processando" de "pendente".

---------------------------------------------------------------------------
-- 1. Numeração por empresa E ambiente
---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS numeracao_dps (
  empresa_id   INTEGER     NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ambiente     VARCHAR(12) NOT NULL CHECK (ambiente IN ('producao','homologacao')),
  serie        VARCHAR(5)  NOT NULL DEFAULT '1',
  prox_numero  BIGINT      NOT NULL DEFAULT 1 CHECK (prox_numero >= 1),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, ambiente)
);

-- Migra a numeração existente para o ambiente em que a empresa está hoje,
-- e cria o outro ambiente zerado.
--
-- O bloco só roda se as colunas antigas ainda existirem: sem essa guarda, uma
-- segunda execução desta migração falharia com "column e.serie_dps does not
-- exist", já que ela mesma remove as colunas mais abaixo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'empresas' AND column_name = 'serie_dps') THEN

    INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
    SELECT e.id, e.ambiente, e.serie_dps, e.prox_num_dps FROM empresas e
    ON CONFLICT (empresa_id, ambiente) DO NOTHING;

    INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
    SELECT e.id,
           CASE WHEN e.ambiente = 'producao' THEN 'homologacao' ELSE 'producao' END,
           e.serie_dps, 1
    FROM empresas e
    ON CONFLICT (empresa_id, ambiente) DO NOTHING;
  END IF;
END $$;

-- Remove as colunas antigas: manter duas fontes de verdade para a numeração
-- é fonte garantida de divergência.
ALTER TABLE empresas DROP COLUMN IF EXISTS serie_dps;
ALTER TABLE empresas DROP COLUMN IF EXISTS prox_num_dps;

---------------------------------------------------------------------------
-- 2. Dados complementares do emitente (endereço, contato, responsável)
---------------------------------------------------------------------------
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS nome_fantasia      VARCHAR(300),
  ADD COLUMN IF NOT EXISTS inscricao_estadual VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cep                VARCHAR(8),
  ADD COLUMN IF NOT EXISTS logradouro         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS numero             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS complemento        VARCHAR(150),
  ADD COLUMN IF NOT EXISTS bairro             VARCHAR(150),
  ADD COLUMN IF NOT EXISTS uf                 CHAR(2),
  ADD COLUMN IF NOT EXISTS email              VARCHAR(255),
  ADD COLUMN IF NOT EXISTS telefone           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS responsavel_nome   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS responsavel_cpf    VARCHAR(11),
  ADD COLUMN IF NOT EXISTS contador_doc       VARCHAR(14);

---------------------------------------------------------------------------
-- 3. Idempotência e ambiente na nota
---------------------------------------------------------------------------
ALTER TABLE notas
  ADD COLUMN IF NOT EXISTS referencia VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ambiente   VARCHAR(12);

-- Preenche o ambiente das notas já existentes a partir da empresa.
UPDATE notas n SET ambiente = e.ambiente
  FROM empresas e WHERE n.empresa_id = e.id AND n.ambiente IS NULL;

-- A referência é única por empresa: é ela que impede a nota duplicada
-- quando o sistema emissor repete uma requisição que deu timeout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notas_referencia
  ON notas (empresa_id, referencia) WHERE referencia IS NOT NULL;

---------------------------------------------------------------------------
-- 4. Novos status do ciclo de vida
---------------------------------------------------------------------------
-- 'pendente' passa a se chamar 'processando' (o envio agora é assíncrono).
UPDATE notas SET status = 'processando' WHERE status = 'pendente';

ALTER TABLE notas DROP CONSTRAINT IF EXISTS notas_status_check;
ALTER TABLE notas ADD CONSTRAINT notas_status_check
  CHECK (status IN ('processando','autorizada','rejeitada','cancelada','erro','substituida','encerrada'));

ALTER TABLE notas ALTER COLUMN status SET DEFAULT 'processando';

---------------------------------------------------------------------------
-- 5. RLS na tabela nova (mesma justificativa da migração 002)
---------------------------------------------------------------------------
ALTER TABLE numeracao_dps ENABLE ROW LEVEL SECURITY;
