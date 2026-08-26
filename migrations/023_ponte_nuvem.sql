-- Ponte com o portal do cliente na nuvem.
--
-- O escritório opera o gateway numa máquina local; os clientes dele acessam um
-- portal na internet para pedir a emissão. Falta o laço entre os dois.
--
-- QUEM INICIA A CONEXÃO É O GATEWAY, sempre. O portal nunca alcança esta
-- máquina: ela guarda os certificados A1 e as notas de todos os clientes do
-- escritório, e abrir porta no roteador da contabilidade para isso seria trocar
-- a segurança do conjunto pela conveniência de um recurso.
--
-- O gateway busca as solicitações pendentes, emite com o certificado que já
-- está aqui, e devolve o resultado. Só tráfego de saída — funciona atrás de
-- qualquer roteador, sem configuração de rede, e o certificado nunca viaja.

CREATE TABLE IF NOT EXISTS config_nuvem (
  id             boolean     PRIMARY KEY DEFAULT TRUE CHECK (id),
  ativo          boolean     NOT NULL DEFAULT FALSE,

  -- Endereço do portal. Só https: as solicitações levam CNPJ, valores e
  -- descrição de serviço, que é dado fiscal de terceiro.
  url            text,
  -- Credencial que identifica ESTA instalação no portal. Cifrada com a
  -- MASTER_KEY, como o certificado e a senha de e-mail.
  chave_cifrada  bytea,

  intervalo_seg  integer     NOT NULL DEFAULT 60 CHECK (intervalo_seg BETWEEN 15 AND 3600),
  -- Quantas solicitações trazer por vez. Teto para uma fila represada não
  -- prender o gateway numa rodada só.
  lote           smallint    NOT NULL DEFAULT 10 CHECK (lote BETWEEN 1 AND 100),

  /* Emitir sozinho ou esperar o contador?
     Falso é o padrão: a solicitação fica aguardando aprovação no painel. Nota
     fiscal emitida sem ninguém olhar, a partir de um pedido que veio da
     internet, é a decisão que o escritório deve tomar de propósito. */
  emitir_automatico boolean  NOT NULL DEFAULT FALSE,

  ultimo_contato    timestamptz,
  ultimo_erro       text,
  erro_em           timestamptz,
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO config_nuvem (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Solicitações trazidas do portal, antes de virarem nota.
CREATE TABLE IF NOT EXISTS solicitacoes (
  id             SERIAL PRIMARY KEY,
  -- Id da solicitação NO PORTAL. É por ele que o resultado é devolvido, e é o
  -- que impede a mesma solicitação de virar duas notas.
  id_externo     varchar(80) NOT NULL UNIQUE,
  empresa_id     INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  -- CNPJ como veio do portal, para diagnosticar quando não casar com empresa
  -- nenhuma do escritório.
  cnpj_informado varchar(20),

  payload        jsonb       NOT NULL,
  -- aguardando | aprovada | emitida | recusada | erro
  situacao       varchar(12) NOT NULL DEFAULT 'aguardando'
                 CHECK (situacao IN ('aguardando','aprovada','emitida','recusada','erro')),
  nota_id        INTEGER REFERENCES notas(id) ON DELETE SET NULL,
  motivo         text,
  decidido_por   varchar(160),
  decidido_em    timestamptz,
  -- Resultado já devolvido ao portal?
  devolvida_em   timestamptz,
  recebida_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solicitacoes_fila
  ON solicitacoes (situacao, recebida_em);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_devolver
  ON solicitacoes (devolvida_em) WHERE devolvida_em IS NULL;

COMMENT ON TABLE solicitacoes IS
  'Pedidos de emissão vindos do portal do cliente. O gateway busca; o portal nunca alcança esta máquina.';
