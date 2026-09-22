#!/usr/bin/env node
/**
 * Cria (ou redefine) um usuário do painel pela linha de comando.
 *
 * Existe por dois motivos:
 *
 *  1. O instalador chama este script para criar o primeiro acesso. Assim a
 *     contabilidade nunca precisa digitar a GATEWAY_API_KEY: quem instalou já
 *     está na máquina, com o .env à mão.
 *
 *  2. Recuperação. Se o único administrador esquecer a senha, ninguém consegue
 *     redefini-la pelo painel — daria um beco sem saída numa máquina local sem
 *     e-mail configurado. Com acesso ao computador, este script resolve.
 *
 * Uso:
 *   node scripts/criar-usuario.js --nome "Maria" --email maria@empresa.com --senha "..."
 *   node scripts/criar-usuario.js --email maria@empresa.com --senha "..." --redefinir
 *
 * Sem --perfil, o primeiro usuário do escritório nasce admin e os demais
 * operador.
 *
 * --escritorio escolhe a casa. Sem ele, 1 — que é o escritório da instalação
 * que existia antes da conversão para vários. Num servidor com mais de um, o
 * argumento deixa de ser opcional na prática: criar o admin da casa errada é
 * dar a chave da carteira de clientes de outra pessoa.
 */
require('dotenv').config();
const db = require('../src/db');
const usuarios = require('../src/services/usuarios');

function argumento(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const tem = nome => process.argv.includes('--' + nome);

async function principal() {
  const email = argumento('email');
  const escritorio = Number(argumento('escritorio') || 1);
  // NFSE_SENHA é o caminho preferido: argumento de linha de comando aparece na
  // lista de processos e no histórico do terminal.
  const senha = process.env.NFSE_SENHA || argumento('senha');
  const nome = argumento('nome');
  const redefinir = tem('redefinir');

  if (!email || !senha) {
    console.error('Uso: node scripts/criar-usuario.js --nome "Nome" --email a@b.com --senha "..."');
    console.error('     ou defina NFSE_SENHA no ambiente e omita --senha.');
    console.error('     Acrescente --redefinir para trocar a senha de quem já existe.');
    process.exit(2);
  }

  /* Já estamos dentro do bloco do escritório, então a policy responde por si:
     pedir outro id aqui devolveria vazio, que é a mesma resposta de "não
     existe". Não é preciso — nem possível — atravessar a RLS para conferir. */
  const casa = await db.query(
    'SELECT nome FROM escritorios WHERE id = $1 AND ativo', [escritorio]);
  if (!casa.rows.length) {
    console.error(`Escritório ${escritorio} não existe ou está inativo.`);
    process.exit(2);
  }
  console.log(`Escritório ${escritorio}: ${casa.rows[0].nome}`);

  const jaHavia = await usuarios.existeAlgum();
  const existente = await usuarios.porEmail(email);

  if (existente) {
    if (!redefinir) {
      console.error(`Já existe usuário com o e-mail ${email}.`);
      console.error('Use --redefinir para trocar a senha e reativar o acesso.');
      process.exit(1);
    }
    await usuarios.atualizar(existente.id, {
      senha,
      ativo: true,
      // Senha vinda da linha de comando não é secreta: fica no histórico do
      // terminal. Quem for usar a conta troca no próximo acesso.
      trocarSenha: true,
      ...(nome ? { nome } : {}),
      ...(argumento('perfil') ? { perfil: argumento('perfil') } : {})
    });
    console.log(`Senha redefinida para ${email}. A troca será pedida no próximo acesso.`);
    return;
  }

  // O primeiro usuário precisa ser admin: não haveria quem lhe desse permissão.
  const perfil = argumento('perfil') || (jaHavia ? 'operador' : 'admin');
  const criado = await usuarios.criar({
    nome: nome || email.split('@')[0],
    email,
    senha,
    perfil,
    empresasIds: [],
    trocarSenha: tem('trocar-senha')
  });

  console.log(`Usuário criado: ${criado.nome} <${criado.email}> (${criado.perfil}).`);
  if (!jaHavia) console.log('É o administrador do gateway e enxerga todas as empresas.');
}

/* Tudo dentro do bloco do escritório: sem ele, `escritorio_id` nasce NULL
   (o padrão da coluna é `inquilino_atual()`) e a gravação falha na hora — que
   é o modo certo de falhar, mas não é motivo para deixar acontecer. */
db.comInquilino(Number(argumento('escritorio') || 1), principal)
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
