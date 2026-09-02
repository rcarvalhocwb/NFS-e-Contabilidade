-- As notas que a empresa RECEBE, e um jeito de achar qualquer uma delas.
--
-- Até aqui o gateway só conhecia o que ele mesmo emitiu. Mas o escritório passa
-- o mês procurando nota de ENTRADA: a que o fornecedor mandou, a que sumiu no
-- e-mail, a que precisa entrar na apuração. Hoje isso é feito abrindo pasta,
-- olhando XML no bloco de notas e conferindo valor a valor.
--
-- DE ONDE ELAS VÊM: dos arquivos XML que o escritório já tem. É o caminho
-- certo e imediato. Puxar direto do Ambiente de Dados Nacional seria melhor,
-- mas o caminho da distribuição por NSU ainda não foi confirmado com
-- certificado real — e este projeto já se queimou assumindo endpoint da Sefin
-- (o /eventos devolve 405 até hoje). Quando confirmar, entra pela coluna
-- `origem` sem mexer em mais nada.
--
-- A QUEM A NOTA PERTENCE: ao CNPJ do TOMADOR. É isso que amarra a entrada à
-- empresa cadastrada, e é isso que faz o escopo por usuário valer aqui também
-- — um cliente da contabilidade não pode ver a nota de entrada de outro.

CREATE TABLE IF NOT EXISTS notas_entrada (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,

  -- A chave é a identidade do documento: reimportar o mesmo arquivo atualiza,
  -- não duplica. Sem isso, a pasta importada duas vezes dobraria a apuração.
  chave_acesso   TEXT NOT NULL UNIQUE,
  numero         TEXT,
  serie          TEXT,

  emitido_em     TIMESTAMPTZ,
  competencia    DATE,

  prestador_doc        TEXT,
  prestador_nome       TEXT,
  prestador_municipio  TEXT,

  tomador_doc    TEXT,
  tomador_nome   TEXT,

  cod_tributacao TEXT,
  descricao      TEXT,
  municipio_incidencia TEXT,

  valor_servico  NUMERIC(15,2),
  valor_iss      NUMERIC(15,2),
  valor_liquido  NUMERIC(15,2),
  aliquota       NUMERIC(7,4),
  iss_retido     BOOLEAN,

  situacao       TEXT NOT NULL DEFAULT 'autorizada',
  origem         TEXT NOT NULL DEFAULT 'xml',
  arquivo        TEXT,                      -- nome do arquivo de onde veio
  xml            TEXT NOT NULL,

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),

  /* O motor de busca.
     Coluna gerada, e não índice de expressão: assim o texto indexado é o mesmo
     que a consulta enxerga, e não há como um ficar velho em relação ao outro.
     `portuguese` porque é ele que trata "serviços" e "serviço" como a mesma
     palavra — com `simple`, procurar no plural não acharia o singular.
     Pesos: A para quem emitiu (é como se procura na prática), B para a
     descrição do serviço, C para números e códigos. */
  busca tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', coalesce(prestador_nome, '')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(descricao, '')), 'B') ||
    setweight(to_tsvector('simple',
      coalesce(numero, '') || ' ' || coalesce(chave_acesso, '') || ' ' ||
      coalesce(prestador_doc, '') || ' ' || coalesce(cod_tributacao, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_notas_entrada_busca
  ON notas_entrada USING GIN (busca);

-- A lista quase sempre é "as notas desta empresa, do mais novo para o mais
-- velho" ou "deste período". Os dois casos no mesmo índice.
CREATE INDEX IF NOT EXISTS idx_notas_entrada_empresa_data
  ON notas_entrada (empresa_id, emitido_em DESC);

CREATE INDEX IF NOT EXISTS idx_notas_entrada_competencia
  ON notas_entrada (empresa_id, competencia);

-- Procurar pelo CNPJ do fornecedor é o segundo caminho mais usado, e a busca
-- textual não serve para prefixo de documento.
CREATE INDEX IF NOT EXISTS idx_notas_entrada_prestador
  ON notas_entrada (empresa_id, prestador_doc);

COMMENT ON TABLE notas_entrada IS
  'NFS-e recebidas pela empresa (ela é a tomadora). Importadas de XML; o campo origem distingue a procedência.';
COMMENT ON COLUMN notas_entrada.busca IS
  'Índice de texto em português, com peso A no prestador, B na descrição e C nos números.';
