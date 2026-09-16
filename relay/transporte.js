const meta = require('./meta');

/* Por onde a mensagem entra e sai.
 *
 * A conversa (`conversa.js`, 695 linhas) não sabe nem precisa saber disto: ela
 * recebe texto e devolve texto. Este arquivo é a única parte que conhece o
 * meio, e existe porque ele deixou de ser um só.
 *
 * DOIS TRANSPORTES, E NUNCA OS DOIS AO MESMO TEMPO:
 *
 *   meta   API oficial do WhatsApp Business. A Meta faz POST no webhook e o
 *          repassador responde pelo Graph API. Tem contrato, tem janela de 24
 *          horas e não corre risco de banimento — é o uso previsto.
 *
 *   local  Sessão própria, mantida pelo módulo `wa/` na máquina do escritório.
 *          Não tem burocracia nem janela de 24 horas; em troca, é automação
 *          não oficial e o número pode ser banido. O escritório aceita um termo
 *          antes de ligar.
 *
 * Dois ao mesmo tempo dariam resposta dobrada ao cliente — que não faz ideia de
 * que existem dois caminhos.
 */

const QUAL = (process.env.WA_TRANSPORTE || 'meta').toLowerCase();
const MODULO_URL = process.env.WA_MODULO_URL || 'http://127.0.0.1:3200';

function ehLocal() { return QUAL === 'local'; }

/* O token do módulo, lido NA HORA e não guardado em memória.
 *
 * Ele é sorteado a cada subida do módulo e gravado em `wa/token.txt`. Lido uma
 * vez na partida, o repassador ficaria com um token velho assim que o módulo
 * reiniciasse — e reiniciar é rotina, porque é o que a pessoa faz quando o
 * WhatsApp trava. O resultado seria um 403 para cada resposta, sem nenhuma
 * relação visível com o reinício.
 *
 * O arquivo só existe quando o módulo roda NESTA máquina, que é o único caso em
 * que o transporte local faz sentido. Na nuvem ele não existe e a variável de
 * ambiente é a reserva. */
function tokenDoModulo() {
  if (process.env.WA_MODULO_TOKEN) return process.env.WA_MODULO_TOKEN;
  try {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(path.join(__dirname, '..', 'wa', 'token.txt'), 'utf8').trim();
  } catch (_) {
    return '';
  }
}

/* Falar com o módulo local. Timeout curto de propósito: a resposta ao cliente
   é importante, mas não vale segurar o processo se o módulo caiu — a próxima
   mensagem dele reconecta. */
async function chamarModulo(caminho, corpo) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 8000);
  try {
    const r = await fetch(MODULO_URL + caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Token': tokenDoModulo() },
      body: JSON.stringify(corpo),
      signal: controle.signal
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.erro || ('módulo respondeu ' + r.status));
    }
    return r.json();
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * Manda texto ao cliente. Devolve true/false — nunca lança.
 *
 * Não lançar é decisão de desenho: quem chama está no meio de uma conversa, e
 * uma exceção aqui derrubaria o tratamento da mensagem inteira por causa do
 * canal de saída. Falhar em responder é ruim; perder o pedido que já estava
 * montado é pior.
 */
async function responder(para, texto, credenciais) {
  try {
    if (ehLocal()) {
      await chamarModulo('/enviar', { para, texto });
      return true;
    }

    const { phoneNumberId, token } = credenciais || {};
    if (!phoneNumberId || !token) {
      console.error('[transporte] sem número da Meta configurado — a resposta para',
        para, 'não saiu. Configure na tela "Portal do cliente" do gateway.');
      return false;
    }
    await meta.enviarTexto({ para, texto, phoneNumberId, token });
    return true;
  } catch (e) {
    if (e.foraDaJanela) {
      console.warn('[transporte] janela de 24h fechada para', para, '— a resposta não saiu');
    } else {
      console.error('[transporte] falha ao responder', para + ':', e.message);
    }
    return false;
  }
}

/**
 * Manda um documento (a DANFSe, quando a nota fica pronta).
 *
 * Na Meta são dois passos — subir a mídia, depois enviar pelo id devolvido. No
 * módulo local é um só. A diferença fica aqui dentro; quem chama manda o
 * arquivo e pronto.
 */
async function enviarDocumento({ para, conteudo, nomeArquivo, tipo, legenda }, credenciais) {
  try {
    if (ehLocal()) {
      await chamarModulo('/enviar', {
        para,
        documento: {
          conteudo: Buffer.isBuffer(conteudo) ? conteudo.toString('base64') : conteudo,
          nome: nomeArquivo, tipo, legenda
        }
      });
      return true;
    }

    const { phoneNumberId, token } = credenciais || {};
    if (!phoneNumberId || !token) return false;

    const mediaId = await meta.subirDocumento({ conteudo, tipo, nomeArquivo, phoneNumberId, token });
    await meta.enviarDocumento({ para, mediaId, nomeArquivo, legenda, phoneNumberId, token });
    return true;
  } catch (e) {
    console.error('[transporte] falha ao enviar documento para', para + ':', e.message);
    return false;
  }
}

/* Como está o transporte, para o diagnóstico do painel. */
async function situacao() {
  if (!ehLocal()) {
    return { transporte: 'meta', ok: true, detalhe: 'API oficial, pelo repassador.' };
  }
  try {
    const r = await fetch(MODULO_URL + '/situacao', {
      headers: { 'X-WA-Token': tokenDoModulo() }
    });
    if (!r.ok) throw new Error('módulo respondeu ' + r.status);
    const e = await r.json();
    return {
      transporte: 'local',
      ok: e.situacao === 'conectado',
      situacao: e.situacao,
      numero: e.numero,
      detalhe: e.ultimoErro || null
    };
  } catch (e) {
    return {
      transporte: 'local', ok: false, situacao: 'desligado',
      detalhe: 'O módulo do WhatsApp não está no ar (' + e.message + '). ' +
               'Abra o WhatsApp.bat na pasta do gateway.'
    };
  }
}

module.exports = { responder, enviarDocumento, situacao, ehLocal, QUAL };
