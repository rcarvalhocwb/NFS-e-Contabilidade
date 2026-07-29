-- Parâmetros municipais: classifica cada município (código IBGE) como emissor
-- Nacional ou próprio, e guarda a alíquota de ISS.
--
-- A fonte da verdade é o ADN (GET /parametros_municipais/{cod}), consultado com
-- o certificado de alguma empresa. Como esses parâmetros mudam raramente, o
-- resultado fica em cache aqui, e a emissão consulta esta tabela em vez de
-- bater no ADN a cada nota.
--
-- A classificação também pode ser definida MANUALMENTE (fonte='manual'), o que
-- deixa o recurso útil desde já — a contabilidade marca, por exemplo, Fazenda
-- Rio Grande como 'proprio' antes mesmo de haver certificado para a consulta
-- automática.

CREATE TABLE IF NOT EXISTS municipios (
  codigo_municipio VARCHAR(7)  PRIMARY KEY,           -- código IBGE de 7 dígitos
  nome             VARCHAR(150),
  uf               CHAR(2),
  -- nacional = emite pela Sefin Nacional (o gateway cobre)
  -- proprio  = emissor municipal próprio (ABRASF etc.) — o gateway NÃO emite
  -- desconhecido = ainda não classificado
  modo_emissao     VARCHAR(12) NOT NULL DEFAULT 'desconhecido'
                   CHECK (modo_emissao IN ('nacional','proprio','desconhecido')),
  conveniado       BOOLEAN,                            -- conveniado ao Sistema Nacional
  aliquota_iss     NUMERIC(5,2),                       -- alíquota de ISS (%), quando disponível
  fonte            VARCHAR(12) NOT NULL DEFAULT 'manual'
                   CHECK (fonte IN ('adn','manual')),
  parametros       JSONB,                              -- resposta bruta do ADN, para auditoria
  consultado_em    TIMESTAMPTZ,                        -- última consulta ao ADN
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE municipios ENABLE ROW LEVEL SECURITY;
