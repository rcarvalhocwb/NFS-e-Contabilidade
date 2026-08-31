const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');

/* O gateway está mesmo no ar? E vai continuar depois de um reinício?
 *
 * Estas respostas moravam num script de PowerShell. Funcionava para quem
 * escreve comandos e não funcionava para quem opera a contabilidade — que é
 * quem vai olhar a tela às oito da manhã quando um cliente reclamar que mandou
 * mensagem e ninguém respondeu.
 *
 * O que dá para fazer de dentro do sistema está aqui. O que não dá — registrar
 * tarefa e serviço exige elevação, e uma página web não dispara o UAC — vira
 * uma instrução de duplo clique num arquivo, não um comando para digitar.
 */

const RAIZ = path.join(__dirname, '..', '..');
const NOME_TAREFA = 'NFS-e Gateway';
const NOME_SERVICO_BANCO = 'nfse-postgres';
const ARQUIVO_MANUTENCAO = 'Manutencao.bat';

function rodar(programa, args, ms = 6000) {
  return new Promise(resolve => {
    execFile(programa, args, { timeout: ms, windowsHide: true },
      (erro, saida, erroTexto) => resolve({
        erro, saida: String(saida || ''), erroTexto: String(erroTexto || '')
      }));
  });
}

/* Este processo consegue mexer em serviço e tarefa?
   `net session` só responde para quem tem privilégio administrativo — é o
   teste mais barato e não depende de traduzir nome de grupo. */
async function elevado() {
  if (process.platform !== 'win32') return false;
  const r = await rodar('net', ['session'], 4000);
  return !r.erro;
}

/* --------------------------------------------------------------- a tarefa */

async function tarefa() {
  if (process.platform !== 'win32') {
    return { estado: 'nao_se_aplica', texto: 'Fora do Windows, quem cuida disso é o sistema operacional.' };
  }
  const r = await rodar('schtasks', ['/query', '/TN', NOME_TAREFA, '/FO', 'LIST']);
  const tudo = r.saida + r.erroTexto;

  if (!r.erro) {
    const st = (tudo.match(/(?:Status|Estado):\s*(.+)/i) || [])[1];
    const rodando = /running|em execu/i.test(st || '');
    return {
      estado: rodando ? 'ok' : 'parada',
      texto: rodando
        ? 'O gateway sobe sozinho com o Windows.'
        : 'A tarefa existe, mas não está em execução.',
      detalhe: (st || '').trim() || null
    };
  }
  if (/negado|denied/i.test(tudo)) {
    /* A tarefa roda como SYSTEM; um gateway aberto pelo atalho não consegue
       consultá-la. Dizer "não existe" seria dizer o contrário da verdade. */
    return {
      estado: 'sem_permissao',
      texto: 'Não consigo conferir daqui — este gateway não foi aberto pela tarefa. ' +
             'Isso normalmente significa que ela existe e está funcionando.'
    };
  }
  return {
    estado: 'falta',
    texto: 'O gateway NÃO sobe sozinho. Depois de um reinício ele fica parado, ' +
           'o WhatsApp não responde e o backup diário não roda.'
  };
}

/* ---------------------------------------------------------------- o banco */

async function banco() {
  if (process.platform !== 'win32') return { estado: 'nao_se_aplica', texto: '' };

  const r = await rodar('sc', ['query', NOME_SERVICO_BANCO]);
  const tudo = r.saida + r.erroTexto;
  if (/RUNNING|EM_EXECU/i.test(tudo)) {
    return { estado: 'ok', texto: 'O banco de dados sobe sozinho com o Windows.' };
  }
  if (/1060|does not exist|n.o existe|especificado n.o existe/i.test(tudo)) {
    return {
      estado: 'falta',
      texto: 'O banco de dados NÃO sobe sozinho. Depois de um reinício o gateway ' +
             'abre sem banco e nada funciona.'
    };
  }
  if (/STOPPED|PARADO/i.test(tudo)) {
    return { estado: 'parada', texto: 'O serviço do banco existe, mas está parado.' };
  }
  return { estado: 'nao_sei', texto: 'Não consegui conferir o serviço do banco.' };
}

/* ------------------------------------------------------------- os avisos */

