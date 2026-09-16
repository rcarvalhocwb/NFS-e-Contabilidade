const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { decrypt } = require('../secretbox');

/* O repassador e o túnel rodando aqui, vigiados pelo gateway.
 *
 * A VPS nunca foi necessária — o que a Meta exige é um endereço público em
 * HTTPS, e um túnel dá isso com conexão de SAÍDA, sem abrir porta no roteador.
 * O que a VPS dava era separação, e o que ela cobrava era uma peça a mais para
 * manter: outro sistema para atualizar, outra conta para pagar, outro lugar
 * para esquecer. Num escritório sem quem cuide de servidor, a peça esquecida é
 * o risco maior.
 *
 * Então: mesma instalação, mesma atualização, mesmo backup, uma tela só. O
 * gateway sobe os dois processos, vigia, reinicia se caírem, e desliga junto.
 *
 * O QUE CONTINUA SEPARADO, e é o que sustenta o arranjo:
 *   - o repassador é um processo à parte, não uma rota deste servidor
 *   - ouve só em 127.0.0.1 — quem o alcança é o túnel, ninguém da rede
 *   - não recebe DATABASE_URL nem MASTER_KEY no ambiente
 *   - não tem acesso ao certificado, à numeração nem ao XML
 *
 * O que se perde em relação à VPS: os processos estão na mesma máquina, então
 * quem invadir o repassador tem por onde tentar escalar. É uma troca, ela está
 * escrita na tela, e o escritório pode continuar apontando para fora.
 */

const RAIZ = path.join(__dirname, '..', '..');
const REINICIO_MS = 5000;
const MAX_REINICIOS_SEGUIDOS = 5;

/* Um supervisor por processo. Mesmas regras, estados separados: o túnel cair
   não deve zerar a contagem do repassador nem vice-versa. */
function supervisor(nome) {
  return {
    nome, filho: null, reinicios: 0, desligando: false,
    ultimoErro: null, subiuEm: null, ultimaLinha: null
  };
}

const s = {
  relay: supervisor('repassador'),
  tunel: supervisor('túnel')
};

async function configuracao() {
  const r = await db.query(
    `SELECT relay_local, relay_porta, relay_url_publica, chave_cifrada,
            wa_app_secret_cifrado, wa_verify_token_cifrado,
            wa_token_cifrado, wa_phone_number_id, wa_transporte,
            tunel_ativo, tunel_token_cifrado, tunel_binario
       FROM config_nuvem WHERE id = TRUE`);
  const c = r.rows[0] || {};

  /* A porta do módulo mora em `whatsapp_local`, não aqui: ela é do programa
     separado, e é o escritório que a escolhe na instalação. O repassador
     precisa dela para saber onde entregar a resposta. */
  const m = await db.query('SELECT porta FROM whatsapp_local WHERE id = 1')
    .catch(() => ({ rows: [] }));
  c.wa_modulo_porta = m.rows.length ? m.rows[0].porta : null;

  return c;
}

function abrir(campo) {
  if (!campo) return null;
  try { return decrypt(campo).toString('utf8'); } catch (_) { return null; }
}

/* ---------------------------------------------------------- a supervisão */

function subir(sup, comando, args, opcoes) {
  if (sup.filho) return { rodando: true, motivo: 'já estava no ar' };

  sup.desligando = false;
  sup.filho = spawn(comando, args, Object.assign(
    { stdio: ['ignore', 'pipe', 'pipe'] }, opcoes));
  sup.subiuEm = new Date();
  sup.ultimoErro = null;

  /* Os dois logs vão para o do gateway, com prefixo. Uma instalação, um lugar
     para olhar quando alguém pergunta por que o bot não respondeu. */
  const marca = '[' + sup.nome + '] ';
  sup.filho.stdout.on('data', d => {
    sup.ultimaLinha = String(d).trim().split('\n').pop();
    process.stdout.write(marca + d);
  });
  sup.filho.stderr.on('data', d => {
    const texto = String(d);
    sup.ultimaLinha = texto.trim().split('\n').pop();
    /* O cloudflared escreve tudo em stderr, inclusive "conexão registrada".
       Guardar isso como "último erro" faria a tela mentir. */
    if (/err|fail|fatal|erro/i.test(texto)) sup.ultimoErro = sup.ultimaLinha;
    process.stderr.write(marca + d);
  });

  sup.filho.on('error', e => {
    sup.ultimoErro = e.code === 'ENOENT'
      ? 'Programa não encontrado: ' + comando
      : e.message;
  });

  sup.filho.on('exit', (codigo, sinal) => {
    sup.filho = null;
    if (sup.desligando) return;

    sup.reinicios++;
    if (sup.reinicios > MAX_REINICIOS_SEGUIDOS) {
      /* Reiniciar em laço um processo que não sobe só enche o log e esconde o
         problema. Para, e a tela mostra o motivo. */
      sup.ultimoErro = 'Caiu ' + sup.reinicios + ' vezes seguidas e parei de ' +
        'tentar. ' + (sup.ultimoErro || 'Encerrou com código ' + codigo + '.');
      console.error(marca + sup.ultimoErro);
      return;
    }

    console.warn(marca + 'encerrou (' + (sinal || 'código ' + codigo) +
      ') — subindo de novo em ' + (REINICIO_MS / 1000) + 's');
    setTimeout(() => {
      iniciar().catch(e => console.error(marca + e.message));
    }, REINICIO_MS).unref();
  });

  /* Um minuto de pé zera a contagem: cair na subida é problema de
     configuração; cair depois de rodar é acidente. */
  setTimeout(() => { if (sup.filho) sup.reinicios = 0; }, 60000).unref();
  return { rodando: true };
}

