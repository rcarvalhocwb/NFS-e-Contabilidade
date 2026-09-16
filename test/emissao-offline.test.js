const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Emissão quando a internet cai.
 *
 * O certificado está nesta máquina, então numerar, montar e assinar a DPS não
 * depende de internet — só a entrega à Sefin depende. A nota fica pronta e
 * assinada na fila, e sai quando a linha voltar.
 *
 * O que quebrava isso: a fila tratava toda falha igual, com cinco tentativas e
 * espera crescente. Somando (5s, 20s, 45s, 80s, 125s), QUALQUER QUEDA DE MAIS
 * DE CINCO MINUTOS virava a nota em 'erro' — e número de DPS não se
 * reaproveita, então cada uma deixava um buraco na sequência fiscal por causa
 * de um cabo solto.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', ...partes), 'utf8');
}
const fila = fonte('services', 'filaEmissao.js');

test('falha de rede não desiste nunca', () => {
  const i = fila.indexOf('async function marcarFalha');
  const corpo = fila.slice(i, fila.indexOf('\n}\n', i));
  assert.match(corpo, /const transitoria = tipo === 'rede' \|\| tipo === 'sefin'/);
  assert.match(corpo, /const desiste = !transitoria && nota\.tentativas >= MAX_TENTATIVAS/,
    'a contagem de tentativas só pode valer para falha definitiva');
});

test('falha de rede não muda o status da nota', () => {
  /* Continua 'processando': para quem olha a tela, a nota está a caminho — que
     é a verdade. 'erro' diria que algo deu errado com o documento. */
  const i = fila.indexOf('async function marcarFalha');
  const corpo = fila.slice(i, fila.indexOf('\n}\n', i));
  const trechoTransitorio = corpo.slice(corpo.indexOf('if (transitoria)'),
                                        corpo.indexOf('if (desiste)'));
  assert.ok(!/status=/.test(trechoTransitorio),
    'o ramo transitório não pode tocar no status');
  assert.match(trechoTransitorio, /falha_tipo=\$3/);
  assert.match(trechoTransitorio, /processar_apos/);
});

test('não alcançar a Sefin é rede; não SABER é outra coisa', () => {
  /* Este teste dizia: toda falha de envio vira 'rede', e retransmite.
     Era o comportamento, e era a suposição perigosa — um timeout entrava
     nessa vala e a DPS era reenviada sem ninguém saber se a primeira tinha
     chegado. A propriedade continua valendo para o que PROVA que nada saiu;
     o resto passou a ser tratado como incerto. */
  const i = fila.indexOf('resp = await transporte.enviarDps');
  assert.ok(i > 0, 'o envio roteado precisa continuar existindo');
  const corpo = fila.slice(i, fila.indexOf('const autorizada', i));

  assert.match(corpo, /provaQueNaoSaiu\(e\)/,
    'a classificação precisa depender de prova, não do fato de ter falhado');
  assert.match(corpo, /'Sem conexão com a Sefin: ' \+ e\.message, 'rede'/,
    'com prova de que nada saiu, continua sendo rede — e retransmite');
  assert.match(corpo, /resolverIncerto\(nota, empresa, cert, e\)/,
    'sem prova, o caminho é resolver a dúvida');

  const comProva = corpo.indexOf('provaQueNaoSaiu');
  const semProva = corpo.indexOf('resolverIncerto');
  assert.ok(comProva < semProva,
    'a prova é testada primeiro; o incerto é o caminho padrão, não a exceção');
});

test('5xx da Sefin é transitório, não rejeição', () => {
  /* Em janeiro de 2026 a Receita reconheceu indisponibilidade do Emissor
     Nacional por volume de acesso. Dias assim não podem queimar numeração. */
  assert.match(fila, /resp\.status >= 500[\s\S]{0,260}'sefin'/);
});

test('certificado e empresa ausente continuam definitivos', () => {
  /* Insistir não resolve, e a nota precisa sair da fila para alguém arrumar. */
  assert.match(fila, /marcarFalha\(nota, 'Empresa não encontrada', 'definitiva'\)/);
  assert.match(fila, /marcarFalha\(nota, 'Certificado: ' \+ e\.message, 'definitiva'\)/);
});

test('credencial recusada não fica retentando', () => {
  /* 401/403 é a Sefin dizendo que o certificado não serve. Voltar a tentar a
     cada dois minutos para sempre não conserta certificado vencido. */
  const i = fila.indexOf('resp.status === 401');
  const corpo = fila.slice(i, i + 700);
  assert.match(corpo, /status='erro'/);
  assert.match(corpo, /falha_tipo='definitiva'/);
});

