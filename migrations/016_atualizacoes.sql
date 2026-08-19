-- Verificação de atualizações do gateway.
--
-- O gateway roda na máquina da contabilidade, sem TI por perto. Quando uma
-- regra da Sefin muda — e elas mudam, como o E0120 e o E0712 mostraram — a
-- correção precisa chegar sem depender de alguém lembrar de perguntar.
--
-- Uma linha só: é o estado da última verificação, não um histórico. O que
-- interessa saber é "existe versão nova agora?", e guardar todas as consultas
-- anteriores não ajuda ninguém a responder isso.

CREATE TABLE IF NOT EXISTS atualizacao (
  -- Trava de linha única: id só aceita TRUE, então o INSERT ... ON CONFLICT
  -- sempre atualiza a mesma linha
  id                 boolean      PRIMARY KEY DEFAULT TRUE CHECK (id),
  verificado_em      timestamptz,
  -- Resultado da última consulta bem-sucedida
  versao_disponivel  varchar(20),
  url_download       text,
  sha256             varchar(64),
  tamanho_bytes      bigint,
  notas              text,
  publicado_em       timestamptz,
  -- Última falha, para a tela poder dizer por que não sabe da versão nova.
  -- Falha de rede não é erro do operador nem impede emitir.
  erro               text,
  erro_em            timestamptz,
  -- Versão que o operador mandou parar de avisar. Não bloqueia a instalação
  -- depois: só silencia o aviso desta versão específica.
  dispensada         varchar(20),
  -- Caminho do instalador já baixado e com checksum conferido
  arquivo_baixado    text,
  baixado_em         timestamptz
);

COMMENT ON TABLE atualizacao IS
  'Estado da verificação de novas versões do gateway. Linha única.';

INSERT INTO atualizacao (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
