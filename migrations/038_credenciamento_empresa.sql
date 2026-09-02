-- Credenciamento é da EMPRESA, não do sistema.
--
-- A pergunta foi feita, e a resposta corrigiu o que eu tinha construído. Na
-- migração 037 a confirmação ficou no MUNICÍPIO, como se credenciar fosse uma
-- coisa só, feita uma vez. Não é: em Fazenda Rio Grande cada prestador pede
-- autorização à Secretaria de Finanças, que responde por e-mail, e só então
-- aquele CNPJ passa a poder emitir. Dez clientes do escritório em Fazenda Rio
-- Grande são dez credenciamentos.
--
-- Com a trava no município, bastaria alguém confirmar por causa do primeiro
-- cliente para os outros nove passarem a tentar emitir sem estar credenciados
-- — cada tentativa reservando número e falhando.
--
-- SÃO DUAS COISAS DIFERENTES, e as duas precisam ser verdade:
--
--   municipios.emissor_confirmado  -> o GATEWAY fala o protocolo deste
--                                     provedor corretamente? (uma vez, para
--                                     todo mundo)
--   empresas.emissor_credenciado   -> ESTA empresa tem autorização desta
--                                     prefeitura? (uma vez por CNPJ)

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS emissor_credenciado BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS emissor_credenciado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emissor_credenciado_por TEXT,
  -- Número/protocolo da autorização, quando a prefeitura devolve um
  ADD COLUMN IF NOT EXISTS emissor_credenciado_ref TEXT;

ALTER TABLE municipios
  /* Nem todo provedor exige credenciamento por empresa. Onde não exige, a
     trava por empresa não deve aparecer e atrapalhar. */
  ADD COLUMN IF NOT EXISTS exige_credenciamento BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------- Fazenda Rio Grande
-- Correção do endereço: a documentação de terceiros dizia `/v2/nfsen`. A do
-- próprio Betha diz `/dps/ws`, e por SOAP 1.1 — não por POST de XML puro.
UPDATE municipios
   SET url_ws = 'https://nota-eletronica.betha.cloud/dps/ws',
       exige_credenciamento = TRUE,
       observacao = 'Manteve o Betha e-Nota e o adaptou ao layout NACIONAL: a '
                    'mesma DPS que o gateway assina, entregue no endereço do '
                    'Betha por SOAP (operação RecepcionarDps). '
                    'CADA PRESTADOR pede autorização à Secretaria de Finanças '
                    'e recebe a resposta por e-mail — dez clientes ali são dez '
                    'credenciamentos. O protocolo ainda não foi testado daqui '
                    'com certificado.',
       atualizado_em = now()
 WHERE codigo_municipio = '4107652';

COMMENT ON COLUMN empresas.emissor_credenciado IS
  'Esta empresa tem autorização da prefeitura para emitir pelo provedor municipal. É por CNPJ: cada prestador pede a sua.';
COMMENT ON COLUMN municipios.emissor_confirmado IS
  'O gateway fala o protocolo deste provedor corretamente — conferido por quem instalou, uma vez, para todas as empresas. Diferente do credenciamento, que é de cada empresa.';
COMMENT ON COLUMN municipios.exige_credenciamento IS
  'Este provedor exige autorização por CNPJ na prefeitura antes da primeira emissão.';
