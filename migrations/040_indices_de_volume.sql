-- Índices que só aparecem quando o banco cresce.
--
-- Medido em banco de carga com 120 mil notas e 30 mil notas de entrada — dois
-- anos de um escritório com 40 clientes. Com 9 notas nada disso importa; é
-- justamente esse o problema de só medir no banco de desenvolvimento.
--
-- O PADRÃO QUE APARECEU: as consultas que fazem varredura sequencial são as
-- SEM filtro de empresa — ou seja, a visão do contador, que enxerga todos os
-- clientes. Com filtro por empresa, o mesmo dado sai em 3ms porque existe
-- índice. A tela que mais dói é a de quem mais usa o sistema.
--
-- Custo: índice pesa na escrita. Nota fiscal é escrita uma vez e lida muitas —
-- a troca compensa. Não estou indexando toda chave estrangeira por reflexo:
-- só as que apareceram numa consulta real ou num caminho de exclusão.

-- Listagem "Notas emitidas" sem filtro, e o resumo do painel: as duas ordenam
-- ou filtram por data e varriam a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_notas_criado_em
  ON notas (criado_em DESC);

-- Filtro por situação na mesma tela ("só as rejeitadas").
CREATE INDEX IF NOT EXISTS idx_notas_status_criado
  ON notas (status, criado_em DESC);

-- Soma do período nas notas de entrada, quando o contador olha todos os
-- clientes de uma vez. O índice que havia exige empresa_id na frente.
CREATE INDEX IF NOT EXISTS idx_notas_entrada_emitido
  ON notas_entrada (emitido_em DESC);

-- Pedidos do WhatsApp por empresa: a tela do Portal do cliente e a devolução
-- de resultados passam por aqui.
CREATE INDEX IF NOT EXISTS idx_solicitacoes_empresa
  ON solicitacoes (empresa_id, recebida_em DESC);

-- Resolução de escopo: roda em toda requisição de usuário com perfil limitado,
-- e também no caminho de exclusão de uma empresa.
CREATE INDEX IF NOT EXISTS idx_usuario_empresas_empresa
  ON usuario_empresas (empresa_id);

-- Entrega de webhook procura por empresa e evento.
CREATE INDEX IF NOT EXISTS idx_webhooks_empresa
  ON webhooks (empresa_id);

COMMENT ON INDEX idx_notas_criado_em IS
  'Listagem sem filtro e resumo do painel. Sem ele, 120 mil notas viram varredura sequencial na tela mais usada.';
