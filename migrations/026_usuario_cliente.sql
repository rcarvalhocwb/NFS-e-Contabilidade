-- Pessoas do cliente, cadastradas aqui e replicadas para o portal.
--
-- O escritório é a fonte de verdade de QUEM acessa e O QUE cada um enxerga.
-- Sem isso, o contador teria de manter a mesma lista em dois lugares, e a
-- pergunta "quem tem acesso à empresa X?" passaria a ter duas respostas
-- possíveis — que é exatamente o que se quer evitar.
--
-- O terceiro perfil não entra no painel do gateway. Ele existe para ser
-- replicado: identifica uma pessoa da empresa cliente, com os CNPJs que ela
-- pode ver, e nada além disso.

DO $$ BEGIN
  ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
  ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
    CHECK (perfil IN ('admin', 'operador', 'cliente'));
END $$;

COMMENT ON COLUMN usuarios.perfil IS
  'admin e operador entram no painel do gateway. cliente NÃO entra: existe para ser replicado ao portal, onde a pessoa da empresa cliente acessa.';

/* A SENHA DO PORTAL NÃO MORA AQUI, e é de propósito.
   O gateway replica a lista de quem pode acessar; quem guarda o segredo é o
   portal, onde a pessoa define a própria senha pelo convite. Assim uma invasão
   do portal não expõe credencial nenhuma do escritório — e a fonte de verdade
   continua sendo uma só para o que importa, que é a permissão. */
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS cliente_cargo varchar(80);

-- Estado da última réplica enviada ao portal.
ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS cadastro_hash  varchar(64),
  ADD COLUMN IF NOT EXISTS cadastro_em    timestamptz,
  ADD COLUMN IF NOT EXISTS cadastro_erro  text;

COMMENT ON COLUMN config_nuvem.cadastro_hash IS
  'Impressão digital do último cadastro enviado. Enquanto não mudar, o gateway não reenvia — a réplica é um retrato inteiro, não um fluxo de diferenças.';