async function certificados() {
  const r = await db.query(
    `SELECT e.razao_social, c.valido_ate,
            EXTRACT(day FROM c.valido_ate - now())::int AS dias
       FROM certificados c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.ativo AND e.ativo ORDER BY c.valido_ate`);
  return r.rows.map(c => ({
    empresa: c.razao_social,
    validoAte: c.valido_ate,
    dias: c.dias,
    estado: c.dias < 0 ? 'vencido' : c.dias <= 30 ? 'vencendo' : 'ok'
  }));
}

async function backup() {
  const destinos = await db.query(
    'SELECT count(*)::int n FROM backup_destinos WHERE ativo');
  const pasta = path.join(RAIZ, 'backups');
  let ultimo = null;
  try {
    const arquivos = fs.readdirSync(pasta)
      .filter(f => /^nfse-backup-.*\.json$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(pasta, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (arquivos.length) ultimo = new Date(arquivos[0].t).toISOString();
  } catch (_) { /* pasta ainda não existe */ }

  const dias = ultimo
    ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 86400000) : null;
  return {
    ultimo, dias,
    destinosFora: destinos.rows[0].n,
    estado: destinos.rows[0].n === 0 ? 'so_aqui'
          : dias === null ? 'nenhum'
          : dias >= 2 ? 'atrasado' : 'ok'
  };
}

function rede() {
  const host = process.env.HOST || '0.0.0.0';
  const aberto = (host === '0.0.0.0' || host === '::') &&
                 process.env.ADMIN_ATIVO !== 'false';
  return {
    host,
    estado: aberto ? 'aberto_na_rede' : 'so_aqui',
    texto: aberto
      ? 'O painel atende toda a rede local, e sem HTTPS: a senha de quem entrar ' +
        'de outro computador trafega em claro.'
      : 'O painel só atende neste computador.'
  };
}

/* ------------------------------------------------------------- o retrato */

async function ler() {
  const [t, b, cert, bkp, priv] = await Promise.all([
    tarefa(), banco(), certificados(), backup(), elevado()
  ]);

  const arquivo = path.join(RAIZ, ARQUIVO_MANUTENCAO);
  return {
    tarefa: t,
    banco: b,
    certificados: cert,
    backup: bkp,
    rede: rede(),
    /* Quando este processo tem privilégio, a tela pode agir. Quando não tem,
       ela aponta o arquivo para dar duplo clique — não um comando para
       digitar, que é o que fazia o operador comum travar. */
    podeAgir: priv,
    arquivoManutencao: fs.existsSync(arquivo) ? arquivo : null,
    versao: require('../../package.json').version,
    noArDesde: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
}

/* ---------------------------------------------------------- as ações */

/* Reiniciar o gateway por ele mesmo.
 *
 * Necessário depois de toda atualização, e é a operação que mais se repete.
 * O `/end` mata este processo; por isso quem chama responde ANTES, e o
 * agendamento de reinício fica por conta do Windows, que reexecuta a tarefa. */
async function reiniciar() {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Só no Windows.'), { status: 400 });
  }
  if (!await elevado()) {
    throw Object.assign(new Error(
      'Este gateway não foi aberto pela tarefa do Windows, então não tem ' +
      'permissão para se reiniciar. Dê dois cliques em ' + ARQUIVO_MANUTENCAO +
      ', na pasta do gateway, e escolha "Reiniciar".'), { status: 409 });
  }

  const r = await rodar('schtasks', ['/query', '/TN', NOME_TAREFA]);
  if (r.erro) {
    throw Object.assign(new Error(
      'A tarefa do Windows não está registrada, então não há o que reiniciar. ' +
      'Dê dois cliques em ' + ARQUIVO_MANUTENCAO + ' e escolha "Instalar".'),
      { status: 409 });
  }

  /* Meio segundo para a resposta HTTP sair antes de o processo morrer. */
  setTimeout(() => {
    execFile('schtasks', ['/end', '/TN', NOME_TAREFA], { windowsHide: true }, () => {
      execFile('schtasks', ['/run', '/TN', NOME_TAREFA], { windowsHide: true }, () => {});
    });
  }, 500).unref();

  return { ok: true, aviso: 'O gateway vai sair do ar por alguns segundos e voltar sozinho.' };
}

module.exports = { ler, reiniciar, elevado, NOME_TAREFA, NOME_SERVICO_BANCO };
