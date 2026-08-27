const http = require('http');
const path = require('path');
const crypto = require('crypto');

const meta = require('./meta');
const conversa = require('./conversa');
const { Memoria } = require('./memoria');

/* O repassador entre o WhatsApp e o gateway do escritório.
 *
 * Existe por um motivo só: a Meta entrega mensagem fazendo POST num endereço
 * público em HTTPS. Alguém precisa ter esse endereço, e não pode ser a máquina
 * que guarda os certificados A1 e as notas de todos os clientes.
 *
 * Então este processo fica na internet e o gateway continua puxando. O que ele
 * pode fazer é deliberadamente pouco: conversar com o cliente, montar o pedido
 * e guardá-lo até o gateway buscar. Certificado, numeração fiscal, XML e PDF
 * nunca passam por aqui — quem quiser o documento pega na consulta pública da
 * Sefin, que é para onde o QR Code da nota aponta de todo jeito.
 *
 * Se este processo for invadido, o que se perde é a fila de pedidos pendentes.
 * Nada que já virou nota, e nada que assine coisa alguma.
 */

const PORTA = Number(process.env.PORT || 8080);

const CFG = {
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  appSecret: process.env.META_APP_SECRET || '',
  token: process.env.META_TOKEN || '',
  phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  chaveGateway: process.env.CHAVE_GATEWAY || ''
};

const memoria = new Memoria(process.env.ARQUIVO_DADOS);

/* -------------------------------------------------------------- utilidades */

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
                          'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

function texto(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(String(corpo));
}

function lerCorpo(req, limite = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', p => {
      bruto += p;
      if (bruto.length > limite) { reject(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => resolve(bruto));
    req.on('error', reject);
  });
}

/* A chave do gateway, comparada em tempo constante — a mesma razão da
   assinatura da Meta: comparação de string vaza o prefixo correto. */
