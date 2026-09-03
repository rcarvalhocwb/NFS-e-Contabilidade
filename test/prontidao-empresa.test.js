const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* "Esta empresa está pronta para emitir?"
 *
 * É a pergunta que o contador faz de verdade. Os campos sempre existiram no
 * cadastro; o que faltava era alguém dizer QUANDO ele está completo. As
 * conferências viviam espalhadas — padrão fiscal na lista de empresas, cadeia
 * do WhatsApp no diagnóstico — e nenhuma respondia isso.
 *
 * Sem elas juntas, a resposta chegava pela nota recusada, que é o pior lugar
 * para descobrir que faltava o certificado.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

const SERVICO = fonte('src', 'services', 'prontidaoEmpresa.js');

test('cobre tudo o que impede uma nota de sair', () => {
  for (const peca of ['certificado', 'Padrões fiscais', 'Numeração',
                      'serviço', 'WhatsApp', 'homologação']) {
    assert.ok(new RegExp(peca, 'i').test(SERVICO), 'precisa conferir: ' + peca);
  }
});

test('a ordem é a da dependência', () => {
  /* Cobrar o número do WhatsApp antes do certificado seria mandar a pessoa
     arrumar o telhado antes da parede. */
  const cert = SERVICO.indexOf("'Sem certificado A1'");
  const wa = SERVICO.indexOf('Nenhum número de WhatsApp');
  assert.ok(cert > 0 && wa > cert);
});

test('"pronta" é sobre emitir, não sobre estar perfeita', () => {
  /* Homologação e WhatsApp sem número não impedem a nota de sair. Dizer que a
     empresa não está pronta por causa deles seria exagerar, e exagero faz o
     aviso perder o valor. */
  assert.match(SERVICO, /pronta: faltas === 0/);
  assert.match(SERVICO, /não impede a nota de sair/);
});

test('cada falta diz onde se resolve', () => {
  const faltas = SERVICO.match(/item\('falta',/g) || [];
  assert.ok(faltas.length >= 4);
  for (const onde of ['Aba Certificado', 'Aba Documentos Fiscais', 'Tela Serviços']) {
    assert.ok(SERVICO.includes(onde), 'precisa apontar: ' + onde);
  }
});

test('o destino da nota entra na conferência', () => {
  /* Uma empresa pode estar completa e ainda assim bloqueada pelo município —
     e é a mesma tela que precisa dizer isso. */
  assert.match(SERVICO, /emissorMunicipal\.conferirPodeEmitir\(mun, e\)/);
  assert.match(SERVICO, /transporte\(mun, e\)/);
  assert.match(SERVICO, /CGSN 189\/2026/);
});

test('a rota respeita o escopo por empresa', () => {
  /* A prontidão diz o que falta no cadastro de um cliente do escritório. */
  const rota = fonte('src', 'routes', 'empresas.js');
  assert.match(rota, /router\.get\('\/:cnpj\/prontidao', exigirEmpresaVisivel/);
});

test('a tela mostra na Visão geral, que é onde se abre a ficha', () => {
  const painel = fonte('src', 'public', 'painel.js');
  assert.match(painel, /function carregarProntidao/);
  assert.match(painel, /carregarProntidao\(e\.cnpj\)/);
  const html = fonte('src', 'public', 'admin.html');
  assert.match(html, /id="vgProntidaoCartao"/);
});
