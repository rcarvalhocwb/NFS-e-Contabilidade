/* Conferência dos dados da nota contra as restrições do leiaute oficial.
 *
 * Por que existir: a Sefin só recusa depois de o gateway ter reservado número
 * de DPS e assinado o documento — o que deixa buraco na sequência fiscal por
 * um e-mail longo demais ou uma máscara de telefone. É o mesmo motivo pelo
 * qual o CNPJ do tomador já era conferido antes de emitir.
 *
 * As restrições abaixo saem do pacote NFSe-ESQUEMAS_XSD (Schemas/1.00,
 * tiposSimples e tiposComplexos). Onde o XSD define um `pattern`, o texto do
 * erro explica a regra em português — o erro do schema ("não aceito pelo
 * pattern 0|[0-9]{1}(\.[0-9]{2})?") não diz nada a quem opera a tela.
 *
 * Isto NÃO substitui a validação contra o XSD: cobre o que o operador digita.
 * A validação do documento montado está em test/xsd.test.js.
 */

function erro(mensagem) {
  return Object.assign(new Error(mensagem), { status: 400 });
}

function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/* Texto com limite de tamanho (TSString e derivados). */
function texto(valor, { campo, min = 1, max, obrigatorio = false }) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw erro(`${campo} é obrigatório`);
    return;
  }
  const s = String(valor);
  if (s.length < min) throw erro(`${campo} deve ter ao menos ${min} caractere(s) — tem ${s.length}`);
  if (max && s.length > max) {
    throw erro(`${campo} deve ter no máximo ${max} caracteres — tem ${s.length}`);
  }
}

/* Percentual, com o número de casas inteiras que o tipo do XSD permite.
   TSDec1V2 (pAliq) admite 1 dígito inteiro; TSDec2V2 (pTotTribSN), 2;
   TSDec3V2 (pTotTrib por esfera), 3. Passar disso invalida o documento. */
function percentual(valor, { campo, digitosInteiros }) {
  if (valor === undefined || valor === null || valor === '') return;
  const n = Number(valor);
  const limite = Math.pow(10, digitosInteiros) - 0.01;
  if (!Number.isFinite(n) || n < 0) throw erro(`${campo} deve ser um percentual`);
  if (n > limite) {
    throw erro(`${campo} não pode passar de ${limite.toFixed(2).replace('.', ',')}% ` +
               `(o leiaute reserva ${digitosInteiros} dígito(s) para a parte inteira)`);
  }
}

function padrao(valor, { campo, regex, comoDeveSer, obrigatorio = false }) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw erro(`${campo} é obrigatório`);
    return;
  }
  if (!regex.test(String(valor))) throw erro(`${campo} ${comoDeveSer}`);
}

/* Códigos de justificativa da SUBSTITUIÇÃO (TSCodJustSubst) — dois dígitos,
   com zero à esquerda. Não confundir com os do cancelamento (TSCodJustCanc),
   que são de um dígito: 1, 2 e 9. */
const MOTIVOS_SUBSTITUICAO = ['01', '02', '03', '04', '05', '99'];
const MOTIVOS_CANCELAMENTO = ['1', '2', '9'];

/* Motivo de evento e de substituição: TSMotivo, 15 a 255 caracteres.
   O mínimo de 15 surpreende — "Erro" e "Outros" são recusados pela Sefin. */
function motivo(valor, campo) {
  texto(valor, { campo, min: 15, max: 255, obrigatorio: true });
}

/**
 * Confere o corpo de uma emissão. Lança Error com status 400 na primeira
 * inconsistência, com mensagem em português dizendo o que corrigir.
 */
