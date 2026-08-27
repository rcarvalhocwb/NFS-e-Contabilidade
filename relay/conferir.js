#!/usr/bin/env node
/* Confere a integração inteira e diz o que falta.
 *
 * "Não funciona" tem umas quinze causas possíveis aqui — token de teste que
 * venceu em 24h, campo `messages` não assinado, App Secret trocado, cadastro
 * que nunca foi enviado, número que a Meta não reconhece. Descobrir qual delas
 * é, um palpite por vez, custa uma tarde.
 *
 * Este script percorre a corrente inteira, na ordem em que ela quebra, e para
 * na primeira peça que falta — dizendo o que fazer.
 *
 *   node conferir.js                    (dentro da pasta relay/, com o .env)
 *   node conferir.js https://meu.dominio.com.br   (confere também de fora)
 */

require('fs').existsSync('.env') && carregarEnv('.env');

function carregarEnv(arquivo) {
  for (const linha of require('fs').readFileSync(arquivo, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const GRAPH = process.env.META_GRAPH || 'https://graph.facebook.com/v21.0';
const publico = process.argv[2] || process.env.URL_PUBLICA || null;

let falhou = false;
const OK = '\x1b[32m✓\x1b[0m';
const NAO = '\x1b[31m✗\x1b[0m';
const AVISO = '\x1b[33m!\x1b[0m';

function passo(marca, texto, detalhe, comoResolver) {
  console.log(' ' + marca + '  ' + texto);
  if (detalhe) console.log('    \x1b[90m' + detalhe + '\x1b[0m');
  if (comoResolver) {
    console.log('    \x1b[36m→ ' + comoResolver.replace(/\n/g, '\n      ') + '\x1b[0m');
  }
  if (marca === NAO) falhou = true;
}

async function pegar(url, opcoes = {}) {
  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opcoes));
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
    return { status: r.status, corpo: j, bruto: t };
  } catch (e) {
    return { erro: e.name === 'AbortError' ? 'não respondeu em 10s' : e.message };
  } finally { clearTimeout(prazo); }
}

