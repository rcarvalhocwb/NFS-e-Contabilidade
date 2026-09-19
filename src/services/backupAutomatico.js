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

  /* Por data de modificação, não por nome. O nome passou a levar o escritório
     ANTES do carimbo de tempo (nfse-backup-e5-2026-09-17), então ordenar por
     nome põe o escritório 5 de ontem à frente do escritório 1 de hoje — e a
     diária deixaria de rodar achando que já rodou. */
  const maisRecente = arquivos
    .map(f => fs.statSync(path.join(pasta, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  return (Date.now() - maisRecente) > UM_DIA_MS;
}

function executar() {
  if (!precisaDeBackup()) return;

  const script = path.join(__dirname, '..', '..', 'scripts', 'backup.js');
  /* `--todos`: um arquivo por escritório. Sem o argumento, backup.js recusa
     rodar — e recusa de propósito. Sob RLS, uma conexão sem inquilino não
     enxerga linha nenhuma, então a diária global gravava arquivo vazio
     dizendo que tinha dado certo, copiava para o pendrive e mostrava verde
     na tela. Um backup que mente é pior do que nenhum. */
  const filho = spawn(process.execPath, [script, '--todos'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let saida = '';
  filho.stdout.on('data', d => { saida += d; });
  filho.stderr.on('data', d => { saida += d; });

  filho.on('close', codigo => {
    if (codigo === 0) {
      /* Uma linha por escritório: a diária que copia três casas e some com
         a quarta precisa aparecer no log como três, não como "concluído". */
      const porCasa = saida.trim().split('\n')
        .filter(l => /escritório \d+: /.test(l)).map(l => l.trim());
      console.log('[backup]', porCasa.length
        ? porCasa.join(' · ')
        : (saida.trim().split('\n').filter(l => l.includes('registros em')).pop() || 'concluído'));

      /* Gerado o arquivo, ele precisa sair deste disco. Cópia que fica ao lado
         do banco não protege contra o disco morrer — que é justamente o que
         aconteceu em 17/08. */
      require('./copiaBackup').copiar()
        .then(r => {
          const bons = r.destinos.filter(d => d.ok).length;
          if (r.destinos.length) {
            console.log(`[backup] cópia externa: ${bons}/${r.destinos.length} destino(s)`);
          }
        })
        .catch(e => console.error('[backup] cópia externa falhou:', e.message));
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
