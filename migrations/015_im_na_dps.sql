-- A Inscrição Municipal na DPS: obrigatória em um ambiente, proibida no outro.
--
-- A Sefin valida a IM contra o CNC (Cadastro Nacional de Contribuintes) do
-- município emissor, e a regra se inverte conforme o município tenha ou não
-- informações complementares registradas ali:
--
--   E0116  "A IM deve ser informada"          — o município exige
--   E0120  "A IM não deve ser informada"      — o município não tem cadastro
--
-- Com a mesma empresa, mesmo CNPJ e mesmo município (Curitiba/4106902), a
-- produção restrita devolveu E0116 e a produção devolveu E0120. Ou seja: não é
-- propriedade da empresa nem do município isoladamente, é do par
-- município + ambiente. Cada rejeição dessas queima um número da sequência
-- fiscal, então vale guardar o que já se aprendeu.
--
-- NULL = ainda não se sabe; envia a IM quando a empresa tem uma cadastrada,
-- que é o comportamento anterior a esta tabela.

CREATE TABLE IF NOT EXISTS regra_im_dps (
  codigo_municipio  varchar(7)   NOT NULL,
  ambiente          varchar(12)  NOT NULL CHECK (ambiente IN ('producao', 'homologacao')),
  exige_im          boolean      NOT NULL,
  -- De onde veio a regra: 'sefin' (aprendida de uma rejeição) ou 'manual'
  origem            varchar(10)  NOT NULL DEFAULT 'sefin',
  observacao        text,
  atualizado_em     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (codigo_municipio, ambiente)
);

COMMENT ON TABLE regra_im_dps IS
  'Se a IM do prestador vai na DPS, por município e ambiente. Aprendida das rejeições E0116/E0120.';

-- O que já custou uma nota para descobrir, em 19/08/2026:
INSERT INTO regra_im_dps (codigo_municipio, ambiente, exige_im, origem, observacao) VALUES
  ('4106902', 'homologacao', TRUE,  'sefin', 'E0116 na DPS 1/5 — produção restrita exige a IM'),
  ('4106902', 'producao',    FALSE, 'sefin', 'E0120 na DPS 2/6 — CNC de Curitiba sem informações complementares')
ON CONFLICT (codigo_municipio, ambiente) DO NOTHING;
