-- O inquilino passa a ser o escritório, não a instalação.
--
-- Até aqui cada escritório de contabilidade rodava a sua própria cópia: um
-- banco, um `identidade`, uma `licenca`, uma linha só em cada tabela de
-- configuração. O modelo novo é um servidor atendendo vários escritórios, e
-- isso muda a pergunta que o banco precisa saber responder. Não é mais "qual é
-- a configuração?", é "a configuração de quem?".
--
-- POR QUE COLUNA EM TODA TABELA, E NÃO JOIN ATÉ A EMPRESA
--
-- Quase toda tabela já chega na empresa por `empresa_id`, e a empresa chegaria
-- no escritório. Daria para escrever as policies como subconsulta. Não damos:
-- policy é código que roda em toda linha de todo SELECT, e uma que precisa de
-- join é uma que o planejador não consegue usar índice para satisfazer. Pior,
-- é uma que se escreve errado sem ninguém notar — o erro não aparece como
-- falha, aparece como linha do escritório vizinho na tela.
--
-- `escritorio_id` desnormalizado em cada tabela deixa toda policy com a mesma
-- forma (`escritorio_id = inquilino_atual()`), indexável e conferível por
-- inspeção. A redundância é paga com as chaves estrangeiras compostas mais
-- abaixo, que tornam a incoerência impossível em vez de improvável.
--
-- O QUE NÃO GANHA DONO
--
-- `municipios`, `regra_im_dps` e `atualizacao` são conhecimento do mundo, não
-- do cliente: o código IBGE de Curitiba e o layout que a Sefin exige lá são os
-- mesmos para todo escritório. `config_rede` e `backup_destinos` são do
-- operador do servidor. `mensagens_vistas` guarda id de mensagem da Meta, que
-- é único globalmente — e vale mais como trava global: um webhook já visto não
-- deve poder ser reenviado por outro caminho.

-- ------------------------------------------------------------- o inquilino