function chaveDoGatewayConfere(req) {
  const cabecalho = String(req.headers.authorization || '');
  const esperado = 'Bearer ' + CFG.chaveGateway;
  if (!CFG.chaveGateway) return false;
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- a conversa */

/* Processa uma mensagem recebida e responde ao cliente.
   Assíncrono de propósito: a Meta espera HTTP 200 em até 20 segundos e desiste
   depois, reenviando. Responder primeiro e trabalhar depois é o que evita ela
   entregar a mesma mensagem três vezes. */
/* Uma mensagem por vez, por número.
 *
 * Duas mensagens do mesmo cliente chegando juntas — o que acontece quando
 * alguém manda "1" e "1" em sequência rápida — leriam o mesmo estado e
 * avançariam os dois a partir dele. No melhor caso a segunda se perde; no pior,
 * as duas passam pela confirmação e viram dois pedidos. A fila por número
 * custa nada e fecha a corrida. */
const emAndamento = new Map();

function enfileirarPorNumero(numero, tarefa) {
  const anterior = emAndamento.get(numero) || Promise.resolve();
  const proxima = anterior.then(tarefa, tarefa);
  emAndamento.set(numero, proxima.catch(() => {}));
  proxima.finally(() => {
    if (emAndamento.get(numero) === proxima.catch(() => {})) emAndamento.delete(numero);
  });
  return proxima;
}

async function tratarMensagem(m) {
  /* Mensagem já processada não vale de novo: a assinatura da Meta continua
     válida para sempre, e quem capturar um POST assinado pode reenviá-lo. */
  if (memoria.jaVi(m.id)) {
    console.warn('[webhook] mensagem repetida, ignorada:', m.id);
    return;
  }

  /* Mensagem velha demais também não. Reenvio legítimo da Meta acontece em
     minutos; horas depois é replay de alguém. */
  if (m.recebidaEm && Date.now() - m.recebidaEm > 6 * 3600 * 1000) {
    console.warn('[webhook] mensagem de', new Date(m.recebidaEm).toISOString(), '— velha demais');
    return;
  }

  if (!m.texto) {
    return responderAoCliente(m.de,
      'Por enquanto eu entendo só texto. Escreva "oi" para começar.');
  }

  const vinculos = memoria.empresasDe(m.de);
  if (!vinculos.length) {
    /* Número desconhecido não recebe a lista de empresas nem sabe que o
       serviço existe: só uma resposta neutra. */
    return responderAoCliente(m.de,
      'Este número não está autorizado a pedir notas.\n\n' +
      'Se você é cliente do escritório, peça para cadastrarem seu WhatsApp.');
  }

  const anterior = memoria.conversaDe(m.de);

  /* Cada mensagem entra na transcrição antes de ser respondida. Anotar só
     depois perderia justamente a que quebrou a conversa. */
  const transcricao = ((anterior && anterior.dados && anterior.dados.transcricao) || [])
    .concat([{ de: 'cliente', texto: String(m.texto).slice(0, 500),
               em: new Date(m.recebidaEm || Date.now()).toISOString() }])
    .slice(-60);
  const comHistorico = anterior
    ? Object.assign({}, anterior, { dados: Object.assign({}, anterior.dados, { transcricao }) })
    : { estado: 'inicio', dados: { transcricao }, em: new Date().toISOString() };

  let saida;
  try {
    saida = conversa.responder({
      texto: m.texto, telefone: m.de, vinculos, conversa: anterior ? comHistorico : null,
      memoria
    });
  } catch (e) {
    console.error('[conversa] quebrou:', e.message);
    memoria.esquecerConversa(m.de);
    return responderAoCliente(m.de,
      'Tive um problema aqui. Comece de novo escrevendo "oi", por favor.');
  }

  // A resposta do sistema também entra no registro
  const completa = transcricao.concat([{
    de: 'sistema', texto: String(saida.resposta || '').slice(0, 1000),
    em: new Date().toISOString()
  }]).slice(-60);

  if (saida.pedido) {
    saida.pedido.transcricao = completa;
    memoria.enfileirar(saida.pedido);
    console.log('[fila] pedido', saida.pedido.id, 'de', m.de, 'para', saida.pedido.cnpjEmpresa);
  }

  if (saida.estado) {
    memoria.guardarConversa(m.de, saida.estado,
      Object.assign({}, saida.dados, { transcricao: completa }));
  } else {
    memoria.esquecerConversa(m.de);
  }

  return responderAoCliente(m.de, saida.resposta);
}

/* As credenciais do número vêm do gateway junto com o cadastro; o .env é o
   caminho de reserva, para a primeira subida e para quando o cadastro ainda não
   chegou. Assim o contador configura o WhatsApp na tela dele, e não por SSH. */
function credenciais() {
  const canal = (memoria.dados.cadastro || {}).canal || {};
  return {
    phoneNumberId: canal.phoneNumberId || CFG.phoneNumberId,
    token: canal.token || CFG.token
  };
}

async function responderAoCliente(para, textoMsg) {
  try {
    const { phoneNumberId, token } = credenciais();
    if (!phoneNumberId || !token) {
      console.error('[meta] sem número configurado — a resposta para', para, 'não saiu.',
        'Configure o WhatsApp do escritório na tela "Portal do cliente" do gateway.');
      return;
    }
    await meta.enviarTexto({ para, texto: textoMsg, phoneNumberId, token });
  } catch (e) {
    if (e.foraDaJanela) {
      console.warn('[meta] janela de 24h fechada para', para, '- a resposta não saiu');
    } else {
      console.error('[meta] falha ao responder', para + ':', e.message);
    }
  }
}

/* --------------------------------------------------------------- servidor */

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  try {
    /* ---------------------------------------------- webhook: verificação */
    if (req.method === 'GET' && u.pathname === '/webhook') {
      const desafio = meta.conferirDesafio(
        Object.fromEntries(u.searchParams), CFG.verifyToken);
      if (desafio === null) return texto(res, 403, 'token de verificação não confere');
      return texto(res, 200, desafio);
    }

    /* ---------------------------------------------- webhook: mensagens */
    if (req.method === 'POST' && u.pathname === '/webhook') {
      const bruto = await lerCorpo(req);

      /* Sem esta conferência, qualquer um que descubra o endereço enfileira
         pedido de nota fiscal em nome de um cliente do escritório. */
      if (!meta.assinaturaConfere(bruto, req.headers['x-hub-signature-256'], CFG.appSecret)) {
        console.warn('[webhook] assinatura não confere — descartado');
        return json(res, 403, { erro: 'assinatura inválida' });
      }

      let corpo = null;
      try { corpo = JSON.parse(bruto); } catch (_) { return json(res, 400, { erro: 'json inválido' }); }

      // Responde antes de trabalhar: a Meta desiste em 20s e reenvia
      json(res, 200, { ok: true });

      for (const m of meta.extrairMensagens(corpo)) {
        enfileirarPorNumero(m.de, () => tratarMensagem(m))
          .catch(e => console.error('[webhook]', e.message));
      }
      return;
    }

    /* ------------------------------------------- o que o gateway consome */
    if (u.pathname === '/cadastro' || u.pathname.startsWith('/solicitacoes')) {
      if (!chaveDoGatewayConfere(req)) return json(res, 401, { erro: 'chave inválida' });
    }

    if (req.method === 'POST' && u.pathname === '/cadastro') {
      const bruto = await lerCorpo(req, 8 * 1024 * 1024);
      const retrato = JSON.parse(bruto);
      memoria.guardarCadastro(retrato);
      console.log('[cadastro] retrato', String(retrato.versao).slice(0, 12),
        '·', (retrato.empresas || []).length, 'empresa(s),',
        (retrato.whatsapp || []).length, 'número(s)');
      return json(res, 200, { ok: true, versao: retrato.versao });
    }

    if (req.method === 'GET' && u.pathname === '/solicitacoes') {
      return json(res, 200, {
        solicitacoes: memoria.pendentes(u.searchParams.get('limite'))
      });
    }

    const m = u.pathname.match(/^\/solicitacoes\/([^/]+)\/resultado$/);
    if (req.method === 'POST' && m) {
      const bruto = await lerCorpo(req);
      const desfecho = JSON.parse(bruto);
      const id = decodeURIComponent(m[1]);
      const pedido = memoria.concluir(id, desfecho);

      /* O cliente pediu e ficou esperando: avisar é a razão de o pedido ter
         guardado o remetente. */
      if (pedido && pedido.remetente) {
        responderAoCliente(pedido.remetente, conversa.avisoDeDesfecho(desfecho))
          .catch(e => console.error('[aviso]', e.message));
      }
      return json(res, 200, { ok: true });
    }

    /* ------------------------------------------------------------ saúde */
    /* Boca de teste: enfileira um pedido direto, como faria quem controlasse
       este processo. Existe para provar que o GATEWAY se defende sozinho, e só
       liga com RELAY_TESTE=true — num servidor de verdade ela não existe. */
    if (req.method === 'POST' && u.pathname === '/_injetar') {
      if (process.env.RELAY_TESTE !== 'true') return json(res, 404, { erro: 'não existe' });
      const bruto = await lerCorpo(req);
      memoria.enfileirar(JSON.parse(bruto));
      return json(res, 201, { ok: true });
    }

    if (req.method === 'GET' && u.pathname === '/saude') {
      const d = memoria.dados;
      return json(res, 200, {
        ok: true,
        cadastro: d.cadastro ? {
          versao: d.cadastro.versao,
          empresas: (d.cadastro.empresas || []).length,
          numeros: (d.cadastro.whatsapp || []).length
        } : null,
        pedidosNaFila: d.pedidos.length,
        conversasAbertas: Object.keys(d.conversas).length
      });
    }

    json(res, 404, { erro: 'não existe' });
  } catch (e) {
    console.error('[servidor]', e.message);
    if (!res.headersSent) json(res, 500, { erro: 'falha interna' });
  }
});

function conferirConfiguracao() {
  const faltando = Object.keys(CFG).filter(k => !CFG[k]);
  if (faltando.length) {
    console.warn('[config] faltam variáveis: ' + faltando.join(', ') +
      ' — veja o .env.exemplo. O relay sobe assim mesmo, mas não vai funcionar inteiro.');
  }
}

if (require.main === module) {
  conferirConfiguracao();
  servidor.listen(PORTA, () => {
    console.log('repassador ouvindo na porta ' + PORTA);
    console.log('  webhook da Meta:  POST /webhook');
    console.log('  gateway busca em: GET  /solicitacoes');
  });
}

module.exports = { servidor, memoria, CFG };