(async () => {
  console.log('\n\x1b[1mConferência da integração com o WhatsApp\x1b[0m\n');

  /* ------------------------------------------------------ 1. configuração */
  console.log('\x1b[1m1. Configuração local\x1b[0m');

  const precisa = {
    META_APP_SECRET: 'Configurações do app → Básico → Mostrar App Secret',
    META_VERIFY_TOKEN: 'Uma frase inventada por você — a mesma vai no painel da Meta',
    CHAVE_GATEWAY: 'A mesma da tela "Portal do cliente" do gateway'
  };
  for (const [chave, onde] of Object.entries(precisa)) {
    process.env[chave]
      ? passo(OK, chave + ' definido')
      : passo(NAO, chave + ' faltando', null, onde);
  }

  /* O token de envio e o phone number ID podem vir do gateway; o .env é
     reserva. Faltar nos dois é que é problema. */
  const doEnv = process.env.META_TOKEN && process.env.META_PHONE_NUMBER_ID;
  passo(doEnv ? OK : AVISO,
    doEnv ? 'Token e número no .env' : 'Token e número não estão no .env',
    doEnv ? null : 'Tudo bem se estiverem na tela do gateway — confiro adiante.');

  if (falhou) {
    console.log('\n\x1b[31mFalta configuração básica. Corrija e rode de novo.\x1b[0m\n');
    process.exit(1);
  }

  /* --------------------------------------------------------- 2. o gateway */
  console.log('\n\x1b[1m2. O gateway do escritório\x1b[0m');

  const url = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
  const cad = await pegar(url + '/ponte/cadastro/previa-ensaio', {
    headers: { authorization: 'Bearer ' + process.env.CHAVE_GATEWAY }
  });

  let cadastro = null;
  if (cad.erro) {
    passo(NAO, 'Não alcancei o gateway em ' + url, cad.erro,
      'O gateway está aberto? Se o repassador está noutra máquina, use\n' +
      'GATEWAY_URL para apontar — mas lembre que em produção quem procura\n' +
      'é o gateway, não o contrário.');
  } else if (cad.status === 401) {
    passo(NAO, 'O gateway recusou a chave',
      'HTTP 401', 'CHAVE_GATEWAY tem de ser igual à da tela "Portal do cliente".');
  } else if (cad.status !== 200) {
    passo(NAO, 'O gateway respondeu HTTP ' + cad.status);
  } else {
    cadastro = cad.corpo;
    passo(OK, 'Gateway respondeu',
      (cadastro.empresas || []).length + ' empresa(s), ' +
      (cadastro.whatsapp || []).length + ' número(s) autorizado(s)');

    const liberadas = (cadastro.empresas || []).filter(e => e.liberado);
    passo(liberadas.length ? OK : NAO,
      liberadas.length + ' empresa(s) liberada(s) para o portal',
      liberadas.map(e => e.nomeFantasia || e.razaoSocial).join(', ') || null,
      liberadas.length ? null :
        'Na ficha da empresa → aba Integração → "Liberado para usar o portal".\n' +
        'Sem isso, todo pedido é recusado na chegada.');

    passo((cadastro.whatsapp || []).length ? OK : NAO,
      (cadastro.whatsapp || []).length + ' número(s) autorizado(s)',
      (cadastro.whatsapp || []).map(w => w.telefone).join(', ') || null,
      (cadastro.whatsapp || []).length ? null :
        'Na ficha da empresa → aba Integração → "WhatsApp autorizado".\n' +
        'Número não cadastrado recebe recusa neutra.');

    const escritorio = (cadastro.escritorio || {}).nome;
    passo(escritorio ? OK : AVISO,
      escritorio ? 'Escritório: ' + escritorio : 'Identidade do escritório em branco',
      null, escritorio ? null :
        'Tela "Identidade visual". Sem o nome, a primeira mensagem chega de um\n' +
        'número desconhecido e parece golpe.');
  }

  /* ----------------------------------------------------------- 3. a Meta */
  console.log('\n\x1b[1m3. O número na Meta\x1b[0m');

  const canal = (cadastro || {}).canal || {};
  const token = canal.token || process.env.META_TOKEN;
  const numeroId = canal.phoneNumberId || process.env.META_PHONE_NUMBER_ID;

  if (!token || !numeroId) {
    passo(NAO, 'Sem token ou sem phone number ID', null,
      'Tela "Portal do cliente" → WhatsApp do escritório.\n' +
      'O token da tela da Meta vence em 24h — gere o permanente por um\n' +
      'usuário do sistema, ou o bot para de responder amanhã.');
  } else {
    passo(OK, 'Credenciais encontradas',
      canal.token ? 'vindas do gateway' : 'vindas do .env');

    const r = await pegar(
      GRAPH + '/' + numeroId + '?fields=verified_name,display_phone_number,quality_rating',
      { headers: { authorization: 'Bearer ' + token } });

    if (r.erro) {
      passo(NAO, 'Não alcancei a Meta', r.erro, 'Sem internet, ou saída bloqueada.');
    } else if (r.status === 200) {
      passo(OK, 'A Meta reconheceu o número',
        (r.corpo.verified_name || '?') + ' · ' + (r.corpo.display_phone_number || '?') +
        (r.corpo.quality_rating ? ' · qualidade ' + r.corpo.quality_rating : ''));
    } else {
      const err = (r.corpo && r.corpo.error) || {};
      const expirou = /expired|session has expired/i.test(err.message || '');
      passo(NAO, 'A Meta recusou (HTTP ' + r.status + ')',
        err.message || r.bruto.slice(0, 160),
        expirou
          ? 'O token venceu. O que aparece na tela da API dura 24 horas —\n' +
            'gere um permanente em Configurações do negócio → Usuários do sistema.'
          : 'Confira o phone number ID e o token. Erro 190 é token inválido;\n' +
            '100 costuma ser id errado.');
    }
  }

  /* --------------------------------------------------- 4. o endereço público */
  console.log('\n\x1b[1m4. O endereço que a Meta chama\x1b[0m');

  if (!publico) {
    passo(AVISO, 'Endereço público não informado', null,
      'Rode com o endereço para eu conferir de fora:\n' +
      'node conferir.js https://seu-dominio.com.br');
  } else {
    const saude = await pegar(publico.replace(/\/+$/, '') + '/saude');
    if (saude.erro) {
      passo(NAO, 'Não alcancei ' + publico, saude.erro,
        'DNS apontando para o servidor? Caddy no ar? Firewall liberado?');
    } else if (saude.status === 200) {
      passo(OK, 'O repassador responde em ' + publico,
        'fila: ' + (saude.corpo.pedidosNaFila ?? '?') + ' pedido(s)');
      passo(publico.startsWith('https://') ? OK : NAO,
        publico.startsWith('https://') ? 'HTTPS' : 'Está em HTTP',
        null, publico.startsWith('https://') ? null :
          'A Meta não entrega em HTTP. Ponha o Caddy na frente.');

      // A verificação do webhook, como a Meta faz
      const desafio = 'teste' + Date.now();
      const v = await pegar(publico.replace(/\/+$/, '') +
        '/webhook?hub.mode=subscribe&hub.verify_token=' +
        encodeURIComponent(process.env.META_VERIFY_TOKEN) +
        '&hub.challenge=' + desafio);
      passo(v.bruto === desafio ? OK : NAO,
        v.bruto === desafio ? 'O webhook devolve o desafio'
                            : 'O webhook não devolveu o desafio',
        v.bruto === desafio ? null : 'respondeu: ' + String(v.bruto).slice(0, 80),
        v.bruto === desafio ? null :
          'O META_VERIFY_TOKEN daqui e o do painel da Meta têm de ser iguais.');

      // Corpo sem assinatura precisa ser recusado
      const semAssinatura = await pegar(publico.replace(/\/+$/, '') + '/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{"entry":[]}'
      });
      passo(semAssinatura.status === 403 ? OK : NAO,
        semAssinatura.status === 403
          ? 'POST sem assinatura é recusado'
          : 'POST sem assinatura NÃO foi recusado (HTTP ' + semAssinatura.status + ')',
        null, semAssinatura.status === 403 ? null :
          'Grave: qualquer um que descubra o endereço enfileira pedido de nota.\n' +
          'Confira o META_APP_SECRET no servidor.');
    } else {
      passo(NAO, publico + ' respondeu HTTP ' + saude.status);
    }
  }

  /* ------------------------------------------------------------ o resumo */
  console.log('');
  if (falhou) {
    console.log('\x1b[31mFalta alguma coisa — as linhas com ✗ dizem o quê.\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[32mTudo de pé.\x1b[0m Mande "oi" do seu celular para o número do escritório.');
  console.log('Se não responder, olhe o log:  journalctl -u nfse-relay -f\n');
})();
