-- Row Level Security (RLS)
--
-- Motivo: em provedores como o Supabase, o schema `public` é exposto pela
-- Data API (REST/PostgREST). Estas tabelas guardam CNPJs e os certificados
-- digitais e senhas cifrados — nada disso pode ser acessível por chave anônima.
--
-- Ativar RLS sem criar policy nenhuma = negação total pela Data API.
-- O gateway conecta via string de conexão direta (role dono das tabelas),
-- que ignora RLS por padrão — então a aplicação continua funcionando normalmente.
-- Isto é defesa em profundidade; vale mesmo em Postgres local.

ALTER TABLE empresas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificados ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas        ENABLE ROW LEVEL SECURITY;
