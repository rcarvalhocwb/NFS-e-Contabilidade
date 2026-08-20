/* Geração local do DANFSe (PDF) a partir do XML da NFS-e autorizada.
 *
 * Por que gerar localmente: a API de geração do DANFSe do ADN
 * (https://adn.nfse.gov.br/danfse/docs/index.html) foi SUSPENSA em 03/08/2026,
 * conforme a Nota Técnica SE/CGNFS-e nº 008/2026. Gerar o documento é agora
 * responsabilidade de cada emissor.
 *
 * O layout segue a NT 008 v1.02 (14/07/2026), "Especificações Técnicas do
 * DANFSe":
 *   - item 2.2.1  A4 retrato, uma única página (obrigatório);
 *   - item 2.2.2  margens de 0,15 cm a 0,20 cm;
 *   - item 2.2.3  linhas de 0,5 pt, borda da página de 1 pt, sombreado cinza 5%
 *                 no cabeçalho, nos títulos de bloco e nos campos "Emitente da
 *                 NFS-e" e "Valor Líquido";
 *   - item 2.4    títulos de bloco 7 pt negrito caixa alta, títulos de campo
 *                 6 pt negrito, conteúdo 7 pt;
 *   - item 2.4.3  QR Code apontando para a consulta pública, com o texto
 *                 complementar de três linhas abaixo dele;
 *   - item 2.5    marca d'água CANCELADA / SUBSTITUÍDA na diagonal.
 *
 * Desvios conscientes, por limitação de fontes e de dados:
 *
 *   1. A NT pede Arial (títulos) e Microsoft Sans Serif (conteúdo). Ambas são
 *      proprietárias e não acompanham o gateway. Usamos Helvetica, que é fonte
 *      base do PDF (nada a embutir) e metricamente compatível com Arial.
 *
 *   2. Os blocos "Destinatário", "Intermediário" e "Tributação IBS/CBS" não são
 *      impressos: pertencem ao leiaute 1.01 (Reforma Tributária) e a DPS que o
 *      gateway emite é 1.00, sem esses grupos. Não há dado a imprimir.
 *
 * Este é um documento AUXILIAR: o que tem valor fiscal é o XML assinado.
 */
const PDFDocument = require('pdfkit');
const qrcode = require('qrcode-generator');

/* Endereço da consulta pública, fixado pela NT 008 item 2.4.3. A chave de
   acesso entra logo após o sinal de igual. */
const URL_CONSULTA = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';

const TEXTO_QR =
  'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ' +
  'ou pela consulta da chave de acesso no portal nacional da NFS-e';

/* ------------------------------------------------------------------ leitura */

function dentro(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[2] : '';
}
function valor(xml, tag) {
  if (!xml) return null;
  const m = xml.match(new RegExp(`<${tag}(\\s[^>]*)?>([^<]*)</${tag}>`));
  return m ? m[2] : null;
}

function fmtDoc(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return s;
}
function fmtMoeda(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPerc(v) {
  if (v === null || v === undefined || v === '') return '';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';
}
function fmtDataHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('pt-BR');
}
function fmtChave(c) {
  return String(c || '').replace(/(.{4})/g, '$1 ').trim();
}
function fmtTelefone(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (s.length === 11) return `(${s.slice(0, 2)}) ${s.slice(2, 7)}-${s.slice(7)}`;
  if (s.length === 10) return `(${s.slice(0, 2)}) ${s.slice(2, 6)}-${s.slice(6)}`;
  return s;
}
function fmtCep(c) {
  const s = String(c || '').replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}
/* "2026-07-01" -> "07/2026": a competência é mensal. */
function fmtCompetencia(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : (d || '');
}

const AMB_GERADOR = { 1: 'Prefeitura', 2: 'Sistema Nacional NFS-e' };
const SIMPLES = { 1: 'Não optante', 2: 'Optante - MEI', 3: 'Optante - ME/EPP' };
const TRIB_ISSQN = { 1: 'Operação tributável', 2: 'Exportação de serviço',
                     3: 'Não incidência', 4: 'Imunidade' };
const RETENCAO = { 1: 'Não retido', 2: 'Retido pelo tomador', 3: 'Retido pelo intermediário' };

/* Lê do XML autorizado tudo que o DANFSe precisa. A NFS-e carrega a DPS
   original embutida, então prestador, tomador e serviço saem de lá. */