test('o desfecho limpa o tipo de falha', () => {
  /* Senão uma nota autorizada depois de uma queda continuaria contando como
     "esperando conexão" na tela. */
  const i = fila.indexOf("status=$2, chave_acesso=$3");
  const corpo = fila.slice(i, i + 300);
  assert.match(corpo, /falha_tipo=NULL/);
});

test('a espera por rede tem teto menor que a por erro', () => {
  /* Quando a internet volta, ninguém quer esperar mais dez minutos. */
  const i = fila.indexOf('function proximaTentativaSegundos');
  const corpo = fila.slice(i, fila.indexOf('\n}', i));
  assert.match(corpo, /transitoria \? 120 : 600/);

  // A fórmula, avaliada como o código a escreve
  const espera = (t, transitoria) => Math.min(5 * t * t, transitoria ? 120 : 600);
  assert.ok(espera(1, true) < espera(3, true), 'a espera cresce com as tentativas');
  assert.equal(espera(50, true), 120, 'teto de 2 min para rede');
  assert.equal(espera(50, false), 600, 'e 10 min para o resto');
});

test('a migração descreve os três tipos', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '027_falha_tipo.sql'), 'utf8');
  assert.match(sql, /CHECK \(falha_tipo IS NULL OR falha_tipo IN \('rede', 'sefin', 'definitiva'\)\)/);
});

/* ------------------------------------------------- o que a tela precisa dizer */

test('o diagnóstico separa a fila de espera do total', () => {
  const diag = fonte('services', 'diagnosticoRede.js');
  const i = diag.indexOf('async function filaDeEspera');
  const corpo = diag.slice(i, diag.indexOf('\n}\n', i));
  assert.match(corpo, /falha_tipo IN \('rede', 'sefin'\)/);
  assert.match(corpo, /status = 'processando'/);
});

test('espera longa vira alerta, sem inventar prazo', () => {
  /* A data de emissão vai dentro do documento assinado, e não achei o prazo
     exato de aceitação nos esquemas publicados. O aviso diz isso em vez de
     afirmar um número que eu não confirmei. */
  const diag = fonte('services', 'diagnosticoRede.js');
  assert.match(diag, /horas >= 24/);
  assert.match(diag, /data de emissão vai dentro/);
});

test('a tela de rede não oferece abrir porta', () => {
  /* A resposta para "que porta eu abro no roteador?" é nenhuma, e precisa estar
     na tela. Se um dia alguém acrescentar um campo de porta pública aqui, este
     teste cai — e é para cair. */
  const diag = fonte('services', 'diagnosticoRede.js');
  assert.match(diag, /precisaAbrirPorta: false/);
  assert.match(diag, /precisaIpPublico: false/);
  assert.match(diag, /precisaDns: false/);

  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'admin.html'), 'utf8');
  const i = html.indexOf('data-tela-conteudo="rede"');
  const secao = html.slice(i, html.indexOf('</section>', i));
  assert.ok(!/id="rd(PortaPublica|IpPublico|Dns|Ddns)"/.test(secao),
    'nenhum campo de exposição na internet');
  assert.match(secao, /Não há nada para configurar aqui/);
});

/* ------------------------------------------------- o resultado incerto */

/* A transmissão falhou. A nota saiu ou não?
 *
 * O código antigo respondia "não saiu" para toda falha, e retransmitia. Está
 * certo para DNS que não resolveu e porta que recusou conexão — aí nada foi
 * enviado. Mas um TIMEOUT não prova nada disso: a DPS pode ter chegado, virado
 * nota, e o que se perdeu foi a resposta. Retransmitir aí emite a mesma nota
 * duas vezes, e desfazer custa um cancelamento que nem todo município aceita.
 */

const { provaQueNaoSaiu } = require('../src/services/filaEmissao');

function erro(codigo, mensagem) {
  return Object.assign(new Error(mensagem || codigo), { code: codigo });
}

test('DNS e conexão recusada provam que nada saiu', () => {
  /* São os casos em que retransmitir é seguro, e o único jeito de a nota sair
     numa queda de internet comum. */
  assert.ok(provaQueNaoSaiu(erro('ENOTFOUND')), 'DNS não resolveu: não houve para onde enviar');
  assert.ok(provaQueNaoSaiu(erro('ECONNREFUSED')), 'a porta recusou: nada foi aceito');
  assert.ok(provaQueNaoSaiu(erro('EAI_AGAIN')), 'falha temporária de DNS');
});

