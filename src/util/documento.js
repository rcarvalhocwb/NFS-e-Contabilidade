/* Validação de CNPJ e CPF pelo dígito verificador.
 *
 * Sem isso, um documento digitado errado só é recusado pela Sefin, depois de
 * reservar numeração e assinar a DPS — foi o que aconteceu num teste real
 * (E0188: "CNPJ do tomador informado na DPS é inválido"). Validar aqui evita
 * consumir número de DPS e uma ida à Sefin para receber erro. */

function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

/* Dígito verificador por soma ponderada, módulo 11 — mesma regra para CPF e
   CNPJ, mudando só os pesos. */
function digitoModulo11(base, pesos) {
  const soma = base.reduce((acc, n, i) => acc + n * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function validarCnpj(valor) {
  const c = soDigitos(valor);
  if (c.length !== 14) return false;
  // Sequências repetidas (00000000000000, 111...) passam no cálculo mas não
  // são CNPJ válido.
  if (/^(\d)\1{13}$/.test(c)) return false;

  const nums = c.split('').map(Number);
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const dv1 = digitoModulo11(nums.slice(0, 12), pesos1);
  if (dv1 !== nums[12]) return false;
  const dv2 = digitoModulo11(nums.slice(0, 13), pesos2);
  return dv2 === nums[13];
}

function validarCpf(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(c)) return false;

  const nums = c.split('').map(Number);
  const dv1 = digitoModulo11(nums.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== nums[9]) return false;
  const dv2 = digitoModulo11(nums.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === nums[10];
}

/* Aceita CPF ou CNPJ, decidindo pelo comprimento. */
function validarDocumento(valor) {
  const d = soDigitos(valor);
  if (d.length === 14) return validarCnpj(d);
  if (d.length === 11) return validarCpf(d);
  return false;
}

module.exports = { validarCnpj, validarCpf, validarDocumento, soDigitos };
