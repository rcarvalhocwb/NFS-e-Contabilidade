-- O WhatsApp do cliente ligado à empresa dele.
--
-- A ideia: o cliente pede a nota pelo WhatsApp em vez de entrar num portal. Do
-- lado do gateway, isso é um cadastro — o número é a identidade, e é ele que
-- diz por qual CNPJ aquela pessoa pode pedir.
--
-- NÚMERO DE TELEFONE É IDENTIDADE, NÃO CREDENCIAL. Quem estiver com o aparelho
-- na mão fala como se fosse o dono: chip clonado, celular perdido, WhatsApp Web
-- esquecido aberto no computador da recepção. Por isso o número sozinho nunca
-- emite nada — ele só produz uma solicitação, que segue as mesmas travas do
-- portal: a empresa precisa estar liberada, e alguém do escritório aprova
-- (`config_nuvem.emitir_automatico` nasce falso).

CREATE TABLE IF NOT EXISTS contatos_whatsapp (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,

  /* Guardado em E.164 sem o "+": 5541999998888.
     A normalização é o ponto delicado no Brasil — celular ganhou o nono dígito
     e o WhatsApp nem sempre entrega o número com ele. Ver contatosWhatsapp.js. */
  telefone      varchar(20) NOT NULL UNIQUE,
  nome          varchar(120),
  cargo         varchar(80),
  ativo         boolean NOT NULL DEFAULT TRUE,

  /* Teto por solicitação, em reais. Nulo = sem teto.
     Serve para o escritório dar corda curta a quem emite valores rotineiros:
     acima do teto a solicitação chega marcada para conferência, mesmo que a
     empresa esteja no modo automático. */
  limite_valor  numeric(15,2),

  ultimo_uso    timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contatos_whatsapp_empresa
  ON contatos_whatsapp (empresa_id);

COMMENT ON TABLE contatos_whatsapp IS
  'Números de WhatsApp autorizados a pedir nota por empresa. O número identifica; quem autoriza a emissão continua sendo o escritório.';

/* De onde veio a solicitação.
   Sem isso, "quem pediu esta nota?" só tem resposta enquanto alguém lembra. E o
   remetente é o que permite responder no mesmo canal. */
ALTER TABLE solicitacoes
  ADD COLUMN IF NOT EXISTS origem    varchar(12) NOT NULL DEFAULT 'portal',
  ADD COLUMN IF NOT EXISTS remetente varchar(60);

DO $$ BEGIN
  ALTER TABLE solicitacoes ADD CONSTRAINT solicitacoes_origem_ck
    CHECK (origem IN ('portal', 'whatsapp', 'api'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN solicitacoes.remetente IS
  'Quem pediu, no formato do canal: número de WhatsApp, e-mail do portal. É por ele que a resposta volta.';
