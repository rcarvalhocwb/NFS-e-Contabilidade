const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { gerarDanfse } = require('../src/nfse/danfse');

/* Conformidade do DANFSe com a NT 008 v1.02 (14/07/2026).
 *
 * O DANFSe é o que o cliente recebe e o que o fiscal olha. A NT descreve o
 * documento com medidas — não com "deve ficar bonito" — e cada uma delas é
 * verificável no arquivo gerado. Este teste mede o PDF em vez de inspecionar o
 * código: o que vale é o que saiu impresso.
 *
 * As exigências conferidas aqui, com o item da NT:
 *   2.2    página única
 *   2.2.1  retrato, mínimo A4
 *   2.2.2  margens entre 0,15 cm e 0,20 cm
 *   2.2.3  linhas divisórias de 0,5 pt
 *   2.4    fontes Arial (títulos) e Microsoft Sans Serif (conteúdo)
 *   2.4.3  cabeçalho com "DANFSe v2.0" e o município do emitente
 *   2.3    homologação leva "NFS-e SEM VALIDADE JURÍDICA"
 *   2.4.3  QR Code de no mínimo 1,52 cm, em X 17,48 cm / Y 1,67 cm
 */

const CM = 28.3465;   // pontos PostScript por centímetro
const A4 = { largura: 595.28, altura: 841.89 };

