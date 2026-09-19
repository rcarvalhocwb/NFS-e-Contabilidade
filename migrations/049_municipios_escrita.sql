-- Correção de uma policy que eu escrevi estreita demais na 046.
--
-- A 046 deu a `municipios` uma policy `FOR SELECT`. O raciocínio estava certo
-- pela metade: município não é dado de inquilino, a policy existe só para
-- cancelar a negação total que vinha da 007, e quem pode escrever ali é
-- decidido por GRANT.
--
-- O que ficou de fora: a aplicação ESCREVE nessa tabela. Classificar município
-- pelo ADN é coisa que o painel faz (POST /municipios/:codigo/classificar), e
-- municipiosService faz INSERT nela. Com policy só de leitura, o GRANT de
-- UPDATE não serve para nada: a policy é a camada de baixo.
--
-- E o modo de falhar é o pior possível. `UPDATE` que não casa com policy
-- nenhuma não dá erro — devolve "UPDATE 0". A rota responderia sucesso, a tela
-- mostraria o município classificado, e nada teria sido gravado. Na emissão
-- seguinte o guard voltaria a dizer "município não classificado", e a pessoa
-- classificaria de novo.
--
-- Encontrado ao restaurar um backup: a restauração morreu em `municipios` com
-- "new row violates row-level security policy". A escrita pela restauração
-- falha alto; a escrita pela tela falhava calada. A segunda é que assustava.
--
-- `FOR ALL` sem filtro: a tabela não tem dono, então não há o que filtrar. Quem
-- pode mexer continua sendo decidido acima — a rota exige administrador, e o
-- GRANT do papel restrito é dado em scripts/papel-app.js.

ALTER TABLE municipios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leitura ON municipios;
DROP POLICY IF EXISTS compartilhada ON municipios;
CREATE POLICY compartilhada ON municipios FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

/* `regra_im_dps` tem o mesmo formato — conhecimento municipal compartilhado,
   escrito pela aplicação quando ela aprende a regra de inscrição de um
   município. Ela nunca teve RLS ligada, então não sofre do problema acima.
   Fica sem RLS de propósito: ligar agora só acrescentaria uma policy
   `USING (true)` que não decide nada. */
