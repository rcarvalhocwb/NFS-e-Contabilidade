-- Tokens de integração passam a ser guardados como hash.
--
-- As sessões de usuário já guardavam só o hash; os tokens de empresa ficavam em
-- texto puro. Quem lesse o banco — uma cópia de segurança esquecida numa pasta,
-- um dump enviado por engano — usaria os tokens direto, emitindo nota em nome
-- do cliente.
--
-- SHA-256 sem sal, de propósito: o token tem 24 bytes aleatórios, então não há
-- o que adivinhar por dicionário, e a consulta precisa achar a linha pelo hash
-- em tempo de requisição.
--
-- Os tokens existentes continuam valendo: a coluna nova é preenchida a partir
-- da antiga nesta mesma migração. Só depois disso o texto puro é apagado —
-- invalidar as integrações em produção sem aviso seria pior que o risco.

ALTER TABLE empresa_tokens ADD COLUMN IF NOT EXISTS token_hash varchar(64);

UPDATE empresa_tokens
   SET token_hash = encode(digest(token, 'sha256'), 'hex')
 WHERE token_hash IS NULL AND token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_empresa_tokens_hash ON empresa_tokens (token_hash);

-- O texto puro sai da tabela. A partir daqui, um token perdido se substitui;
-- não se consulta.
ALTER TABLE empresa_tokens DROP COLUMN IF EXISTS token;

COMMENT ON COLUMN empresa_tokens.token_hash IS
  'SHA-256 do token. O valor original só existe no momento em que é gerado.';
