-- O ovo e a galinha do isolamento.
--
-- Toda consulta precisa saber de qual escritório ela é. A requisição chega
-- sabendo só de uma credencial: um cookie de sessão ou um X-API-Key. Descobrir
-- o escritório a partir dela exige ler `sessoes` ou `empresa_tokens` — que
-- estão sob policy, e a policy exige saber o escritório. Nenhuma das duas
-- pontas começa.
--
-- Há três saídas, e duas são ruins:
--
--   Dar BYPASSRLS ao papel da aplicação. Resolve tudo e desliga tudo: as
--   policies continuam no banco e nenhuma é consultada.
--
--   Pôr o escritório na URL ou num cabeçalho. Vira parâmetro de entrada, e
--   parâmetro de entrada se troca — o isolamento passaria a depender de o
--   cliente ser honesto sobre quem ele é.
--
--   Duas funções SECURITY DEFINER, estreitas: recebem o HASH da credencial e
--   devolvem um inteiro. Não listam, não vazam nome, não aceitam id de
--   escritório. Quem não tem a credencial não consegue nada delas, e quem tem
--   já ia entrar de qualquer forma. É esta.
--
-- SECURITY DEFINER exige search_path fixo: sem isso, quem controlasse o
-- search_path da sessão poderia plantar uma tabela `sessoes` própria e a
-- função a leria com os privilégios da dona.

CREATE OR REPLACE FUNCTION escritorio_da_sessao(p_token_hash text)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT s.escritorio_id
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuario_id AND u.escritorio_id = s.escritorio_id
   WHERE s.token_hash = p_token_hash
     AND s.expira_em > now()
     AND u.ativo
$$;

COMMENT ON FUNCTION escritorio_da_sessao(text) IS
  'Escritório de um cookie de sessão válido, atravessando RLS. Devolve só o id.';

CREATE OR REPLACE FUNCTION escritorio_do_token(p_token_hash text)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT t.escritorio_id
    FROM empresa_tokens t
    JOIN empresas e ON e.id = t.empresa_id AND e.escritorio_id = t.escritorio_id
   WHERE t.token_hash = p_token_hash
     AND t.ativo AND e.ativo
$$;

COMMENT ON FUNCTION escritorio_do_token(text) IS
  'Escritório de um token de integração ativo, atravessando RLS. Devolve só o id.';

/* A condição `u.escritorio_id = s.escritorio_id` no JOIN não é decoração.
   Sessão e usuário têm a coluna cada um; se um dia divergirem, a função
   preferir não responder é melhor do que preferir um dos dois. */

/* O que NÃO tem função aqui: a chave global GATEWAY_API_KEY. Ela é credencial
   de máquina, igual para todos, e não pertence a escritório nenhum — dar a ela
   um escritório seria escolher um por ela. Quem entra por essa porta entra
   sem inquilino, enxerga zero linha nas tabelas de cliente, e precisa dizer
   em qual escritório quer operar. Ver src/middleware/inquilino.js. */

-- ------------------------------------------------------------------ login

/* Antes do login não há credencial, só um e-mail digitado. E o e-mail deixou
   de ser único no servidor (045): o mesmo contador pode atender dois
   escritórios, e antes disso o segundo cadastro falhava dizendo "já existe"
   sobre uma linha que aquele escritório não podia ver.
 
   Esta função é a que mais precisa de cuidado das três: ela responde a quem
   ainda não provou nada. Por isso devolve APENAS ids, e só de conta ativa.
   Saber que existem duas contas com aquele e-mail é o mínimo necessário para
   perguntar "em qual escritório?" — e é tudo que se descobre: nem nome de
   escritório, nem se a senha está certa, nem se a conta existe quando a lista
   volta vazia (o que é indistinguível de e-mail nunca cadastrado). */
CREATE OR REPLACE FUNCTION escritorios_do_email(p_email text)
  RETURNS SETOF integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT u.escritorio_id
    FROM usuarios u
    JOIN escritorios c ON c.id = u.escritorio_id
   WHERE lower(u.email) = lower(p_email)
     AND u.ativo AND c.ativo
   ORDER BY u.escritorio_id
$$;

COMMENT ON FUNCTION escritorios_do_email(text) IS
  'Ids dos escritórios em que o e-mail tem conta ativa. Só ids, e só para a tela de acesso.';
