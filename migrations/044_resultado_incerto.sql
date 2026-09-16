-- O resultado incerto: nem emitida, nem não-emitida.
--
-- POR QUE EXISTE. Quando a transmissão da DPS falha, o código antigo assumia
-- que ela não tinha saído -- e retransmitia. Isso está certo para DNS que não
-- resolveu ou porta que recusou conexão: aí realmente nada foi enviado.
--
-- Mas um TIMEOUT, ou uma conexão cortada no meio, não prova nada disso. A DPS
-- pode ter chegado, sido processada e virado nota; o que se perdeu foi a
-- resposta no caminho de volta. Retransmitir nesse estado é como se emite a
-- mesma nota duas vezes: dois números fiscais para um serviço só, e desfazer
-- custa um cancelamento -- que nem sempre o município aceita.
--
-- O ESTADO NOVO. `falha_tipo = 'incerto'` marca a nota que está nessa dúvida.
-- Ela continua em 'processando' e volta à fila, mas volta para PERGUNTAR à
-- Sefin se a DPS virou nota (GET /dps/{id}), nunca para enviar de novo.
--
-- E ela NUNCA vira 'erro' por esgotar tentativas, como as outras falhas.
-- 'erro' quer dizer "a nota não saiu", e é exatamente isso que não se sabe.
-- Uma nota parada e visível é recuperável; uma nota declarada não-emitida
-- quando existe no fisco vira duas notas no dia em que alguém reemitir.

DO $$ BEGIN
  ALTER TABLE notas DROP CONSTRAINT notas_falha_tipo_ck;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE notas
  ADD CONSTRAINT notas_falha_tipo_ck
  CHECK (falha_tipo IS NULL
         OR falha_tipo IN ('rede', 'sefin', 'definitiva', 'incerto'));

COMMENT ON COLUMN notas.falha_tipo IS
  'rede/sefin: transitória, retransmite. definitiva: conta tentativas. '
  'incerto: NÃO retransmite -- consulta a Sefin até saber se a DPS virou nota.';

-- Achar as incertas sem varrer a tabela. São raras e urgentes: cada uma é uma
-- nota que pode existir no fisco sem o gateway saber.
CREATE INDEX IF NOT EXISTS idx_notas_incertas
  ON notas (empresa_id, atualizado_em DESC)
  WHERE falha_tipo = 'incerto';
