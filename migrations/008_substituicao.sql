-- Rastreamento de substituição de NFS-e.
--
-- Ao autorizar uma DPS com o bloco <subst>, a Sefin cancela a NFS-e original
-- (evento "Cancelamento por Substituição") e autoriza a nova. Sem registrar
-- esse vínculo, o gateway continuaria mostrando a original como 'autorizada'
-- enquanto ela já está cancelada na Sefin — divergência detectada testando
-- substituição em produção.

ALTER TABLE notas
  -- chave da NFS-e que ESTA nota substitui (preenchido na emissão)
  ADD COLUMN IF NOT EXISTS substitui_chave VARCHAR(50),
  -- chave da NFS-e que substituiu ESTA (preenchido quando ela é substituída)
  ADD COLUMN IF NOT EXISTS substituida_por VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_notas_substitui ON notas (substitui_chave)
  WHERE substitui_chave IS NOT NULL;
