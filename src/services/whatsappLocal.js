const db = require('../db');

/* O gateway conversando com o módulo do WhatsApp.
 *
 * O módulo é outro processo, com ícone próprio, que mantém a sessão. Este
 * arquivo é a metade daqui: guarda a configuração, registra o aceite do termo,
 * e sabe pedir ao módulo que envie uma mensagem.
 *
 * NADA AQUI PODE IMPEDIR UMA NOTA DE SAIR. O WhatsApp é um canal de entrada
 * de pedidos; se ele estiver fora do ar, o pedido chega por outro caminho ou
 * não chega — e a emissão pelo painel segue igual. Toda função deste arquivo
 * falha para o lado de "o WhatsApp não está disponível", nunca para o lado de
 * "o sistema parou".
 */

const PORTA_PADRAO = 3200;

async function ler() {
  const r = await db.query('SELECT * FROM whatsapp_local WHERE id = 1');
  return r.rows[0] || null;
}

async function situacao() {
  const linha = await ler();

  /* O `catch` aqui existe para UM caso: instalação antiga, antes da coluna
     `wa_transporte`, em que a consulta falha por ela não existir. Só que ele
     engolia qualquer erro — e engoliu um de verdade por tempo demais.
     `config_nuvem.id` é BOOLEAN, e esta consulta dizia `WHERE id = 1`: o
     Postgres respondia "operador não existe: boolean = integer", o catch
     transformava isso em zero linhas, e zero linhas viravam o padrão 'meta'.
     Resultado: o painel jurava que o transporte era a Meta mesmo com a sessão
     própria escolhida, e ninguém tinha como desconfiar — não havia erro, só uma
     resposta errada com cara de certa.

     Agora só a ausência da coluna é perdoada. Qualquer outra falha sobe, porque
     uma resposta errada sobre POR ONDE a nota sai é pior que uma tela de erro. */
  let transporte = 'meta';
  try {
    const cfg = await db.query('SELECT wa_transporte FROM config_nuvem WHERE id = TRUE');
    if (cfg.rows.length) transporte = cfg.rows[0].wa_transporte;
  } catch (e) {
    /* 42703 = undefined_column: a migração ainda não rodou. */
    if (e.code !== '42703') throw e;
  }

  return {
    transporte,
    ativo: !!(linha && linha.ativo),
    porta: linha ? linha.porta : PORTA_PADRAO,
    numero: linha ? linha.numero : null,
    nomePerfil: linha ? linha.nome_perfil : null,
    /* A situação vem do banco, gravada pelo próprio módulo. É de propósito:
       perguntar ao módulo exigiria que ele estivesse de pé, e é justamente
       quando ele cai que alguém quer saber o que houve. */
    situacaoSessao: linha ? linha.situacao : 'desligado',
    situacaoEm: linha ? linha.situacao_em : null,
    ultimoErro: linha ? linha.ultimo_erro : null,
    termo: linha && linha.termo_aceito_em ? {
      versao: linha.termo_versao,
      aceitoEm: linha.termo_aceito_em,
      aceitoPor: linha.termo_aceito_nome
    } : null
  };
}

/* Registra o aceite. O nome é COPIADO no ato, e não só referenciado: se o
   usuário for removido depois, a prova de quem aceitou não pode sumir com ele. */
async function aceitarTermo({ versao, usuarioId, nome }) {
  if (!versao) {
    throw Object.assign(new Error('Informe a versão do termo aceito.'), { status: 400 });
  }
  await db.query(
    `UPDATE whatsapp_local
        SET termo_versao = $1, termo_aceito_em = now(),
            termo_aceito_por = $2, termo_aceito_nome = $3, atualizado_em = now()
      WHERE id = 1`,
    [versao, usuarioId || null, nome || null]);
  return situacao();
}

/* Liga ou desliga o transporte local. Ligar sem aceite é recusado AQUI, e não
   só na tela do módulo: trava que vive só no navegador não é trava. */
