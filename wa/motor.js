const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/* A sessão do WhatsApp, e tudo que ela sabe fazer.
 *
 * Embrulha o Baileys — WebSocket, sem navegador. O `whatsapp-web.js` faria o
 * mesmo trazendo o Chromium junto: 300 MB a mais num instalador que precisa
 * caber num download de escritório.
 *
 * O QUE ESTE ARQUIVO EXISTE PARA RESOLVER, e é a parte que a biblioteca não
 * resolve sozinha:
 *
 *   - RECONECTAR sem virar tempestade. Queda de rede é comum; tentar de novo
 *     em laço apertado é o caminho mais curto para o WhatsApp achar que isto é
 *     um robô abusivo e banir o número. Espera crescente, com teto;
 *
 *   - SABER A DIFERENÇA entre "caiu" e "foi banido". Cair se resolve sozinho;
 *     banimento não se resolve nunca, e insistir piora. São códigos diferentes
 *     e comportamentos opostos;
 *
 *   - NÃO PERDER MENSAGEM no meio. Quem escreveu enquanto a sessão estava fora
 *     precisa ser atendido quando ela voltar — o Baileys entrega o atrasado, e
 *     este módulo não pode descartar o que chegou fora de ordem.
 *
 * O QUE ELE NÃO FAZ, DE PROPÓSITO: envio em massa, disparo para lista e
 * qualquer coisa que pareça propaganda. Não é limitação técnica — é que o
 * caminho mais rápido para perder o número é usar automação para o que a
 * automação não devia fazer, e um sistema fiscal não tem por que oferecer esse
 * caminho.
 */

const ESPERA_INICIAL_MS = 3000;
const ESPERA_MAXIMA_MS = 5 * 60 * 1000;

class Motor extends EventEmitter {
  constructor({ pastaSessao, aoReceber }) {
    super();
    this.pastaSessao = pastaSessao;
    this.aoReceber = aoReceber || (() => {});
    this.sock = null;
    this.situacao = 'desligado';
    this.qrAtual = null;
    this.numero = null;
    this.nomePerfil = null;
    this.ultimoErro = null;
    this.tentativa = 0;
    this.parando = false;
    this.timerReconexao = null;
  }

  estado() {
    return {
      situacao: this.situacao,
      numero: this.numero,
      nomePerfil: this.nomePerfil,
      temQr: !!this.qrAtual,
      ultimoErro: this.ultimoErro,
      tentativa: this.tentativa
    };
  }

  mudar(situacao, erro) {
    this.situacao = situacao;
    this.ultimoErro = erro || null;
    this.emit('situacao', this.estado());
  }

  async ligar() {
    this.parando = false;
    const baileys = require('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

    fs.mkdirSync(this.pastaSessao, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.pastaSessao);

    /* A versão do protocolo é buscada em vez de fixada: o WhatsApp muda o
       formato interno e uma versão velha para de conectar sem dizer por quê.
       Se a busca falhar, o Baileys usa a que conhece — melhor que não subir. */
    let versao;
    try {
      const r = await fetchLatestBaileysVersion();
      versao = r.version;
    } catch (_) { versao = undefined; }

    this.mudar('conectando');

    this.sock = makeWASocket({
      version: versao,
      auth: state,
      /* O QR sai por evento e vai para a tela do módulo; imprimir no terminal
         não serve, porque ninguém fica olhando um terminal. */
      printQRInTerminal: false,
      browser: ['NFS-e Gateway', 'Desktop', '1.0'],
      /* Não marca como visto sozinho: o escritório pode querer ler a conversa
         no celular depois, e mensagem já lida some da lista de não lidas. */
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (u) => this.aoMudarConexao(u, DisconnectReason));

    this.sock.ev.on('messages.upsert', async (m) => {
      /* `notify` é mensagem nova de verdade. `append` é histórico sendo
         sincronizado — reagir a ele responderia de novo a conversas antigas
         toda vez que a sessão reconectasse. */
      if (m.type !== 'notify') return;
      for (const msg of m.messages || []) {
        try {
          const traduzida = this.traduzir(msg);
          if (traduzida) await this.aoReceber(traduzida);
        } catch (e) {
          console.error('[wa] falha ao tratar mensagem:', e.message);
        }
      }
    });
  }

  aoMudarConexao(u, DisconnectReason) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.qrAtual = qr;
      this.mudar('esperando_qr');
      this.emit('qr', qr);
    }

    if (connection === 'open') {
      this.qrAtual = null;
      this.tentativa = 0;
      const id = (this.sock.user || {}).id || '';
      this.numero = id.split(':')[0].split('@')[0] || null;
      this.nomePerfil = (this.sock.user || {}).name || null;
      this.mudar('conectado');
      return;
    }

    if (connection !== 'close') return;

    const codigo = ((lastDisconnect || {}).error || {}).output
      ? lastDisconnect.error.output.statusCode : null;

    /* Banido ou desconectado pelo próprio dono: NÃO reconectar.
       Insistir com credencial recusada é exatamente o padrão que faz o
       WhatsApp endurecer contra o número — e, no caso de logout, seria
       reconectar uma sessão que a pessoa encerrou de propósito no celular. */
    if (codigo === DisconnectReason.loggedOut || codigo === 403 || codigo === 401) {
      this.apagarSessao();
      this.mudar('banido',
        codigo === DisconnectReason.loggedOut
          ? 'A sessão foi encerrada no celular. Leia o QR de novo para reconectar.'
          : 'O WhatsApp recusou esta sessão (código ' + codigo + '). ' +
            'Pode ser bloqueio do número. Não vou tentar de novo sozinho.');
      return;
    }

    if (this.parando) { this.mudar('desligado'); return; }

    /* Queda comum: reconectar com espera crescente e teto. Sem o teto, uma
       queda longa vira milhares de tentativas; sem a espera, vira tempestade. */
    this.tentativa += 1;
    const espera = Math.min(ESPERA_INICIAL_MS * Math.pow(2, this.tentativa - 1), ESPERA_MAXIMA_MS);
    this.mudar('caiu', 'Conexão caiu (código ' + codigo + '). Tentando de novo em ' +
      Math.round(espera / 1000) + 's.');

    clearTimeout(this.timerReconexao);
    this.timerReconexao = setTimeout(() => {
      this.ligar().catch(e => this.mudar('caiu', e.message));
    }, espera);
  }

