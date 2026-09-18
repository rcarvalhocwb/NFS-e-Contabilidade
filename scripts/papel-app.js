#!/usr/bin/env node
/**
 * Cria (ou renova a senha do) papel restrito com que a aplicação conecta.
 *
 * POR QUE A APLICAÇÃO NÃO PODE CONECTAR COMO DONA DO BANCO
 *
 * Policy de RLS não se aplica ao dono da tabela, e não se aplica de jeito
 * nenhum a superusuário — nem com FORCE ROW LEVEL SECURITY. A instalação
 * antiga conectava com o papel que criou o banco, que costuma ser os dois. Com
 * um escritório só, dava no mesmo. Com vários, significa que todas as policies
 * da 046 estão lá e nenhuma é consultada: o isolamento volta a depender de
 * ninguém esquecer um WHERE.
 *
 * Este script fecha esse buraco. Ele cria um papel que:
 *   - não é superusuário, não é dono de nada, não pode criar nada;
 *   - tem SELECT/INSERT/UPDATE/DELETE nas tabelas de inquilino, onde as
 *     policies mandam;
 *   - tem só SELECT no conhecimento compartilhado (municípios, regras);
 *   - não enxerga as tabelas do operador do servidor.
 *
 * Roda com uma conexão de administrador (a mesma DATABASE_URL de hoje, ou
 * ADMIN_DATABASE_URL). Imprime no fim a DATABASE_URL nova, que é a que vai
 * para o .env da aplicação.
 *
 * Uso:
 *   node scripts/papel-app.js                 # cria, sorteia senha
 *   node scripts/papel-app.js --senha SEGREDO # usa uma senha escolhida
 *   node scripts/papel-app.js --papel app_x   # outro nome de papel
 *   node scripts/papel-app.js --conferir      # só diz como está, não muda nada
 */
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }
const crypto = require('crypto');
const { Pool } = require('pg');

function opcao(nome, padrao) {
  const i = process.argv.indexOf('--' + nome);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : padrao;
}

const PAPEL = opcao('papel', process.env.APP_DB_ROLE || 'app_nfse');
const CONFERIR = process.argv.includes('--conferir');

/* Compartilhadas com escrita: o que não pertence a escritório nenhum mas é o
   próprio servidor quem mantém.

   `municipios` e `regra_im_dps` são conhecimento fiscal — a aplicação
   classifica município pelo ADN e aprende a regra de inscrição municipal.
   `atualizacao` guarda o resultado da verificação de versão. `config_rede` e
   `backup_destinos` são configuração do servidor, e quem escreve nelas é o
   processo do servidor: o worker de cópia de segurança e o listener HTTPS
   rodam dentro da aplicação, não fora dela.

   Que um administrador de escritório não deva MEXER em caminho de disco ou
   certificado TLS do servidor continua verdade — mas quem garante isso é a
   autorização de rota, não o GRANT. Fingir que o banco garante seria pior do
   que dizer aqui que ele não garante. */
const COMPARTILHADAS = ['municipios', 'regra_im_dps', 'atualizacao',
                        'mensagens_vistas', 'config_rede', 'backup_destinos'];

/* Só leitura: a aplicação mostra em que versão o banco está (tela de saúde,
   relatório de atualização), mas não aplica migração. Não poderia mesmo — o
   papel não é dono das tabelas e não tem DDL. Migrar é passo de operador,
   com a URL de administrador. */
const SO_LEITURA = ['schema_migrations'];

/* Nome de papel entra em comando que não aceita parâmetro. Em vez de escapar,
   recusa: nome de papel é escolha do operador, não entrada de usuário, e a
   lista branca elimina a classe inteira de problema. */
function papelValido(nome) {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(nome);
}

function senhaSorteada() {
  // 24 bytes em base64url: 32 caracteres sem nada que atrapalhe em URL de
  // conexão, .env ou linha de comando do Windows.
  return crypto.randomBytes(24).toString('base64url');
}

async function tabelasDeInquilino(pool) {
  const { rows } = await pool.query(`
    SELECT c.relname AS tabela
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'escritorio_id'
                      AND NOT a.attisdropped)
     ORDER BY 1`);
  // `escritorios` é a raiz: tem `id`, não `escritorio_id`, e a aplicação
  // precisa lê-la para saber de quem é a conexão.
  return rows.map(r => r.tabela).concat('escritorios');
}

