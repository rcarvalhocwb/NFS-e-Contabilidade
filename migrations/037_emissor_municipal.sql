-- Para onde a DPS é transmitida, por município.
--
-- Até aqui só existia um destino: a Sefin Nacional. Município com emissor
-- próprio era bloqueado antes de reservar número, com uma mensagem dizendo
-- onde emitir à mão.
--
-- O QUE MUDOU O QUADRO: Fazenda Rio Grande manteve o Betha e-Nota, mas o
-- adaptou ao PADRÃO NACIONAL. Ou seja: a mesma DPS que este gateway já monta e
-- assina, entregue noutro endereço. Não é outro documento — é outro carteiro.
--
-- São José dos Pinhais fez o contrário: desligou o ISSonline municipal e
-- migrou para o Sistema Nacional, obrigatório desde 01/01/2026. Lá o gateway
-- já emite hoje; só faltava o município estar classificado, para não cair em
-- 'desconhecido'.
--
-- A TRAVA QUE ACOMPANHA: um endereço de webservice que eu não testei com
-- certificado e credenciamento é um palpite. Palpite errado aqui reserva
-- número, assina a DPS e falha — deixando buraco na sequência fiscal. Por isso
-- `emissor_confirmado` nasce FALSO: o município com provedor próprio só emite
-- depois de alguém confirmar na tela que o credenciamento foi feito e que o
-- endereço responde. Este projeto já assumiu dois endpoints da Sefin que não
-- existiam (o /eventos devolve 405, o /parametros_municipais devolve 501).

ALTER TABLE municipios
  /* Quem transmite. 'sefin' é o Sistema Nacional; os demais são provedores
     municipais que aceitam o layout nacional no endereço deles. */
  ADD COLUMN IF NOT EXISTS provedor VARCHAR(20) NOT NULL DEFAULT 'sefin'
    CHECK (provedor IN ('sefin', 'betha')),
  ADD COLUMN IF NOT EXISTS url_ws text,

  /* Falso até alguém confirmar que o credenciamento na prefeitura foi feito e
     que o endereço responde. Enquanto for falso, a emissão é recusada ANTES de
     reservar número — que é o que protege a sequência fiscal do palpite. */
  ADD COLUMN IF NOT EXISTS emissor_confirmado BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS emissor_confirmado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emissor_confirmado_por TEXT;

-- ------------------------------------------------- São José dos Pinhais
-- Migrou para o Sistema Nacional; o ISSonline municipal saiu de uso em
-- 01/01/2026. Aqui não há integração a fazer: o gateway já emite.
INSERT INTO municipios (codigo_municipio, nome, uf, modo_emissao, provedor,
                        conveniado, fonte, observacao, atualizado_em)
VALUES ('4125506', 'São José dos Pinhais', 'PR', 'nacional', 'sefin',
        TRUE, 'manual',
        'Desligou o ISSonline municipal e migrou para o Sistema Nacional, '
        'obrigatório desde 01/01/2026. Emite por aqui como Curitiba.',
        now())
ON CONFLICT (codigo_municipio) DO UPDATE
  SET modo_emissao = 'nacional', provedor = 'sefin', conveniado = TRUE,
      observacao = EXCLUDED.observacao, atualizado_em = now();

-- ------------------------------------------------- Fazenda Rio Grande
-- Manteve o Betha e-Nota, adaptado ao layout nacional. Mesma DPS, outro
-- endereço. O endereço abaixo veio de documentação de terceiros e NÃO foi
-- testado com certificado: por isso emissor_confirmado continua falso.
UPDATE municipios
   SET provedor = 'betha',
       url_ws = 'https://nota-eletronica.betha.cloud/',
       observacao = 'Manteve o Betha e-Nota e o adaptou ao layout NACIONAL: a '
                    'mesma DPS que o gateway assina, entregue no endereço do '
                    'Betha. Exige credenciamento na prefeitura (Menu RPS > '
                    'Autorização) antes da primeira emissão. O endereço do '
                    'webservice ainda não foi testado aqui com certificado.',
       atualizado_em = now()
 WHERE codigo_municipio = '4107652';

COMMENT ON COLUMN municipios.provedor IS
  'Quem recebe a DPS assinada. sefin = Sistema Nacional; betha = provedor municipal que aceita o layout nacional.';
COMMENT ON COLUMN municipios.emissor_confirmado IS
  'Falso até alguém confirmar credenciamento e endereço. Enquanto falso, a emissão por provedor próprio é recusada ANTES de reservar número, para um endereço errado não abrir buraco na sequência fiscal.';
