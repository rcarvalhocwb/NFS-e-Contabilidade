-- De onde o painel aceita conexão, e se ela é criptografada.
--
-- Isto vivia só na variável HOST do .env, editada no bloco de notas. Numa
-- máquina de contabilidade, mexer em arquivo de configuração à mão é onde o
-- operador trava — e onde alguém apaga uma linha sem querer. Passa a ser tela.
--
-- Por que importa: sem HTTPS, a senha de quem abre o painel de OUTRO
-- computador do escritório atravessa a rede em texto puro. Enquanto só esta
-- máquina opera, isso não existe; no dia em que a contadora abrir do
-- computador dela, passa a existir e ninguém percebe.
--
-- O certificado é gerado aqui mesmo, assinado por ele próprio. Isso resolve a
-- criptografia e NÃO resolve a identidade: o navegador vai avisar que não
-- conhece quem assinou, e alguém precisa aceitar uma vez em cada computador.
-- Para uma rede de escritório é a troca certa — na internet não seria, mas o
-- gateway não vai para a internet.

CREATE TABLE IF NOT EXISTS config_rede (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  /* 'local' = só este computador (127.0.0.1); 'rede' = toda a rede local.
     O padrão é 'rede' porque é como o gateway sempre funcionou: mudar o
     comportamento de quem já usa, numa migração, seria tirar o painel do ar
     de quem o abre de outra máquina sem ter pedido nada. */
  escuta TEXT NOT NULL DEFAULT 'rede' CHECK (escuta IN ('local', 'rede')),

  https_ativo BOOLEAN NOT NULL DEFAULT FALSE,
  https_porta INTEGER NOT NULL DEFAULT 3443
    CHECK (https_porta BETWEEN 1024 AND 65535),

  /* Cifrados com a MASTER_KEY, como o certificado A1. A chave privada de um
     certificado de servidor não é documento fiscal, mas quem a tiver consegue
     se passar pelo painel dentro da rede. */
  cert_pem_cifrado   BYTEA,
  chave_pem_cifrada  BYTEA,

  cert_origem      TEXT CHECK (cert_origem IN ('gerado', 'enviado')),
  cert_assunto     TEXT,
  cert_nomes       TEXT,          -- para quais nomes/IPs ele vale
  cert_valido_ate  TIMESTAMPTZ,
  cert_gerado_em   TIMESTAMPTZ,

  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO config_rede (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE config_rede IS
  'De onde o painel aceita conexão e se usa HTTPS. Substitui a variável HOST do .env, que continua valendo como emergência.';
COMMENT ON COLUMN config_rede.escuta IS
  'local = 127.0.0.1, só esta máquina. rede = 0.0.0.0, todo o escritório.';
COMMENT ON COLUMN config_rede.chave_pem_cifrada IS
  'Chave privada do certificado do painel, cifrada com a MASTER_KEY. Quem a tiver consegue se passar pelo painel na rede.';