CREATE TABLE IF NOT EXISTS escritorios (
  id          serial      PRIMARY KEY,
  -- Nome curto e identificável em log e tela de operador. A marca que o
  -- cliente vê continua em `identidade`, que agora é uma linha por escritório.
  nome        varchar(120) NOT NULL,
  -- CNPJ do escritório contratante. Nulo enquanto o cadastro não fecha.
  cnpj        varchar(14),
  -- Desligar um escritório não apaga nada: o histórico fiscal dele tem prazo
  -- de guarda que não é nosso para decidir.
  ativo       boolean     NOT NULL DEFAULT TRUE,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escritorios_cnpj
  ON escritorios (cnpj) WHERE cnpj IS NOT NULL;

/* A instalação que existe hoje vira o escritório 1, com o nome que ela já
   usava. Nada de "Escritório padrão": quem abrir a tabela amanhã precisa
   reconhecer a própria casa. */
INSERT INTO escritorios (id, nome)
SELECT 1, COALESCE(NULLIF(TRIM(i.nome), ''), 'Escritório')
  FROM (SELECT nome FROM identidade LIMIT 1) i
 WHERE NOT EXISTS (SELECT 1 FROM escritorios)
UNION ALL
SELECT 1, 'Escritório'
 WHERE NOT EXISTS (SELECT 1 FROM escritorios)
   AND NOT EXISTS (SELECT 1 FROM identidade)
LIMIT 1;

SELECT setval('escritorios_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM escritorios), 1));

-- --------------------------------------------------- quem está perguntando

/* A policy precisa de um número; a conexão traz uma string, ou não traz nada.
   NULLIF + cast concentra as duas conversões num lugar só.

   Sem a variável definida o resultado é NULL, e `escritorio_id = NULL` não é
   verdadeiro para linha nenhuma. Esquecer de dizer quem está perguntando não
   devolve tudo: não devolve nada. É a única direção em que errar é seguro. */
CREATE OR REPLACE FUNCTION inquilino_atual() RETURNS integer
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.escritorio', true), '')::integer $$;

COMMENT ON FUNCTION inquilino_atual() IS
  'Escritório da conexão atual (GUC app.escritorio). NULL = nenhum, e nenhum não vê nada.';

-- ------------------------------------------------------- a coluna, em todas

DO $$
DECLARE
  t text;
  /* Ordem importa só para leitura humana: raiz, pessoas, configuração do
     escritório, depois o que pende de empresa, depois os filhos. */
  tabelas text[] := ARRAY[
    'empresas', 'usuarios', 'sessoes', 'terminais', 'obrigacao_modelos',
    'identidade', 'config_email', 'config_nuvem', 'chatbot', 'licenca',
    'whatsapp_local',
    'auditoria', 'certificados', 'contatos_whatsapp', 'empresa_obrigacoes',
    'empresa_tokens', 'lotes', 'notas', 'notas_entrada', 'numeracao_dps',
    'obrigacoes', 'servicos', 'solicitacoes', 'tomadores', 'usuario_empresas',
    'webhooks',
    'lote_itens', 'webhook_entregas', 'email_entregas'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS escritorio_id integer', t);
    /* Tudo que existe hoje é do escritório 1 — é a conversão de uma instalação
       de um escritório só. Backfill literal, não derivado: derivar por join
       daria o mesmo resultado com mais chance de errar. */
    EXECUTE format('UPDATE %I SET escritorio_id = 1 WHERE escritorio_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN escritorio_id SET NOT NULL', t);
    /* O DEFAULT é a função, não um número.

       Esta é a decisão que evita reescrever todo INSERT do sistema. Há
       centenas deles, e acrescentar `escritorio_id` em cada um seria centenas
       de oportunidades de esquecer — com o esquecimento aparecendo como linha
       gravada no escritório errado, ou (com DEFAULT 1) sempre no primeiro.

       Com `inquilino_atual()` como padrão, o INSERT que não fala em escritório
       cai no escritório da conexão, que é o certo por construção. E sem
       conexão amarrada a função devolve NULL, a coluna é NOT NULL, e a
       gravação falha alto — em vez de cair em qualquer lugar. */
    EXECUTE format('ALTER TABLE %I ALTER COLUMN escritorio_id SET DEFAULT inquilino_atual()', t);
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I, '
      'ADD CONSTRAINT %I FOREIGN KEY (escritorio_id) REFERENCES escritorios (id)',
      t, t || '_escritorio_fk', t || '_escritorio_fk');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (escritorio_id)',
                   'idx_' || t || '_escritorio', t);
  END LOOP;
END $$;

/* Duas travas, e as duas precisam existir.

   O DEFAULT resolve o caso comum: INSERT que não fala em escritório cai no
   da conexão. A policy WITH CHECK (046) resolve o caso hostil: INSERT que
   fala em escritório, e fala no errado, é recusado. Uma sozinha não basta —
   sem o DEFAULT, todo INSERT antigo quebra; sem o WITH CHECK, um INSERT
   explícito escreve onde quiser. */

-- ------------------------------------------- a configuração deixa de ser una

/* As tabelas de configuração nasceram com trava de linha única
   (`id boolean PRIMARY KEY DEFAULT TRUE CHECK (id)`): a instalação atendia um
   escritório, e a trava impedia a segunda linha por engano.

   A coluna `id` fica. Trocar só a chave primária para `escritorio_id` mantém
   `WHERE id = TRUE` funcionando em todo o código que já existe — com RLS, essa
   condição passa a significar "a linha única *deste* escritório", que é
   exatamente o que aquele código sempre quis dizer. O CHECK continua barrando
   a segunda linha dentro do mesmo escritório. */
DO $$
DECLARE
  t text;
  config text[] := ARRAY['identidade', 'config_email', 'config_nuvem',
                         'chatbot', 'licenca', 'whatsapp_local'];
BEGIN
  FOREACH t IN ARRAY config LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_pkey');
    EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (escritorio_id)', t);
  END LOOP;
END $$;

/* `licenca` e `whatsapp_local` usavam `id integer` com sequência, não a trava
   booleana — o CHECK de linha única não existia ali. A chave primária em
   `escritorio_id` passa a garantir o mesmo. */

-- ------------------------------------- referência cruzada vira impossível

/* RLS esconde a linha do vizinho; não impede que uma linha nossa aponte para
   ela. Uma nota do escritório 1 com `empresa_id` de empresa do escritório 2
   passa em toda policy e some da tela dos dois — bug caro de achar.
   Com a chave estrangeira composta o banco recusa a linha na hora. */
ALTER TABLE empresas DROP CONSTRAINT IF EXISTS empresas_escritorio_id_unico;
ALTER TABLE empresas ADD  CONSTRAINT empresas_escritorio_id_unico UNIQUE (escritorio_id, id);

DO $$
DECLARE
  t text;
  velha text;
  filhas text[] := ARRAY[
    'auditoria', 'certificados', 'contatos_whatsapp', 'empresa_obrigacoes',
    'empresa_tokens', 'lotes', 'notas', 'notas_entrada', 'numeracao_dps',
    'obrigacoes', 'servicos', 'solicitacoes', 'tomadores', 'usuario_empresas',
    'webhooks'
  ];
BEGIN
  FOREACH t IN ARRAY filhas LOOP
    /* Só troca a FK se `empresa_id` for obrigatório. Onde ela é opcional
       (auditoria de ação que não é de empresa nenhuma) a composta não serve:
       FK composta com uma coluna NULL simplesmente não é verificada, e trocar
       perderia a verificação que existe. */
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = t AND column_name = 'empresa_id' AND is_nullable = 'NO');

    FOR velha IN
      SELECT c.conname FROM pg_constraint c
       WHERE c.conrelid = t::regclass AND c.contype = 'f'
         AND c.confrelid = 'empresas'::regclass
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, velha);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I '
      'FOREIGN KEY (escritorio_id, empresa_id) '
      'REFERENCES empresas (escritorio_id, id) ON DELETE CASCADE',
      t, t || '_empresa_fk');
  END LOOP;
