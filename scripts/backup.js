#!/usr/bin/env node
/**
 * Backup dos dados do gateway em arquivo JSON.
 *
 * Existe porque em 2026-08-17 o projeto Supabase que hospedava o banco
 * desapareceu e não havia cópia alguma: empresa, numeração, tokens e histórico
 * de notas se foram de uma vez. Backup automático do provedor não vale de nada
 * quando o provedor é que some.
 *
 * JSON, e não pg_dump: roda sem depender dos binários do Postgres estarem no
 * PATH, e o arquivo pode ser lido a olho nu se um dia for preciso conferir um
 * número de nota na mão.
 *
 * O certificado A1 sai cifrado, exatamente como está no banco. Sem a MASTER_KEY
 * do .env ele não serve para nada — guarde as duas coisas separadas.
 *
 * Uso:
 *   node scripts/backup.js                    # grava em backups/
 *   node scripts/backup.js --saida C:\bkp     # escolhe a pasta
 *   node scripts/backup.js --sem-notas        # só cadastro, arquivo bem menor
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

function argumento(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/* Ordem importa na hora de restaurar: quem é referenciado vem antes. */
const TABELAS = [
  'empresas',
  'certificados',
  'numeracao_dps',
  'empresa_tokens',
  'usuarios',
  'usuario_empresas',
  'municipios',
  'webhooks',
  'tomadores',
  'servicos',
  'notas'
];

const PESADAS = ['notas'];

async function principal() {
  const semNotas = process.argv.includes('--sem-notas');
  const pasta = argumento('saida') || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(pasta, { recursive: true });

  const agora = new Date();
  const carimbo = agora.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const arquivo = path.join(pasta, `nfse-backup-${carimbo}.json`);

  const dados = { gerado_em: agora.toISOString(), versao: 1, tabelas: {} };
  let total = 0;

  for (const tabela of TABELAS) {
    if (semNotas && PESADAS.includes(tabela)) {
      dados.tabelas[tabela] = { omitida: true, motivo: '--sem-notas' };
      continue;
    }
    try {
      const r = await db.query(`SELECT * FROM ${tabela} ORDER BY 1`);
      dados.tabelas[tabela] = r.rows;
      total += r.rows.length;
      console.log(`${tabela.padEnd(18)} ${String(r.rows.length).padStart(5)} registro(s)`);
    } catch (e) {
      // Tabela ausente não interrompe: um banco de versão anterior pode não
      // ter todas, e um backup parcial vale mais que nenhum.
      dados.tabelas[tabela] = { erro: e.message };
      console.log(`${tabela.padEnd(18)}     - (${e.message})`);
    }
  }

  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf8');
  const mb = (fs.statSync(arquivo).size / 1048576).toFixed(2);
  console.log(`\n${total} registros em ${arquivo} (${mb} MB)`);

  // Rotação: guarda os 30 mais recentes. Sem isso a pasta cresce para sempre
  // numa máquina que ninguém acompanha.
  const antigos = fs.readdirSync(pasta)
    .filter(f => /^nfse-backup-.*\.json$/.test(f))
    .sort()
    .reverse()
    .slice(30);
  antigos.forEach(f => {
    fs.unlinkSync(path.join(pasta, f));
    console.log(`removido backup antigo: ${f}`);
  });

  if (dados.tabelas.certificados && Array.isArray(dados.tabelas.certificados)
      && dados.tabelas.certificados.length) {
    console.log('\nO certificado saiu cifrado. Guarde a MASTER_KEY do .env em');
    console.log('lugar separado deste arquivo — uma sem a outra não abre nada.');
  }
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