function conferirEmissao(dados = {}) {
  const t = dados.tomador || {};
  const s = dados.servico || {};
  const v = dados.valores || {};
  const end = t.endereco || {};

  // --- serviço
  padrao(s.codigoTributacaoNacional, {
    campo: 'servico.codigoTributacaoNacional', regex: /^[0-9]{6}$/, obrigatorio: true,
    comoDeveSer: 'deve ter exatamente 6 dígitos (cTribNac)'
  });
  padrao(s.codigoTributacaoMunicipal, {
    campo: 'servico.codigoTributacaoMunicipal', regex: /^[0-9]{3}$/,
    comoDeveSer: 'deve ter exatamente 3 dígitos (cTribMun)'
  });
  texto(s.descricao, { campo: 'servico.descricao', max: 2000, obrigatorio: true });
  padrao(s.codigoMunicipioPrestacao, {
    campo: 'servico.codigoMunicipioPrestacao', regex: /^[0-9]{7}$/,
    comoDeveSer: 'deve ser o código IBGE de 7 dígitos'
  });

  // --- tomador
  texto(t.razaoSocial, { campo: 'tomador.razaoSocial', max: 300 });
  texto(t.email, { campo: 'tomador.email', max: 80 });
  if (t.telefone) {
    padrao(soDigitos(t.telefone), {
      campo: 'tomador.telefone', regex: /^[0-9]{6,20}$/,
      comoDeveSer: 'deve ter de 6 a 20 dígitos'
    });
  }
  texto(end.logradouro, { campo: 'tomador.endereco.logradouro', max: 255 });
  texto(end.numero, { campo: 'tomador.endereco.numero', max: 60 });
  texto(end.complemento, { campo: 'tomador.endereco.complemento', max: 156 });
  texto(end.bairro, { campo: 'tomador.endereco.bairro', max: 60 });
  padrao(end.codigoMunicipio, {
    campo: 'tomador.endereco.codigoMunicipio', regex: /^[0-9]{7}$/,
    comoDeveSer: 'deve ser o código IBGE de 7 dígitos'
  });
  if (end.cep) {
    padrao(soDigitos(end.cep), {
      campo: 'tomador.endereco.cep', regex: /^[0-9]{8}$/, comoDeveSer: 'deve ter 8 dígitos'
    });
  }
  // O endereço vai completo ou não vai: xLgr, nro e xBairro são obrigatórios
  // dentro do bloco. Avisar aqui é melhor do que emitir a nota sem o endereço
  // que o operador acha que informou.
  const partes = [end.logradouro, end.numero, end.bairro].filter(Boolean).length;
  if (partes > 0 && partes < 3) {
    throw erro('Endereço do tomador incompleto: logradouro, número e bairro são exigidos ' +
               'juntos pelo leiaute. Complete os três ou não informe endereço.');
  }

  // --- valores
  if (v.valorServico === undefined || v.valorServico === null) {
    throw erro('valores.valorServico é obrigatório');
  }
  const vs = Number(v.valorServico);
  if (!Number.isFinite(vs) || vs < 0) throw erro('valores.valorServico deve ser um número positivo');
  if (vs > 999999999999999.99) throw erro('valores.valorServico excede o máximo do leiaute');

  percentual(v.aliquotaIss, { campo: 'valores.aliquotaIss', digitosInteiros: 1 });
  percentual(v.percentualTotalTributosSN, { campo: 'valores.percentualTotalTributosSN', digitosInteiros: 2 });
  if (v.percentualTotalTributos) {
    const p = v.percentualTotalTributos;
    percentual(p.federal, { campo: 'valores.percentualTotalTributos.federal', digitosInteiros: 3 });
    percentual(p.estadual, { campo: 'valores.percentualTotalTributos.estadual', digitosInteiros: 3 });
    percentual(p.municipal, { campo: 'valores.percentualTotalTributos.municipal', digitosInteiros: 3 });
  }

  // --- substituição
  if (dados.substituicao) {
    const sub = dados.substituicao;
    padrao(soDigitos(sub.chaveSubstituida), {
      campo: 'substituicao.chaveSubstituida', regex: /^[0-9]{50}$/, obrigatorio: true,
      comoDeveSer: 'deve ter 50 dígitos'
    });
    const cod = String(sub.codigoMotivo == null ? '99' : sub.codigoMotivo);
    if (!MOTIVOS_SUBSTITUICAO.includes(cod)) {
      throw erro(`substituicao.codigoMotivo deve ser um de ${MOTIVOS_SUBSTITUICAO.join(', ')} ` +
                 `(dois dígitos, com zero à esquerda) — recebido "${cod}"`);
    }
    motivo(sub.motivo || 'Substituicao de NFS-e', 'substituicao.motivo');
  }
}

/* Texto de xMotivo quando o pedido não traz um.
 *
 * Os dois primeiros cabem num padrão porque o código já diz tudo: cancelar
 * por erro de emissão é cancelar por erro de emissão. O 9 não tem padrão de
 * propósito — "Outros" é a ausência de motivo conhecido, e inventar uma frase
 * genérica para caber no mínimo do leiaute seria pôr no documento fiscal uma
 * justificativa que ninguém deu. Quem escolhe 9 diz por quê.
 *
 * TSMotivo exige de 15 a 255 caracteres, então os textos abaixo não são
 * enfeite: um mais curto derruba o evento no schema da Sefin — depois de
 * assinado, o que é tarde. */
const TEXTO_PADRAO_CANCELAMENTO = {
  1: 'Erro na emissao da NFS-e',
  2: 'Servico nao prestado'
};

/* Confere o pedido de cancelamento antes de assinar e transmitir o evento. */
function conferirCancelamento({ codigoMotivo, motivo: texto_ } = {}) {
  const cod = String(codigoMotivo == null ? '1' : codigoMotivo);
  if (!MOTIVOS_CANCELAMENTO.includes(cod)) {
    throw erro(`codigoMotivo deve ser 1 (erro na emissão), 2 (serviço não prestado) ` +
               `ou 9 (outros) — recebido "${cod}"`);
  }
  if (texto_) {
    // Texto próprio: conferir aqui pega o curto demais antes de assinar.
    motivo(texto_, 'motivo');
    return;
  }
  if (!TEXTO_PADRAO_CANCELAMENTO[cod]) {
    throw erro('motivo é obrigatório quando codigoMotivo é 9 (outros): ' +
               'descreva por que a nota está sendo cancelada, em pelo menos ' +
               '15 caracteres');
  }
}

module.exports = {
  conferirEmissao, conferirCancelamento,
  MOTIVOS_SUBSTITUICAO, MOTIVOS_CANCELAMENTO,
  TEXTO_PADRAO_CANCELAMENTO,
  LIMITE_MOTIVO: { min: 15, max: 255 }
};
