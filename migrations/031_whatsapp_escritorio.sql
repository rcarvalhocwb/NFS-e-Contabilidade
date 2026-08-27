-- O WhatsApp do escritório, e o histórico do que foi conversado.
--
-- Duas faltas que só aparecem quando o sistema sai do papel: o contador não tem
-- onde configurar o número que emite, e não existe registro do que o cliente
-- pediu — só do pedido pronto.

/* ---------------------------------------------------- o número do escritório
 *
 * As credenciais da Meta ficam AQUI e são empurradas para o repassador junto
 * com o cadastro, em vez de o contador precisar entrar num servidor por SSH
 * para editar arquivo. O gateway é onde ele já trabalha.
 *
 * DUAS COISAS NÃO VÊM PARA CÁ, de propósito: o App Secret e o token de
 * verificação do webhook. São eles que provam que a mensagem veio da Meta e que
 * o canal é o certo — mandá-los PELO canal que eles protegem seria fechar o
 * círculo. Esses continuam no .env do repassador, escritos uma vez na
 * instalação.
 */
ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS wa_numero          varchar(20),
  ADD COLUMN IF NOT EXISTS wa_phone_number_id varchar(40),
  ADD COLUMN IF NOT EXISTS wa_token_cifrado   bytea,
  ADD COLUMN IF NOT EXISTS wa_ativo           boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN config_nuvem.wa_numero IS
  'O número que aparece para o cliente. Informativo: quem manda a mensagem é o phone_number_id.';
COMMENT ON COLUMN config_nuvem.wa_token_cifrado IS
  'Token permanente da Meta, cifrado com a MASTER_KEY como o certificado. Sai daqui só para o repassador.';

/* ------------------------------------------------------------- o histórico
 *
 * A conversa vivia só na memória do repassador e sumia ao terminar. Guardava-se
 * o pedido pronto — não o que foi perguntado, o que a pessoa respondeu, nem em
 * que ordem.
 *
 * Isso é o que falta no dia em que um cliente diz "eu não pedi essa nota". O
 * pedido sozinho não prova nada; a conversa prova. Junto com a auditoria de
 * quem aprovou, que já existe, fecha a linha inteira: quem pediu, o que
 * respondeu, quem liberou, o que a Sefin devolveu.
 */
ALTER TABLE solicitacoes
  ADD COLUMN IF NOT EXISTS transcricao jsonb;

COMMENT ON COLUMN solicitacoes.transcricao IS
  'A conversa que gerou o pedido, na ordem: cada mensagem do cliente e cada resposta do sistema, com horário. É a prova de quem pediu o quê.';