function dadosDoXml(xml) {
  const inf = dentro(xml, 'infNFSe');
  const emit = dentro(inf, 'emit');
  const enderEmit = dentro(emit, 'enderNac');
  const valoresNfse = dentro(inf, 'valores');

  const dps = dentro(inf, 'DPS');
  const infDps = dentro(dps, 'infDPS') || dentro(xml, 'infDPS');
  const prest = dentro(infDps, 'prest');
  const regTrib = dentro(prest, 'regTrib');
  const toma = dentro(infDps, 'toma');
  const endToma = dentro(toma, 'end');
  const endNacToma = dentro(endToma, 'endNac');
  const serv = dentro(infDps, 'serv');
  const cServ = dentro(serv, 'cServ');
  const valoresDps = dentro(infDps, 'valores');
  const trib = dentro(valoresDps, 'trib');
  const tribMun = dentro(trib, 'tribMun');
  const totTrib = dentro(trib, 'totTrib');
  const pTotTrib = dentro(totTrib, 'pTotTrib');
  const subst = dentro(infDps, 'subst');

  return {
    chave: (xml.match(/<infNFSe[^>]*Id="NFS([^"]+)"/) || [])[1] || '',
    numero: valor(inf, 'nNFSe'),
    dhProc: valor(inf, 'dhProc'),
    cStat: valor(inf, 'cStat'),
    ambGer: valor(inf, 'ambGer'),
    tpAmb: valor(infDps, 'tpAmb'),
    verAplic: valor(inf, 'verAplic'),
    locEmi: valor(inf, 'xLocEmi'),
    locPrestacao: valor(inf, 'xLocPrestacao'),
    locIncid: valor(inf, 'xLocIncid') || valor(inf, 'xLocEmi'),
    descTribNac: valor(inf, 'xTribNac'),
    descTribMun: valor(inf, 'xTribMun'),
    descNBS: valor(inf, 'xNBS'),
    substituiu: valor(subst, 'chSubstda'),

    emitente: {
      cnpj: valor(emit, 'CNPJ') || valor(emit, 'CPF'),
      im: valor(emit, 'IM'),
      nome: valor(emit, 'xNome'),
      logradouro: valor(emit, 'xLgr'),
      numero: valor(emit, 'nro'),
      complemento: valor(emit, 'xCpl'),
      bairro: valor(emit, 'xBairro'),
      cMun: valor(enderEmit, 'cMun'),
      uf: valor(enderEmit, 'UF'),
      cep: valor(enderEmit, 'CEP'),
      fone: valor(emit, 'fone'),
      email: valor(emit, 'email'),
      opSimpNac: valor(regTrib, 'opSimpNac'),
      regApTribSN: valor(regTrib, 'regApTribSN')
    },
    tomador: {
      doc: valor(toma, 'CNPJ') || valor(toma, 'CPF') || valor(toma, 'NIF'),
      im: valor(toma, 'IM'),
      nome: valor(toma, 'xNome'),
      logradouro: valor(endToma, 'xLgr'),
      numero: valor(endToma, 'nro'),
      complemento: valor(endToma, 'xCpl'),
      bairro: valor(endToma, 'xBairro'),
      cMun: valor(endNacToma, 'cMun'),
      cep: valor(endNacToma, 'CEP'),
      fone: valor(toma, 'fone'),
      email: valor(toma, 'email')
    },
    serie: valor(infDps, 'serie'),
    nDPS: valor(infDps, 'nDPS'),
    dhEmiDps: valor(infDps, 'dhEmi'),
    competencia: valor(infDps, 'dCompet'),
    cTribNac: valor(cServ, 'cTribNac'),
    cTribMun: valor(cServ, 'cTribMun'),
    cNBS: valor(cServ, 'cNBS'),
    descServico: valor(cServ, 'xDescServ'),

    tribISSQN: valor(tribMun, 'tribISSQN'),
    pAliq: valor(tribMun, 'pAliq'),
    tpRetISSQN: valor(tribMun, 'tpRetISSQN'),
    pTotTribSN: valor(totTrib, 'pTotTribSN'),
    pTotTribFed: valor(pTotTrib, 'pTotTribFed'),
    pTotTribEst: valor(pTotTrib, 'pTotTribEst'),
    pTotTribMun: valor(pTotTrib, 'pTotTribMun'),
    indTotTrib: valor(totTrib, 'indTotTrib'),

    valorServico: valor(dentro(valoresDps, 'vServPrest'), 'vServ'),
    descIncond: valor(dentro(valoresDps, 'vDescCondIncond'), 'vDescIncond'),
    descCond: valor(dentro(valoresDps, 'vDescCondIncond'), 'vDescCond'),
    vBC: valor(valoresNfse, 'vBC'),
    pAliqAplic: valor(valoresNfse, 'pAliqAplic'),
    vISSQN: valor(valoresNfse, 'vISSQN'),
    vTotalRet: valor(valoresNfse, 'vTotalRet'),
    vLiq: valor(valoresNfse, 'vLiq'),
    xOutInf: valor(valoresNfse, 'xOutInf')
  };
}

