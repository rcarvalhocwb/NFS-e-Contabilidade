#!/usr/bin/env node
/**
 * Abre um escritório no servidor: a linha de inquilino, a identidade visual e
 * o primeiro administrador.
 *
 * É o passo que faltava depois da conversão para vários escritórios. Sem ele,
 * abrir uma casa nova seria três comandos SQL na mão — e o terceiro, o
 * administrador, sendo o que ninguém pode errar.
 *
 * Roda com a URL de ADMINISTRADOR (ADMIN_DATABASE_URL, ou DATABASE_URL se for
 * a mesma): criar escritório é ato de operador do servidor, não de inquilino.
 * O papel restrito da aplicação nem enxerga os outros escritórios — por
 * desenho, e é assim que deve continuar.
 *
 * Uso:
 *   node scripts/criar-escritorio.js --nome "Contabilidade Silva" \
 *        --cnpj 12345678000190 --admin maria@silva.com.br
 *
 * A senha do administrador sai sorteada e impressa uma vez. Quem receber
 * troca no primeiro acesso — o script já marca isso.
 */
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }
const crypto = require('crypto');
const { Pool } = require('pg');

function opcao(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : undefined;
}

const soDigitos = t => String(t || '').replace(/\D+/g, '');

/* Senha de primeiro acesso: sorteada, nunca escolhida por quem cria. Uma
   senha escolhida pelo operador é uma senha que o operador conhece, e ele não
   deveria conhecer a do administrador de um cliente. */
function senhaSorteada() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  // Sem O/0 e I/l: a senha vai ser lida em voz alta ou copiada de uma tela.
  return Array.from(crypto.randomBytes(14))
    .map(b => alfabeto[b % alfabeto.length]).join('');
}

async function main() {
  const nome = opcao('nome');
  const cnpj = soDigitos(opcao('cnpj')) || null;
  const admin = opcao('admin');

  if (!nome || !admin) {
    console.error('Uso: node scripts/criar-escritorio.js --nome "Nome do escritório" \\');
    console.error('       --admin email@do.admin [--cnpj 12345678000190]');
    process.exit(2);
  }
  if (cnpj && cnpj.length !== 14) {
    console.error(`CNPJ com ${cnpj.length} dígitos; são 14.`);
    process.exit(2);
  }

  const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('defina ADMIN_DATABASE_URL (ou DATABASE_URL) antes de rodar');

  const pool = new Pool({ connectionString: url });
  const cliente = await pool.connect();
  const senha = senhaSorteada();
  let id;

  try {
    await cliente.query('BEGIN');

    const novo = await cliente.query(
      'INSERT INTO escritorios (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj]);
    id = novo.rows[0].id;

    /* A partir daqui as tabelas têm policy, e a conexão de administrador é
       dona — dona ignora policy, então as gravações passariam de qualquer
       jeito. Amarrar mesmo assim faz o DEFAULT `inquilino_atual()` funcionar,
       o que mantém estes INSERTs iguais aos do resto do sistema em vez de
       uma versão especial que passa `escritorio_id` na mão. */
    await cliente.query(`SELECT set_config('app.escritorio', $1, false)`, [String(id)]);

    /* A identidade nasce com o nome do escritório. Sem ela, o painel abre sem
       marca nenhuma e parece meio instalado. */
    await cliente.query(
      'INSERT INTO identidade (nome) VALUES ($1) ON CONFLICT DO NOTHING',
      [nome.slice(0, 80)]);

    /* O primeiro usuário é admin: não haveria quem lhe desse permissão.
       O hash sai do mesmo serviço que o resto do sistema usa — duplicar a
       regra de hash aqui seria criar um segundo lugar para ela envelhecer. */
    const { gerarHash } = require('../src/services/usuarios');
    await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, trocar_senha)
       VALUES ($1, $2, $3, 'admin', TRUE, TRUE)`,
      [admin.split('@')[0], admin, await gerarHash(senha)]);

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    if (erro.code === '23505') {
      console.error(`Já existe escritório com o CNPJ ${cnpj}.`);
      process.exit(1);
    }
    throw erro;
  } finally {
    cliente.release();
    await pool.end();
  }

  console.log('');
  console.log(`  Escritório ${id} aberto: ${nome}`);
  console.log('');
  console.log(`    administrador  ${admin}`);
  console.log(`    senha          ${senha}`);
  console.log('');
  console.log('  A senha é de primeiro acesso: o sistema pede a troca no login.');
  console.log('  Entregue por um caminho que não seja o mesmo do e-mail de acesso.');
  console.log('');
}

main().catch(err => { console.error('Falhou:', err.message); process.exit(1); });
