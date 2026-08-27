#!/usr/bin/env node
/**
 * Restaura um backup gerado por scripts/backup.js.
 *
 * Um backup que nunca foi testado não é um backup. Este script é o par do
 * outro, e o `--conferir` existe para que dê para validar o arquivo sem
 * escrever nada.
 *
 * Uso:
 *   node scripts/restaurar-backup.js backups/nfse-backup-....json --conferir
 *   node scripts/restaurar-backup.js backups/nfse-backup-....json
 *
 * Só insere o que não existe (ON CONFLICT DO NOTHING): restaurar por cima de um
 * banco em uso não sobrescreve o que está lá. Para uma restauração limpa, use
 * um banco vazio.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const arquivo = process.argv[2];
const soConferir = process.argv.includes('--conferir');

/* A mesma lista do backup, na mesma ordem. */
const { TABELAS: ORDEM, CHAVE_NATURAL } = require('./tabelas-backup');

/* Onde não há chave natural melhor, pergunta ao Postgres qual é a primária.
   O mapa fixo anterior chutava `(id)` para o resto, e isso quebrava justamente
   nas de chave composta — numeracao_dps, regra_im_dps, empresa_obrigacoes —
   que são as que mais doem perder. */
async function conflitoDe(tabela) {
  if (CHAVE_NATURAL[tabela]) return CHAVE_NATURAL[tabela];
  const r = await db.query(
    `SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) AS colunas
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(att, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.att
      WHERE con.contype = 'p' AND c.relname = $1
        AND c.relnamespace = 'public'::regnamespace`, [tabela]);
  const colunas = (r.rows[0] || {}).colunas;
  return colunas ? '(' + colunas + ')' : null;
}

async function principal() {
  if (!arquivo) {
    console.error('Uso: node scripts/restaurar-backup.js <arquivo.json> [--conferir]');
    process.exit(2);
  }
  if (!fs.existsSync(arquivo)) {
    console.error('Arquivo não encontrado:', arquivo);
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  console.log('Backup de', new Date(backup.gerado_em).toLocaleString('pt-BR'), '\n');

  if (soConferir) {
    for (const tabela of ORDEM) {
      const linhas = backup.tabelas[tabela];
      if (!Array.isArray(linhas)) {
        console.log(`${tabela.padEnd(18)}     - ${linhas && linhas.omitida ? '(omitida)' : '(ausente)'}`);
        continue;
      }
      console.log(`${tabela.padEnd(18)} ${String(linhas.length).padStart(5)} registro(s)`);
    }
    console.log('\nModo conferência — nada foi gravado.');
    return;
  }

  const cliente = await db.pool.connect();
  let total = 0;
  try {
    await cliente.query('BEGIN');

    for (const tabela of ORDEM) {
      const linhas = backup.tabelas[tabela];
      if (!Array.isArray(linhas) || !linhas.length) continue;
      if (!(await conflitoDe(tabela)) &&
          !(await db.query('SELECT to_regclass($1) AS t', ['public.' + tabela]))
            .rows[0].t) {
        console.log(`${tabela.padEnd(18)}     - (não existe neste banco)`);
        continue;
      }

      const conflito = await conflitoDe(tabela);
      for (const linha of linhas) {
        const colunas = Object.keys(linha);
        const marcadores = colunas.map((_, i) => '$' + (i + 1));
        await cliente.query(
          `INSERT INTO ${tabela} (${colunas.map(c => `"${c}"`).join(',')})
           VALUES (${marcadores.join(',')})
           ${conflito ? 'ON CONFLICT ' + conflito + ' DO NOTHING' : ''}`,
          colunas.map(c => linha[c]));
      }
      total += linhas.length;
      console.log(`${tabela.padEnd(18)} ${String(linhas.length).padStart(5)} registro(s)`);
    }

    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }

  /* As sequences não acompanham inserts com id explícito: sem este ajuste, o
     próximo INSERT tentaria reusar um id existente e falharia.

     Fora da transação de propósito. Um setval que falha (tabela sem coluna id
     serial) aborta a transação inteira no Postgres, e o `.catch` do JS engole o
     erro sem desfazer isso — o COMMIT seguinte vira um rollback silencioso e a
     restauração não grava nada, relatando sucesso. */
  for (const tabela of ORDEM) {
    if (!Array.isArray(backup.tabelas[tabela]) || !backup.tabelas[tabela].length) continue;
    try {
      await db.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${tabela}), 1))
         WHERE pg_get_serial_sequence($1, 'id') IS NOT NULL`, [tabela]);
    } catch (e) {
      console.warn(`aviso: não ajustei a sequence de ${tabela} (${e.message})`);
    }
  }

  /* A fila do repassador só volta se não houver uma no lugar: sobrescrever
     uma fila viva perderia pedidos que chegaram depois do backup. */
  if (backup.repassador && !backup.repassador.erro) {
    const destino = path.join(__dirname, '..', 'dados-relay', 'relay.json');
    if (fs.existsSync(destino)) {
      console.log('\nA fila do repassador já existe e foi mantida. O backup ' +
        'tem ' + (backup.repassador.pedidos || []).length + ' pedido(s); ' +
        'para usá-la, pare o gateway e apague ' + destino + ' antes.');
    } else {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, JSON.stringify(backup.repassador, null, 1), 'utf8');
      console.log('\nFila do repassador restaurada: ' +
        (backup.repassador.pedidos || []).length + ' pedido(s).');
    }
  }

  console.log(`\n${total} registros restaurados.`);
  console.log('Confira a numeração das DPS antes de emitir em produção.');
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
