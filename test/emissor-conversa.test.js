const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* A emissão por conversa vista de quem emite o dia inteiro.
 *
 * Um escritório atende dezenas de CNPJs, e o mesmo cliente costuma receber a
 * mesma nota todo mês. Duas coisas decorrem disso, e as duas são testadas aqui:
 *
 *   1. a empresa escolhida precisa ficar visível o tempo todo. A conversa rola,
 *      e depois de três respostas o nome sai de vista — emitir na empresa
 *      errada não é um erro de tela, é nota fiscal no CNPJ de outro cliente,
 *      assinada com o certificado dele;
 *   2. repetir a nota do mês passado não pode custar seis respostas.
 */

const js = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'emitir.js'), 'utf8');
const html = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'emitir.html'), 'utf8');
const rota = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'emissor.js'), 'utf8');

test('a barra da empresa é fixa no topo', () => {
  assert.match(html, /\.barra-empresa\s*\{[^}]*position:sticky/,
    'sem sticky, a barra sobe junto com a conversa e some');
  assert.match(html, /id="barraEmpresa"/);
  for (const id of ['beNome', 'beDoc', 'beAmbiente']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' precisa existir');
  }
});

test('produção muda a barra inteira de cor', () => {
  /* O aviso de produção era uma faixa separada, que dizia o ambiente e não
     dizia a empresa. Agora é a mesma barra: quem emite lê as duas coisas no
     mesmo lugar, sem cruzar informação. */
  assert.match(html, /\.barra-empresa\.producao/);
  assert.match(js, /classList\.toggle\('producao', e\.ambiente === 'producao'\)/);
  assert.ok(!/id="avisoProd"/.test(html), 'a faixa antiga saiu');
  assert.ok(!/avisoProd/.test(js), 'e ninguém ficou tentando escondê-la');
});

test('a barra é preenchida ao escolher a empresa', () => {
  const i = js.indexOf('function escolherEmpresa');
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /mostrarBarraEmpresa\(e\)/);
});

test('muitas empresas ganham busca em vez de parede de botões', () => {
  /* Trinta botões são piores do que nenhuma ajuda: a pessoa passa o olho, não
     acha, e clica no que parece. */
  assert.match(js, /function listarEmpresas/);
  const i = js.indexOf('function listarEmpresas');
  const corpo = js.slice(i, js.indexOf('\n  /* A barra fica na tela', i));
  assert.match(corpo, /aptas\.length > 6/, 'a busca aparece quando são muitas');
  assert.match(corpo, /nome_fantasia[\s\S]*razao_social[\s\S]*cnpj/,
    'o filtro olha nome fantasia, razão social e CNPJ');
  assert.match(corpo, /replace\(\/\[\^\\w\\sà-ú\]\/gi, ''\)/,
    'pontuação é ignorada dos dois lados — quem digita 99.990.003 acha o CNPJ');
});

test('a última nota da empresa volta inteira da rota', () => {
  const i = rota.indexOf('ultimaNota = {');
  assert.ok(i > 0, 'a rota precisa montar a última nota');
  const corpo = rota.slice(i, rota.indexOf('};', i));
  for (const campo of ['valor', 'servico', 'tomador', 'documentoTomador', 'nomeTomador']) {
    assert.match(corpo, new RegExp('\\b' + campo + ':'), campo + ' faz falta para repetir');
  }
  assert.match(rota, /<toma>\(\[\\s\\S\]\*\?\)<\\\/toma>/,
    'o documento do tomador sai do bloco <toma> da DPS');
});

test('sem tomador no cadastro, não oferece repetir', () => {
  /* Reconstruir endereço a partir do XML daria uma nota parecida, não a mesma —
     e "parecida" numa nota fiscal é erro. */
  const i = js.indexOf('function oferecerRepeticao');
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /!u\.tomador/);
  assert.match(corpo, /return perguntarTomador\(\)/);
});

test('repetir cai direto na conferência', () => {
  /* O ganho todo está aqui: dois toques até a tela de conferir, em vez de seis
     respostas. E ainda passa pela conferência — repetir não emite sozinho. */
  const i = js.indexOf('function repetirUltima');
  const corpo = js.slice(i, js.indexOf('\n  }', i));
  assert.match(corpo, /revisar\(\)/);
  assert.ok(!/emitir\(\)/.test(corpo), 'nada de emitir sem passar pela conferência');
});

test('depois de emitir, a empresa continua escolhida', () => {
  /* A próxima nota quase sempre é da mesma empresa. Voltar ao começo obrigaria
     a procurá-la de novo na lista, e a chance de pegar a errada nasce aí. */
  const i = js.indexOf('var empresaAtual = nota.empresa');
  assert.ok(i > 0, 'a empresa precisa ser guardada antes de limpar a conversa');
  const corpo = js.slice(i, i + 700);
  assert.match(corpo, /escolherEmpresa\(empresaAtual\)/);
  assert.match(corpo, /Trocar de empresa/, 'e trocar continua a um toque');
});

test('trocar de empresa limpa a nota em curso', () => {
  /* Meia nota da empresa A com a barra da empresa B seria o pior dos mundos. */
  const i = js.indexOf("el('beTrocar').onclick");
  const corpo = js.slice(i, js.indexOf('\n  };', i));
  assert.match(corpo, /nota = \{\}/);
  assert.match(corpo, /barraEmpresa'\)\.hidden = true/);
});
