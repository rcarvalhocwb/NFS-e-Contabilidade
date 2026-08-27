const crypto = require('crypto');

/* Conversa com a WhatsApp Cloud API da Meta.
 *
 * Duas direções, e as duas passam por aqui:
 *   entrada — a Meta faz POST no webhook quando o cliente escreve
 *   saída   — este módulo faz POST no Graph API para responder
 *
 * A assinatura da entrada é a parte que não se pode pular. O endereço do
 * webhook é público: qualquer um que o descubra pode mandar um POST fingindo
 * ser a Meta. Sem conferir o X-Hub-Signature-256, um estranho enfileira pedido
 * de nota fiscal em nome de um cliente do escritório.
 */

/* Endereco do Graph API. Configuravel para fixar a versao quando a Meta
   lancar uma nova, e para o teste de ponta a ponta poder apontar para um
   servidor local em vez de mandar mensagem de verdade. */
const GRAPH = process.env.META_GRAPH || 'https://graph.facebook.com/v21.0';

/* Verificação do webhook, feita uma vez quando se cadastra o endereço no painel
   da Meta: ela chama com GET e espera o desafio de volta em texto puro. */
function conferirDesafio(query, tokenEsperado) {
  if (query['hub.mode'] !== 'subscribe') return null;
  if (query['hub.verify_token'] !== tokenEsperado) return null;
  return query['hub.challenge'];
}

/* Assinatura do corpo, com o App Secret.
 *
 * Compara em tempo constante: `a === b` em string vaza, pelo tempo de resposta,
 * quantos bytes iniciais bateram — e com isso se descobre a assinatura correta
 * byte a byte. */
function assinaturaConfere(corpoBruto, cabecalho, appSecret) {
  if (!cabecalho || !appSecret) return false;
  const esperada = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(corpoBruto, 'utf8')
    .digest('hex');

  const a = Buffer.from(esperada);
  const b = Buffer.from(String(cabecalho));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Tira da estrutura da Meta o que interessa: quem falou e o que disse.
 *
 * O formato vem aninhado em entry[].changes[].value.messages[], e um mesmo POST
 * pode trazer várias mensagens — inclusive de pessoas diferentes. Também chegam
 * eventos de status (entregue, lido) que não são mensagem nenhuma; esses são
 * descartados aqui em vez de virarem conversa. */
function extrairMensagens(corpo) {
  const achadas = [];
  for (const entrada of (corpo && corpo.entry) || []) {
    for (const mudanca of entrada.changes || []) {
      const valor = mudanca.value || {};
      const perfis = {};
      for (const c of valor.contacts || []) {
        perfis[c.wa_id] = (c.profile || {}).name || null;
      }
      for (const m of valor.messages || []) {
        // Só texto e botão: áudio, imagem e figurinha não pedem nota fiscal
        let texto = null;
        if (m.type === 'text') texto = (m.text || {}).body;
        else if (m.type === 'button') texto = (m.button || {}).text;
        else if (m.type === 'interactive') {
          const i = m.interactive || {};
          texto = (i.button_reply || i.list_reply || {}).title;
        }

        achadas.push({
          id: m.id,
          de: m.from,
          nome: perfis[m.from] || null,
          texto: texto,
          tipo: m.type,
          recebidaEm: m.timestamp ? Number(m.timestamp) * 1000 : Date.now(),
          telefoneDestino: (valor.metadata || {}).phone_number_id || null
        });
      }
    }
  }
  return achadas;
}

/* Manda uma mensagem de texto. Dentro da janela de 24 horas aberta pelo
   cliente, isso é conversa de serviço — gratuita e sem limite desde 11/2024.
   Fora dela a Meta recusa, e aí só template aprovado resolve. */
async function enviarTexto({ para, texto, phoneNumberId, token }) {
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: para,
      type: 'text',
      text: { preview_url: true, body: texto }
    })
  });

  const corpo = await r.text();
  if (!r.ok) {
    /* O erro da Meta vem com código; o 131047 é "fora da janela de 24h", que
       não é falha de programação e sim o cliente ter sumido. Quem chama decide
       o que fazer, mas precisa saber diferenciar. */
    let detalhe = corpo;
    try { detalhe = JSON.parse(corpo).error || detalhe; } catch (_) {}
    const e = new Error('A Meta recusou o envio: ' + JSON.stringify(detalhe).slice(0, 300));
    e.status = r.status;
    e.codigoMeta = detalhe && detalhe.code;
    e.foraDaJanela = detalhe && (detalhe.code === 131047 || detalhe.code === 131051);
    throw e;
  }
  return JSON.parse(corpo);
}

/* O que a Meta aceita como documento.
 *
 * A lista é fechada e XML NÃO está nela: só texto, PDF e os formatos do Office.
 * O XML da nota é o arquivo que o contador do cliente vai querer, então ele vai
 * como text/plain — o MIME é o que a Meta valida, e o nome do arquivo continua
 * dizendo o que é.
 */
const TIPOS = {
  pdf: { mime: 'application/pdf', extensao: '.pdf' },
  xml: { mime: 'text/plain', extensao: '.xml' }
};

/* Sobe o arquivo e devolve o id da mídia.
 *
 * Duas etapas, e é assim que a Meta quer: primeiro o upload, depois a mensagem
 * apontando para o id. Mandar por link exigiria um endereço público para o
 * documento fiscal — exatamente o que não se quer. */
async function subirDocumento({ conteudo, tipo, nomeArquivo, phoneNumberId, token }) {
  const t = TIPOS[tipo];
  if (!t) throw new Error('tipo de documento não suportado: ' + tipo);

  const forma = new FormData();
  forma.append('messaging_product', 'whatsapp');
  forma.append('type', t.mime);
  forma.append('file', new Blob([conteudo], { type: t.mime }), nomeArquivo);

  const r = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token },
    body: forma
  });
  const corpo = await r.text();
  if (!r.ok) {
    let detalhe = corpo;
    try { detalhe = JSON.parse(corpo).error || detalhe; } catch (_) {}
    const e = new Error('A Meta recusou o upload: ' + JSON.stringify(detalhe).slice(0, 300));
    e.status = r.status;
    e.codigoMeta = detalhe && detalhe.code;
    throw e;
  }
  return JSON.parse(corpo).id;
}

/* Manda um documento já subido. A legenda é o que a pessoa lê na conversa —
   sem ela, chega um anexo sem contexto. */
async function enviarDocumento({ para, mediaId, nomeArquivo, legenda,
                                 phoneNumberId, token }) {
  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: para,
      type: 'document',
      document: { id: mediaId, filename: nomeArquivo,
                  caption: legenda || undefined }
    })
  });
  const corpo = await r.text();
  if (!r.ok) {
    let detalhe = corpo;
    try { detalhe = JSON.parse(corpo).error || detalhe; } catch (_) {}
    const e = new Error('A Meta recusou o documento: ' + JSON.stringify(detalhe).slice(0, 300));
    e.status = r.status;
    e.codigoMeta = detalhe && detalhe.code;
    e.foraDaJanela = detalhe && (detalhe.code === 131047 || detalhe.code === 131051);
    throw e;
  }
  return JSON.parse(corpo);
}

module.exports = {
  conferirDesafio, assinaturaConfere, extrairMensagens,
  enviarTexto, subirDocumento, enviarDocumento, TIPOS, GRAPH
};
