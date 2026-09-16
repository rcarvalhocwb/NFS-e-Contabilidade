/* O que o repassador pode PERGUNTAR ao gateway.
 *
 * O desenho é de mão única de propósito — o gateway busca, o repassador espera.
 * É o que permite a máquina do escritório ficar atrás de um roteador doméstico,
 * sem porta aberta, com o certificado A1 dentro.
 *
 * Estas duas chamadas são a exceção, e cabem porque o repassador roda NA MESMA
 * MÁQUINA (`relay_local`). Quando ele está na nuvem, `GATEWAY_URL` não é
 * definida e as funções devolvem null — a conversa então diz que o escritório
 * vai retornar, em vez de prometer o que não pode cumprir.
 *
 * O QUE ELAS ALCANÇAM é estreito: as notas que nasceram dos pedidos daquele
 * telefone. Não as da empresa, não as do escritório. Mesmo com a chave em mãos,
 * o que se obtém é o que aquele número já tinha pedido e recebido.
 */
const URL_GATEWAY = process.env.GATEWAY_URL || '';
const CHAVE = process.env.CHAVE_GATEWAY || '';

function alcancavel() { return !!(URL_GATEWAY && CHAVE); }

/* Timeout curto: alguém está do outro lado esperando uma resposta no WhatsApp,
   e um gateway que não respondeu em seis segundos não vai responder a tempo de
   a conversa fazer sentido. */
async function chamar(caminho, corpo) {
  if (!alcancavel()) return null;

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 6000);
  try {
    const r = await fetch(URL_GATEWAY + caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chave-Gateway': CHAVE },
      body: JSON.stringify(corpo),
      signal: controle.signal
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      const erro = new Error(e.erro || ('gateway respondeu ' + r.status));
      erro.status = r.status;
      throw erro;
    }
    return r.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('[gateway] não respondeu a tempo:', caminho);
      return null;
    }
    /* 404 e 409 são respostas, não falhas: "não é sua" e "ainda não tem
       documento" precisam chegar à conversa para virar frase. */
    if (e.status === 404 || e.status === 409) throw e;
    console.error('[gateway] falha em', caminho + ':', e.message);
    return null;
  } finally {
    clearTimeout(relogio);
  }
}

/* As notas que aquele número pediu. null = não deu para perguntar. */
function notasDoCliente(telefone, limite) {
  return chamar('/ponte/cliente/notas', { telefone, limite });
}

/* O PDF e o XML de uma nota dele. Lança 404 quando a chave não é daquele
   número — e é a conversa que transforma isso em frase. */
function documentoDoCliente(telefone, chave) {
  return chamar('/ponte/cliente/documento', { telefone, chave });
}

module.exports = { notasDoCliente, documentoDoCliente, alcancavel };
