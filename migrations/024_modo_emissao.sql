-- Quem emite as notas de cada empresa, e a trava que segura o cliente até a
-- parametrização estar pronta.
--
-- Um escritório atende dois tipos de cliente ao mesmo tempo: o que emite as
-- próprias notas e só quer um lugar para fazer isso, e o que manda tudo para a
-- contabilidade e não quer saber de sistema. Forçar os dois no mesmo modelo é
-- escolher qual deles fica insatisfeito — então a escolha é por empresa.
--
-- E é UMA escolha só, não duas: quem guarda o certificado e quem distribui a
-- numeração têm de ser o mesmo lugar. Dois emissores para o mesmo CNPJ produzem
-- número repetido, que a Sefin rejeita, deixando buraco na sequência fiscal.
-- Esta coluna é o registro dessa decisão.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS modo_emissao varchar(10) NOT NULL DEFAULT 'gateway';

DO $$ BEGIN
  ALTER TABLE empresas ADD CONSTRAINT empresas_modo_emissao_ck
    CHECK (modo_emissao IN ('gateway', 'portal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN empresas.modo_emissao IS
  'gateway = o escritório emite com o A1 guardado aqui; portal = o cliente emite lá, com o A1 dele. Um só por empresa: é o mesmo lugar que distribui a numeração.';

/* A trava de liberação.
   Nasce fechada, e é o que faltava para o cliente não emitir antes de o contador
   terminar a parametrização — nota com código de tributação errado sai válida e
   dá trabalho de desfazer. O motivo é escrito para voltar ao cliente no portal:
   "bloqueado" sem explicação é a queixa que mais aparece nas reclamações de
   contabilidade. */
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS portal_liberado     boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS portal_motivo       text,
  ADD COLUMN IF NOT EXISTS portal_decidido_por varchar(160),
  ADD COLUMN IF NOT EXISTS portal_decidido_em  timestamptz;

COMMENT ON COLUMN empresas.portal_liberado IS
  'Se FALSE, solicitação vinda do portal para esta empresa é recusada com o motivo. Padrão fechado: liberar é ato do contador.';
