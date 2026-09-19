-- A linha que três migrações editaram e nenhuma criou.
--
-- As migrações 029, 037 e 038 fazem `UPDATE municipios ... WHERE
-- codigo_municipio = '4107652'`, cada uma acrescentando o que se descobriu
-- sobre Fazenda Rio Grande: que manteve o Betha e-Nota, o endereço do
-- webservice, que o credenciamento é por CNPJ. Nenhuma das três INSERE a
-- linha.
--
-- Em banco que já rodava, a linha veio de um cadastro manual pelo painel e os
-- UPDATEs pegaram. Em banco novo — máquina nova, restauração, o servidor de
-- teste — os três rodam sem erro e afetam zero linhas. O município some, e
-- com ele o aviso que diz para onde ir emitir. A emissão para com "município
-- não classificado" em vez de "vá ao portal do Betha e credencie-se antes".
--
-- Não é hipótese: num banco recriado do zero com as 47 migrações, a consulta
-- por 4107652 devolve zero linhas.
--
-- A 037, na mesma tela, usa INSERT ... ON CONFLICT DO UPDATE para São José
-- dos Pinhais, três linhas acima. Foi escorregão de cópia, não decisão.
--
-- Corrigir as três no lugar seria reescrever migração já aplicada — o banco
-- de quem já rodou não voltaria atrás. Esta migração faz o upsert com o
-- estado final que as três queriam: idempotente, serve tanto ao banco novo
-- quanto ao que já tem a linha.

INSERT INTO municipios (
  codigo_municipio, nome, uf, modo_emissao, emissor, url_portal,
  provedor, url_ws, emissor_confirmado, exige_credenciamento,
  fonte, observacao, atualizado_em
) VALUES (
  '4107652', 'Fazenda Rio Grande', 'PR', 'proprio', 'Betha e-Nota',
  'https://www.frg.pr.gov.br',
  'betha', 'https://nota-eletronica.betha.cloud/dps/ws',
  FALSE, TRUE,
  'manual',
  'Manteve o Betha e-Nota e o adaptou ao layout NACIONAL: a mesma DPS que o '
  'gateway assina, entregue no endereço do Betha por SOAP (operação '
  'RecepcionarDps). CADA PRESTADOR pede autorização à Secretaria de Finanças '
  'e recebe a resposta por e-mail — dez clientes ali são dez credenciamentos. '
  'O protocolo ainda não foi testado daqui com certificado.',
  now()
)
ON CONFLICT (codigo_municipio) DO UPDATE SET
  nome                 = COALESCE(municipios.nome, EXCLUDED.nome),
  uf                   = COALESCE(municipios.uf, EXCLUDED.uf),
  modo_emissao         = EXCLUDED.modo_emissao,
  emissor              = EXCLUDED.emissor,
  url_portal           = EXCLUDED.url_portal,
  provedor             = EXCLUDED.provedor,
  url_ws               = EXCLUDED.url_ws,
  exige_credenciamento = EXCLUDED.exige_credenciamento,
  observacao           = EXCLUDED.observacao,
  atualizado_em        = now();

/* `emissor_confirmado` NÃO entra no DO UPDATE.
   Ele é falso até alguém confirmar credenciamento e endereço com certificado
   na mão, e quem confirmou foi uma pessoa — não uma migração. Sobrescrever
   para FALSE aqui apagaria essa confirmação e faria a emissão voltar a ser
   recusada, num banco onde ela já funcionava. */

/* `nome` e `uf` entram com COALESCE porque em banco antigo eles podem ter
   vindo do cadastro manual ou da consulta ao ADN, que são fontes melhores
   que uma constante escrita aqui. */
