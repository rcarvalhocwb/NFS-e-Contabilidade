const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Emissão direta pelo WhatsApp, e a nota voltando na conversa.
 *
 * As duas mudam o que acontece sem ninguém olhando, então as travas em volta
 * importam mais do que o recurso.
 */

function fonte(...partes) {
  return fs.readFileSync(path.join(__dirname, '..', ...partes), 'utf8');
}

/* ------------------------------------------------------- a emissão direta */

test('a escolha é por empresa, não global', () => {
  /* O cliente que emite a mesma nota há três anos não precisa de aprovação; o
     que entrou mês passado precisa. Uma chave global serve mal aos dois. */
  const sql = fonte('migrations', '032_whatsapp_direto.sql');
  assert.match(sql, /ALTER TABLE empresas[\s\S]{0,120}whatsapp_direto boolean NOT NULL DEFAULT FALSE/);

  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /AND e\.whatsapp_direto/,
    'a consulta do automático precisa filtrar pela empresa');
});

test('nasce desligada', () => {
  const sql = fonte('migrations', '032_whatsapp_direto.sql');
  assert.match(sql, /whatsapp_direto boolean NOT NULL DEFAULT FALSE/);
});

test('só WhatsApp emite direto — portal nunca', () => {
  /* Emitir sem ninguém olhar a partir de identidade que só a nuvem viu seria
     dar ao relay a capacidade de virar texto em documento fiscal assinado. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('const liberadas = await db.query');
  const corpo = ponte.slice(i, ponte.indexOf('\n  for (const s of liberadas', i));
  assert.match(corpo, /s\.origem = 'whatsapp'/);
  assert.ok(!/portal/i.test(corpo), 'portal não entra na fila automática');
});

test('acima do teto do número, ainda espera gente', () => {
  /* Enquanto tudo passava por um humano, o teto só marcava a solicitação. Com
     emissão direta é a única coisa entre um dedo escorregando no teclado e uma
     nota de R$ 250.000 com imposto. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('const liberadas = await db.query');
  const corpo = ponte.slice(i, ponte.indexOf('\n  for (const s of liberadas', i));
  assert.match(corpo, /s\.motivo IS NULL/,
    'pedido com motivo (acima do teto) fica de fora do automático');
});

test('a empresa bloqueada continua bloqueada', () => {
  /* Emissão direta não pode passar por cima da trava de liberação: sem ela o
     pedido nem chega a ficar aguardando. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  assert.match(ponte, /!e\.portal_liberado/);
  const i = ponte.indexOf('const liberadas = await db.query');
  const corpo = ponte.slice(i, ponte.indexOf('\n  for (const s of liberadas', i));
  assert.match(corpo, /situacao = 'aguardando'/,
    'só o que passou pela chegada entra no automático');
});

/* --------------------------------------------------------- os documentos */

test('a nota só sai daqui quando existe e o escritório quis', () => {
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('if (cfg.wa_envia_documentos');
  assert.ok(i > 0);
  const corpo = ponte.slice(i, ponte.indexOf('\n    }', i));
  assert.match(corpo, /s\.origem === 'whatsapp'/, 'só para quem pediu pelo WhatsApp');
  assert.match(corpo, /corpo\.situacao === 'emitida'/, 'só nota autorizada');
  assert.match(corpo, /s\.chave_acesso && s\.nfse_xml/, 'e só com o documento pronto');
});

test('PDF que não gera não segura o aviso', () => {
  /* Nota autorizada com PDF quebrado é problema para resolver, mas o cliente
     precisa saber que a nota saiu. */
  const ponte = fonte('src', 'services', 'ponteNuvem.js');
  const i = ponte.indexOf('não consegui gerar o PDF');
  assert.ok(i > 0);
  const antes = ponte.slice(i - 300, i);
  assert.match(antes, /catch \(e\)/, 'a falha do PDF é engolida, não propagada');
});

test('o XML vai como text/plain porque a Meta não aceita XML', () => {
  /* A lista de tipos de documento é fechada: texto, PDF e Office. O nome do
     arquivo continua dizendo o que é. */
  const meta = fonte('relay', 'meta.js');
  assert.match(meta, /xml: \{ mime: 'text\/plain', extensao: '\.xml' \}/);
  assert.match(meta, /XML NÃO está nela/);
});

test('o upload é em duas etapas, sem link público', () => {
  /* Mandar por link exigiria um endereço público para o documento fiscal —
     exatamente o que não se quer. */
  const meta = fonte('relay', 'meta.js');
  assert.match(meta, /\/media`/, 'sobe o arquivo');
  assert.match(meta, /document: \{ id: mediaId/, 'e manda pelo id');
  assert.ok(!/document: \{ link:/.test(meta), 'nunca por link');
});

test('o texto vai antes dos arquivos', () => {
  /* Se o upload falhar, a pessoa pelo menos soube que a nota foi autorizada e
     tem o link. Documento é conforto; saber que a nota existe, não. */
  const servidor = fonte('relay', 'servidor.js');
  const i = servidor.indexOf('async function avisarDesfecho');
  const corpo = servidor.slice(i, servidor.indexOf('\n}', i));
  const texto = corpo.indexOf('responderAoCliente');
  /* O envio do anexo passou a ser `transporte.enviarDocumento`: a Meta deixou
     de estar soldada aqui quando surgiu o segundo transporte. A ordem, que é o
     que este teste guarda, não mudou. */
  const anexo = corpo.indexOf('transporte.enviarDocumento');
  assert.ok(texto > 0 && anexo > 0, 'aviso e anexo precisam existir');
  assert.ok(texto < anexo, 'o aviso vem primeiro');
  assert.match(corpo, /if \(!entregue \|\| !docs\) return;/,
    'e sem o aviso entregue, nem tenta o anexo');
});

test('falhar um anexo não impede o outro', () => {
  /* A Meta pode recusar o XML pelo tipo. O PDF é o que importa.

     O try/catch mudou de casa junto com o envio: mora no adaptador, que é quem
     sabe falar com cada meio. A garantia é a mesma — falha de um anexo é
     registrada, nunca propagada — e agora vale para os dois transportes de uma
     vez, em vez de estar escrita duas. */
  const servidor = fonte('relay', 'servidor.js');
  const i = servidor.indexOf('for (const a of anexos)');
  const corpo = servidor.slice(i, servidor.indexOf('\n  }', i));
  assert.ok(!/throw/.test(corpo), 'o laço dos anexos não pode propagar falha');

  const t = fonte('relay', 'transporte.js');
  const j = t.indexOf('async function enviarDocumento');
  const envio = t.slice(j, t.indexOf('\n}', j));
  assert.match(envio, /try \{/);
  assert.match(envio, /catch \(e\)/);
  assert.match(envio, /return false;/, 'devolve o insucesso em vez de lançar');
  assert.ok(!/throw/.test(envio));
});

test('os arquivos não tocam o disco do repassador', () => {
  /* Chegam em base64, viram Buffer, sobem e somem. */
  const servidor = fonte('relay', 'servidor.js');
  const i = servidor.indexOf('async function avisarDesfecho');
  const corpo = servidor.slice(i, servidor.indexOf('\n}', i));
  assert.match(corpo, /Buffer\.from\(a\.conteudo, 'base64'\)/);
  assert.ok(!/writeFile|createWriteStream|fs\./.test(corpo),
    'nada é gravado em disco');
});

test('com documentos, o link vira segunda via', () => {
  /* Útil no dia em que a pessoa apagar a conversa. */
  const conv = fonte('relay', 'conversa.js');
  const i = conv.indexOf('function avisoDeDesfecho');
  const corpo = conv.slice(i, conv.indexOf('\n}', i));
  assert.match(corpo, /desfecho\.documentos/);
  assert.match(corpo, /Segunda via/);
  assert.match(corpo, /Mando o PDF e o XML aqui em seguida/);
});

test('sem documentos, o link continua sendo o caminho', () => {
  const conv = fonte('relay', 'conversa.js');
  const i = conv.indexOf('function avisoDeDesfecho');
  const corpo = conv.slice(i, conv.indexOf('\n}', i));
  assert.match(corpo, /PDF e XML em:/);
});

/* ------------------------------------------------ o que falta para funcionar */

test('o diagnóstico percorre a corrente na ordem em que ela quebra', () => {
  /* "Não funciona" tem umas quinze causas. Descobrir qual, um palpite por vez,
     custa uma tarde. */
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  for (const peca of ['Endereço do repassador', 'Chave da ponte',
                      'Phone number ID', 'Token da Meta',
                      'empresa', 'número de WhatsApp',
                      'Cadastro', 'Repassador respondendo']) {
    assert.ok(d.includes(peca), 'o diagnóstico precisa cobrir: ' + peca);
  }
});

test('cada falta vem com o que fazer, não só com o que falta', () => {
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  /* Cada chamada inteira, do `item('falta',` até o próximo `item(`.
     A regex não-gulosa que estava aqui parava no primeiro `))` e cortava o
     item antes do texto de orientação — acusava de não orientar justamente os
     itens mais bem escritos, que são os que ocupam várias linhas. */
  const faltas = [];
  const marcas = [...d.matchAll(/item\('falta',/g)].map(m => m.index);
  for (const i of marcas) {
    const proximo = d.indexOf("item('", i + 6);
    faltas.push(d.slice(i, proximo === -1 ? i + 600 : proximo));
  }
  assert.ok(faltas.length >= 6, 'esperava várias verificações');

  /* A propriedade, não o vocabulário.
     Este teste conferia uma lista de palavras ("Clique", "Ponha", "Invente") e
     virou armadilha: item novo escrito com outro verbo era acusado de não
     orientar quando orientava. O que se quer mesmo é estrutural — a assinatura
     é item(estado, o_que, detalhe, resolver), então basta perguntar se o
     quarto argumento existe. */
  const temResolver = chamada => {
    const abre = chamada.indexOf('(');
    let nivel = 0, virgulas = 0, aspas = null;
    for (let i = abre; i < chamada.length; i++) {
      const c = chamada[i];
      if (aspas) {
        if (c === '\\') i++;
        else if (c === aspas) aspas = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { aspas = c; continue; }
      if (c === '(' || c === '[' || c === '{') nivel++;
      else if (c === ')' || c === ']' || c === '}') { nivel--; if (nivel === 0) break; }
      else if (c === ',' && nivel === 1) virgulas++;
    }
    return virgulas >= 3;
  };
  const comSaida = faltas.filter(temResolver);

  /* Uma ou outra é auto-explicativa — o HTTP 500 do repassador não tem "onde
     resolver", tem "o servidor respondeu isso". */
  const semSaida = faltas.filter(f => !comSaida.includes(f));
  assert.ok(comSaida.length >= faltas.length - 2,
    'quase toda falta precisa dizer como resolver. Sem saída: ' +
    semSaida.map(f => f.slice(0, 80)).join(' | '));
});

test('o que o gateway não consegue ver é dito, não omitido', () => {
  /* Dar "tudo certo" quando não se conferiu tudo é pior do que não conferir. */
  const d = fonte('src', 'services', 'diagnosticoWhatsapp.js');
  assert.match(d, /naoConfiro/);
  assert.match(d, /Meta está entregando o webhook/);
  assert.match(d, /messages" foi assinado/);
});

test('o verificador de linha de comando cobre o que a tela não alcança', () => {
  /* O gateway não consegue provar que o webhook responde de fora nem que o
     token vale — as duas coisas precisam ser perguntadas de onde dá. */
  const c = fonte('relay', 'conferir.js');
  assert.match(c, /hub\.mode=subscribe/, 'refaz a verificação como a Meta faz');
  assert.match(c, /POST sem assinatura/, 'e confere que corpo sem assinatura é recusado');
  assert.match(c, /verified_name/, 'e pergunta à Meta se o número é dela');
});

test('token vencido tem mensagem própria', () => {
  /* É a causa mais comum de "parou de funcionar no dia seguinte": o token que
     aparece na tela da API dura 24 horas. */
  const c = fonte('relay', 'conferir.js');
  assert.match(c, /expired\|session has expired/);
  assert.match(c, /dura 24 horas/);
});
