-- A senha SMTP cifrada é binária, não texto.
--
-- A 021 criou a coluna como TEXT. O secretbox devolve um Buffer (IV + tag +
-- dados do AES-256-GCM), e gravar bytes arbitrários numa coluna de texto faz o
-- Postgres recusar com "sequência de bytes é inválida para codificação UTF8" —
-- o que aconteceu na primeira gravação.
--
-- BYTEA é o tipo que o certificado A1 já usa para a mesma finalidade.
-- A coluna está vazia neste ponto (nenhuma senha chegou a ser gravada), então
-- não há conversão a fazer.

ALTER TABLE config_email DROP COLUMN IF EXISTS senha_cifrada;
ALTER TABLE config_email ADD COLUMN senha_cifrada BYTEA;

COMMENT ON COLUMN config_email.senha_cifrada IS
  'Senha SMTP cifrada com a MASTER_KEY (AES-256-GCM). Para Gmail, é a senha de app.';
