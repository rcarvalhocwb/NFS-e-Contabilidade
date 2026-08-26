-- Cópia do backup para fora da máquina.
--
-- Em 17 de agosto de 2026 o banco que hospedava tudo desapareceu e não havia
-- cópia: empresa, numeração fiscal, tokens e histórico se foram juntos. O
-- backup diário nasceu daquela noite — mas ele grava numa pasta do próprio
-- disco onde o banco mora. Enquanto a única cópia estiver no mesmo disco, não é
-- backup: é conforto. Disco que morre leva os dois.
--
-- Aqui ficam os lugares para onde a cópia é levada depois de pronta: um pen
-- drive, um disco externo, uma pasta de rede do escritório, uma pasta
-- sincronizada com nuvem. Quantos quiser — a cópia só vale quando existe em
-- mais de um lugar.

CREATE TABLE IF NOT EXISTS backup_destinos (
  id           SERIAL PRIMARY KEY,
  caminho      text        NOT NULL UNIQUE,
  apelido      varchar(80),
  ativo        boolean     NOT NULL DEFAULT TRUE,

  -- Quantas cópias manter ali. Pen drive não tem o espaço do disco interno.
  manter       smallint    NOT NULL DEFAULT 7 CHECK (manter BETWEEN 1 AND 365),

  /* Resultado da última tentativa. Backup que falha em silêncio é pior do que
     não ter backup, porque dá segurança falsa — então o desfecho fica gravado e
     aparece na tela. */
  ultimo_ok    timestamptz,
  ultimo_arquivo text,
  ultimo_erro  text,
  erro_em      timestamptz,

  criado_em    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE backup_destinos IS
  'Para onde a cópia do backup é levada depois de gerada. Cópia no mesmo disco do banco não protege contra o disco morrer.';
