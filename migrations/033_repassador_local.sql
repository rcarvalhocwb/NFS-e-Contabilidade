-- O repassador rodando na própria máquina do escritório.
--
-- A VPS nunca foi necessária: o que a Meta exige é um endereço público em
-- HTTPS, e um túnel resolve isso com conexão de SAÍDA, sem abrir porta no
-- roteador. O que a VPS dava era separação — repassador invadido numa máquina
-- que não tem nada.
--
-- Contra isso pesa o custo de manutenção, e ele é real: outro sistema
-- operacional para atualizar, outra conta para pagar, outro lugar para esquecer.
-- Num escritório sem quem cuide de servidor, VPS esquecida é risco, não
-- proteção.
--
-- Então o repassador passa a poder rodar aqui, supervisionado pelo gateway:
-- mesma instalação, mesma atualização, mesmo backup, uma configuração só. O que
-- se perde em separação, recupera-se em não ter uma peça abandonada.
--
-- O que NÃO muda: o repassador continua um processo à parte, ouvindo só em
-- 127.0.0.1, sem acesso ao banco nem ao certificado. Quem chegar nele por uma
-- falha ainda precisa escalar para alcançar o que importa.

ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS relay_local boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS relay_porta integer NOT NULL DEFAULT 8080
    CHECK (relay_porta BETWEEN 1024 AND 65535),

  /* Com o repassador aqui dentro, estes dois deixam de morar num .env noutra
     máquina e passam a ser configurados na tela, como todo o resto. Não há
     círculo a fechar: não viajam por canal nenhum — são entregues ao processo
     filho na hora de iniciá-lo. */
  ADD COLUMN IF NOT EXISTS wa_app_secret_cifrado    bytea,
  ADD COLUMN IF NOT EXISTS wa_verify_token_cifrado  bytea,

  -- Endereço público do túnel, para o gateway saber onde se conferir
  ADD COLUMN IF NOT EXISTS relay_url_publica text;

COMMENT ON COLUMN config_nuvem.relay_local IS
  'O gateway sobe e vigia o repassador nesta máquina. Desligado, ele roda noutro lugar e o endereço é o de config_nuvem.url.';
COMMENT ON COLUMN config_nuvem.wa_app_secret_cifrado IS
  'App Secret da Meta. Só existe aqui quando o repassador é local — noutro servidor ele fica no .env de lá, porque mandá-lo pelo canal que ele protege fecharia o círculo.';
