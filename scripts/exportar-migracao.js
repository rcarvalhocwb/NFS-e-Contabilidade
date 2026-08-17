#!/usr/bin/env node
/**
 * Pacote de migração: leva o gateway inteiro para outra máquina.
 *
 * Diferente do backup diário, que guarda só os dados. Aqui vão junto as chaves
 * do .env — sem a MASTER_KEY o certificado A1 do backup não abre em lugar
 * nenhum, e a migração chegaria do outro lado com uma empresa que não emite.
 *
 * Por isso o arquivo é CIFRADO com uma senha que você escolhe. Ele contém, em
 * claro: certificado digital, tokens de integração e o hash das senhas dos
 * usuários. Não é arquivo para mandar por e-mail sem senha.
 *
 * Uso:
 *   node scripts/exportar-migracao.js --senha "frase secreta"
 *   node scripts/exportar-migracao.js --senha "..." --saida D:\pendrive
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

const TABELAS = ['empresas', 'certificados', 'numeracao_dps', 'empresa_tokens',
  'usuarios', 'usuario_empresas', 'municipios', 'webhooks', 'tomadores',
  'servicos', 'notas'];

/* Chaves que a instalação de destino precisa. PORT e GATEWAY_BASE_URL ficam de
   fora de propósito: são da máquina, não da instalação. DATABASE_URL idem — o
   banco do destino é outro. */
const CHAVES_ENV = ['GATEWAY_API_KEY', 'MASTER_KEY', 'VER_APLIC', 'XML_SIG_ALG',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USUARIO', 'SMTP_SENHA', 'SMTP_REMETENTE'];

async function principal() {
  const senha = process.env.NFSE_SENHA_MIGRACAO || argumento('senha');
  if (!senha || senha.length < 8) {
    console.error('Informe uma senha de ao menos 8 caracteres para cifrar o pacote:');
    console.error('  node scripts/exportar-migracao.js --senha "sua frase secreta"');
    console.error('\nGuarde a senha: sem ela o pacote não abre, e não há como recuperá-lo.');
    process.exit(2);
  }

  const pasta = argumento('saida') || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(pasta, { recursive: true });

  const pacote = {
    gerado_em: new Date().toISOString(),
    versao: 1,
    origem: require('os').hostname(),
    env: {},
    tabelas: {}
  };

  for (const chave of CHAVES_ENV) {
    if (process.env[chave]) pacote.env[chave] = process.env[chave];
  }

  let total = 0;
  for (const tabela of TABELAS) {
    try {
      const r = await db.query(`SELECT * FROM ${tabela} ORDER BY 1`);
      pacote.tabelas[tabela] = r.rows;
      total += r.rows.length;
      console.log(`${tabela.padEnd(18)} ${String(r.rows.length).padStart(5)} registro(s)`);
    } catch (e) {
      pacote.tabelas[tabela] = [];
      console.log(`${tabela.padEnd(18)}     - (${e.message})`);
    }
  }

  // Comprime antes de cifrar: dados cifrados não comprimem.
  const bruto = zlib.gzipSync(Buffer.from(JSON.stringify(pacote), 'utf8'));

  const sal = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chave = await scrypt(senha, sal, 32, { N: 16384, r: 8, p: 1 });

  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const conteudo = Buffer.concat([cifra.update(bruto), cifra.final()]);
  const tag = cifra.getAuthTag();

  /* Cabeçalho em claro para o importador saber o que fazer sem a senha, e para
     alguém que ache o arquivo daqui a um ano entender o que é. */
  const cabecalho = Buffer.from(JSON.stringify({
    formato: 'nfse-gateway-migracao',
    versao: 1,
    kdf: 'scrypt',
    N: 16384, r: 8, p: 1,
    cifra: 'aes-256-gcm',
    sal: sal.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    gerado_em: pacote.gerado_em
  }) + '\n', 'utf8');

  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const arquivo = path.join(pasta, `nfse-migracao-${carimbo}.nfsepkg`);
  fs.writeFileSync(arquivo, Buffer.concat([cabecalho, conteudo]));

  const mb = (fs.statSync(arquivo).size / 1048576).toFixed(2);
  console.log(`\nPacote cifrado: ${arquivo} (${mb} MB, ${total} registros)`);
  console.log('\nNa máquina nova:');
  console.log('  1. Instale o gateway normalmente');
  console.log('  2. node scripts/importar-migracao.js <arquivo.nfsepkg> --senha "..."');
  console.log('\nGuarde a senha em lugar separado do arquivo. Sem ela nada abre.');
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
