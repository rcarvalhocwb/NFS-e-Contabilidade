#!/usr/bin/env node
/**
 * Módulo do WhatsApp — programa separado, com ícone próprio.
 *
 * POR QUE NÃO É PARTE DO GATEWAY: a sessão do WhatsApp cai, reconecta, pede QR
 * de novo e às vezes morre por decisão de terceiro. Dentro do gateway, cada um
 * desses acidentes seria um acidente do sistema de nota fiscal. Aqui fora, o
 * pior que acontece é o WhatsApp parar — e a emissão pelo painel nem fica
 * sabendo.
 *
 * É o mesmo desenho do monitor, pelo mesmo motivo: dois programas, duas vidas.
 *
 * ACESSO: atende só em 127.0.0.1 e exige um token sorteado a cada subida. O
 * `WhatsApp.bat` lê o token e abre o navegador já com ele. Sem isso, qualquer
 * programa da máquina que falasse com a porta mandaria mensagem em nome do
 * escritório.
 *
 * O QUE ELE NÃO FAZ: não emite nota, não assina, não fala com a Sefin, não
 * guarda XML e não conhece a conversa. Ele mantém a sessão, entrega o texto ao
 * repassador e envia o que o repassador mandar enviar.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Motor } = require('./motor');
const termo = require('./termo');

const PORTA = Number(process.env.WA_PORTA || 3200);
/* O REPASSADOR, e nao o gateway. A conversa inteira -- 695 linhas, a memoria e
   a fila -- ja vive nele, e ele atende tanto na nuvem quanto nesta maquina
   (`relay_local`). Mandar direto ao gateway obrigaria a uma segunda
   implementacao da conversa, que divergiria da primeira no primeiro ajuste. */
const RELAY = process.env.WA_RELAY || 'http://127.0.0.1:8080';
const CHAVE_RELAY = process.env.CHAVE_GATEWAY || '';
const PASTA = __dirname;   // arquivos que vieram no pacote (só leitura)
/* Onde este módulo ESCREVE: sessão e token. Não pode ser a pasta de instalação
   — no Windows ela vive em Arquivos de Programas, que é só-leitura para quem
   não é administrador, e a gravação estourava com EPERM. O WhatsApp.bat aponta
   NFSE_WA_DADOS para uma pasta gravável (LocalAppData). Fora do Windows, ou
   rodando à mão, cai em __dirname, como antes. */
let DADOS;
try {
  /* Mesma resolução que o gateway usa para LER o token (src/util/dados):
     os dois processos precisam do mesmo caminho. */
  DADOS = require('../src/util/dados').pastaWhatsapp();
} catch (_) {
  DADOS = process.env.NFSE_WA_DADOS || __dirname;
}
try { fs.mkdirSync(DADOS, { recursive: true }); } catch (_) { /* já existe */ }
const SESSAO = path.join(DADOS, 'sessao');
const ARQ_TOKEN = path.join(DADOS, 'token.txt');

/* Token de abertura, como no monitor. Gravado num arquivo que o .bat lê e
   apagado quando o processo sai — token que sobrevive ao processo é token que
   alguém encontra depois. */
const TOKEN = crypto.randomBytes(24).toString('hex');
fs.writeFileSync(ARQ_TOKEN, TOKEN, { mode: 0o600 });
const limparToken = () => { try { fs.unlinkSync(ARQ_TOKEN); } catch (_) {} };
process.on('exit', limparToken);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { limparToken(); process.exit(0); });

/* Últimas mensagens, só para a tela. Em memória e limitado: este processo não
   guarda histórico — quem guarda é o repassador, na memória dele, e o gateway,
   no banco. Aqui é só o que a pessoa vê ao abrir a janela. */
const ULTIMAS = [];
function anotar(linha) {
  ULTIMAS.unshift(Object.assign({ em: new Date().toISOString() }, linha));
  if (ULTIMAS.length > 40) ULTIMAS.pop();
}

/* ---------------------------------------------- a ponte com o repassador */

/* A mensagem chega aqui e vai para o repassador, que tem a conversa e a fila.
   Este módulo não decide nada sobre nota fiscal — ele transporta.

   A RESPOSTA NÃO VOLTA POR AQUI: o repassador responde chamando de volta o
   `/enviar` deste módulo, pelo mesmo adaptador que usaria para falar com a
   Meta. É o que mantém um caminho só para a saída, seja qual for o meio. */
async function entregarAoRelay(msg) {
  anotar({ direcao: 'entrada', de: msg.de, texto: msg.texto, tipo: msg.tipo });

  if (!msg.texto) {
    /* Áudio, figurinha e imagem sem legenda não pedem nota. Responder algo é
       melhor que o silêncio, que faz a pessoa achar que o número está morto. */
    await motor.enviarTexto({
      para: msg.de,
      texto: 'Recebi, mas só consigo ler mensagens de texto. ' +
             'Escreva o que precisa que eu ajudo.'
    }).catch(() => {});
    return;
  }

  motor.digitando(msg.de, true).catch(() => {});

  try {
    const r = await fetch(RELAY + '/wa/entrada', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chave-Gateway': CHAVE_RELAY },
      body: JSON.stringify({ de: msg.de, texto: msg.texto, id: msg.id, em: msg.em })
    });
    if (!r.ok) throw new Error('repassador respondeu ' + r.status);
  } catch (e) {
    /* O repassador fora do ar não pode virar silêncio para quem escreveu: sem
       resposta, a pessoa manda de novo, e duas mensagens iguais viram duas
       conversas na fila. */
    console.error('[wa] repassador não respondeu:', e.message);
    anotar({ direcao: 'erro', de: msg.de, texto: e.message });
    await motor.enviarTexto({
      para: msg.de,
      texto: 'O sistema do escritório não respondeu agora. ' +
             'Sua mensagem não se perdeu — tente de novo em alguns minutos.'
    }).catch(() => {});
  } finally {
    motor.digitando(msg.de, false).catch(() => {});
  }
}

