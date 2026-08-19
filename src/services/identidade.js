/* Identidade visual do escritório.
 *
 * O gateway é operado por um escritório de contabilidade e os relatórios vão
 * para os clientes dele. Com a marca da casa, o fechamento mensal é
 * entregável; sem ela, parece saída de sistema.
 *
 * A logo mora no banco de propósito: a cópia de segurança já leva o banco, e
 * arquivo solto numa pasta se perde na primeira troca de máquina.
 */
const db = require('../db');

/* Formatos aceitos. SVG fica de fora: é XML executável, e uma logo é a última
   coisa que deveria poder rodar script no painel de um sistema fiscal. */
const TIPOS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};
const LIMITE_BYTES = 300 * 1024;

/* Confere pelo conteúdo, não pelo nome nem pelo cabeçalho enviado: os dois
   vêm do cliente e podem mentir. */
function tipoReal(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function ler() {
  const r = await db.query(
    `SELECT nome, descricao, cor_acento, rodape, site, telefone, email,
            logo_tipo, logo_bytes, atualizado_em,
            (logo IS NOT NULL) AS tem_logo
       FROM identidade WHERE id = TRUE`);
  return r.rows[0] || {};
}

async function lerLogo() {
  const r = await db.query('SELECT logo, logo_tipo FROM identidade WHERE id = TRUE');
  const linha = r.rows[0];
  return linha && linha.logo ? { conteudo: linha.logo, tipo: linha.logo_tipo } : null;
}

/* Cor em #rrggbb. Aceita com ou sem #, em maiúscula ou minúscula — o valor
   costuma vir copiado de um manual de marca. */
function normalizarCor(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    throw Object.assign(new Error('A cor deve estar no formato #1e3a5f (seis dígitos).'),
      { status: 400 });
  }
  return '#' + s.toLowerCase();
}

async function salvar(dados = {}) {
  const cor = dados.corAcento !== undefined ? normalizarCor(dados.corAcento) : undefined;
  const campos = [];
  const valores = [];
  const põe = (coluna, valor) => {
    valores.push(valor);
    campos.push(`${coluna} = $${valores.length}`);
  };

  // Edição parcial: o que não vem no corpo fica como está
  const texto = v => (v === undefined ? undefined : (String(v).trim() || null));
  if (dados.nome !== undefined)      põe('nome', texto(dados.nome));
  if (dados.descricao !== undefined) põe('descricao', texto(dados.descricao));
  if (cor !== undefined)             põe('cor_acento', cor);
  if (dados.rodape !== undefined)    põe('rodape', texto(dados.rodape));
  if (dados.site !== undefined)      põe('site', texto(dados.site));
  if (dados.telefone !== undefined)  põe('telefone', texto(dados.telefone));
  if (dados.email !== undefined)     põe('email', texto(dados.email));

  if (!campos.length) return ler();

  await db.query(
    `UPDATE identidade SET ${campos.join(', ')}, atualizado_em = now() WHERE id = TRUE`,
    valores);
  return ler();
}

async function salvarLogo(buffer) {
  if (!buffer || !buffer.length) {
    throw Object.assign(new Error('Escolha um arquivo de imagem.'), { status: 400 });
  }
  if (buffer.length > LIMITE_BYTES) {
    throw Object.assign(new Error(
      `A imagem tem ${Math.round(buffer.length / 1024)} KB; o limite é ${LIMITE_BYTES / 1024} KB. ` +
      'Uma logo de 400 pixels de largura costuma bastar.'), { status: 400 });
  }
  const tipo = tipoReal(buffer);
  if (!tipo) {
    throw Object.assign(new Error(
      'Formato não reconhecido. Use PNG, JPG ou WebP.'), { status: 400 });
  }

  await db.query(
    'UPDATE identidade SET logo = $1, logo_tipo = $2, logo_bytes = $3, atualizado_em = now() WHERE id = TRUE',
    [buffer, tipo, buffer.length]);
  return { tipo, bytes: buffer.length };
}

async function removerLogo() {
  await db.query(
    'UPDATE identidade SET logo = NULL, logo_tipo = NULL, logo_bytes = NULL, atualizado_em = now() WHERE id = TRUE');
}

module.exports = { ler, lerLogo, salvar, salvarLogo, removerLogo, normalizarCor, tipoReal, TIPOS, LIMITE_BYTES };
