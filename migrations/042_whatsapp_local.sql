-- WhatsApp por sessão própria (open-wa / Baileys), como alternativa à API da Meta.
--
-- POR QUE EXISTE: ligar o WhatsApp pela Meta exige conta Business, verificação
-- da empresa, um número que SAI do aplicativo e um endereço público em HTTPS.
-- Para um escritório de contabilidade isso é uma semana de burocracia antes da
-- primeira mensagem. Por sessão própria são dois minutos e um QR code.
--
-- O QUE ISSO CUSTA, e está escrito no termo que o escritório precisa aceitar:
-- é automação não oficial. O número pode ser banido pelo WhatsApp, e quem
-- fornece o gateway não tem contrato, canal de suporte nem influência nenhuma
-- sobre essa decisão. Por isso o aceite é registrado com nome, data e a versão
-- do texto aceito -- não é formalidade, é a prova de que a escolha foi
-- informada.

CREATE TABLE IF NOT EXISTS whatsapp_local (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ativo         boolean NOT NULL DEFAULT FALSE,

  -- Porta do módulo separado, que roda como processo próprio com ícone próprio
  -- -- do mesmo jeito que o monitor. Ele atende só em 127.0.0.1.
  porta         integer NOT NULL DEFAULT 3200 CHECK (porta BETWEEN 1024 AND 65535),

  -- O número que atende, preenchido pelo próprio módulo depois de conectar.
  -- Nunca digitado: quem informa é o WhatsApp, e digitar abriria espaço para o
  -- escritório achar que configurou um número e estar usando outro.
  numero        text,
  nome_perfil   text,

  -- Estado da sessão, atualizado pelo módulo. Guardado aqui para o painel
  -- mostrar sem depender de o módulo estar de pé -- é justamente quando ele
  -- cai que alguém quer saber o que houve.
  situacao      text NOT NULL DEFAULT 'desligado'
                CHECK (situacao IN ('desligado','esperando_qr','conectando','conectado','caiu','banido')),
  situacao_em   timestamptz,
  ultimo_erro   text,

  -- O aceite. Sem ele o módulo não liga, e isso é conferido no código.
  termo_versao  text,
  termo_aceito_em timestamptz,
  termo_aceito_por integer REFERENCES usuarios(id) ON DELETE SET NULL,
  termo_aceito_nome text,   -- o nome fica gravado mesmo se o usuário for removido

  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO whatsapp_local (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE whatsapp_local IS
  'Transporte alternativo do WhatsApp, por sessão própria. Exige aceite de termo.';
COMMENT ON COLUMN whatsapp_local.termo_aceito_nome IS
  'Nome de quem aceitou, copiado no ato: a prova não pode sumir com o cadastro.';

-- Qual transporte está em uso. Nunca os dois ao mesmo tempo: duas origens
-- escrevendo na mesma conversa gerariam resposta dobrada para o cliente.
ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS wa_transporte text NOT NULL DEFAULT 'meta'
    CHECK (wa_transporte IN ('meta', 'local'));

COMMENT ON COLUMN config_nuvem.wa_transporte IS
  'meta = API oficial pelo repassador na nuvem; local = sessão própria nesta máquina.';
