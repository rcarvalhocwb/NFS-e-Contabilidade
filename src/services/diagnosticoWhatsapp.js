const db = require('../db');
const ponte = require('./ponteNuvem');

/* O que falta para o WhatsApp funcionar.
 *
 * A mesma conferência do `relay/conferir.js`, na tela — para quem não vai abrir
 * terminal. Percorre a corrente na ordem em que ela quebra e diz, em cada
 * ponto, o que fazer.
 *
 * O que este lado NÃO alcança: se a Meta está entregando o webhook. Isso só o
 * repassador sabe, e é por isso que o `/saude` dele entra aqui — se ele
 * responde e nunca recebeu mensagem nenhuma, o problema está no painel da Meta,
 * não aqui.
 */

const TIMEOUT_MS = 8000;

async function bater(url, opcoes = {}) {
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opcoes));
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
    return { status: r.status, corpo: j, bruto: t };
  } catch (e) {
    return { erro: e.name === 'AbortError' ? 'não respondeu em 8s'
                                           : ((e.cause && e.cause.code) || e.message) };
  } finally { clearTimeout(prazo); }
}

function item(estado, o_que, detalhe, resolver) {
  return { estado, o_que, detalhe: detalhe || null, resolver: resolver || null };
}

async function conferir() {
  const itens = [];
  const c = await ponte.ler();

  /* ------------------------------------------------ o endereço e a chave */
  itens.push(c.url
    ? item('ok', 'Endereço do repassador', c.url)
    : item('falta', 'Endereço do repassador não configurado', null,
        'Preencha aqui em cima, com o https:// do servidor.'));

  itens.push(c.tem_chave
    ? item('ok', 'Chave da ponte guardada')
    : item('falta', 'Chave da ponte não configurada', null,
        'Invente uma frase longa e ponha aqui e no .env do repassador.'));

  /* ------------------------------------------------- o número do escritório */
  itens.push(c.wa_phone_number_id
    ? item('ok', 'Phone number ID', c.wa_phone_number_id)
    : item('falta', 'Phone number ID não configurado', null,
        'Meta → WhatsApp → Configuração da API.'));

  itens.push(c.tem_wa_token
    ? item('ok', 'Token da Meta guardado')
    : item('falta', 'Token da Meta não configurado', null,
        'Gere um token PERMANENTE por um usuário do sistema. O que aparece na ' +
        'tela da API vence em 24 horas.'));

  itens.push(c.wa_ativo
    ? item('ok', 'Canal do WhatsApp ligado')
    : item('atencao', 'Canal do WhatsApp desligado', null,
        'Marque "Atender pedidos por WhatsApp" aqui em cima.'));

  /* ---------------------------------------------------------- as empresas */
  const emp = await db.query(
    `SELECT e.razao_social, e.nome_fantasia, e.portal_liberado, e.whatsapp_direto,
            count(w.id)::int AS numeros
       FROM empresas e
       LEFT JOIN contatos_whatsapp w ON w.empresa_id = e.id AND w.ativo
      WHERE e.ativo
      GROUP BY e.id ORDER BY e.razao_social`);

  const liberadas = emp.rows.filter(e => e.portal_liberado);
  itens.push(liberadas.length
    ? item('ok', liberadas.length + ' empresa(s) liberada(s)',
        liberadas.map(e => e.nome_fantasia || e.razao_social).join(', '))
    : item('falta', 'Nenhuma empresa liberada para o portal', null,
        'Ficha da empresa → aba Integração → "Liberado para usar o portal". ' +
        'Sem isso, todo pedido é recusado na chegada.'));

  const comNumero = emp.rows.filter(e => e.numeros > 0);
  itens.push(comNumero.length
    ? item('ok', comNumero.length + ' empresa(s) com número autorizado',
        comNumero.map(e => (e.nome_fantasia || e.razao_social) +
          ' (' + e.numeros + ')').join(', '))
    : item('falta', 'Nenhum número de WhatsApp autorizado', null,
        'Ficha da empresa → aba Integração → "WhatsApp autorizado". ' +
        'Número não cadastrado recebe recusa neutra.'));

  /* O caso silencioso: liberada, mas sem ninguém que possa pedir. */
  const mudas = liberadas.filter(e => e.numeros === 0);
  if (mudas.length) {
    itens.push(item('atencao',
      mudas.length + ' empresa(s) liberada(s) sem número cadastrado',
      mudas.map(e => e.nome_fantasia || e.razao_social).join(', '),
      'Elas estão prontas, mas ninguém consegue pedir nota por elas.'));
  }

  /* ------------------------------------------------------- a identidade */
  const ident = await db.query('SELECT nome FROM identidade LIMIT 1');
  const nome = (ident.rows[0] || {}).nome;
  itens.push(nome
    ? item('ok', 'Escritório se apresenta como "' + nome + '"')
    : item('atencao', 'Identidade do escritório em branco', null,
        'Tela "Identidade visual". Sem o nome, a primeira mensagem chega de um ' +
        'número desconhecido e parece golpe.'));

  /* --------------------------------------------------- o cadastro enviado */
  itens.push(c.cadastro_em
    ? item('ok', 'Cadastro enviado ao repassador',
        new Date(c.cadastro_em).toLocaleString('pt-BR'))
    : item('falta', 'Cadastro nunca foi enviado', null,
        'Clique em "Enviar agora". Sem o cadastro, o repassador não sabe ' +
        'quem pode pedir nota.'));

  if (c.cadastro_erro) {
    itens.push(item('falta', 'O último envio de cadastro falhou', c.cadastro_erro));
  }

  /* ------------------------------------------------------ o repassador */
  let saude = null;
  if (c.url) {
    const r = await bater(c.url.replace(/\/+$/, '') + '/saude');
    if (r.erro) {
      itens.push(item('falta', 'Não alcancei o repassador', r.erro,
        'O servidor está no ar? O endereço está certo? ' +
        'Em https, o certificado é válido?'));
    } else if (r.status === 200) {
      saude = r.corpo;
      itens.push(item('ok', 'Repassador respondendo',
        (saude.pedidosNaFila || 0) + ' pedido(s) na fila, ' +
        (saude.conversasAbertas || 0) + ' conversa(s) aberta(s)'));

      itens.push(c.url.startsWith('https://')
        ? item('ok', 'Endereço em HTTPS')
        : item('falta', 'O endereço está em HTTP', null,
            'A Meta não entrega em HTTP. Ponha o Caddy na frente.'));
    } else {
      itens.push(item('falta', 'O repassador respondeu HTTP ' + r.status));
    }
  }

  const falta = itens.filter(i => i.estado === 'falta').length;
  const atencao = itens.filter(i => i.estado === 'atencao').length;

  return {
    itens,
    pronto: falta === 0,
    resumo: falta
      ? falta + ' coisa(s) faltando' + (atencao ? ' e ' + atencao + ' para olhar' : '')
      : atencao
        ? 'Tudo o que é obrigatório está de pé; ' + atencao + ' ponto(s) para olhar'
        : 'Tudo de pé',
    /* O que este lado não consegue ver, e precisa ser dito em vez de omitido. */
    naoConfiro: [
      'Se a Meta está entregando o webhook — isso só aparece no log do repassador.',
      'Se o campo "messages" foi assinado no painel da Meta.',
      'Se o token ainda vale: quem responde isso é a Meta, e quem pergunta é o repassador.'
    ]
  };
}

module.exports = { conferir };
