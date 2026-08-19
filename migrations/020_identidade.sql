-- Identidade visual do escritório de contabilidade.
--
-- Quem opera o gateway é o escritório, e quem recebe os relatórios é o cliente
-- dele. Um relatório de fechamento com a marca da casa é entregável; um
-- relatório genérico parece rascunho de sistema.
--
-- ONDE A MARCA DO ESCRITÓRIO NÃO ENTRA: no DANFSe. Ele é a representação
-- auxiliar de um documento fiscal cujo emitente é a empresa prestadora. A logo
-- da contabilidade ali sugeriria que foi ela quem emitiu a nota, e o layout
-- segue padrão nacional. Se um dia houver logo no DANFSe, será a da empresa
-- emitente — que é de quem o documento é.

CREATE TABLE IF NOT EXISTS identidade (
  -- Trava de linha única: a instalação atende um escritório
  id             boolean     PRIMARY KEY DEFAULT TRUE CHECK (id),
  nome           varchar(80),
  -- Aparece sob o nome, na barra lateral e na tela de acesso
  descricao      varchar(80),

  -- A logo vive no banco, não no disco: a cópia de segurança já leva o banco,
  -- e um arquivo solto na pasta se perde na primeira troca de máquina.
  logo           bytea,
  logo_tipo      varchar(40),
  logo_bytes     integer,

  -- Uma cor só. O resto do tema é derivado dela: pedir seis cores a quem quer
  -- "colocar a marca da empresa" é o caminho para uma tela desmontada.
  cor_acento     varchar(7),

  -- Rodapé dos relatórios e do pacote de notas
  rodape         varchar(160),
  site           varchar(120),
  telefone       varchar(40),
  email          varchar(120),

  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO identidade (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE identidade IS
  'Marca do escritório no painel e nos relatórios gerenciais. Nunca no DANFSe, que é documento fiscal do prestador.';
