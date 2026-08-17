#!/usr/bin/env node
/**
 * Importa um pacote gerado por scripts/exportar-migracao.js.
 *
 * Restaura os dados E as chaves do .env — é isso que faz o certificado A1
 * continuar abrindo do outro lado, já que ele está cifrado com a MASTER_KEY da
 * instalação de origem.
 *
 * Uso:
 *   node scripts/importar-migracao.js arquivo.nfsepkg --senha "..." --conferir
 *   node scripts/importar-migracao.js arquivo.nfsepkg --senha "..."
 */
require('dotenv').config();
const crypto = require('crypto');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../src/db');

const scrypt = promisify(crypto.scrypt);

function argumento(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const CONFLITO = {
  empresas: '(cnpj)', numeracao_dps: '(empresa_id, ambiente)',
  empresa_tokens: '(empresa_id, ambiente)', usuarios: '(email)',
  usuario_empresas: '(usuario_id, empresa_id)', municipios: '(codigo_municipio)',
  tomadores: '(empresa_id, documento)', servicos: '(empresa_id, apelido)'
};
const ORDEM = ['empresas', 'certificados', 'numeracao_dps', 'empresa_tokens',
  'usuarios', 'usuario_empresas', 'municipios', 'webhooks', 'tomadores',
  'servicos', 'notas'];

async function abrirPacote(arquivo, senha) {
  const bruto = fs.readFileSync(arquivo);
  const quebra = bruto.indexOf(0x0a);
  if (quebra === -1) throw new Error('Arquivo não parece um pacote de migração');

  const cabecalho = JSON.parse(bruto.subarray(0, quebra).toString('utf8'));
  if (cabecalho.formato !== 'nfse-gateway-migracao') {
    throw new Error('Arquivo não é um pacote de migração do gateway');
  }

  const chave = await scrypt(senha, Buffer.from(cabecalho.sal, 'base64'), 32,
    { N: cabecalho.N, r: cabecalho.r, p: cabecalho.p });

  const decifra = crypto.createDecipheriv('aes-256-gcm', chave,
    Buffer.from(cabecalho.iv, 'base64'));
  decifra.setAuthTag(Buffer.from(cabecalho.tag, 'base64'));

  let aberto;
  try {
    aberto = Buffer.concat([
      decifra.update(bruto.subarray(quebra + 1)),
      decifra.final()
    ]);
  } catch (_) {
    // O GCM só falha assim quando a chave está errada ou o arquivo foi mexido
    throw new Error('Senha incorreta, ou o arquivo foi alterado depois de gerado');
  }

  return { cabecalho, pacote: JSON.parse(zlib.gunzipSync(aberto).toString('utf8')) };
}

/* Grava as chaves no .env local. Sem isso o certificado importado fica
   inutilizável: ele está cifrado com a MASTER_KEY da máquina de origem. */
function aplicarEnv(env) {
  const caminho = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(caminho)) {
    throw Object.assign(new Error('.env não encontrado — instale o gateway antes de importar'),
      { status: 400 });
  }

  // Guarda o anterior: se algo der errado, dá para voltar
  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  fs.copyFileSync(caminho, `${caminho}.antes-da-migracao-${carimbo}`);

  let texto = fs.readFileSync(caminho, 'utf8');
  const alteradas = [];
  for (const [chave, valor] of Object.entries(env)) {
    const linha = `${chave}=${valor}`;
    const padrao = new RegExp(`^${chave}=.*$`, 'm');
    texto = padrao.test(texto) ? texto.replace(padrao, linha) : texto.trimEnd() + '\n' + linha + '\n';
    alteradas.push(chave);
  }
  fs.writeFileSync(caminho, texto, 'utf8');
  return alteradas;
}

async function principal() {
  const arquivo = process.argv[2];
  const senha = process.env.NFSE_SENHA_MIGRACAO || argumento('senha');
  const soConferir = process.argv.includes('--conferir');

  if (!arquivo || !senha) {
    console.error('Uso: node scripts/importar-migracao.js <arquivo.nfsepkg> --senha "..." [--conferir]');
    process.exit(2);
  }
  if (!fs.existsSync(arquivo)) {
    console.error('Arquivo não encontrado:', arquivo);
    process.exit(1);
  }

  const { pacote } = await abrirPacote(arquivo, senha);
  console.log(`Pacote de ${new Date(pacote.gerado_em).toLocaleString('pt-BR')}` +
              (pacote.origem ? ` (máquina ${pacote.origem})` : '') + '\n');

  for (const tabela of ORDEM) {
    const linhas = pacote.tabelas[tabela] || [];
    console.log(`${tabela.padEnd(18)} ${String(linhas.length).padStart(5)} registro(s)`);
  }
  console.log(`\nchaves do .env      ${String(Object.keys(pacote.env || {}).length).padStart(5)}` +
              ` (${Object.keys(pacote.env || {}).join(', ') || 'nenhuma'})`);

  if (soConferir) {
    console.log('\nModo conferência — nada foi gravado.');
    return;
  }

  const cliente = await db.pool.connect();
  let total = 0;
  try {
    await cliente.query('BEGIN');
    for (const tabela of ORDEM) {
      const linhas = pacote.tabelas[tabela] || [];
      for (const linha of linhas) {
        const colunas = Object.keys(linha);
        await cliente.query(
          `INSERT INTO ${tabela} (${colunas.map(c => `"${c}"`).join(',')})
           VALUES (${colunas.map((_, i) => '$' + (i + 1)).join(',')})
           ON CONFLICT ${CONFLITO[tabela] || '(id)'} DO NOTHING`,
          colunas.map(c => linha[c]));
      }
      total += linhas.length;
    }
    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }

  /* Fora da transação: um setval que falha aborta a transação inteira no
     Postgres, e o COMMIT seguinte viraria um rollback silencioso. */
  for (const tabela of ORDEM) {
    if (!(pacote.tabelas[tabela] || []).length) continue;
    try {
      await db.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${tabela}), 1))
         WHERE pg_get_serial_sequence($1, 'id') IS NOT NULL`, [tabela]);
    } catch (_) { /* tabela sem id serial */ }
  }

  const alteradas = aplicarEnv(pacote.env || {});

  console.log(`\n${total} registros importados.`);
  console.log(`.env atualizado: ${alteradas.join(', ')} (cópia do anterior guardada ao lado)`);
  console.log('\nReinicie o gateway para as chaves novas valerem.');
  console.log('Depois confira a numeração das DPS antes de emitir em produção.');
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
