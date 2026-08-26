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
        opcoes(aptas.map(function (e) {
          return {
            texto: e.nome_fantasia || e.razao_social,
            detalhe: fmtDoc(e.cnpj) + ' · ' + e.ambiente,
            acao: function () { escolherEmpresa(e); }
          };
        }));
        travarEntrada();
      }
    }).catch(function (e) {
      bot('Não consegui carregar os dados: ' + esc(e.message));
      if (/sess|401|logado/i.test(e.message)) location.href = '/admin';
    });
  }

  function escolherEmpresa(e) {
    nota.empresa = e;
    usuario(e.nome_fantasia || e.razao_social);
    el('avisoProd').hidden = e.ambiente !== 'producao';
    // Recarrega tomadores e serviços já usados por esta empresa.
    api('/emissor/contexto?empresaId=' + e.id).then(function (d) {
      ctx.tomadores = d.tomadores || [];
      ctx.servicos = d.servicos || [];
      perguntarTomador();
    }).catch(function () { perguntarTomador(); });
  }

  function perguntarTomador() {
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
        bot('Não deu certo: ' + esc(e.message));
        etapa = 'tomador';
        pedir('CNPJ ou CPF do cliente');
      });
  }

  function perguntarServico() {
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
    etapa = 'valor';
    pedir('Ex.: 1500,00', 'Use vírgula ou ponto para os centavos.');
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
    // Optante do Simples informa o percentual do PGDAS; os demais, a alíquota.
    if ([2, 3].indexOf(Number(e.op_simp_nac)) >= 0) {
      if (s.aliquota_iss) corpo.valores.percentualTotalTributosSN = Number(s.aliquota_iss);
    } else if (s.aliquota_iss) {
      corpo.valores.aliquotaIss = Number(s.aliquota_iss);
    }

    api('/nfse', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(corpo) })
      .then(function (r) {
        salvarAprendizado();
        acompanhar(r.notaId);
      })
      .catch(function (err) {
        bot('<strong>Não foi possível emitir.</strong><br>' + esc(err.message));
        opcoes([{ texto: 'Tentar de novo', acao: function () { conversa.innerHTML=''; nota={}; iniciar(); } }]);
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
              'Corrija o que for necessário e emita novamente.');
        }
        opcoes([{ texto: 'Emitir outra nota', acao: function () { conversa.innerHTML=''; nota={}; iniciar(); } }]);
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

  function processar(texto) {
    texto = (texto || '').trim();
    if (!texto) return;

    if (etapa === 'tomador') {
      var doc = digits(texto);
      if (doc.length !== 11 && doc.length !== 14) {
        bot('Esse documento não parece válido. CNPJ tem 14 dígitos e CPF tem 11.');
        return;
      }
      usuario(fmtDoc(doc));
      buscarTomador(doc);
      return;
    }
    if (etapa === 'tomadorNome') {
      usuario(texto);
      nota.tomador.razao_social = texto;
      perguntarServico();
      return;
    }
    if (etapa === 'servicoCodigo') {
      var cod = digits(texto);
      if (cod.length !== 6) { bot('O código tem 6 dígitos. Tente de novo.'); return; }
      usuario(cod);
      nota.servico = { codigo_tributacao: cod };
      bot('Descreva o serviço como deve aparecer na nota.');
      etapa = 'servicoDescricao';
      pedir('Ex.: Servico de vigilancia patrimonial');
      return;
    }
    if (etapa === 'servicoDescricao') {
      usuario(texto);
      nota.servico.descricao = texto;
      nota.servico.apelido = texto.slice(0, 40);
      perguntarValor();
      return;
    }
    if (etapa === 'valor') {
      // Aceita "1.500,00" e "1500.00"
      var limpo = texto.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
      var v = Number(limpo);
      if (!Number.isFinite(v) || v <= 0) { bot('Não entendi o valor. Digite algo como 1500,00.'); return; }
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
