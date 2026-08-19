const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Leitura de valores no formato brasileiro.
 *
 * Os campos eram <input type="number">, que só entende ponto decimal. Quem
 * digitasse "1.234,56" — mil duzentos e trinta e quatro reais, a forma que
 * qualquer contador usa — via o navegador guardar "1.23456", e o total da nota
 * virava R$ 1,23. Mil vezes menos, sem aviso, virando documento fiscal com
 * imposto recolhido a menor.
 *
 * Verificado no navegador antes da correção: digitando 1.234,56 o campo ficou
 * com 1.23456 e o rodapé mostrou "R$ 1,23".
 *
 * A função vive no navegador; o teste extrai a fonte para que os dois lados
 * não divirjam. */

function carregar(nome) {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'nota.js'), 'utf8');
  const inicio = fonte.indexOf('function ' + nome);
  assert.ok(inicio > 0, nome + ' não encontrada');
  const resto = fonte.slice(inicio);
  const fim = resto.indexOf('\n  }\n');
  return new Function(resto.slice(0, fim + 4) + '; return ' + nome + ';')();
}

const parseValorBR = carregar('parseValorBR');

test('formato brasileiro completo', () => {
  assert.equal(parseValorBR('1.234,56'), 1234.56);
  assert.equal(parseValorBR('1.234.567,89'), 1234567.89);
  assert.equal(parseValorBR('12.345,00'), 12345);
});

test('vírgula decimal sem separador de milhar', () => {
  assert.equal(parseValorBR('1234,56'), 1234.56);
  assert.equal(parseValorBR('3,00'), 3);
  assert.equal(parseValorBR('0,05'), 0.05);
});

test('ponto como separador de milhar, sem centavos', () => {
  // "1.234" para um contador é mil duzentos e trinta e quatro
  assert.equal(parseValorBR('1.234'), 1234);
  assert.equal(parseValorBR('1.234.567'), 1234567);
});

test('ponto decimal continua valendo (planilha em inglês)', () => {
  assert.equal(parseValorBR('1234.56'), 1234.56);
  assert.equal(parseValorBR('12.34'), 12.34);
  assert.equal(parseValorBR('0.5'), 0.5);
});

test('número inteiro simples', () => {
  assert.equal(parseValorBR('3'), 3);
  assert.equal(parseValorBR('1000'), 1000);
});

test('campo vazio é ausência, não zero', () => {
  // undefined faz o campo não ir na DPS; zero iria como desconto de R$ 0,00
  assert.equal(parseValorBR(''), undefined);
  assert.equal(parseValorBR('   '), undefined);
  assert.equal(parseValorBR(null), undefined);
});

test('texto que não é número vira NaN, não silêncio', () => {
  // NaN é detectável pela validação; virar 0 ou undefined esconderia o engano
  assert.ok(Number.isNaN(parseValorBR('abc')));
  assert.ok(Number.isNaN(parseValorBR('1,2,3')));
  assert.ok(Number.isNaN(parseValorBR('12x34')));
});

test('aceita R$ e espaços, que vêm junto ao colar', () => {
  assert.equal(parseValorBR('R$ 1.234,56'), 1234.56);
  assert.equal(parseValorBR(' 3,00 '), 3);
});

test('o caso que gerou o defeito', () => {
  // A nota de R$ 1.234,56 que virava R$ 1,23
  const lido = parseValorBR('1.234,56');
  assert.equal(lido, 1234.56);
  assert.notEqual(lido, 1.23456);
});

test('números já em forma numérica passam intactos', () => {
  // O valor pode chegar do autopreenchimento, não só da digitação
  assert.equal(parseValorBR(1234.56), 1234.56);
  assert.equal(parseValorBR(3), 3);
});
