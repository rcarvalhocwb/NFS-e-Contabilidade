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

test('não alcançar a Sefin é classificado como rede', () => {
  /* O envio passou a ser roteado por município — a Sefin na maioria, o
     provedor municipal onde ele aceita o layout nacional. A classificação da
     falha é a mesma para os dois: não falar com o destino é rede. */
  const i = fila.indexOf('resp = await transporte.enviarDps');
  assert.ok(i > 0, 'o envio roteado precisa continuar existindo');
  const corpo = fila.slice(i, i + 600);
  assert.match(corpo, /marcarFalha\(nota, 'Sem conexão com a Sefin: ' \+ e\.message, 'rede'\)/);
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
