-- Preferências de emissão.
--
-- Quem opera é o escritório contábil, emitindo para vários clientes a partir da
-- mesma tela. Escolher a empresa em toda nota é a repetição mais cara do fluxo:
-- na prática se emite em lote para o mesmo CNPJ, e a troca é ocasional.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_padrao_id INTEGER
  REFERENCES empresas(id) ON DELETE SET NULL;

-- Alíquota de ISS por serviço já existia; aqui entram os campos que o formulário
-- precisa lembrar entre uma emissão e outra, para não redigitar.
ALTER TABLE servicos ADD COLUMN IF NOT EXISTS tributacao_issqn SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE servicos ADD COLUMN IF NOT EXISTS retencoes_federais JSONB;
ALTER TABLE servicos ADD COLUMN IF NOT EXISTS informacoes_complementares TEXT;
