#!/usr/bin/env node
/**
 * Sobe o Postgres local, se for o caso, antes do gateway iniciar.
 *
 * O `Iniciar Gateway.bat` já fazia isso, mas quem roda `npm start` direto — em
 * desenvolvimento, no preview, num atalho próprio — ficava com o servidor no ar
 * e o banco fora, vendo "ECONNREFUSED" sem saber o motivo.
 *
 * Não faz nada quando o banco é externo: aí não há o que iniciar.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

/* O Postgres local pode estar em duas pastas, conforme a instalação:
   instalador/postgres (cópia manual) ou postgres (instalado pelo .exe). */
function acharInstalacao() {
  for (const base of [path.join(RAIZ, 'instalador'), RAIZ]) {
    if (fs.existsSync(path.join(base, 'postgres', 'pgsql', 'bin', 'pg_ctl.exe'))) {
      return base;
    }
  }
  return null;
}

function bancoEhLocal() {
  const env = path.join(RAIZ, '.env');
  if (!fs.existsSync(env)) return false;
  const url = (fs.readFileSync(env, 'utf8').match(/^DATABASE_URL=(.+)$/m) || [])[1] || '';
  return /@(127\.0\.0\.1|localhost)[:/]/.test(url);
}

function principal() {
  if (process.platform !== 'win32') return;      // o Postgres embutido é do instalador Windows
  if (!bancoEhLocal()) return;                    // banco externo: nada a subir

  const base = acharInstalacao();
  if (!base) return;                              // sem Postgres embutido

  const ps1 = fs.existsSync(path.join(base, 'postgres-local.ps1'))
    ? path.join(base, 'postgres-local.ps1')
    : path.join(RAIZ, 'postgres-local.ps1');
  if (!fs.existsSync(ps1)) return;

  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `. '${ps1}'; if (Test-PgRodando '${base}') { exit 0 }; ` +
      `if (Start-PostgresLocal '${base}') { exit 0 } else { exit 1 }`
    ], { stdio: 'pipe', timeout: 60000 });
    console.log('[banco] Postgres local pronto');
  } catch (e) {
    // Aviso, não erro fatal: o gateway ainda mostra a tela explicando que o
    // banco não respondeu, e forçar a saída aqui esconderia essa mensagem.
    console.warn('[banco] não consegui iniciar o Postgres local.',
                 'Veja postgres/postgres.log');
  }
}

principal();
