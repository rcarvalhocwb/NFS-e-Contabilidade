/* Leitura de CSV para a importação em lote.
 *
 * Sem dependência: o que chega aqui é planilha exportada do Excel, e o que ela
 * exige é pouco — separador variável, aspas e BOM. Uma biblioteca de CSV traria
 * dialetos que ninguém vai usar.
 */

/* Descobre o separador contando ocorrências fora de aspas na primeira linha.
   Excel em português exporta com ponto e vírgula; quem edita à mão costuma usar
   vírgula. Errar isso transforma a planilha inteira numa coluna só. */
function detectarSeparador(primeiraLinha) {
  const candidatos = [';', ',', '\t'];
  let melhor = ';', maior = -1;
  for (const sep of candidatos) {
    let fora = 0, aspas = false;
    for (const ch of primeiraLinha) {
      if (ch === '"') aspas = !aspas;
      else if (ch === sep && !aspas) fora++;
    }
    if (fora > maior) { maior = fora; melhor = sep; }
  }
  return melhor;
}

/* Divide uma linha respeitando aspas e o escape "" dentro do campo. */
function dividirLinha(linha, sep) {
  const campos = [];
  let atual = '', aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (ch === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; }
      else aspas = !aspas;
    } else if (ch === sep && !aspas) {
      campos.push(atual); atual = '';
    } else {
      atual += ch;
    }
  }
  campos.push(atual);
  return campos.map(c => c.trim());
}

/* Quebra o texto em linhas, mas sem cortar dentro de um campo entre aspas —
   descrição de serviço com quebra de linha é comum. */
function separarLinhas(texto) {
  const linhas = [];
  let atual = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (ch === '"') { aspas = !aspas; atual += ch; continue; }
    if (!aspas && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      linhas.push(atual); atual = '';
      continue;
    }
    atual += ch;
  }
  if (atual) linhas.push(atual);
  return linhas.filter(l => l.trim() !== '');
}

/* Normaliza o nome da coluna: sem acento, minúsculo, sem espaço.
   "Razão Social" e "razao_social" viram a mesma chave — quem monta a planilha
   não deveria precisar acertar a grafia exata. */
function normalizarCabecalho(nome) {
  return String(nome)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lerCsv(texto) {
  // BOM do Excel apareceria colado no nome da primeira coluna
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);

  const linhas = separarLinhas(texto);
  if (!linhas.length) return { colunas: [], registros: [] };

  const sep = detectarSeparador(linhas[0]);
  const colunas = dividirLinha(linhas[0], sep).map(normalizarCabecalho);

  const registros = linhas.slice(1).map((linha, i) => {
    const campos = dividirLinha(linha, sep);
    const registro = { __linha: i + 2 };  // +2: cabeçalho é a linha 1
    colunas.forEach((col, j) => {
      if (col) registro[col] = campos[j] !== undefined ? campos[j] : '';
    });
    return registro;
  });

  return { colunas, registros, separador: sep };
}

/* Número em formato brasileiro: "1.234,56" -> 1234.56 */
function lerNumero(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\s/g, '');
  // Com vírgula, ela é o decimal e o ponto é milhar
  const normalizado = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : undefined;
}

function gerarCsv(colunas, linhas) {
  const escapar = v => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cab = colunas.map(c => escapar(c.titulo)).join(';');
  const corpo = linhas.map(l => colunas.map(c => escapar(l[c.campo])).join(';'));
  // BOM para o Excel abrir com acentuação correta
  return '﻿' + [cab, ...corpo].join('\r\n') + '\r\n';
}

module.exports = { lerCsv, lerNumero, gerarCsv, normalizarCabecalho };