function derrubar(sup) {
  sup.desligando = true;
  if (sup.filho) {
    sup.filho.kill();
    sup.filho = null;
  }
}

/* ---------------------------------------------------------- o repassador */

/* O que o processo filho precisa saber — e só isso.
 *
 * A lista é curta de propósito: passar o ambiente inteiro entregaria
 * DATABASE_URL e MASTER_KEY a um processo que fala com a internet. */
function ambienteDoRelay(c) {
  const faltando = [];
  const chave = abrir(c.chave_cifrada);
  const appSecret = abrir(c.wa_app_secret_cifrado);
  const verify = abrir(c.wa_verify_token_cifrado);

  /* A chave da ponte é sempre necessária: é ela que autentica o módulo, o
     gateway e a réplica do cadastro contra o repassador. */
  if (!chave) faltando.push('a chave da ponte');

  /* App Secret e verify token servem para UMA coisa: provar que um POST veio
     mesmo da Meta, e responder ao desafio que ela faz ao cadastrar o webhook.
     No transporte por sessão própria não existe webhook nenhum — a mensagem
     chega do módulo desta máquina, pelo /wa/entrada, autenticada pela chave
     acima.
     Exigi-los sempre travava o caminho inteiro: quem escolhia sessão própria
     via o repassador recusar-se a subir pedindo credenciais de um serviço que
     nunca vai usar, sem nada na tela ligando uma coisa à outra. */
  if (c.wa_transporte !== 'local') {
    if (!appSecret) faltando.push('o App Secret da Meta');
    if (!verify) faltando.push('o token de verificação do webhook');
  }

  if (faltando.length) {
    throw Object.assign(new Error('Falta configurar ' + faltando.join(', ') + '.'),
      { faltando });
  }

  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: String(c.relay_porta || 8080),
    /* Só localhost. O túnel alcança daqui de dentro; a rede do escritório, não
       — e não há motivo para o repassador atender a máquina de ninguém. */
    HOST: '127.0.0.1',
    META_APP_SECRET: appSecret,
    META_VERIFY_TOKEN: verify,
    META_TOKEN: abrir(c.wa_token_cifrado) || '',
    META_PHONE_NUMBER_ID: c.wa_phone_number_id || '',
    CHAVE_GATEWAY: chave,

    /* POR ONDE A RESPOSTA SAI.
     *
     * Faltava, e sem isto o transporte por sessão própria nunca funcionou
     * quando o repassador é subido pelo gateway — que é o desenho de produção.
     * `transporte.js` lê `WA_TRANSPORTE` e, sem a variável, assume 'meta';
     * então o escritório escolhia sessão própria na tela, o módulo conectava,
     * a conversa rodava certa, e a resposta morria em "sem número da Meta
     * configurado". Tudo aparentemente de pé, e o cliente sem resposta.
     *
     * A porta vai junto porque é o escritório quem a escolhe, na instalação. */
    WA_TRANSPORTE: c.wa_transporte === 'local' ? 'local' : 'meta',
    WA_MODULO_URL: 'http://127.0.0.1:' + (c.wa_modulo_porta || 3200),

    /* O caminho de volta, para o cliente poder consultar as PROPRIAS notas e
       pedir segunda via sem sair da conversa.
       So existe porque este repassador roda NESTA maquina. Um repassador na
       nuvem nao recebe esta variavel, e a conversa entao diz que o escritorio
       vai retornar -- em vez de prometer o que nao pode cumprir. */
    GATEWAY_URL: 'http://127.0.0.1:' + (process.env.PORT || 3000),

    ARQUIVO_DADOS: path.join(RAIZ, 'dados-relay', 'relay.json')
  };
}

