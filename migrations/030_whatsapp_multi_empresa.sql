-- Um número pode falar por mais de uma empresa.
--
-- A regra anterior era "um número, uma empresa", para não repetir no WhatsApp a
-- confusão que o painel resolve com a barra fixa. Mas quem cuida do financeiro
-- de três empresas do mesmo grupo teria de andar com três chips — e isso não
-- acontece: a pessoa usa o número dela e alguém dá um jeito por fora.
--
-- A troca é: o número pode ser cadastrado em várias empresas, e a conversa
-- passa a PERGUNTAR por qual delas, sempre, antes de qualquer outra coisa. O
-- vínculo continua sendo o que autoriza — só aparecem as empresas em que aquele
-- número está cadastrado, e a escolha é conferida contra o cadastro de novo no
-- gateway, que não confia na resposta que veio da nuvem.

ALTER TABLE contatos_whatsapp DROP CONSTRAINT IF EXISTS contatos_whatsapp_telefone_key;

DO $$ BEGIN
  ALTER TABLE contatos_whatsapp
    ADD CONSTRAINT contatos_whatsapp_telefone_empresa_key UNIQUE (telefone, empresa_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_contatos_whatsapp_telefone
  ON contatos_whatsapp (telefone) WHERE ativo;

COMMENT ON TABLE contatos_whatsapp IS
  'Números de WhatsApp autorizados a pedir nota, por empresa. O mesmo número pode constar em várias — e aí a conversa pergunta por qual antes de começar.';

/* Número de telefone envelhece.
 *
 * Operadora recicla número desligado, gente sai da empresa, celular é trocado.
 * Um cadastro de dois anos atrás pode estar apontando para um desconhecido, e
 * o sistema não tem como saber sozinho. O que dá para fazer é mostrar ao
 * escritório quais estão parados há muito tempo, para alguém decidir. */
ALTER TABLE contatos_whatsapp
  ADD COLUMN IF NOT EXISTS confirmado_em timestamptz,
  ADD COLUMN IF NOT EXISTS confirmado_por varchar(160);

COMMENT ON COLUMN contatos_whatsapp.confirmado_em IS
  'Quando o escritório conferiu pela última vez que este número ainda é de quem se pensa que é.';

/* Mensagens já processadas, para replay não virar nota.
 *
 * A assinatura da Meta prova que o corpo veio dela — e continua provando para
 * sempre. Quem capturar um POST assinado (log de proxy, backup mal guardado)
 * pode reenviá-lo, e sem esta tabela cada reenvio seria um pedido novo.
 * O id da mensagem (wamid) é único na Meta; visto uma vez, não vale de novo. */
CREATE TABLE IF NOT EXISTS mensagens_vistas (
  id_mensagem varchar(120) PRIMARY KEY,
  origem      varchar(12)  NOT NULL DEFAULT 'whatsapp',
  vista_em    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mensagens_vistas_limpeza
  ON mensagens_vistas (vista_em);
