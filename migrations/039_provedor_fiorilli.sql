-- O Fiorilli entra na lista de provedores.
--
-- Conferido contra o serviço real (Assis/SP) em 03/09/2026: ele aceita a DPS
-- NO NAMESPACE NACIONAL, sem alterar nada. Enviando uma sem assinatura, ele
-- respondeu "E172: Arquivo enviado com erro na assinatura" — toda a estrutura
-- passou. É mais simples que o Betha, que exige o namespace dele.
--
-- O ENDEREÇO É POR MUNICÍPIO. Cada prefeitura tem o seu host, no formato
-- https://nfsews.<cidade>.<uf>.gov.br/IssWeb-ejb/IssWebWSNacional/IssWebWSNacionalPortType
-- Por isso não há um INSERT de município aqui: quem cadastra é o escritório,
-- conforme os clientes que tiver, e a tela já pede o endereço.
--
-- O Fiorilli mantém um webservice ABRASF antigo. Não é usado: a documentação
-- dele diz que emissões em ABRASF deixaram de ser aceitas em 01/08/2026 e que
-- o nacional deve ser priorizado. É a mesma direção que a Reforma impôs a
-- todos os provedores, e é o que torna cada nova integração pequena.

ALTER TABLE municipios DROP CONSTRAINT IF EXISTS municipios_provedor_check;
ALTER TABLE municipios ADD CONSTRAINT municipios_provedor_check
  CHECK (provedor IN ('sefin', 'betha', 'fiorilli'));

COMMENT ON COLUMN municipios.url_ws IS
  'Endereço do webservice do provedor municipal. É por município: cada prefeitura tem o seu host.';
