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
 * DE QUEM É O BACKUP
 *
 * Com vários escritórios no mesmo banco, "backup" deixou de ser uma coisa só.
 * Cada arquivo é de um escritório, e o nome diz qual — é o que permite à rota
 * de download recusar o arquivo do vizinho.
 *
 * Rodar sem dizer de quem é passou a ser ERRO, e não o padrão de antes.
 * Motivo: sob RLS, uma conexão sem inquilino não enxerga linha nenhuma. O
 * backup global rodava, imprimia "5 registros", gravava o arquivo, copiava
 * para o pendrive e mostrava verde na tela — com zero empresas, zero
 * certificados e zero notas dentro. Um backup que mente é pior que nenhum:
 * nenhum a gente sabe que não tem.
 *
 * Uso:
 *   node scripts/backup.js --escritorio 3     # um escritório
 *   node scripts/backup.js --todos            # um arquivo por escritório
 *   node scripts/backup.js --todos --saida C:\bkp
 *   node scripts/backup.js --todos --sem-notas   # só cadastro, bem menor
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

function argumento(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/* A lista mora em tabelas-backup.js, compartilhada com a restauração. Eram
   duas listas, e divergiram — o que só se descobre no dia da restauração. */
const { TABELAS, PESADAS } = require('./tabelas-backup');

async function umEscritorio(escritorioId) {
  const semNotas = process.argv.includes('--sem-notas');
  const pasta = argumento('saida') || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(pasta, { recursive: true });

  const agora = new Date();
  const carimbo = agora.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  /* Um rótulo no nome para a cópia feita antes de atualizar. Sem ele, ela some
     no meio das diárias, e "restaure a de antes da atualização" vira garimpo
     por data — justamente quando alguém está com pressa. */
  const rotulo = argumento('rotulo');
  /* O escritório entra no NOME, não só no conteúdo. A rota de download confere
     o nome antes de abrir o arquivo: sem isso, bastaria pedir o arquivo do
     vizinho pelo nome para levar a carteira inteira dele — por um caminho que
     não passa por consulta nenhuma, e que portanto a RLS não alcança. */
  const arquivo = path.join(pasta,
    `nfse-${rotulo ? String(rotulo).replace(/[^\w.-]/g, '') : 'backup'}` +
    `-e${escritorioId}-${carimbo}.json`);

  const dados = {
    gerado_em: agora.toISOString(), versao: 2,
    escritorio_id: escritorioId, tabelas: {}
  };
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

  /* A fila do repassador, quando ele roda nesta máquina.
     São os pedidos que o gateway ainda não buscou e as conversas em andamento.
     Fora do banco de propósito (é transitório e não vale um Postgres), mas
     perder isso é perder pedido de cliente sem ninguém saber. */
  const filaRelay = path.join(__dirname, '..', 'dados-relay', 'relay.json');
  if (fs.existsSync(filaRelay)) {
    try {
      dados.repassador = JSON.parse(fs.readFileSync(filaRelay, 'utf8'));
      console.log('repassador'.padEnd(18) +
        String((dados.repassador.pedidos || []).length).padStart(5) +
        ' pedido(s) na fila');
    } catch (e) {
      dados.repassador = { erro: e.message };
      console.log('repassador'.padEnd(18) + '     - (' + e.message + ')');
    }
  }

  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf8');
  const mb = (fs.statSync(arquivo).size / 1048576).toFixed(2);
  console.log(`\n${total} registros em ${arquivo} (${mb} MB)`);

  /* Rotação por escritório: guarda os 30 mais recentes DE CADA UM. Uma
     rotação global apagaria o backup de um escritório pequeno para caber o do
     grande, e quem perde o histórico é sempre quem emite menos. */
  const meus = new RegExp(`^nfse-backup-e${escritorioId}-.*\\.json$`);
  const antigos = fs.readdirSync(pasta)
    .filter(f => meus.test(f))
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

  return { escritorioId, arquivo, total };
}

async function principal() {
  const pedido = argumento('escritorio');
  const todos = process.argv.includes('--todos');

  if (!pedido && !todos) {
    /* Não assumir. Antes o padrão era "o banco inteiro", o que fazia sentido
       quando o banco era de um escritório só. Agora esse padrão produziria
       silenciosamente um arquivo vazio — ver o cabeçalho. */
    const ids = await db.comServidor(async () => {
      const r = await db.query('SELECT * FROM escritorios_ativos() AS id');
      return r.rows.map(l => l.id);
    });
    console.error('Diga de quem é o backup: --escritorio N ou --todos.');
    console.error(`Escritórios ativos: ${ids.join(', ') || '(nenhum)'}`);
    console.error('');
    console.error('Sem isso a conexão não tem inquilino, e sob RLS ela não');
    console.error('enxerga linha nenhuma: o arquivo sairia vazio dizendo que');
    console.error('deu certo.');
    process.exit(2);
  }

  if (pedido) {
    const r = await db.comInquilino(Number(pedido), () => umEscritorio(Number(pedido)));
    return [r];
  }

  const feitos = [];
  await db.porInquilino(async (id) => { feitos.push(await umEscritorio(id)); });
  console.log('');
  feitos.forEach(f => console.log(`  escritório ${f.escritorioId}: ${f.total} registro(s)`));
  if (!feitos.length) console.log('  nenhum escritório ativo — nada a copiar.');
  return feitos;
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