async function definirAtivo(ativo, { porta } = {}) {
  const linha = await ler();
  if (ativo && !(linha && linha.termo_aceito_em)) {
    throw Object.assign(
      new Error('É preciso aceitar o termo de uso do WhatsApp por sessão própria antes de ligar.'),
      { status: 412 });
  }
  await db.query(
    `UPDATE whatsapp_local
        SET ativo = $1, porta = COALESCE($2, porta), atualizado_em = now()
      WHERE id = 1`,
    [!!ativo, porta || null]);

  /* Um transporte de cada vez. Dois escrevendo na mesma conversa dariam
     resposta dobrada ao cliente — e ele não faz ideia de que existem dois. */
  await db.query(
    'UPDATE config_nuvem SET wa_transporte = $1, atualizado_em = now() WHERE id = TRUE',
    [ativo ? 'local' : 'meta']);

  return situacao();
}

/* O módulo avisa como está. Chamado por ele, não pelo painel. */
async function registrarSituacao(estado) {
  await db.query(
    `UPDATE whatsapp_local
        SET situacao = $1, situacao_em = now(), ultimo_erro = $2,
            numero = COALESCE($3, numero), nome_perfil = COALESCE($4, nome_perfil),
            atualizado_em = now()
      WHERE id = 1`,
    [estado.situacao || 'desligado', estado.ultimoErro || null,
     estado.numero || null, estado.nomePerfil || null]);
}

/* Manda uma mensagem pelo módulo. Usado pelo gateway quando a nota fica pronta
   e o cliente precisa receber o link.

   Timeout curto: se o módulo não responde em cinco segundos, ele não vai
   responder — e quem chamou tem outra coisa para fazer (gravar a nota, seguir
   a fila) que não pode esperar por um canal de conveniência. */
async function enviar({ para, texto, documento }) {
  const s = await situacao();
  if (s.transporte !== 'local' || !s.ativo) {
    throw Object.assign(new Error('O WhatsApp por sessão própria não está ligado.'),
      { status: 409 });
  }

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 5000);
  try {
    const r = await fetch('http://127.0.0.1:' + s.porta + '/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Token': await tokenDoModulo() },
      body: JSON.stringify({ para, texto, documento }),
      signal: controle.signal
    });
    if (!r.ok) {
      const corpo = await r.json().catch(() => ({}));
      throw Object.assign(new Error(corpo.erro || ('módulo respondeu ' + r.status)),
        { status: 502 });
    }
    return r.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error('O módulo do WhatsApp não respondeu.'), { status: 504 });
    }
    throw e;
  } finally {
    clearTimeout(relogio);
  }
}

/* O token que o módulo sorteia a cada subida e grava em wa/token.txt. Lê na
   hora: o módulo pode ter reiniciado desde a última chamada, e um token velho
   em memória levaria a um 403 confuso. */
async function tokenDoModulo() {
  const fs = require('fs');
  const path = require('path');
  const arquivo = path.join(__dirname, '..', '..', 'wa', 'token.txt');
  try {
    return fs.readFileSync(arquivo, 'utf8').trim();
  } catch (_) {
    throw Object.assign(
      new Error('O módulo do WhatsApp não está no ar. Abra o WhatsApp.bat.'),
      { status: 409 });
  }
}

/* Fala com o módulo em nome do painel.
 *
 * POR QUE O GATEWAY NO MEIO: o módulo atende só em 127.0.0.1, com um token que
 * ele sorteia a cada subida e grava num arquivo. Quem está no painel pela rede
 * — de outro computador do escritório — não alcança nenhum dos dois. Sem esta
 * ponte, conectar o WhatsApp exigiria ir até o servidor, sentar nele e abrir
 * uma segunda janela; e "vá até o servidor" é o oposto do que um painel serve.
 *
 * O timeout é maior que o de `enviar`: aqui alguém está olhando a tela
 * esperando um QR aparecer, e não há fila nenhuma sendo segurada. */
async function conversarComModulo(caminho, { metodo = 'GET', corpo } = {}) {
  const linha = await ler();
  const porta = (linha && linha.porta) || PORTA_PADRAO;

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 10000);
  try {
    const r = await fetch('http://127.0.0.1:' + porta + caminho, {
      method: metodo,
      headers: Object.assign(
        { 'X-WA-Token': await tokenDoModulo() },
        corpo ? { 'Content-Type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controle.signal
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw Object.assign(new Error(dados.erro || ('o módulo respondeu ' + r.status)),
        { status: r.status === 404 ? 404 : 502 });
    }
    return dados;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error('O módulo do WhatsApp não respondeu.'), { status: 504 });
    }
    throw e;
  } finally {
    clearTimeout(relogio);
  }
}

