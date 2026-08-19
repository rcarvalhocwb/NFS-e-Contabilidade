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
  /* CNPJ aceita letra desde julho/2026 — limpar com /\D/g apagaria o documento. */
  function docLimpo(v) { return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
  /* Lê um valor escrito como se escreve no Brasil.
   *
   * O campo era <input type="number">, que só entende ponto decimal. Quem
   * digitasse "1.234,56" — mil duzentos e trinta e quatro reais, a forma que
   * todo contador usa — via o campo virar 1.23456, e a nota sairia com R$ 1,23.
   * Mil vezes menos, sem nenhum erro na tela, virando documento fiscal.
   *
   * Regras, na ordem:
   *   tem vírgula      → ela é o decimal; pontos são separador de milhar
   *   só tem ponto     → ponto que separa exatamente 3 dígitos finais, havendo
   *                      outro ponto ou grupo inicial curto, é milhar;
   *                      caso contrário é decimal (aceita "1234.56" colado de
   *                      planilha em inglês)
   */
  function parseValorBR(texto) {
    var v = String(texto == null ? '' : texto).trim().replace(/\s|R\$| /g, '');
    if (v === '') return undefined;

    var negativo = /^-/.test(v);
    v = v.replace(/^[+-]/, '');
    if (!/^[\d.,]+$/.test(v)) return NaN;

    if (v.indexOf(',') >= 0) {
      // Mais de uma vírgula não é número, é engano de digitação
      if (v.split(',').length > 2) return NaN;
      v = v.replace(/\./g, '').replace(',', '.');
    } else if (v.indexOf('.') >= 0) {
      var grupos = v.split('.');
      var ultimo = grupos[grupos.length - 1];
      var milhar = ultimo.length === 3 &&
                   (grupos.length > 2 || grupos[0].length <= 3);
      if (milhar) v = grupos.join('');
    }

    var n = Number(v);
    if (!isFinite(n)) return NaN;
    return negativo ? -n : n;
  }

  /* Escreve de volta no formato brasileiro, para a pessoa conferir o que o
     sistema entendeu — é o retorno visual que faltava. */
  function fmtValorBR(n) {
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2,
                                               maximumFractionDigits: 2 });
  }

  function num(id) {
    return parseValorBR(el(id).value);
  }
  function fmtMoeda(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  }
  function fmtDoc(v) {
    v = docLimpo(v);
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
    return sefin.mensagem || sefin.Mensagem ||
           ('A Sefin recusou a nota sem detalhar o motivo (HTTP ' + status + ')');
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

  /* Indicadores de operação do IBS/CBS: lista da Sefin, carregada uma vez.
     Sem ela o campo é digitação de seis dígitos sem significado, e um código
     que não existe na tabela só é recusado depois de gastar o número da DPS. */
  function carregarIndicadoresOperacao() {
    api('/emissor/indicadores-operacao').then(function (lista) {
      var sel = el('fIbsOperacao');
      sel.innerHTML = '<option value="">Escolha…</option>';
      lista.forEach(function (i) {
        var o = document.createElement('option');
        o.value = i.codigo;
        o.textContent = i.codigo + ' — ' + i.tipo;
        o.title = i.caracteristica || '';
        sel.appendChild(o);
      });
    }).catch(function () { /* o grupo IBS/CBS é facultativo; sem lista, sem bloco */ });
  }

  function iniciar() {
    carregarIndicadoresOperacao();
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
      aplicarSugestoes(d.sugestoes || {});

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

  /* Preenche o que o sistema já sabe.
     Só campos vazios: quem digitou algo tem a palavra final, e sobrescrever o
     que a pessoa acabou de escrever é pior que não preencher. */
  function aplicarSugestoes(sug) {
    estado.sugestoes = sug;
    var vazio = function (id) { return !el(id).value; };

    // Município da prestação: o da empresa, que é o caso comum
    if (sug.municipioPrestacao && vazio('fMunPrest')) {
      el('fMunPrest').value = sug.municipioPrestacao;
    }
    if (sug.competencia && vazio('fCompetencia')) {
      el('fCompetencia').value = sug.competencia;
    }
    /* Os padrões da empresa vêm primeiro, e por isso ficam antes da alíquota
       do município e da última nota: foi o contador quem os cadastrou olhando
       o enquadramento do cliente, enquanto os outros dois são inferência. */
    var pad = sug.padroes || {};
    if (pad.codigoTributacao && vazio('fCodTrib')) el('fCodTrib').value = pad.codigoTributacao;
    if (pad.codigoNbs && vazio('fNbs')) el('fNbs').value = pad.codigoNbs;
    if (pad.codigoTributacaoMunicipal && vazio('fCodMun')) {
      el('fCodMun').value = pad.codigoTributacaoMunicipal;
    }
    if (pad.descricao && vazio('fDescricao')) el('fDescricao').value = pad.descricao;
    if (pad.tributacaoIssqn) {
      el('fNatureza').value = String(pad.tributacaoIssqn);
      // A natureza governa quais campos aparecem: sem reaplicar, a tela fica
      // pedindo alíquota numa nota imune
      aplicarNatureza();
    }
    if (pad.issRetido) el('fIssRetido').value = 'true';
    if (pad.percentualTotalTributos != null && vazio('fTotTrib')) {
      el('fTotTrib').value = pad.percentualTotalTributos;
    }
    if (pad.aliquotaIss != null && !sug.optanteSimples && vazio('fAliquota')) {
      el('fAliquota').value = pad.aliquotaIss;
    }

    // Alíquota do município: só quando a empresa não cadastrou a dela
    if (sug.aliquotaMunicipal && pad.aliquotaIss == null &&
        !sug.optanteSimples && vazio('fAliquota')) {
      el('fAliquota').value = sug.aliquotaMunicipal;
    }

    // O que a empresa emitiu por último costuma ser o que vai emitir de novo
    var u = sug.ultimoServico;
    if (u && u.codigoTributacao) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Repetir última: ' + (u.descricao || '').slice(0, 34) +
                      ((u.descricao || '').length > 34 ? '…' : '');
      b.title = 'Preenche com o serviço da última nota autorizada';
      b.onclick = function () {
        el('fCodTrib').value = u.codigoTributacao;
        el('fDescricao').value = u.descricao || '';
        if (u.codigoNbs) el('fNbs').value = u.codigoNbs;
        if (u.aliquota != null && !el('fAliquota').disabled) el('fAliquota').value = u.aliquota;
        atualizarTotal();
        el('fValor').focus();
        aviso('Preenchido com a última nota. Confira o valor.');
      };
      var caixa = el('sugServicos');
      if (!caixa.querySelector('[data-ultima]')) {
        b.setAttribute('data-ultima', '1');
        caixa.insertBefore(b, caixa.firstChild);
      }
    }
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
  /* Naturezas conforme TSTribISSQN do esquema oficial:
       1 tributável · 2 imunidade · 3 exportação · 4 não incidência
     A exigibilidade suspensa é marcada à parte, porque no esquema ela é um
     grupo próprio e não uma natureza — pode acompanhar qualquer uma delas. */
  function aplicarNatureza() {
    var n = el('fNatureza').value;
    el('wrapImunidade').hidden = n !== '2';
    el('wrapPais').hidden = n !== '3';
    el('wrapSuspensao').hidden = !el('fSuspensa').checked;

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
  el('fSuspensa').onchange = aplicarNatureza;

  el('btnBuscarDoc').onclick = function () {
    var doc = docLimpo(el('fDoc').value);
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

  /* Campos de moeda: ao sair, reescreve no formato brasileiro. É o retorno
     visual de que o sistema entendeu o mesmo número que a pessoa quis dizer —
     quem digita 1.234,56 vê 1.234,56, e quem erra o formato vê na hora. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-moeda]'), function (campo) {
    campo.addEventListener('blur', function () {
      var n = parseValorBR(campo.value);
      campo.classList.remove('invalido');
      if (n === undefined) { campo.value = ''; return; }
      if (isNaN(n)) { campo.classList.add('invalido'); return; }
      campo.value = fmtValorBR(n);
      atualizarTotal();
    });
  });

  el('btnLimpar').onclick = function () {
    if (!confirm('Limpar todos os campos?')) return;
    ['fDoc','fNome','fMunTom','fEmailTom','fFoneTom','fCodTrib','fCodMun','fMunPrest',
     'fNbs','fDocTec','fPedido','fDescricao','fCompl','fValor','fAliquota','fDescIncond',
     'fDescCond','fDeducoes','fBmNumero','fBmReducao','fNumProcesso',
     'fPais','fCompetencia','fReferencia','fTotTrib',
     'fRetPis','fRetCofins','fRetIrrf','fRetCsll','fRetInss',
     'fIbsCst','fIbsClass','fIbsOperacao','fIbsCredPres',
     'fObraCodigo','fObraCib','fObraInscricao','fObraCep','fObraLogradouro',
     'fObraNumero','fObraComplemento','fObraBairro'].forEach(function (id) { el(id).value = ''; });
    el('fIbsAtivo').checked = false;
    el('fIbsCampos').hidden = true;
    el('fNatureza').value = '1';
    el('fIssRetido').value = 'false';
    aplicarNatureza();
    atualizarTotal();
  };

  /* ------------------------------------------------------------- emitir */

  /* Obra: código OU CIB OU endereço — o leiaute aceita um dos três, e mandar
     mais de um faz a Sefin recusar. A ordem aqui define a preferência. */
  function montarObra() {
    var codigo = el('fObraCodigo').value.trim();
    var cib = el('fObraCib').value.trim();
    var cep = digitos(el('fObraCep').value);
    var logradouro = el('fObraLogradouro').value.trim();
    var inscricao = el('fObraInscricao').value.trim();

    if (!codigo && !cib && !cep && !logradouro && !inscricao) return undefined;

    var obra = {};
    if (inscricao) obra.inscricaoImobiliaria = inscricao;
    if (codigo) {
      obra.codigoObra = codigo;
    } else if (cib) {
      obra.codigoCIB = cib;
    } else {
      obra.cep = cep;
      obra.logradouro = logradouro;
      obra.numero = el('fObraNumero').value.trim() || undefined;
      obra.complemento = el('fObraComplemento').value.trim() || undefined;
      obra.bairro = el('fObraBairro').value.trim() || undefined;
    }
    return obra;
  }

  /* IBS/CBS só entra quando marcado. Enquanto é facultativo, informar por
     engano é pior que não informar: o conteúdo passa a ser todo validado. */
  function montarIbsCbs() {
    if (!el('fIbsAtivo').checked) return null;

    var g = {
      indicadorOperacao: digitos(el('fIbsOperacao').value),
      indicadorDestinatario: Number(el('fIbsDest').value),
      tributacao: {
        cst: digitos(el('fIbsCst').value),
        classificacaoTributaria: digitos(el('fIbsClass').value)
      }
    };
    if (el('fIbsFinal').value !== '') g.consumidorFinal = Number(el('fIbsFinal').value);
    if (digitos(el('fIbsCredPres').value)) {
      g.tributacao.creditoPresumido = digitos(el('fIbsCredPres').value);
    }
    return g;
  }

  el('fIbsAtivo').onchange = function () {
    var ligado = el('fIbsAtivo').checked;
    el('fIbsCampos').hidden = !ligado;
    if (ligado) {
      el('detIbsCbs').open = true;
      // O leiaute 1.01 torna o NBS obrigatório; avisar aqui evita a recusa
      if (!digitos(el('fNbs').value)) {
        aviso('Com IBS/CBS, o código NBS passa a ser obrigatório. Preencha-o no bloco do serviço.', 'info');
      }
    }
  };

  function montarCorpo() {
    var e = empresaAtual();
    var doc = docLimpo(el('fDoc').value);
    var natureza = el('fNatureza').value;

    var valores = {
      valorServico: num('fValor'),
      issRetido: el('fIssRetido').value === 'true'
    };
    if (!el('fAliquota').disabled && num('fAliquota') !== undefined) valores.aliquotaIss = num('fAliquota');
    if (natureza !== '1') valores.tributacaoIssqn = Number(natureza);
    if (natureza === '2') valores.tipoImunidade = Number(el('fTipoImunidade').value);
    if (el('fSuspensa').checked) {
      valores.exigibilidadeSuspensa = {
        tipo: Number(el('fTipoSusp').value),
        numeroProcesso: el('fNumProcesso').value.trim() || undefined
      };
    }
    if (num('fDescIncond') !== undefined) valores.descontoIncondicionado = num('fDescIncond');
    if (num('fDescCond') !== undefined) valores.descontoCondicionado = num('fDescCond');
    if (num('fDeducoes') !== undefined) valores.valorDeducoes = num('fDeducoes');
    if (digitos(el('fBmNumero').value)) {
      valores.beneficioMunicipal = { numero: digitos(el('fBmNumero').value) };
      if (num('fBmReducao') !== undefined) {
        valores.beneficioMunicipal.percentualReducao = num('fBmReducao');
      }
    }
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
        codigoNbs: digitos(el('fNbs').value) || undefined,
        documentoTecnico: el('fDocTec').value.trim() || undefined,
        pedido: el('fPedido').value.trim() || undefined,
        informacoesComplementares: el('fCompl').value.trim() || undefined,
        codigoPaisPrestacao: natureza === '3' ? (el('fPais').value.trim().toUpperCase() || undefined) : undefined,
        obra: montarObra()
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
    var ibs = montarIbsCbs();
    if (ibs) corpo.ibsCbs = ibs;
    if (el('fCompetencia').value) corpo.dataCompetencia = el('fCompetencia').value;
    if (el('fReferencia').value.trim()) corpo.referencia = el('fReferencia').value.trim();
    return corpo;
  }

  function validar() {
    var e = empresaAtual();
    if (!e) return 'Escolha a empresa emissora.';

    /* Valor que não dá para ler não pode virar "campo em branco": desconto ou
       dedução ilegível seria simplesmente ignorado, e a nota sairia com o
       valor cheio sem ninguém notar. */
    var rotulos = {
      fValor: 'Valor do serviço', fDescIncond: 'Desconto incondicionado',
      fDeducoes: 'Deduções da base', fDescCond: 'Desconto condicionado',
      fRetPis: 'PIS', fRetCofins: 'COFINS', fRetIrrf: 'IRRF',
      fRetCsll: 'CSLL', fRetInss: 'INSS'
    };
    for (var id in rotulos) {
      if (isNaN(num(id))) {
        return 'O campo "' + rotulos[id] + '" não é um valor válido. ' +
               'Escreva como 1.234,56.';
      }
    }

    if (!/^\d{6}$/.test(digitos(el('fCodTrib').value))) return 'O código de tributação tem 6 dígitos.';
    if (!el('fDescricao').value.trim()) return 'Descreva o serviço prestado.';
    if (!num('fValor') || num('fValor') <= 0) return 'Informe o valor do serviço.';
    var doc = docLimpo(el('fDoc').value);
    if (doc && doc.length !== 11 && doc.length !== 14) return 'Documento do cliente inválido.';
    if (doc && !el('fNome').value.trim()) return 'Informe o nome do cliente.';
    var munTom = digitos(el('fMunTom').value);
    if (munTom && munTom.length !== 7) return 'O código do município do cliente tem 7 dígitos (IBGE).';
    var munPrest = digitos(el('fMunPrest').value);
    if (munPrest && munPrest.length !== 7) return 'O código do município da prestação tem 7 dígitos (IBGE).';
    if (el('fNatureza').value === '3' && !el('fPais').value.trim()) {
      return 'Exportação de serviço exige o país da prestação.';
    }
    if (el('fSuspensa').checked && !el('fNumProcesso').value.trim()) {
      return 'Exigibilidade suspensa exige o número do processo.';
    }
    /* Formato do NBS conferido aqui: a Sefin recusa com E1235 ("falha no
       esquema XML") depois de reservar número e assinar — um dígito a menos
       custa um número da sequência fiscal. */
    var nbs = digitos(el('fNbs').value);
    if (nbs && nbs.length !== 9) {
      return 'O código NBS tem 9 dígitos (você informou ' + nbs.length + ').';
    }
    if (el('fIbsAtivo').checked) {
      if (!nbs) return 'Com IBS/CBS, informe o código NBS do serviço.';
      if (!digitos(el('fIbsCst').value)) return 'Informe o CST do IBS/CBS.';
      if (!digitos(el('fIbsClass').value)) return 'Informe a classificação tributária do IBS/CBS.';
      if (!el('fIbsOperacao').value) return 'Escolha o indicador da operação (cIndOp).';
      if (digitos(el('fIbsClass').value).length > 6) return 'A classificação tributária tem até 6 dígitos.';

    }
    if (el('fObraCodigo').value.trim() && el('fObraCib').value.trim()) {
      return 'Informe o código da obra OU o CIB, não os dois.';
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
    var doc = docLimpo(el('fDoc').value);
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
