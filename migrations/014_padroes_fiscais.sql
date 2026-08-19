-- Padrões fiscais por empresa.
--
-- Uma empresa de vigilância emite vigilância; uma de contabilidade emite
-- contabilidade. O código de tributação, o NBS e a alíquota não mudam de nota
-- para nota — mudam de empresa para empresa. Digitá-los a cada emissão é
-- repetição pura, e cada digitação é uma chance de errar um dígito e queimar
-- um número da sequência fiscal.
--
-- São padrões, não travas: a tela deixa alterar em qualquer nota.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cod_tributacao_padrao   VARCHAR(6);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cod_tributacao_municipal VARCHAR(20);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cod_nbs_padrao          VARCHAR(9);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS descricao_padrao        TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS aliquota_iss_padrao     NUMERIC(5,4);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS iss_retido_padrao       BOOLEAN NOT NULL DEFAULT FALSE;

-- Percentual do PGDAS-D para optante do Simples, ou o total aproximado de
-- tributos da Lei 12.741 para os demais regimes. Muda a cada apuração, então
-- fica no cadastro para não ser digitado errado de memória.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS perc_total_tributos     NUMERIC(5,4);

-- Natureza da operação: quase sempre 1 (tributável), mas entidade imune ou
-- exportadora de serviço tem outra, e é fixa para ela.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS tributacao_issqn_padrao SMALLINT NOT NULL DEFAULT 1;
