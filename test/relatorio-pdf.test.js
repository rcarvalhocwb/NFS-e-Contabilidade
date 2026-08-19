const test = require('node:test');
const assert = require('node:assert');
const { gerarFechamentoPdf } = require('../src/nfse/relatorioPdf');

/* Relatório de fechamento em PDF.
 *
 * É o que o escritório manda ao cliente no fim do mês. Duas coisas precisam
 * continuar verdadeiras:
 *
 * 1. A marca do escritório aparece — é o que faz o documento ser entregável em
 *    vez de virar números copiados à mão para outro arquivo (que é onde o erro
 *    de transcrição nasce).
 * 2. As notas que NÃO entraram no fechamento são listadas. Um relatório que
 *    mostra só o que deu certo faz o cliente conferir contra outra realidade.
 *
 * O texto é lido de dentro do PDF sem compressão: é a forma de verificar o que
 * saiu impresso sem depender de um leitor externo. */

const DADOS = {
  periodo: { inicio: '2026-08-01', fim: '2026-08-31' },
  empresas: [
    { empresa: 'RECALCATTI SEGURANCA PRIVADA LTDA', cnpj: '21583854000118', notas: 12,
      valorServico: 18400.5, baseCalculo: 18400.5, valorIss: 368.01,
      issRetido: 0, retencoesFederais: 0 },
    { empresa: 'OUTRA EMPRESA LTDA', cnpj: '11222333000181', notas: 3,
      valorServico: 2500, baseCalculo: 2500, valorIss: 50,
      issRetido: 50, retencoesFederais: 116.25 }
  ],
  totais: { notas: 15, valorServico: 20900.5, baseCalculo: 20900.5,
            valorIss: 418.01, issRetido: 50, retencoesFederais: 116.25 },
  naoAutorizadas: [
    { empresa: 'RECALCATTI SEGURANCA PRIVADA LTDA', serie: '2', numero: '7',
      status: 'rejeitada', referencia: 'CONTRATO-88' }
  ]
};

const MARCA = {
  nome: 'Contabilidade Exemplo', descricao: 'Assessoria contábil e fiscal',
  cor_acento: '#0f766e', rodape: 'Contabilidade Exemplo · CRC-PR 000000/O',
  site: 'exemplo.com.br', telefone: '(41) 3000-0000'
};

/* Texto visível do PDF, para conferir o que foi impresso.
   O PDFKit escreve as strings em hexadecimal — <4d41524341...> — então ler o
   arquivo procurando texto literal não acha nada. */
async function textoDo(dados, marca, logo) {
  const pdf = await gerarFechamentoPdf(dados, marca, logo, { comprimir: false });
  const bruto = pdf.toString('latin1');
  const pedacos = [...bruto.matchAll(/<([0-9a-fA-F]{2,})>/g)].map(m =>
    Buffer.from(m[1], 'hex').toString('latin1'));
  const texto = pedacos.join(' ');
  /* O PDFKit ajusta o espacejamento letra a letra, então uma palavra sai
     partida no arquivo ("Fec hamento", "RECALCA TTI"). Comparar sem espaços
     verifica o conteúdo sem depender do kerning. */
  return { texto, compacto: texto.replace(/\s+/g, ''), pdf, bruto };
}

/* Procura no texto ignorando espaços, dos dois lados. */
function contem(resultado, trecho) {
  return resultado.compacto.includes(trecho.replace(/\s+/g, ''));
}

test('o relatório leva o nome do escritório', async () => {
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, 'Contabilidade Exemplo'), 'o nome do escritório precisa aparecer');
  assert.ok(contem(r, 'Assessoria contábil'));
});

test('o período aparece em formato brasileiro', async () => {
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, '01/08/2026'));
  assert.ok(contem(r, '31/08/2026'));
});

test('os valores saem no formato brasileiro', async () => {
  // 18400.5 precisa virar 18.400,50 — não 18,400.50
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, '18.400,50'), 'valor por empresa em pt-BR');
  assert.ok(contem(r, '20.900,50'), 'total em pt-BR');
});

test('cada empresa aparece com seus totais', async () => {
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, 'RECALCATTI'));
  assert.ok(contem(r, 'OUTRA EMPRESA'));
});

test('as notas fora do fechamento são listadas', async () => {
  // Sem isso, o cliente confere o relatório contra outra realidade
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, 'Fora do fechamento'));
  assert.ok(contem(r, 'rejeitada'));
  assert.ok(contem(r, 'CONTRATO-88'), 'a referência ajuda a achar a nota');
});

test('o rodapé traz os dados do escritório', async () => {
  const r = await textoDo(DADOS, MARCA, null);
  assert.ok(contem(r, 'CRC-PR'));
});

test('sem identidade cadastrada, ainda sai um relatório', async () => {
  // Instalação nova, antes de alguém abrir a aba de identidade
  const r = await textoDo(DADOS, {}, null);
  assert.ok(r.pdf.length > 800);
  assert.ok(contem(r, 'Fechamento'));
  assert.ok(contem(r, '20.900,50'), 'os números continuam corretos');
});

test('a logo entra no arquivo quando existe', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const { bruto } = await textoDo(DADOS, MARCA, { conteudo: png, tipo: 'image/png' });
  assert.match(bruto, /\/Subtype\s*\/Image/);
});

test('logo ilegível não derruba o relatório', async () => {
  // Arquivo corrompido no banco não pode impedir o fechamento do mês
  const lixo = Buffer.from('isto nao e uma imagem');
  const r = await textoDo(DADOS, MARCA, { conteudo: lixo, tipo: 'image/png' });
  assert.ok(contem(r, 'Contabilidade Exemplo'));
  assert.ok(contem(r, '20.900,50'));
});

test('fechamento sem nenhuma nota gera documento válido', async () => {
  const vazio = {
    periodo: { inicio: '2026-08-01', fim: '2026-08-31' },
    empresas: [],
    totais: { notas: 0, valorServico: 0, baseCalculo: 0, valorIss: 0,
              issRetido: 0, retencoesFederais: 0 },
    naoAutorizadas: []
  };
  const r = await textoDo(vazio, MARCA, null);
  assert.ok(r.pdf.length > 800);
  assert.ok(contem(r, '0,00'));
});
