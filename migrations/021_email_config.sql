-- Configuração de e-mail pela tela, em vez de só pelo .env.
--
-- O envio da nota ao cliente e o aviso de prazos dependem de SMTP. Hoje isso
-- só se configura editando o .env com o Bloco de Notas e reiniciando o
-- gateway — o que a contabilidade não vai fazer, e por isso o recurso ficava
-- desligado.
--
-- A senha é cifrada com a mesma MASTER_KEY do certificado A1: senha de e-mail
-- em texto puro num banco que sai em cópia de segurança é credencial vazando
-- pela porta dos fundos.
--
-- O .env continua valendo como alternativa: instalação que já configurou por
-- lá não precisa mexer em nada.

CREATE TABLE IF NOT EXISTS config_email (
  -- Linha única: um escritório, um remetente
  id             boolean     PRIMARY KEY DEFAULT TRUE CHECK (id),
  ativo          boolean     NOT NULL DEFAULT FALSE,

  host           varchar(120),
  porta          integer     DEFAULT 587,
  -- true = porta 465 (TLS direto); false = 587 com STARTTLS
  seguro         boolean     NOT NULL DEFAULT FALSE,
  usuario        varchar(160),
  senha_cifrada  text,
  remetente      varchar(200),      -- "Contabilidade X <nfse@exemplo.com.br>"

  -- O que o gateway manda sozinho
  enviar_nota    boolean     NOT NULL DEFAULT TRUE,   -- NFS-e ao tomador
  resumo_diario  boolean     NOT NULL DEFAULT FALSE,  -- prazos do escritório
  resumo_para    varchar(200),                        -- quem recebe o resumo
  resumo_hora    smallint    NOT NULL DEFAULT 8 CHECK (resumo_hora BETWEEN 0 AND 23),
  resumo_enviado_em date,     -- trava para não repetir no mesmo dia

  testado_em     timestamptz,
  ultimo_erro    text,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO config_email (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN config_email.senha_cifrada IS
  'Senha SMTP cifrada com a MASTER_KEY. Para Gmail, é a senha de app — nunca a senha da conta.';
