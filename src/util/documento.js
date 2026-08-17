/* Validação de CNPJ e CPF pelo dígito verificador.
 *
 * Sem isso, um documento digitado errado só é recusado pela Sefin, depois de
 * reservar numeração e assinar a DPS — foi o que aconteceu num teste real
 * (E0188: "CNPJ do tomador informado na DPS é inválido"). Validar aqui evita
 * consumir número de DPS e uma ida à Sefin para receber erro.
 *
 * CNPJ ALFANUMÉRICO (desde julho/2026): as 12 primeiras posições podem conter
 * letras; só os 2 dígitos verificadores continuam numéricos. O cálculo do DV
 * passou a usar o valor ASCII do caractere menos 48 — para os algarismos isso
 * devolve o próprio número, então a regra é a mesma de sempre para os CNPJ
 * antigos. Limpar o valor com /\D/g destruiria um CNPJ novo, por isso a
 * limpeza aqui preserva letras. */

/* Só dígitos: para CPF, e para formatar valores que se sabe numéricos. */
function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

/* Limpeza para documentos que podem ser alfanuméricos. Mantém A-Z e 0-9,
   descartando pontuação; letras vão para maiúsculas, como no cadastro. */
function limparDocumento(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/* Dígito verificador por soma ponderada, módulo 11 — mesma regra para CPF e
   CNPJ, mudando só os pesos. */
function digitoModulo11(base, pesos) {
  const soma = base.reduce((acc, n, i) => acc + n * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/* Valor de cada caractere no cálculo do DV: ASCII menos 48.
   '0'→0 … '9'→9, 'A'→17, 'B'→18 … 'Z'→42. */
function valorCaractere(ch) { return ch.charCodeAt(0) - 48; }

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function validarCnpj(valor) {
  const c = limparDocumento(valor);
  if (c.length !== 14) return false;

  // Os dois últimos são sempre numéricos, mesmo no formato alfanumérico
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;

  // Sequências repetidas (00000000000000, AAAAAAAAAAAA00) passam no cálculo
  // mas não são CNPJ válido.
  if (/^(.)\1{13}$/.test(c)) return false;

  const valores = c.split('').map(valorCaractere);

  const dv1 = digitoModulo11(valores.slice(0, 12), PESOS_CNPJ_1);
  if (dv1 !== Number(c[12])) return false;
  const dv2 = digitoModulo11(valores.slice(0, 13), PESOS_CNPJ_2);
  return dv2 === Number(c[13]);
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

/* Aceita CPF ou CNPJ, decidindo pelo comprimento.
   CPF nunca tem letra; CNPJ pode ter. */
function validarDocumento(valor) {
  const d = limparDocumento(valor);
  if (d.length === 14) return validarCnpj(d);
  if (d.length === 11) return validarCpf(d);
  return false;
}

/* True quando o documento usa o formato novo, com letra. Útil para avisar em
   telas e relatórios que ainda assumem CNPJ só numérico. */
function cnpjAlfanumerico(valor) {
  const c = limparDocumento(valor);
  return c.length === 14 && /[A-Z]/.test(c);
}

module.exports = {
  validarCnpj, validarCpf, validarDocumento,
  soDigitos, limparDocumento, cnpjAlfanumerico
};
