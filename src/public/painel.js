/* Painel do NFS-e Gateway.
   Navegação por hash, sem framework: o sistema é pequeno o bastante para não
   justificar build, e assim o arquivo servido é o mesmo que se lê. */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var $$ = function (sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); };

  var estado = {
    empresas: [], editando: null, notaAtual: null, resumoInicial: null,
    usuario: null, usuarioEditando: null
  };

  /* ------------------------------------------------------------ utilidades */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }
  /* O perfil sai do estado, não de uma variável local de abrirPainel: as
     telas carregam a qualquer momento, e uma delas já tentou ler a local. */
  function souAdmin() { return !!(estado.usuario && estado.usuario.perfil === 'admin'); }
  /* Leitura de dinheiro em formato brasileiro, de valorbr.js. */
  var parseValorBR = window.parseValorBR;
  /* CNPJ aceita letra desde julho/2026 — limpar com /\D/g apagaria o documento. */
  function docLimpo(v) { return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
  function fmtDoc(v) {
    v = docLimpo(v);
    if (v.length === 14) return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    if (v.length === 11) return v.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    return v || '—';
  }
  function fmtMoeda(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  }
  function fmtData(d) { return d ? new Date(d).toLocaleDateString('pt-BR') : '—'; }
  function fmtDataHora(d) { return d ? new Date(d).toLocaleString('pt-BR') : '—'; }

  /* Alterna entre a tabela e a mensagem de lista vazia. Esconde a tabela junto,
     senão sobra um cabeçalho de colunas sem nada embaixo. */
  function alternarVazio(corpoId, vazioId, quantidade) {
    var corpo = el(corpoId);
    var area = corpo.closest('.tabela-area');
    if (area) area.hidden = quantidade === 0;
    el(vazioId).hidden = quantidade > 0;
  }

  function aviso(texto, tipo) {
    var a = el('aviso');
    a.textContent = texto;
    a.className = 'aviso ' + (tipo || 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tipo !== 'erro') setTimeout(function () { a.className = 'aviso'; }, 4500);
  }

  /* A Sefin devolve os problemas em `erros[]`, não em `erro` — sem tratar isso o
     operador só veria "Erro HTTP 422" e não saberia o que corrigir. */
  function mensagemErro(dados, status) {
    if (!dados) return 'Erro HTTP ' + status;
    if (dados.erro || dados.detalhe) return dados.erro || dados.detalhe;
    var sefin = dados.retornoSefin || dados;
    if (Array.isArray(sefin.erros) && sefin.erros.length) {
      /* A Sefin devolve Codigo/Descricao/Complemento em maiúsculas; outros
         retornos usam minúsculas. Procurar só uma das formas fazia a caixa de
         erro aparecer vazia — o operador via "rejeitada" sem saber por quê. */
      return sefin.erros.map(function (e) {
        var codigo = e.Codigo || e.codigo;
        var descricao = e.Descricao || e.descricao || e.Mensagem || e.mensagem;
        var complemento = e.Complemento || e.complemento;
        return (codigo ? codigo + ': ' : '') + (descricao || 'erro sem descrição') +
               (complemento ? ' — ' + complemento : '');
      }).join(' | ');
    }
    return sefin.mensagem || sefin.motivo || sefin.Mensagem ||
           ('A Sefin recusou a nota sem detalhar o motivo (HTTP ' + status + ')');
  }

  /* A credencial vai no cookie de sessão, que o navegador envia sozinho — nada
     de chave em sessionStorage ao alcance de qualquer script da página. */
  function api(caminho, opcoes) {
    opcoes = opcoes || {};

    /* Sem content-type, o express.json() ignora o corpo e a rota recebe {} —
       uma requisição que parece ter dado certo (200) e gravou vazio. Foi assim
       que os padrões fiscais de uma empresa foram apagados: a tela mostrava os
       valores, o PUT levava os valores, e o servidor gravou nulos.
       Definido aqui, e não em cada chamador, porque esquecer é silencioso. */
    var headers = {};
    Object.keys(opcoes.headers || {}).forEach(function (h) {
      headers[h] = opcoes.headers[h];
    });
    if (opcoes.body && typeof opcoes.body === 'string' &&
        !Object.keys(headers).some(function (h) { return h.toLowerCase() === 'content-type'; })) {
      headers['content-type'] = 'application/json';
    }

    return fetch(caminho, {
      method: opcoes.method || 'GET',
      headers: headers,
      body: opcoes.body,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (t) {
        var dados = null;
        try { dados = t ? JSON.parse(t) : null; } catch (e) { dados = { erro: t }; }
        if (res.status === 401 && !/^\/auth\//.test(caminho)) {
          mostrarTelaAcesso();
          throw new Error('Sua sessão expirou. Entre novamente.');
        }
        if (!res.ok) throw new Error(mensagemErro(dados, res.status));
        return dados;
      });
    });
  }

  var NOME_AMBIENTE = { homologacao: 'homologação', producao: 'produção' };
  function nomeAmbiente(a) { return NOME_AMBIENTE[a] || a; }

  var SELO_STATUS = {
    autorizada:'s-ok', processando:'s-alerta', rejeitada:'s-erro',
    erro:'s-erro', cancelada:'s-neutro', substituida:'s-neutro', encerrada:'s-neutro'
  };
  function seloStatus(s) {
    return '<span class="selo-status ' + (SELO_STATUS[s] || 's-neutro') + '">' + esc(s) + '</span>';
  }
  function seloAmbiente(a) {
    return a === 'producao'
      ? '<span class="selo-status s-erro sem-ponto">produção</span>'
      : '<span class="selo-status s-info sem-ponto">homologação</span>';
  }
  function seloCertificado(validoAte) {
    if (!validoAte) return '<span class="selo-status s-neutro sem-ponto">sem certificado</span>';
    var dias = Math.floor((new Date(validoAte) - new Date()) / 86400000);
    if (dias < 0)  return '<span class="selo-status s-erro">vencido</span>';
    if (dias <= 30) return '<span class="selo-status s-alerta">vence em ' + dias + 'd</span>';
    return '<span class="selo-status s-ok">até ' + fmtData(validoAte) + '</span>';
  }

  /* --------------------------------------------------------------- acesso */

  function erroAcesso(mensagem) {
    var box = el('erroAcesso');
    box.textContent = mensagem;
    box.className = mensagem ? 'aviso erro' : 'aviso';
  }

  /* Decide entre "entrar" e "criar primeiro acesso". */
  function mostrarTelaAcesso() {
    el('app').hidden = true;
    el('telaAcesso').hidden = false;
    fetch('/auth/estado').then(function (r) { return r.json(); }).then(function (d) {
      if (d.bancoIndisponivel) {
        el('formAcesso').hidden = true;
        el('formPrimeiro').hidden = true;
        erroAcesso('O gateway está no ar, mas não conseguiu falar com o banco de dados. ' +
          'Verifique a conexão com a internet e se o banco está ativo. Detalhe: ' + (d.detalhe || '—'));
        return;
      }
      el('formAcesso').hidden = !d.temUsuarios;
      el('formPrimeiro').hidden = !!d.temUsuarios;
      el((d.temUsuarios ? 'acEmail' : 'pNome')).focus();
    }).catch(function () {
      // Sem resposta do gateway, o login normal é o palpite mais útil
      el('formAcesso').hidden = false;
    });
  }

  /* Entrou: monta a interface conforme o perfil e o escopo do usuário. */
  function abrirPainel(usuario) {
    estado.usuario = usuario;
    var ehAdmin = souAdmin();

    el('btnMinhaConta').textContent = usuario.nome;
    el('btnMinhaConta').title = usuario.email + ' · trocar minha senha';

    // Telas de configuração só existem para administrador. Escondê-las evita
    // que o operador esbarre em um 403 sem entender o motivo.
    $$('[data-admin]').forEach(function (n) { n.hidden = !ehAdmin; });

    el('telaAcesso').hidden = true;
    el('app').hidden = false;
    erroAcesso('');

    api('/painel/resumo').then(function (resumo) {
      estado.resumoInicial = resumo;
      el('rodapeAmbiente').textContent = 'versão ' + resumo.versao;
      navegar(location.hash.replace('#','') || 'inicio');
    }).catch(function (e) { aviso(e.message, 'erro'); });

    // Carrega uma vez: os filtros e seletores de várias telas dependem disso
    api('/empresas').then(function (l) {
      estado.empresas = l || []; preencherSelectsEmpresa();
    }).catch(function () {});

    // Senha definida por outra pessoa: trocar antes de operar.
    if (usuario.trocarSenha) abrirTrocaObrigatoria();
  }

  /* Troca obrigatória: o diálogo não fecha por ESC nem por clique fora.
     Antes fechava — e como a marcação no banco continuava, ele voltava a cada
     carga da página. Ou a troca é obrigatória de verdade, ou não é. */
  function abrirTrocaObrigatoria() {
    el('trocaMotivo').textContent =
      'Sua senha foi definida por um administrador. Escolha uma que só você conheça ' +
      'para continuar.';
    el('tsCancelar').hidden = true;
    el('formTrocarSenha').reset();

    var dlg = el('dlgTrocarSenha');
    dlg.addEventListener('cancel', impedirFechamento);
    dlg.showModal();
    el('tsAtual').focus();
  }

  function impedirFechamento(ev) {
    ev.preventDefault();
    aviso('Escolha uma senha para continuar. Ela substitui a que foi definida por outra pessoa.', 'info');
  }

  function liberarFechamento() {
    el('dlgTrocarSenha').removeEventListener('cancel', impedirFechamento);
  }

  function sair() {
    fetch('/auth/logout', { method: 'POST' }).then(function () {
      estado.usuario = null;
      estado.empresas = [];
      el('acSenha').value = '';
      mostrarTelaAcesso();
    });
  }

  el('formAcesso').onsubmit = function (ev) {
    ev.preventDefault();
    erroAcesso('');
    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api('/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: el('acEmail').value.trim(), senha: el('acSenha').value })
    }).then(function (r) { abrirPainel(r.usuario); })
      .catch(function (e) { erroAcesso(e.message); })
      .then(function () { botao.disabled = false; });
  };

  el('formPrimeiro').onsubmit = function (ev) {
    ev.preventDefault();
    erroAcesso('');
    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api('/auth/primeiro-acesso', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        nome: el('pNome').value.trim(),
        email: el('pEmail').value.trim(),
        senha: el('pSenha').value,
        chaveInstalacao: el('pChave').value
      })
    }).then(function (r) {
      abrirPainel(r.usuario);
      aviso('Acesso criado. Você é o administrador do gateway.');
    }).catch(function (e) { erroAcesso(e.message); })
      .then(function () { botao.disabled = false; });
  };

  el('btnSair').onclick = sair;

  /* ---------------------------------------------------------- minha conta */

  el('btnMinhaConta').onclick = function () {
    // Troca voluntária: dá para desistir
    liberarFechamento();
    el('trocaMotivo').textContent = 'Escolha uma senha que só você conheça.';
    el('tsCancelar').hidden = false;
    el('formTrocarSenha').reset();
    el('dlgTrocarSenha').showModal();
    el('tsAtual').focus();
  };
  el('tsCancelar').onclick = function () { liberarFechamento(); el('dlgTrocarSenha').close(); };
  el('formTrocarSenha').onsubmit = function (ev) {
    ev.preventDefault();
    if (el('tsNova').value !== el('tsConfirma').value) {
      return aviso('As duas senhas novas não são iguais.', 'erro');
    }
    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api('/usuarios/eu/senha', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ senhaAtual: el('tsAtual').value, senhaNova: el('tsNova').value })
    }).then(function () {
      liberarFechamento();
      el('dlgTrocarSenha').close();
      if (estado.usuario) estado.usuario.trocarSenha = false;
      aviso('Senha alterada. As demais sessões abertas foram encerradas.');
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { botao.disabled = false; });
  };

  /* ------------------------------------------------------------ navegação */

  var TELAS = {
    inicio:      { titulo:'Início',        sub:'Visão geral do sistema',                carregar: function () { carregarInicio(); carregarAtualizacao(); } },
    empresas:    { titulo:'Empresas',      sub:'Cadastro, certificados e numeração',    carregar: carregarEmpresas },
    empresaEdit: { titulo:'Empresa',       sub:'',                                       carregar: null },
    notas:       { titulo:'Notas emitidas',sub:'Consulta, XML, PDF e cancelamento',     carregar: carregarNotas },
    lotes:       { titulo:'Emissão em lote', sub:'Muitas notas a partir de uma planilha', carregar: carregarLotes },
    relatorios:  { titulo:'Relatórios',    sub:'Fechamento do período e livro de notas', carregar: prepararRelatorios },
    clientes:    { titulo:'Clientes',      sub:'Tomadores usados nas emissões',         carregar: carregarClientes },
    servicos:    { titulo:'Serviços',      sub:'Modelos para emitir mais rápido',       carregar: carregarServicos },
    usuarios:    { titulo:'Usuários',      sub:'Quem acessa o gateway e o que pode fazer', carregar: carregarUsuarios },
    agenda:      { titulo:'Agenda do escritório', sub:'Obrigações e prazos dos clientes', carregar: function () { carregarAgenda(); carregarModelos(); } },
    email:       { titulo:'E-mail e avisos', sub:'Envio de notas e resumo de prazos', carregar: carregarEmail },
    identidade:  { titulo:'Identidade visual', sub:'A marca do escritório no painel e nos relatórios', carregar: carregarIdentidade },
    manutencao:  { titulo:'Backup e migração', sub:'Cópia de segurança e mudança de computador', carregar: function () { carregarManutencao(); carregarAtualizacao(); carregarCopias(); } },
    rede:        { titulo:'Rede e conexão', sub:'As saídas do gateway e a emissão sem internet', carregar: carregarRede },
    sistema:     { titulo:'O gateway no ar', sub:'Início automático, banco de dados e manutenção', carregar: carregarSistema },
    municipios:  { titulo:'Municípios',    sub:'Nacional ou emissor próprio',           carregar: carregarMunicipios },
    webhooks:    { titulo:'Webhooks',      sub:'Retorno automático ao sistema cliente', carregar: carregarWebhooks },
    portal:      { titulo:'Portal do cliente', sub:'Pedidos de nota que chegam pelo site', carregar: carregarPonte }
  };

  function navegar(tela) {
    if (!TELAS[tela]) tela = 'inicio';
    $$('[data-tela-conteudo]').forEach(function (s) {
      s.hidden = s.dataset.telaConteudo !== tela;
    });
    $$('.menu a[data-tela]').forEach(function (a) {
      // "empresaEdit" mantém "Empresas" destacado no menu
      var alvo = tela === 'empresaEdit' ? 'empresas' : tela;
      a.classList.toggle('ativo', a.dataset.tela === alvo);
    });
    el('tituloTela').textContent = TELAS[tela].titulo;
    el('subtituloTela').textContent = TELAS[tela].sub;
    el('sidebar').classList.remove('aberta');
    if (TELAS[tela].carregar) TELAS[tela].carregar();
  }


  /* --------------------------------------------------- portal do cliente */

  /* A tela tem dois donos. A configuração é do administrador: endereço, chave
     e o modo de emissão, que valem para o escritório inteiro. A fila é de quem
     opera — e cada um só enxerga as solicitações das empresas às quais está
     vinculado, porque a rota filtra pelo escopo antes de responder. */

  var SITUACAO = {
    aguardando: ['s-alerta', 'Esperando aprovação'],
    aprovada:   ['s-info',   'Aprovada, emitindo'],
    emitida:    ['s-ok',     'Emitida'],
    recusada:   ['s-neutro', 'Recusada'],
    erro:       ['s-erro',   'Com erro']
  };

  function valorDaSolicitacao(p) {
    var v = p && p.valores;
    if (!v) return null;
    return v.valorServico != null ? v.valorServico : v.vServ;
  }

  function nomeDoTomador(p) {
    var t = p && p.tomador;
    if (!t) return '—';
    return t.razaoSocial || t.nome || t.cnpj || t.cpf || '—';
  }

  function carregarPonte() {
    if (souAdmin()) {
      api('/ponte/config').then(function (c) {
        el('ptUrl').value = c.url || '';
        el('ptIntervalo').value = String(c.intervalo_seg || 60);
        el('ptLote').value = c.lote || 10;
        el('ptAtivo').checked = !!c.ativo;
        el('ptAuto').checked = !!c.emitir_automatico;
        el('ptChave').value = '';
        el('ptUltimo').value = c.ultimo_contato ? fmtDataHora(c.ultimo_contato) : 'nunca';
        el('ptChaveEstado').textContent = c.tem_chave
          ? 'Uma chave já está guardada. Deixe em branco para mantê-la.'
          : 'Nenhuma chave guardada.';

        var selo = el('ptEstado');
        if (!c.ativo) { selo.className = 'selo-status s-neutro'; selo.textContent = 'Desligada'; }
        else if (c.ultimo_erro) { selo.className = 'selo-status s-erro'; selo.textContent = 'Com erro'; }
        else if (c.ultimo_contato) { selo.className = 'selo-status s-ok'; selo.textContent = 'Ligada'; }
        else { selo.className = 'selo-status s-alerta'; selo.textContent = 'Sem contato ainda'; }

        el('ptResultado').textContent = c.ultimo_erro
          ? 'Última falha em ' + fmtDataHora(c.erro_em) + ': ' + c.ultimo_erro : '';

        preencherCanal(c);
        preencherRepassador(c);
        conferirWhatsapp();
        el('ptCadastroEstado').textContent = c.cadastro_erro
          ? 'Último envio falhou: ' + c.cadastro_erro
          : c.cadastro_em ? 'Enviado em ' + fmtDataHora(c.cadastro_em) + '.'
          : 'Nunca enviado.';
      }).catch(function (e) { aviso(e.message, 'erro'); });
    }
    listarSolicitacoes();
  }

  function listarSolicitacoes() {
    var f = el('ptFiltro').value;
    return api('/ponte/solicitacoes' + (f ? '?situacao=' + f : '')).then(function (lista) {
      el('ptVazio').hidden = lista.length > 0;
      el('ptLista').innerHTML = lista.map(function (s) {
        var sit = SITUACAO[s.situacao] || ['s-neutro', s.situacao];
        var v = valorDaSolicitacao(s.payload);
        var acoes = '';
        if (s.situacao === 'aguardando' || s.situacao === 'erro') {
          acoes = '<button class="pequeno primario" data-aprovar="' + s.id + '">' +
                  (s.situacao === 'erro' ? 'Tentar de novo' : 'Aprovar e emitir') + '</button> ' +
                  '<button class="pequeno" data-recusar="' + s.id + '">Recusar</button>';
        } else if (s.chave_acesso) {
          acoes = '<a class="botao pequeno" href="#notas" data-tela="notas">Ver nota</a>';
        }
        /* A conversa fica ao alcance de um clique em toda linha: na hora de
           conferir um pedido estranho, é ela que responde o que aconteceu. */
        if (s.transcricao && s.transcricao.length) {
          acoes += ' <button class="pequeno" data-conversa="' + s.id + '">Ver conversa</button>';
        }
        var empresa = s.razao_social
          ? esc(s.razao_social)
          : '<span class="s-erro">CNPJ ' + esc(s.cnpj_informado || '?') + ' não cadastrado</span>';
        /* De onde veio o pedido importa na hora de aprovar: no WhatsApp a
           identidade é o número, e o contador precisa saber disso. */
        var origem = s.origem === 'whatsapp'
          ? '<div class="ajuda">WhatsApp ' + esc(fmtTelefone(s.remetente)) + '</div>'
          : (s.origem && s.origem !== 'portal'
              ? '<div class="ajuda">' + esc(s.origem) + '</div>' : '');
        return '<tr>' +
          '<td>' + fmtDataHora(s.recebida_em) + '</td>' +
          '<td>' + empresa + origem + '</td>' +
          '<td>' + esc(nomeDoTomador(s.payload)) + '</td>' +
          '<td>' + (v != null ? fmtMoeda(v) : '—') + '</td>' +
          '<td><span class="selo-status ' + sit[0] + '">' + sit[1] + '</span>' +
              (s.motivo ? '<div class="ajuda">' + esc(s.motivo) + '</div>' : '') +
              (s.serie ? '<div class="ajuda mono">' + esc(s.serie) + '/' + esc(String(s.numero)) + '</div>' : '') +
          '</td>' +
          '<td>' + acoes + '</td>' +
        '</tr>';
      }).join('');
      atualizarSeloFila();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  /* O número no menu existe para o pedido não ficar esperando sem ninguém
     saber. Sem ele, a fila só apareceria para quem abrisse a tela. */
  function atualizarSeloFila() {
    return api('/ponte/solicitacoes?situacao=aguardando&limite=200').then(function (l) {
      var selo = el('seloFila');
      selo.hidden = l.length === 0;
      selo.textContent = l.length;
    }).catch(function () { /* menu não é lugar de mostrar erro de rede */ });
  }

  el('ptFiltro').onchange = listarSolicitacoes;
  el('btnRecarregarPonte').onclick = listarSolicitacoes;

  el('ptLista').onclick = function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.aprovar) aprovarSolicitacao(b.dataset.aprovar, b);
    if (b.dataset.recusar) recusarSolicitacao(b.dataset.recusar);
    if (b.dataset.conversa) verTranscricao(b.dataset.conversa);
  };

  function aprovarSolicitacao(id, botao) {
    if (!confirm('Emitir a nota desta solicitação?\n\n' +
                 'A nota vai para a Sefin com valor fiscal. Confira empresa, ' +
                 'tomador e valor antes de continuar.')) return;
    botao.disabled = true;
    api('/ponte/solicitacoes/' + id + '/aprovar', { method: 'POST' })
      .then(function () { aviso('Solicitação aprovada; a nota entrou na fila.', 'ok'); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(listarSolicitacoes);
  }

  function recusarSolicitacao(id) {
    var motivo = prompt('Por que está recusando?\n\nO motivo volta para o cliente no portal.');
    if (!motivo) return;
    api('/ponte/solicitacoes/' + id + '/recusar',
        { method: 'POST', body: JSON.stringify({ motivo: motivo }) })
      .then(function () { aviso('Solicitação recusada.', 'ok'); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(listarSolicitacoes);
  }

  el('btnSalvarPonte').onclick = function () {
    var b = el('btnSalvarPonte');
    b.disabled = true;
    api('/ponte/config', { method: 'PUT', body: JSON.stringify({
      url: el('ptUrl').value,
      intervaloSeg: Number(el('ptIntervalo').value),
      lote: Number(el('ptLote').value),
      ativo: el('ptAtivo').checked,
      emitirAutomatico: el('ptAuto').checked,
      // Vazio mantém a chave guardada, não apaga
      chave: el('ptChave').value || undefined
    }) })
      .then(function () { aviso('Ligação salva.', 'ok'); carregarPonte(); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  el('btnTestarPonte').onclick = function () {
    var b = el('btnTestarPonte');
    b.disabled = true;
    el('ptResultado').textContent = 'Procurando…';
    api('/ponte/sincronizar', { method: 'POST' })
      .then(function (r) {
        el('ptResultado').textContent = r.pulado
          ? 'Nada feito: ' + r.pulado
          : 'Trouxe ' + r.recebidas + ' (' + r.novas + ' nova(s)), emitiu ' +
            r.emitidas + ', devolveu ' + r.devolvidas + ' — modo ' + r.modo + '.';
        carregarPonte();
      })
      .catch(function (e) { el('ptResultado').textContent = e.message; })
      .then(function () { b.disabled = false; });
  };


  /* ------------------------------------------- portal, na ficha da empresa */

  /* Salvo por rota própria, e não junto com o "Salvar empresa": liberar o
     portal muda o que o cliente consegue fazer lá fora, e isso não devia sair
     de carona num salvamento de cadastro. */

  function preencherPortalEmpresa(e) {
    el('empModoEmissao').value = e.modo_emissao || 'gateway';
    el('empPortalLiberado').checked = !!e.portal_liberado;
    el('empWhatsappDireto').checked = !!e.whatsapp_direto;
    atualizarAvisoDireto();
    el('empPortalMotivo').value = e.portal_liberado ? '' : (e.portal_motivo || '');
    el('empModoAjuda').textContent = (e.modo_emissao === 'portal')
      ? 'O certificado e a numeração desta empresa ficam no portal.'
      : 'O certificado e a numeração ficam nesta máquina. O cliente solicita; o escritório emite.';
    el('empPortalEstado').textContent = e.portal_decidido_em
      ? (e.portal_liberado ? 'Liberado' : 'Bloqueado') + ' em ' +
        fmtDataHora(e.portal_decidido_em) + ' por ' + (e.portal_decidido_por || '—')
      : '';
    atualizarMotivoPortal();
  }

  function atualizarMotivoPortal() {
    var liberado = el('empPortalLiberado').checked;
    el('empPortalMotivo').disabled = liberado;
    if (liberado) el('empPortalMotivo').value = '';
  }
  el('empPortalLiberado').onchange = function () {
    atualizarMotivoPortal();
    atualizarAvisoDireto();
  };
  el('empWhatsappDireto').onchange = atualizarAvisoDireto;

  /* A emissão direta só vale para WhatsApp, e só com o portal liberado. Dizer
     isso na hora evita a pergunta "liguei e não emitiu sozinho". */
  function atualizarAvisoDireto() {
    var direto = el('empWhatsappDireto').checked;
    var liberado = el('empPortalLiberado').checked;
    var aviso = el('empDiretoAjuda');
    if (direto && !liberado) {
      aviso.textContent = 'Sem o portal liberado acima, nada chega a ser emitido.';
      aviso.style.color = 'var(--alerta)';
    } else if (direto) {
      aviso.textContent = 'Pedido de WhatsApp de número autorizado vira nota na hora. ' +
        'Acima do teto do número, ainda espera aprovação. Pedido pelo portal nunca ' +
        'emite direto — quem autenticou a pessoa foi o site, não este sistema.';
      aviso.style.color = '';
    } else {
      aviso.textContent = 'Todo pedido espera alguém do escritório aprovar.';
      aviso.style.color = '';
    }
  }

  el('btnSalvarPortalEmp').onclick = function () {
    if (!estado.editando) return;
    var b = el('btnSalvarPortalEmp');
    b.disabled = true;
    api('/empresas/' + estado.editando + '/portal', {
      method: 'PUT',
      body: JSON.stringify({
        modoEmissao: el('empModoEmissao').value,
        liberado: el('empPortalLiberado').checked,
        whatsappDireto: el('empWhatsappDireto').checked,
        motivo: el('empPortalMotivo').value || undefined
      })
    })
      .then(function (e) {
        preencherPortalEmpresa(e);
        aviso(e.portal_liberado
          ? 'Portal liberado para esta empresa.'
          : 'Portal bloqueado; o cliente vê o motivo.', 'ok');
      })
      .catch(function (err) { aviso(err.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };


  /* --------------------------------------------- cópia fora da máquina */

  /* O selo e o aviso existem para a falha aparecer. Um backup que falha em
     silêncio é pior do que não ter backup: dá segurança falsa, e a conta só
     chega no dia da restauração. */

  function carregarCopias() {
    return api('/manutencao/copias').then(function (d) {
      var selo = el('cpSelo');
      selo.className = 'selo-status ' +
        (d.nivel === 'ok' ? 's-ok' : d.nivel === 'alerta' ? 's-alerta' : 's-erro');
      selo.textContent = d.nivel === 'ok' ? 'Protegido'
        : d.nivel === 'alerta' ? 'Cópia atrasada' : 'Sem cópia externa';

      var av = el('cpAviso');
      av.className = 'aviso ' + (d.nivel === 'ok' ? 'ok' : d.nivel === 'alerta' ? 'info' : 'erro');
      av.textContent = d.texto;

      el('cpVazio').hidden = d.destinos.length > 0;
      el('cpLista').innerHTML = d.destinos.map(function (x) {
        var estado = x.ultimo_erro
          ? '<span class="selo-status s-erro">falhou</span>' +
            '<div class="ajuda">' + esc(x.ultimo_erro) + '</div>'
          : x.ultimo_ok
            ? '<span class="selo-status s-ok">' + fmtDataHora(x.ultimo_ok) + '</span>' +
              (x.ultimo_arquivo ? '<div class="ajuda mono">' + esc(x.ultimo_arquivo) + '</div>' : '')
            : '<span class="selo-status s-neutro">nunca</span>';
        return '<tr>' +
          '<td><span class="mono">' + esc(x.caminho) + '</span>' +
            (x.mesmo_disco
              ? '<div class="ajuda" style="color:var(--erro)">mesmo disco do banco — não protege contra o disco morrer</div>'
              : '') +
            (x.ativo ? '' : '<div class="ajuda">desligado</div>') + '</td>' +
          '<td>' + x.manter + '</td>' +
          '<td>' + estado + '</td>' +
          '<td><button class="pequeno" data-copiar-destino="' + x.id + '">Copiar</button> ' +
              '<button class="pequeno perigo" data-remover-destino="' + x.id + '">Remover</button></td>' +
        '</tr>';
      }).join('');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('cpLista').onclick = function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.removerDestino) {
      if (!confirm('Remover este destino? As cópias já gravadas lá continuam onde estão.')) return;
      api('/manutencao/copias/' + b.dataset.removerDestino, { method: 'DELETE' })
        .then(function () { aviso('Destino removido.', 'ok'); carregarCopias(); })
        .catch(function (e) { aviso(e.message, 'erro'); });
    }
    if (b.dataset.copiarDestino) copiarBackup(Number(b.dataset.copiarDestino), b);
  };

  el('btnAddDestino').onclick = function () {
    var b = el('btnAddDestino');
    b.disabled = true;
    api('/manutencao/copias', { method: 'POST', body: JSON.stringify({
      caminho: el('cpCaminho').value,
      manter: Number(el('cpManter').value)
    }) })
      .then(function () {
        el('cpCaminho').value = '';
        aviso('Destino cadastrado e testado.', 'ok');
        carregarCopias();
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  function copiarBackup(id, botao) {
    var b = botao || el('btnCopiarAgora');
    b.disabled = true;
    el('cpResultado').textContent = 'Copiando…';
    api('/manutencao/copias/copiar', { method: 'POST', body: JSON.stringify(id ? { id: id } : {}) })
      .then(function (r) {
        var bons = r.destinos.filter(function (d) { return d.ok; }).length;
        el('cpResultado').textContent = r.destinos.length
          ? bons + ' de ' + r.destinos.length + ' destino(s) receberam ' +
            r.arquivo + ' (' + r.registros + ' registros, conferidos no destino).'
          : 'Nenhum destino ativo para copiar.';
        carregarCopias();
      })
      .catch(function (e) { el('cpResultado').textContent = e.message; })
      .then(function () { b.disabled = false; });
  }

  el('btnCopiarAgora').onclick = function () { copiarBackup(null, null); };


  /* ------------------------------------------- réplica e perfil de cliente */

  /* O formulário muda de significado conforme o perfil. Uma pessoa do cliente
     não entra no painel — então não tem senha aqui — e o vínculo com empresa
     deixa de ser opcional: sem ele, ela enxergaria a vida fiscal de todos os
     clientes do escritório, num sistema que fica na internet. */
  function ajustarFormularioPorPerfil() {
    var ehCliente = el('u_perfil').value === 'cliente';
    el('u_blocoSenha').hidden = ehCliente;
    el('u_blocoCargo').hidden = !ehCliente;
    el('u_perfilAjuda').textContent = ehCliente
      ? 'Acessa o portal do cliente, nunca este painel. A senha é definida por ela mesma, lá.'
      : '';
    el('u_empresasAjuda').textContent = ehCliente
      ? 'Obrigatório marcar ao menos uma — e ela verá só o que estiver marcado.'
      : 'Sem nenhuma marcada, o usuário enxerga todas as empresas.';
    el('u_empresasAjuda').style.color = ehCliente ? 'var(--alerta)' : '';
  }
  el('u_perfil').onchange = ajustarFormularioPorPerfil;

  el('btnEnviarCadastro').onclick = function () {
    var b = el('btnEnviarCadastro');
    b.disabled = true;
    el('ptCadastroEstado').textContent = 'Enviando…';
    api('/ponte/cadastro', { method: 'POST' })
      .then(function (r) {
        el('ptCadastroEstado').textContent = r.pulado
          ? r.pulado
          : r.empresas + ' empresa(s), ' + r.servicos + ' serviço(s) e ' +
            r.acessos + ' acesso(s) enviados.';
      })
      .catch(function (e) { el('ptCadastroEstado').textContent = e.message; })
      .then(function () { b.disabled = false; });
  };


  /* ------------------------------------------------------- rede e conexão */

  /* A pergunta que sempre volta é "que porta eu abro no roteador?". A resposta
     é nenhuma, e ela precisa estar na tela — não só na documentação. O que esta
     tela faz é o contrário de configurar exposição: confere se as duas saídas
     funcionam e mostra onde parou quando não funcionam. */

  function carregarRede() {
    return api('/manutencao/rede').then(function (d) {
      var falhou = d.saidas.filter(function (s) { return s.alcancavel === false; });
      var selo = el('rdSelo');
      selo.className = 'selo-status ' + (falhou.length ? 's-erro' : 's-ok');
      selo.textContent = falhou.length ? 'Sem saída' : 'Saídas funcionando';

      el('rdSaidas').innerHTML = d.saidas.map(function (s) {
        var estado = s.alcancavel === null
          ? '<span class="selo-status s-neutro">não configurado</span>'
          : s.alcancavel
            ? '<span class="selo-status s-ok">' + s.ms + ' ms</span>'
            : '<span class="selo-status s-erro">não respondeu</span>';
        return '<tr><td>' + esc(s.nome) + '</td>' +
          '<td><span class="mono">' + esc(s.endereco || '—') + '</span></td>' +
          '<td>' + estado + '<div class="ajuda">' + esc(s.detalhe) + '</div></td></tr>';
      }).join('');

      el('rdPorta').textContent = d.rede.porta;
      el('rdHost').textContent = d.rede.aceitaRedeLocal
        ? 'Sim — outras máquinas do escritório conseguem abrir'
        : 'Não — só este computador (HOST=' + d.rede.host + ')';

      el('rdEnderecos').innerHTML = d.rede.enderecos.length
        ? d.rede.enderecos.map(function (e) {
            return '<div style="margin-bottom:6px">' +
              '<span class="mono">' + esc(e.url) + '</span> ' +
              '<span class="ajuda">(' + esc(e.interface) + ')</span></div>';
          }).join('')
        : '<div class="ajuda">Nenhum endereço de rede encontrado — a máquina pode estar sem rede.</div>';

      var f = d.fila;
      var fs = el('rdFilaSelo');
      fs.className = 'selo-status ' +
        (f.esperandoConexao ? (f.alerta ? 's-erro' : 's-alerta') : 's-ok');
      fs.textContent = f.esperandoConexao
        ? f.esperandoConexao + ' esperando' : 'Nada parado';

      var av = el('rdFilaAviso');
      if (f.alerta) { av.className = 'aviso erro'; av.textContent = f.alerta; }
      else if (f.esperandoConexao) {
        av.className = 'aviso info';
        av.textContent = 'A linha caiu e as notas estão prontas e assinadas, ' +
          'esperando. Elas saem sozinhas quando a conexão voltar — não é preciso ' +
          'emitir de novo, e o número não se perde.';
      } else { av.className = 'aviso'; av.textContent = ''; }

      el('rdEsperando').textContent = f.esperandoConexao;
      el('rdNaFila').textContent = f.naFila;
      el('rdMaisAntiga').textContent = f.maisAntiga
        ? fmtDataHora(f.maisAntiga) + ' (há ' + f.horasEsperando + ' h)' : '—';
      el('rdUltimoErro').textContent = f.ultimoErro ? 'Último erro: ' + f.ultimoErro : '';
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnTestarRede').onclick = function () {
    var b = el('btnTestarRede');
    b.disabled = true;
    el('rdTestado').textContent = 'Testando…';
    carregarRede().then(function () {
      el('rdTestado').textContent = 'Testado em ' + fmtDataHora(new Date());
    }).then(function () { b.disabled = false; });
  };


  /* ------------------------------------------------- WhatsApp por empresa */

  /* O gateway não fala com o WhatsApp: a API da Meta entrega por webhook, num
     endereço público, e esta máquina não recebe conexão de fora. O que se
     cadastra aqui é só quem pode pedir por qual CNPJ — a mensagem chega pela
     mesma fila do portal, com a origem marcada. */

  function carregarWhatsapp() {
    if (!estado.editando) return Promise.resolve();
    return api('/empresas/' + estado.editando + '/whatsapp').then(mostrarWhatsapp)
      .catch(function (e) { aviso(e.message, 'erro'); });
  }

  function mostrarWhatsapp(lista) {
    el('waVazio').hidden = lista.length > 0;
    el('waLista').innerHTML = lista.map(function (c) {
      return '<tr>' +
        '<td><span class="mono">' + esc(fmtTelefone(c.telefone)) + '</span></td>' +
        '<td>' + esc(c.nome || '—') +
          (c.cargo ? '<div class="ajuda">' + esc(c.cargo) + '</div>' : '') + '</td>' +
        '<td>' + (c.limite_valor == null ? 'sem teto' : fmtMoeda(c.limite_valor)) + '</td>' +
        '<td>' + (c.ultimo_uso ? fmtDataHora(c.ultimo_uso) : 'nunca') + '</td>' +
        '<td><button class="pequeno perigo" data-remover-wa="' + c.id + '">Remover</button></td>' +
      '</tr>';
    }).join('');
  }

  /* 5541999998888 é ilegível para quem confere. */
  function fmtTelefone(t) {
    var d = String(t || '');
    if (d.length === 13 && d.indexOf('55') === 0) {
      return '(' + d.slice(2,4) + ') ' + d.slice(4,9) + '-' + d.slice(9);
    }
    if (d.length === 12 && d.indexOf('55') === 0) {
      return '(' + d.slice(2,4) + ') ' + d.slice(4,8) + '-' + d.slice(8);
    }
    return '+' + d;
  }

  el('waLista').onclick = function (ev) {
    var b = ev.target.closest('button');
    if (!b || !b.dataset.removerWa) return;
    if (!confirm('Remover este número? Ele deixa de conseguir pedir notas.')) return;
    api('/empresas/' + estado.editando + '/whatsapp/' + b.dataset.removerWa,
        { method: 'DELETE' })
      .then(mostrarWhatsapp)
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  el('btnAddWhatsapp').onclick = function () {
    var b = el('btnAddWhatsapp');
    b.disabled = true;
    el('waResultado').textContent = '';
    api('/empresas/' + estado.editando + '/whatsapp', {
      method: 'POST',
      body: JSON.stringify({
        telefone: el('waTelefone').value,
        nome: el('waNome').value,
        cargo: el('waCargo').value,
        limiteValor: parseValorBR(el('waLimite').value)
      })
    })
      .then(function (lista) {
        mostrarWhatsapp(lista);
        el('waTelefone').value = ''; el('waNome').value = '';
        el('waCargo').value = ''; el('waLimite').value = '';
        aviso('Número autorizado.', 'ok');
      })
      .catch(function (e) { el('waResultado').textContent = e.message; })
      .then(function () { b.disabled = false; });
  };


  /* ------------------------------------------- o sistema por baixo */

  /* Isto morava num script de PowerShell. Funcionava para quem escreve
     comandos, e nao para quem opera a contabilidade -- que e justamente quem
     vai olhar as oito da manha, quando um cliente disser que mandou mensagem e
     ninguem respondeu.

     Cada linha diz O QUE ACONTECE se aquela peca faltar. "Tarefa nao
     registrada" nao significa nada para o operador; "depois de um reinicio o
     WhatsApp nao responde" significa. */
  function linhaSistema(cor, titulo, texto, saida) {
    return '<div style="display:flex;gap:11px;padding:11px 0;' +
      'border-bottom:1px solid var(--linha)">' +
      '<div style="flex:none;width:14px"><span class="' + cor + '">\u25cf</span></div>' +
      '<div style="flex:1"><div><strong>' + esc(titulo) + '</strong></div>' +
      '<div class="ajuda">' + esc(texto) + '</div>' +
      (saida ? '<div class="ajuda" style="color:var(--acento)">\u2192 ' + esc(saida) + '</div>' : '') +
      '</div></div>';
  }

  function carregarSistema() {
    return api('/manutencao/sistema').then(function (d) {
      var linhas = '';
      var problemas = 0;

      /* --------------------------------------------- o inicio automatico */
      var t = d.tarefa;
      if (t.estado === 'ok') {
        linhas += linhaSistema('s-ok', 'Inicia sozinho com o Windows', t.texto);
      } else if (t.estado === 'sem_permissao') {
        linhas += linhaSistema('s-alerta', 'Inicia sozinho com o Windows', t.texto);
      } else if (t.estado !== 'nao_se_aplica') {
        problemas++;
        linhas += linhaSistema('s-erro', 'NÃO inicia sozinho', t.texto,
          'Use o arquivo de manutenção, abaixo, e escolha "Instalar o início automático".');
      }

      /* ------------------------------------------------------- o banco */
      var b = d.banco;
      if (b.estado === 'ok') {
        linhas += linhaSistema('s-ok', 'Banco de dados', b.texto);
      } else if (b.estado !== 'nao_se_aplica') {
        problemas++;
        linhas += linhaSistema('s-erro', 'Banco de dados', b.texto,
          'Use o arquivo de manutenção e escolha "Instalar o início automático".');
      }

      /* -------------------------------------------------- o certificado */
      (d.certificados || []).forEach(function (c) {
        if (c.estado === 'vencido') {
          problemas++;
          linhas += linhaSistema('s-erro', 'Certificado de ' + c.empresa + ' VENCIDO',
            'Venceu em ' + fmtData(c.validoAte) + '. Nenhuma nota desta empresa sai, ' +
            'e o cancelamento também não.',
            'Renove na certificadora e suba o arquivo novo na ficha da empresa.');
        } else if (c.estado === 'vencendo') {
          problemas++;
          linhas += linhaSistema('s-alerta', 'Certificado de ' + c.empresa,
            'Vence em ' + c.dias + ' dia(s), em ' + fmtData(c.validoAte) + '.',
            'Renovar leva alguns dias na certificadora. Comece agora, não no dia.');
        } else {
          linhas += linhaSistema('s-ok', 'Certificado de ' + c.empresa,
            'Válido até ' + fmtData(c.validoAte) + ' (' + c.dias + ' dias).');
        }
      });

      /* ----------------------------------------------------- o backup */
      var k = d.backup;
      var quando = k.ultimo ? fmtDataHora(k.ultimo) : 'nunca';
      if (k.estado === 'so_aqui') {
        problemas++;
        linhas += linhaSistema('s-alerta', 'Backup só neste computador',
          'Última cópia: ' + quando + '. Ela fica no mesmo disco do banco — ' +
          'um disco que falhar leva os dois.',
          'Configure um destino em Backup e migração. Um pendrive ou uma pasta ' +
          'de rede já resolve.');
      } else if (k.estado === 'atrasado' || k.estado === 'nenhum') {
        problemas++;
        linhas += linhaSistema('s-erro', 'Backup atrasado',
          'Última cópia: ' + quando + '.',
          'Costuma querer dizer que o gateway ficou fechado — e fechado ele ' +
          'também não atende o WhatsApp.');
      } else {
        linhas += linhaSistema('s-ok', 'Backup em dia',
          'Última cópia: ' + quando + ', com ' + k.destinosFora + ' destino(s) fora daqui.');
      }

      /* ------------------------------------------------------- a rede */
      if (d.rede.estado === 'aberto_na_rede') {
        problemas++;
        linhas += linhaSistema('s-alerta', 'O painel atende toda a rede local', d.rede.texto,
          'Se só este computador opera, ponha HOST=127.0.0.1 no arquivo .env. ' +
          'Se outras pessoas precisam entrar, trate de HTTPS antes de dar a senha a elas.');
      } else {
        linhas += linhaSistema('s-ok', 'O painel so atende neste computador', d.rede.texto);
      }

      el('sisLista').innerHTML = linhas;

      var selo = el('sisSelo');
      selo.className = 'selo-status ' + (problemas ? 's-erro' : 's-ok');
      selo.textContent = problemas
        ? problemas + ' ponto(s) para olhar'
        : 'Tudo de pé \u00b7 versão ' + d.versao;

      /* O selo do menu existe para o problema nao esperar alguem abrir a tela. */
      var seloMenu = el('seloSistema');
      if (seloMenu) { seloMenu.hidden = problemas === 0; seloMenu.textContent = problemas; }

      /* O arquivo de duplo clique so aparece quando ha o que fazer com ele. */
      var precisa = !d.podeAgir || problemas > 0;
      el('sisCaixaArquivo').hidden = !(precisa && d.arquivoManutencao);
      if (d.arquivoManutencao) el('sisArquivo').textContent = d.arquivoManutencao;

      el('btnSisReiniciar').disabled = !d.podeAgir;
      el('btnSisReiniciar').title = d.podeAgir ? ''
        : 'Este gateway não foi aberto pela tarefa do Windows, então não tem ' +
          'permissão para se reiniciar. Use o arquivo de manutenção.';
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnSisAtualizar').onclick = function () {
    var b = el('btnSisAtualizar');
    b.disabled = true;
    carregarSistema().then(function () { b.disabled = false; });
  };

  el('btnSisReiniciar').onclick = function () {
    if (!confirm('Reiniciar o gateway?\n\n' +
                 'Ele sai do ar por alguns segundos e volta sozinho. ' +
                 'Nota em emissão nesse momento continua na fila e sai depois.')) return;
    var b = el('btnSisReiniciar');
    b.disabled = true;
    el('sisResultado').textContent = 'Reiniciando…';
    api('/manutencao/sistema/reiniciar', { method: 'POST' })
      .then(function () {
        /* O proprio processo que responderia morre agora. Esperar e tentar de
           novo e o que sobra -- e e o que a pessoa faria a mao. */
        var tentar = function (resta) {
          api('/manutencao/sistema').then(function () {
            el('sisResultado').textContent = 'De volta ao ar.';
            b.disabled = false;
            carregarSistema();
          }).catch(function () {
            if (resta <= 0) {
              el('sisResultado').textContent =
                'Não voltou em 40 segundos. Confira pelo arquivo de manutenção.';
              b.disabled = false;
              return;
            }
            setTimeout(function () { tentar(resta - 1); }, 2000);
          });
        };
        setTimeout(function () { tentar(20); }, 3000);
      })
      .catch(function (e) {
        el('sisResultado').textContent = e.message;
        b.disabled = false;
      });
  };

  /* ------------------------------- WhatsApp do escritório e a conversa */

  /* As credenciais da Meta ficam no gateway e viajam com o cadastro. O contador
     configura na tela dele, não por SSH num servidor. */
  function preencherCanal(c) {
    el('waNumero').value = c.wa_numero ? fmtTelefone(c.wa_numero) : '';
    el('waPhoneId').value = c.wa_phone_number_id || '';
    el('waCanalAtivo').checked = !!c.wa_ativo;
    el('waDocumentos').checked = c.wa_envia_documentos !== false;
    el('waToken').value = '';
    el('waTokenEstado').textContent = c.tem_wa_token
      ? 'Um token já está guardado. Deixe em branco para mantê-lo.'
      : 'Nenhum token guardado.';
  }

  /* ------------------------------------------- o repassador desta máquina */

  /* Quem recebe a mensagem da Meta pode rodar aqui ou num servidor alugado.
     Rodando aqui, some a peça que ninguém atualiza — e é o gateway que sobe,
     vigia e reinicia os dois processos. A tela é a única configuração. */
  function preencherRepassador(c) {
    var local = !!c.relay_local;
    el('rpLocal').checked = local;
    el('rpCaixaLocal').hidden = !local;
    el('rpPorta').value = c.relay_porta || 8080;
    el('rpTunel').checked = !!c.tunel_ativo;
    el('rpUrlPublica').value = c.relay_url_publica || '';
    el('rpBinario').value = c.tunel_binario || '';
    el('rpAppSecret').value = '';
    el('rpVerify').value = '';
    el('rpTunelToken').value = '';

    el('rpAppSecretEstado').textContent = c.tem_app_secret
      ? 'Guardado. Em branco mantém.' : 'Nenhum guardado.';
    el('rpVerifyEstado').textContent = c.tem_verify_token
      ? 'Guardado. Em branco mantém.' : 'Nenhum guardado.';
    el('rpTunelTokenEstado').textContent = c.tem_tunel_token
      ? 'Guardado. Em branco mantém.' : 'Nenhum guardado.';

    /* Com o repassador aqui, o endereço não é digitado: é o processo que este
       gateway mesmo subiu. Deixar a caixa aberta só criaria jeito de errar. */
    el('ptUrl').readOnly = local;
    el('ptUrlNota').textContent = local
      ? 'O repassador é desta máquina: o endereço é escolhido pelo sistema.'
      : 'Precisa ser https: as solicitações levam CNPJ, valores e descrição de serviço.';

    /* A frase sobre os segredos deixa de valer quando ele roda aqui. */
    el('waSegredosNota').innerHTML = local
      ? 'O <span class="mono">App Secret</span> e o token de verificação ficam ' +
        'logo acima, em <strong>Onde o WhatsApp atende</strong> — com o ' +
        'repassador nesta máquina, não há .env noutro servidor para editar.'
      : 'O <span class="mono">App Secret</span> e o token de verificação ' +
        '<strong>não vêm para cá</strong>: são eles que provam que a mensagem ' +
        'veio da Meta, e mandá-los pelo canal que protegem fecharia o círculo. ' +
        'Ficam no <span class="mono">.env</span> do repassador, escritos uma ' +
        'vez na instalação.';

    if (local) situacaoRepassador();
    else {
      el('rpEstado').className = 'selo-status s-neutro';
      el('rpEstado').textContent = 'Roda fora daqui';
    }
  }

  function linhaProcesso(nome, p, ligado, papel) {
    var cor, texto;
    if (!ligado) { cor = 's-neutro'; texto = 'desligado'; }
    else if (p.rodando) { cor = 's-ok'; texto = 'no ar desde ' + fmtDataHora(p.subiuEm); }
    else if (p.desistiu) { cor = 's-erro'; texto = 'parado'; }
    else { cor = 's-alerta'; texto = 'subindo'; }

    return '<div style="display:flex;gap:10px;padding:8px 0;' +
      'border-bottom:1px solid var(--linha)">' +
      '<div style="flex:none;width:14px"><span class="' + cor + '">●</span></div>' +
      '<div style="flex:1"><div><strong>' + esc(nome) + '</strong> — ' + esc(texto) + '</div>' +
      '<div class="ajuda">' + esc(papel) + '</div>' +
      (p.ultimoErro ? '<div class="ajuda s-erro">' + esc(p.ultimoErro) + '</div>' : '') +
      (!p.ultimoErro && p.ultimaLinha
        ? '<div class="ajuda mono">' + esc(p.ultimaLinha) + '</div>' : '') +
      '</div></div>';
  }

  /* "O bot não respondeu" começa aqui: os dois processos, de pé ou não, com a
     última linha que cada um escreveu. Sem isto, a resposta seria abrir o log
     do Windows — que ninguém no escritório vai abrir. */
  function situacaoRepassador() {
    return api('/ponte/repassador').then(function (r) {
      el('rpProcessos').innerHTML =
        linhaProcesso('Repassador', r.repassador, r.relayLocal,
          'Recebe a mensagem da Meta e enfileira o pedido. Escuta em 127.0.0.1:' +
          r.porta + '.') +
        linhaProcesso('Túnel', r.tunel, r.tunelAtivo,
          r.cloudflared
            ? 'Dá o endereço público sem abrir porta. Programa: ' + r.cloudflared
            : 'Dá o endereço público sem abrir porta.');

      var selo = el('rpEstado');
      var faltaSegredo = !r.temAppSecret || !r.temVerifyToken;
      var deviaTer = r.relayLocal && (!r.tunelAtivo || r.tunel.rodando);
      if (!r.relayLocal) { selo.className = 'selo-status s-neutro'; selo.textContent = 'Roda fora daqui'; }
      else if (faltaSegredo) { selo.className = 'selo-status s-alerta'; selo.textContent = 'Falta configurar'; }
      else if (r.repassador.rodando && deviaTer) { selo.className = 'selo-status s-ok'; selo.textContent = 'No ar'; }
      else { selo.className = 'selo-status s-erro'; selo.textContent = 'Parado'; }
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('rpLocal').onchange = function () {
    el('rpCaixaLocal').hidden = !this.checked;
    /* Preenche o quadro dos processos na hora de abrir a caixa: um retangulo
       vazio parece defeito, e "desligado" e uma informacao. */
    if (this.checked) situacaoRepassador();
  };

  /* Fica visível de propósito: esta mesma frase precisa ser colada no painel da
     Meta, e ela não protege nada depois do cadastro do webhook — serve só para
     a Meta provar, uma vez, que quem respondeu era mesmo o dono do endereço. */
  el('btnSortearVerify').onclick = function () {
    var b = new Uint8Array(18);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    el('rpVerify').value = 'nfse-' + s;
    el('rpVerifyEstado').textContent =
      'Copie esta frase: ela vai igualzinha no painel da Meta, em Webhook → ' +
      'Token de verificação. Salve aqui antes de sair da tela.';
  };

  el('btnSalvarRepassador').onclick = function () {
    var b = el('btnSalvarRepassador');
    var local = el('rpLocal').checked;
    if (local && el('rpTunel').checked && !el('rpUrlPublica').value) {
      return aviso('Diga qual é o endereço público do túnel — é ele que vai ' +
                   'no webhook da Meta.', 'erro');
    }
    b.disabled = true;
    el('rpResultado').textContent = 'Aplicando…';
    api('/ponte/config', { method: 'PUT', body: JSON.stringify({
      relayLocal: local,
      relayPorta: Number(el('rpPorta').value) || 8080,
      relayUrlPublica: el('rpUrlPublica').value || null,
      tunelAtivo: el('rpTunel').checked,
      tunelBinario: el('rpBinario').value,
      // Vazio mantém o que está guardado, não apaga
      waAppSecret: el('rpAppSecret').value || undefined,
      waVerifyToken: el('rpVerify').value || undefined,
      tunelToken: el('rpTunelToken').value || undefined
    }) })
      .then(function (c) {
        el('rpResultado').textContent = '';
        preencherRepassador(c);
        el('ptUrl').value = c.url || '';
        aviso('Salvo e aplicado.', 'ok');
      })
      .catch(function (e) {
        el('rpResultado').textContent = e.message;
        aviso(e.message, 'erro');
      })
      .then(function () { b.disabled = false; });
  };

  /* Existe para depois de trocar o token na Meta, e para o caso em que o
     processo caiu cinco vezes e a supervisão desistiu de propósito. */
  el('btnReiniciarRepassador').onclick = function () {
    var b = el('btnReiniciarRepassador');
    b.disabled = true;
    el('rpResultado').textContent = 'Reiniciando…';
    api('/ponte/repassador/reiniciar', { method: 'POST' })
      .then(function () {
        el('rpResultado').textContent = '';
        /* Dá tempo de o processo subir antes de perguntar como ele está. */
        setTimeout(situacaoRepassador, 1500);
      })
      .catch(function (e) { el('rpResultado').textContent = e.message; })
      .then(function () { b.disabled = false; });
  };

  /* A conversa que gerou o pedido. É o que responde "eu não pedi essa nota":
     o pedido pronto não prova nada, o diálogo prova. */
  function verTranscricao(id) {
    api('/ponte/solicitacoes?limite=200').then(function (lista) {
      var s = lista.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!s) return aviso('Solicitação não encontrada.', 'erro');
      var linhas = (s.transcricao || []).map(function (m) {
        var quem = m.de === 'cliente' ? 'Cliente' : 'Sistema';
        return '<div style="margin-bottom:10px">' +
          '<div class="ajuda"><strong>' + quem + '</strong> · ' + fmtDataHora(m.em) + '</div>' +
          '<div style="white-space:pre-wrap">' + esc(m.texto) + '</div></div>';
      }).join('');
      el('trTitulo').textContent = 'Pedido ' + s.id_externo;
      el('trSub').textContent = (s.razao_social || s.cnpj_informado || '') +
        (s.remetente ? ' · ' + fmtTelefone(s.remetente) : '') +
        ' · ' + fmtDataHora(s.recebida_em);
      el('trCorpo').innerHTML = linhas ||
        '<div class="ajuda">Este pedido não veio de conversa — não há transcrição.</div>';
      el('dlgTranscricao').showModal();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }
  el('trFechar').onclick = function () { el('dlgTranscricao').close(); };

  el('btnSalvarCanal').onclick = function () {
    var b = el('btnSalvarCanal');
    b.disabled = true;
    api('/ponte/config', { method: 'PUT', body: JSON.stringify({
      waNumero: el('waNumero').value,
      waPhoneNumberId: el('waPhoneId').value,
      waAtivo: el('waCanalAtivo').checked,
      waEnviaDocumentos: el('waDocumentos').checked,
      waToken: el('waToken').value || undefined
    }) })
      .then(function (c) { preencherCanal(c); aviso('WhatsApp do escritório salvo.', 'ok'); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };


  /* ------------------------------------------- o que falta para funcionar */

  /* A mesma conferência do relay/conferir.js, na tela — para quem não vai abrir
     terminal. O que este lado não alcança fica escrito, em vez de omitido: dar
     "tudo certo" quando não se conferiu tudo é pior do que não conferir. */
  function conferirWhatsapp() {
    return api('/ponte/diagnostico').then(function (d) {
      var selo = el('dgSelo');
      selo.className = 'selo-status ' + (d.pronto ? 's-ok' : 's-erro');
      selo.textContent = d.resumo;

      el('dgLista').innerHTML = d.itens.map(function (i) {
        var marca = i.estado === 'ok' ? '<span class="s-ok">●</span>'
                  : i.estado === 'falta' ? '<span class="s-erro">●</span>'
                  : '<span class="s-alerta">●</span>';
        return '<div style="display:flex;gap:10px;padding:7px 0;' +
          'border-bottom:1px solid var(--linha)">' +
          '<div style="flex:none;width:14px">' + marca + '</div>' +
          '<div><div>' + esc(i.o_que) + '</div>' +
          (i.detalhe ? '<div class="ajuda mono">' + esc(i.detalhe) + '</div>' : '') +
          (i.resolver ? '<div class="ajuda" style="color:var(--acento)">→ ' +
                        esc(i.resolver) + '</div>' : '') +
          '</div></div>';
      }).join('');

      el('dgCego').textContent = ' ' + d.naoConfiro.join(' ');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnConferirWa').onclick = function () {
    var b = el('btnConferirWa');
    b.disabled = true;
    conferirWhatsapp().then(function () { b.disabled = false; });
  };

  window.addEventListener('hashchange', function () {
    navegar(location.hash.replace('#','') || 'inicio');
  });
  el('btnMenu').onclick = function () { el('sidebar').classList.toggle('aberta'); };

  /* ---------------------------------------------------------------- início */

  function carregarInicio() {
    var pronto = estado.resumoInicial
      ? Promise.resolve(estado.resumoInicial)
      : api('/painel/resumo');
    estado.resumoInicial = null;
    pronto.then(function (d) {
      /* Zero por falta de acesso é diferente de zero por não haver nada. Sem
         esta frase, quem foi criado sem vínculo conclui que o sistema quebrou. */
      var av = el('avisoSemVinculo');
      if (d.semVinculo) {
        av.className = 'aviso info';
        av.textContent = 'Sua conta ainda não está vinculada a nenhuma empresa, ' +
          'por isso as telas aparecem vazias. Peça ao administrador do gateway ' +
          'para vincular as empresas que você atende.';
      } else { av.className = 'aviso'; av.textContent = ''; }

      el('mTotal').textContent = d.mes.total;
      el('mTotalNota').textContent = d.mes.total === 1 ? 'nota neste mês' : 'notas neste mês';
      el('mAut').textContent = d.mes.autorizadas;
      el('mProc').textContent = d.mes.porStatus.processando || 0;
      el('mErro').textContent = (d.mes.porStatus.rejeitada || 0) + (d.mes.porStatus.erro || 0);
      el('qtdEmpresas').textContent = d.empresas.total + ' cadastrada(s), ' +
        d.empresas.em_producao + ' em produção';

      // Alertas primeiro: certificado vencido é o que trava a operação
      var alertas = '';
      (d.alertas.certificados || []).forEach(function (c) {
        var vencido = c.dias < 0;
        alertas += '<div class="linha-alerta ' + (vencido ? 'critico' : 'aviso') + '">' +
          '<strong>' + esc(c.razao_social) + '</strong>' +
          (vencido ? ' — certificado VENCIDO em ' + fmtData(c.valido_ate)
                   : ' — certificado vence em ' + c.dias + ' dia(s)') +
          '</div>';
      });
      (d.alertas.semCertificado || []).forEach(function (e) {
        alertas += '<div class="linha-alerta aviso"><strong>' + esc(e.razao_social) +
          '</strong> — sem certificado digital, não pode emitir</div>';
      });
      el('alertas').innerHTML = alertas;

      var tb = el('corpoUltimas'); tb.innerHTML = '';
      alternarVazio('corpoUltimas', 'vazioUltimas', d.ultimasNotas.length);
      d.ultimasNotas.forEach(function (n) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + n.id + '</td>' +
          '<td>' + esc(n.razao_social) + '</td>' +
          '<td class="mono">' + esc(n.serie) + '/' + esc(n.numero) + '</td>' +
          '<td>' + seloStatus(n.status) + '</td>' +
          '<td style="color:var(--texto-2)">' + fmtDataHora(n.criado_em) + '</td>';
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  /* -------------------------------------------------------------- empresas */

  function carregarEmpresas() {
    api('/empresas').then(function (linhas) {
      estado.empresas = linhas || [];
      var tb = el('corpoEmpresas'); tb.innerHTML = '';
      alternarVazio('corpoEmpresas', 'vazioEmpresas', estado.empresas.length);
      estado.empresas.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + fmtDoc(e.cnpj) + '</td>' +
          '<td><strong>' + esc(e.razao_social) + '</strong>' +
            (e.nome_fantasia ? '<div class="ajuda">' + esc(e.nome_fantasia) + '</div>' : '') +
            (e.ativo ? '' : ' <span class="selo-status s-neutro sem-ponto">inativa</span>') +
            /* Falta de padrão fiscal só aparecia quando o cliente mandava a
               primeira mensagem e a Sefin recusava. Aqui é onde se conserta. */
            ((e.falta_padroes || []).length
              ? '<div class="ajuda s-erro">Falta ' + esc(e.falta_padroes.join(' e ')) +
                ' — emite pelo formulário, mas o WhatsApp é recusado.</div>'
              : '') + '</td>' +
          '<td class="mono">' + esc(e.codigo_municipio) + (e.uf ? '/' + esc(e.uf) : '') + '</td>' +
          '<td>' + seloAmbiente(e.ambiente) + '</td>' +
          '<td>' + seloCertificado(e.certificado_valido_ate) + '</td>' +
          '<td class="mono">' + esc(e.serie_dps || '—') + '/' + esc(e.prox_num_dps || '—') + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno'; b.textContent = 'Abrir';
        b.onclick = function () { abrirEmpresa(e.cnpj); };
        tr.lastChild.appendChild(b);

        // Trocar de ambiente muda o que a próxima nota significa, então é ação
        // própria e visível, não um campo perdido dentro do cadastro.
        var amb = document.createElement('button');
        amb.className = 'pequeno' + (e.ambiente === 'homologacao' ? ' primario' : ' perigo');
        amb.style.marginLeft = '6px';
        amb.textContent = e.ambiente === 'homologacao' ? 'Ir para produção' : 'Voltar a teste';
        amb.title = e.ambiente === 'homologacao'
          ? 'Passar a emitir notas com valor fiscal'
          : 'Voltar a emitir notas de teste';
        amb.onclick = function () { trocarAmbiente(e); };
        tr.lastChild.appendChild(amb);
        tb.appendChild(tr);
      });
      preencherSelectsEmpresa();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  /* Troca de ambiente.
     A confirmação usa diálogo próprio, não prompt(): o prompt nativo é
     bloqueado por vários navegadores e, quando bloqueado, retorna null — o
     usuário clicava, nada acontecia, e não havia como saber por quê. */
  function trocarAmbiente(e, aoConcluir) {
    var nome = e.nome_fantasia || e.razao_social;

    if (e.ambiente === 'producao') {
      if (!confirm('Voltar ' + nome + ' para homologação (teste)?\n\n' +
                   'As notas passam a ser de teste, sem valor fiscal.')) return;
      return aplicarAmbiente(e, 'homologacao', false, nome, aoConcluir);
    }

    // Para produção: diálogo com o que muda, a numeração de destino e a
    // confirmação digitada.
    el('prodEmpresa').textContent = nome + ' — ' + fmtDoc(e.cnpj);
    el('prodConfirma').value = '';
    el('prodConfirmar').disabled = true;

    api('/empresas/' + e.cnpj + '/resumo').then(function (d) {
      var num = (d.numeracao || []).filter(function (n) { return n.ambiente === 'producao'; })[0];
      el('prodNumeracao').textContent = num
        ? 'série ' + num.serie + ', número ' + num.prox_numero
        : 'série 1, número 1 (primeira nota em produção)';
      el('prodCert').innerHTML = seloCertificado(d.certificado && d.certificado.valido_ate);
    }).catch(function () {
      el('prodNumeracao').textContent = '—';
    });

    el('prodConfirmar').onclick = function () {
      el('dlgProducao').close();
      aplicarAmbiente(e, 'producao', true, nome, aoConcluir);
    };
    el('dlgProducao').showModal();
    el('prodConfirma').focus();
  }

  /* Só habilita o botão quando o texto confere: o clique por engano aqui custa
     uma nota fiscal real. */
  el('prodConfirma').oninput = function () {
    el('prodConfirmar').disabled = el('prodConfirma').value.trim().toUpperCase() !== 'PRODUCAO';
  };
  el('prodConfirma').onkeydown = function (ev) {
    if (ev.key === 'Enter' && !el('prodConfirmar').disabled) el('prodConfirmar').click();
  };
  el('prodCancelar').onclick = function () { el('dlgProducao').close(); };

  function aplicarAmbiente(e, ambiente, confirmo, nome, aoConcluir) {
    api('/empresas/' + e.cnpj + '/ambiente', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ambiente: ambiente, confirmo: confirmo })
    }).then(function (r) {
      var n = r.numeracao;
      aviso(nome + ' agora emite em ' + nomeAmbiente(r.ambiente) +
        (n ? '. Próxima nota: série ' + n.serie + ', número ' + n.prox_numero + '.' : '.'));
      if (aoConcluir) aoConcluir(); else carregarEmpresas();
    }).catch(function (err) { aviso(err.message, 'erro'); });
  }

  function carregarVisaoGeral(cnpj) {
    api('/empresas/' + cnpj + '/resumo').then(function (d) {
      var e = d.empresa;

      // Alertas antes dos números: é o que impede de emitir
      var alertas = '';
      if (!d.certificado) {
        alertas += '<div class="linha-alerta critico"><strong>Sem certificado digital</strong>' +
          ' — esta empresa não consegue emitir. Anexe na aba Certificado.</div>';
      } else if (d.certificado.dias < 0) {
        alertas += '<div class="linha-alerta critico"><strong>Certificado vencido</strong> em ' +
          fmtData(d.certificado.valido_ate) + ' — renove antes de emitir.</div>';
      } else if (d.certificado.dias <= 30) {
        alertas += '<div class="linha-alerta aviso"><strong>Certificado vence em ' +
          d.certificado.dias + ' dia(s)</strong> (' + fmtData(d.certificado.valido_ate) + ').</div>';
      }
      if (d.naFila) {
        alertas += '<div class="linha-alerta aviso">' + d.naFila +
          ' nota(s) aguardando resposta da Sefin.</div>';
      }
      var comProblema = (d.mes.porStatus.rejeitada || 0) + (d.mes.porStatus.erro || 0);
      if (comProblema) {
        alertas += '<div class="linha-alerta aviso">' + comProblema +
          ' nota(s) com problema neste mês — veja a lista abaixo.</div>';
      }
      el('visaoAlertas').innerHTML = alertas;

      el('vgMes').textContent = d.mes.total;
      el('vgMesNota').textContent = d.mes.autorizadas + ' autorizada(s)';

      // Faturamento vem dos XMLs das últimas notas: o resumo não recalcula o
      // mês inteiro, que é trabalho do relatório de fechamento.
      var faturado = d.ultimasNotas
        .filter(function (n) { return n.status === 'autorizada'; })
        .reduce(function (t, n) { return t + ((n.valores && n.valores.valorServico) || 0); }, 0);
      el('vgFaturado').textContent = fmtMoeda(faturado);

      var num = (d.numeracao || []).filter(function (n) { return n.ambiente === e.ambiente; })[0];
      el('vgProxima').textContent = num ? num.serie + '/' + num.prox_numero : '—';
      el('vgAmbiente').innerHTML = seloAmbiente(e.ambiente);

      el('vgCert').innerHTML = seloCertificado(d.certificado && d.certificado.valido_ate);
      el('vgCertNota').textContent = d.certificado
        ? 'anexado em ' + fmtData(d.certificado.criado_em) : 'nenhum anexado';

      // Barras simples: doze meses cabem sem biblioteca de gráfico
      var maior = Math.max.apply(null, d.historico.map(function (h) { return h.total; }).concat([1]));
      el('vgHistorico').innerHTML = d.historico.length
        ? d.historico.map(function (h) {
            var altura = Math.max(3, Math.round((h.total / maior) * 74));
            var mes = h.mes.slice(5) + '/' + h.mes.slice(2, 4);
            return '<div title="' + mes + ': ' + h.total + ' nota(s), ' + h.autorizadas +
              ' autorizada(s)" style="flex:1;display:flex;flex-direction:column;' +
              'justify-content:flex-end;align-items:center;gap:4px">' +
              '<div style="width:100%;height:' + altura + 'px;background:var(--acento);' +
              'border-radius:3px 3px 0 0;opacity:' + (h.total ? 1 : .25) + '"></div>' +
              '<span style="font-size:9.5px;color:var(--texto-3)">' + mes + '</span></div>';
          }).join('')
        : '<div class="ajuda">Sem histórico ainda.</div>';

      var tb = el('vgNotas'); tb.innerHTML = '';
      el('vgSemNotas').hidden = d.ultimasNotas.length > 0;
      d.ultimasNotas.forEach(function (n) {
        var v = n.valores || {};
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + esc(n.serie) + '/' + esc(n.numero) + '</td>' +
          '<td>' + esc(v.tomador || '—') + '</td>' +
          '<td>' + (v.valorServico ? fmtMoeda(v.valorServico) : '—') + '</td>' +
          '<td>' + seloStatus(n.status) +
            (n.ultimo_erro ? '<div class="ajuda">' + esc(n.ultimo_erro.slice(0, 60)) + '</div>' : '') + '</td>' +
          '<td style="color:var(--texto-2)">' + fmtDataHora(n.criado_em) + '</td>' +
          '<td class="acoes"></td>';
        var ver = document.createElement('button');
        ver.className = 'pequeno'; ver.textContent = 'Ver';
        ver.onclick = function () { abrirNota(n.id); };
        tr.lastChild.appendChild(ver);
        tb.appendChild(tr);
      });

      el('vgLotes').innerHTML = d.lotes.length
        ? d.lotes.map(function (l) {
            return '<div style="display:flex;gap:9px;align-items:center;margin-bottom:7px;font-size:13px">' +
              '<span class="mono">#' + l.id + '</span>' +
              '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                esc(l.descricao || '—') + '</span>' +
              '<span class="ajuda">' + l.total + ' linha(s)' +
                (l.com_erro ? ', ' + l.com_erro + ' com erro' : '') + '</span></div>';
          }).join('')
        : '<div class="ajuda">Nenhum lote enviado.</div>';

      el('vgClientes').textContent = d.cadastros.clientes;
      el('vgServicos').textContent = d.cadastros.servicos;
      el('vgVerNotas').onclick = function () {
        el('nf_empresa').value = cnpj;
        location.hash = 'notas';
      };
    }).catch(function (err) { aviso(err.message, 'erro'); });
  }

  function montarBlocoAmbiente(empresa, numeracoes) {
    var producao = empresa.ambiente === 'producao';
    var lista = estado.empresas.filter(function (x) { return x.cnpj === empresa.cnpj; })[0] || {};

    el('seloAmbienteEmpresa').innerHTML = producao
      ? '<span class="selo-status s-erro">produção</span>'
      : '<span class="selo-status s-info sem-ponto">homologação</span>';

    el('textoAmbiente').textContent = producao
      ? 'As notas emitidas por esta empresa têm valor fiscal e geram imposto.'
      : 'As notas são de teste. Não têm valor fiscal e não geram imposto.';

    var num = (numeracoes || []).filter(function (n) { return n.ambiente === empresa.ambiente; })[0];
    el('proximaNota').textContent = num
      ? 'série ' + num.serie + ', número ' + num.prox_numero
      : 'ainda não numerada';

    // Sem certificado válido a produção não é permitida; dizer isso aqui evita
    // a recusa depois do clique.
    el('certAmbiente').innerHTML = seloCertificado(lista.certificado_valido_ate);

    var b = el('btnTrocarAmbiente');
    b.textContent = producao ? 'Voltar para homologação (teste)' : 'Passar para produção';
    b.className = producao ? 'perigo' : 'primario';
    b.onclick = function () {
      trocarAmbiente({
        cnpj: empresa.cnpj,
        ambiente: empresa.ambiente,
        nome_fantasia: empresa.nome_fantasia,
        razao_social: empresa.razao_social
      }, function () { abrirEmpresa(empresa.cnpj); });
    };

    el('blocoAmbiente').hidden = false;
    el('wrapAmbienteNovo').hidden = true;   // o select é só para empresa nova
  }

  function preencherSelectsEmpresa() {
    [['nf_empresa','Todas'], ['cl_empresa',null], ['sv_empresa',null], ['w_empresa','Todas']]
      .forEach(function (par) {
        var sel = el(par[0]); if (!sel) return;
        var atual = sel.value;
        sel.innerHTML = par[1] ? '<option value="">' + par[1] + '</option>' : '';
        estado.empresas.forEach(function (e) {
          var o = document.createElement('option');
          o.value = (par[0] === 'cl_empresa' || par[0] === 'sv_empresa') ? e.id : e.cnpj;
          o.textContent = e.nome_fantasia || e.razao_social;
          sel.appendChild(o);
        });
        if (atual) sel.value = atual;
      });
  }

  /* Padrões fiscais da empresa.

     Antes, o código de tributação, o NBS e a alíquota eram digitados em cada
     nota. Uma empresa de vigilância emite o mesmo serviço todo mês: repetir
     seis dígitos de cTribNac cem vezes por mês é onde o erro entra, e a Sefin
     só reclama depois de queimar o número da DPS. Ficam aqui, no cadastro,
     definidos uma vez por quem entende do enquadramento. */
  function padroesRefletemNatureza() {
    var natureza = Number(el('pf_natureza').value);
    var tributavel = natureza === 1;
    var simples = estado.padroesSimples;

    // Fora de operação tributável não há alíquota a informar; no Simples, quem
    // define o ISS é o DAS, e o que vai na nota é o total de tributos do PGDAS
    el('pf_wrapAliquota').style.display = (tributavel && !simples) ? '' : 'none';
    el('pf_ajudaAliquota').textContent = tributavel
      ? 'Do município do prestador.' : '';
    el('pf_ajudaTotTrib').textContent = simples
      ? 'Optante do Simples: informe aqui a alíquota efetiva do PGDAS.'
      : 'Opcional — Lei 12.741 (imposto aproximado).';
  }

  function carregarPadroesFiscais(cnpj) {
    api('/empresas/' + cnpj + '/padroes-fiscais').then(function (p) {
      estado.padroesSimples = [2, 3].indexOf(Number(p.op_simp_nac)) >= 0;
      el('pf_codigo').value = p.cod_tributacao_padrao || '';
      el('pf_nbs').value = p.cod_nbs_padrao || '';
      el('pf_codmun').value = p.cod_tributacao_municipal || '';
      el('pf_descricao').value = p.descricao_padrao || '';
      el('pf_natureza').value = String(p.tributacao_issqn_padrao || 1);
      el('pf_aliquota').value = p.aliquota_iss_padrao != null ? p.aliquota_iss_padrao : '';
      el('pf_retido').value = p.iss_retido_padrao ? 'true' : 'false';
      el('pf_tottrib').value = p.perc_total_tributos != null ? p.perc_total_tributos : '';
      padroesRefletemNatureza();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('pf_natureza').onchange = padroesRefletemNatureza;

  el('btnSalvarPadroes').onclick = function () {
    if (!estado.editando) return;
    var corpo = {
      codigoTributacao: el('pf_codigo').value.trim(),
      codigoNbs: el('pf_nbs').value.trim(),
      codigoTributacaoMunicipal: el('pf_codmun').value.trim(),
      descricao: el('pf_descricao').value.trim(),
      tributacaoIssqn: Number(el('pf_natureza').value),
      aliquotaIss: el('pf_aliquota').value,
      issRetido: el('pf_retido').value === 'true',
      percentualTotalTributos: el('pf_tottrib').value
    };
    var b = el('btnSalvarPadroes');
    b.disabled = true;
    api('/empresas/' + estado.editando + '/padroes-fiscais',
        { method: 'PUT', body: JSON.stringify(corpo) })
      .then(function () { aviso('Padrões salvos. Valem para as próximas notas.', 'ok'); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  /* ============================ Gestão do cliente ============================
     Obrigações, histórico e o pacote de notas do período. As três coisas que o
     escritório precisa saber sobre um cliente e que não cabiam na ficha
     cadastral. */

  function fmtDataCurta(d) {
    if (!d) return '—';
    var s = String(d).slice(0, 10).split('-');
    return s.length === 3 ? s[2] + '/' + s[1] : fmtData(d);
  }

  /* "vence em 3 dias" diz mais que uma data solta quando o assunto é prazo. */
  function prazoEmPalavras(dias) {
    if (dias === null || dias === undefined) return '';
    var n = Number(dias);
    if (n < 0)  return 'atrasada há ' + Math.abs(n) + (Math.abs(n) === 1 ? ' dia' : ' dias');
    if (n === 0) return 'vence hoje';
    if (n === 1) return 'vence amanhã';
    return 'em ' + n + ' dias';
  }

  function seloPrazo(o) {
    if (o.situacao === 'concluida')  return '<span class="selo-status s-ok">concluída</span>';
    if (o.situacao === 'dispensada') return '<span class="selo-status s-neutro">dispensada</span>';
    var dias = Number(o.dias_para_vencer);
    var classe = o.atrasada ? 's-erro' : (dias <= 7 ? 's-alerta' : 's-neutro');
    return '<span class="selo-status ' + classe + '">' + esc(prazoEmPalavras(dias)) + '</span>';
  }

  /* --------------------------------------------- agenda do escritório */

  function carregarAgenda() {
    var dias = el('agDias').value;
    api('/obrigacoes/agenda?dias=' + dias).then(function (lista) {
      var atrasadas = lista.filter(function (o) { return o.atrasada; }).length;
      var semana = lista.filter(function (o) {
        return !o.atrasada && Number(o.dias_para_vencer) <= 7;
      }).length;

      el('agAtrasadas').textContent = atrasadas;
      el('agAtrasadas').style.color = atrasadas ? 'var(--erro)' : '';
      el('agSemana').textContent = semana;
      el('agTotal').textContent = lista.length;
      el('agHorizonte').textContent = 'nos próximos ' + dias + ' dias';

      var tb = el('agLista');
      tb.innerHTML = '';
      if (!lista.length) {
        tb.innerHTML = '<tr><td colspan="5" style="color:var(--texto-2);padding:22px">' +
          'Nada a vencer neste período. Se esperava ver algo, confira se as obrigações ' +
          'estão marcadas na ficha do cliente.</td></tr>';
        return;
      }
      lista.forEach(function (o) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + esc(fmtDataCurta(o.vencimento)) + '</td>' +
          '<td>' + esc(o.razao_social) + '</td>' +
          '<td>' + esc(o.nome) + '</td>' +
          '<td class="mono">' + esc(o.competencia) + '</td>' +
          '<td style="text-align:right">' + seloPrazo(o) +
            ' <button data-concluir="' + o.id + '">Concluir</button></td>';
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('agDias').onchange = carregarAgenda;
  el('btnAgAtualizar').onclick = carregarAgenda;

  el('agLista').onclick = function (ev) {
    var b = ev.target.closest('[data-concluir]');
    if (!b) return;
    b.disabled = true;
    api('/obrigacoes/' + b.dataset.concluir, {
      method: 'PUT', body: JSON.stringify({ situacao: 'concluida' })
    }).then(function () { aviso('Concluída.', 'ok'); carregarAgenda(); })
      .catch(function (e) { aviso(e.message, 'erro'); b.disabled = false; });
  };

  /* --------------------------------------------- modelos do escritório */

  function carregarModelos() {
    api('/obrigacoes/modelos').then(function (lista) {
      var alvo = el('mdLista');
      if (!lista.length) {
        alvo.innerHTML = '<div class="ajuda">Nenhuma obrigação cadastrada. Use a lista ' +
                         'sugerida para começar e ajuste os prazos.</div>';
        return;
      }
      alvo.innerHTML = '<table class="tabela"><thead><tr><th>Obrigação</th>' +
        '<th>Repete</th><th>Vencimento</th><th>Clientes</th></tr></thead><tbody>' +
        lista.map(function (m) {
          var quando = m.desloca_meses === 0 ? 'no mês da competência'
                     : m.desloca_meses === 1 ? 'no mês seguinte'
                     : m.desloca_meses + ' meses depois';
          return '<tr' + (m.ativo ? '' : ' style="opacity:.5"') + '>' +
            '<td>' + esc(m.nome) + (m.descricao ?
              '<div class="ajuda">' + esc(m.descricao) + '</div>' : '') + '</td>' +
            '<td>' + esc(m.periodicidade) + '</td>' +
            '<td>dia ' + esc(m.dia_vencimento) + ', ' + esc(quando) + '</td>' +
            '<td class="mono">' + esc(m.clientes) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnNovoModelo').onclick = function () {
    var nome = el('mdNome').value.trim();
    if (!nome) return aviso('Dê um nome à obrigação.', 'erro');
    var b = el('btnNovoModelo');
    b.disabled = true;
    api('/obrigacoes/modelos', { method: 'POST', body: JSON.stringify({
      nome: nome,
      periodicidade: el('mdPeriodicidade').value,
      diaVencimento: Number(el('mdDia').value),
      deslocaMeses: Number(el('mdDesloca').value)
    })}).then(function () {
      el('mdNome').value = '';
      aviso('Obrigação criada. Marque-a na ficha dos clientes que a entregam.', 'ok');
      carregarModelos();
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  el('btnSugestoes').onclick = function () {
    api('/obrigacoes/modelos/sugestoes', { method: 'POST' }).then(function (r) {
      if (r.instalados) {
        aviso(r.instalados + ' obrigações adicionadas. Confira os prazos antes de usar.', 'ok');
      } else {
        aviso('Já existem obrigações cadastradas — a lista sugerida só entra numa casa vazia.');
      }
      carregarModelos();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* ------------------------------------ obrigações de um cliente */

  function carregarObrigacoesEmpresa(cnpj) {
    var emp = (estado.empresas || []).filter(function (e) { return e.cnpj === cnpj; })[0];
    if (!emp) return;

    api('/obrigacoes/empresa/' + emp.id).then(function (d) {
      el('obAtrasadas').textContent = d.resumo.atrasadas;
      el('obAtrasadas').style.color = d.resumo.atrasadas ? 'var(--erro)' : '';
      el('obProximas').textContent  = d.resumo.proximas;
      el('obPendentes').textContent = d.resumo.pendentes;
      el('obConcluidas').textContent = d.resumo.concluidas30d;

      el('obModelos').innerHTML = d.modelos.length
        ? d.modelos.map(function (m) {
            return '<label style="display:flex;align-items:center;gap:10px;padding:9px 0;' +
              'border-bottom:1px solid var(--linha);font-weight:400">' +
              '<input type="checkbox" style="width:auto" data-modelo="' + m.id + '"' +
              (m.vinculada ? ' checked' : '') + '>' +
              '<span><strong>' + esc(m.nome) + '</strong>' +
              '<span class="ajuda" style="display:block">dia ' + esc(m.dia_vencimento) +
              ', ' + esc(m.periodicidade) + '</span></span></label>';
          }).join('')
        : '<div class="ajuda">Nenhuma obrigação cadastrada ainda. Cadastre em ' +
          '<a href="#agenda">Agenda do escritório</a>.</div>';

      var tb = el('obLista');
      tb.innerHTML = d.ocorrencias.length
        ? d.ocorrencias.map(function (o) {
            return '<tr><td>' + esc(o.nome) + '</td>' +
              '<td class="mono">' + esc(o.competencia) + '</td>' +
              '<td class="mono">' + esc(fmtData(o.vencimento)) + '</td>' +
              '<td>' + (o.situacao === 'concluida'
                ? '<span class="selo-status s-ok">concluída</span>' +
                  (o.concluida_por ? '<div class="ajuda">' + esc(o.concluida_por) + '</div>' : '')
                : '<span class="selo-status s-neutro">' + esc(o.situacao) + '</span>') + '</td>' +
              '<td style="text-align:right">' +
                (o.situacao === 'pendente'
                  ? '<button data-concluir-emp="' + o.id + '">Concluir</button>'
                  : '<button data-reabrir="' + o.id + '">Reabrir</button>') +
              '</td></tr>';
          }).join('')
        : '<tr><td colspan="5" style="color:var(--texto-2);padding:20px">' +
          'Marque acima o que este cliente entrega e as datas aparecem aqui.</td></tr>';
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('obModelos').onclick = function (ev) {
    var c = ev.target.closest('[data-modelo]');
    if (!c) return;
    var emp = (estado.empresas || []).filter(function (e) { return e.cnpj === estado.editando; })[0];
    if (!emp) return;
    api('/obrigacoes/empresa/' + emp.id + '/modelo/' + c.dataset.modelo, {
      method: 'PUT', body: JSON.stringify({ ativo: c.checked })
    }).then(function () {
      aviso(c.checked ? 'Passou a acompanhar. As próximas datas já entraram na agenda.'
                      : 'Deixou de acompanhar.', 'ok');
      carregarObrigacoesEmpresa(estado.editando);
    }).catch(function (e) { aviso(e.message, 'erro'); c.checked = !c.checked; });
  };

  el('obLista').onclick = function (ev) {
    var b = ev.target.closest('[data-concluir-emp], [data-reabrir]');
    if (!b) return;
    var id = b.dataset.concluirEmp || b.dataset.reabrir;
    var situacao = b.dataset.concluirEmp ? 'concluida' : 'pendente';
    b.disabled = true;
    api('/obrigacoes/' + id, { method: 'PUT', body: JSON.stringify({ situacao: situacao }) })
      .then(function () { carregarObrigacoesEmpresa(estado.editando); })
      .catch(function (e) { aviso(e.message, 'erro'); b.disabled = false; });
  };

  /* ------------------------------------ histórico e pacote do período */

  function carregarHistorico(cnpj) {
    var emp = (estado.empresas || []).filter(function (e) { return e.cnpj === cnpj; })[0];
    if (!emp) return;

    // Período padrão do pacote: o mês corrente, que é o caso comum
    var hoje = new Date();
    if (!el('pkInicio').value) {
      el('pkInicio').value = hoje.getFullYear() + '-' +
        String(hoje.getMonth() + 1).padStart(2, '0') + '-01';
      el('pkFim').value = hoje.getFullYear() + '-' +
        String(hoje.getMonth() + 1).padStart(2, '0') + '-' +
        String(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate()).padStart(2, '0');
    }

    api('/empresas/' + cnpj + '/historico').then(function (lista) {
      var tb = el('histLista');
      tb.innerHTML = lista.length
        ? lista.map(function (h) {
            return '<tr><td class="mono" style="white-space:nowrap">' +
                esc(fmtDataHora(h.ocorrido_em)) + '</td>' +
              '<td>' + esc(h.autor) +
                (h.origem === 'api' ? '<div class="ajuda">por integração</div>' : '') + '</td>' +
              '<td>' + esc(h.descricao) +
                (h.referencia ? '<div class="ajuda mono">' + esc(h.referencia) + '</div>' : '') +
              '</td></tr>';
          }).join('')
        : '<tr><td colspan="3" style="color:var(--texto-2);padding:20px">' +
          'Nada registrado ainda. A partir de agora, emissões, cancelamentos e mudanças ' +
          'de configuração aparecem aqui.</td></tr>';
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnPacote').onclick = function () {
    var inicio = el('pkInicio').value;
    var fim = el('pkFim').value;
    if (!inicio || !fim) return aviso('Escolha o período.', 'erro');
    if (fim < inicio) return aviso('A data final é anterior à inicial.', 'erro');

    var b = el('btnPacote');
    b.disabled = true;
    b.textContent = 'Preparando…';

    var url = '/nfse/pacote?cnpjEmpresa=' + encodeURIComponent(estado.editando) +
              '&inicio=' + inicio + '&fim=' + fim +
              (el('pkPdf').checked ? '' : '&pdf=0');

    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (d) { throw new Error(d.erro || 'Falhou'); });
        }
        var total = r.headers.get('X-Total-Notas');
        return r.blob().then(function (blob) { return { blob: blob, total: total }; });
      })
      .then(function (r) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(r.blob);
        a.download = 'notas-' + estado.editando + '-' + inicio + '-a-' + fim + '.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        aviso(r.total + ' nota(s) no pacote.', 'ok');
        carregarHistorico(estado.editando);
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Baixar pacote'; });
  };

  /* ========================== Identidade do escritório =======================
     A marca aparece no painel, na tela de acesso e nos relatórios entregues ao
     cliente. Fora do DANFSe, que é documento fiscal da empresa prestadora. */

  /* Deriva o tema a partir de uma cor só. Pedir seis cores a quem quer apenas
     "colocar a marca da empresa" é o caminho para uma tela desmontada. */
  function aplicarMarca(m) {
    if (!m) return;
    var raiz = document.documentElement;

    if (m.corAcento || m.cor_acento) {
      var cor = m.corAcento || m.cor_acento;
      raiz.style.setProperty('--acento', cor);
      raiz.style.setProperty('--marca', escurecer(cor, 0.26));
      raiz.style.setProperty('--marca-2', escurecer(cor, 0.4));
      raiz.style.setProperty('--acento-suave', clarear(cor, 0.9));
      raiz.style.setProperty('--acento-fg', contrasteClaro(cor) ? '#ffffff' : '#10161f');
    }

    var nome = m.nome;
    if (nome) {
      var alvo = document.querySelector('.marca .nome');
      if (alvo) alvo.textContent = nome;
      var acesso = document.querySelector('.marca-grande h1');
      if (acesso) acesso.textContent = nome;
      document.title = nome + ' · NFS-e';
    }
    var desc = m.descricao;
    if (desc) {
      var sub = document.querySelector('.marca .versao');
      if (sub) sub.textContent = desc;
      var subAcesso = document.querySelector('.marca-grande div[style*="texto-3"]');
      if (subAcesso) subAcesso.textContent = desc;
    }

    if (m.temLogo || m.tem_logo) {
      /* A logo substitui o quadrado "NF". Fundo transparente e altura fixa: o
         que varia entre logos é a largura, e esticar a imagem é pior que
         deixá-la pequena. */
      document.querySelectorAll('.logo').forEach(function (caixa) {
        caixa.innerHTML = '<img src="/marca/logo" alt="' + esc(nome || 'Logo') + '">';
        // A classe muda o arranjo do bloco inteiro; o CSS cuida do resto
        if (caixa.parentElement) caixa.parentElement.classList.add('com-logo');
      });
    }
  }

  function corParaRgb(hex) {
    var h = String(hex).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function paraHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('');
  }
  function escurecer(hex, quanto) {
    var c = corParaRgb(hex);
    return paraHex(c[0] * (1 - quanto), c[1] * (1 - quanto), c[2] * (1 - quanto));
  }
  function clarear(hex, quanto) {
    var c = corParaRgb(hex);
    return paraHex(c[0] + (255 - c[0]) * quanto, c[1] + (255 - c[1]) * quanto,
                   c[2] + (255 - c[2]) * quanto);
  }
  /* Texto branco só quando o fundo é escuro o bastante para sustentá-lo. */
  function contrasteClaro(hex) {
    var c = corParaRgb(hex);
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 < 150;
  }

  function carregarMarca() {
    return fetch('/marca', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (m) { estado.marca = m; aplicarMarca(m); })
      .catch(function () { /* sem marca, o padrão serve */ });
  }

  function carregarIdentidade() {
    api('/identidade').then(function (i) {
      el('idNome').value = i.nome || '';
      el('idDescricao').value = i.descricao || '';
      el('idRodape').value = i.rodape || '';
      el('idSite').value = i.site || '';
      el('idTelefone').value = i.telefone || '';
      el('idEmail').value = i.email || '';
      var cor = i.cor_acento || '#2563eb';
      el('idCor').value = cor;
      el('idCorTexto').value = cor;

      var pv = el('idPreview');
      if (i.tem_logo) {
        pv.innerHTML = '<img src="/marca/logo?t=' + Date.now() +
          '" style="max-width:100%;max-height:100%;object-fit:contain">';
        el('btnRemoverLogo').hidden = false;
      } else {
        pv.textContent = 'sem logo';
        el('btnRemoverLogo').hidden = true;
      }
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  // Os dois campos de cor andam juntos: o seletor para escolher, o texto para
  // colar o código que veio do manual de marca
  el('idCor').oninput = function () { el('idCorTexto').value = el('idCor').value; };
  el('idCorTexto').oninput = function () {
    var v = el('idCorTexto').value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) el('idCor').value = v[0] === '#' ? v : '#' + v;
  };

  el('btnSalvarIdentidade').onclick = function () {
    var b = el('btnSalvarIdentidade');
    b.disabled = true;
    api('/identidade', { method: 'PUT', body: JSON.stringify({
      nome: el('idNome').value,
      descricao: el('idDescricao').value,
      corAcento: el('idCorTexto').value || el('idCor').value,
      rodape: el('idRodape').value,
      site: el('idSite').value,
      telefone: el('idTelefone').value,
      email: el('idEmail').value
    })}).then(function () {
      aviso('Identidade salva.', 'ok');
      return carregarMarca();
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  el('btnEscolherLogo').onclick = function () { el('idArquivo').click(); };

  el('idArquivo').onchange = function () {
    var arquivo = el('idArquivo').files[0];
    if (!arquivo) return;
    var fd = new FormData();
    fd.append('logo', arquivo);
    // FormData sem content-type: quem monta o boundary é o navegador
    api('/identidade/logo', { method: 'POST', body: fd })
      .then(function () {
        aviso('Logo atualizada.', 'ok');
        el('idArquivo').value = '';
        carregarIdentidade();
        return carregarMarca();
      })
      .catch(function (e) { aviso(e.message, 'erro'); el('idArquivo').value = ''; });
  };

  el('btnRemoverLogo').onclick = function () {
    if (!confirm('Remover a logo do escritório?')) return;
    api('/identidade/logo', { method: 'DELETE' }).then(function () {
      aviso('Logo removida.', 'ok');
      carregarIdentidade();
      // Volta o quadrado padrão sem exigir recarga da página
      document.querySelectorAll('.logo').forEach(function (c) {
        c.style.background = ''; c.style.width = ''; c.textContent = 'NF';
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* ============================ E-mail e avisos =============================
     Configuração do envio e do resumo diário de prazos. O resumo leva os
     compromissos anexados em .ics: é assim que o prazo chega ao celular sem
     precisar expor o gateway na internet. */

  function preencherProvedores(provedores) {
    var sel = el('emProvedor');
    if (sel.options.length) return;
    Object.keys(provedores).forEach(function (chave) {
      var o = document.createElement('option');
      o.value = chave;
      o.textContent = provedores[chave].nome;
      sel.appendChild(o);
    });
    estado.provedoresEmail = provedores;
  }

  el('emProvedor').onchange = function () {
    var p = (estado.provedoresEmail || {})[el('emProvedor').value];
    if (!p) return;
    // "Outro" não sobrescreve o que a pessoa já digitou
    if (p.host) {
      el('emHost').value = p.host;
      el('emPorta').value = p.porta;
      el('emSeguro').value = String(p.seguro);
    }
    el('emAjudaProvedor').textContent = p.ajuda || '';
  };

  function carregarEmail() {
    // Horas do resumo, uma vez
    var h = el('emResumoHora');
    if (!h.options.length) {
      for (var i = 0; i < 24; i++) {
        var o = document.createElement('option');
        o.value = i;
        o.textContent = String(i).padStart(2, '0') + ':00';
        h.appendChild(o);
      }
    }

    api('/email').then(function (d) {
      preencherProvedores(d.provedores || {});
      var c = d.config || {};
      el('emHost').value = c.host || '';
      el('emPorta').value = c.porta || 587;
      el('emSeguro').value = String(!!c.seguro);
      el('emUsuario').value = c.usuario || '';
      el('emRemetente').value = c.remetente || '';
      el('emAtivo').checked = !!c.ativo;
      el('emResumoPara').value = c.resumo_para || '';
      el('emResumoHora').value = c.resumo_hora != null ? c.resumo_hora : 8;
      el('emResumoAtivo').checked = !!c.resumo_diario;
      el('emSenha').value = '';

      el('emSenhaEstado').textContent = c.tem_senha
        ? 'Uma senha já está guardada. Deixe em branco para mantê-la.'
        : 'Nenhuma senha guardada.';

      // Adivinha o provedor pelo host, para a ajuda certa aparecer
      var achou = Object.keys(d.provedores || {}).filter(function (k) {
        return d.provedores[k].host && d.provedores[k].host === c.host;
      })[0];
      el('emProvedor').value = achou || 'outro';
      el('emAjudaProvedor').textContent = achou ? d.provedores[achou].ajuda : '';

      var partes = [];
      if (!c.ativo && d.emUso) partes.push('Em uso pela configuração do arquivo .env.');
      if (c.testado_em) {
        partes.push(c.ultimo_erro
          ? 'Último teste em ' + fmtDataHora(c.testado_em) + ' falhou: ' + c.ultimo_erro
          : 'Último teste em ' + fmtDataHora(c.testado_em) + ': funcionou.');
      }
      el('emResultado').textContent = partes.join(' ');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  function corpoEmail() {
    return {
      host: el('emHost').value,
      porta: Number(el('emPorta').value),
      seguro: el('emSeguro').value === 'true',
      usuario: el('emUsuario').value,
      remetente: el('emRemetente').value,
      ativo: el('emAtivo').checked,
      resumoPara: el('emResumoPara').value,
      resumoHora: Number(el('emResumoHora').value),
      resumoDiario: el('emResumoAtivo').checked,
      // Vazio significa "manter a que está guardada", não "apagar"
      senha: el('emSenha').value || undefined
    };
  }

  function salvarEmail() {
    return api('/email', { method: 'PUT', body: JSON.stringify(corpoEmail()) });
  }

  el('btnSalvarEmail').onclick = function () {
    var b = el('btnSalvarEmail');
    b.disabled = true;
    salvarEmail()
      .then(function () { aviso('Configuração salva.', 'ok'); carregarEmail(); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; });
  };

  el('btnTestarEmail').onclick = function () {
    var destino = el('emTeste').value.trim();
    if (!destino) return aviso('Informe um endereço para receber o teste.', 'erro');

    var b = el('btnTestarEmail');
    b.disabled = true; b.textContent = 'Enviando…';
    el('emResultado').textContent = '';

    /* Salva antes de testar: testar o que está na tela, e não o que está
       gravado, é o que a pessoa espera de um botão ao lado dos campos. */
    salvarEmail()
      .then(function () {
        return api('/email/testar', { method: 'POST', body: JSON.stringify({ para: destino }) });
      })
      .then(function (r) {
        el('emResultado').textContent =
          'Enviado para ' + r.destino + ' por ' + r.servidor + '. Confira a caixa de entrada.';
        aviso('E-mail de teste enviado.', 'ok');
        carregarEmail();
      })
      .catch(function (e) { aviso(e.message, 'erro'); carregarEmail(); })
      .then(function () { b.disabled = false; b.textContent = 'Enviar teste'; });
  };

  el('btnResumoAgora').onclick = function () {
    var b = el('btnResumoAgora');
    b.disabled = true; b.textContent = 'Enviando…';
    salvarEmail()
      .then(function () { return api('/email/resumo', { method: 'POST' }); })
      .then(function (r) {
        el('emResumoResultado').textContent = r.enviado
          ? r.prazos + ' prazo(s) enviados para ' + r.destino +
            (r.atrasadas ? ' — ' + r.atrasadas + ' atrasada(s).' : '.')
          : 'Nada enviado: ' + r.motivo + '.';
        if (r.enviado) aviso('Resumo enviado.', 'ok');
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Enviar o resumo agora'; });
  };

  function aba(nome) {
    $$('#abas button').forEach(function (b) { b.classList.toggle('ativo', b.dataset.aba === nome); });
    ['visao','identificacao','endereco','contato','responsavel','contabilidade','fiscais','obrigacoes','historico','certificado','integracao']
      .forEach(function (p) { el('aba-' + p).classList.toggle('ativo', p === nome); });
    // Numeração, certificado e integração gravam por conta própria
    el('acoesEmpresa').style.display =
      (nome === 'visao' || nome === 'fiscais' || nome === 'obrigacoes' ||
       nome === 'historico' || nome === 'certificado' || nome === 'integracao')
        ? 'none' : '';
    if (nome === 'integracao' && estado.editando) carregarIntegracao(estado.editando);
    if (nome === 'visao' && estado.editando) carregarVisaoGeral(estado.editando);
    if (nome === 'fiscais' && estado.editando) carregarPadroesFiscais(estado.editando);
    if (nome === 'obrigacoes' && estado.editando) carregarObrigacoesEmpresa(estado.editando);
    if (nome === 'historico' && estado.editando) carregarHistorico(estado.editando);
  }
  el('abas').onclick = function (ev) {
    var b = ev.target.closest('button');
    if (b && !b.disabled) aba(b.dataset.aba);
  };

  function travarAbasNovas(novo) {
    $$('#abas button').forEach(function (b) {
      if (b.dataset.precisaSalvar) {
        b.disabled = novo;
        b.title = novo ? 'Disponível após salvar a empresa' : '';
      }
    });
  }

  var CAMPOS = ['f_cnpj','f_razao','f_fantasia','f_im','f_ie','f_mun','f_uf','f_cep','f_lgr','f_num',
                'f_cpl','f_bairro','f_email','f_tel','f_respnome','f_respcpf','f_contador',
                'f_serie_h','f_num_h','f_serie_p','f_num_p','f_senha'];

  function limparFormulario() {
    CAMPOS.forEach(function (i) { el(i).value = ''; });
    el('f_pfx').value = '';
    el('f_simp').value = '1'; el('f_regesp').value = '0';
    el('f_amb').value = 'homologacao'; el('f_ativo').value = 'true';
    el('f_email_tom').value = 'false';
    el('certAtual').innerHTML = '';
  }

  el('btnNovaEmp').onclick = function () {
    limparFormulario(); estado.editando = null;
    el('f_cnpj').disabled = false; el('wrapAtivo').hidden = true;
    el('blocoAmbiente').hidden = true;
    el('wrapAmbienteNovo').hidden = false;
    travarAbasNovas(true); aba('identificacao');
    TELAS.empresaEdit.titulo = 'Nova empresa';
    TELAS.empresaEdit.sub = 'Numeração, certificado e integração ficam disponíveis após salvar';
    location.hash = 'empresaEdit';
  };
  el('btnVoltarEmp').onclick = el('btnCancelarEmp').onclick = function () { location.hash = 'empresas'; };
  el('btnRecarregarEmp').onclick = carregarEmpresas;

  function abrirEmpresa(cnpj) {
    limparFormulario(); estado.editando = cnpj;
    el('f_cnpj').disabled = true; el('wrapAtivo').hidden = false;
    travarAbasNovas(false); aba('visao');

    api('/empresas/' + cnpj).then(function (e) {
      TELAS.empresaEdit.titulo = e.razao_social;
      TELAS.empresaEdit.sub = fmtDoc(e.cnpj) + ' · ' + nomeAmbiente(e.ambiente);
      el('tituloTela').textContent = TELAS.empresaEdit.titulo;
      el('subtituloTela').textContent = TELAS.empresaEdit.sub;

      el('f_cnpj').value = e.cnpj;
      el('f_razao').value = e.razao_social || '';
      el('f_fantasia').value = e.nome_fantasia || '';
      el('f_im').value = e.inscricao_municipal || '';
      el('f_ie').value = e.inscricao_estadual || '';
      el('f_simp').value = String(e.op_simp_nac);
      el('f_regesp').value = String(e.reg_esp_trib);
      el('f_amb').value = e.ambiente;
      el('f_ativo').value = String(e.ativo);
      el('f_mun').value = e.codigo_municipio || '';
      el('f_uf').value = e.uf || '';
      el('f_cep').value = e.cep || '';
      el('f_lgr').value = e.logradouro || '';
      el('f_num').value = e.numero || '';
      el('f_cpl').value = e.complemento || '';
      el('f_bairro').value = e.bairro || '';
      el('f_email').value = e.email || '';
      el('f_tel').value = e.telefone || '';
      el('f_respnome').value = e.responsavel_nome || '';
      el('f_respcpf').value = e.responsavel_cpf || '';
      el('f_contador').value = e.contador_doc || '';
      el('f_email_tom').value = e.email_tomador_ativo ? 'true' : 'false';
      preencherPortalEmpresa(e);
      carregarWhatsapp();

      var lista = estado.empresas.filter(function (x) { return x.cnpj === cnpj; })[0];
      el('certAtual').innerHTML = 'Certificado atual: ' +
        seloCertificado(lista && lista.certificado_valido_ate) +
        (lista && lista.certificado_subject
          ? '<div class="ajuda" style="margin-top:6px">' + esc(lista.certificado_subject) + '</div>' : '');
    }).catch(function (e) { aviso(e.message, 'erro'); });

    api('/empresas/' + cnpj + '/numeracao').then(function (linhas) {
      api('/empresas/' + cnpj).then(function (e) { montarBlocoAmbiente(e, linhas); })
        .catch(function () {});
      (linhas || []).forEach(function (n) {
        if (n.ambiente === 'homologacao') { el('f_serie_h').value = n.serie; el('f_num_h').value = n.prox_numero; }
        else { el('f_serie_p').value = n.serie; el('f_num_p').value = n.prox_numero; }
      });
    }).catch(function () {});

    location.hash = 'empresaEdit';
  }

  function coletarEmpresa() {
    return {
      razaoSocial: el('f_razao').value.trim(),
      nomeFantasia: el('f_fantasia').value.trim() || null,
      inscricaoMunicipal: el('f_im').value.trim() || null,
      inscricaoEstadual: el('f_ie').value.trim() || null,
      codigoMunicipio: el('f_mun').value.trim(),
      opSimpNac: Number(el('f_simp').value),
      regEspTrib: Number(el('f_regesp').value),
      ambiente: el('f_amb').value,
      cep: digitos(el('f_cep').value) || null,
      logradouro: el('f_lgr').value.trim() || null,
      numero: el('f_num').value.trim() || null,
      complemento: el('f_cpl').value.trim() || null,
      bairro: el('f_bairro').value.trim() || null,
      uf: el('f_uf').value.trim().toUpperCase() || null,
      email: el('f_email').value.trim() || null,
      telefone: el('f_tel').value.trim() || null,
      responsavelNome: el('f_respnome').value.trim() || null,
      responsavelCpf: digitos(el('f_respcpf').value) || null,
      contadorDoc: docLimpo(el('f_contador').value) || null,
      emailTomadorAtivo: el('f_email_tom').value === 'true'
    };
  }

  el('btnSalvarEmp').onclick = function () {
    var cnpj = docLimpo(el('f_cnpj').value);
    if (!estado.editando && cnpj.length !== 14) { aba('identificacao'); return aviso('CNPJ deve ter 14 dígitos.', 'erro'); }
    var corpo = coletarEmpresa();
    if (!corpo.razaoSocial) { aba('identificacao'); return aviso('Razão social é obrigatória.', 'erro'); }
    if (!/^\d{7}$/.test(corpo.codigoMunicipio)) { aba('endereco'); return aviso('Código do município deve ter 7 dígitos (IBGE).', 'erro'); }
    if (estado.editando) {
      corpo.ativo = el('f_ativo').value === 'true';
      // Ambiente não vai junto: quem edita troca pelo bloco próprio, que exige
      // confirmação. Mandar aqui permitiria contornar essa proteção.
      delete corpo.ambiente;
    } else {
      corpo.cnpj = cnpj;
    }

    el('btnSalvarEmp').disabled = true;
    api(estado.editando ? '/empresas/' + estado.editando : '/empresas', {
      method: estado.editando ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (r) {
      if (!estado.editando && r.tokens) {
        aviso('Empresa cadastrada. Tokens de API gerados — veja na aba Integração.');
      } else {
        aviso('Empresa atualizada.');
      }
      location.hash = 'empresas';
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { el('btnSalvarEmp').disabled = false; });
  };

  el('btnBuscaCnpj').onclick = function () {
    var cnpj = docLimpo(el('f_cnpj').value);
    if (cnpj.length !== 14) return aviso('Digite o CNPJ (14 dígitos) antes de buscar.', 'erro');
    var b = el('btnBuscaCnpj');
    b.disabled = true; b.textContent = 'Buscando…';
    api('/consulta/cnpj/' + cnpj).then(function (d) {
      var por = function (id, v) { if (v != null && v !== '' && !el(id).value) el(id).value = v; };
      por('f_razao', d.razaoSocial); por('f_fantasia', d.nomeFantasia);
      por('f_mun', d.codigoMunicipio); por('f_uf', d.uf); por('f_cep', d.cep);
      por('f_lgr', d.logradouro); por('f_num', d.numero); por('f_cpl', d.complemento);
      por('f_bairro', d.bairro); por('f_tel', d.telefone); por('f_email', d.email);
      aviso('Dados de ' + (d.razaoSocial || 'empresa') + ' preenchidos. Confira antes de salvar.');
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Buscar'; });
  };

  el('f_cep').onblur = function () {
    var cep = digitos(el('f_cep').value);
    if (cep.length !== 8) return;
    api('/consulta/cep/' + cep).then(function (d) {
      if (d.logradouro) el('f_lgr').value = d.logradouro;
      if (d.bairro) el('f_bairro').value = d.bairro;
      if (d.uf) el('f_uf').value = d.uf;
      if (d.codigoMunicipio) el('f_mun').value = d.codigoMunicipio;
      aviso('Endereço preenchido pelo CEP (' + (d.municipioNome||'') + '/' + (d.uf||'') + ').');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  };

  $$('#aba-fiscais button[data-amb]').forEach(function (btn) {
    btn.onclick = function () {
      if (!estado.editando) return;
      var amb = btn.dataset.amb, h = amb === 'homologacao';
      btn.disabled = true;
      api('/empresas/' + estado.editando + '/numeracao', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          ambiente: amb,
          serie: (h ? el('f_serie_h') : el('f_serie_p')).value.trim() || '1',
          proxNumero: Number((h ? el('f_num_h') : el('f_num_p')).value) || 1
        })
      }).then(function (r) {
        aviso('Numeração de ' + (h?'homologação':'produção') + ' salva: série ' + r.serie + ', próximo ' + r.prox_numero + '.');
      }).catch(function (e) { aviso(e.message, 'erro'); })
        .then(function () { btn.disabled = false; });
    };
  });

  el('btnCert').onclick = function () {
    if (!estado.editando) return;
    var arquivo = el('f_pfx').files[0];
    if (!arquivo) return aviso('Selecione o arquivo .pfx.', 'erro');
    if (!el('f_senha').value) return aviso('Informe a senha do certificado.', 'erro');
    var fd = new FormData();
    fd.append('certificado', arquivo); fd.append('senha', el('f_senha').value);
    el('btnCert').disabled = true;
    api('/empresas/' + estado.editando + '/certificado', { method:'POST', body: fd })
      .then(function (r) {
        el('f_pfx').value = ''; el('f_senha').value = '';
        el('certAtual').innerHTML = 'Certificado atual: ' + seloCertificado(r.validoAte) +
          (r.subject ? '<div class="ajuda" style="margin-top:6px">' + esc(r.subject) + '</div>' : '');
        aviso('Certificado cadastrado. Titular: ' + (r.cnpjCertificado||'—') + ' · válido até ' + fmtData(r.validoAte));
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { el('btnCert').disabled = false; });
  };

  function carregarIntegracao(cnpj) {
    el('intResumo').innerHTML = '<div class="ajuda">Carregando…</div>';
    api('/integracao/' + cnpj).then(function (d) {
      el('intResumo').innerHTML =
        '<dl class="kv">' +
        '<dt>URL base</dt><dd class="mono">' + esc(d.baseUrl) + '</dd>' +
        '<dt>Autenticação</dt><dd>header <span class="mono">' + esc(d.autenticacao.header) + '</span></dd>' +
        '<dt>Certificado</dt><dd>' + (d.empresa.certificadoOk
          ? '<span class="selo-status s-ok">configurado</span>'
          : '<span class="selo-status s-erro">ausente — a emissão vai falhar</span>') + '</dd></dl>';

      el('intTokens').innerHTML = '';
      d.tokens.forEach(function (t) {
        var linha = document.createElement('div');
        linha.style.cssText = 'display:flex;gap:9px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
        linha.innerHTML =
          '<span class="selo-status ' + (t.ambiente==='producao'?'s-erro':'s-info') +
          ' sem-ponto" style="min-width:100px;justify-content:center">' + esc(nomeAmbiente(t.ambiente)) + '</span>' +
          '<input class="mono" readonly value="' + esc(t.token) + '" style="flex:1;min-width:210px">';
        var copiar = document.createElement('button');
        copiar.className = 'pequeno'; copiar.textContent = 'Copiar';
        copiar.onclick = function () { navigator.clipboard.writeText(t.token).then(function(){ aviso('Token copiado.'); }); };
        var novo = document.createElement('button');
        novo.className = 'pequeno'; novo.textContent = 'Gerar novo';
        novo.onclick = function () {
          if (!confirm('Gerar novo token de ' + nomeAmbiente(t.ambiente) + '?\n\n' +
                       'O token atual para de funcionar imediatamente.')) return;
          api('/integracao/' + cnpj + '/tokens', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ ambiente: t.ambiente })
          }).then(function () { aviso('Novo token gerado.'); carregarIntegracao(cnpj); })
            .catch(function (e) { aviso(e.message, 'erro'); });
        };
        linha.appendChild(copiar); linha.appendChild(novo);
        el('intTokens').appendChild(linha);
      });

      el('intEndpoints').innerHTML = Object.keys(d.endpoints).map(function (k) {
        var e = d.endpoints[k];
        return '<div><span class="selo-status s-neutro sem-ponto">' + e.metodo + '</span> ' + esc(e.url) + '</div>';
      }).join('');
      el('intExemplo').textContent = d.exemplo.curl;
    }).catch(function (e) {
      el('intResumo').innerHTML = '<div class="aviso erro">' + esc(e.message) + '</div>';
    });
  }

  /* ----------------------------------------------------------------- notas */

  function carregarNotas() {
    var q = [];
    if (el('nf_empresa').value) q.push('cnpjEmpresa=' + encodeURIComponent(el('nf_empresa').value));
    if (el('nf_status').value) q.push('status=' + encodeURIComponent(el('nf_status').value));
    if (el('nf_ambiente').value) q.push('ambiente=' + encodeURIComponent(el('nf_ambiente').value));
    if (el('nf_ref').value.trim()) q.push('referencia=' + encodeURIComponent(el('nf_ref').value.trim()));
    api('/nfse' + (q.length ? '?' + q.join('&') : '')).then(function (linhas) {
      var tb = el('corpoNotas'); tb.innerHTML = '';
      alternarVazio('corpoNotas', 'vazioNotas', linhas.length);
      linhas.forEach(function (n) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + n.id + '</td>' +
          '<td class="mono">' + fmtDoc(n.cnpj_empresa) + '</td>' +
          '<td class="mono">' + esc(n.serie) + '/' + esc(n.numero) + '</td>' +
          '<td>' + seloAmbiente(n.ambiente) + '</td>' +
          '<td>' + seloStatus(n.status) + (n.tentativas > 1 ? ' <span class="ajuda">' + n.tentativas + 'x</span>' : '') + '</td>' +
          '<td>' + esc(n.referencia || '—') + '</td>' +
          '<td style="color:var(--texto-2)">' + fmtDataHora(n.criado_em) + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno'; b.textContent = 'Ver';
        b.onclick = function () { abrirNota(n.id); };
        tr.lastChild.appendChild(b);

        // Baixar direto da lista: quem precisa de vinte PDFs não deveria abrir
        // vinte diálogos para isso.
        if (n.status === 'autorizada' || n.status === 'cancelada' || n.status === 'substituida') {
          var pdf = document.createElement('button');
          pdf.className = 'pequeno'; pdf.textContent = 'PDF';
          pdf.title = 'Baixar o DANFSe';
          pdf.style.marginLeft = '6px';
          pdf.onclick = function () {
            baixar('/nfse/' + n.id + '/danfse', 'DANFSe-' + (n.chave_acesso || n.id) + '.pdf');
          };
          var xml = document.createElement('button');
          xml.className = 'pequeno'; xml.textContent = 'XML';
          xml.title = 'Baixar o XML autorizado';
          xml.style.marginLeft = '4px';
          xml.onclick = function () {
            baixar('/nfse/' + n.id + '/xml', (n.chave_acesso || n.id) + '.xml');
          };
          tr.lastChild.appendChild(pdf);
          tr.lastChild.appendChild(xml);
        }
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }
  el('btnFiltrarNotas').onclick = carregarNotas;

  function abrirNota(id) {
    api('/nfse/local/' + id).then(function (n) {
      estado.notaAtual = n;
      el('notaTitulo').textContent = 'Nota ' + n.id + ' — série ' + n.serie + '/' + n.numero;
      el('notaSub').textContent = 'ID DPS: ' + n.id_dps;
      el('notaKv').innerHTML =
        '<dt>Status</dt><dd>' + seloStatus(n.status) + '</dd>' +
        '<dt>Ambiente</dt><dd>' + seloAmbiente(n.ambiente) + '</dd>' +
        '<dt>Referência</dt><dd>' + esc(n.referencia || '—') + '</dd>' +
        '<dt>Chave de acesso</dt><dd class="mono">' + esc(n.chave_acesso || '—') + '</dd>' +
        '<dt>Criada em</dt><dd>' + fmtDataHora(n.criado_em) + '</dd>';
      el('notaErroBox').innerHTML = n.ultimo_erro
        ? '<div class="aviso erro">' + esc(n.ultimo_erro) + '</div>' : '';
      var temDoc = !!n.nfse_xml;
      el('notaBaixarXml').disabled = !temDoc;
      el('notaBaixarPdf').disabled = !temDoc;
      // Só nota autorizada pode ser cancelada; substituída já foi cancelada junto
      var podeOperar = n.status === 'autorizada' && !!n.chave_acesso;
      el('notaCancelar').hidden = !podeOperar;
      // Substituir é o que faz o papel de "alterar": a NFS-e não se altera
      el('notaSubstituir').hidden = !podeOperar;
      mostrarXml('dps');
      el('dlgNota').showModal();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  /* Indenta o XML só para leitura na tela. O XML que o operador baixa é sempre o
     original — reformatar um documento assinado quebraria a assinatura. */
  function formatarXml(xml) {
    if (!xml) return xml;
    var nivel = 0;
    return xml.replace(/>\s*</g, '>\n<').split('\n').map(function (linha) {
      if (/^<\/[^>]+>/.test(linha)) nivel = Math.max(0, nivel - 1);
      var saida = new Array(nivel + 1).join('  ') + linha;
      // Abre nível só em tag de abertura que não fecha na mesma linha
      if (/^<[^/?!][^>]*[^/]>$/.test(linha) && !/^<[^>]+>.*<\/[^>]+>$/.test(linha)) nivel++;
      return saida;
    }).join('\n');
  }

  function mostrarXml(qual) {
    $$('#notaAbas button').forEach(function (b) { b.classList.toggle('ativo', b.dataset.xml === qual); });
    var n = estado.notaAtual || {};
    var texto = '—';
    if (qual === 'dps') texto = n.dps_xml ? formatarXml(n.dps_xml) : '(DPS não disponível)';
    else if (qual === 'nfse') texto = n.nfse_xml ? formatarXml(n.nfse_xml) : '(NFS-e ainda não autorizada)';
    else texto = n.mensagens ? JSON.stringify(n.mensagens, null, 2) : '(sem retorno registrado)';
    el('notaXml').textContent = texto;
  }
  el('notaAbas').onclick = function (ev) {
    var b = ev.target.closest('button'); if (b) mostrarXml(b.dataset.xml);
  };
  el('notaFechar').onclick = function () { el('dlgNota').close(); };

  function baixar(caminho, nomeArquivo) {
    fetch(caminho, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('Documento indisponível'); return r.blob(); })
      .then(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b); a.download = nomeArquivo;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      }).catch(function (e) { aviso(e.message, 'erro'); });
  }
  el('notaBaixarXml').onclick = function () {
    var n = estado.notaAtual; baixar('/nfse/' + n.id + '/xml', (n.chave_acesso || n.id) + '.xml');
  };
  el('notaBaixarPdf').onclick = function () {
    var n = estado.notaAtual; baixar('/nfse/' + n.id + '/danfse', 'DANFSe-' + (n.chave_acesso || n.id) + '.pdf');
  };

  /* Substituição.
     A NFS-e não tem "alterar": corrigir é emitir uma nova em substituição, e a
     Sefin cancela a original sozinha (evento E0840, "cancelamento por
     substituição"). Por isso a tela parte dos dados da nota original — o
     comum é mudar um campo e manter o resto. */
  el('notaSubstituir').onclick = function () {
    var n = estado.notaAtual;
    if (!n || !n.chave_acesso) {
      return aviso('Só é possível substituir nota autorizada.', 'erro');
    }
    var v = valoresDoXml(n.dps_xml);

    el('subOriginal').innerHTML =
      'Substituindo a nota <strong>' + esc(n.serie) + '/' + esc(n.numero) + '</strong>' +
      ' de ' + fmtDataHora(n.criado_em) +
      '<div class="mono" style="font-size:11.5px;margin-top:5px">' + esc(n.chave_acesso) + '</div>';

    el('sb_doc').value = v.docTomador || '';
    el('sb_nome').value = v.tomador || '';
    el('sb_codigo').value = v.codigoTributacao || '';
    el('sb_servico').value = v.descricao || '';
    el('sb_valor').value = v.valorServico != null ? v.valorServico : '';
    el('sb_aliquota').value = v.aliquota != null ? v.aliquota : '';
    el('sb_motivo').value = '99';
    el('sb_descricao').value = '';

    el('dlgNota').close();
    el('dlgSubstituir').showModal();
  };

  /* Lê da DPS original os campos que a substituta reaproveita. */
  function valoresDoXml(xml) {
    if (!xml) return {};
    var pega = function (tag) {
      var m = xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
      return m ? m[1] : null;
    };
    var toma = (xml.match(/<toma>[\s\S]*?<\/toma>/) || [''])[0];
    var pegaToma = function (tag) {
      var m = toma.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
      return m ? m[1] : null;
    };
    return {
      docTomador: pegaToma('CNPJ') || pegaToma('CPF'),
      tomador: pegaToma('xNome'),
      codigoTributacao: pega('cTribNac'),
      descricao: pega('xDescServ'),
      valorServico: pega('vServ') ? Number(pega('vServ')) : null,
      aliquota: pega('pAliq') ? Number(pega('pAliq')) : null,
      municipioTomador: (toma.match(/<cMun>([^<]*)</) || [])[1] || null
    };
  }

  el('subCancelar').onclick = function () { el('dlgSubstituir').close(); };

  el('formSubstituir').onsubmit = function (ev) {
    ev.preventDefault();
    var n = estado.notaAtual;
    var motivo = el('sb_motivo').value;
    var descricao = el('sb_descricao').value.trim();

    if (motivo === '99' && !descricao) {
      return aviso('Descreva o motivo quando escolher "Outros".', 'erro');
    }
    if (!/^\d{6}$/.test(digitos(el('sb_codigo').value))) {
      return aviso('O código de tributação tem 6 dígitos.', 'erro');
    }
    if (!el('sb_servico').value.trim()) return aviso('Descreva o serviço.', 'erro');
    var valor = Number(el('sb_valor').value);
    if (!valor || valor <= 0) return aviso('Informe o valor do serviço.', 'erro');

    var empresa = estado.empresas.filter(function (e) { return e.cnpj === n.cnpj_empresa; })[0];
    var producao = empresa && empresa.ambiente === 'producao';

    if (!confirm('Substituir a nota ' + n.serie + '/' + n.numero + '?\n\n' +
                 'A original será CANCELADA pela Sefin e uma nova será emitida ' +
                 'no lugar, com ' + fmtMoeda(valor) + '.' +
                 (producao ? '\n\nEM PRODUÇÃO: as duas têm valor fiscal.' : ''))) return;

    var doc = docLimpo(el('sb_doc').value);
    var corpo = {
      cnpjEmpresa: n.cnpj_empresa,
      referencia: 'SUBST-' + n.id + '-' + Date.now().toString().slice(-6),
      substituicao: {
        chaveSubstituida: n.chave_acesso,
        codigoMotivo: Number(motivo),
        motivo: descricao || undefined
      },
      servico: {
        codigoTributacaoNacional: digitos(el('sb_codigo').value),
        descricao: el('sb_servico').value.trim()
      },
      valores: { valorServico: valor }
    };
    if (el('sb_aliquota').value !== '') corpo.valores.aliquotaIss = Number(el('sb_aliquota').value);
    if (doc) {
      corpo.tomador = {};
      if (doc.length === 14) corpo.tomador.cnpj = doc; else corpo.tomador.cpf = doc;
      corpo.tomador.razaoSocial = el('sb_nome').value.trim();
      var v = valoresDoXml(n.dps_xml);
      if (v.municipioTomador) corpo.tomador.endereco = { codigoMunicipio: v.municipioTomador };
    }

    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api('/nfse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (r) {
      el('dlgSubstituir').close();
      aviso('Substituta enviada (nota ' + r.serie + '/' + r.numero + '). ' +
            'A original é cancelada pela Sefin ao autorizar a nova.');
      carregarNotas();
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { botao.disabled = false; });
  };

  el('notaCancelar').onclick = function () {
    var n = estado.notaAtual;
    el('c_chave').value = n.chave_acesso;
    el('c_codigo').value = '1';
    el('c_motivo').value = '';
    el('dlgCancelar').showModal();
  };
  el('cancCancelar').onclick = function () { el('dlgCancelar').close(); };
  el('formCancelar').onsubmit = function (ev) {
    ev.preventDefault();
    var n = estado.notaAtual;
    var codigo = Number(el('c_codigo').value);
    var motivo = el('c_motivo').value.trim();
    if (codigo === 9 && !motivo) return aviso('Descreva o motivo quando escolher "Outros".', 'erro');
    if (!confirm('Cancelar a nota ' + n.serie + '/' + n.numero + ' definitivamente?\n\n' +
                 'O evento vai para a Sefin Nacional e não pode ser desfeito.')) return;
    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api('/nfse/' + n.chave_acesso + '/cancelamento', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ cnpjEmpresa: n.cnpj_empresa, codigoMotivo: codigo, motivo: motivo || undefined })
    }).then(function () {
      el('dlgCancelar').close(); el('dlgNota').close();
      aviso('Nota cancelada na Sefin Nacional.');
      carregarNotas();
    }).catch(function (e) {
      // 422 = a Sefin recusou; o diálogo fica aberto para corrigir o motivo
      aviso('A Sefin recusou o cancelamento. ' + e.message, 'erro');
    }).then(function () { botao.disabled = false; });
  };

  function exportar(tipo, btn) {
    var q = ['tipo=' + tipo];
    if (el('nf_empresa').value) q.push('cnpjEmpresa=' + encodeURIComponent(el('nf_empresa').value));
    if (el('nf_status').value) q.push('status=' + encodeURIComponent(el('nf_status').value));
    if (el('nf_ambiente').value) q.push('ambiente=' + encodeURIComponent(el('nf_ambiente').value));
    btn.disabled = true;
    fetch('/nfse/export?' + q.join('&'), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) throw new Error('Nenhuma nota com XML para os filtros ativos.');
        if (!r.ok) throw new Error('Falha ao exportar.');
        var total = r.headers.get('X-Total-Xmls');
        return r.blob().then(function (b) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(b); a.download = tipo + '-' + new Date().toISOString().slice(0,10) + '.zip';
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(a.href);
          aviso('Exportadas ' + total + ' nota(s).');
        });
      }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { btn.disabled = false; });
  }
  el('btnExpNfse').onclick = function () { exportar('nfse', el('btnExpNfse')); };
  el('btnExpDps').onclick = function () { exportar('dps', el('btnExpDps')); };

  /* Os PDFs são montados um a um na hora — por isso o aviso de espera aqui e o
     teto de quantidade no servidor. */
  function baixarZipPdf(caminho, botao) {
    var texto = botao.textContent;
    botao.disabled = true; botao.textContent = 'Gerando…';
    aviso('Montando os PDFs. Em lotes grandes isso leva alguns minutos.', 'info');
    fetch(caminho, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) throw new Error('Nenhuma nota autorizada para os filtros ativos.');
        if (!r.ok) throw new Error('Falha ao gerar os PDFs.');
        var total = r.headers.get('X-Total-Pdfs');
        return r.blob().then(function (b) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'danfse-' + new Date().toISOString().slice(0, 10) + '.zip';
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(a.href);
          aviso(total + ' PDF(s) no arquivo.');
        });
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { botao.disabled = false; botao.textContent = texto; });
  }

  el('btnExpPdf').onclick = function () {
    var q = [];
    if (el('nf_empresa').value) q.push('cnpjEmpresa=' + encodeURIComponent(el('nf_empresa').value));
    if (el('nf_status').value) q.push('status=' + encodeURIComponent(el('nf_status').value));
    if (el('nf_ambiente').value) q.push('ambiente=' + encodeURIComponent(el('nf_ambiente').value));
    baixarZipPdf('/nfse/export-pdf' + (q.length ? '?' + q.join('&') : ''), el('btnExpPdf'));
  };

  /* -------------------------------------------------------------- clientes */

  function carregarClientes() {
    if (!estado.empresas.length) {
      return api('/empresas').then(function (l) { estado.empresas = l || []; preencherSelectsEmpresa(); carregarClientes(); });
    }
    var empresaId = el('cl_empresa').value || (estado.empresas[0] && estado.empresas[0].id);
    if (!empresaId) return;
    api('/emissor/contexto?empresaId=' + empresaId).then(function (d) {
      var tb = el('corpoClientes'); tb.innerHTML = '';
      alternarVazio('corpoClientes', 'vazioClientes', d.tomadores.length);
      d.tomadores.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + fmtDoc(t.documento) + '</td>' +
          '<td><strong>' + esc(t.razao_social) + '</strong></td>' +
          '<td class="mono">' + esc(t.codigo_municipio || '—') + (t.uf ? '/' + esc(t.uf) : '') + '</td>' +
          '<td>' + esc(t.email || '—') + '</td>' +
          '<td>' + (t.vezes_usado || 0) + '</td>';
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }
  el('cl_empresa').onchange = carregarClientes;

  /* -------------------------------------------------------------- serviços */

  function carregarServicos() {
    if (!estado.empresas.length) {
      return api('/empresas').then(function (l) { estado.empresas = l || []; preencherSelectsEmpresa(); carregarServicos(); });
    }
    var empresaId = el('sv_empresa').value || (estado.empresas[0] && estado.empresas[0].id);
    if (!empresaId) return;
    api('/emissor/contexto?empresaId=' + empresaId).then(function (d) {
      var tb = el('corpoServicos'); tb.innerHTML = '';
      alternarVazio('corpoServicos', 'vazioServicos', d.servicos.length);
      d.servicos.forEach(function (s) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><strong>' + esc(s.apelido) + '</strong></td>' +
          '<td class="mono">' + esc(s.codigo_tributacao) + '</td>' +
          '<td style="color:var(--texto-2)">' + esc(s.descricao) + '</td>' +
          '<td>' + (s.valor_padrao ? fmtMoeda(s.valor_padrao) : '—') + '</td>' +
          '<td>' + (s.vezes_usado || 0) + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno perigo'; b.textContent = 'Remover';
        b.onclick = function () {
          if (!confirm('Remover o serviço "' + s.apelido + '"?')) return;
          api('/emissor/servico/' + s.id, { method:'DELETE' })
            .then(function () { aviso('Serviço removido.'); carregarServicos(); })
            .catch(function (e) { aviso(e.message, 'erro'); });
        };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }
  el('sv_empresa').onchange = carregarServicos;

  el('btnNovoServico').onclick = function () {
    el('formServico').reset();
    el('dlgServico').showModal();
  };
  el('servCancelar').onclick = function () { el('dlgServico').close(); };
  el('formServico').onsubmit = function (ev) {
    ev.preventDefault();
    var empresaId = el('sv_empresa').value || (estado.empresas[0] && estado.empresas[0].id);
    if (!empresaId) return aviso('Cadastre uma empresa antes.', 'erro');
    if (!/^\d{6}$/.test(digitos(el('s_codigo').value))) return aviso('O código de tributação tem 6 dígitos.', 'erro');
    api('/emissor/servico', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        empresaId: Number(empresaId),
        apelido: el('s_apelido').value.trim(),
        codigoTributacao: digitos(el('s_codigo').value),
        descricao: el('s_descricao').value.trim(),
        valorPadrao: el('s_valor').value !== '' ? Number(el('s_valor').value) : null,
        aliquotaIss: el('s_aliquota').value !== '' ? Number(el('s_aliquota').value) : null,
        issRetido: el('s_retido').value === 'true'
      })
    }).then(function () { el('dlgServico').close(); aviso('Serviço salvo.'); carregarServicos(); })
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* ------------------------------------------------------------------ lotes */

  function carregarLotes() {
    preencherSelectEmpresasLote();
    api('/lote').then(function (linhas) {
      var tb = el('corpoLotes'); tb.innerHTML = '';
      alternarVazio('corpoLotes', 'vazioLotes', linhas.length);
      linhas.forEach(function (l) {
        var tr = document.createElement('tr');
        var resumo = '';
        if (l.autorizadas) resumo += '<span class="selo-status s-ok">' + l.autorizadas + ' autorizada(s)</span> ';
        if (l.processando) resumo += '<span class="selo-status s-alerta">' + l.processando + ' na fila</span> ';
        if (l.rejeitadas) resumo += '<span class="selo-status s-erro">' + l.rejeitadas + ' rejeitada(s)</span> ';
        if (l.com_erro) resumo += '<span class="selo-status s-erro sem-ponto">' + l.com_erro + ' com erro</span>';
        tr.innerHTML =
          '<td class="mono">' + l.id + '</td>' +
          '<td>' + esc(l.descricao || '—') +
            (l.usuario ? '<div class="ajuda">' + esc(l.usuario) + '</div>' : '') + '</td>' +
          '<td>' + esc(l.razao_social) + '</td>' +
          '<td>' + seloAmbiente(l.ambiente) + '</td>' +
          '<td>' + (resumo || '<span class="ajuda">' + l.total + ' linha(s)</span>') + '</td>' +
          '<td style="color:var(--texto-2)">' + fmtDataHora(l.criado_em) + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno'; b.textContent = 'Abrir';
        b.onclick = function () { abrirLote(l.id); };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  function preencherSelectEmpresasLote() {
    ['lt_empresa', 'rl_empresa'].forEach(function (id) {
      var sel = el(id); if (!sel) return;
      var atual = sel.value;
      sel.innerHTML = id === 'rl_empresa' ? '<option value="">Todas</option>' : '';
      estado.empresas.forEach(function (e) {
        var o = document.createElement('option');
        o.value = e.id;
        o.textContent = (e.nome_fantasia || e.razao_social) + ' — ' + fmtDoc(e.cnpj);
        sel.appendChild(o);
      });
      if (atual) sel.value = atual;
    });
  }

  function enviarPlanilha(caminho) {
    var arquivo = el('lt_arquivo').files[0];
    if (!arquivo) { aviso('Escolha a planilha antes.', 'erro'); return null; }
    var fd = new FormData();
    fd.append('arquivo', arquivo);
    fd.append('empresaId', el('lt_empresa').value);
    fd.append('descricao', arquivo.name);
    return api(caminho, { method: 'POST', body: fd });
  }

  el('btnConferirLote').onclick = function () {
    var b = el('btnConferirLote');
    b.disabled = true; b.textContent = 'Conferindo…';
    var p = enviarPlanilha('/lote/conferir');
    if (!p) { b.disabled = false; b.textContent = 'Conferir'; return; }
    p.then(mostrarConferencia)
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Conferir'; });
  };

  /* Conferência antes de emitir: uma vez transmitida, a nota só sai por
     cancelamento, e cada linha errada custa um número da sequência fiscal. */
  function mostrarConferencia(d) {
    var caixa = el('lt_resultado');
    var linhas = d.itens.map(function (i) {
      return '<tr>' +
        '<td class="mono">' + i.linha + '</td>' +
        '<td>' + esc(i.cliente) + '</td>' +
        '<td>' + esc((i.descricao || '').slice(0, 50)) + '</td>' +
        '<td>' + (i.valor ? fmtMoeda(i.valor) : '—') + '</td>' +
        '<td>' + (i.erro
          ? '<span class="selo-status s-erro">' + esc(i.erro) + '</span>'
          : '<span class="selo-status s-ok">ok</span>') + '</td>' +
      '</tr>';
    }).join('');

    caixa.innerHTML =
      '<div class="' + (d.comErro ? 'aviso erro' : 'aviso ok') + '" style="display:block">' +
        d.validos + ' de ' + d.total + ' linha(s) prontas · total ' + fmtMoeda(d.valorTotal) +
        (d.comErro ? ' · <strong>' + d.comErro + ' com erro, que não serão emitidas</strong>' : '') +
      '</div>' +
      '<div class="tabela-area" style="max-height:340px;overflow-y:auto;margin-top:12px">' +
        '<table><thead><tr><th>Linha</th><th>Cliente</th><th>Serviço</th><th>Valor</th><th></th></tr></thead>' +
        '<tbody>' + linhas + '</tbody></table>' +
      '</div>';

    if (d.validos) {
      var b = document.createElement('button');
      b.className = 'primario';
      b.style.marginTop = '14px';
      b.textContent = 'Emitir ' + d.validos + ' nota(s) em ' +
        (d.empresa.ambiente === 'producao' ? 'PRODUÇÃO' : 'homologação');
      b.onclick = function () { emitirLote(d); };
      caixa.appendChild(b);
    }
  }

  function emitirLote(conferencia) {
    var producao = conferencia.empresa.ambiente === 'producao';
    var texto = 'Emitir ' + conferencia.validos + ' nota(s) por ' +
      conferencia.empresa.razaoSocial + '?\n\nTotal: ' + fmtMoeda(conferencia.valorTotal);
    if (producao) texto += '\n\nEM PRODUÇÃO: as notas terão valor fiscal e geram imposto.';
    if (!confirm(texto)) return;

    aviso('Enviando as notas… isso pode levar alguns minutos.');
    var p = enviarPlanilha('/lote');
    if (!p) return;
    p.then(function (r) {
      el('lt_resultado').innerHTML = '';
      el('lt_arquivo').value = '';
      aviso(r.enviados + ' nota(s) enviadas' +
            (r.comErro ? ', ' + r.comErro + ' com erro' : '') +
            '. Acompanhe abaixo o resultado de cada uma.');
      carregarLotes();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnAtualizarLotes').onclick = carregarLotes;

  function abrirLote(id) {
    api('/lote/' + id).then(function (d) {
      var linhas = d.itens.map(function (i) {
        var situacao;
        if (i.status === 'erro') situacao = '<span class="selo-status s-erro">' + esc(i.erro) + '</span>';
        else if (i.status_nota) situacao = seloStatus(i.status_nota) +
          (i.ultimo_erro ? '<div class="ajuda">' + esc(i.ultimo_erro) + '</div>' : '');
        else situacao = '<span class="selo-status s-alerta">na fila</span>';
        return '<tr>' +
          '<td class="mono">' + i.linha + '</td>' +
          '<td class="mono">' + (i.numero ? esc(i.serie) + '/' + esc(i.numero) : '—') + '</td>' +
          '<td>' + situacao + '</td>' +
        '</tr>';
      }).join('');

      el('loteTitulo').textContent = 'Lote ' + d.lote.id;
      el('loteSub').textContent = (d.lote.descricao || '') + ' · ' + d.lote.razao_social;
      el('loteCorpo').innerHTML =
        '<div class="tabela-area" style="max-height:420px;overflow-y:auto">' +
        '<table><thead><tr><th>Linha</th><th>Nota</th><th>Situação</th></tr></thead><tbody>' +
        linhas + '</tbody></table></div>';
      el('dlgLote').showModal();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('loteFechar').onclick = function () { el('dlgLote').close(); };

  /* ------------------------------------------------------------- relatórios */

  function prepararRelatorios() {
    preencherSelectEmpresasLote();
    if (!el('rl_inicio').value) {
      // Abre no mês corrente, que é o fechamento em curso
      var hoje = new Date();
      el('rl_inicio').value = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
        .toISOString().slice(0, 10);
      el('rl_fim').value = hoje.toISOString().slice(0, 10);
    }
    gerarRelatorio();
  }

  function filtrosRelatorio() {
    var q = ['inicio=' + el('rl_inicio').value, 'fim=' + el('rl_fim').value];
    if (el('rl_empresa').value) q.push('empresaId=' + el('rl_empresa').value);
    if (el('rl_ambiente').value) q.push('ambiente=' + el('rl_ambiente').value);
    return q.join('&');
  }

  function gerarRelatorio() {
    api('/relatorios/fechamento?' + filtrosRelatorio()).then(function (d) {
      var t = d.totais;
      el('rl_metricas').hidden = false;
      el('rlNotas').textContent = t.notas;
      el('rlValor').textContent = fmtMoeda(t.valorServico);
      el('rlIss').textContent = fmtMoeda(t.valorIss);
      el('rlIssRetido').textContent = t.issRetido
        ? fmtMoeda(t.issRetido) + ' retido pelo tomador' : '';
      el('rlRetFed').textContent = fmtMoeda(t.retencoesFederais);

      var tb = el('corpoRelatorio'); tb.innerHTML = '';
      alternarVazio('corpoRelatorio', 'vazioRelatorio', d.empresas.length);
      d.empresas.forEach(function (e) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><strong>' + esc(e.empresa) + '</strong>' +
            '<div class="ajuda">' + fmtDoc(e.cnpj) +
            (e.optanteSimples ? ' · Simples Nacional' : '') + '</div></td>' +
          '<td>' + e.notas + '</td>' +
          '<td>' + fmtMoeda(e.valorServico) + '</td>' +
          '<td>' + fmtMoeda(e.baseCalculo) + '</td>' +
          // Optante do Simples recolhe o ISS no DAS: mostrar valor aqui daria a
          // entender que há guia municipal a pagar.
          '<td>' + (e.optanteSimples
            ? '<span class="ajuda">no DAS</span>'
            : fmtMoeda(e.valorIss) +
              (e.issRetido ? '<div class="ajuda">' + fmtMoeda(e.issRetido) + ' retido</div>' : '')) + '</td>' +
          '<td>' + (e.retencoesFederais ? fmtMoeda(e.retencoesFederais) : '—') + '</td>';
        tb.appendChild(tr);
      });

      var pend = d.naoAutorizadas || [];
      el('cartaoPendencias').hidden = pend.length === 0;
      el('rl_pendencias').innerHTML = pend.map(function (p) {
        return '<div class="linha-alerta aviso"><strong>' + esc(p.empresa) + '</strong> — ' +
          'nota ' + esc(p.serie) + '/' + esc(p.numero) + ' ' + seloStatus(p.status) +
          (p.referencia ? ' · ' + esc(p.referencia) : '') + '</div>';
      }).join('');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnGerarRelatorio').onclick = gerarRelatorio;
  el('btnBaixarCsv').onclick = function () {
    baixar('/relatorios/notas.csv?' + filtrosRelatorio(),
           'nfse-' + el('rl_inicio').value + '-a-' + el('rl_fim').value + '.csv');
  };

  /* Documentos do período: o que o escritório arquiva e manda ao cliente no
     fechamento. Mesmos filtros da tela, para não haver diferença entre o que
     se vê e o que se baixa. */
  function filtrosDocumentos() {
    var q = ['inicio=' + el('rl_inicio').value, 'fim=' + el('rl_fim').value, 'status=autorizada'];
    if (el('rl_ambiente').value) q.push('ambiente=' + el('rl_ambiente').value);
    var emp = el('rl_empresa').value;
    if (emp) {
      var e = estado.empresas.filter(function (x) { return String(x.id) === String(emp); })[0];
      if (e) q.push('cnpjEmpresa=' + encodeURIComponent(e.cnpj));
    }
    return q.join('&');
  }

  el('btnBaixarPdfsPeriodo').onclick = function () {
    baixarZipPdf('/nfse/export-pdf?' + filtrosDocumentos(), el('btnBaixarPdfsPeriodo'));
  };
  el('btnBaixarXmlsPeriodo').onclick = function () {
    baixar('/nfse/export?tipo=nfse&' + filtrosDocumentos(),
           'xmls-' + el('rl_inicio').value + '-a-' + el('rl_fim').value + '.zip');
  };

  /* -------------------------------------------------------------- usuários */

  function nomesEmpresas(ids) {
    if (!ids || !ids.length) return '<span style="color:var(--texto-3)">todas</span>';
    var nomes = ids.map(function (id) {
      var e = estado.empresas.filter(function (x) { return x.id === id; })[0];
      return e ? (e.nome_fantasia || e.razao_social) : '#' + id;
    });
    // Lista inteira só no title: em grupo grande a coluna estouraria a tabela
    return nomes.length <= 2
      ? esc(nomes.join(', '))
      : '<span title="' + esc(nomes.join(', ')) + '">' + nomes.length + ' empresas</span>';
  }

  function carregarUsuarios() {
    api('/usuarios').then(function (linhas) {
      var tb = el('corpoUsuarios'); tb.innerHTML = '';
      alternarVazio('corpoUsuarios', 'vazioUsuarios', linhas.length);
      linhas.forEach(function (u) {
        var euMesmo = estado.usuario && estado.usuario.id === u.id;
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><strong>' + esc(u.nome) + '</strong>' +
            (euMesmo ? ' <span class="selo-status s-info sem-ponto">você</span>' : '') + '</td>' +
          '<td>' + esc(u.email) + '</td>' +
          '<td>' + (u.perfil === 'admin'
            ? '<span class="selo-status s-info sem-ponto">administrador</span>'
            : '<span class="selo-status s-neutro sem-ponto">operador</span>') + '</td>' +
          '<td>' + nomesEmpresas(u.empresas_ids) + '</td>' +
          '<td>' + (u.ativo ? '<span class="selo-status s-ok">ativo</span>'
                            : '<span class="selo-status s-neutro">inativo</span>') +
            (u.trocar_senha ? ' <span class="selo-status s-alerta sem-ponto">senha provisória</span>' : '') + '</td>' +
          '<td style="color:var(--texto-2)">' + (u.ultimo_acesso ? fmtDataHora(u.ultimo_acesso) : 'nunca') + '</td>' +
          '<td class="acoes"></td>';

        var editar = document.createElement('button');
        editar.className = 'pequeno'; editar.textContent = 'Editar';
        editar.onclick = function () { abrirUsuario(u); };
        tr.lastChild.appendChild(editar);

        if (!euMesmo) {
          var excluir = document.createElement('button');
          excluir.className = 'pequeno perigo'; excluir.textContent = 'Excluir';
          excluir.style.marginLeft = '6px';
          excluir.onclick = function () {
            if (!confirm('Excluir o usuário ' + u.nome + '?\n\n' +
                         'As notas que essa pessoa emitiu continuam registradas.')) return;
            api('/usuarios/' + u.id, { method:'DELETE' })
              .then(function () { aviso('Usuário excluído.'); carregarUsuarios(); })
              .catch(function (e) { aviso(e.message, 'erro'); });
          };
          tr.lastChild.appendChild(excluir);
        }
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  function montarCaixasEmpresa(marcadas) {
    var caixa = el('u_empresas');
    caixa.innerHTML = '';
    if (!estado.empresas.length) {
      caixa.innerHTML = '<div class="ajuda">Nenhuma empresa cadastrada ainda.</div>';
      return;
    }
    estado.empresas.forEach(function (e) {
      var linha = document.createElement('label');
      linha.style.cssText = 'display:flex;align-items:center;gap:9px;font-weight:400;margin-bottom:7px';
      var caixinha = document.createElement('input');
      caixinha.type = 'checkbox';
      caixinha.value = e.id;
      caixinha.style.cssText = 'width:auto;margin:0';
      caixinha.checked = (marcadas || []).indexOf(e.id) !== -1;
      linha.appendChild(caixinha);
      linha.appendChild(document.createTextNode(e.nome_fantasia || e.razao_social));
      caixa.appendChild(linha);
    });
  }

  function abrirUsuario(u) {
    estado.usuarioEditando = u ? u.id : null;
    el('usuTitulo').textContent = u ? u.nome : 'Novo usuário';
    el('formUsuario').reset();
    el('u_nome').value = u ? u.nome : '';
    el('u_email').value = u ? u.email : '';
    el('u_perfil').value = u ? u.perfil : 'operador';
    el('u_ativo').value = u ? String(u.ativo) : 'true';
    el('u_senhaObs').textContent = u ? '' : '*';
    el('u_senhaAjuda').textContent = u
      ? 'Deixe em branco para manter a senha atual. Ao preencher, a pessoa troca no próximo acesso.'
      : 'Ao menos 8 caracteres. A pessoa troca no primeiro acesso.';
    el('u_cargo').value = (u && u.cliente_cargo) || '';
    el('usuEncerrar').hidden = !u;
    montarCaixasEmpresa(u ? u.empresas_ids : []);
    ajustarFormularioPorPerfil();
    el('dlgUsuario').showModal();
  }

  el('btnNovoUsuario').onclick = function () { abrirUsuario(null); };
  el('usuCancelar').onclick = function () { el('dlgUsuario').close(); };

  el('usuEncerrar').onclick = function () {
    if (!estado.usuarioEditando) return;
    if (!confirm('Encerrar as sessões abertas deste usuário?\n\n' +
                 'Ele precisará entrar de novo em qualquer máquina onde estiver logado.')) return;
    api('/usuarios/' + estado.usuarioEditando + '/encerrar-sessoes', { method:'POST' })
      .then(function () { aviso('Sessões encerradas.'); })
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  el('formUsuario').onsubmit = function (ev) {
    ev.preventDefault();
    var senha = el('u_senha').value;
    var ehCliente = el('u_perfil').value === 'cliente';
    if (!estado.usuarioEditando && !senha && !ehCliente) {
      return aviso('Defina uma senha para o novo usuário.', 'erro');
    }

    var empresas = $$('#u_empresas input:checked').map(function (c) { return Number(c.value); });
    /* A conferência de verdade é do servidor; esta aqui é para a pessoa não
       descobrir o problema depois de preencher o formulário inteiro. */
    if (ehCliente && !empresas.length) {
      return aviso('Marque ao menos uma empresa: sem vínculo, essa pessoa ' +
                   'enxergaria todas as empresas do escritório.', 'erro');
    }

    var corpo = {
      nome: el('u_nome').value.trim(),
      email: el('u_email').value.trim(),
      perfil: el('u_perfil').value,
      ativo: el('u_ativo').value === 'true',
      empresasIds: empresas
    };
    if (ehCliente) corpo.clienteCargo = el('u_cargo').value.trim() || null;
    if (senha && !ehCliente) corpo.senha = senha;

    var botao = ev.target.querySelector('button[type=submit]');
    botao.disabled = true;
    api(estado.usuarioEditando ? '/usuarios/' + estado.usuarioEditando : '/usuarios', {
      method: estado.usuarioEditando ? 'PUT' : 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(corpo)
    }).then(function () {
      el('dlgUsuario').close();
      aviso(estado.usuarioEditando ? 'Usuário atualizado.' : 'Usuário criado.');
      carregarUsuarios();
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { botao.disabled = false; });
  };

  /* ------------------------------------------------------ backup e migração */

  function fmtTamanho(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* Atualizações do gateway.

     O gateway roda na contabilidade, sem TI por perto, e as regras da Sefin
     mudam sem aviso. Ele confere sozinho se saiu versão nova, mas não instala:
     trocar arquivos no meio de uma emissão interromperia o trabalho, e quem
     sabe a hora de parar é quem está operando. */
  function tamanhoLegivel(bytes) {
    if (!bytes) return '';
    var mb = bytes / 1048576;
    return mb >= 1 ? mb.toFixed(1).replace('.', ',') + ' MB'
                   : Math.round(bytes / 1024) + ' KB';
  }

  /* As notas da release vêm em markdown. Em vez de interpretar tudo, mostra o
     texto como está — escapado, que é o que importa: veio da internet. */
  function notasComoTexto(notas) {
    return '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">' +
           esc(String(notas || '').replace(/^SHA-?256.*$/gim, '').trim()) + '</pre>';
  }

  function mostrarAtualizacao(a) {
    estado.atualizacao = a;

    // Faixa na tela inicial: some quando não há nada novo ou quando a pessoa
    // já disse que não quer ser avisada desta versão
    var faixa = el('avisoAtualizacao');
    if (faixa) {
      var mostrar = a.temAtualizacao && !a.dispensada;
      faixa.hidden = !mostrar;
      if (mostrar) {
        faixa.innerHTML =
          '<div class="linha-alerta aviso"><strong>Versão ' + esc(a.versaoDisponivel) +
          ' disponível</strong> — você está na ' + esc(a.versaoAtual) +
          '. <a href="#manutencao">Ver o que mudou</a></div>';
      }
    }

    if (!el('atVersaoAtual')) return;   // tela de manutenção ainda não montada
    el('atVersaoAtual').textContent = a.versaoAtual || '—';
    el('atVersaoNova').textContent = a.temAtualizacao
      ? a.versaoDisponivel + (a.tamanhoBytes ? ' (' + tamanhoLegivel(a.tamanhoBytes) + ')' : '')
      : (a.versaoDisponivel ? a.versaoDisponivel + ' — já instalada' : '—');
    el('atVerificado').textContent = a.erro
      ? 'falhou em ' + fmtDataHora(a.erroEm) + ': ' + a.erro
      : fmtDataHora(a.verificadoEm);

    var notas = el('atNotas');
    notas.hidden = !(a.temAtualizacao && a.notas);
    if (!notas.hidden) notas.innerHTML = notasComoTexto(a.notas);

    el('btnBaixarAtualizacao').hidden = !a.temAtualizacao;
    el('btnDispensarAtualizacao').hidden = !a.temAtualizacao || a.dispensada;

    if (a.arquivoBaixado && a.temAtualizacao) {
      el('atResultado').innerHTML =
        'Instalador pronto em <span class="mono">' + esc(a.arquivoBaixado) + '</span>.<br>' +
        'Feche o gateway e execute esse arquivo para atualizar. Seus dados, ' +
        'certificados e numeração continuam onde estão.';
    }
  }

  function carregarAtualizacao() {
    return api('/atualizacao')
      .then(mostrarAtualizacao)
      .catch(function () { /* nunca atrapalha o resto da tela */ });
  }

  el('btnVerificarAtualizacao').onclick = function () {
    var b = el('btnVerificarAtualizacao');
    b.disabled = true; b.textContent = 'Verificando…';
    el('atResultado').textContent = '';
    api('/atualizacao/verificar', { method: 'POST' })
      .then(function (a) {
        mostrarAtualizacao(a);
        if (a.erro) aviso('Não foi possível verificar: ' + a.erro, 'erro');
        else if (a.temAtualizacao) aviso('Versão ' + a.versaoDisponivel + ' disponível.', 'ok');
        else aviso('O gateway já está atualizado.', 'ok');
      })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Verificar agora'; });
  };

  el('btnBaixarAtualizacao').onclick = function () {
    var b = el('btnBaixarAtualizacao');
    b.disabled = true; b.textContent = 'Baixando…';
    el('atResultado').textContent = 'Baixando o instalador. Pode levar alguns minutos.';
    api('/atualizacao/baixar', { method: 'POST' })
      .then(function (a) {
        mostrarAtualizacao(a);
        // Sem soma publicada o arquivo veio, mas ninguém conferiu a origem —
        // e isso precisa aparecer antes de alguém executá-lo como administrador
        if (a.aviso) aviso(a.aviso, 'erro');
        else aviso('Instalador baixado e conferido.', 'ok');
      })
      .catch(function (e) {
        el('atResultado').textContent = '';
        aviso(e.message, 'erro');
      })
      .then(function () { b.disabled = false; b.textContent = 'Baixar atualização'; });
  };

  el('btnDispensarAtualizacao').onclick = function () {
    var a = estado.atualizacao || {};
    api('/atualizacao/dispensar', { method: 'POST',
                                    body: JSON.stringify({ versao: a.versaoDisponivel }) })
      .then(function (r) {
        mostrarAtualizacao(r);
        aviso('Não avisaremos mais sobre a versão ' + a.versaoDisponivel +
              '. Ela continua disponível aqui.', 'ok');
      })
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  function carregarManutencao() {
    api('/manutencao').then(function (d) {
      el('mtPasta').textContent = d.pasta;
      el('mtUltimo').innerHTML = d.ultimoBackup
        ? fmtDataHora(d.ultimoBackup.criado_em) +
          ' <span class="ajuda">(' + fmtTamanho(d.ultimoBackup.tamanho) + ')</span>'
        : '<span class="selo-status s-alerta">nenhuma ainda</span>';

      var arquivos = (d.backups || []).map(function (b) { return { a: b, tipo: 'cópia' }; })
        .concat((d.pacotesMigracao || []).map(function (p) { return { a: p, tipo: 'migração' }; }))
        .sort(function (x, y) { return y.a.nome.localeCompare(x.a.nome); });

      var tb = el('corpoManutencao'); tb.innerHTML = '';
      alternarVazio('corpoManutencao', 'vazioManutencao', arquivos.length);

      arquivos.forEach(function (item) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono" style="font-size:12px">' + esc(item.a.nome) + '</td>' +
          '<td>' + (item.tipo === 'migração'
            ? '<span class="selo-status s-info sem-ponto">migração</span>'
            : '<span class="selo-status s-neutro sem-ponto">cópia</span>') + '</td>' +
          '<td>' + fmtTamanho(item.a.tamanho) + '</td>' +
          '<td style="color:var(--texto-2)">' + fmtDataHora(item.a.criado_em) + '</td>' +
          '<td class="acoes"></td>';

        var baixarBtn = document.createElement('button');
        baixarBtn.className = 'pequeno'; baixarBtn.textContent = 'Baixar';
        baixarBtn.onclick = function () {
          baixar('/manutencao/arquivo/' + encodeURIComponent(item.a.nome), item.a.nome);
        };
        var apagar = document.createElement('button');
        apagar.className = 'pequeno perigo'; apagar.textContent = 'Apagar';
        apagar.style.marginLeft = '6px';
        apagar.onclick = function () {
          if (!confirm('Apagar ' + item.a.nome + '?')) return;
          api('/manutencao/arquivo/' + encodeURIComponent(item.a.nome), { method:'DELETE' })
            .then(function () { aviso('Arquivo apagado.'); carregarManutencao(); })
            .catch(function (e) { aviso(e.message, 'erro'); });
        };
        tr.lastChild.appendChild(baixarBtn);
        tr.lastChild.appendChild(apagar);
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnAtualizarManutencao').onclick = carregarManutencao;

  el('btnBackupAgora').onclick = function () {
    var b = el('btnBackupAgora');
    b.disabled = true; b.textContent = 'Gerando…';
    api('/manutencao/backup', { method:'POST' })
      .then(function (r) { aviso(r.resumo || 'Cópia gerada.'); carregarManutencao(); })
      .catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Gerar cópia agora'; });
  };

  el('btnGerarMigracao').onclick = function () {
    var senha = el('mtSenha').value;
    if (!senha || senha.length < 8) {
      return aviso('Escolha uma senha de ao menos 8 caracteres para o arquivo.', 'erro');
    }
    if (!confirm('O arquivo vai conter o certificado digital, os tokens e as chaves do sistema.\n\n' +
                 'Guarde a senha em lugar separado do arquivo — sem ela nada abre.\n\nGerar?')) return;

    var b = el('btnGerarMigracao');
    b.disabled = true; b.textContent = 'Gerando…';
    api('/manutencao/migracao', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ senha: senha })
    }).then(function (r) {
      el('mtSenha').value = '';
      aviso('Arquivo de migração gerado. Baixe-o na lista abaixo e leve para o outro computador.');
      carregarManutencao();
    }).catch(function (e) { aviso(e.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Gerar arquivo de migração'; });
  };

  /* ------------------------------------------------------------ municípios */

  var MODO_SELO = { nacional:'s-ok', proprio:'s-erro', desconhecido:'s-neutro' };
  var MODO_TEXTO = { nacional:'Nacional', proprio:'Emissor próprio', desconhecido:'Desconhecido' };

  function carregarMunicipios() {
    api('/municipios').then(function (linhas) {
      var tb = el('corpoMunicipios'); tb.innerHTML = '';
      alternarVazio('corpoMunicipios', 'vazioMunicipios', linhas.length);
      linhas.forEach(function (m) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + esc(m.codigo_municipio) + '</td>' +
          '<td>' + esc(m.nome || '—') + '</td>' +
          '<td class="mono">' + esc(m.uf || '—') + '</td>' +
          '<td><span class="selo-status ' + (MODO_SELO[m.modo_emissao]||'s-neutro') + ' sem-ponto">' +
            esc(MODO_TEXTO[m.modo_emissao] || m.modo_emissao) + '</span></td>' +
          '<td class="mono">' + (m.aliquota_iss != null ? esc(m.aliquota_iss) : '—') + '</td>' +
          '<td style="color:var(--texto-2)">' + esc(m.fonte) + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno'; b.textContent = 'Editar';
        b.onclick = function () { abrirMunicipio(m); };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  function abrirMunicipio(m) {
    el('m_cod').value = m ? m.codigo_municipio : '';
    el('m_cod').disabled = !!m;
    el('m_nome').value = m ? (m.nome || '') : '';
    el('m_uf').value = m ? (m.uf || '') : '';
    el('m_modo').value = m ? m.modo_emissao : 'nacional';
    el('m_iss').value = m && m.aliquota_iss != null ? m.aliquota_iss : '';
    el('dlgMun').showModal();
  }
  el('btnNovoMun').onclick = function () { abrirMunicipio(null); };
  el('munCancelar').onclick = function () { el('dlgMun').close(); };
  el('formMun').onsubmit = function (ev) {
    ev.preventDefault();
    var cod = digitos(el('m_cod').value);
    if (!/^\d{7}$/.test(cod)) return aviso('Código IBGE deve ter 7 dígitos.', 'erro');
    api('/municipios/' + cod, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        modoEmissao: el('m_modo').value,
        nome: el('m_nome').value.trim() || null,
        uf: el('m_uf').value.trim().toUpperCase() || null,
        aliquotaIss: el('m_iss').value !== '' ? Number(el('m_iss').value) : undefined
      })
    }).then(function () { el('dlgMun').close(); aviso('Município salvo.'); carregarMunicipios(); })
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* -------------------------------------------------------------- webhooks */

  function carregarWebhooks() {
    // A tabela mostra o nome da empresa a partir do empresa_id do webhook
    if (!estado.empresas.length) {
      return api('/empresas').then(function (l) {
        estado.empresas = l || []; preencherSelectsEmpresa(); carregarWebhooks();
      }).catch(function (e) { aviso(e.message, 'erro'); });
    }
    api('/webhooks').then(function (linhas) {
      var tb = el('corpoWebhooks'); tb.innerHTML = '';
      alternarVazio('corpoWebhooks', 'vazioWebhooks', linhas.length);
      linhas.forEach(function (w) {
        var emp = estado.empresas.filter(function (e) { return e.id === w.empresa_id; })[0];
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">' + esc(w.url) + '</td>' +
          '<td>' + (emp ? esc(emp.nome_fantasia || emp.razao_social) : 'Todas') + '</td>' +
          '<td>' + (w.ambiente ? seloAmbiente(w.ambiente) : '<span class="selo-status s-neutro sem-ponto">ambos</span>') + '</td>' +
          '<td>' + (w.tem_chave ? '<span class="selo-status s-ok">autenticado</span>'
                                : '<span class="selo-status s-alerta">sem chave</span>') + '</td>' +
          '<td>' + (w.ativo ? '<span class="selo-status s-ok">ativo</span>'
                            : '<span class="selo-status s-neutro">inativo</span>') + '</td>' +
          '<td class="acoes"></td>';
        var b = document.createElement('button');
        b.className = 'pequeno perigo'; b.textContent = 'Remover';
        b.onclick = function () {
          if (!confirm('Remover este webhook?\n\n' + w.url)) return;
          api('/webhooks/' + w.id, { method:'DELETE' })
            .then(function () { aviso('Webhook removido.'); carregarWebhooks(); })
            .catch(function (e) { aviso(e.message, 'erro'); });
        };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  el('btnNovoWebhook').onclick = function () {
    el('formWebhook').reset(); preencherSelectsEmpresa(); el('dlgWebhook').showModal();
  };
  el('webCancelar').onclick = function () { el('dlgWebhook').close(); };
  el('formWebhook').onsubmit = function (ev) {
    ev.preventDefault();
    var url = el('w_url').value.trim();
    if (!/^https?:\/\//.test(url)) return aviso('A URL deve começar com http:// ou https://', 'erro');
    api('/webhooks', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        url: url,
        cnpjEmpresa: el('w_empresa').value || undefined,
        ambiente: el('w_ambiente').value || undefined,
        headerAutorizacao: el('w_header').value.trim() || undefined,
        chaveAutorizacao: el('w_chave').value || undefined
      })
    }).then(function () { el('dlgWebhook').close(); aviso('Webhook cadastrado.'); carregarWebhooks(); })
      .catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* ---------------------------------------------------------------- início */

  // Links do menu e das ações rápidas que apontam para telas internas
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a[data-tela]');
    if (a && a.getAttribute('href').charAt(0) === '#') {
      ev.preventDefault();
      location.hash = a.dataset.tela;
    }
  });

  /* A marca vem antes de qualquer decisão de tela: a de acesso já a mostra, e
     aplicá-la depois faria a página piscar do azul padrão para a cor da casa. */
  carregarMarca();

  /* Retomada: o cookie sobrevive ao F5, então a sessão continua sem novo login. */
  api('/usuarios/eu')
    .then(function (u) { abrirPainel(u); })
    .catch(function () { mostrarTelaAcesso(); });
})();