/* A situação, preferindo o módulo quando ele responde.
 *
 * `situacao()` lê o BANCO, e isso é de propósito: a linha lá é gravada pelo
 * próprio módulo quando ele avisa, e continua respondendo depois que ele cai —
 * que é justamente quando alguém quer saber o que houve.
 *
 * Só que para a tela do QR isso não serve. Quem acabou de clicar em "ligar"
 * está olhando o navegador, e o módulo leva alguns segundos entre conectar e
 * conseguir avisar; enquanto isso o banco ainda diz "desligado", a tela não
 * mostra o QR, e a pessoa conclui que não funcionou. Pior: se o módulo não
 * tiver como avisar — instalação sem a chave do gateway configurada — o banco
 * nunca muda, e o QR nunca apareceria.
 *
 * Então: o módulo é a autoridade sobre a PRÓPRIA conexão, e o banco é a
 * autoridade sobre o que é do escritório (o termo aceito, a porta, o
 * transporte escolhido). Cada um responde pelo que sabe. */
async function situacaoAoVivo() {
  const guardada = await situacao();
  try {
    const viva = await conversarComModulo('/situacao');
    return Object.assign({}, guardada, {
      situacaoSessao: viva.situacao || guardada.situacaoSessao,
      numero: viva.numero || guardada.numero,
      nomePerfil: viva.nomePerfil || guardada.nomePerfil,
      ultimoErro: viva.ultimoErro || null,
      moduloNoAr: true
    });
  } catch (_) {
    /* Módulo fora do ar: o que o banco guardou é a melhor resposta que existe,
       e dizer que ele está fora é informação, não falha. */
    return Object.assign({}, guardada, { moduloNoAr: false });
  }
}

/* O QR, já como imagem pronta. Some assim que a leitura acontece — por isso o
   404 do módulo não é erro: é "conectou, ou ainda não gerou". */
async function qrAtual() {
  try {
    return await conversarComModulo('/qr');
  } catch (e) {
    if (e.status === 404) return { qr: null };
    throw e;
  }
}

/* Ligar pelo painel.
 *
 * O aceite é conferido NOS DOIS lados e não é duplicação por descuido: o
 * gateway guarda quem aceitou e quando (é a prova), e o módulo confere a versão
 * do texto que está no disco dele (é a trava). Uma instalação com o módulo
 * atualizado e o aceite antigo precisa de um aceite novo — e é o módulo quem
 * sabe disso, porque o texto mora com ele. */
async function ligarPeloPainel() {
  const s = await situacao();
  if (!s.termo) {
    throw Object.assign(
      new Error('É preciso aceitar o termo de uso do WhatsApp por sessão própria antes de ligar.'),
      { status: 412 });
  }
  const estado = await conversarComModulo('/ligar',
    { metodo: 'POST', corpo: { termoVersao: s.termo.versao } });
  await definirAtivo(true, {});
  return estado;
}

async function desligarPeloPainel({ apagarSessao = false } = {}) {
  /* A ordem importa: desliga o módulo primeiro. Marcando inativo antes, uma
     falha na chamada deixaria o banco dizendo "desligado" com a sessão viva —
     e o cliente recebendo resposta de um transporte que o painel jura morto. */
  const estado = await conversarComModulo('/desligar',
    { metodo: 'POST', corpo: { apagarSessao } });
  await definirAtivo(false, {});
  return estado;
}

/* O texto do termo vem do próprio módulo, e não de uma cópia aqui: é o texto
   que ele vai exigir na hora de ligar. Ler de outro lugar abriria a chance de
   alguém aceitar uma versão e o módulo recusar por outra. */
async function textoDoTermo() {
  return conversarComModulo('/termo');
}

module.exports = {
  ler, situacao, aceitarTermo, definirAtivo, registrarSituacao, enviar,
  tokenDoModulo, situacaoAoVivo, qrAtual, ligarPeloPainel, desligarPeloPainel,
  textoDoTermo,
  PORTA_PADRAO
};