async function diagnostico(pool, papel) {
  const { rows } = await pool.query(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`, [papel]);
  if (!rows.length) return { existe: false };
  return { existe: true, ...rows[0] };
}

async function main() {
  if (!papelValido(PAPEL)) {
    throw new Error(`nome de papel inválido: ${PAPEL} (use minúsculas, dígitos e _)`);
  }

  const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('defina DATABASE_URL (ou ADMIN_DATABASE_URL) antes de rodar');

  const pool = new Pool({ connectionString: url });
  const inquilino = await tabelasDeInquilino(pool);

  if (!inquilino.includes('empresas')) {
    throw new Error('o banco ainda não tem escritorio_id: rode node scripts/migrate.js primeiro');
  }

  if (CONFERIR) {
    const d = await diagnostico(pool, PAPEL);
    const quem = await pool.query(
      'SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super');
    console.log('');
    console.log(`  Conectado como: ${quem.rows[0].current_user}` +
                (quem.rows[0].super ? '  (SUPERUSUÁRIO — ignora toda policy)' : ''));
    console.log(`  Tabelas de inquilino: ${inquilino.length}`);
    console.log(`  Papel ${PAPEL}: ` + (d.existe
      ? `existe` +
        (d.rolsuper ? ' — SUPERUSUÁRIO, não serve' : '') +
        (d.rolbypassrls ? ' — tem BYPASSRLS, não serve' : '') +
        (!d.rolcanlogin ? ' — sem LOGIN, não conecta' : '') +
        (!d.rolsuper && !d.rolbypassrls && d.rolcanlogin ? ' — ok' : '')
      : 'não existe'));
    console.log('');
    await pool.end();
    return;
  }

  const senha = opcao('senha', senhaSorteada());
  const souSuper = (await pool.query(
    'SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS s'
  )).rows[0].s;
  const cliente = await pool.connect();

  try {
    await cliente.query('BEGIN');

    /* CREATE ROLE não tem IF NOT EXISTS. O bloco resolve os dois casos com o
       mesmo comando: primeira vez cria, depois troca a senha. Rotacionar senha
       é o segundo uso previsto deste script. */
    await cliente.query(`
      DO $do$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PAPEL}') THEN
          ALTER ROLE ${PAPEL} LOGIN PASSWORD ${quote(senha)};
        ELSE
          CREATE ROLE ${PAPEL} LOGIN PASSWORD ${quote(senha)};
        END IF;
      END
      $do$;`);

    /* Explícito, mesmo sendo o padrão de CREATE ROLE: quem lê este script
       precisa ver que a ausência destes atributos é escolha, não descuido.

       Só um superusuário pode mexer nestes atributos — um papel com CREATEROLE
       cria papéis, mas não decide quem é superusuário. Quando a conexão de
       administração não é superusuária, o comando é pulado e a garantia passa
       a vir da conferência no fim, que é de onde ela sempre veio de verdade:
       o que vale é o papel não TER o atributo, não termos mandado tirar. */
    if (souSuper) {
      await cliente.query(`ALTER ROLE ${PAPEL} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }

    await cliente.query(`GRANT CONNECT ON DATABASE ${ident(await bancoAtual(cliente))} TO ${PAPEL}`);
    await cliente.query(`GRANT USAGE ON SCHEMA public TO ${PAPEL}`);

    /* Nada de GRANT ALL TABLES: isso incluiria as do operador. A lista é
       derivada do banco (quem tem escritorio_id), então tabela nova de
       inquilino entra sozinha na próxima execução — e tabela nova do operador
       não entra por acidente. */
    for (const t of inquilino) {
      await cliente.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(t)} TO ${PAPEL}`);
    }
    for (const t of SO_LEITURA) {
      if (await existe(cliente, t)) {
        await cliente.query(`GRANT SELECT ON ${ident(t)} TO ${PAPEL}`);
        await cliente.query(
          `REVOKE INSERT, UPDATE, DELETE ON ${ident(t)} FROM ${PAPEL}`);
      }
    }
    for (const t of COMPARTILHADAS) {
      if (await existe(cliente, t)) {
        await cliente.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(t)} TO ${PAPEL}`);
      }
    }

    /* As sequências vão junto: sem USAGE, todo INSERT em tabela com `serial`
       falha — e falha só em produção, porque em desenvolvimento se conecta
       como dono. */
    await cliente.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PAPEL}`);

    /* `inquilino_atual()` é STABLE e lê só um GUC, mas EXECUTE explícito
       documenta que a aplicação depende dela. */
    await cliente.query(`GRANT EXECUTE ON FUNCTION inquilino_atual() TO ${PAPEL}`);
    /* `escritorios_ativos()` é SECURITY DEFINER: atravessa RLS de propósito,
       para o worker saber em quais escritórios rodar a fila. Devolve só ids. */
    await cliente.query(`GRANT EXECUTE ON FUNCTION escritorios_ativos() TO ${PAPEL}`);
    /* As duas resolvem o ovo-e-galinha: descobrem o escritório a partir do
       hash da credencial, que é a única coisa que a requisição traz antes de
       haver inquilino. Recebem hash, devolvem inteiro — não listam nada. */
    await cliente.query(`GRANT EXECUTE ON FUNCTION escritorio_da_sessao(text) TO ${PAPEL}`);
    await cliente.query(`GRANT EXECUTE ON FUNCTION escritorio_do_token(text) TO ${PAPEL}`);
    await cliente.query(`GRANT EXECUTE ON FUNCTION escritorios_do_email(text) TO ${PAPEL}`);

    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }

  /* A conferência é a garantia, não o ALTER acima. Um papel reaproveitado que
     já fosse superusuário ou já tivesse BYPASSRLS passaria por todo o resto
     deste script sem reclamar — e as policies da 046 viravam enfeite. Parar
     aqui é a única forma de isso não passar despercebido. */
  const d = await diagnostico(pool, PAPEL);
  if (d.rolsuper || d.rolbypassrls) {
    await pool.end();
    throw new Error(
      `${PAPEL} ${d.rolsuper ? 'é superusuário' : 'tem BYPASSRLS'} e por isso ignora ` +
      'toda policy de RLS.\n' +
      '  Enquanto for assim, o isolamento entre escritórios não existe.\n' +
      `  Corrija com um superusuário: ALTER ROLE ${PAPEL} NOSUPERUSER NOBYPASSRLS;\n` +
      '  ou use --papel com um nome novo.');
  }
  const banco = await pool.query('SELECT current_database() AS b');
  const host = (url.match(/@([^/]+)\//) || [])[1] || 'localhost:5432';
  await pool.end();

  console.log('');
  console.log(`  Papel ${PAPEL} pronto: ${inquilino.length} tabela(s) de inquilino,` +
              ` ${COMPARTILHADAS.length} compartilhada(s), ${SO_LEITURA.length} só de leitura.`);
  console.log(`  super=${d.rolsuper}  bypassrls=${d.rolbypassrls}  (os dois precisam ser false)`);
  console.log('');
  console.log('  Ponha no .env da aplicação:');
  console.log('');
  console.log(`    DATABASE_URL=postgres://${PAPEL}:${encodeURIComponent(senha)}@${host}/${banco.rows[0].b}`);
  console.log('');
  console.log('  A URL de administrador continua necessária para migrar.');
  console.log('  Guarde-a como ADMIN_DATABASE_URL, fora do .env da aplicação.');
  console.log('');
}

async function bancoAtual(cliente) {
  return (await cliente.query('SELECT current_database() AS b')).rows[0].b;
}

async function existe(cliente, tabela) {
  const r = await cliente.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'r'`, [tabela]);
  return r.rowCount > 0;
}

/* Identificador e literal em comando montado por concatenação. Os nomes vêm do
   catálogo do próprio banco e o papel já passou pela lista branca, mas quoting
   correto custa duas funções e tira a pergunta da frente de quem revisar. */
function ident(nome) { return '"' + String(nome).replace(/"/g, '""') + '"'; }
function quote(texto) { return "'" + String(texto).replace(/'/g, "''") + "'"; }

main().catch(err => { console.error(err.message); process.exit(1); });
