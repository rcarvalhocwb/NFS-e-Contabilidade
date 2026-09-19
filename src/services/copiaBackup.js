const fs = require('fs');
const path = require('path');
const db = require('../db');

/* Leva a cópia do backup para fora da máquina.
 *
 * O backup diário já roda, mas grava numa pasta do mesmo disco onde o banco
 * mora. Disco que morre leva os dois — e o escritório descobre no dia em que
 * precisar. Este módulo é a segunda perna: depois de o arquivo ficar pronto,
 * ele é copiado para cada destino cadastrado e CONFERIDO ali.
 *
 * Conferir é a parte que costuma faltar. Cópia truncada por pen drive removido
 * no meio, por rede que caiu ou por disco cheio fica com o nome certo, o
 * tamanho quase certo, e só se revela inútil na hora de restaurar. Aqui o
 * arquivo é lido de volta do destino, interpretado, e o número de registros é
 * comparado com o da origem. Se não bater, o destino conta como falhado.
 */

const RE_BACKUP = /^nfse-backup-.*\.json$/;

function pastaBackups() {
  return require('../util/dados').pastaBackups();
}

/* Dois caminhos no mesmo volume não são "fora da máquina".
   No Windows o root sai como "C:\"; num caminho de rede, "\\servidor\pasta\" —
   que é justamente o que se quer. */
function mesmoVolume(a, b) {
  const raiz = p => path.parse(path.resolve(p)).root.toLowerCase();
  return raiz(a) === raiz(b);
}

function contarRegistros(dados) {
  if (!dados || !dados.tabelas) return -1;
  return Object.values(dados.tabelas)
    .reduce((total, t) => total + (Array.isArray(t) ? t.length : 0), 0);
}

async function listar() {
  const r = await db.query(
    `SELECT id, caminho, apelido, ativo, manter, ultimo_ok, ultimo_arquivo,
            ultimo_erro, erro_em, criado_em
       FROM backup_destinos ORDER BY id`);
  return r.rows.map(d => Object.assign(d, {
    mesmo_disco: mesmoVolume(d.caminho, pastaBackups())
  }));
}

async function acrescentar({ caminho, apelido, manter }) {
  const limpo = String(caminho || '').trim();
  if (!limpo) {
    throw Object.assign(new Error('Informe a pasta de destino.'), { status: 400 });
  }

  /* Criar a pasta agora, e não na hora do backup: um caminho digitado errado
     precisa falhar aqui, com alguém olhando, e não às três da manhã. */
  try {
    fs.mkdirSync(limpo, { recursive: true });
    const teste = path.join(limpo, '.nfse-teste-escrita');
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
  } catch (e) {
    throw Object.assign(new Error('Não consegui gravar em ' + limpo + ': ' +
      explicar(e, limpo) + '.'), { status: 400 });
  }

  const n = Number(manter);
  const r = await db.query(
    `INSERT INTO backup_destinos (caminho, apelido, manter)
     VALUES ($1, $2, $3)
     ON CONFLICT (caminho) DO UPDATE SET apelido = EXCLUDED.apelido,
       manter = EXCLUDED.manter, ativo = TRUE
     RETURNING id`,
    [limpo, apelido || null, Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7]);
  return r.rows[0];
}

async function remover(id) {
  await db.query('DELETE FROM backup_destinos WHERE id = $1', [id]);
}

async function alternar(id, ativo) {
  await db.query('UPDATE backup_destinos SET ativo = $2 WHERE id = $1', [id, !!ativo]);
}

/* O backup mais recente da pasta local. É ele que viaja. */
function ultimoBackup() {
  const pasta = pastaBackups();
  if (!fs.existsSync(pasta)) return null;
  const arquivos = fs.readdirSync(pasta).filter(f => RE_BACKUP.test(f)).sort().reverse();
  return arquivos.length ? path.join(pasta, arquivos[0]) : null;
}

function rotacionar(pasta, manter) {
  try {
    fs.readdirSync(pasta)
      .filter(f => RE_BACKUP.test(f))
      .sort().reverse().slice(manter)
      .forEach(f => { try { fs.unlinkSync(path.join(pasta, f)); } catch (_) {} });
  } catch (_) { /* rotação é higiene, não pode derrubar a cópia */ }
}

/* Traduz o erro do sistema de arquivos para o que a pessoa precisa fazer.
   "EEXIST: file already exists, mkdir" está correto e não ajuda ninguém numa
   contabilidade — o texto tem de dizer o que aconteceu com aquele pen drive. */
