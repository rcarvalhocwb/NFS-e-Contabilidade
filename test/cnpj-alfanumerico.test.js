const test = require('node:test');
const assert = require('node:assert');
const { validarCnpj, validarDocumento, limparDocumento, cnpjAlfanumerico } =
  require('../src/util/documento');

/* CNPJ alfanumérico entrou em vigor em julho/2026: as 12 primeiras posições
   aceitam letras, e o dígito verificador passa a usar o valor ASCII menos 48.
   Para os CNPJ antigos, só de algarismos, a conta é a mesma de sempre. */

/* Calcula o DV pela regra nova, para montar casos de teste sem depender de um
   CNPJ real emitido. */
function comDv(base12) {
  const val = base12.split('').map(c => c.charCodeAt(0) - 48);
  const m11 = (b, p) => {
    const s = b.reduce((a, n, i) => a + n * p[i], 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  const d1 = m11(val, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = m11(val.concat([d1]), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base12 + String(d1) + String(d2);
}

test('CNPJ numérico continua válido', () => {
  // O da empresa que já emitiu em produção: se este quebrar, quebrou tudo
  assert.equal(validarCnpj('21583854000118'), true);
  assert.equal(validarCnpj('21.583.854/0001-18'), true);
  assert.equal(validarCnpj('21583854000119'), false);
});

test('CNPJ com letras é aceito quando o dígito confere', () => {
  const alfa = comDv('A1B2C3D4E5F6');
  assert.equal(validarCnpj(alfa), true);
  assert.equal(validarCnpj('A1B2C3D4E5F699'), false);
});

test('a limpeza preserva letras — /\\D/g apagaria o documento', () => {
  assert.equal(limparDocumento('a1b2c3d4e5f6/68'), 'A1B2C3D4E5F668');
  assert.equal(limparDocumento('21.583.854/0001-18'), '21583854000118');
});

test('os dois últimos dígitos continuam numéricos', () => {
  // O DV nunca é letra, mesmo no formato novo
  assert.equal(validarCnpj('A1B2C3D4E5F6AB'), false);
});

test('sequência repetida é recusada mesmo com letras', () => {
  assert.equal(validarCnpj('AAAAAAAAAAAAAA'), false);
  assert.equal(validarCnpj('00000000000000'), false);
});

test('cnpjAlfanumerico distingue os dois formatos', () => {
  assert.equal(cnpjAlfanumerico(comDv('A1B2C3D4E5F6')), true);
  assert.equal(cnpjAlfanumerico('21583854000118'), false);
  assert.equal(cnpjAlfanumerico('12345678901'), false); // CPF
});

test('CPF não aceita letra', () => {
  assert.equal(validarDocumento('A1234567890'), false);
});

test('validarDocumento aceita CNPJ alfanumérico', () => {
  assert.equal(validarDocumento(comDv('AB12CD34EF56')), true);
});