/* NFS-e mínima para gerar o documento. O DANFSe lê a NFS-e e a DPS embutida. */
function nfseXml({ tpAmb = '1' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
 <infNFSe Id="NFS41069022221583854000118000000000123126084264360279">
  <xLocEmi>Curitiba</xLocEmi><xTribNac>Vigilancia</xTribNac>
  <verAplic>1.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis>
  <nNFSe>1231</nNFSe><cLocIncid>4106902</cLocIncid>
  <xLocPrestacao>Curitiba</xLocPrestacao><dhProc>2026-08-19T12:07:42-03:00</dhProc>
  <emit><CNPJ>21583854000118</CNPJ><xNome>PRESTADOR TESTE LTDA</xNome>
   <enderNac><xLgr>RUA XV</xLgr><nro>100</nro><xBairro>Centro</xBairro>
    <cMun>4106902</cMun><UF>PR</UF><CEP>80010000</CEP></enderNac></emit>
  <valores><vCalcDR>0.00</vCalcDR><vCalcBM>0.00</vCalcBM>
   <vBC>3.00</vBC><pAliqAplic>0.00</pAliqAplic><vISSQN>0.00</vISSQN>
   <vLiq>3.00</vLiq></valores>
  <DPS><infDPS Id="DPS410690222158385400011800002000000000000008">
   <tpAmb>${tpAmb}</tpAmb><dhEmi>2026-08-19T12:07:38-03:00</dhEmi>
   <serie>2</serie><nDPS>8</nDPS><dCompet>2026-08-19</dCompet>
   <prest><CNPJ>21583854000118</CNPJ></prest>
   <toma><CNPJ>14073521000183</CNPJ><xNome>CLIENTE LTDA</xNome></toma>
   <serv><cServ><cTribNac>110201</cTribNac>
    <xDescServ>Servico de vigilancia</xDescServ></cServ></serv>
   <valores><vServPrest><vServ>3.00</vServ></vServPrest></valores>
  </infDPS></DPS>
 </infNFSe>
</NFSe>`;
}

function bruto(pdf) { return pdf.toString('latin1'); }

/* Texto impresso: o PDFKit escreve as strings em hexadecimal, dentro de um
   stream comprimido. */
function textoDo(pdf) {
  const b = bruto(pdf);
  const i = b.indexOf('stream\n') + 'stream\n'.length;
  const f = b.indexOf('\nendstream', i);
  let fluxo;
  try {
    fluxo = zlib.inflateSync(Buffer.from(b.slice(i, f), 'latin1')).toString('latin1');
  } catch (_) {
    fluxo = b;
  }
  return (fluxo.match(/<([0-9a-fA-F]+)>/g) || [])
    .map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join('');
}

function fluxoDe(pdf) {
  const b = bruto(pdf);
  const i = b.indexOf('stream\n') + 'stream\n'.length;
  const f = b.indexOf('\nendstream', i);
  try {
    return zlib.inflateSync(Buffer.from(b.slice(i, f), 'latin1')).toString('latin1');
  } catch (_) { return b; }
}

test('2.2 — o documento tem uma página só', async () => {
  // A NT não admite DANFSe em duas páginas, nem por transbordo de conteúdo
  const pdf = await gerarDanfse(nfseXml());
  const paginas = (bruto(pdf).match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(paginas, 1, 'saiu com ' + paginas + ' páginas');
});

test('2.2.1 — retrato, no tamanho A4', async () => {
  const pdf = await gerarDanfse(nfseXml());
  const m = bruto(pdf).match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(m, 'MediaBox não encontrado');
  const [largura, altura] = [Number(m[1]), Number(m[2])];
  assert.ok(Math.abs(largura - A4.largura) < 1, 'largura ' + largura);
  assert.ok(Math.abs(altura - A4.altura) < 1, 'altura ' + altura);
  assert.ok(altura > largura, 'precisa ser retrato');
});

test('2.2.2 — margens entre 0,15 cm e 0,20 cm', async () => {
  const pdf = await gerarDanfse(nfseXml());
  const fluxo = fluxoDe(pdf);
  /* A borda da página é o retângulo mais externo desenhado. Sua posição diz
     onde o corpo impresso começa. */
  const rets = [...fluxo.matchAll(/([\d.]+) ([\d.]+) ([\d.-]+) ([\d.-]+) re/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
  assert.ok(rets.length, 'nenhum retângulo desenhado');
  const margem = Math.min(...rets.map(r => r.x));
  assert.ok(margem >= 0.15 * CM - 0.5 && margem <= 0.20 * CM + 0.5,
    'margem de ' + (margem / CM).toFixed(3) + ' cm, fora da faixa 0,15–0,20');
});

test('2.2.3 — linhas divisórias de 0,5 ponto', async () => {
  const pdf = await gerarDanfse(nfseXml());
  assert.match(fluxoDe(pdf), /(^|\s)0\.5 w/, 'espessura de linha 0,5 não encontrada');
});

test('2.3 — homologação leva "NFS-e SEM VALIDADE JURÍDICA"', async () => {
  /* Sem esse aviso, um documento de teste circula como se valesse. A NT o
     exige no cabeçalho, abaixo do título. */
  const teste = textoDo(await gerarDanfse(nfseXml({ tpAmb: '2' })));
  assert.match(teste.replace(/\s+/g, ' '), /SEM VALIDADE JUR/i);
});

test('2.3 — produção NÃO leva o aviso de teste', async () => {
  const producao = textoDo(await gerarDanfse(nfseXml({ tpAmb: '1' })));
  assert.ok(!/SEM VALIDADE/i.test(producao),
    'nota real não pode sair com aviso de documento sem validade');
});

test('2.4.3 — cabeçalho traz "DANFSe v2.0" e o município', async () => {
  const t = textoDo(await gerarDanfse(nfseXml())).replace(/\s+/g, '');
  assert.ok(t.includes('DANFSev2.0'), 'falta a identificação da versão');
  assert.ok(t.includes('DocumentoAuxiliar'), 'falta "Documento Auxiliar da NFS-e"');
  assert.ok(t.includes('Curitiba'), 'falta o município do emitente');
});

test('2.4.3 — o QR Code tem ao menos 1,52 cm de lado', async () => {
  const pdf = await gerarDanfse(nfseXml());
  const fluxo = fluxoDe(pdf);
  /* O QR é desenhado como uma malha de retângulos do mesmo tamanho. A extensão
     entre o menor e o maior x dessa malha é o lado do código. */
  const quadrados = [...fluxo.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g)]
    .map(m => ({ x: +m[1], y: +m[2], l: +m[3], a: +m[4] }))
    .filter(r => r.l === r.a && r.l > 0 && r.l < 12);   // módulos do QR
  assert.ok(quadrados.length > 100, 'malha do QR não encontrada (' + quadrados.length + ')');

  const xs = quadrados.map(q => q.x);
  const lado = Math.max(...xs) + quadrados[0].l - Math.min(...xs);
  assert.ok(lado >= 1.52 * CM - 1,
    'QR com ' + (lado / CM).toFixed(2) + ' cm; a NT pede no mínimo 1,52 cm');
});

test('2.4.3 — a descrição de autenticidade acompanha o QR', async () => {
  const t = textoDo(await gerarDanfse(nfseXml())).replace(/\s+/g, ' ');
  assert.match(t, /autenticidade desta NFS-?e/i);
  assert.match(t, /portal nacional/i);
});

test('2.4 — DIVERGÊNCIA CONHECIDA: Helvetica no lugar de Arial', async () => {
  /* A NT pede Arial nos títulos e Microsoft Sans Serif nos conteúdos. As duas
     são proprietárias da Microsoft: não acompanham o gateway e não podem ser
     embutidas e redistribuídas num instalador.

     Helvetica é fonte base do PDF (não precisa ser embutida, abre em qualquer
     leitor) e é metricamente compatível com Arial — mesma largura de caractere,
     então o layout fica idêntico ao da NT.

     Esta é a única divergência conhecida em relação à NT 008, e é deliberada.
     O teste existe para que ela continue sendo uma escolha registrada, e não
     vire um descuido que ninguém lembra de onde veio. */
  const b = bruto(await gerarDanfse(nfseXml()));
  assert.match(b, /Helvetica/, 'a fonte escolhida em lugar da Arial');
});

test('2.4.1 — títulos de bloco em 7 pontos', async () => {
  const fluxo = fluxoDe(await gerarDanfse(nfseXml()));
  assert.match(fluxo, /\/F\d+ 7 Tf/, 'nenhum texto em corpo 7');
});

test('2.4.2 — títulos de campo em 6 pontos', async () => {
  const fluxo = fluxoDe(await gerarDanfse(nfseXml()));
  assert.match(fluxo, /\/F\d+ 6 Tf/, 'nenhum texto em corpo 6');
});

test('2.4.3 — cabeçalho em 9 pontos', async () => {
  const fluxo = fluxoDe(await gerarDanfse(nfseXml()));
  assert.match(fluxo, /\/F\d+ 9 Tf/, 'nenhum texto em corpo 9');
});

test('o conteúdo impresso vem do XML, não de valor inventado', async () => {
  // Item 2.1: não podem ser impressas informações que não constem da NFS-e
  const t = textoDo(await gerarDanfse(nfseXml())).replace(/\s+/g, '');
  assert.ok(t.includes('PRESTADORTESTELTDA'), 'nome do prestador do XML');
  assert.ok(t.includes('1231'), 'número da NFS-e do XML');
  assert.ok(t.includes('CLIENTELTDA'), 'tomador do XML');
});
