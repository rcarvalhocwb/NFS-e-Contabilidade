const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Padrões fiscais da empresa no formulário de emissão.
 *
 * Antes, o código de tributação, o NBS e a alíquota eram digitados a cada nota.
 * Uma empresa de vigilância emite o mesmo serviço todo mês, e um dígito errado
 * no cTribNac só aparece na rejeição da Sefin — com o número da DPS já gasto.
 *
 * A regra que estes testes protegem é a de precedência. Há três fontes para o
 * mesmo campo, e elas não valem igual:
 *
 *   1. o que a pessoa digitou      — nunca é sobrescrito
 *   2. o padrão cadastrado na empresa — alguém decidiu, olhando o enquadramento
 *   3. a alíquota do município      — inferência, só serve de reserva
 *
 * A função vive no navegador; o teste extrai a fonte e roda com um DOM de
 * mentira, para que os dois lados não possam divergir. */

const FONTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'nota.js'), 'utf8');

function carregarAplicarSugestoes() {
  const inicio = FONTE.indexOf('function aplicarSugestoes');
  assert.ok(inicio > 0, 'aplicarSugestoes não encontrada em nota.js');
  const resto = FONTE.slice(inicio);
  const corpo = resto.slice(0, resto.indexOf('\n  }\n') + 4);

  const campos = {};
  const el = id => (campos[id] = campos[id] || { value: '', checked: false, disabled: false,
                                                 style: {}, setAttribute() {}, focus() {},
                                                 querySelector: () => null, insertBefore() {},
                                                 appendChild() {} });
  const contexto = {
    estado: {},
    el,
    aplicarNatureza: () => { contexto.naturezaAplicada = true; },
    atualizarTotal: () => {},
    aviso: () => {},
    document: { createElement: () => ({ style: {}, setAttribute() {}, classList: { add() {} } }) }
  };

  const fabrica = new Function('estado', 'el', 'aplicarNatureza', 'atualizarTotal', 'aviso',
    'document', corpo + '; return aplicarSugestoes;');
  const fn = fabrica(contexto.estado, el, contexto.aplicarNatureza,
    contexto.atualizarTotal, contexto.aviso, contexto.document);

  return { aplicar: fn, campos, contexto, valor: id => (campos[id] || {}).value };
}

const PADROES_VIGILANCIA = {
  codigoTributacao: '110201',
  codigoTributacaoMunicipal: '0501',
  codigoNbs: '115011000',
  descricao: 'Prestacao de servicos de vigilancia patrimonial desarmada',
  tributacaoIssqn: 1,
  issRetido: false,
  percentualTotalTributos: 6,
  aliquotaIss: 5
};

test('os padrões da empresa preenchem a nota', () => {
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: PADROES_VIGILANCIA });

  assert.equal(t.valor('fCodTrib'), '110201');
  assert.equal(t.valor('fCodMun'), '0501');
  assert.equal(t.valor('fNbs'), '115011000');
  assert.match(t.valor('fDescricao'), /vigilancia patrimonial/);
  assert.equal(t.valor('fTotTrib'), 6);
  assert.equal(t.valor('fAliquota'), 5);
});

test('o padrão da empresa vence a alíquota do município', () => {
  // A empresa tem regime próprio; a alíquota geral da cidade é palpite
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: { aliquotaIss: 2 }, aliquotaMunicipal: 5 });
  assert.equal(t.valor('fAliquota'), 2);
});

test('sem padrão da empresa, o município ainda serve', () => {
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: {}, aliquotaMunicipal: 5 });
  assert.equal(t.valor('fAliquota'), 5);
});

test('o que a pessoa digitou nunca é sobrescrito', () => {
  const t = carregarAplicarSugestoes();
  t.campos.fCodTrib = { value: '620110', style: {} };
  t.campos.fAliquota = { value: '3', style: {} };
  t.aplicar({ padroes: PADROES_VIGILANCIA });

  assert.equal(t.valor('fCodTrib'), '620110');
  assert.equal(t.valor('fAliquota'), '3');
  assert.equal(t.valor('fNbs'), '115011000', 'os campos vazios continuam sendo preenchidos');
});

test('optante do Simples não recebe alíquota de ISS', () => {
  // Quem está no Simples recolhe pelo DAS; alíquota na nota é erro de emissão
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: PADROES_VIGILANCIA, aliquotaMunicipal: 5, optanteSimples: true });
  assert.ok(!t.valor('fAliquota'), 'alíquota ficou ' + t.valor('fAliquota'));
  assert.equal(t.valor('fTotTrib'), 6, 'mas o total de tributos do PGDAS entra');
});

test('a natureza padrão reaplica as regras da tela', () => {
  // Sem reaplicar, uma empresa imune segue mostrando o campo de alíquota
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: { tributacaoIssqn: 4 } });
  assert.equal(t.valor('fNatureza'), '4');
  assert.ok(t.contexto.naturezaAplicada, 'aplicarNatureza precisa rodar depois de mudar o valor');
});

test('ISS retido por padrão marca o campo', () => {
  const t = carregarAplicarSugestoes();
  t.aplicar({ padroes: { issRetido: true } });
  assert.equal(t.valor('fIssRetido'), 'true');
});

test('empresa sem padrões cadastrados não quebra o formulário', () => {
  const t = carregarAplicarSugestoes();
  assert.doesNotThrow(() => t.aplicar({}));
  assert.doesNotThrow(() => t.aplicar({ padroes: null }));
});
