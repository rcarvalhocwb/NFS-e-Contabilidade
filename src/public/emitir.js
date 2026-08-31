/* Emissão por conversa.
 *
 * Arquivo separado, e não script dentro do HTML, porque a
 * Content-Security-Policy do gateway é `script-src 'self'`: o navegador
 * recusa script escrito na própria página. Enquanto este código morou lá
 * dentro, a tela abria com o cabeçalho e o campo de texto e mais nada —
 * sem erro visível para quem estava usando, só uma linha no console. */
(function () {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var conversa = el('conversa');

  // Estado da emissão em andamento.
  var ctx = { empresas: [], tomadores: [], servicos: [] };
  var nota = {};
  var etapa = null;

  /* Voltar uma resposta.
   *
   * Quem digita erra, e percebe uma pergunta depois. Sem caminho de volta, a
   * única saída era recomeçar do zero — o que faz a pessoa preferir "deixa
   * assim" e emitir uma nota que ela já sabe estar errada. Cada pergunta
   * empilha como se refazê-la; voltar desempilha.
   */
  var historico = [];

  function marcar(refazer) {
    historico.push(refazer);
  }

  function podeVoltar() { return historico.length > 1; }

  function voltar() {
    if (!podeVoltar()) {
      bot('Esta é a primeira pergunta — não há para onde voltar.',
          'Use "Trocar empresa" lá em cima para recomeçar.');
      return;
    }
    historico.pop();                       // a pergunta atual
    var anterior = historico.pop();        // a que se quer refazer
    usuario('voltar');
    erros = 0;
    anterior();
  }

  /* Palavras que significam "errei". A pessoa escreve antes de procurar botão. */
  var PEDIDOS_DE_VOLTA = /^(voltar|volta|corrigir|corrige|errei|erro|desfazer|anterior)$/i;

  /* Quantas vezes a resposta atual foi recusada. Insistir na mesma pergunta sem
     oferecer saída é como o sistema trava a pessoa num canto. */
  var erros = 0;

  function naoEntendi(mensagem, exemplo) {
    erros++;
    bot(mensagem, exemplo);
    if (erros >= 3) {
      bot('Se preferir, dá para voltar uma pergunta ou recomeçar.');
      opcoes([
        { texto: 'Voltar uma pergunta', acao: voltar },
        { texto: 'Recomeçar', acao: function () {
            conversa.innerHTML = ''; nota = {}; historico = []; erros = 0;
            el('barraEmpresa').hidden = true; iniciar(); } }
      ]);
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function fmtDoc(v) {
    v = digits(v);
    if (v.length === 14) return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    if (v.length === 11) return v.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    return v;
  }
  /* Data do jeito que se lê no Brasil. O que vem do servidor é ISO. */
  function fmtData(d) {
    if (!d) return '—';
    var x = new Date(d);
    return isNaN(x) ? '—' : x.toLocaleDateString('pt-BR');
  }

  function fmtMoeda(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  }
  function rolar() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }

  function bot(html, sub) {
    var d = document.createElement('div');
    d.className = 'msg-bot';
    d.innerHTML = '<div class="bolha">' + html + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
    conversa.appendChild(d); rolar();
  }
  function usuario(texto) {
    var d = document.createElement('div');
    d.className = 'msg-user';
    d.innerHTML = '<div class="bolha">' + esc(texto) + '</div>';
    conversa.appendChild(d); rolar();
  }
  function opcoes(lista) {
    var d = document.createElement('div');
    d.className = 'opcoes';
    lista.forEach(function (o) {
      var b = document.createElement('button');
      b.innerHTML = esc(o.texto) + (o.detalhe ? '<span class="det">' + esc(o.detalhe) + '</span>' : '');
      b.onclick = function () { d.remove(); o.acao(); };
      d.appendChild(b);
    });
    conversa.appendChild(d); rolar();
    return d;
  }
  function bloco(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    conversa.appendChild(d); rolar();
    return d;
  }
  function pedir(placeholder, dica, tipo) {
    el('campo').placeholder = placeholder || 'Digite aqui...';
    el('campo').type = tipo || 'text';
    el('campo').disabled = false;
    el('enviar').disabled = false;
    el('dica').textContent = dica || '';
    el('campo').focus();
  }
  function travarEntrada() {
    el('campo').disabled = true; el('enviar').disabled = true;
    el('campo').value = ''; el('campo').placeholder = '';
    el('dica').textContent = '';
  }

  function api(path, opts) {
    opts = opts || {};
    // Mesma sessao do painel: o cookie vai sozinho, sem chave nenhuma na pagina
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      credentials: 'same-origin'
    }).then(function (res) {
        return res.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = { erro: t }; }
          if (!res.ok) throw new Error((data && (data.erro || data.detalhe)) || ('Erro HTTP ' + res.status));
          return data;
        });
      });
  }

  // ------------------------------------------------------------- etapas

  function iniciar() {
    // O emissor nao tem tela de login propria: quem nao esta logado volta para
    // o painel, entra la e cai de volta aqui.
    api('/usuarios/eu').then(function (u) {
      el('quemSou').textContent = u.nome;
      carregarContexto();
    }).catch(function () {
      location.href = '/admin';
    });
  }

  function carregarContexto() {
    api('/emissor/contexto').then(function (d) {
      ctx.empresas = d.empresas || [];
      var aptas = ctx.empresas.filter(function (e) { return e.tem_certificado; });
      if (!ctx.empresas.length) {
        bot('Nenhuma empresa cadastrada ainda.',
            'Cadastre no <a href="/admin" style="color:inherit">painel</a> antes de emitir.');
        travarEntrada(); return;
      }
      if (!aptas.length) {
        bot('As empresas cadastradas ainda não têm certificado digital.',
            'Anexe o certificado A1 no painel — sem ele não é possível assinar a nota.');
        travarEntrada(); return;
      }
      bot('Olá! Vamos emitir uma nota fiscal.');
      if (aptas.length === 1) {
        escolherEmpresa(aptas[0]);
      } else {
        bot('Por qual empresa?');
        listarEmpresas(aptas);
      }
    }).catch(function (e) {
      bot('Não consegui carregar os dados: ' + esc(e.message));
      if (/sess|401|logado/i.test(e.message)) location.href = '/admin';
    });
  }

  /* Lista de empresas com busca.
     Uma parede de trinta botões é pior do que nenhuma ajuda: a pessoa passa o
     olho, não acha, e clica no que parece. Com o campo, ela digita três letras
     do nome ou do CNPJ e sobra o que importa. */
  function listarEmpresas(aptas) {
    var caixa = document.createElement('div');
    caixa.className = 'opcoes';

    var busca = null;
    if (aptas.length > 6) {
      busca = document.createElement('input');
      busca.className = 'busca-empresa';
      busca.placeholder = 'Digite parte do nome ou do CNPJ (' + aptas.length + ' empresas)';
      caixa.appendChild(busca);
    }

    var lista = document.createElement('div');
    caixa.appendChild(lista);

    function desenhar(filtro) {
      var termo = (filtro || '').toLowerCase().replace(/[^\w\sà-ú]/gi, '');
      var vistas = aptas.filter(function (e) {
        if (!termo) return true;
        var alvo = ((e.nome_fantasia || '') + ' ' + e.razao_social + ' ' + e.cnpj).toLowerCase();
        return alvo.replace(/[^\w\sà-ú]/gi, '').indexOf(termo) !== -1;
      });
      lista.innerHTML = '';
      if (!vistas.length) {
        var vazio = document.createElement('div');
        vazio.className = 'dica';
        vazio.textContent = 'Nenhuma empresa com esse nome ou CNPJ.';
        lista.appendChild(vazio);
        return;
      }
      vistas.slice(0, 30).forEach(function (e) {
        var b = document.createElement('button');
        // Mesma marcacao dos outros botoes de opcao: o CSS estiliza
        // `.opcoes button` e `.det`, nao uma classe propria.
        b.innerHTML = esc(e.nome_fantasia || e.razao_social) +
          '<span class="det">' + esc(fmtDoc(e.cnpj)) + ' · ' + esc(e.ambiente) + '</span>';
        b.onclick = function () { caixa.remove(); escolherEmpresa(e); };
        lista.appendChild(b);
      });
    }

    desenhar('');
    if (busca) {
      busca.oninput = function () { desenhar(busca.value); };
    }
    conversa.appendChild(caixa);
    rolar();
    travarEntrada();
    if (busca) busca.focus();
  }

  /* A barra fica na tela o tempo todo. A conversa rola, e depois de três
     respostas o nome da empresa já saiu de vista — num escritório que atende
     dezenas de CNPJs, isso é nota emitida no cliente errado, com o certificado
     dele. */
  function mostrarBarraEmpresa(e) {
    var barra = el('barraEmpresa');
    barra.hidden = false;
    barra.classList.toggle('producao', e.ambiente === 'producao');
    el('beNome').textContent = e.nome_fantasia || e.razao_social;
    el('beDoc').textContent = fmtDoc(e.cnpj);
    el('beAmbiente').textContent = e.ambiente === 'producao'
      ? 'produção · valor fiscal' : 'homologação · teste';
  }

  el('beTrocar').onclick = function () {
    if (nota.notaEmAndamento) return;
    conversa.innerHTML = '';
    nota = {};
    el('barraEmpresa').hidden = true;
    iniciar();
  };

  function escolherEmpresa(e) {
    nota.empresa = e;
    usuario(e.nome_fantasia || e.razao_social);
    mostrarBarraEmpresa(e);
    // Recarrega tomadores e serviços já usados por esta empresa.
    api('/emissor/contexto?empresaId=' + e.id).then(function (d) {
      ctx.tomadores = d.tomadores || [];
      ctx.servicos = d.servicos || [];
      ctx.ultimaNota = (d.sugestoes || {}).ultimaNota || null;
      oferecerRepeticao();
    }).catch(function () { perguntarTomador(); });
  }

  /* Escritório emite a mesma coisa para o mesmo cliente todo mês. Reconstruir
     seis respostas para chegar no mesmo lugar é tempo perdido — e cada resposta
     digitada de novo é uma chance a mais de errar. */
  function oferecerRepeticao() {
    var u = ctx.ultimaNota;
    if (!u || !u.tomador || !u.servico || !u.servico.codigoTributacao || u.valor == null) {
      return perguntarTomador();
    }
    bot('A última nota desta empresa foi para <strong>' + esc(u.nomeTomador || '—') +
        '</strong>, de ' + fmtMoeda(u.valor) + '.',
        esc(u.servico.descricao || '') + ' · série ' + esc(u.serie) + '/' + esc(u.numero) +
        ' em ' + fmtData(u.emitidaEm));
    opcoes([
      { texto: 'Repetir essa nota', detalhe: 'mesmo cliente, serviço e valor',
        acao: function () { repetirUltima(u); } },
      { texto: 'Mesmo cliente, outro valor',
        acao: function () { nota.tomador = u.tomador; usuario(u.nomeTomador || '—');
                            aplicarServico(u.servico); perguntarValor(); } },
      { texto: 'Começar do zero', acao: function () { perguntarTomador(); } }
    ]);
    travarEntrada();
  }

  function repetirUltima(u) {
    nota.tomador = u.tomador;
    usuario('Repetir a última nota');
    aplicarServico(u.servico);
    nota.valor = u.valor;
    revisar();
  }

  /* O serviço da nota anterior, no formato que o resto do fluxo espera. */
  function aplicarServico(s) {
    nota.servico = {
      codigo_tributacao: s.codigoTributacao,
      descricao: s.descricao,
      aliquota_iss: s.aliquota,
      codigo_nbs: s.codigoNbs
    };
  }

  function perguntarTomador() {
    marcar(perguntarTomador);
    erros = 0;
    bot('Para quem é a nota?');
    if (ctx.tomadores.length) {
      opcoes(ctx.tomadores.slice(0, 6).map(function (t) {
        return {
          texto: t.razao_social,
          detalhe: fmtDoc(t.documento),
          acao: function () { usuario(t.razao_social); nota.tomador = t; perguntarServico(); }
        };
      }));
    }
    etapa = 'tomador';
    pedir('CNPJ ou CPF do cliente', ctx.tomadores.length
      ? 'Escolha acima ou digite o documento de um cliente novo.'
      : 'Digite o CNPJ ou CPF — eu busco os dados automaticamente.');
  }

  function buscarTomador(doc) {
    bot('Buscando ' + esc(fmtDoc(doc)) + '...');
    api('/emissor/tomador/' + doc + (nota.empresa ? '?empresaId=' + nota.empresa.id : ''))
      .then(function (r) {
        nota.tomador = r.tomador;
        nota.tomadorNovo = r.origem !== 'cadastro';
        if (r.tomador.razao_social) {
          bot('Encontrei: <strong>' + esc(r.tomador.razao_social) + '</strong>',
              r.origem === 'receita' ? 'Dados da base pública da Receita.' : '');
          perguntarServico();
        } else {
          bot('Não achei esse documento nas bases públicas. Qual o nome do cliente?');
          etapa = 'tomadorNome';
          pedir('Nome ou razão social do cliente');
        }
      }).catch(function (e) {
        /* O servidor confere o dígito verificador; aqui só se mostra o motivo
           e se devolve a pergunta, em vez de deixar a pessoa no vazio. */
        var digito = /dígitos|inválido/i.test(e.message || '');
        bot('Não deu certo: ' + esc(e.message),
            digito ? 'Confira o documento — um dígito trocado costuma ser a causa.'
                   : 'Pode ser a base pública fora do ar; dá para seguir digitando os dados.');
        erros++;
        etapa = 'tomador';
        pedir('CNPJ ou CPF do cliente');
        if (erros >= 2) {
          opcoes([{ texto: 'Voltar uma pergunta', acao: voltar }]);
        }
      });
  }

  function perguntarServico() {
    marcar(perguntarServico);
    erros = 0;
    bot('Qual serviço foi prestado?');
    var lista = ctx.servicos.slice(0, 6).map(function (s) {
      return {
        texto: s.apelido,
        detalhe: (s.valor_padrao ? fmtMoeda(s.valor_padrao) + ' · ' : '') + 'cód. ' + s.codigo_tributacao,
        acao: function () { usuario(s.apelido); nota.servico = s; perguntarValor(); }
      };
    });
    lista.push({
      texto: '+ Outro serviço',
      detalhe: 'informar código e descrição',
      acao: function () {
        usuario('Outro serviço');
        bot('Qual o <strong>código de tributação nacional</strong>?',
            'São 6 dígitos. Ex.: 110201 (vigilância e segurança), 010101 (análise de sistemas).');
        etapa = 'servicoCodigo';
        pedir('Código de 6 dígitos');
      }
    });
    opcoes(lista);
    travarEntrada();
  }

  function perguntarValor() {
    var s = nota.servico || {};
    if (s.valor_padrao) {
      bot('Qual o valor? O padrão deste serviço é <strong>' + fmtMoeda(s.valor_padrao) + '</strong>.');
      opcoes([{
        texto: 'Usar ' + fmtMoeda(s.valor_padrao),
        acao: function () { usuario(fmtMoeda(s.valor_padrao)); nota.valor = Number(s.valor_padrao); revisar(); }
      }]);
    } else {
      bot('Qual o valor do serviço?');
    }
    marcar(perguntarValor);
    erros = 0;
    etapa = 'valor';
    pedir('Ex.: 1500,00', 'Use vírgula ou ponto para os centavos. Digite "voltar" para corrigir a resposta anterior.');
  }

  function revisar() {
    travarEntrada();
    var e = nota.empresa, t = nota.tomador, s = nota.servico;
    bloco(
      '<div class="resumo">' +
        '<h3>Confira antes de emitir</h3>' +
        '<dl>' +
          '<dt>Empresa</dt><dd>' + esc(e.nome_fantasia || e.razao_social) + '</dd>' +
          '<dt>Ambiente</dt><dd>' + (e.ambiente === 'producao'
            ? '<span class="tag err">produção — valor fiscal</span>'
            : '<span class="tag ok">homologação — teste</span>') + '</dd>' +
          '<dt>Cliente</dt><dd>' + esc(t.razao_social) + '<br><span class="mono">' + fmtDoc(t.documento) + '</span></dd>' +
          '<dt>Serviço</dt><dd>' + esc(s.descricao) + '</dd>' +
        '</dl>' +
        '<div class="total">' + fmtMoeda(nota.valor) + '</div>' +
      '</div>');
    opcoes([
      { texto: 'Emitir nota', acao: emitir },
      { texto: 'Cancelar', detalhe: 'recomeçar do zero', acao: function () {
          usuario('Cancelar'); nota = {}; conversa.innerHTML = ''; iniciar(); } }
    ]);
  }

  function emitir() {
    usuario('Emitir nota');
    bot('Emitindo... isso leva alguns segundos.');
    travarEntrada();

    var t = nota.tomador, s = nota.servico, e = nota.empresa;
    var docT = digits(t.documento);
    var corpo = {
      cnpjEmpresa: e.cnpj,
      referencia: 'EMISSOR-' + Date.now(),
      tomador: {},
      servico: {
        codigoTributacaoNacional: s.codigo_tributacao,
        descricao: s.descricao
      },
      valores: { valorServico: nota.valor, issRetido: s.iss_retido === true }
    };
    if (docT.length === 14) corpo.tomador.cnpj = docT; else corpo.tomador.cpf = docT;
    corpo.tomador.razaoSocial = t.razao_social;
    if (t.email) corpo.tomador.email = t.email;
    if (t.logradouro) {
      corpo.tomador.endereco = {
        codigoMunicipio: t.codigo_municipio, cep: t.cep, logradouro: t.logradouro,
        numero: t.numero, complemento: t.complemento, bairro: t.bairro
      };
    }
    /* Fora do Simples, a alíquota do serviço é o que vale — e é para isso que
       o campo existe: em 010_emissor.sql ele está descrito como "usada fora do
       Simples Nacional".

       Dentro do Simples, esta tela mandava essa MESMA alíquota como
       percentualTotalTributosSN, que é outra coisa: o pTotTribSN é a alíquota
       efetiva do PGDAS-D, não a de ISS. Enquanto o servidor não preenchia nada,
       o número errado era melhor que nenhum. Agora que ele aplica o
       perc_total_tributos da empresa, mandar daqui só serviria para
       sobrescrever o valor certo pelo errado — porque o que o chamador manda
       vence. Então não manda: o servidor resolve. */
    if ([2, 3].indexOf(Number(e.op_simp_nac)) < 0 && s.aliquota_iss) {
      corpo.valores.aliquotaIss = Number(s.aliquota_iss);
    }

    /* Clicar duas vezes em "Emitir nota" enviaria duas DPS. A referência
       resolve no servidor, mas gastar uma ida e vir com dúvida é pior do que
       simplesmente não deixar o segundo clique acontecer. */
    if (nota.emitindo) return;
    nota.emitindo = true;

    api('/nfse', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(corpo) })
      .then(function (r) {
        salvarAprendizado();
        acompanhar(r.notaId);
      })
      .catch(function (err) {
        nota.emitindo = false;
        bot('<strong>Não foi possível emitir.</strong><br>' + esc(err.message));
        /* Nada foi emitido: os dados continuam válidos, e obrigar a redigitar
           tudo por um erro que não foi da pessoa é castigo sem motivo. */
        opcoes([
          { texto: 'Tentar emitir de novo', acao: function () { revisar(); } },
          { texto: 'Corrigir o valor', acao: function () { nota.valorConfirmado = false; perguntarValor(); } },
          { texto: 'Recomeçar', acao: function () {
              conversa.innerHTML = ''; nota = {}; historico = [];
              el('barraEmpresa').hidden = true; iniciar(); } }
        ]);
      });
  }

  /* Guarda cliente e serviço para as próximas emissões ficarem mais rápidas. */
  function salvarAprendizado() {
    var t = nota.tomador, s = nota.servico, e = nota.empresa;
    var depois = function () {
      api('/emissor/registrar-uso', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ tomadorId: nota.tomador && nota.tomador.id, servicoId: s && s.id })
      }).catch(function(){});
    };
    if (nota.tomadorNovo && t && t.razao_social) {
      api('/emissor/tomador', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          empresaId: e.id, documento: t.documento, razaoSocial: t.razao_social,
          email: t.email, telefone: t.telefone, codigoMunicipio: t.codigo_municipio,
          cep: t.cep, logradouro: t.logradouro, numero: t.numero,
          complemento: t.complemento, bairro: t.bairro, uf: t.uf
        })
      }).then(function (salvo) { nota.tomador = salvo; depois(); }).catch(depois);
    } else { depois(); }
  }

  /* A emissão é assíncrona: consulta até sair do "processando". */
  function acompanhar(notaId) {
    var tentativas = 0;
    var timer = setInterval(function () {
      tentativas++;
      api('/nfse/local/' + notaId).then(function (n) {
        if (n.status === 'processando') {
          if (tentativas > 20) { clearInterval(timer); bot('A nota ainda está sendo processada. Consulte no painel em instantes.'); }
          return;
        }
        clearInterval(timer);
        if (n.status === 'autorizada') {
          bot('<strong>Nota autorizada!</strong>');
          bloco(
            '<div class="resumo">' +
              '<dl>' +
                '<dt>Número</dt><dd>' + esc(n.serie) + '/' + esc(n.numero) + '</dd>' +
                '<dt>Chave</dt><dd class="mono">' + esc(n.chave_acesso) + '</dd>' +
              '</dl>' +
              '<div class="acoes-nota">' +
                '<a href="#" data-doc="danfse" data-id="' + n.id + '">Baixar PDF</a>' +
                '<a href="#" data-doc="xml" data-id="' + n.id + '">Baixar XML</a>' +
              '</div>' +
            '</div>');
          ligarDownloads();
        } else {
          var motivo = n.ultimo_erro ||
            (n.mensagens && n.mensagens.erros && n.mensagens.erros
              .map(function (x) { return x.Complemento || x.Descricao; }).join(' · ')) ||
            'sem detalhe informado';
          bot('<strong>A nota não foi autorizada.</strong><br>' + esc(motivo),
              'O número desta DPS foi consumido — a próxima tentativa usa o seguinte. ' +
              'Nenhuma nota existe com estes dados.');
        }
        /* A próxima nota quase sempre é da mesma empresa. Voltar ao começo
           obrigaria a procurá-la de novo na lista — e a chance de escolher a
           errada nasce aí. */
        var empresaAtual = nota.empresa;
        opcoes([
          { texto: 'Outra nota para ' + esc(empresaAtual.nome_fantasia || empresaAtual.razao_social),
            acao: function () {
              conversa.innerHTML = ''; nota = {};
              escolherEmpresa(empresaAtual);
            } },
          { texto: 'Trocar de empresa',
            acao: function () {
              conversa.innerHTML = ''; nota = {};
              el('barraEmpresa').hidden = true;
              iniciar();
            } }
        ]);
      }).catch(function () { clearInterval(timer); });
    }, 2500);
  }

  /* Download com o header de autenticação — link direto não carrega a chave. */
  function ligarDownloads() {
    Array.prototype.forEach.call(document.querySelectorAll('a[data-doc]'), function (a) {
      if (a._ligado) return;
      a._ligado = true;
      a.onclick = function (ev) {
        ev.preventDefault();
        var url = '/nfse/' + a.dataset.id + '/' + a.dataset.doc;
        fetch(url, { credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('Documento indisponível'); return r.blob(); })
          .then(function (b) {
            var link = document.createElement('a');
            link.href = URL.createObjectURL(b);
            link.download = (a.dataset.doc === 'danfse' ? 'NFSe-' : 'NFSe-') + a.dataset.id +
                            (a.dataset.doc === 'danfse' ? '.pdf' : '.xml');
            document.body.appendChild(link); link.click(); link.remove();
            URL.revokeObjectURL(link.href);
          })
          .catch(function (e) { bot('Não consegui baixar: ' + esc(e.message)); });
      };
    });
  }

  // ------------------------------------------------------- entrada de texto

  /* Limite do campo de descrição na DPS. Cortar aqui é melhor do que a Sefin
     recusar depois — e a pessoa vê o corte antes de confirmar. */
  var MAX_DESCRICAO = 2000;

  /* Acima disso, pergunta antes de aceitar. Não é um teto: é o dedo escorregando
     no teclado numérico, que numa nota fiscal vira imposto a mais e um
     cancelamento para desfazer. */
  var VALOR_QUE_ASSUSTA = 100000;

  function processar(texto) {
    texto = (texto || '').trim();
    if (!texto) return;

    if (PEDIDOS_DE_VOLTA.test(texto)) { voltar(); return; }

    if (etapa === 'tomador') {
      var doc = digits(texto);
      if (doc.length !== 11 && doc.length !== 14) {
        naoEntendi('Esse documento não parece válido.',
          'CNPJ tem 14 dígitos e CPF tem 11 — você digitou ' + doc.length + '.');
        return;
      }
      usuario(fmtDoc(doc));
      buscarTomador(doc);
      return;
    }
    if (etapa === 'tomadorNome') {
      if (texto.length < 3) {
        naoEntendi('O nome ficou curto demais.', 'Escreva o nome ou a razão social do cliente.');
        return;
      }
      usuario(texto);
      nota.tomador.razao_social = texto.slice(0, 300);
      perguntarServico();
      return;
    }
    if (etapa === 'servicoCodigo') {
      var cod = digits(texto);
      if (cod.length !== 6) {
        naoEntendi('O código de tributação nacional tem 6 dígitos.',
          'Você digitou ' + cod.length + '. Ex.: 110201 (vigilância), 010101 (sistemas).');
        return;
      }
      usuario(cod);
      nota.servico = { codigo_tributacao: cod };
      marcar(function () {
        bot('Descreva o serviço como deve aparecer na nota.');
        etapa = 'servicoDescricao';
        pedir('Ex.: Servico de vigilancia patrimonial');
      });
      erros = 0;
      bot('Descreva o serviço como deve aparecer na nota.');
      etapa = 'servicoDescricao';
      pedir('Ex.: Servico de vigilancia patrimonial');
      return;
    }
    if (etapa === 'servicoDescricao') {
      if (texto.length < 3) {
        naoEntendi('A descrição ficou curta demais.',
          'É o que o cliente vai ler na nota — escreva o serviço prestado.');
        return;
      }
      if (texto.length > MAX_DESCRICAO) {
        naoEntendi('A descrição passou de ' + MAX_DESCRICAO + ' caracteres.',
          'Você escreveu ' + texto.length + '. Resuma — a Sefin recusa acima disso.');
        return;
      }
      usuario(texto);
      nota.servico.descricao = texto;
      nota.servico.apelido = texto.slice(0, 40);
      perguntarValor();
      return;
    }
    if (etapa === 'valor') {
      /* Mesma leitura de dinheiro do painel e da tela de emissão, de
         valorbr.js: três regras diferentes para o mesmo número seria uma
         divergindo das outras. */
      var v = window.parseValorBR(texto);
      if (v === undefined || !isFinite(v)) {
        naoEntendi('Não entendi o valor.',
          'Digite algo como 1500,00 ou 1.234,56.');
        return;
      }
      if (v <= 0) {
        naoEntendi('O valor precisa ser maior que zero.',
          'Nota de valor zero a Sefin não aceita.');
        return;
      }
      if (v >= VALOR_QUE_ASSUSTA && !nota.valorConfirmado) {
        usuario(fmtMoeda(v));
        bot('Confirma <strong>' + fmtMoeda(v) + '</strong>?',
            'É um valor alto — vale conferir antes, porque desfazer depois exige cancelamento.');
        opcoes([
          { texto: 'Sim, é esse valor', acao: function () {
              nota.valorConfirmado = true; nota.valor = v; revisar(); } },
          { texto: 'Não, digitar de novo', acao: function () {
              nota.valorConfirmado = false; perguntarValor(); } }
        ]);
        travarEntrada();
        return;
      }
      usuario(fmtMoeda(v));
      nota.valor = v;
      revisar();
      return;
    }
  }

  el('enviar').onclick = function () { var v = el('campo').value; el('campo').value=''; processar(v); };
  el('campo').onkeydown = function (ev) {
    if (ev.key === 'Enter') { var v = el('campo').value; el('campo').value=''; processar(v); }
  };

  iniciar();
})();
