const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Backup diário, disparado pelo próprio gateway.
 *
 * Em 2026-08-17 o projeto de banco que hospedava tudo desapareceu e não havia
 * cópia nenhuma: empresa, numeração fiscal, tokens e histórico se foram juntos.
 * Depender do backup do provedor não protege contra o provedor sumir.
 *
 * Numa máquina de contabilidade ninguém vai lembrar de rodar backup na mão, e
 * agendar tarefa no Windows exige privilégio e some quando a máquina é trocada.
 * O gateway já está aberto todo dia para emitir — é o lugar natural.
 *
 * Roda em processo separado: um erro no backup não pode derrubar a emissão.
 */

const INTERVALO_MS = 6 * 3600 * 1000;   // confere de 6 em 6 horas
const UM_DIA_MS = 24 * 3600 * 1000;

let timer = null;

function pastaBackups() {
  return process.env.BACKUP_PASTA || path.join(__dirname, '..', '..', 'backups');
}

/* Só faz sentido se o último for de mais de um dia atrás. Sem essa checagem,
   reiniciar o gateway cinco vezes num dia geraria cinco backups iguais. */
function precisaDeBackup() {
  const pasta = pastaBackups();
  if (!fs.existsSync(pasta)) return true;

  const arquivos = fs.readdirSync(pasta).filter(f => /^nfse-backup-.*\.json$/.test(f));
  if (!arquivos.length) return true;

  const maisRecente = arquivos.sort().reverse()[0];
  const idade = Date.now() - fs.statSync(path.join(pasta, maisRecente)).mtimeMs;
  return idade > UM_DIA_MS;
}

function executar() {
  if (!precisaDeBackup()) return;

  const script = path.join(__dirname, '..', '..', 'scripts', 'backup.js');
  const filho = spawn(process.execPath, [script], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let saida = '';
  filho.stdout.on('data', d => { saida += d; });
  filho.stderr.on('data', d => { saida += d; });

  filho.on('close', codigo => {
    if (codigo === 0) {
      const ultima = saida.trim().split('\n').filter(l => l.includes('registros em')).pop();
      console.log('[backup]', ultima || 'concluído');
    } else {
      // Falhar o backup não interrompe nada, mas precisa aparecer: um backup
      // que falha em silêncio é pior que não ter backup, porque dá segurança
      // falsa.
      console.error('[backup] FALHOU — os dados estão sem cópia:',
        saida.trim().split('\n').pop());
    }
  });

  filho.on('error', e => console.error('[backup] não consegui iniciar:', e.message));
}

function iniciar() {
  // Espera um pouco: na subida o gateway ainda está abrindo conexões, e o
  // backup pode disputar o pool com a primeira emissão do dia.
  setTimeout(executar, 60 * 1000).unref();
  timer = setInterval(executar, INTERVALO_MS);
  timer.unref();
  console.log(`[backup] cópia diária ativa (pasta ${pastaBackups()})`);
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { iniciar, parar, precisaDeBackup };
