/* A tela do monitor.
 *
 * Fala com o próprio servidor do monitor, nunca com o gateway — é isso que
 * deixa a tela viva quando o gateway não está. O token veio na URL com que o
 * Monitor.bat abriu o navegador. */
(function () {
  'use strict';

  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var q = function (id) { return document.getElementById(id); };
  var MAX_LINHAS = 500;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hora(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleTimeString('pt-BR', { hour12: false });
  }

  function recado(texto, bom) {
    var r = q('recado');
    r.textContent = texto;
    r.className = 'mostra ' + (bom ? 'bom' : 'ruim');
    clearTimeout(recado.t);
    recado.t = setTimeout(function () { r.className = ''; }, 9000);
  }

  /* ------------------------------------------------------------- as peças */

  var PECAS = {
    gateway: {
      rotulo: 'Gateway',
      no_ar: ['p-ok', 'no ar, emitindo e atendendo'],
      fora:  ['p-erro', 'FORA DO AR — nenhuma nota sai e o WhatsApp não responde']
    },
    tarefa: {
      rotulo: 'Sobe com o Windows',
      rodando: ['p-ok', 'sim'],
      parada: ['p-alerta', 'a tarefa existe, mas está parada'],
      ausente: ['p-erro', 'NÃO — depois de um reinício fica tudo parado'],
      sem_permissao: ['p-neutro', 'não dá para conferir daqui'],
      nao_se_aplica: ['p-neutro', '—']
    },
    servicoBanco: {
      rotulo: 'Banco de dados',
      rodando: ['p-ok', 'no ar'],
      parado: ['p-erro', 'PARADO — o gateway não consegue trabalhar'],
      ausente: ['p-erro', 'não é serviço: não sobe sozinho depois de um reinício'],
      nao_se_aplica: ['p-neutro', '—']
    }
  };

  function desenharPecas(d) {
    var html = '';
    Object.keys(PECAS).forEach(function (chave) {
      var def = PECAS[chave];
      var par = def[d[chave]] || ['p-neutro', d[chave] || '—'];
      html += '<div class="item"><span class="ponto ' + par[0] + '"></span>' +
              '<span class="rot">' + esc(def.rotulo) + '</span>' +
              '<span class="val">' + esc(par[1]) + '</span></div>';
    });
    q('pecas').innerHTML = html;

    var vivo = d.gateway === 'no_ar';
    q('pulso').className = 'pulso ' + (vivo ? 'vivo' : 'morto');
    q('resumo').textContent = vivo
      ? 'tudo funcionando · ' + hora(d.em)
      : 'gateway fora do ar · ' + hora(d.em);

    q('btnIniciar').disabled = vivo;
    q('btnParar').disabled = !vivo;
  }

  var SELO_NOTA = {
    autorizada: 's-ok', emitida: 's-ok', cancelada: 's-neutro',
    processando: 's-alerta', rejeitada: 's-erro', erro: 's-erro'
  };
  var SELO_PEDIDO = {
    emitida: 's-ok', aguardando: 's-alerta', recusada: 's-neutro', erro: 's-erro'
  };

  function nomeEmpresa(l) { return l.nome_fantasia || l.razao_social || '—'; }

  function desenharDados(dados) {
    if (!dados || dados.erro) {
      q('nProcessando').textContent = '?';
      q('nErro').textContent = '?';
      q('tbNotas').innerHTML = '<tr><td>' +
        esc(dados && dados.erro ? 'Sem banco: ' + dados.erro : 'Sem banco.') + '</td></tr>';
      return;
    }

    var p = q('nProcessando');
    p.textContent = dados.processando;
    p.className = 'n' + (dados.processando > 0 ? ' alerta' : '');

    var e = q('nErro');
    e.textContent = dados.comErro;
    e.className = 'n' + (dados.comErro > 0 ? ' erro' : '');

    q('tbNotas').innerHTML = (dados.notas || []).map(function (n) {
      return '<tr><td class="hora">' + esc(hora(n.atualizado_em)) + '</td>' +
        '<td>' + esc(nomeEmpresa(n)) +
        '<div style="color:var(--texto3)">' + esc(n.serie) + '/' + esc(n.numero) +
        (n.ambiente === 'homologacao' ? ' · homologação' : '') + '</div></td>' +
        '<td style="text-align:right"><span class="selo ' +
        (SELO_NOTA[n.status] || 's-neutro') + '">' + esc(n.status) + '</span></td></tr>';
    }).join('') || '<tr><td style="color:var(--texto3)">Nenhuma nota ainda.</td></tr>';

    q('tbPedidos').innerHTML = (dados.pedidos || []).map(function (s) {
      return '<tr><td class="hora">' + esc(hora(s.recebida_em)) + '</td>' +
        '<td>' + esc(nomeEmpresa(s)) +
        '<div style="color:var(--texto3)">' + esc(s.origem || '—') +
        (s.remetente ? ' · ' + esc(s.remetente) : '') + '</div></td>' +
        '<td style="text-align:right"><span class="selo ' +
        (SELO_PEDIDO[s.situacao] || 's-neutro') + '">' + esc(s.situacao) + '</span></td></tr>';
    }).join('') || '<tr><td style="color:var(--texto3)">Nenhum pedido ainda.</td></tr>';
  }

  /* ----------------------------------------------------------------- o log */

  var logEl = q('log');
  var vazio = true;

  function porLinha(linha) {
    /* O formato é "2026-08-31T14:29:56.108Z NIVEL  texto". Só a hora interessa
       na tela: a data é hoje, e o dia inteiro cabe na cabeça de quem olha. */
    var m = linha.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2}:\d{2}:\d{2})[^ ]* (\S+)\s+([\s\S]*)$/);
    var classe = '', h = '', texto = linha;
    if (m) {
      h = m[2];
      texto = m[4];
      if (/ERRO/.test(m[3])) classe = 'erro';
      else if (/AVISO/.test(m[3])) classe = 'aviso';
    }
    var div = document.createElement('div');
    if (classe) div.className = classe;
    div.innerHTML = (h ? '<span class="hora">' + esc(h) + '</span>  ' : '') + esc(texto);
    return div;
  }

  function acrescentar(linhas) {
    if (vazio) { logEl.innerHTML = ''; vazio = false; }
    linhas.forEach(function (l) { logEl.appendChild(porLinha(l)); });
    while (logEl.childElementCount > MAX_LINHAS) logEl.removeChild(logEl.firstChild);
    if (q('seguir').checked) logEl.scrollTop = logEl.scrollHeight;
  }

  q('btnLimpar').onclick = function () {
    logEl.innerHTML = '<div class="vazio">Limpo. O que vier daqui em diante aparece aqui.</div>';
    vazio = true;
  };

  /* --------------------------------------------------------- a ligação */

  var fonte = null;

  function ligar() {
    if (fonte) fonte.close();
    fonte = new EventSource('/eventos?t=' + encodeURIComponent(TOKEN));

    fonte.addEventListener('retrato', function (ev) {
      var d = JSON.parse(ev.data);
      desenharPecas(d);
      desenharDados(d.dados);
    });

    fonte.addEventListener('log', function (ev) { acrescentar(JSON.parse(ev.data)); });

    /* O EventSource reconecta sozinho. O que ele não faz é avisar a pessoa,
       e um monitor mudo é pior que um monitor errado. */
    fonte.onerror = function () {
      q('pulso').className = 'pulso morto';
      q('resumo').textContent = 'perdi a ligação com o monitor — tentando de novo';
    };
  }

  /* ------------------------------------------------------------ as ações */

  function agir(qual, pergunta) {
    if (pergunta && !confirm(pergunta)) return;
    var botoes = [q('btnIniciar'), q('btnReiniciar'), q('btnParar')];
    botoes.forEach(function (b) { b.disabled = true; });

    fetch('/acao/' + qual + '?t=' + encodeURIComponent(TOKEN), { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) {
        recado(r.ok ? r.j.texto : r.j.erro, r.ok);
      })
      .catch(function (e) { recado(e.message, false); })
      .then(function () {
        setTimeout(function () { botoes.forEach(function (b) { b.disabled = false; }); }, 3000);
      });
  }

  q('btnIniciar').onclick = function () { agir('iniciar'); };
  q('btnReiniciar').onclick = function () {
    agir('reiniciar', 'Reiniciar o gateway?\n\n' +
      'Ele sai do ar por alguns segundos. Nota que estiver na fila sai depois.');
  };
  q('btnParar').onclick = function () {
    agir('parar', 'PARAR o gateway?\n\n' +
      'Enquanto estiver parado, nenhuma nota é emitida e o WhatsApp não responde a ninguém.');
  };

  ligar();
})();