const motor = new Motor({ pastaSessao: SESSAO, aoReceber: entregarAoRelay });

motor.on('situacao', (e) => {
  console.log('[wa] ' + e.situacao + (e.ultimoErro ? ' — ' + e.ultimoErro : ''));
  /* O GATEWAY guarda a situação — este é o único ponto em que o módulo fala
     com ele, e é para o painel poder mostrar o estado mesmo com este processo
     fora do ar, que é justamente quando alguém quer saber. */
  fetch((process.env.WA_GATEWAY || 'http://127.0.0.1:3000') + '/ponte/whatsapp/situacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chave-Gateway': CHAVE_RELAY },
    body: JSON.stringify(e)
  }).catch(() => {});
});

/* ------------------------------------------------------------- o servidor */

function json(res, codigo, corpo) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function corpoDe(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  /* A tela e seus arquivos: o token vem na URL, injetado pelo .bat. */
  if (u.pathname === '/' || u.pathname === '/janela.js') {
    if (u.searchParams.get('t') !== TOKEN && req.headers['x-wa-token'] !== TOKEN) {
      res.writeHead(403).end('token invalido');
      return;
    }
    const nome = u.pathname === '/' ? 'janela.html' : 'janela.js';
    let conteudo = fs.readFileSync(path.join(PASTA, nome), 'utf8');
    if (nome === 'janela.html') conteudo = conteudo.replace(/__TOKEN__/g, TOKEN);
    res.writeHead(200, {
      'Content-Type': nome.endsWith('.html')
        ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
    });
    res.end(conteudo);
    return;
  }

  /* Tudo o mais exige o token no cabeçalho. */
  if (req.headers['x-wa-token'] !== TOKEN) {
    json(res, 403, { erro: 'token invalido' });
    return;
  }

  try {
    if (u.pathname === '/situacao' && req.method === 'GET') {
      return json(res, 200, Object.assign(motor.estado(), {
        termoVersao: termo.VERSAO,
        ultimas: ULTIMAS.slice(0, 20)
      }));
    }

    if (u.pathname === '/termo' && req.method === 'GET') {
      return json(res, 200, { versao: termo.VERSAO, resumo: termo.RESUMO, texto: termo.TEXTO });
    }

    /* O QR, já como imagem, para a tela não precisar de biblioteca. */
    if (u.pathname === '/qr' && req.method === 'GET') {
      if (!motor.qrAtual) return json(res, 404, { erro: 'não há QR agora' });
      const qrcode = require('qrcode');
      const dataUrl = await qrcode.toDataURL(motor.qrAtual, { margin: 1, width: 320 });
      return json(res, 200, { qr: dataUrl });
    }

    if (u.pathname === '/ligar' && req.method === 'POST') {
      const b = await corpoDe(req);
      /* Sem aceite não liga, e a conferência é aqui — não só na tela. Uma
         trava que vive só no navegador não é trava. */
      if (b.termoVersao !== termo.VERSAO) {
        return json(res, 412, {
          erro: 'É preciso aceitar o termo de uso (versão ' + termo.VERSAO + ') antes de ligar.'
        });
      }
      await motor.ligar();
      return json(res, 200, motor.estado());
    }

    if (u.pathname === '/desligar' && req.method === 'POST') {
      const b = await corpoDe(req);
      await motor.desligar({ apagar: !!b.apagarSessao });
      return json(res, 200, motor.estado());
    }

    if (u.pathname === '/enviar' && req.method === 'POST') {
      const b = await corpoDe(req);
      let r;
      if (b.documento) {
        r = await motor.enviarDocumento({
          para: b.para, conteudo: b.documento.conteudo,
          nomeArquivo: b.documento.nome, tipo: b.documento.tipo, legenda: b.documento.legenda
        });
      } else if (b.imagem) {
        r = await motor.enviarImagem({ para: b.para, conteudo: b.imagem.conteudo, legenda: b.imagem.legenda });
      } else {
        r = await motor.enviarTexto({ para: b.para, texto: b.texto });
      }
      anotar({ direcao: 'saida', de: b.para, texto: b.texto || '[arquivo]' });
      return json(res, 200, r);
    }

    if (u.pathname === '/existe' && req.method === 'GET') {
      const n = u.searchParams.get('numero');
      return json(res, 200, { existe: await motor.existe(n) });
    }

    json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    json(res, e.status || 500, { erro: e.message });
  }
});

/* 127.0.0.1 e não 0.0.0.0: quem alcança esta porta manda mensagem em nome do
   escritório. Não há motivo para isso atravessar a rede. */
servidor.listen(PORTA, '127.0.0.1', () => {
  console.log('');
  console.log('  Módulo WhatsApp do NFS-e Gateway');
  console.log('  tela:     http://127.0.0.1:' + PORTA + '/?t=' + TOKEN);
  console.log('  repassador: ' + RELAY);
  console.log('  sessão:   ' + SESSAO);
  console.log('');
  console.log('  Este módulo usa automação NÃO OFICIAL do WhatsApp.');
  console.log('  O número pode ser banido. A emissão de notas não depende disto.');
  console.log('');
});

module.exports = { servidor, motor, TOKEN };
