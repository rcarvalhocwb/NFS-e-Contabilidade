-- Licença do escritório, e os terminais que ela cobre.
--
-- A cobrança é POR ESCRITÓRIO, sem limite de empresas atendidas — contar CNPJ
-- atendido seria cobrar o cliente por crescer, e é justamente o crescimento
-- dele que traz o próximo terminal. O adicional é por terminal instalado.
--
-- Isso cria um problema que não existia: terminal precisa ser CONTÁVEL. No
-- desenho do instalador, terminal é só um atalho para o painel do servidor —
-- não instala gateway nenhum, porque dois gateways no mesmo banco reservariam
-- a mesma numeração fiscal. Só que atalho não se conta.
--
-- A saída é contar do lado que está sob licença: o servidor. Todo navegador
-- que abre o painel ganha uma marca durável e vira uma linha aqui. Não é
-- perfeito — quem abrir o painel do celular uma vez aparece — e por isso a
-- coluna `contar` existe: o administrador do escritório diz o que é terminal
-- de trabalho e o que foi visita.

CREATE TABLE IF NOT EXISTS licenca (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- A licença assinada, como veio. Guardada inteira e nunca em pedaços: a
  -- assinatura cobre os bytes, e uma cópia "interpretada" no banco seria uma
  -- segunda verdade capaz de divergir da primeira.
  texto         text,
  -- De onde veio, para o atendimento saber o que perguntar.
  origem        text CHECK (origem IN ('ativacao', 'arquivo', 'instalador')),
  instalada_em  timestamptz,
  instalada_por integer REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Último contato com o emissor. Nulo não é erro: rede fechada é caso
  -- previsto, e a licença vale offline pela própria assinatura.
  ultimo_contato timestamptz,
  ultimo_erro    text,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO licenca (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE licenca IS
  'Uma linha só. A licença não impede emitir nota em situação nenhuma.';

-- ---------------------------------------------------------------- terminais

CREATE TABLE IF NOT EXISTS terminais (
  id             serial PRIMARY KEY,
  -- Marca durável do navegador, sorteada no primeiro acesso e guardada num
  -- cookie de longa duração. Não identifica pessoa: identifica máquina, que é
  -- o que se cobra.
  chave          text NOT NULL UNIQUE,
  apelido        text,
  primeiro_acesso timestamptz NOT NULL DEFAULT now(),
  ultimo_acesso  timestamptz NOT NULL DEFAULT now(),
  ip             varchar(45),
  user_agent     text,
  -- O próprio servidor não é terminal adicional: ele É a licença. Marcado na
  -- primeira vez em que o acesso vem de 127.0.0.1.
  eh_servidor    boolean NOT NULL DEFAULT FALSE,
  -- O escritório diz o que conta. Sem isso, o celular de quem abriu o painel
  -- uma vez no domingo entraria na fatura — e uma cobrança que o cliente não
  -- reconhece custa mais do que o terminal vale.
  contar         boolean NOT NULL DEFAULT TRUE,
  observacao     text
);

CREATE INDEX IF NOT EXISTS idx_terminais_ultimo ON terminais (ultimo_acesso DESC);

COMMENT ON COLUMN terminais.chave IS
  'Marca do navegador (cookie durável). Identifica máquina, não pessoa.';
COMMENT ON COLUMN terminais.contar IS
  'Entra na conta de terminais contratados. O administrador do escritório decide.';

-- Liga a sessão ao terminal de onde ela veio, para a lista mostrar quem usa
-- cada máquina. ON DELETE SET NULL: apagar um terminal da lista não pode
-- derrubar a sessão de quem está trabalhando nele.
ALTER TABLE sessoes
  ADD COLUMN IF NOT EXISTS terminal_id integer REFERENCES terminais(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessoes_terminal ON sessoes (terminal_id);