test('timeout NÃO prova que nada saiu', () => {
  /* O caso que existe para ser pego. A requisição foi enviada; o que não
     voltou foi a resposta. */
  assert.ok(!provaQueNaoSaiu(erro('ETIMEDOUT')));
  assert.ok(!provaQueNaoSaiu(erro('UND_ERR_HEADERS_TIMEOUT')));
  assert.ok(!provaQueNaoSaiu(erro('ECONNRESET')), 'conexão cortada no meio: pode ter chegado');
  assert.ok(!provaQueNaoSaiu(erro('EPIPE')));
});

test('erro sem código conhecido cai no lado seguro', () => {
  /* Na dúvida, incerto. Classificar como "não saiu" sem prova autoriza
     retransmitir — o erro caro. Ficar parado é o erro barato. */
  assert.ok(!provaQueNaoSaiu(new Error('alguma coisa quebrou')));
  assert.ok(!provaQueNaoSaiu(erro('COISA_NOVA_DO_NODE')));
  assert.ok(!provaQueNaoSaiu(null));
  assert.ok(!provaQueNaoSaiu(undefined));
});

test('o código aninhado em cause também é lido', () => {
  /* O fetch do Node embrulha o erro real em `cause`. Sem olhar ali, todo
     ECONNREFUSED viraria "incerto" e a nota ficaria parada numa queda de
     internet banal — o oposto do problema, mas também ruim. */
  const embrulhado = new Error('fetch failed');
  embrulhado.cause = erro('ECONNREFUSED');
  assert.ok(provaQueNaoSaiu(embrulhado));
});

test('incerto consulta a Sefin em vez de retransmitir', () => {
  const i = fila.indexOf('async function resolverIncerto');
  assert.ok(i > 0, 'a resolução do resultado incerto sumiu');
  const corpo = fila.slice(i, fila.indexOf('\nasync function transmitir', i));

  assert.match(corpo, /sefin\.consultarDps/,
    'a dúvida se resolve perguntando, e a consulta por idDps existe para isso');
  assert.ok(!/enviarDps/.test(corpo),
    'resolver a dúvida NUNCA pode transmitir');

  /* Três respostas, três caminhos — e o terceiro é o que mais importa. */
  assert.match(corpo, /status === 404/, '404 é resposta: a Sefin não tem a DPS');
  assert.match(corpo, /'autorizada'/, 'a nota que já existe é adotada');
  assert.match(corpo, /NÃO vou retransmitir/,
    'consulta que também falhou mantém a dúvida, não libera envio');
});

test('incerto nunca volta pelo caminho de transmitir', () => {
  /* A retentativa normal chama `transmitir`, que envia. Uma nota em dúvida
     precisa voltar para PERGUNTAR. */
  const i = fila.indexOf('async function transmitir');
  const corpo = fila.slice(i, fila.indexOf('\n/* ', i) + 1 || fila.length);
  assert.match(corpo, /nota\.falha_tipo === 'incerto'/,
    'transmitir precisa desviar antes de enviar qualquer coisa');
  const desvio = corpo.indexOf("falha_tipo === 'incerto'");
  const envio = corpo.indexOf('enviarDps');
  assert.ok(desvio > 0 && desvio < envio,
    'o desvio tem que vir ANTES do envio, senão não desvia nada');
});

test('incerto nunca vira erro por esgotar tentativas', () => {
  /* 'erro' quer dizer "a nota não saiu". É exatamente o que não se sabe.
     Declarar não-emitida uma nota que existe no fisco vira duas notas no dia
     em que alguém reemitir. */
  const i = fila.indexOf('async function marcarFalha');
  const corpo = fila.slice(i, fila.indexOf('\n/* ---', i));
  const bloco = corpo.slice(corpo.indexOf("tipo === 'incerto'"),
                            corpo.indexOf('const transitoria'));
  assert.ok(bloco.length > 0, 'o tratamento do incerto sumiu de marcarFalha');
  assert.ok(!/status\s*=\s*'erro'/.test(bloco) && !/status='erro'/.test(bloco),
    'incerto não pode virar erro');
  assert.match(bloco, /MAX_TENTATIVAS/.test(bloco) ? /$^/ : /processar_apos/,
    'ele reagenda, mas sem contar tentativas para desistir');
});

test('a migração permite o tipo novo', () => {
  /* Sem isso o UPDATE viola o CHECK e a nota fica sem marcação nenhuma —
     que é o pior dos mundos: em dúvida e sem ninguém saber. */
  const m = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '044_resultado_incerto.sql'), 'utf8');
  assert.match(m, /'incerto'/);
  assert.match(m, /DROP CONSTRAINT notas_falha_tipo_ck/,
    'a constraint antiga precisa sair antes de a nova entrar');
});
