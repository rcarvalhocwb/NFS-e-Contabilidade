-- Usuários do painel.
--
-- Até aqui o painel era aberto com a GATEWAY_API_KEY, que é credencial de
-- máquina: a mesma para todo mundo. Isso trazia três problemas para quem opera
-- de fato — a contabilidade digitava 48 caracteres hexadecimais para entrar,
-- não havia como saber quem emitiu cada nota (o que tem valor fiscal), e tirar
-- o acesso de uma pessoa derrubaria as integrações junto.
--
-- A chave global passa a servir só para chamadas de sistema e para criar o
-- primeiro usuário na instalação. Pessoas entram com login e senha.

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nome          VARCHAR(150) NOT NULL,
  -- Login é o e-mail: a contabilidade já o conhece e não precisa inventar
  -- outro identificador. Guardado em minúsculas para não falhar por caixa.
  email         VARCHAR(255) NOT NULL UNIQUE,
  senha_hash    TEXT         NOT NULL,
  perfil        VARCHAR(12)  NOT NULL DEFAULT 'operador'
                CHECK (perfil IN ('admin','operador')),
  ativo         BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Obriga a troca no primeiro login quando o admin cadastra com senha
  -- provisória; assim ninguém opera com a senha que o administrador conhece.
  trocar_senha  BOOLEAN      NOT NULL DEFAULT FALSE,
  ultimo_acesso TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Empresas que o usuário enxerga. Sem nenhuma linha aqui, enxerga todas —
-- é o caso comum de um grupo pequeno, e evita ter que marcar CNPJ por CNPJ
-- só para o sistema funcionar.
CREATE TABLE IF NOT EXISTS usuario_empresas (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, empresa_id)
);

-- Sessões no banco, não em cookie assinado: o gateway pode reiniciar sem
-- deslogar todo mundo, e o administrador consegue encerrar a sessão de alguém
-- que perdeu o acesso à máquina.
CREATE TABLE IF NOT EXISTS sessoes (
  -- Guarda o hash do token, nunca o token: quem ler a tabela não entra no
  -- lugar de ninguém.
  token_hash TEXT        PRIMARY KEY,
  usuario_id INTEGER     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em  TIMESTAMPTZ NOT NULL,
  ip         VARCHAR(45),
  user_agent TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);
-- Limpeza das expiradas sem varrer a tabela toda.
CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes (expira_em);

-- Quem emitiu a nota. Nulo para as emitidas por integração (aí quem responde
-- é o token da empresa) e para as anteriores a esta migração.
ALTER TABLE notas ADD COLUMN IF NOT EXISTS usuario_id INTEGER
  REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE usuarios         ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes          ENABLE ROW LEVEL SECURITY;
