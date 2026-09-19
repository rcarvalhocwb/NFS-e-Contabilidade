const os = require('os');
const fs = require('fs');
const path = require('path');
const db = require('../db');

/* O que é preciso saber ANTES de a nota não sair.
 *
 * Três coisas que só se descobrem no pior momento, e que ninguém vai procurar
 * numa tela:
 *
 *   - o certificado A1 venceu, e com ele param emissão, cancelamento e consulta
 *   - a única cópia do backup está no mesmo disco do banco, que é exatamente a
 *     lição do dia em que o projeto do Supabase sumiu
 *   - o painel atende a rede do escritório em HTTP, com a senha em claro
 *
 * Roda uma vez na subida e uma vez por dia. Vai para o log, que é para onde
 * alguém olha quando pergunta o que aconteceu — e o log fica em arquivo, então
 * a resposta continua lá depois.
 */

const UM_DIA = 24 * 3600 * 1000;

function aviso(texto) { console.warn('[aviso] ' + texto); }

/* ------------------------------------------------------------ certificado */

async function certificados() {
  const r = await db.query(
    `SELECT e.razao_social, c.valido_ate,
            EXTRACT(day FROM c.valido_ate - now())::int AS dias
       FROM certificados c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.ativo AND e.ativo`);

  for (const c of r.rows) {
    const quando = new Date(c.valido_ate).toLocaleDateString('pt-BR');
    if (c.dias < 0) {
      aviso('CERTIFICADO VENCIDO de ' + c.razao_social + ' (em ' + quando + '). ' +
            'Nenhuma nota desta empresa sai, e o cancelamento também não. ' +
            'Renove e suba o novo arquivo na ficha da empresa.');
    } else if (c.dias <= 30) {
      aviso('O certificado de ' + c.razao_social + ' vence em ' + c.dias +
            ' dia(s), em ' + quando + '. Renovar leva alguns dias na ' +
            'certificadora — comece agora, não no dia.');
    }
  }
}

/* ---------------------------------------------------------------- backup */

async function backup() {
  const destinos = await db.query('SELECT count(*)::int n FROM backup_destinos WHERE ativo');
  if (destinos.rows[0].n === 0) {
    aviso('Nenhum destino de backup fora desta máquina. A cópia diária fica no ' +
          'mesmo disco do banco: um disco que falha leva os dois. ' +
          'Configure em Backup e migração — um pendrive ou uma pasta de rede resolve.');
  }

  /* Backup velho é o sintoma de que o gateway não estava aberto — que é a
     mesma causa de o WhatsApp ficar mudo. Vale dizer as duas coisas juntas. */
  const pasta = path.join(__dirname, '..', '..', 'backups');
  try {
    const arquivos = fs.readdirSync(pasta)
      .filter(f => /^nfse-backup-.*\.json$/.test(f))
      .map(f => fs.statSync(path.join(pasta, f)).mtimeMs)
      .sort((a, b) => b - a);
    if (!arquivos.length) return;
    const dias = Math.floor((Date.now() - arquivos[0]) / UM_DIA);
    if (dias >= 2) {
      aviso('O último backup tem ' + dias + ' dias. Isso costuma querer dizer ' +
            'que o gateway ficou fechado nesses dias — e fechado ele também ' +
            'não atende o WhatsApp. Confira com: ' +
            'scripts\\servico-windows.ps1 situacao');
    }
  } catch (_) { /* sem pasta ainda: nada a dizer */ }
}

/* ------------------------------------------------------------------- rede */

function rede() {
  if (process.env.ADMIN_ATIVO === 'false') return;
  const host = process.env.HOST || '0.0.0.0';
  if (host !== '0.0.0.0' && host !== '::') return;

  /* Só avisa se houver de fato outra máquina possível na rede — numa instalação
     isolada o alerta seria ruído. */
  const temRede = Object.values(os.networkInterfaces()).some(
    lista => (lista || []).some(i => i.family === 'IPv4' && !i.internal));
  if (!temRede) return;

  aviso('O painel atende toda a rede local em HTTP (HOST=0.0.0.0). ' +
        'A senha de quem entrar de outro computador trafega em claro. ' +
        'Se só esta máquina opera, ponha HOST=127.0.0.1 no .env; ' +
        'se outras precisam entrar, trate de HTTPS antes de distribuir a senha.');
}

/* ------------------------------------------------------------- os padrões */

async function padroesFiscais() {
  const { faltaParaEmitirSemFormulario } = require('../nfse/padroesEmpresa');
  const r = await db.query('SELECT * FROM empresas WHERE ativo AND portal_liberado');
  for (const e of r.rows) {
    const falta = faltaParaEmitirSemFormulario(e);
    if (falta.length) {
      aviso('A empresa ' + (e.nome_fantasia || e.razao_social) + ' está liberada ' +
            'para pedir nota por WhatsApp, mas falta ' + falta.join(' e ') + '. ' +
            'Pelo formulário ela emite; pelo WhatsApp a Sefin recusa.');
    }
  }
}

/* Duas metades, e a divisão não é arbitrária.
 *
 * `rede` e `backup` olham o servidor: em que endereço ele escuta, se a cópia
 * diária sai do disco. Isso é um só, e avisar uma vez por escritório seria
 * repetir o mesmo aviso N vezes por dia até ninguém mais lê-lo.
 *
 * `certificados` e `padroesFiscais` olham a carteira de clientes, que é de
 * cada escritório. Sem rodar por inquilino, sob RLS eles não veriam empresa
 * nenhuma e o silêncio pareceria "está tudo certo" — quando o certificado A1
 * de alguém está para vencer. */
async function conferir() {
  try {
    rede();
    await backup();
  } catch (e) {
    // Conferência não pode derrubar o gateway nem atrapalhar a emissão.
    console.warn('[aviso] não consegui conferir o servidor:', e.message);
  }

  await db.porInquilino(
    async () => { await certificados(); await padroesFiscais(); },
    (e, id) => console.warn(`[aviso] escritório ${id}:`, e.message)
  ).catch(e => console.warn('[aviso] não consegui listar escritórios:', e.message));
}

let timer = null;

function iniciar() {
  /* Dez segundos depois de subir: o log da inicialização já passou, então o
     aviso não se perde no meio dele. */
  setTimeout(conferir, 10000).unref();
  timer = setInterval(conferir, UM_DIA);
  timer.unref();
}

function parar() { if (timer) clearInterval(timer); timer = null; }

module.exports = { iniciar, parar, conferir };
