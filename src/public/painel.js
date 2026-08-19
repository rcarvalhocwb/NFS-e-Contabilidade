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
    var ehAdmin = usuario.perfil === 'admin';

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
    identidade:  { titulo:'Identidade visual', sub:'A marca do escritório no painel e nos relatórios', carregar: carregarIdentidade },
    manutencao:  { titulo:'Backup e migração', sub:'Cópia de segurança e mudança de computador', carregar: function () { carregarManutencao(); carregarAtualizacao(); } },
    municipios:  { titulo:'Municípios',    sub:'Nacional ou emissor próprio',           carregar: carregarMunicipios },
    webhooks:    { titulo:'Webhooks',      sub:'Retorno automático ao sistema cliente', carregar: carregarWebhooks }
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
            (e.ativo ? '' : ' <span class="selo-status s-neutro sem-ponto">inativa</span>') + '</td>' +
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
    el('usuEncerrar').hidden = !u;
    montarCaixasEmpresa(u ? u.empresas_ids : []);
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
    if (!estado.usuarioEditando && !senha) return aviso('Defina uma senha para o novo usuário.', 'erro');

    var corpo = {
      nome: el('u_nome').value.trim(),
      email: el('u_email').value.trim(),
      perfil: el('u_perfil').value,
      ativo: el('u_ativo').value === 'true',
      empresasIds: $$('#u_empresas input:checked').map(function (c) { return Number(c.value); })
    };
    if (senha) corpo.senha = senha;

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