/* --------------------------------------------------------------- desenho */

const CINZA_BLOCO = '#F2F2F2';   // 5% de densidade (item 2.2.3)
const CINZA_MARCA = '#A6A6A6';   // K35 da marca d'água (item 2.5)
const CM = 28.3465;              // pontos por centímetro

/* Desenha o QR Code módulo a módulo. Evita gerar PNG e embutir imagem: menos
   dependência e nada de reamostragem borrando o código na impressão. */
function desenharQr(doc, texto, x, y, lado) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const passo = lado / n;
  doc.save().fillColor('#000');
  for (let linha = 0; linha < n; linha++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(linha, col)) {
        // +0.02 fecha a fresta entre módulos que alguns renderizadores mostram
        doc.rect(x + col * passo, y + linha * passo, passo + 0.02, passo + 0.02).fill();
      }
    }
  }
  doc.restore();
}

function gerarDanfse(xmlNfse, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const d = dadosDoXml(xmlNfse);

    // Margem de 0,175 cm, dentro da faixa de 0,15 a 0,20 cm da NT (item 2.2.2).
    const margem = 0.175 * CM;
    const doc = new PDFDocument({ size: 'A4', margin: margem, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: 'A4', margin: margem });

    const L = margem, R = doc.page.width - margem, W = R - L;
    let y = margem;

    /* --- primitivas ------------------------------------------------------ */
    const linhaH = (yy, x1 = L, x2 = R) => {
      doc.moveTo(x1, yy).lineTo(x2, yy).lineWidth(0.5).strokeColor('#000').stroke();
    };
    const linhaV = (yy, altura, x) => {
      doc.moveTo(x, yy).lineTo(x, yy + altura).lineWidth(0.5).strokeColor('#000').stroke();
    };
    /* Título de bloco: 7 pt, negrito, caixa alta, fundo cinza 5% (item 2.4.1). */
    const tituloBloco = (texto, yy, altura = 11, largura = W) => {
      doc.rect(L, yy, largura, altura).fillColor(CINZA_BLOCO).fill();
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(7)
         .text(String(texto).toUpperCase(), L + 3, yy + 3, { width: largura - 6, lineBreak: false });
      linhaH(yy, L, L + largura); linhaH(yy + altura, L, L + largura);
      return yy + altura;
    };
    /* Campo: label 6 pt negrito (item 2.4.2) e conteúdo 7 pt (item 2.4.4). */
    const campo = (rotulo, conteudo, x, yy, largura, opts = {}) => {
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
         .text(rotulo, x + 3, yy + 2, { width: largura - 6, lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#000')
         .text(conteudo == null || conteudo === '' ? '' : String(conteudo),
               x + 3, yy + 10, { width: largura - 6, lineBreak: false, ...opts });
    };
    /* Linha de campos em colunas proporcionais. */
    const linhaCampos = (yy, colunas, altura = 19) => {
      let x = L;
      colunas.forEach((c, i) => {
        const largura = W * c.w;
        campo(c.r, c.v, x, yy, largura, c.opts);
        if (i > 0) linhaV(yy, altura, x);
        x += largura;
      });
      linhaH(yy + altura);
      return yy + altura;
    };

    /* --- cabeçalho (item 2.4.3) ------------------------------------------ */
    const altCabecalho = 34;
    doc.rect(L, y, W, altCabecalho).fillColor(CINZA_BLOCO).fill();

    // A logomarca oficial é um PNG distribuído à parte; sem o arquivo, o nome
    // do sistema ocupa o canto esquerdo previsto na NT.
    doc.fillColor('#0b5ea8').font('Helvetica-Bold').fontSize(15).text('NFS-e', L + 6, y + 7);
    doc.fillColor('#333').font('Helvetica').fontSize(5.5)
       .text('Nota Fiscal de\nServiço Eletrônica', L + 6, y + 22, { lineGap: -1 });

    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9)
       .text('DANFSe v2.0', L, y + 5, { width: W, align: 'center' })
       .text('Documento Auxiliar da NFS-e', L, y + 15, { width: W, align: 'center' });

    // Só em homologação, e com este texto exato (item 2.4.3, observação).
    if (d.tpAmb === '2') {
      doc.fillColor('#e30613').font('Helvetica-Bold').fontSize(9)
         .text('NFS-e SEM VALIDADE JURÍDICA', L, y + 24, { width: W, align: 'center' });
    }

    const xDir = L + W * 0.68;
    doc.fillColor('#000').font('Helvetica').fontSize(8)
       .text('Município: ' + (d.locEmi || ''), xDir, y + 4, { width: W * 0.32 - 60, lineBreak: false });
    doc.fontSize(6)
       .text('Ambiente Gerador: ' + (AMB_GERADOR[d.ambGer] || d.ambGer || ''), xDir, y + 15,
             { width: W * 0.32 - 60, lineBreak: false })
       .text('Tipo de Ambiente: ' + (d.tpAmb === '2' ? 'Homologação' : 'Produção'), xDir, y + 23,
             { width: W * 0.32 - 60, lineBreak: false });
    linhaH(y); linhaH(y + altCabecalho);
    y += altCabecalho;

    /* --- chave de acesso -------------------------------------------------- */
    // Coordenadas da NT (item 2.4.3): QR em X 17,48 cm / Y 1,67 cm, lado mínimo
    // 1,52 cm. O símbolo é desenhado no fim, depois de todas as linhas: elas
    // atravessavam o código e o deixavam ilegível pelo leitor.
    const qrLado = 1.52 * CM;
    const qrX = 17.48 * CM;
    const qrY = 1.67 * CM;
    const larguraEsq = qrX - L - 8;   // os campos param antes da coluna do QR

    y = tituloBloco('Chave de Acesso da NFS-e', y, 10, larguraEsq);
    doc.font('Helvetica').fontSize(8).fillColor('#000')
       .text(fmtChave(d.chave), L + 3, y + 3, { width: larguraEsq - 6, lineBreak: false });
    y += 13; linhaH(y, L, L + larguraEsq);

    /* --- identificação (item 2.1.2) — labels em 7 pt caixa alta ---------- */
    const campoIdent = (rotulo, conteudo, x, yy, largura) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#000')
         .text(rotulo.toUpperCase(), x + 3, yy + 2, { width: largura - 6, lineBreak: false });
      doc.font('Helvetica').fontSize(7)
         .text(conteudo == null ? '' : String(conteudo), x + 3, yy + 11,
               { width: largura - 6, lineBreak: false });
    };
    const linhaIdent = (yy, colunas, altura = 20) => {
      let x = L;
      colunas.forEach((c, i) => {
        const largura = larguraEsq * c.w;
        campoIdent(c.r, c.v, x, yy, largura);
        if (i > 0) linhaV(yy, altura, x);
        x += largura;
      });
      linhaH(yy + altura, L, L + larguraEsq);
      return yy + altura;
    };
    y = linhaIdent(y, [
      { r: 'Número da NFS-e', v: d.numero, w: 0.34 },
      { r: 'Competência da NFS-e', v: fmtCompetencia(d.competencia), w: 0.33 },
      { r: 'Data e Hora da Emissão da NFS-e', v: fmtDataHora(d.dhProc), w: 0.33 }
    ]);
    y = linhaIdent(y, [
      { r: 'Número da DPS', v: d.nDPS, w: 0.34 },
      { r: 'Série da DPS', v: d.serie, w: 0.33 },
      { r: 'Data e Hora da Emissão da DPS', v: fmtDataHora(d.dhEmiDps), w: 0.33 }
    ]);
    // "Emitente da NFS-e" tem sombreado próprio (item 2.2.3).
    doc.rect(L, y, larguraEsq * 0.34, 20).fillColor(CINZA_BLOCO).fill();
    y = linhaIdent(y, [
      { r: 'Emitente da NFS-e', v: AMB_GERADOR[d.ambGer] || '', w: 0.34 },
      { r: 'Situação da NFS-e', v: opcoes.situacao || (d.cStat === '100' ? 'Autorizada' : d.cStat), w: 0.33 },
      { r: 'Finalidade', v: d.substituiu ? 'Substituição de NFS-e' : 'Normal', w: 0.33 }
    ]);
    linhaH(y);
    // A coluna do QR fica reservada: o texto complementar dele desce até aqui,
    // e o bloco seguinte não pode começar por cima.
    y = Math.max(y, qrY + qrLado + 30);
    linhaH(y);

    /* --- prestador (item 2.1.3) ------------------------------------------ */
    y = tituloBloco('Prestador / Fornecedor', y);
    y = linhaCampos(y, [
      { r: 'Nome / Nome Empresarial', v: d.emitente.nome, w: 0.42 },
      { r: 'CNPJ / CPF / NIF', v: fmtDoc(d.emitente.cnpj), w: 0.20 },
      { r: 'Indicador Municipal (Inscrição)', v: d.emitente.im, w: 0.20 },
      { r: 'Telefone', v: fmtTelefone(d.emitente.fone), w: 0.18 }
    ]);
    y = linhaCampos(y, [
      { r: 'Endereço', v: [d.emitente.logradouro, d.emitente.numero, d.emitente.complemento,
                           d.emitente.bairro].filter(Boolean).join(', '), w: 0.42 },
      { r: 'Município / Sigla UF', v: [d.locEmi, d.emitente.uf].filter(Boolean).join(' / '), w: 0.20 },
      { r: 'Código IBGE / CEP', v: [d.emitente.cMun, fmtCep(d.emitente.cep)].filter(Boolean).join(' / '), w: 0.20 },
      { r: 'E-mail', v: d.emitente.email, w: 0.18 }
    ]);
    y = linhaCampos(y, [
      { r: 'Simples Nacional na Data de Competência', v: SIMPLES[d.emitente.opSimpNac] || '', w: 0.42 },
      { r: 'Regime de Apuração Tributária pelo SN', v: d.emitente.regApTribSN || '', w: 0.58 }
    ], 17);

    /* --- tomador (item 2.1.4) -------------------------------------------- */
    y = tituloBloco('Tomador / Adquirente da Operação', y);
    if (!d.tomador.doc && !d.tomador.nome) {
      // Supressão prevista no item 2.3.1, com o texto que a NT determina.
      doc.font('Helvetica').fontSize(7).fillColor('#000')
         .text('TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', L + 3, y + 4,
               { width: W - 6, lineBreak: false });
      y += 15; linhaH(y);
    } else {
      y = linhaCampos(y, [
        { r: 'Nome / Nome Empresarial', v: d.tomador.nome, w: 0.42 },
        { r: 'CNPJ / CPF / NIF', v: fmtDoc(d.tomador.doc), w: 0.20 },
        { r: 'Indicador Municipal (Inscrição)', v: d.tomador.im, w: 0.20 },
        { r: 'Telefone', v: fmtTelefone(d.tomador.fone), w: 0.18 }
      ]);
      y = linhaCampos(y, [
        { r: 'Endereço', v: [d.tomador.logradouro, d.tomador.numero, d.tomador.complemento,
                             d.tomador.bairro].filter(Boolean).join(', '), w: 0.42 },
        // A DPS do tomador carrega só o código IBGE do município, não o nome.
        { r: 'Município / Sigla UF', v: '', w: 0.20 },
        { r: 'Código IBGE / CEP', v: [d.tomador.cMun, fmtCep(d.tomador.cep)].filter(Boolean).join(' / '), w: 0.20 },
        { r: 'E-mail', v: d.tomador.email, w: 0.18 }
      ]);
    }

    /* --- serviço (item 2.1.7) -------------------------------------------- */
    y = tituloBloco('Serviço Prestado', y);
    y = linhaCampos(y, [
      { r: 'Código de Tributação Nacional / Municipal',
        v: [d.cTribNac, d.cTribMun].filter(Boolean).join(' / '), w: 0.34 },
      { r: 'Código da NBS', v: d.cNBS || '', w: 0.33 },
      { r: 'Local da Prestação / Sigla UF / País', v: d.locPrestacao || '', w: 0.33 }
    ]);
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
       .text('Descrição do Código de Tributação Nacional / Municipal', L + 3, y + 2,
             { width: W - 6, lineBreak: false });
    doc.font('Helvetica').fontSize(7)
       .text([d.descTribNac, d.descTribMun].filter(Boolean).join(' / '), L + 3, y + 10,
             { width: W - 6, height: 9, ellipsis: true, lineBreak: false });
    y += 20; linhaH(y);

    // A descrição do serviço tem altura fixa: a NT exige página única, então o
    // texto é recortado aqui em vez de empurrar o documento para uma segunda
    // folha. O conteúdo íntegro está no XML, que é o documento fiscal.
    // Alturas calculadas para a página fechar cheia, como no modelo do Anexo I.
    // O que sobra depois dos blocos de altura fixa vai para a descrição do
    // serviço e as informações complementares — os dois que a NT manda
    // aumentar quando há espaço (itens 2.3.1 e 2.3.3).
    const alturaFixaRestante = 11 + 19 * 2 + 17   // tributação municipal
                             + 11 + 19 + 22       // valor total
                             + 11 + 14;           // título das complementares + rodapé
    const ALT_DESC_MIN = 66, ALT_COMPL_MIN = 46;
    const sobra = Math.max(0,
      (doc.page.height - margem) - y - alturaFixaRestante - ALT_DESC_MIN - ALT_COMPL_MIN);
    const alturaDesc = ALT_DESC_MIN + Math.round(sobra * 0.55);
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
       .text('Descrição do Serviço', L + 3, y + 2, { width: W - 6, lineBreak: false });
    doc.font('Helvetica').fontSize(7)
       .text(d.descServico || '', L + 3, y + 11,
             { width: W - 6, height: alturaDesc - 14, ellipsis: true });
    y += alturaDesc; linhaH(y);

    /* --- tributação municipal (item 2.1.8) -------------------------------- */
    y = tituloBloco('Tributação Municipal (ISSQN)', y);
    y = linhaCampos(y, [
      { r: 'Tipo de Tributação do ISSQN', v: TRIB_ISSQN[d.tribISSQN] || '', w: 0.34 },
      { r: 'Município / Sigla UF / País de Incidência do ISSQN', v: d.locIncid || '', w: 0.33 },
      { r: 'Total Deduções/Reduções', v: d.vCalcDR ? 'R$ ' + fmtMoeda(d.vCalcDR) : '', w: 0.33 }
    ]);
    y = linhaCampos(y, [
      { r: 'Desconto Incondicionado', v: d.descIncond ? 'R$ ' + fmtMoeda(d.descIncond) : '', w: 0.25 },
      { r: 'BC ISSQN', v: d.vBC ? 'R$ ' + fmtMoeda(d.vBC) : '', w: 0.25 },
      { r: 'Alíquota Aplicada', v: fmtPerc(d.pAliqAplic || d.pAliq), w: 0.25 },
      { r: 'Retenção do ISSQN', v: RETENCAO[d.tpRetISSQN] || '', w: 0.25 }
    ]);
    y = linhaCampos(y, [
      { r: 'ISSQN Apurado', v: d.vISSQN ? 'R$ ' + fmtMoeda(d.vISSQN) : '', w: 0.50 },
      { r: 'Total das Retenções (ISSQN / Federais)',
        v: d.vTotalRet ? 'R$ ' + fmtMoeda(d.vTotalRet) : '', w: 0.50 }
    ], 17);

    /* --- valor total (item 2.1.11) --------------------------------------- */
    y = tituloBloco('Valor Total da NFS-e', y);
    y = linhaCampos(y, [
      { r: 'Valor da Operação / Serviço', v: 'R$ ' + fmtMoeda(d.valorServico), w: 0.34 },
      { r: 'Desconto Incondicionado', v: 'R$ ' + fmtMoeda(d.descIncond || 0), w: 0.33 },
      { r: 'Desconto Condicionado', v: 'R$ ' + fmtMoeda(d.descCond || 0), w: 0.33 }
    ]);
    // "Valor Líquido" leva sombreado próprio (item 2.2.3).
    const alturaLiq = 22;
    doc.rect(L + W * 0.67, y, W * 0.33, alturaLiq).fillColor(CINZA_BLOCO).fill();
    let xLiq = L;
    [{ r: 'Total das Retenções (ISSQN / Federais)', v: 'R$ ' + fmtMoeda(d.vTotalRet || 0), w: 0.34 },
     { r: 'Total do IBS/CBS', v: '', w: 0.33 },
     { r: 'Valor Líquido da NFS-e', v: 'R$ ' + fmtMoeda(d.vLiq || d.valorServico), w: 0.33 }
    ].forEach((c, i) => {
      const largura = W * c.w;
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
         .text(c.r, xLiq + 3, y + 3, { width: largura - 6, lineBreak: false });
      doc.font(i === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 2 ? 10 : 7)
         .text(c.v, xLiq + 3, y + 11, { width: largura - 6, lineBreak: false });
      if (i > 0) linhaV(y, alturaLiq, xLiq);
      xLiq += largura;
    });
    y += alturaLiq; linhaH(y);

    /* --- informações complementares (item 2.1.12) ------------------------- */
    y = tituloBloco('Informações Complementares', y);
    const complementares = [];
    if (d.substituiu) complementares.push('Substitui a NFS-e de chave ' + fmtChave(d.substituiu) + '.');
    if (d.xOutInf) complementares.push(d.xOutInf);
    // Totais aproximados dos tributos — Lei 12.741/2012.
    if (d.pTotTribSN) {
      complementares.push('Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: ' +
        fmtPerc(d.pTotTribSN) + ' (Simples Nacional).');
    } else if (d.pTotTribFed || d.pTotTribEst || d.pTotTribMun) {
      complementares.push('Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ' +
        fmtPerc(d.pTotTribFed || 0) + '; Estaduais: ' + fmtPerc(d.pTotTribEst || 0) +
        '; Municipais: ' + fmtPerc(d.pTotTribMun || 0) + '.');
    } else if (d.indTotTrib === '0') {
      complementares.push('Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: ' +
        'sem informação de tributos declarada na DPS.');
    }
    // O restante da sobra: a soma das duas fatias tem de fechar em `sobra`,
    // senão o documento passa para uma segunda página — que a NT proíbe.
    const alturaCompl = ALT_COMPL_MIN + (sobra - Math.round(sobra * 0.55));
    doc.font('Helvetica').fontSize(6.5).fillColor('#000')
       .text(complementares.join('\n') || '—', L + 3, y + 3,
             { width: W - 6, height: alturaCompl - 6, ellipsis: true });
    y += alturaCompl; linhaH(y);

    /* --- rodapé ----------------------------------------------------------- */
    doc.font('Helvetica').fontSize(5.5).fillColor('#444')
       .text('Documento auxiliar — o documento fiscal é o XML assinado. ' +
             'Gerado conforme a Nota Técnica SE/CGNFS-e nº 008. ' +
             'Aplicativo: ' + (d.verAplic || '—') + '.',
             L + 3, y + 3, { width: W - 6, lineBreak: false });

    /* --- borda da página (item 2.2.3): 1 pt ------------------------------- */
    doc.rect(L, margem, W, doc.page.height - margem * 2).lineWidth(1).strokeColor('#000').stroke();

    /* --- QR Code, por último (item 2.4.3) --------------------------------- */
    // A zona de silêncio (4 módulos de margem branca) é parte da especificação
    // do QR: sem ela o leitor não encontra o símbolo. Aqui ela também apaga
    // qualquer linha de bloco que tenha passado por baixo.
    const silencio = qrLado / 41 * 4;
    doc.save().fillColor('#fff')
       .rect(qrX - silencio, qrY - silencio, qrLado + silencio * 2, qrLado + silencio * 2).fill()
       .restore();
    desenharQr(doc, URL_CONSULTA + d.chave, qrX, qrY, qrLado);
    const yTexto = qrY + qrLado + silencio;
    doc.save().fillColor('#fff').rect(qrX - 10, yTexto, R - qrX + 10, 26).fill().restore();
    doc.font('Helvetica').fontSize(5.5).fillColor('#000')
       .text(TEXTO_QR, qrX - 9, yTexto + 1,
             { width: R - qrX + 8, align: 'left', lineGap: -0.8, height: 24, ellipsis: false });

    /* --- marca d'água (item 2.5) ------------------------------------------ */
    const marca = opcoes.marcaDagua ||
      (opcoes.situacao === 'Cancelada' ? 'CANCELADA' : null);
    if (marca) {
      doc.save();
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica').fontSize(70).fillColor(CINZA_MARCA)
         .text(marca, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
      doc.restore();
    }

    doc.end();
  });
}

module.exports = { gerarDanfse, dadosDoXml, URL_CONSULTA };
