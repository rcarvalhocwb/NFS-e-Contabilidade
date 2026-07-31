/* Painel do NFS-e Gateway.
   Navegação por hash, sem framework: o sistema é pequeno o bastante para não
   justificar build, e assim o arquivo servido é o mesmo que se lê. */
(function () {
  'use strict';

  var CHAVE_STORE = 'nfse_gateway_api_key';
  var el = function (id) { return document.getElementById(id); };
  var $$ = function (sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); };

  var estado = { empresas: [], editando: null, notaAtual: null, resumoInicial: null };

  /* ------------------------------------------------------------ utilidades */

  function chave() { return sessionStorage.getItem(CHAVE_STORE) || ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }
  function fmtDoc(v) {
    v = digitos(v);
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
      return sefin.erros.map(function (e) {
        return (e.codigo ? e.codigo + ': ' : '') + (e.descricao || e.mensagem || '') +
               (e.complemento ? ' — ' + e.complemento : '');
      }).join(' | ');
    }
    return sefin.mensagem || sefin.motivo || ('Erro HTTP ' + status);
  }

  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var headers = opcoes.headers || {};
    headers['X-API-Key'] = chave();
    return fetch(caminho, { method: opcoes.method || 'GET', headers: headers, body: opcoes.body })
      .then(function (res) {
        return res.text().then(function (t) {
          var dados = null;
          try { dados = t ? JSON.parse(t) : null; } catch (e) { dados = { erro: t }; }
          if (res.status === 401) { sair(); throw new Error('Sessão expirada'); }
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

  function entrar(valor) {
    sessionStorage.setItem(CHAVE_STORE, valor);
    return api('/painel/resumo').then(function (resumo) {
      // O resumo já veio na validação da chave; a tela inicial reaproveita em
      // vez de repetir a consulta assim que abre.
      estado.resumoInicial = resumo;
      el('rodapeAmbiente').textContent = 'versão ' + resumo.versao;
      el('telaAcesso').hidden = true;
      el('app').hidden = false;
      // Carrega uma vez: os filtros e seletores de várias telas dependem disso
      api('/empresas').then(function (l) {
        estado.empresas = l || []; preencherSelectsEmpresa();
      }).catch(function () {});
      navegar(location.hash.replace('#','') || 'inicio');
    }).catch(function (e) {
      sessionStorage.removeItem(CHAVE_STORE);
      var box = el('erroAcesso');
      box.textContent = /Sessão|401|inválida/i.test(e.message)
        ? 'Chave incorreta. Confira o valor de GATEWAY_API_KEY no arquivo .env.'
        : e.message;
      box.className = 'aviso erro';
      throw e;
    });
  }
  function sair() {
    sessionStorage.removeItem(CHAVE_STORE);
    el('app').hidden = true;
    el('telaAcesso').hidden = false;
    el('campoChave').value = '';
  }

  el('formAcesso').onsubmit = function (ev) {
    ev.preventDefault();
    el('erroAcesso').className = 'aviso';
    var v = el('campoChave').value.trim();
    if (v) entrar(v).catch(function () {});
  };
  el('btnSair').onclick = sair;

  /* ------------------------------------------------------------ navegação */

  var TELAS = {
    inicio:      { titulo:'Início',        sub:'Visão geral do sistema',                carregar: carregarInicio },
    empresas:    { titulo:'Empresas',      sub:'Cadastro, certificados e numeração',    carregar: carregarEmpresas },
    empresaEdit: { titulo:'Empresa',       sub:'',                                       carregar: null },
    notas:       { titulo:'Notas emitidas',sub:'Consulta, XML, PDF e cancelamento',     carregar: carregarNotas },
    clientes:    { titulo:'Clientes',      sub:'Tomadores usados nas emissões',         carregar: carregarClientes },
    servicos:    { titulo:'Serviços',      sub:'Modelos para emitir mais rápido',       carregar: carregarServicos },
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
        tb.appendChild(tr);
      });
      preencherSelectsEmpresa();
    }).catch(function (e) { aviso(e.message, 'erro'); });
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

  function aba(nome) {
    $$('#abas button').forEach(function (b) { b.classList.toggle('ativo', b.dataset.aba === nome); });
    ['identificacao','endereco','contato','responsavel','contabilidade','fiscais','certificado','integracao']
      .forEach(function (p) { el('aba-' + p).classList.toggle('ativo', p === nome); });
    // Numeração, certificado e integração gravam por conta própria
    el('acoesEmpresa').style.display =
      (nome === 'fiscais' || nome === 'certificado' || nome === 'integracao') ? 'none' : '';
    if (nome === 'integracao' && estado.editando) carregarIntegracao(estado.editando);
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
    travarAbasNovas(false); aba('identificacao');

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
      contadorDoc: digitos(el('f_contador').value) || null,
      emailTomadorAtivo: el('f_email_tom').value === 'true'
    };
  }

  el('btnSalvarEmp').onclick = function () {
    var cnpj = digitos(el('f_cnpj').value);
    if (!estado.editando && cnpj.length !== 14) { aba('identificacao'); return aviso('CNPJ deve ter 14 dígitos.', 'erro'); }
    var corpo = coletarEmpresa();
    if (!corpo.razaoSocial) { aba('identificacao'); return aviso('Razão social é obrigatória.', 'erro'); }
    if (!/^\d{7}$/.test(corpo.codigoMunicipio)) { aba('endereco'); return aviso('Código do município deve ter 7 dígitos (IBGE).', 'erro'); }
    if (estado.editando) corpo.ativo = el('f_ativo').value === 'true'; else corpo.cnpj = cnpj;

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
    var cnpj = digitos(el('f_cnpj').value);
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
      el('notaCancelar').hidden = !(n.status === 'autorizada' && n.chave_acesso);
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
    fetch(caminho, { headers: { 'X-API-Key': chave() } })
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
    fetch('/nfse/export?' + q.join('&'), { headers: { 'X-API-Key': chave() } })
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

  if (chave()) {
    entrar(chave()).catch(function () {});
  } else {
    el('telaAcesso').hidden = false;
  }
})();
