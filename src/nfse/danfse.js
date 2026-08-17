/* Geração local do DANFSe (PDF) a partir do XML da NFS-e autorizada.
 *
 * Por que gerar localmente: a API oficial de DANFSe do ambiente nacional
 * (GET /danfse/{chave}) responde 501 — foi descontinuada. Depender dela
 * deixaria o gateway sem PDF. Com o XML autorizado em mãos temos todos os
 * dados necessários, então o documento é montado aqui.
 *
 * Este é um documento AUXILIAR: o que tem valor fiscal é o XML assinado.
 * O layout busca ser claro e conferível, não uma réplica pixel a pixel do
 * modelo oficial. */
const PDFDocument = require('pdfkit');

/* Extrator simples por nome de tag — evita trazer um parser XML só para isto.
   O XML da NFS-e é gerado pela Sefin, então a estrutura é previsível. */
function extrair(xml, tag, dentroDe) {
  let escopo = xml;
  if (dentroDe) {
    const m = xml.match(new RegExp(`<${dentroDe}>([\\s\\S]*?)</${dentroDe}>`));
    if (!m) return null;
    escopo = m[1];
  }
  const m = escopo.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function fmtDoc(d) {
  if (!d) return '';
  const s = String(d || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return s;
}
function fmtMoeda(v) {
  const n = Number(v || 0);
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const s = String(d || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === 11) return `(${s.slice(0,2)}) ${s.slice(2,7)}-${s.slice(7)}`;
  if (s.length === 10) return `(${s.slice(0,2)}) ${s.slice(2,6)}-${s.slice(6)}`;
  return s || '';
}
/* "2026-07-01" -> "07/2026" (a competência é mensal) */
function fmtCompetencia(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : (d || '-');
}

/* Lê do XML tudo que o DANFSe precisa. */
function dadosDoXml(xml) {
  const emit = (xml.match(/<emit>([\s\S]*?)<\/emit>/) || [])[1] || '';
  const toma = (xml.match(/<toma>([\s\S]*?)<\/toma>/) || [])[1] || '';
  const ender = (emit.match(/<enderNac>([\s\S]*?)<\/enderNac>/) || [])[1] || '';
  const endToma = (toma.match(/<end>([\s\S]*?)<\/end>/) || [])[1] || '';
  const g = (t, esc) => { const m = (esc || xml).match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? m[1] : null; };

  const idNfse = (xml.match(/<infNFSe[^>]*Id="NFS([^"]+)"/) || [])[1] || '';

  return {
    chave: idNfse,
    numero: g('nNFSe'),
    dhProc: g('dhProc'),
    cStat: g('cStat'),
    locEmi: g('xLocEmi'),
    locPrestacao: g('xLocPrestacao'),
    locIncid: g('xLocIncid'),
    descServico: g('xTribNac'),
    verAplic: g('verAplic'),
    ambiente: g('tpAmb'),
    emitente: {
      cnpj: g('CNPJ', emit),
      nome: g('xNome', emit),
      logradouro: g('xLgr', ender),
      numero: g('nro', ender),
      bairro: g('xBairro', ender),
      municipio: g('cMun', ender),
      uf: g('UF', ender),
      cep: g('CEP', ender),
      fone: g('fone', emit),
      email: g('email', emit)
    },
    tomador: {
      doc: g('CNPJ', toma) || g('CPF', toma),
      nome: g('xNome', toma),
      logradouro: g('xLgr', endToma),
      numero: g('nro', endToma),
      bairro: g('xBairro', endToma)
    },
    serie: g('serie'),
    nDPS: g('nDPS'),
    competencia: g('dCompet'),
    dhEmi: g('dhEmi'),
    cTribNac: g('cTribNac'),
    descDetalhada: g('xDescServ'),
    valorServico: g('vServ'),
    valorLiquido: g('vLiq'),
    pTotTribSN: g('pTotTribSN'),
    pAliq: g('pAliq'),
    tpRetISSQN: g('tpRetISSQN')
  };
}

/* Monta o PDF e devolve um Buffer. */
function gerarDanfse(xmlNfse) {
  return new Promise((resolve, reject) => {
    const d = dadosDoXml(xmlNfse);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 36, R = 559, W = R - L;
    let y = L;

    const linha = (yy) => { doc.moveTo(L, yy).lineTo(R, yy).strokeColor('#999').lineWidth(0.5).stroke(); };
    const caixaTitulo = (texto, yy) => {
      doc.rect(L, yy, W, 16).fillColor('#eeeeee').fill();
      doc.fillColor('#000').fontSize(8).font('Helvetica-Bold').text(texto, L + 5, yy + 4.5);
      return yy + 16;
    };
    const campo = (rotulo, valor, x, yy, largura) => {
      doc.fontSize(6.5).font('Helvetica').fillColor('#555').text(rotulo, x, yy, { width: largura });
      doc.fontSize(9).font('Helvetica').fillColor('#000')
         .text(valor || '-', x, yy + 8, { width: largura });
    };

    // Cabeçalho
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
       .text('NFS-e  Nota Fiscal de Serviço Eletrônica', L, y);
    y += 18;
    doc.fontSize(8).font('Helvetica').fillColor('#444')
       .text('Documento Auxiliar — o documento fiscal válido é o XML assinado.', L, y);
    y += 14;
    linha(y); y += 8;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000')
       .text(`Número ${d.numero || '-'}`, L, y);
    doc.fontSize(8).font('Helvetica')
       .text(`Emitida em ${fmtDataHora(d.dhProc)}   ·   Competência ${fmtCompetencia(d.competencia)}   ·   Série ${d.serie || '-'} / DPS ${d.nDPS || '-'}`,
             L, y + 13);
    if (d.ambiente === '2') {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#b42318')
         .text('AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL', L, y, { width: W, align: 'right' });
    }
    y += 30;

    doc.fontSize(6.5).font('Helvetica').fillColor('#555').text('CHAVE DE ACESSO', L, y);
    doc.fontSize(9).font('Courier-Bold').fillColor('#000').text(fmtChave(d.chave), L, y + 8);
    y += 26;

    // Prestador
    y = caixaTitulo('PRESTADOR DO SERVIÇO', y) + 4;
    campo('NOME / RAZÃO SOCIAL', d.emitente.nome, L + 4, y, 330);
    campo('CNPJ', fmtDoc(d.emitente.cnpj), L + 340, y, 180);
    y += 24;
    campo('ENDEREÇO',
      [d.emitente.logradouro, d.emitente.numero, d.emitente.bairro].filter(Boolean).join(', '),
      L + 4, y, 330);
    campo('MUNICÍPIO / UF', `${d.locEmi || ''} / ${d.emitente.uf || ''}`, L + 340, y, 180);
    y += 24;
    campo('TELEFONE', fmtTelefone(d.emitente.fone), L + 4, y, 160);
    campo('E-MAIL', d.emitente.email, L + 170, y, 350);
    y += 28;

    // Tomador
    y = caixaTitulo('TOMADOR DO SERVIÇO', y) + 4;
    campo('NOME / RAZÃO SOCIAL', d.tomador.nome, L + 4, y, 330);
    campo('CNPJ / CPF', fmtDoc(d.tomador.doc), L + 340, y, 180);
    y += 24;
    campo('ENDEREÇO',
      [d.tomador.logradouro, d.tomador.numero, d.tomador.bairro].filter(Boolean).join(', ') || '-',
      L + 4, y, 500);
    y += 28;

    // Serviço
    y = caixaTitulo('DISCRIMINAÇÃO DO SERVIÇO', y) + 4;
    campo('CÓDIGO DE TRIBUTAÇÃO NACIONAL', d.cTribNac, L + 4, y, 160);
    campo('LOCAL DA PRESTAÇÃO', d.locPrestacao, L + 170, y, 180);
    campo('MUNICÍPIO DE INCIDÊNCIA DO ISS', d.locIncid, L + 360, y, 180);
    y += 26;
    doc.fontSize(6.5).font('Helvetica').fillColor('#555').text('DESCRIÇÃO', L + 4, y);
    doc.fontSize(9).font('Helvetica').fillColor('#000')
       .text(d.descDetalhada || d.descServico || '-', L + 4, y + 9, { width: W - 8 });
    y += 9 + doc.heightOfString(d.descDetalhada || d.descServico || '-', { width: W - 8 }) + 12;

    // Valores
    y = caixaTitulo('VALORES', y) + 4;
    campo('VALOR DO SERVIÇO', fmtMoeda(d.valorServico), L + 4, y, 160);
    campo('ISS RETIDO', d.tpRetISSQN === '2' ? 'Sim' : 'Não', L + 170, y, 120);
    if (d.pTotTribSN) {
      campo('TRIBUTOS (SIMPLES NACIONAL)', d.pTotTribSN + ' %', L + 300, y, 200);
    } else if (d.pAliq) {
      campo('ALÍQUOTA ISS', d.pAliq + ' %', L + 300, y, 200);
    }
    y += 28;

    doc.rect(L, y, W, 26).fillColor('#f3f4f6').fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('VALOR LÍQUIDO', L + 6, y + 4);
    doc.fontSize(13).font('Helvetica-Bold')
       .text(fmtMoeda(d.valorLiquido || d.valorServico), L, y + 5, { width: W - 8, align: 'right' });
    y += 36;

    // Rodapé
    linha(y); y += 6;
    doc.fontSize(6.5).font('Helvetica').fillColor('#666')
       .text(`Processado por ${d.verAplic || 'Sefin Nacional'} · situação ${d.cStat || '-'} (100 = autorizada). ` +
             `Consulte a autenticidade em nfse.gov.br informando a chave de acesso. ` +
             `Documento gerado automaticamente.`, L, y, { width: W });

    doc.end();
  });
}

module.exports = { gerarDanfse, dadosDoXml };
