-- RLS deixa de ser cortina e passa a ser a trava.
--
-- A 002 ligou RLS em três tabelas sem criar policy nenhuma. Aquilo era defesa
-- contra a Data API do Supabase: nenhuma policy = negação total para quem
-- chega por chave anônima, e a aplicação seguia funcionando porque conectava
-- como dona das tabelas, e dona ignora RLS. Fazia sentido enquanto o banco
-- inteiro pertencia a um escritório só.
--
-- Não faz mais. Com vários escritórios no mesmo banco, a pergunta "o contador
-- da casa A pode ler o certificado digital da casa B?" não pode depender de
-- ninguém ter lembrado do WHERE. Um WHERE esquecido numa rota de relatório é
-- um erro de digitação; vazar o certificado A1 de um cliente é um incidente
-- que não tem como desfazer. A diferença entre os dois tem que estar no banco.
--
-- O QUE ISTO EXIGE DA APLICAÇÃO — e é a parte que costuma ser esquecida:
--
--   1. Conectar com papel que NÃO é dono das tabelas e NÃO é superusuário.
--      Dono ignora policy. Superusuário ignora policy. Um `FORCE ROW LEVEL
--      SECURITY` resolve o dono, mas não o superusuário — e a instalação de
--      hoje conecta justamente com o superusuário que criou o banco. Sem
--      trocar o papel, tudo abaixo é decoração. Ver scripts/papel-app.js.
--
--   2. Definir `app.escritorio` a cada requisição, antes da primeira consulta.
--      Ver src/db.js.
--
-- Não definir a variável não abre nada: `inquilino_atual()` devolve NULL,
-- `escritorio_id = NULL` não é verdadeiro, e a consulta volta vazia. O modo de
-- falhar é perder dado de vista, nunca mostrar dado alheio.

DO $$
DECLARE
  t text;
  /* Toda tabela com dono. A de fora desta lista ou é conhecimento do mundo
     (municipios, regra_im_dps, atualizacao), ou é do operador do servidor
     (config_rede, backup_destinos), ou é trava global de replay
     (mensagens_vistas), ou é infraestrutura (schema_migrations).
     O teste em test/inquilino.test.js falha se alguma tabela nova aparecer
     sem estar nem aqui nem naquela lista — é assim que esta lista não
     envelhece. */
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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS inquilino ON %I', t);
    /* USING filtra o que sai; WITH CHECK filtra o que entra. Sem o segundo,
       um INSERT com escritorio_id alheio é aceito e some — linha gravada no
       banco do vizinho, invisível para quem gravou. */
    EXECUTE format(
      'CREATE POLICY inquilino ON %I FOR ALL TO PUBLIC '
      'USING (escritorio_id = inquilino_atual()) '
      'WITH CHECK (escritorio_id = inquilino_atual())', t);
  END LOOP;
END $$;

/* A raiz se filtra pela própria chave. Sem isto, a tela de perfil listaria
   todos os escritórios do servidor. */
ALTER TABLE escritorios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inquilino ON escritorios;
CREATE POLICY inquilino ON escritorios FOR ALL TO PUBLIC
  USING (id = inquilino_atual())
  WITH CHECK (id = inquilino_atual());

/* `municipios` está com RLS ligada desde a 007 e nunca teve policy — o que,
   para o papel da aplicação, significa tabela vazia. Enquanto a aplicação
   conectava como dona, ninguém notou. A partir do papel restrito, notaria na
   primeira emissão: sem o município não há código IBGE nem regra de IM.

   Não é tabela de inquilino, então a policy não filtra nada; ela existe para
   cancelar a negação total. Quem pode escrever é decidido por GRANT, não
   aqui: a classificação de município é conhecimento nosso, não do cliente. */
ALTER TABLE municipios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leitura ON municipios;
CREATE POLICY leitura ON municipios FOR SELECT TO PUBLIC USING (true);

/* As compartilhadas ficam legíveis por todos e graváveis por ninguém pelo
   papel da aplicação — o GRANT em scripts/papel-app.js dá só SELECT nelas.
   `mensagens_vistas` é a exceção: a aplicação precisa gravar o wamid visto. */

/* GRANT não entra aqui de propósito. O papel da aplicação é criado pelo
   operador (scripts/papel-app.js), pode ter outro nome em cada instalação, e
   uma migração que referencia papel inexistente trava a implantação inteira.
   Efeito de esquecer o script: a aplicação não conecta. Barulhento, na
   inicialização, antes de qualquer dado trafegar. */

-- ------------------------------------- a fila não é de ninguém, é de todos

/* O worker de webhook e o de e-mail varrem a fila inteira, sem inquilino: não
   existe "requisição atual" num processo que acorda de minuto em minuto. Com
   RLS, uma conexão sem `app.escritorio` não enxerga fila nenhuma, e a fila
   pararia em silêncio — o pior modo de falhar que uma fila tem.
 
   A saída não é dar BYPASSRLS ao papel da aplicação, que desligaria tudo.
   É o worker rodar uma vez por escritório. Para isso ele precisa saber quais
   existem, e `escritorios` está sob policy como as demais.
 
   SECURITY DEFINER roda como a dona da tabela, que ignora RLS. Devolve só o
   id: nem nome, nem CNPJ. É o mínimo que o worker precisa e o máximo que
   convém deixar atravessar a fronteira. */
CREATE OR REPLACE FUNCTION escritorios_ativos() RETURNS SETOF integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id FROM escritorios WHERE ativo ORDER BY id $$;

COMMENT ON FUNCTION escritorios_ativos() IS
  'Ids dos escritórios ativos, atravessando RLS. Para laço de worker, não para tela.';

/* EXECUTE é concedido em scripts/papel-app.js, junto do resto. Não aqui:
   ver a nota sobre GRANT acima. */