/* --------------------------------------------------------------- o túnel */

/* Onde está o cloudflared.
 *
 * Não é baixado automaticamente de propósito: um programa que busca e executa
 * binário sozinho é justamente o que ninguém quer numa máquina que guarda
 * certificado A1. Baixar é uma vez, e está no roteiro. */
function acharCloudflared(c) {
  const candidatos = [
    c.tunel_binario,
    path.join(RAIZ, 'ferramentas', 'cloudflared.exe'),
    path.join(RAIZ, 'ferramentas', 'cloudflared'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe'
  ].filter(Boolean);

  for (const caminho of candidatos) {
    try { if (fs.statSync(caminho).isFile()) return caminho; } catch (_) { /* segue */ }
  }
  /* Instalado pelo winget/choco fica no PATH: deixa o SO resolver. */
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/* ------------------------------------------------------------- o conjunto */

async function iniciar() {
  const c = await configuracao();
  const saida = { repassador: null, tunel: null };

  if (c.relay_local) {
    try {
      const env = ambienteDoRelay(c);
      const r = subir(s.relay, process.execPath,
        [path.join(RAIZ, 'relay', 'servidor.js')],
        { cwd: path.join(RAIZ, 'relay'), env });
      if (r.rodando && !r.motivo) {
        console.log('[repassador] no ar em 127.0.0.1:' + env.PORT +
          ' (esta máquina, vigiado pelo gateway)');
      }
      saida.repassador = r;
    } catch (e) {
      s.relay.ultimoErro = e.message;
      console.warn('[repassador] não subiu —', e.message);
      saida.repassador = { rodando: false, motivo: e.message };
    }
  } else {
    saida.repassador = { rodando: false, motivo: 'desligado na configuração' };
  }

  if (c.tunel_ativo) {
    const token = abrir(c.tunel_token_cifrado);
    if (!token) {
      s.tunel.ultimoErro = 'Falta o token do túnel.';
      saida.tunel = { rodando: false, motivo: s.tunel.ultimoErro };
    } else {
      const bin = acharCloudflared(c);
      /* --no-autoupdate: um processo que se troca sozinho no meio do
         expediente é surpresa, e surpresa aqui é nota que não sai. A
         atualização entra junto com a do gateway. */
      const r = subir(s.tunel, bin,
        ['tunnel', '--no-autoupdate', 'run', '--token', token],
        { env: { PATH: process.env.PATH } });
      if (r.rodando && !r.motivo) {
        console.log('[túnel] subindo — endereço público: ' +
          (c.relay_url_publica || '(configure o nome no painel da Cloudflare)'));
      }
      saida.tunel = r;
    }
  } else {
    saida.tunel = { rodando: false, motivo: 'desligado na configuração' };
  }

  return saida;
}

function parar() {
  derrubar(s.relay);
  derrubar(s.tunel);
}

function retrato(sup) {
  return {
    rodando: !!sup.filho,
    subiuEm: sup.subiuEm,
    ultimoErro: sup.ultimoErro,
    ultimaLinha: sup.ultimaLinha,
    desistiu: sup.reinicios > MAX_REINICIOS_SEGUIDOS,
    reinicios: sup.reinicios
  };
}

async function situacao() {
  const c = await configuracao();
  return {
    relayLocal: !!c.relay_local,
    porta: c.relay_porta || 8080,
    urlPublica: c.relay_url_publica || null,
    temAppSecret: !!c.wa_app_secret_cifrado,
    temVerifyToken: !!c.wa_verify_token_cifrado,
    tunelAtivo: !!c.tunel_ativo,
    temTunelToken: !!c.tunel_token_cifrado,
    cloudflared: c.tunel_ativo ? acharCloudflared(c) : null,
    repassador: retrato(s.relay),
    tunel: retrato(s.tunel)
  };
}

/* Aplica uma mudança de configuração agora, sem esperar o próximo reinício do
   gateway — salvar na tela e o processo seguir com a configuração velha até
   alguém reiniciar é a pior forma de errar: parece feito. */
async function reaplicar() {
  parar();
  s.relay.reinicios = 0;
  s.tunel.reinicios = 0;
  s.relay.ultimoErro = null;
  s.tunel.ultimoErro = null;
  return iniciar();
}

module.exports = { iniciar, parar, situacao, reaplicar };
