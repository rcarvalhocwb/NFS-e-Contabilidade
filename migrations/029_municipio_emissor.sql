-- Onde emitir, quando o município não é do Sistema Nacional.
--
-- O gateway já barra a emissão em município de emissor próprio, antes de
-- reservar número. Mas a mensagem dizia só o código IBGE — quem está com a nota
-- para emitir precisa saber PARA ONDE ir, não que o código 4107652 não serve.
--
-- Fazenda Rio Grande (PR) é o caso concreto: apesar do prazo de 1º/01/2026 da
-- Reforma Tributária, o município manteve o emissor próprio da Betha Sistemas,
-- adaptado ao padrão nacional em vez de migrado para o sefin.nfse.gov.br. Quem
-- atende um cliente de lá emite no portal da prefeitura, e o gateway não tem
-- como fazer por ele.

ALTER TABLE municipios
  ADD COLUMN IF NOT EXISTS emissor    varchar(80),
  ADD COLUMN IF NOT EXISTS url_portal text,
  ADD COLUMN IF NOT EXISTS observacao text;

COMMENT ON COLUMN municipios.emissor IS
  'Nome do sistema emissor do município quando modo_emissao = proprio (Betha e-Nota, ISSNet, GISS…). Vai na mensagem de bloqueio.';
COMMENT ON COLUMN municipios.url_portal IS
  'Endereço onde a nota daquele município é emitida. É o que a pessoa precisa para resolver o problema.';

/* O que já se sabe hoje, para a mensagem sair útil desde a primeira vez.
   Curitiba é referência de comparação: também tem emissor próprio (ISS Curitiba). */
UPDATE municipios
   SET emissor = 'Betha e-Nota',
       url_portal = 'https://www.frg.pr.gov.br',
       observacao = 'Manteve o emissor municipal e o adaptou ao padrão nacional, '
                    'em vez de migrar para o Sistema Nacional. Exige credenciamento '
                    'na prefeitura antes da primeira emissão.'
 WHERE codigo_municipio = '4107652';