END $$;

-- ---------------------------------------------- unicidade que era do mundo

/* Estes três eram únicos no banco inteiro porque o banco inteiro era de um
   escritório. Agora "único" precisa dizer para quem. */

-- Empresa atendida por dois escritórios é caso real: troca de contabilidade
-- com sobreposição de competência, ou parte fiscal e parte societária em casas
-- diferentes. Com o índice global, a segunda casa não conseguia cadastrar — e
-- recebia um erro sobre uma linha que a RLS não deixa ela ver.
ALTER TABLE empresas DROP CONSTRAINT IF EXISTS empresas_cnpj_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas (escritorio_id, cnpj);

-- Contador que atende dois escritórios tem um e-mail só. Com o índice global,
-- o segundo cadastro falhava dizendo que o e-mail já existe — vazando que
-- aquela pessoa é usuária de outro cliente nosso.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios (escritorio_id, lower(email));

-- `id_externo` é a chave de idempotência que o cliente escolhe. "PED-001" de
-- um escritório não pode bloquear o "PED-001" do outro.
ALTER TABLE solicitacoes DROP CONSTRAINT IF EXISTS solicitacoes_id_externo_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitacoes_id_externo
  ON solicitacoes (escritorio_id, id_externo);

-- Nota de entrada é documento recebido: se os dois escritórios atendem a mesma
-- empresa, os dois importam a mesma chave, e nenhum dos dois está errado.
ALTER TABLE notas_entrada DROP CONSTRAINT IF EXISTS notas_entrada_chave_acesso_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notas_entrada_chave
  ON notas_entrada (escritorio_id, chave_acesso);

/* `notas.idx_notas_iddps` FICA GLOBAL, de propósito.
   O Id da DPS é CNPJ + série + número: é a identidade do documento perante a
   Sefin, não um nome interno. Duas casas atendendo a mesma empresa e emitindo
   na mesma numeração é emissão em duplicidade — o índice global é a última
   trava antes de o erro virar problema fiscal do cliente. Custa um conflito
   entre inquilinos; vale mais do que custa. */

/* `terminais.chave` também fica global: é valor aleatório de 256 bits, não há
   colisão honesta, e a trava global impede que um terminal registrado num
   escritório seja reapresentado em outro. */
