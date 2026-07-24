-- Emissão assíncrona: campos de fila/retentativa na nota.
--
-- Problema que resolve: hoje o POST /nfse transmite à Sefin dentro da própria
-- requisição. Se a Sefin demora, o sistema emissor fica pendurado; se dá
-- timeout, a nota fica presa em 'processando' para sempre e ninguém tenta de
-- novo — e o emissor não sabe se a nota foi ou não transmitida.
--
-- Solução: a requisição monta, assina e grava a DPS (rápido, sem rede) e
-- devolve 202. Um worker no próprio processo reivindica as notas pendentes e
-- transmite, com retentativa e backoff. O estado vive no banco, então
-- reiniciar o processo não perde nada.

ALTER TABLE notas
  -- quantas vezes já tentamos transmitir
  ADD COLUMN IF NOT EXISTS tentativas    INTEGER NOT NULL DEFAULT 0,
  -- backoff: não tentar antes deste instante
  ADD COLUMN IF NOT EXISTS processar_apos TIMESTAMPTZ,
  -- lease de reivindicação: enquanto no futuro, outro worker não pega
  ADD COLUMN IF NOT EXISTS bloqueado_ate TIMESTAMPTZ,
  -- último erro de transmissão, para diagnóstico no painel
  ADD COLUMN IF NOT EXISTS ultimo_erro   TEXT;

-- Índice da varredura do worker: só as pendentes elegíveis.
CREATE INDEX IF NOT EXISTS idx_notas_fila
  ON notas (processar_apos NULLS FIRST, id)
  WHERE status = 'processando';
