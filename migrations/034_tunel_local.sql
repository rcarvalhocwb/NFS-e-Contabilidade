-- O túnel também vive aqui dentro.
--
-- Faltava a última peça para a conta fechar. Sem VPS, o endereço público vem de
-- um túnel — e um túnel instalado como serviço à parte é exatamente o que se
-- queria evitar: mais um programa para atualizar, mais um lugar onde alguém
-- esquece de olhar quando o bot para de responder.
--
-- Então o gateway sobe o túnel junto com o repassador. Uma chave na tela, dois
-- processos vigiados, um log só. O que o escritório precisa fazer uma vez é
-- criar o túnel no painel da Cloudflare e colar o token aqui.
--
-- Por que túnel nomeado e não o `trycloudflare` de teste: o endereço aleatório
-- muda a cada reinício, e endereço de webhook que muda sozinho significa
-- reconfigurar a Meta toda vez que faltar luz. Com túnel nomeado, o nome é seu
-- e sobrevive a reinício, troca de máquina e troca de IP da operadora.
--
-- O token do túnel vale como a chave do endereço público: quem o tiver
-- consegue publicar o próprio serviço naquele nome. Cifrado, como o resto.

ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS tunel_ativo boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tunel_token_cifrado bytea,
  -- Onde está o cloudflared. Vazio: procura no PATH e na pasta ferramentas/
  ADD COLUMN IF NOT EXISTS tunel_binario text;

COMMENT ON COLUMN config_nuvem.tunel_ativo IS
  'O gateway sobe e vigia o cloudflared nesta máquina, dando endereço público ao repassador sem abrir porta no roteador.';
COMMENT ON COLUMN config_nuvem.tunel_token_cifrado IS
  'Token do túnel nomeado da Cloudflare. Vale como a chave do endereço público — cifrado com a MASTER_KEY.';