function explicar(e, caminho) {
  const c = e && e.code;
  if (c === 'ENOENT') {
    return 'a pasta ' + caminho + ' não foi encontrada — o disco externo pode ' +
           'estar desconectado, ou a pasta de rede fora do ar';
  }
  if (c === 'EEXIST' || c === 'ENOTDIR') {
    return caminho + ' existe, mas não é uma pasta — apague ou renomeie o ' +
           'arquivo com esse nome';
  }
  if (c === 'EACCES' || c === 'EPERM') {
    return 'sem permissão para gravar em ' + caminho;
  }
  if (c === 'ENOSPC') return 'não há espaço livre em ' + caminho;
  if (c === 'EBUSY') return caminho + ' está em uso por outro programa';
  return e.message;
}

async function copiarPara(destino, origem, esperados) {
  const alvo = path.join(destino.caminho, path.basename(origem));
  try {
    fs.mkdirSync(destino.caminho, { recursive: true });
    fs.copyFileSync(origem, alvo);
  } catch (e) {
    throw new Error(explicar(e, destino.caminho));
  }

  // Lê de volta DO DESTINO: é o único jeito de saber que chegou inteiro
  const lido = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  const achados = contarRegistros(lido);
  if (achados !== esperados) {
    throw new Error('a cópia chegou incompleta — ' + achados +
      ' registros no destino contra ' + esperados + ' na origem');
  }

  rotacionar(destino.caminho, destino.manter);
  return alvo;
}

/* Leva o último backup para todos os destinos ativos.
   Um destino que falha não impede os outros: pen drive desconectado não pode
   deixar a pasta de rede sem cópia. */
async function copiar({ apenas } = {}) {
  const origem = ultimoBackup();
  if (!origem) {
    throw Object.assign(new Error(
      'Ainda não existe backup para copiar. Gere um primeiro.'), { status: 400 });
  }

  let esperados;
  try {
    esperados = contarRegistros(JSON.parse(fs.readFileSync(origem, 'utf8')));
  } catch (e) {
    throw Object.assign(new Error(
      'O backup da pasta local não pôde ser lido (' + e.message +
      '). Gere um novo antes de copiar.'), { status: 500 });
  }

  const destinos = (await listar()).filter(d => d.ativo && (!apenas || d.id === apenas));
  const resultado = { arquivo: path.basename(origem), registros: esperados, destinos: [] };

  for (const d of destinos) {
    try {
      const alvo = await copiarPara(d, origem, esperados);
      await db.query(
        `UPDATE backup_destinos SET ultimo_ok = now(), ultimo_arquivo = $2,
                ultimo_erro = NULL, erro_em = NULL WHERE id = $1`,
        [d.id, path.basename(alvo)]);
      resultado.destinos.push({ id: d.id, caminho: d.caminho, ok: true });
    } catch (e) {
      await db.query(
        `UPDATE backup_destinos SET ultimo_erro = $2, erro_em = now() WHERE id = $1`,
        [d.id, e.message]);
      console.error('[backup] destino', d.caminho, 'falhou:', e.message);
      resultado.destinos.push({ id: d.id, caminho: d.caminho, ok: false, erro: e.message });
    }
  }

  return resultado;
}

/* O que a tela precisa dizer em uma frase. */
async function situacao() {
  const destinos = await listar();
  const ativos = destinos.filter(d => d.ativo);
  const fora = ativos.filter(d => !d.mesmo_disco);
  const okRecente = fora.filter(d =>
    d.ultimo_ok && Date.now() - new Date(d.ultimo_ok).getTime() < 3 * 24 * 3600 * 1000);

  let nivel = 'erro';
  let texto;
  if (!ativos.length) {
    texto = 'A única cópia está no mesmo disco do banco. Se o disco morrer, ' +
            'os dois vão juntos — cadastre um destino externo.';
  } else if (!fora.length) {
    texto = 'Todos os destinos estão no mesmo disco do banco. Isso não protege ' +
            'contra o disco morrer.';
  } else if (!okRecente.length) {
    nivel = 'alerta';
    texto = 'Existe destino externo, mas nenhuma cópia bem-sucedida nos últimos ' +
            'três dias.';
  } else {
    nivel = 'ok';
    texto = 'Cópia levada para fora da máquina em ' +
            new Date(Math.max(...okRecente.map(d => new Date(d.ultimo_ok)))).toLocaleString('pt-BR') + '.';
  }
  return { nivel, texto, destinos, pastaLocal: pastaBackups() };
}

module.exports = {
  listar, acrescentar, remover, alternar, copiar, situacao,
  ultimoBackup, mesmoVolume, contarRegistros, explicar
};
