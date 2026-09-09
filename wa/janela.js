/* A tela do módulo do WhatsApp.
 *
 * Simples de propósito: quem abre isto quer saber uma coisa — está conectado ou
 * não? — e, quando não está, o que fazer a respeito. Todo o resto é ruído.
 *
 * O token vem no atributo do <body>, injetado pelo servidor. Ele não vai para
 * a URL das chamadas: URL entra no histórico do navegador.
 */
(function () {
  'use strict';

  var TOKEN = document.body.dataset.token;
  var el = function (id) { return document.getElementById(id); };
  var termoVersao = null;

  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    opcoes.headers = Object.assign({ 'X-WA-Token': TOKEN }, opcoes.headers || {});
    return fetch(caminho, opcoes).then(function (r) {
      return r.json().then(function (corpo) {
        if (!r.ok) throw new Error(corpo.erro || ('erro ' + r.status));
        return corpo;
      });
    });
  }

  /* Cada situação diz o que é e o que fazer. Um rótulo sozinho — "caiu" — deixa
     a pessoa sem saber se espera ou se age. */
  var SITUACOES = {
    desligado: {
      selo: 's-neutro', rotulo: 'desligado',
      texto: 'O WhatsApp não está ligado. Clique em "Ligar" para começar.'
    },
    esperando_qr: {
      selo: 's-aviso', rotulo: 'aguardando leitura',
      texto: 'Leia o código abaixo com o celular que vai atender os clientes.'
    },
    conectando: {
      selo: 's-aviso', rotulo: 'conectando',
      texto: 'Conectando ao WhatsApp…'
    },
    conectado: {
      selo: 's-ok', rotulo: 'conectado',
      texto: 'Conectado. As mensagens dos clientes chegam ao gateway por aqui.'
    },
    caiu: {
      selo: 's-aviso', rotulo: 'caiu, tentando de novo',
      texto: 'A conexão caiu. Estou tentando reconectar sozinho, com espera ' +
             'crescente para não insistir demais — insistir rápido demais é o que ' +
             'faz o WhatsApp bloquear um número.'
    },
    banido: {
      selo: 's-erro', rotulo: 'sessão recusada',
      texto: 'O WhatsApp recusou esta sessão e não vou tentar de novo sozinho. ' +
             'Se foi você que desconectou pelo celular, ligue de novo e leia o QR. ' +
             'Se não foi, o número pode ter sido bloqueado — e nesse caso não há ' +
             'a quem recorrer. A emissão de notas pelo painel continua normal.'
    }
  };

  function pintar(e) {
    var s = SITUACOES[e.situacao] || SITUACOES.desligado;
    var selo = el('selo');
    selo.className = 'selo ' + s.selo;
    selo.textContent = s.rotulo;

    el('explicacao').textContent = s.ultimoErro || s.texto;
    if (e.ultimoErro && e.situacao !== 'conectado') {
      el('explicacao').textContent = s.texto + '  (' + e.ultimoErro + ')';
    }

    el('numero').textContent = e.numero
      ? e.numero + (e.nomePerfil ? ' · ' + e.nomePerfil : '') : '';

    var mostrarQr = e.situacao === 'esperando_qr' && e.temQr;
    el('qrCaixa').hidden = !mostrarQr;
    if (mostrarQr) carregarQr();

    var ligado = e.situacao !== 'desligado';
    el('btnLigar').hidden = ligado;
    el('btnDesligar').hidden = !ligado;
    el('btnEsquecer').hidden = !e.numero && e.situacao !== 'banido';

    termoVersao = e.termoVersao;
    pintarMensagens(e.ultimas || []);
  }

  function carregarQr() {
    api('/qr').then(function (r) { el('qrImg').src = r.qr; }).catch(function () {});
  }

  function pintarMensagens(lista) {
    var caixa = el('mensagens');
    if (!lista.length) {
      caixa.innerHTML = '<div class="vazio">Nada ainda.</div>';
      return;
    }
    caixa.innerHTML = lista.map(function (m) {
      var hora = new Date(m.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return '<div class="msg">' +
        '<span class="dir ' + m.direcao + '">' + m.direcao + '</span>' +
        '<span class="num">' + escapar(m.de || '') + '</span>' +
        '<span class="txt">' + escapar(m.texto || '') + '</span>' +
        '<span class="espaco"></span>' +
        '<span class="campo">' + hora + '</span>' +
        '</div>';
    }).join('');
  }

  function escapar(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ------------------------------------------------------------ o termo */

  el('btnLigar').onclick = function () {
    api('/termo').then(function (t) {
      termoVersao = t.versao;
      el('termoResumo').innerHTML = t.resumo.map(function (r) {
        return '<li>' + escapar(r) + '</li>';
      }).join('');
      el('termoTexto').textContent = t.texto;
      el('chkAceite').checked = false;
      el('btnAceitar').disabled = true;
      el('dlgTermo').showModal();
    }).catch(function (e) { alert(e.message); });
  };

  el('chkAceite').onchange = function () {
    el('btnAceitar').disabled = !this.checked;
  };

  el('btnCancelarTermo').onclick = function () { el('dlgTermo').close(); };

  el('btnAceitar').onclick = function () {
    el('btnAceitar').disabled = true;
    api('/ligar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termoVersao: termoVersao })
    }).then(function () {
      el('dlgTermo').close();
      atualizar();
    }).catch(function (e) {
      alert(e.message);
      el('btnAceitar').disabled = false;
    });
  };

  el('btnDesligar').onclick = function () {
    api('/desligar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}' }).then(atualizar).catch(function (e) { alert(e.message); });
  };

  el('btnEsquecer').onclick = function () {
    /* Apagar a sessão é irreversível: é preciso ler o QR de novo. Vale
       perguntar, porque o botão fica ao lado do de desligar. */
    if (!confirm('Isto apaga a sessão desta máquina.\n\n' +
                 'Para voltar a usar, será preciso ler o QR code de novo no celular.\n\n' +
                 'Continuar?')) return;
    api('/desligar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apagarSessao: true }) })
      .then(atualizar).catch(function (e) { alert(e.message); });
  };

  /* ----------------------------------------------------------- o ritmo */

  function atualizar() {
    return api('/situacao').then(pintar).catch(function (e) {
      var selo = el('selo');
      selo.className = 'selo s-erro';
      selo.textContent = 'módulo fora do ar';
      el('explicacao').textContent =
        'Não consigo falar com o módulo (' + e.message + '). ' +
        'Se você fechou a janela preta, abra o WhatsApp.bat de novo.';
    });
  }

  atualizar();
  /* Três segundos: o QR expira e é renovado com frequência, e quem está com o
     celular na mão olhando a tela precisa ver o código novo aparecer. */
  setInterval(atualizar, 3000);
})();
