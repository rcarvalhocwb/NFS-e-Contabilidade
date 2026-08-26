-- Por que a transmissão falhou — e se vale insistir.
--
-- Até aqui a fila tratava toda falha do mesmo jeito: cinco tentativas com
-- espera crescente e, esgotadas, a nota virava 'erro'. Somando as esperas
-- (5s, 20s, 45s, 80s, 125s), QUALQUER QUEDA DE INTERNET DE MAIS DE CINCO
-- MINUTOS queimava todas as notas da fila. O número reservado se perde junto:
-- número de DPS não se reaproveita, então cada nota assim deixa um buraco na
-- sequência fiscal da empresa.
--
-- Numa contabilidade a internet cai, o roteador reinicia, o provedor troca de
-- rota. Cinco minutos é pouco. E a queda não é julgamento da nota: a Sefin nem
-- chegou a ver o documento.
--
--   rede       não alcançou a Sefin (DNS, timeout, cabo). Insiste para sempre.
--   sefin      alcançou e ela respondeu 5xx. Insiste para sempre.
--   definitiva certificado inválido, empresa ausente, credencial recusada.
--              Insistir não resolve; desiste depois das tentativas.
--
-- Rejeição de conteúdo (esquema, regra fiscal) não passa por aqui: a nota vai
-- direto para 'rejeitada', que é a Sefin tendo analisado e recusado.

ALTER TABLE notas
  ADD COLUMN IF NOT EXISTS falha_tipo varchar(12);

DO $$ BEGIN
  ALTER TABLE notas ADD CONSTRAINT notas_falha_tipo_ck
    CHECK (falha_tipo IS NULL OR falha_tipo IN ('rede', 'sefin', 'definitiva'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN notas.falha_tipo IS
  'Natureza da última falha de transmissão. rede e sefin são transitórias: a nota fica na fila e não queima o número.';

-- A fila de espera por conexão é o que a tela precisa mostrar primeiro quando
-- a internet cai.
CREATE INDEX IF NOT EXISTS idx_notas_esperando_rede
  ON notas (falha_tipo, atualizado_em)
  WHERE status = 'processando' AND falha_tipo IS NOT NULL;
