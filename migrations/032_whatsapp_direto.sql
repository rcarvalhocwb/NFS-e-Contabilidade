-- Emissão direta pelo WhatsApp, e os documentos de volta.
--
-- O modo automático era global (config_nuvem.emitir_automatico): ligava para
-- todas as empresas de uma vez. Isso é grosso demais para um escritório — o
-- cliente que emite a mesma nota há três anos não precisa de aprovação, e o que
-- entrou mês passado precisa.
--
-- Agora a decisão é por empresa, e continua valendo a regra que a sustenta:
-- emissão sem gente olhando só para identidade que ESTE lado conferiu. Pedido de
-- portal, cuja autenticação só a nuvem viu, espera aprovação de qualquer jeito.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_direto boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN empresas.whatsapp_direto IS
  'Pedido vindo do WhatsApp de número autorizado vira nota sem passar por aprovação. Vale só para WhatsApp: portal nunca emite direto.';

/* O teto por número deixa de ser aviso e passa a ser trava.
 *
 * Enquanto tudo passava por um humano, o teto só marcava a solicitação para
 * conferência. Com emissão direta ele é a única coisa entre um dedo escorregando
 * no teclado e uma nota de R$ 250.000 com imposto — então acima dele o pedido
 * para e espera gente, mesmo com a emissão direta ligada. */

/* Mandar a nota pronta de volta no WhatsApp.
 *
 * O cliente recebia o link da consulta pública — oficial, mas exige abrir o
 * navegador e depender do portal do governo estar no ar. O PDF na conversa é
 * onde as pessoas de fato guardam documento.
 *
 * Em troca, o documento passa pelo repassador e fica nos servidores da Meta.
 * Por isso é uma chave, e não um comportamento: quem preferir o link continua
 * com ele. */
ALTER TABLE config_nuvem
  ADD COLUMN IF NOT EXISTS wa_envia_documentos boolean NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN config_nuvem.wa_envia_documentos IS
  'Manda o PDF (e o XML) da nota pela conversa. Desligado, vai só o link da consulta pública e nenhum documento sai daqui.';
