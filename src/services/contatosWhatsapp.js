const db = require('../db');

/* Números de WhatsApp autorizados a pedir nota, por empresa.
 *
 * O gateway não fala com o WhatsApp — nem poderia. A API da Meta entrega
 * mensagem por webhook: ela faz POST num endereço público em HTTPS e espera
 * HTTP 200 em até 20 segundos. Isso é exatamente a conexão de entrada que a
 * arquitetura evita, porque abriria à internet a máquina que guarda os
 * certificados A1 de todos os clientes do escritório.
 *
 * Quem recebe o webhook é o mesmo lado de nuvem que já existe para o portal, e
 * ele grava na fila de solicitações. O gateway continua puxando. Do ponto de
 * vista deste código, WhatsApp é só mais uma ORIGEM na mesma fila — nada aqui
 * precisa saber que a Meta existe.
 *
 * O que este módulo resolve é a parte que é do escritório: qual número fala por
 * qual CNPJ.
 */

/* Normalização de número brasileiro — a parte que costuma dar errado.
 *
 * Celular no Brasil ganhou um nono dígito, e a Meta nem sempre entrega o número
 * com ele: em DDDs mais antigos o WhatsApp historicamente devolve o número sem
 * o 9. Então 5541999998888 e 554199998888 são a mesma pessoa, e comparar texto
 * com texto erra metade das vezes.
 *
 * A saída é guardar sempre a forma COM o nono dígito e comparar por ela.
 */
function normalizar(bruto) {
  const texto = String(bruto || '');
  let d = texto.replace(/\D/g, '');
  if (!d) return null;

  /* Número digitado sem o país: assume Brasil, que é onde o gateway roda.
     O "+" na frente diz que o país já veio — sem essa checagem, um +1 415 555
     2671 viraria 5514155552671, um número brasileiro que não existe. */
  const temPais = texto.trim().startsWith('+');
  if (!temPais && (d.length === 10 || d.length === 11)) d = '55' + d;
  if (!d.startsWith('55')) return d;                 // estrangeiro: deixa como está

  const ddd = d.slice(2, 4);
  let assinante = d.slice(4);

  /* Celular tem 9 dígitos e começa com 9; fixo tem 8. Se vier com 8 dígitos
     começando em 6, 7, 8 ou 9, é celular sem o nono — repõe. */
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
    assinante = '9' + assinante;
  }
  return '55' + ddd + assinante;
}

/* As duas formas do mesmo número, para procurar no banco.
   Cadastro antigo pode ter sido gravado sem o nono dígito. */
function variacoes(numero) {
  const n = normalizar(numero);
  if (!n) return [];
  const formas = new Set([n]);
  if (n.startsWith('55') && n.length === 13) {
    const ddd = n.slice(2, 4);
    const assinante = n.slice(4);
    if (assinante.startsWith('9')) formas.add('55' + ddd + assinante.slice(1));
  }
  return [...formas];
}

function ehValido(numero) {
  const n = normalizar(numero);
  if (!n) return false;
  if (!n.startsWith('55')) return n.length >= 8 && n.length <= 15;
  return n.length === 13 || n.length === 12;   // celular ou fixo
}

async function listar(empresaId) {
  const r = await db.query(
    `SELECT c.id, c.empresa_id, c.telefone, c.nome, c.cargo, c.ativo,
            c.limite_valor, c.ultimo_uso, c.criado_em, e.razao_social
       FROM contatos_whatsapp c JOIN empresas e ON e.id = c.empresa_id
      WHERE ($1::int IS NULL OR c.empresa_id = $1)
      ORDER BY e.razao_social, c.nome`, [empresaId || null]);
  return r.rows.map(c => Object.assign(c, {
    limite_valor: c.limite_valor === null ? null : Number(c.limite_valor)
  }));
}

async function acrescentar({ empresaId, telefone, nome, cargo, limiteValor }) {
  if (!ehValido(telefone)) {
    throw Object.assign(new Error(
      'Número inválido. Use DDD e número, como (41) 99999-8888.'), { status: 400 });
  }
  const n = normalizar(telefone);

  /* Um número fala por UMA empresa. Deixar o mesmo celular pedir nota por dois
     CNPJs traz de volta, pelo WhatsApp, exatamente a confusão que o resto do
     sistema evita — e do outro lado não há tela mostrando qual empresa está
     selecionada. Quem atende duas empresas usa dois números, ou pede pelo
     painel. */
  const jaTem = await db.query(
    `SELECT c.empresa_id, e.razao_social FROM contatos_whatsapp c
       JOIN empresas e ON e.id = c.empresa_id WHERE c.telefone = $1`, [n]);
  if (jaTem.rows.length && Number(jaTem.rows[0].empresa_id) !== Number(empresaId)) {
    throw Object.assign(new Error(
      'Este número já pede notas por ' + jaTem.rows[0].razao_social +
      '. Um número fala por uma empresa só — no WhatsApp não há tela para ' +
      'mostrar qual está selecionada.'), { status: 409 });
  }

  const limite = limiteValor === '' || limiteValor == null ? null : Number(limiteValor);
  if (limite !== null && (!Number.isFinite(limite) || limite <= 0)) {
    throw Object.assign(new Error('O teto precisa ser um valor maior que zero.'),
      { status: 400 });
  }

  const r = await db.query(
    `INSERT INTO contatos_whatsapp (empresa_id, telefone, nome, cargo, limite_valor)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome,
       cargo = EXCLUDED.cargo, limite_valor = EXCLUDED.limite_valor, ativo = TRUE
     RETURNING id`,
    [empresaId, n, nome || null, cargo || null, limite]);
  return r.rows[0];
}

async function remover(id) {
  await db.query('DELETE FROM contatos_whatsapp WHERE id = $1', [id]);
}

/* De quem é este número? Devolve o contato e a empresa, ou null.
   É o que o recebedor do webhook precisa saber antes de aceitar um pedido. */
async function resolver(telefone) {
  const formas = variacoes(telefone);
  if (!formas.length) return null;
  const r = await db.query(
    `SELECT c.*, e.cnpj, e.razao_social, e.portal_liberado, e.portal_motivo
       FROM contatos_whatsapp c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.telefone = ANY($1::text[]) AND c.ativo AND e.ativo
      LIMIT 1`, [formas]);
  if (!r.rows.length) return null;
  const c = r.rows[0];
  c.limite_valor = c.limite_valor === null ? null : Number(c.limite_valor);
  return c;
}

/* O teto por solicitação. Acima dele o pedido não é recusado — ele apenas
   nunca sai no automático, e espera alguém do escritório olhar. */
function acimaDoTeto(contato, valor) {
  if (!contato || contato.limite_valor == null) return false;
  return Number(valor) > contato.limite_valor;
}

module.exports = {
  normalizar, variacoes, ehValido, listar, acrescentar, remover, resolver, acimaDoTeto
};
