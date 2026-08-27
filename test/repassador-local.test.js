const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O repassador rodando na própria máquina do escritório.
 *
 * A troca é deliberada: a VPS dava separação de máquina, e cobrava uma peça a
 * mais para manter. Num escritório sem quem cuide de servidor, a peça que
 * ninguém atualiza é o risco maior. O que estes testes protegem é o lado da
 * troca que NÃO pode ser abandonado junto: o repassador continua um processo
 * separado, sem banco, sem certificado, e sem atender ninguém da rede.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVICO = fonte('src', 'services', 'repassadorLocal.js');

/* ------------------------------------------------- o que ele NÃO recebe */

test('o processo filho não recebe o banco nem a MASTER_KEY', () => {
  /* É o ponto inteiro do arranjo. Passar `process.env` seria entregar
     DATABASE_URL e MASTER_KEY a um processo que fala com a internet — e aí a
     separação vira decoração. */
  const i = SERVICO.indexOf('function ambienteDoRelay');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  assert.ok(!/DATABASE_URL|MASTER_KEY/.test(corpo));
  assert.ok(!/\.\.\.process\.env|Object\.assign\(\{\}, process\.env/.test(corpo),
    'o ambiente é montado item a item, nunca herdado inteiro');
  /* PATH é o único empréstimo, e é preciso: sem ele o Node não acha nada. */
  assert.match(corpo, /PATH: process\.env\.PATH/);
});

test('o repassador atende só em 127.0.0.1', () => {
  /* Em 0.0.0.0 qualquer computador do escritório alcançaria o webhook e a fila
     de pedidos. Quem precisa alcançá-lo é o túnel, e o túnel roda aqui. */
  assert.match(SERVICO, /HOST: '127\.0\.0\.1'/);

  const servidor = fonte('relay', 'servidor.js');
  assert.match(servidor, /const HOST = process\.env\.HOST \|\| '0\.0\.0\.0'/,
    'a VPS continua ouvindo em todas as placas, porque o Caddy está fora do processo');
  assert.match(servidor, /servidor\.listen\(PORTA, HOST/);
});

test('o token do túnel e os segredos da Meta ficam cifrados', () => {
  const sql033 = fonte('migrations', '033_repassador_local.sql');
  const sql034 = fonte('migrations', '034_tunel_local.sql');
  assert.match(sql033, /wa_app_secret_cifrado\s+bytea/);
  assert.match(sql033, /wa_verify_token_cifrado\s+bytea/);
  assert.match(sql034, /tunel_token_cifrado bytea/);

  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  for (const campo of ['waAppSecret', 'waVerifyToken', 'tunelToken']) {
    assert.match(ponte, new RegExp('dados\\.' + campo + '\\)? ?\\)? ?põe|' +
      'dados\\.' + campo + '\\) põe'), campo + ' precisa ser cifrado ao salvar');
  }
});

test('nenhum segredo do repassador volta pela API', () => {
  /* A tela só precisa saber SE existe. Devolver o App Secret num GET o
     espalharia por log de proxy, histórico de navegador e print de tela. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('async function ler()');
  const consulta = ponte.slice(i, ponte.indexOf('}', i));
  for (const coluna of ['wa_app_secret_cifrado', 'wa_verify_token_cifrado',
                        'tunel_token_cifrado', 'chave_cifrada']) {
    assert.match(consulta, new RegExp('\\(' + coluna + ' IS NOT NULL\\) AS'),
      coluna + ' só pode sair como "tem ou não tem"');
  }
});

/* ------------------------------------------------------------ a supervisão */

test('processo que não sobe para de ser reiniciado', () => {
  /* Reiniciar em laço um processo com configuração errada enche o log e
     esconde o motivo. Para, e a tela mostra por quê. */
  assert.match(SERVICO, /MAX_REINICIOS_SEGUIDOS = \d+/);
  assert.match(SERVICO, /sup\.reinicios > MAX_REINICIOS_SEGUIDOS/);
  assert.match(SERVICO, /parei de\s*\n?\s*'?\s*\+?\s*'?tentar/);
});

test('um minuto de pé zera a contagem', () => {
  /* Cair na subida é configuração; cair depois de rodar é acidente. Sem isso,
     uma queda por semana acabaria esgotando o contador em dois meses. */
  assert.match(SERVICO, /if \(sup\.filho\) sup\.reinicios = 0;/);
});

test('os dois processos têm contadores separados', () => {
  /* O túnel cair não pode zerar a paciência com o repassador. */
  assert.match(SERVICO, /function supervisor\(nome\)/);
  assert.match(SERVICO, /relay: supervisor\(/);
  assert.match(SERVICO, /tunel: supervisor\(/);
});

test('o cloudflared não se atualiza sozinho', () => {
  /* Um processo que se troca sozinho no meio do expediente é surpresa, e
     surpresa aqui é nota que não sai. */
  assert.match(SERVICO, /'--no-autoupdate'/);
});

test('o gateway não baixa binário nenhum', () => {
  /* Numa máquina que guarda certificado A1, um programa que busca e executa
     binário sozinho é exatamente o que não se faz. */
  assert.ok(!/https?:\/\/[^\s']*cloudflared[^\s']*\.(exe|tgz|zip)/.test(SERVICO));
  assert.ok(!/fetch\(|https\.get|download/i.test(SERVICO),
    'o serviço não busca nada na internet');
  assert.match(SERVICO, /Não é baixado automaticamente de propósito/);
});

test('desligar o gateway desliga os dois', () => {
  const server = fonte('src', 'server.js');
  assert.match(server, /require\('\.\/services\/repassadorLocal'\)\.iniciar\(\)/);
  assert.match(server, /require\('\.\/services\/repassadorLocal'\)\.parar\(\)/);

  const i = SERVICO.indexOf('function parar()');
  const corpo = SERVICO.slice(i, SERVICO.indexOf('\n}', i));
  assert.match(corpo, /derrubar\(s\.relay\)/);
  assert.match(corpo, /derrubar\(s\.tunel\)/);
});

test('desligar de propósito não conta como queda', () => {
  /* Sem isso, parar o gateway dispararia um reinício do filho no caminho. */
  assert.match(SERVICO, /if \(sup\.desligando\) return;/);
});

test('a saída normal do cloudflared não vira "erro" na tela', () => {
  /* Ele escreve tudo em stderr, inclusive "conexão registrada". Guardar isso
     como último erro faria a tela mentir sobre um túnel saudável. */
  assert.match(SERVICO, /if \(\/err\|fail\|fatal\|erro\/i\.test\(texto\)\)/);
});

/* --------------------------------------------------- salvar aplica de fato */

test('mexer na configuração reinicia o processo na hora', () => {
  /* Salvar na tela e o processo continuar com a configuração velha até alguém
     reiniciar o gateway é a pior forma de errar: parece feito. */
  const rota = fonte('src', 'routes', 'ponte.js');
  const i = rota.indexOf("router.put('/config'");
  const corpo = rota.slice(i, rota.indexOf('\n});', i));
  assert.match(corpo, /antes\.relay_local !== salvo\.relay_local/);
  assert.match(corpo, /antes\.tunel_ativo !== salvo\.tunel_ativo/);
  assert.match(corpo, /b\.waAppSecret \|\| b\.waVerifyToken/);
  assert.match(corpo, /repassador\.reaplicar\(\)/);
});

test('o endereço da própria máquina é escolhido, não digitado', () => {
  /* Pedir que alguém digite http://127.0.0.1:8080 numa segunda caixa seria
     inventar um jeito de errar: o endereço é decidido aqui. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /põe\('url', 'http:\/\/127\.0\.0\.1:' \+ porta\)/);

  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /el\('ptUrl'\)\.readOnly = local;/);
});

test('a trava de rede interna continua valendo para endereço digitado', () => {
  /* A exceção é estreita de propósito: vale para o processo que ESTE gateway
     subiu, não para qualquer coisa que alguém escreva na caixa. Sem isso, o
     gateway viraria um scanner da rede da contabilidade. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('function validarUrl');
  const corpo = ponte.slice(i, ponte.indexOf('\n}', i));
  assert.match(corpo, /opcoes\.proprioProcesso/);
  assert.match(corpo, /\['127\.0\.0\.1', 'localhost'\]\.includes/);
  assert.match(corpo, /172\\\.\(1\[6-9\]\|2\\d\|3\[01\]\)/,
    'as faixas privadas continuam recusadas');
  assert.match(corpo, /169\\\.254\\\./, 'e o endereço de metadados de nuvem também');
});

test('a chave da ponte é sorteada quando os dois lados são o mesmo processo', () => {
  /* Pedir a mesma frase longa em dois campos só cria jeito de errar, e a frase
     que a pessoa inventa é sempre pior que 32 bytes aleatórios. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /dados\.relayLocal === true && !dados\.chave/);
  assert.match(ponte, /crypto\.randomBytes\(32\)/);
  assert.match(ponte, /if \(!atual\.tem_chave\)/,
    'chave já guardada não pode ser trocada por uma nova sem avisar');
});

/* ------------------------------------------------------- o que a tela diz */

test('a tela diz o que se perde rodando aqui', () => {
  /* Uma troca escondida é uma armadilha. Quem escolhe tem de saber que, numa
     VPS, o repassador invadido está numa máquina que não tem nada. */
  const html = fonte('src', 'public', 'admin.html');
  assert.match(html, /O que se perde rodando aqui/);
  assert.match(html, /mesma máquina do\s*\n?\s*certificado/);
});

test('o diagnóstico confere o https do endereço público, não o do localhost', () => {
  /* Com o repassador aqui, c.url é http://127.0.0.1 — e cobrar https dele
     daria uma falha que não existe, escondendo a que existe. */
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  assert.match(d, /const publico = local \? c\.relay_url_publica : c\.url;/);
  assert.match(d, /Endereço público em HTTPS/);
});

test('o diagnóstico dá a volta pela internet para provar o túnel', () => {
  /* É o único jeito de responder "a Meta consegue me alcançar?" sem esperar a
     primeira mensagem perdida. */
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  assert.match(d, /O endereço público responde de fora/);
  assert.match(d, /bater\(publico/);
});

test('cloudflared que não existe tem saída própria', () => {
  /* "Não está de pé" sem dizer que falta o programa manda a pessoa procurar no
     lugar errado. */
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  assert.match(d, /Programa não encontrado/);
  assert.match(d, /Baixe o cloudflared/);
});

test('a tela mostra os dois processos e a última linha de cada um', () => {
  /* Sem isto, a resposta para "o bot não respondeu" seria abrir o log do
     Windows — que ninguém no escritório vai abrir. */
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /function linhaProcesso/);
  assert.match(painel, /ultimaLinha/);
  assert.match(painel, /Repassador/);
  assert.match(painel, /Túnel/);
});

/* ------------------------------------------------ o que é instalado e escrito */

test('o instalador leva o relay junto', () => {
  /* Sem relay/ no pacote, a chave "Rodar o repassador nesta máquina" ligaria e
     nada aconteceria — o pior tipo de falha, porque parece feito. */
  const p = fonte('instalador', 'preparar-pacote.ps1');
  assert.match(p, /'src', 'migrations', 'scripts', 'relay'/);
  assert.match(p, /relay\\teste/, 'mas sem os testes');
  assert.match(p, /ferramentas/, 'e com a pasta onde vai o cloudflared');
});

test('o relay não depende de pacote nenhum de fora', () => {
  /* Ele é copiado para dentro do pacote sem node_modules próprio: se um dia
     alguém importar uma dependência aqui, o repassador sobe na máquina do
     desenvolvedor e quebra na do escritório. */
  const arquivos = require('fs')
    .readdirSync(require('path').join(__dirname, '..', 'relay'))
    .filter(f => f.endsWith('.js'));
  const builtins = ['crypto', 'fs', 'http', 'https', 'os', 'path', 'url',
                    'net', 'zlib', 'stream', 'events', 'buffer', 'util'];
  for (const f of arquivos) {
    const s = fonte('relay', f);
    for (const m of s.matchAll(/require\('([^.'][^']*)'\)/g)) {
      assert.ok(builtins.includes(m[1].replace(/^node:/, '')),
        'relay/' + f + ' importa ' + m[1] + ', que não é do Node');
    }
  }
});

test('o roteiro do arranjo local existe e é o recomendado', () => {
  const local = fonte('relay', 'implantar', 'NESTA-MAQUINA.md');
  assert.match(local, /túnel nomeado|Túnel nomeado/i,
    'o endereço de teste muda a cada reinício e não serve de webhook');
  assert.match(local, /O gateway não baixa programa sozinho/);
  assert.match(local, /O que se \*\*perde\*\*/,
    'a troca precisa estar escrita, não escondida');

  const vps = fonte('relay', 'implantar', 'LEIA-ME.md');
  assert.match(vps, /Provavelmente você não precisa deste roteiro/);
  assert.match(vps, /NESTA-MAQUINA\.md/);
  assert.ok(!/SEM-SERVIDOR\.md/.test(vps), 'o roteiro antigo não existe mais');
});
