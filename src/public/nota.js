/* Emissão por formulário.
   O modo conversa é bom para quem emite uma nota de vez em quando; quem emite
   em série precisa ver todos os campos de uma vez e usar o Tab. */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };
  var estado = { empresas: [], tomadores: [], servicos: [], usuario: null, ultimaNota: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }
  function num(id) {
    var v = el(id).value;
    return v === '' ? undefined : Number(v);
  }
  function fmtMoeda(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  }
  function fmtDoc(v) {
    v = digitos(v);
    if (v.length === 14) return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    if (v.length === 11) return v.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    return v;
  }

  function aviso(texto, tipo) {
    var a = el('aviso');
    a.textContent = texto;
    a.className = 'aviso ' + (tipo || 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tipo !== 'erro') setTimeout(function () { a.className = 'aviso'; }, 5000);
  }

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
    return sefin.mensagem || ('Erro HTTP ' + status);
  }

  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    return fetch(caminho, {
      method: opcoes.method || 'GET',
      headers: opcoes.headers || {},
      body: opcoes.body,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (t) {
        var dados = null;
        try { dados = t ? JSON.parse(t) : null; } catch (e) { dados = { erro: t }; }
        if (res.status === 401) { location.href = '/admin'; throw new Error('Sessão expirada'); }
        if (!res.ok) throw new Error(mensagemErro(dados, res.status));
        return dados;
      });
    });
  }

  /* ------------------------------------------------------------- carga */

  function iniciar() {
    api('/usuarios/eu').then(function (u) {
      estado.usuario = u;
      return api('/emissor/contexto');
    }).then(function (d) {
      estado.empresas = (d.empresas || []).filter(function (e) { return e.tem_certificado; });

      if (!estado.empresas.length) {
        aviso('Nenhuma empresa com certificado digital. Cadastre no painel antes de emitir.', 'erro');
        el('btnEmitir').disabled = true;
        return;
      }

      var sel = el('fEmpresa');
      sel.innerHTML = '';
      estado.empresas.forEach(function (e) {
        var o = document.createElement('option');
        o.value = e.id;
        o.textContent = (e.nome_fantasia || e.razao_social) + ' — ' + fmtDoc(e.cnpj);
        sel.appendChild(o);
      });

      // Empresa padrão do usuário, se ainda estiver visível para ele
      var padrao = estado.usuario.empresaPadraoId;
      if (padrao && estado.empresas.some(function (e) { return e.id === padrao; })) {
        sel.value = padrao;
        el('fPadrao').checked = true;
      }
      trocarEmpresa();
    }).catch(function (e) { aviso(e.message, 'erro'); });
  }

  function empresaAtual() {
    var id = Number(el('fEmpresa').value);
    return estado.empresas.filter(function (e) { return e.id === id; })[0];
  }

  function trocarEmpresa() {
    var e = empresaAtual();
    if (!e) return;

    el('faixaProd').hidden = e.ambiente !== 'producao';
    el('fEmpresaInfo').textContent = e.ambiente === 'producao'
      ? 'Produção — a nota terá valor fiscal'
      : 'Homologação — nota de teste, sem valor fiscal';

    // Simples Nacional não declara alíquota de ISS: o imposto sai no DAS
    var optanteSN = [2, 3].indexOf(Number(e.op_simp_nac)) !== -1;
    el('fAliquota').disabled = optanteSN;
    if (optanteSN) el('fAliquota').value = '';
    el('ajudaAliquota').textContent = optanteSN
      ? 'Optante do Simples: o ISS sai no DAS, sem alíquota na nota.'
      : '';

    carregarSugestoes(e.id);
  }

  function carregarSugestoes(empresaId) {
    api('/emissor/contexto?empresaId=' + empresaId).then(function (d) {
      estado.tomadores = d.tomadores || [];
      estado.servicos = d.servicos || [];

      var st = el('sugTomadores'); st.innerHTML = '';
      estado.tomadores.slice(0, 6).forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = t.razao_social;
        b.onclick = function () { preencherTomador(t); };
        st.appendChild(b);
      });

      var ss = el('sugServicos'); ss.innerHTML = '';
      if (estado.servicos.length) {
        var rot = document.createElement('span');
        rot.className = 'ajuda';
        rot.style.cssText = 'align-self:center;margin:0 4px 0 0';
        rot.textContent = 'Serviços salvos:';
        ss.appendChild(rot);
      }
      estado.servicos.slice(0, 8).forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = s.apelido;
        b.onclick = function () { preencherServico(s); };
        ss.appendChild(b);
      });
    }).catch(function () { /* sugestão é conveniência, não bloqueia */ });
  }

  function preencherTomador(t) {
    el('fDoc').value = t.documento || '';
    el('fNome').value = t.razao_social || '';
    el('fMunTom').value = t.codigo_municipio || '';
    el('fEmailTom').value = t.email || '';
    el('fFoneTom').value = t.telefone || '';
  }

  function preencherServico(s) {
    el('fCodTrib').value = s.codigo_tributacao || '';
    el('fDescricao').value = s.descricao || '';
    if (s.valor_padrao != null) el('fValor').value = s.valor_padrao;
    if (s.aliquota_iss != null && !el('fAliquota').disabled) el('fAliquota').value = s.aliquota_iss;
    el('fIssRetido').value = s.iss_retido ? 'true' : 'false';
    if (s.tributacao_issqn) el('fNatureza').value = String(s.tributacao_issqn);
    if (s.informacoes_complementares) el('fCompl').value = s.informacoes_complementares;
    aplicarNatureza();
    atualizarTotal();
  }

  /* --------------------------------------------------------- interações */

  el('fEmpresa').onchange = trocarEmpresa;

  el('fPadrao').onchange = function () {
    var id = el('fPadrao').checked ? Number(el('fEmpresa').value) : null;
    api('/usuarios/eu/empresa-padrao', {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ empresaId: id })
    }).then(function () {
      aviso(id ? 'Esta empresa passa a vir escolhida por padrão.' : 'Empresa padrão removida.');
    }).catch(function (e) { aviso(e.message, 'erro'); });
  };

  /* A natureza da operação decide o que mais precisa ser informado — e o que
     não pode ser: imunidade e não incidência não declaram alíquota de ISS. */
  function aplicarNatureza() {
    var n = el('fNatureza').value;
    el('wrapImunidade').hidden = n !== '4';
    el('wrapSuspensao').hidden = !(n === '5' || n === '6');
    el('wrapPais').hidden = n !== '2';
    if (n === '5') el('fTipoSusp').value = '1';
    if (n === '6') el('fTipoSusp').value = '2';

    var tributavel = n === '1';
    var e = empresaAtual();
    var optanteSN = e && [2, 3].indexOf(Number(e.op_simp_nac)) !== -1;
    el('fAliquota').disabled = !tributavel || optanteSN;
    if (!tributavel) {
      el('fAliquota').value = '';
      el('ajudaAliquota').textContent = 'Sem ISS a declarar nesta natureza.';
    } else if (!optanteSN) {
      el('ajudaAliquota').textContent = '';
    }
  }
  el('fNatureza').onchange = function () { aplicarNatureza(); atualizarTotal(); };

  el('btnBuscarDoc').onclick = function () {
    var doc = digitos(el('fDoc').value);
    if (doc.length !== 14 && doc.length !== 11) {
      return aviso('Informe um CNPJ (14 dígitos) ou CPF (11 dígitos).', 'erro');
    }
    var e = empresaAtual();
    var b = el('btnBuscarDoc');
    b.disabled = true; b.textContent = 'Buscando…';
    api('/emissor/tomador/' + doc + (e ? '?empresaId=' + e.id : ''))
      .then(function (r) {
        preencherTomador(r.tomador || {});
        el('fDoc').value = doc;
        if (r.origem === 'receita') aviso('Dados obtidos na Receita. Confira antes de emitir.');
        else if (r.origem === 'novo') aviso('Cliente novo — preencha o nome.', 'info');
      })
      .catch(function (err) { aviso(err.message, 'erro'); })
      .then(function () { b.disabled = false; b.textContent = 'Buscar'; });
  };
  el('fDoc').onkeydown = function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); el('btnBuscarDoc').click(); }
  };

  /* Calcula as retenções pelas alíquotas usuais de serviço para PJ. É uma
     sugestão para conferência, não uma apuração: a regra depende do serviço,
     do regime e do contrato. */
  el('btnCalcularRet').onclick = function () {
    var base = num('fValor');
    if (!base) return aviso('Informe o valor do serviço antes de calcular.', 'erro');
    var r2 = function (x) { return Math.round(x * 100) / 100; };
    el('fRetPis').value = r2(base * 0.0065);
    el('fRetCofins').value = r2(base * 0.03);
    el('fRetCsll').value = r2(base * 0.01);
    el('fRetIrrf').value = r2(base * 0.015);
    aviso('Valores sugeridos (PIS 0,65% · COFINS 3% · CSLL 1% · IRRF 1,5%). ' +
          'Confira contra o contrato e o serviço — INSS não entra no cálculo padrão.', 'info');
    atualizarTotal();
  };

  function atualizarTotal() {
    var valor = num('fValor') || 0;
    var desc = num('fDescIncond') || 0;
    el('totalNota').textContent = fmtMoeda(valor - desc);

    var partes = [];
    var aliq = num('fAliquota');
    if (aliq) partes.push('ISS ' + aliq + '%' + (el('fIssRetido').value === 'true' ? ' (retido)' : ''));
    var ret = ['fRetPis','fRetCofins','fRetIrrf','fRetCsll','fRetInss']
      .reduce(function (s, id) { return s + (num(id) || 0); }, 0);
    if (ret) partes.push('retenções federais ' + fmtMoeda(ret));
    if (num('fDeducoes')) partes.push('deduções ' + fmtMoeda(num('fDeducoes')));
    el('resumoTributos').textContent = partes.join(' · ');
  }
  ['fValor','fDescIncond','fAliquota','fIssRetido','fDeducoes',
   'fRetPis','fRetCofins','fRetIrrf','fRetCsll','fRetInss'].forEach(function (id) {
    el(id).addEventListener('input', atualizarTotal);
    el(id).addEventListener('change', atualizarTotal);
  });

  el('btnLimpar').onclick = function () {
    if (!confirm('Limpar todos os campos?')) return;
    ['fDoc','fNome','fMunTom','fEmailTom','fFoneTom','fCodTrib','fCodMun','fMunPrest',
     'fDescricao','fCompl','fValor','fAliquota','fDescIncond','fDeducoes','fNumProcesso',
     'fPais','fCompetencia','fReferencia','fTotTrib',
     'fRetPis','fRetCofins','fRetIrrf','fRetCsll','fRetInss'].forEach(function (id) { el(id).value = ''; });
    el('fNatureza').value = '1';
    el('fIssRetido').value = 'false';
    aplicarNatureza();
    atualizarTotal();
  };

  /* ------------------------------------------------------------- emitir */

  function montarCorpo() {
    var e = empresaAtual();
    var doc = digitos(el('fDoc').value);
    var natureza = el('fNatureza').value;

    var valores = {
      valorServico: num('fValor'),
      issRetido: el('fIssRetido').value === 'true'
    };
    if (!el('fAliquota').disabled && num('fAliquota') !== undefined) valores.aliquotaIss = num('fAliquota');
    if (natureza !== '1') valores.tributacaoIssqn = Number(natureza);
    if (natureza === '4') valores.tipoImunidade = Number(el('fTipoImunidade').value);
    if (natureza === '5' || natureza === '6') {
      valores.tipoSuspensao = Number(el('fTipoSusp').value);
      valores.numeroProcesso = el('fNumProcesso').value.trim() || undefined;
    }
    if (num('fDescIncond') !== undefined) valores.descontoIncondicionado = num('fDescIncond');
    if (num('fDeducoes') !== undefined) valores.valorDeducoes = num('fDeducoes');
    if (num('fTotTrib') !== undefined) {
      var optanteSN = [2, 3].indexOf(Number(e.op_simp_nac)) !== -1;
      if (optanteSN) valores.percentualTotalTributosSN = num('fTotTrib');
      else valores.percentualTotalTributos = num('fTotTrib');
    }

    var ret = {};
    if (num('fRetPis') !== undefined) ret.valorPis = num('fRetPis');
    if (num('fRetCofins') !== undefined) ret.valorCofins = num('fRetCofins');
    if (num('fRetIrrf') !== undefined) ret.valorRetencaoIrrf = num('fRetIrrf');
    if (num('fRetCsll') !== undefined) ret.valorRetencaoCsll = num('fRetCsll');
    if (num('fRetInss') !== undefined) ret.valorRetencaoPrevidencia = num('fRetInss');
    if (Object.keys(ret).length) {
      ret.retidoPeloTomador = el('fRetPeloTomador').checked;
      if (ret.valorPis !== undefined || ret.valorCofins !== undefined) {
        ret.baseCalculo = num('fValor');
      }
      valores.retencoesFederais = ret;
    }

    var corpo = {
      cnpjEmpresa: e.cnpj,
      servico: {
        codigoTributacaoNacional: digitos(el('fCodTrib').value),
        codigoTributacaoMunicipal: el('fCodMun').value.trim() || undefined,
        descricao: el('fDescricao').value.trim(),
        codigoMunicipioPrestacao: digitos(el('fMunPrest').value) || undefined,
        informacoesComplementares: el('fCompl').value.trim() || undefined,
        codigoPaisPrestacao: natureza === '2' ? (el('fPais').value.trim().toUpperCase() || undefined) : undefined
      },
      valores: valores
    };
    if (doc) {
      corpo.tomador = {};
      if (doc.length === 14) corpo.tomador.cnpj = doc; else corpo.tomador.cpf = doc;
      corpo.tomador.razaoSocial = el('fNome').value.trim();
      corpo.tomador.email = el('fEmailTom').value.trim() || undefined;
      corpo.tomador.telefone = el('fFoneTom').value.trim() || undefined;
      if (digitos(el('fMunTom').value)) {
        corpo.tomador.endereco = { codigoMunicipio: digitos(el('fMunTom').value) };
      }
    }
    if (el('fCompetencia').value) corpo.dataCompetencia = el('fCompetencia').value;
    if (el('fReferencia').value.trim()) corpo.referencia = el('fReferencia').value.trim();
    return corpo;
  }

  function validar() {
    var e = empresaAtual();
    if (!e) return 'Escolha a empresa emissora.';
    if (!/^\d{6}$/.test(digitos(el('fCodTrib').value))) return 'O código de tributação tem 6 dígitos.';
    if (!el('fDescricao').value.trim()) return 'Descreva o serviço prestado.';
    if (!num('fValor') || num('fValor') <= 0) return 'Informe o valor do serviço.';
    var doc = digitos(el('fDoc').value);
    if (doc && doc.length !== 11 && doc.length !== 14) return 'Documento do cliente inválido.';
    if (doc && !el('fNome').value.trim()) return 'Informe o nome do cliente.';
    if (el('fNatureza').value === '2' && !el('fPais').value.trim()) {
      return 'Exportação de serviço exige o país da prestação.';
    }
    return null;
  }

  el('btnEmitir').onclick = function () {
    var problema = validar();
    if (problema) return aviso(problema, 'erro');

    var e = empresaAtual();
    if (e.ambiente === 'producao') {
      if (!confirm('Emitir em PRODUÇÃO?\n\n' +
                   (el('fNome').value.trim() || 'Cliente') + '\n' +
                   fmtMoeda(num('fValor')) + '\n\n' +
                   'A nota terá valor fiscal e gera imposto.')) return;
    }

    var b = el('btnEmitir');
    b.disabled = true; b.textContent = 'Emitindo…';
    el('resTitulo').textContent = 'Enviando à Sefin Nacional…';
    el('resSub').textContent = 'Isso leva alguns segundos.';
    el('resCorpo').innerHTML = '';
    el('resNova').hidden = true;
    el('dlgResultado').showModal();

    api('/nfse', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(montarCorpo())
    }).then(function (r) {
      estado.ultimaNota = r;
      acompanhar(r.notaId, 0);
    }).catch(function (err) {
      el('resTitulo').textContent = 'A nota não foi emitida';
      el('resSub').textContent = '';
      el('resCorpo').innerHTML = '<div class="aviso erro" style="display:block">' + esc(err.message) + '</div>';
    }).then(function () {
      b.disabled = false; b.textContent = 'Emitir nota';
    });
  };

  /* A emissão é assíncrona: o worker transmite e atualiza o status. Aqui se
     acompanha até sair do "processando". */
  function acompanhar(notaId, tentativa) {
    if (tentativa > 30) {
      el('resTitulo').textContent = 'Ainda processando';
      el('resSub').textContent = 'A nota foi enviada. Acompanhe em Notas emitidas, no painel.';
      return;
    }
    api('/nfse/local/' + notaId).then(function (n) {
      if (n.status === 'processando') {
        el('resSub').textContent = 'Aguardando a Sefin… (' + (tentativa + 1) + ')';
        return setTimeout(function () { acompanhar(notaId, tentativa + 1); }, 2000);
      }

      if (n.status === 'autorizada') {
        el('resTitulo').textContent = 'Nota autorizada';
        el('resSub').textContent = 'Série ' + n.serie + ' · número ' + n.numero;
        el('resCorpo').innerHTML =
          '<dl class="kv" style="margin-bottom:14px">' +
          '<dt>Chave de acesso</dt><dd class="mono">' + esc(n.chave_acesso) + '</dd>' +
          '</dl>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a class="botao" href="/nfse/' + n.id + '/danfse" target="_blank">Abrir PDF</a>' +
          '<a class="botao" href="/nfse/' + n.id + '/xml" download>Baixar XML</a>' +
          '</div>';
        el('resNova').hidden = false;
        registrarUso();
      } else {
        el('resTitulo').textContent = 'A nota não foi autorizada';
        el('resSub').textContent = 'Status: ' + n.status;
        el('resCorpo').innerHTML = '<div class="aviso erro" style="display:block">' +
          esc(n.ultimo_erro || mensagemErro(n.mensagens, 0)) + '</div>' +
          '<div class="ajuda" style="margin-top:10px">Corrija os dados e emita novamente. ' +
          'O número desta DPS não pode ser reaproveitado.</div>';
      }
    }).catch(function (e) {
      el('resTitulo').textContent = 'Não consegui consultar o resultado';
      el('resCorpo').innerHTML = '<div class="aviso erro" style="display:block">' + esc(e.message) + '</div>';
    });
  }

  /* Realimenta as sugestões: o que se usa mais aparece primeiro na próxima. */
  function registrarUso() {
    var doc = digitos(el('fDoc').value);
    var t = estado.tomadores.filter(function (x) { return x.documento === doc; })[0];
    var cod = digitos(el('fCodTrib').value);
    var s = estado.servicos.filter(function (x) { return x.codigo_tributacao === cod; })[0];
    if (!t && !s) return;
    api('/emissor/registrar-uso', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tomadorId: t && t.id, servicoId: s && s.id })
    }).catch(function () { /* estatística não bloqueia nada */ });
  }

  el('resFechar').onclick = function () { el('dlgResultado').close(); };
  el('resNova').onclick = function () {
    el('dlgResultado').close();
    ['fCodTrib','fDescricao','fCompl','fValor','fReferencia'].forEach(function (id) { el(id).value = ''; });
    atualizarTotal();
    el('fCodTrib').focus();
    aviso('Cliente e empresa mantidos. Preencha o novo serviço.');
  };

  iniciar();
  atualizarTotal();
})();