  /* Traduz a mensagem do Baileys para a forma que a conversa entende — a
     MESMA que `relay/meta.js` produz. É isto que faz `conversa.js` não precisar
     saber por onde a mensagem chegou. */
  traduzir(msg) {
    if (!msg.message) return null;
    if (msg.key && msg.key.fromMe) return null;

    const de = (msg.key.remoteJid || '').split('@')[0];
    /* Grupo não pede nota fiscal, e responder dentro de um deixaria a conversa
       do escritório exposta a todo mundo do grupo. */
    if ((msg.key.remoteJid || '').includes('@g.us')) return null;

    const m = msg.message;
    let texto = null;
    let tipo = 'desconhecido';

    if (m.conversation) { texto = m.conversation; tipo = 'text'; }
    else if (m.extendedTextMessage) { texto = m.extendedTextMessage.text; tipo = 'text'; }
    else if (m.buttonsResponseMessage) {
      texto = m.buttonsResponseMessage.selectedDisplayText; tipo = 'button';
    }
    else if (m.listResponseMessage) {
      texto = (m.listResponseMessage.title || ''); tipo = 'interactive';
    }
    else if (m.imageMessage) { texto = m.imageMessage.caption || null; tipo = 'image'; }
    else if (m.documentMessage) { texto = m.documentMessage.caption || null; tipo = 'document'; }
    else if (m.audioMessage) { tipo = 'audio'; }
    else if (m.videoMessage) { texto = m.videoMessage.caption || null; tipo = 'video'; }

    return {
      de,
      texto,
      tipo,
      id: msg.key.id,
      nome: msg.pushName || null,
      em: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
    };
  }

  /* ------------------------------------------------------------ o envio */

  exigirConectado() {
    if (this.situacao !== 'conectado' || !this.sock) {
      const e = new Error('O WhatsApp não está conectado (situação: ' + this.situacao + ').');
      e.status = 409;
      throw e;
    }
  }

  /* O JID a partir do número. Aceita com ou sem símbolos: quem digita o número
     de um cliente não deveria precisar saber o que é JID. */
  paraJid(numero) {
    const so = String(numero).replace(/\D/g, '');
    if (!so) {
      const e = new Error('Número vazio.');
      e.status = 400;
      throw e;
    }
    return so + '@s.whatsapp.net';
  }

  async enviarTexto({ para, texto }) {
    this.exigirConectado();
    const r = await this.sock.sendMessage(this.paraJid(para), { text: String(texto) });
    return { id: r.key.id };
  }

  async enviarDocumento({ para, conteudo, nomeArquivo, tipo, legenda }) {
    this.exigirConectado();
    const buffer = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'base64');
    const r = await this.sock.sendMessage(this.paraJid(para), {
      document: buffer,
      mimetype: tipo || 'application/octet-stream',
      fileName: nomeArquivo || 'arquivo',
      caption: legenda || undefined
    });
    return { id: r.key.id };
  }

  async enviarImagem({ para, conteudo, legenda }) {
    this.exigirConectado();
    const buffer = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'base64');
    const r = await this.sock.sendMessage(this.paraJid(para), {
      image: buffer, caption: legenda || undefined
    });
    return { id: r.key.id };
  }

  /* "Digitando..." enquanto o gateway pensa. Não é enfeite: sem isso, a pessoa
     que fez uma pergunta acha que a mensagem não chegou e manda de novo — e
     duas mensagens iguais viram duas conversas na fila. */
  async digitando(para, ligado) {
    if (this.situacao !== 'conectado' || !this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(ligado ? 'composing' : 'paused', this.paraJid(para));
    } catch (_) { /* presença é conveniência: falhar aqui não pode derrubar nada */ }
  }

  async marcarLida(chaveMensagem) {
    if (this.situacao !== 'conectado' || !this.sock) return;
    try { await this.sock.readMessages([chaveMensagem]); } catch (_) {}
  }

  /* Este número existe no WhatsApp? Serve para o escritório saber, ANTES de
     mandar, que o cliente digitou o telefone errado no cadastro. */
  async existe(numero) {
    this.exigirConectado();
    const r = await this.sock.onWhatsApp(this.paraJid(numero));
    return !!(r && r[0] && r[0].exists);
  }

  /* ------------------------------------------------------- fim de sessão */

  apagarSessao() {
    try {
      fs.rmSync(this.pastaSessao, { recursive: true, force: true });
    } catch (e) {
      console.error('[wa] não consegui apagar a sessão:', e.message);
    }
    this.numero = null;
    this.nomePerfil = null;
  }

  async desligar({ apagar = false } = {}) {
    this.parando = true;
    clearTimeout(this.timerReconexao);
    if (this.sock) {
      try {
        if (apagar) await this.sock.logout();
        else this.sock.end(undefined);
      } catch (_) {}
    }
    this.sock = null;
    if (apagar) this.apagarSessao();
    this.mudar('desligado');
  }
}

module.exports = { Motor, ESPERA_INICIAL_MS, ESPERA_MAXIMA_MS };
