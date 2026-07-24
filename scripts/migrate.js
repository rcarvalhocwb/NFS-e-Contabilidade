/* Aplica as migrações pendentes, em ordem de nome de arquivo.
   Cada arquivo roda UMA vez: o que já foi aplicado fica registrado em
   schema_migrations. Antes disso o script re-executava tudo a cada chamada,
   o que só funcionava enquanto todas as migrações fossem idempotentes — e
   deixou de funcionar quando uma delas passou a remover colunas que ela
   própria lê. */
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      arquivo     TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      aplicado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const aplicadas = new Map(
    (await pool.query('SELECT arquivo, hash FROM schema_migrations')).rows
      .map(r => [r.arquivo, r.hash])
  );

  const arquivos = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  let novas = 0;

  for (const f of arquivos) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (aplicadas.has(f)) {
      // Alerta útil: um arquivo já aplicado que muda de conteúdo indica que a
      // migração foi editada depois de rodar — o banco não reflete o arquivo.
      if (aplicadas.get(f) !== hash) {
        console.warn(`  ! ${f} já aplicado, mas o conteúdo mudou desde então (não será reaplicado)`);
      }
      continue;
    }

    // Cada migração roda dentro de uma transação: falhou, nada fica pela metade.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (arquivo, hash) VALUES ($1,$2)', [f, hash]);
      await client.query('COMMIT');
      console.log('  + aplicado', f);
      novas++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`  x falhou ${f}: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(novas ? `Migrações concluídas (${novas} nova(s)).` : 'Nada a aplicar: banco já atualizado.');
  await pool.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
