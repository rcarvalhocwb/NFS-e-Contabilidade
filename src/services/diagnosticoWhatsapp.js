const { execFile } = require('child_process');
const db = require('../db');
const ponte = require('./ponteNuvem');
const repassador = require('./repassadorLocal');
const { faltaParaEmitirSemFormulario } = require('../nfse/padroesEmpresa');

/* O gateway sobe junto com o Windows?
 *
 * É a pergunta que decide se o WhatsApp atende de verdade. Enquanto o gateway
 * foi um atalho na área de trabalho, a resposta para o cliente que escrevia às
 * 8h depois de um reinício de madrugada era o silêncio — e silêncio não aparece
 * em log nenhum. O repassador e o túnel são filhos deste processo: se ele não
 * sobe, nada sobe. */
function tarefaDoWindows() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('schtasks', ['/query', '/TN', 'NFS-e Gateway'],
      { timeout: 5000, windowsHide: true },
      (erro, saida, erroTexto) => {
        if (!erro) return resolve(/NFS-e Gateway/.test(String(saida)));
        /* A tarefa roda como SYSTEM: um gateway aberto pelo atalho, sem
           elevação, recebe "Acesso negado" ao consultá-la. Tratar isso como
           "não registrada" faria a tela dizer que o gateway não sobe sozinho
           justamente quando ele sobe — e dizer o contrário do que é verdade é
           pior do que não conferir. */
        const texto = String(erroTexto || '') + String(saida || '');
        if (/negado|denied/i.test(texto)) return resolve('sem_permissao');
        resolve(false);
      });
  });
}

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
  const local = !!c.relay_local;

  itens.push(c.url
    ? item('ok', local ? 'Repassador nesta máquina' : 'Endereço do repassador',
        c.url)
    : item('falta', 'Endereço do repassador não configurado', null,
        'Preencha aqui em cima, com o https:// do servidor.'));

  itens.push(c.tem_chave
    ? item('ok', 'Chave da ponte guardada')
    : item('falta', 'Chave da ponte não configurada', null,
        local ? 'Preencha "Chave desta instalação" aqui em cima. Com o ' +
                'repassador daqui, ela é usada dos dois lados sozinha.'
              : 'Invente uma frase longa e ponha aqui e no .env do repassador.'));

  /* --------------------------------- o que só existe quando ele roda aqui */
  if (local) {
    const r = await repassador.situacao();

    itens.push(c.tem_app_secret
      ? item('ok', 'App Secret da Meta guardado')
      : item('falta', 'App Secret da Meta não configurado', null,
          'Meta → Configurações do app → Básico. É o que prova que a mensagem ' +
          'veio da Meta; sem ele nenhuma mensagem é aceita.'));

    itens.push(c.tem_verify_token
      ? item('ok', 'Token de verificação do webhook guardado')
      : item('falta', 'Token de verificação não configurado', null,
          'Invente uma frase e use a mesma aqui e no painel da Meta ao ' +
          'cadastrar o webhook.'));

    itens.push(r.repassador.rodando
      ? item('ok', 'Processo do repassador de pé',
          'desde ' + new Date(r.repassador.subiuEm).toLocaleString('pt-BR'))
      : item('falta', 'O processo do repassador não está de pé',
          r.repassador.ultimoErro,
          r.repassador.desistiu
            ? 'Caiu várias vezes seguidas e a supervisão parou de tentar de ' +
              'propósito. Resolva o motivo acima e clique em Reiniciar.'
            : 'Ligue "Rodar o repassador nesta máquina" e salve.'));

    if (r.tunelAtivo) {
      itens.push(r.tunel.rodando
        ? item('ok', 'Túnel de pé', r.cloudflared)
        : item('falta', 'O túnel não está de pé',
            r.tunel.ultimoErro || r.cloudflared,
            /Programa não encontrado/.test(r.tunel.ultimoErro || '')
              ? 'Baixe o cloudflared e ponha na pasta ferramentas, ou diga o ' +
                'caminho dele no campo "Programa do túnel".'
              : 'Confira o token do túnel no painel da Cloudflare.'));
    } else {
      itens.push(item('atencao', 'O túnel não é mantido por aqui', null,
        'A Meta precisa de um endereço público em https. Se não é este ' +
        'gateway que mantém o túnel, alguém tem de mantê-lo.'));
    }
  }

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
    `SELECT e.*, e.razao_social, e.nome_fantasia, e.portal_liberado, e.whatsapp_direto,
            (SELECT count(*) FROM contatos_whatsapp w
              WHERE w.empresa_id = e.id AND w.ativo)::int AS numeros,
            (SELECT count(*) FROM servicos s WHERE s.empresa_id = e.id)::int AS servicos
       FROM empresas e
      WHERE e.ativo ORDER BY e.razao_social`);

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

  /* O serviço é o que a conversa oferece para escolher. Sem nenhum, ela
     responde "ainda não há nenhum para esta empresa" e encerra na primeira
     pergunta — a empresa fica liberada, com número cadastrado, e muda. */
  const semServico = liberadas.filter(e => e.servicos === 0);
  itens.push(semServico.length
    ? item('falta', semServico.length + ' empresa(s) liberada(s) sem serviço cadastrado',
        semServico.map(e => e.nome_fantasia || e.razao_social).join(', '),
        'Tela Serviços. A conversa pede para escolher um serviço; sem lista, ' +
        'ela não tem o que oferecer e o pedido morre aí.')
    : item('ok', 'Todas as empresas liberadas têm serviço cadastrado'));

  /* Os padrões fiscais que a tela preenchia sozinha.
     Uma empresa do Simples sem o percentual do PGDAS emite pelo formulário,
     onde alguém digita, e é recusada por todos os outros caminhos com E1235.
     Antes de 27/08/2026 isso só aparecia na primeira mensagem do cliente. */
  const semPadrao = liberadas
    .map(e => ({ e, falta: faltaParaEmitirSemFormulario(e) }))
    .filter(x => x.falta.length);
  itens.push(semPadrao.length
    ? item('falta', semPadrao.length + ' empresa(s) sem os padrões fiscais completos',
        semPadrao.map(x => (x.e.nome_fantasia || x.e.razao_social) +
          ': falta ' + x.falta.join(', ')).join(' · '),
        'Ficha da empresa → aba Padrões fiscais. Sem eles a nota sai pelo ' +
        'formulário e é recusada pelo WhatsApp.')
    : item('ok', 'Padrões fiscais completos nas empresas liberadas'));

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

      /* Em http://127.0.0.1 o https não se aplica: quem precisa estar em
         https é o endereço que a Meta chama, e esse é o do túnel. */
      const publico = local ? c.relay_url_publica : c.url;
      itens.push(publico && publico.startsWith('https://')
        ? item('ok', 'Endereço público em HTTPS', publico)
        : item('falta',
            publico ? 'O endereço público está em HTTP'
                    : 'Endereço público não informado',
            publico,
            local ? 'Ponha em "Endereço público" o nome que você deu ao túnel ' +
                    'na Cloudflare. É ele que vai no webhook da Meta.'
                  : 'A Meta não entrega em HTTP. Ponha o Caddy na frente.'));

      /* A prova de que o túnel funciona de verdade: sair daqui, dar a volta
         pela internet e voltar. É o único jeito de responder "a Meta consegue
         me alcançar?" sem esperar a primeira mensagem perdida. */
      if (publico && publico.startsWith('https://')) {
        const fora = await bater(publico.replace(/\/+$/, '') + '/saude');
        itens.push(fora.status === 200
          ? item('ok', 'O endereço público responde de fora', publico)
          : item('falta', 'O endereço público não respondeu',
              fora.erro || ('HTTP ' + fora.status),
              local ? 'O túnel está de pé, mas o nome pode não estar apontando ' +
                      'para 127.0.0.1:' + (c.relay_porta || 8080) +
                      '. Confira no painel da Cloudflare.'
                    : 'Confira o DNS e o certificado do servidor.'));
      }
    } else {
      itens.push(item('falta', 'O repassador respondeu HTTP ' + r.status));
    }
  }

  /* --------------------------------------------- o gateway sobe sozinho */
  const tarefa = await tarefaDoWindows();
  if (tarefa === 'sem_permissao') {
    itens.push(item('atencao', 'Não consegui conferir se o gateway sobe sozinho',
      'a consulta à tarefa agendada voltou "acesso negado"',
      'Isso costuma significar que a tarefa existe e roda como SYSTEM, ' +
      'enquanto este gateway foi aberto pelo atalho. Confira num PowerShell ' +
      'como Administrador: .\\scripts\\servico-windows.ps1 situacao'));
  } else if (tarefa !== null) {
    itens.push(tarefa
      ? item('ok', 'O gateway sobe junto com o Windows')
      : item('falta', 'O gateway não sobe sozinho',
          'nenhuma tarefa "NFS-e Gateway" registrada',
          'Abra o PowerShell como Administrador na pasta do gateway e rode: ' +
          '.\\scripts\\servico-windows.ps1 instalar — sem isso, o WhatsApp ' +
          'fica mudo depois de qualquer reinício, e o backup diário só roda ' +
          'nos dias em que alguém abrir o programa.'));
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
    ],
    repassadorLocal: local
  };
}

module.exports = { conferir };
