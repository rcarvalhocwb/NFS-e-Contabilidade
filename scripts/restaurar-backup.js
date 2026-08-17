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
const db = require('../src/db');

const arquivo = process.argv[2];
const soConferir = process.argv.includes('--conferir');

/* Chave natural de cada tabela, para saber o que já existe. As que não têm
   chave além do id ficam de fora do ON CONFLICT e usam o próprio id. */
const CONFLITO = {
  empresas: '(cnpj)',
  numeracao_dps: '(empresa_id, ambiente)',
  empresa_tokens: '(empresa_id, ambiente)',
  usuarios: '(email)',
  usuario_empresas: '(usuario_id, empresa_id)',
  municipios: '(codigo_municipio)',
  tomadores: '(empresa_id, documento)',
  servicos: '(empresa_id, apelido)',
  notas: '(id)',
  certificados: '(id)',
  webhooks: '(id)'
};

const ORDEM = ['empresas', 'certificados', 'numeracao_dps', 'empresa_tokens',
  'usuarios', 'usuario_empresas', 'municipios', 'webhooks', 'tomadores',
  'servicos', 'notas'];

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

      for (const linha of linhas) {
        const colunas = Object.keys(linha);
        const marcadores = colunas.map((_, i) => '$' + (i + 1));
        await cliente.query(
          `INSERT INTO ${tabela} (${colunas.map(c => `"${c}"`).join(',')})
           VALUES (${marcadores.join(',')})
           ON CONFLICT ${CONFLITO[tabela] || '(id)'} DO NOTHING`,
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
