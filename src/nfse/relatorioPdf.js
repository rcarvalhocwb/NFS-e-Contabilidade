/* Relatório de fechamento em PDF, com a marca do escritório.
 *
 * É o que se manda ao cliente no fim do mês. Com a marca da casa vira
 * entregável; sem ela, parece saída de sistema — e o escritório acaba copiando
 * os números para um documento próprio, que é onde o erro de transcrição entra.
 *
 * A marca aqui é a do ESCRITÓRIO, e isso é correto: este documento é dele. O
 * DANFSe é outra história — lá o emitente é a empresa prestadora, e a logo da
 * contabilidade sugeriria que foi ela quem emitiu a nota.
 */
const PDFDocument = require('pdfkit');

const CINZA = '#5b6472';
const CINZA_CLARO = '#e3e6ea';
const TINTA = '#1b2027';

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2,
                                                  maximumFractionDigits: 2 });
}
function dataBR(iso) {
  return iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
}

/**
 * @param dados      resposta de GET /relatorios/fechamento
 * @param identidade { nome, descricao, cor_acento, rodape, site, telefone, email }
 * @param logo       { conteudo, tipo } ou null
 */
function gerarFechamentoPdf(dados, identidade = {}, logo = null, opcoes = {}) {
  return new Promise((resolve, reject) => {
    // `comprimir: false` deixa o texto legível dentro do arquivo — é como o
    // teste confere o que saiu impresso, sem depender de um leitor de PDF.
    const doc = new PDFDocument({ size: 'A4', margin: 42,
                                  compress: opcoes.comprimir !== false });
    const partes = [];
    doc.on('data', p => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const acento = identidade.cor_acento || '#1e3a5f';
    const larguraUtil = doc.page.width - 84;

    /* ---------------------------------------------------- cabeçalho */
    let y = 42;
    if (logo && logo.conteudo) {
      try {
        // fit mantém a proporção: logo esticada é pior que logo pequena
        doc.image(logo.conteudo, 42, y, { fit: [130, 44] });
      } catch (_) { /* imagem ilegível não derruba o relatório */ }
    }

    const xTexto = logo && logo.conteudo ? 186 : 42;
    doc.font('Helvetica-Bold').fontSize(15).fillColor(TINTA)
       .text(identidade.nome || 'Fechamento do período', xTexto, y + 2);
    if (identidade.descricao) {
      doc.font('Helvetica').fontSize(8.5).fillColor(CINZA)
         .text(identidade.descricao, xTexto, doc.y + 1);
    }

    doc.font('Helvetica-Bold').fontSize(11).fillColor(acento)
       .text('Fechamento de ' + dataBR(dados.periodo.inicio) + ' a ' + dataBR(dados.periodo.fim),
             xTexto, doc.y + 6);

    y = Math.max(doc.y + 12, 100);
    doc.moveTo(42, y).lineTo(42 + larguraUtil, y).lineWidth(1.6).strokeColor(acento).stroke();
    y += 18;

    /* ---------------------------------------------------- totais */
    const t = dados.totais || {};
    const cartoes = [
      ['Notas autorizadas', String(t.notas || 0)],
      ['Valor dos serviços', 'R$ ' + moeda(t.valorServico)],
      ['ISS', 'R$ ' + moeda(t.valorIss)],
      ['Retenções federais', 'R$ ' + moeda(t.retencoesFederais)]
    ];
    const largura = larguraUtil / cartoes.length;
    cartoes.forEach(([rotulo, valor], i) => {
      const x = 42 + i * largura;
      doc.font('Helvetica').fontSize(7.5).fillColor(CINZA)
         .text(rotulo.toUpperCase(), x, y, { width: largura - 8, characterSpacing: 0.4 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(TINTA)
         .text(valor, x, y + 11, { width: largura - 8 });
    });
    y += 42;

    /* ---------------------------------------------------- por empresa */
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TINTA).text('Por empresa', 42, y);
    y += 15;

    const colunas = [
      { t: 'Empresa',  x: 42,  l: 150, a: 'left' },
      { t: 'Notas',    x: 196, l: 34,  a: 'right' },
      { t: 'Serviços', x: 234, l: 76,  a: 'right' },
      { t: 'Base',     x: 314, l: 76,  a: 'right' },
      { t: 'ISS',      x: 394, l: 62,  a: 'right' },
      { t: 'Retido',   x: 460, l: 43,  a: 'right' },
      { t: 'Fed.',     x: 507, l: 46,  a: 'right' }
    ];

    const cabecalhoTabela = () => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(CINZA);
      colunas.forEach(c => doc.text(c.t.toUpperCase(), c.x, y, { width: c.l, align: c.a }));
      y += 11;
      doc.moveTo(42, y).lineTo(42 + larguraUtil, y).lineWidth(0.6).strokeColor(CINZA_CLARO).stroke();
      y += 6;
    };
    cabecalhoTabela();

    doc.font('Helvetica').fontSize(8).fillColor(TINTA);
    for (const e of dados.empresas || []) {
      if (y > doc.page.height - 90) {   // reserva espaço para o rodapé
        doc.addPage();
        y = 42;
        cabecalhoTabela();
        doc.font('Helvetica').fontSize(8).fillColor(TINTA);
      }
      const valores = [
        e.empresa, String(e.notas), moeda(e.valorServico), moeda(e.baseCalculo),
        moeda(e.valorIss), moeda(e.issRetido), moeda(e.retencoesFederais)
      ];
      colunas.forEach((c, i) => {
        doc.text(valores[i], c.x, y, { width: c.l, align: c.a, lineBreak: false, ellipsis: true });
      });
      y += 14;
    }

    y += 2;
    doc.moveTo(42, y).lineTo(42 + larguraUtil, y).lineWidth(0.6).strokeColor(CINZA_CLARO).stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(TINTA);
    const totais = ['Total', String(t.notas || 0), moeda(t.valorServico), moeda(t.baseCalculo),
                    moeda(t.valorIss), moeda(t.issRetido), moeda(t.retencoesFederais)];
    colunas.forEach((c, i) => doc.text(totais[i], c.x, y, { width: c.l, align: c.a, lineBreak: false }));
    y += 24;

    /* O que ficou de fora precisa aparecer: um fechamento que esconde as
       rejeitadas faz o cliente conferir os números contra outra realidade. */
    const fora = dados.naoAutorizadas || [];
    if (fora.length) {
      if (y > doc.page.height - 120) { doc.addPage(); y = 42; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor(TINTA)
         .text('Fora do fechamento (' + fora.length + ')', 42, y);
      y += 13;
      doc.font('Helvetica').fontSize(7.5).fillColor(CINZA)
         .text('Notas que não foram autorizadas e por isso não entram nos totais acima.',
               42, y, { width: larguraUtil });
      y += 14;
      doc.fontSize(8).fillColor(TINTA);
      for (const n of fora.slice(0, 40)) {
        if (y > doc.page.height - 80) { doc.addPage(); y = 42; }
        doc.text(`${n.empresa} — série ${n.serie}/${n.numero} — ${n.status}` +
                 (n.referencia ? ` — ${n.referencia}` : ''), 42, y,
                 { width: larguraUtil, lineBreak: false, ellipsis: true });
        y += 12;
      }
      if (fora.length > 40) {
        doc.fillColor(CINZA).text(`e mais ${fora.length - 40}. A lista completa está no painel.`,
                                  42, y, { width: larguraUtil });
      }
    }

    /* ---------------------------------------------------- rodapé */
    const paginas = doc.bufferedPageRange();
    const contato = [identidade.site, identidade.telefone, identidade.email]
      .filter(Boolean).join('  ·  ');
    for (let i = 0; i < paginas.count; i++) {
      doc.switchToPage(paginas.start + i);
      const yr = doc.page.height - 52;
      doc.moveTo(42, yr).lineTo(42 + larguraUtil, yr).lineWidth(0.6).strokeColor(CINZA_CLARO).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(CINZA);
      doc.text(identidade.rodape || contato || '', 42, yr + 7,
               { width: larguraUtil - 90, lineBreak: false, ellipsis: true });
      doc.text('Emitido em ' + new Date().toLocaleString('pt-BR') +
               '   ·   página ' + (i + 1) + ' de ' + paginas.count,
               42, yr + 7, { width: larguraUtil, align: 'right' });
    }

    doc.end();
  });
}

module.exports = { gerarFechamentoPdf };
