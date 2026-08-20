/* Configuração de e-mail do escritório.
 *
 * O envio da nota ao cliente e o aviso de prazos dependem de SMTP. Antes isso
 * só se configurava editando o .env e reiniciando o gateway — o que a
 * contabilidade não faz, e por isso o recurso ficava desligado para sempre.
 *
 * A senha é cifrada com a mesma MASTER_KEY do certificado A1. Senha de e-mail
 * em texto puro num banco que sai em cópia de segurança é credencial vazando
 * pela porta dos fundos.
 *
 * O .env continua valendo: quem já configurou por lá não precisa mexer em nada.
 * O banco tem precedência quando está marcado como ativo.
 */
const db = require('../db');
const { encrypt, decrypt } = require('../secretbox');

/* Provedores comuns, para a tela não pedir host e porta de cor.
   O Gmail exige SENHA DE APP: a senha da conta não passa desde 2022, e quem
   tentar com ela recebe "Username and Password not accepted" sem explicação. */
const PROVEDORES = {
  gmail: {
    nome: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com', porta: 587, seguro: false,
    ajuda: 'Use uma SENHA DE APP, não a senha da conta. Ative a verificação em ' +
           'duas etapas e gere em myaccount.google.com/apppasswords.'
  },
  outlook: {
    nome: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com', porta: 587, seguro: false,
    ajuda: 'Contas com autenticação moderna podem exigir senha de aplicativo.'
  },
  zoho: {
    nome: 'Zoho Mail',
    host: 'smtp.zoho.com', porta: 465, seguro: true,
    ajuda: 'Gere uma senha específica de aplicativo no painel do Zoho.'
  },
  outro: { nome: 'Outro servidor', host: '', porta: 587, seguro: false, ajuda: '' }
};

async function ler() {
  const r = await db.query(
    `SELECT id, ativo, host, porta, seguro, usuario, remetente,
            enviar_nota, resumo_diario, resumo_para, resumo_hora,
            testado_em, ultimo_erro, atualizado_em,
            (senha_cifrada IS NOT NULL) AS tem_senha
       FROM config_email WHERE id = TRUE`);
  return r.rows[0] || {};
}

/* Configuração pronta para uso, já com a senha decifrada.
   Devolve null quando não há e-mail configurado — nem no banco, nem no .env. */
async function efetiva() {
  const c = await ler();
  if (c.ativo && c.host) {
    let senha = null;
    if (c.tem_senha) {
      const r = await db.query('SELECT senha_cifrada FROM config_email WHERE id = TRUE');
      try {
        senha = decrypt(r.rows[0].senha_cifrada).toString('utf8');
      } catch (e) {
        // MASTER_KEY trocada depois de gravar a senha: dizer isso é melhor que
        // falhar no envio com "autenticação recusada"
        throw Object.assign(new Error(
          'Não foi possível abrir a senha de e-mail guardada. Isso acontece quando ' +
          'a MASTER_KEY do .env muda depois de a senha ser salva. Grave a senha de novo.'),
          { status: 500 });
      }
    }
    return {
      host: c.host, porta: c.porta, seguro: c.seguro,
      usuario: c.usuario || null, senha,
      remetente: c.remetente || c.usuario || 'nfse-gateway@localhost',
      origem: 'painel'
    };
  }

  if (process.env.SMTP_HOST) {
    return {
      host: process.env.SMTP_HOST,
      porta: Number(process.env.SMTP_PORT || 587),
      seguro: process.env.SMTP_SECURE === 'true',
      usuario: process.env.SMTP_USER || null,
      senha: process.env.SMTP_PASS || null,
      remetente: process.env.SMTP_FROM || process.env.SMTP_USER || 'nfse-gateway@localhost',
      origem: 'env'
    };
  }
  return null;
}

async function salvar(dados = {}) {
  const campos = [];
  const valores = [];
  const põe = (coluna, valor) => {
    valores.push(valor);
    campos.push(`${coluna} = $${valores.length}`);
  };
  const texto = v => (v === undefined ? undefined : (String(v).trim() || null));

  if (dados.host !== undefined) põe('host', texto(dados.host));
  if (dados.porta !== undefined) põe('porta', Number(dados.porta) || 587);
  if (dados.seguro !== undefined) põe('seguro', !!dados.seguro);
  if (dados.usuario !== undefined) põe('usuario', texto(dados.usuario));
  if (dados.remetente !== undefined) põe('remetente', texto(dados.remetente));
  if (dados.ativo !== undefined) põe('ativo', !!dados.ativo);
  if (dados.enviarNota !== undefined) põe('enviar_nota', !!dados.enviarNota);
  if (dados.resumoDiario !== undefined) põe('resumo_diario', !!dados.resumoDiario);
  if (dados.resumoPara !== undefined) põe('resumo_para', texto(dados.resumoPara));
  if (dados.resumoHora !== undefined) {
    const h = Number(dados.resumoHora);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw Object.assign(new Error('A hora do resumo vai de 0 a 23.'), { status: 400 });
    }
    põe('resumo_hora', h);
  }

  /* Senha só é gravada quando vem preenchida: a tela manda o campo vazio
     quando ninguém o tocou, e sobrescrever ali apagaria a senha existente. */
  if (dados.senha) põe('senha_cifrada', encrypt(String(dados.senha)));
  if (dados.removerSenha) põe('senha_cifrada', null);

  if (campos.length) {
    valores.push(true);
    await db.query(
      `UPDATE config_email SET ${campos.join(', ')}, atualizado_em = now()
        WHERE id = $${valores.length}`, valores);
  }
  return ler();
}

async function registrarTeste(erro) {
  await db.query(
    'UPDATE config_email SET testado_em = now(), ultimo_erro = $1 WHERE id = TRUE',
    [erro || null]);
}

module.exports = { ler, efetiva, salvar, registrarTeste, PROVEDORES };
