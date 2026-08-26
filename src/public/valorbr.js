/* Leitura de valor em dinheiro no formato brasileiro.
 *
 * Arquivo próprio porque duas telas precisam dela — a de emissão e a do painel —
 * e duas cópias de regra de dinheiro é uma que vai divergir da outra. O campo
 * `type="number"` do navegador só entende ponto decimal: quem digitasse
 * 1.234,56 num deles teria o valor lido como 1,23. Daí esta função e os campos
 * `data-moeda`.
 *
 * Devolve `undefined` para vazio e `NaN` para o que não é número — os dois
 * significam coisas diferentes para quem chama, e juntar tudo em 0 faria uma
 * nota de mil reais virar uma nota de zero sem ninguém perceber.
 */
(function (raiz) {
  'use strict';

  function parseValorBR(texto) {
    var v = String(texto == null ? '' : texto).trim().replace(/\s|R\$| /g, '');
    if (v === '') return undefined;

    var negativo = /^-/.test(v);
    v = v.replace(/^[+-]/, '');
    if (!/^[\d.,]+$/.test(v)) return NaN;

    if (v.indexOf(',') >= 0) {
      // Mais de uma vírgula não é número, é engano de digitação
      if (v.split(',').length > 2) return NaN;
      v = v.replace(/\./g, '').replace(',', '.');
    } else if (v.indexOf('.') >= 0) {
      /* Só ponto: 1.234 é mil duzentos e trinta e quatro, mas 12.34 é doze e
         trinta e quatro. Três dígitos no fim, com o começo curto, é milhar. */
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

  raiz.parseValorBR = parseValorBR;
})(window);
