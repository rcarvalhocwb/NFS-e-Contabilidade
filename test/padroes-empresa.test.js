const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { aplicarPadroes, faltaParaEmitirSemFormulario } = require('../src/nfse/padroesEmpresa');
const { montarDps } = require('../src/nfse/dpsBuilder');

/* Os padrões da empresa fora do navegador.
 *
 * O caso que originou este arquivo está em produção: a nota 8 saiu pelo
 * formulário, com <pTotTribSN>6.00</pTotTribSN>, e foi autorizada. A nota 9
 * saiu pelo caminho da solicitação, sem <totTrib>, e voltou E1235 — "o elemento
 * 'trib' tem conteúdo incompleto". A diferença era um elemento, e era o que a
 * tela preenchia sozinha.
 */

const SIMPLES = {
  cnpj: '21583854000118',
  codigo_municipio: '4106902',
  op_simp_nac: 3,
  cod_tributacao_padrao: '110201',
  cod_tributacao_municipal: null,
  cod_nbs_padrao: null,
  descricao_padrao: 'Vigilancia patrimonial armada',
  aliquota_iss_padrao: null,
  iss_retido_padrao: false,
  perc_total_tributos: '6.0000',
  tributacao_issqn_padrao: 1
};

const FORA_DO_SIMPLES = Object.assign({}, SIMPLES, {
  op_simp_nac: 1,
  aliquota_iss_padrao: '5.00',
  perc_total_tributos: '12.5000'
});

/* O que o WhatsApp manda: o valor, e nada mais. */
const PEDIDO_DO_WHATSAPP = {
  tomador: { cnpj: '11222333000181', razaoSocial: 'CLIENTE TESTE LTDA' },
  servico: { codigoTributacaoNacional: '110201', descricao: 'Vigilancia' },
  valores: { valorServico: 250 }
};

/* -------------------------------------------------- a regressão da nota 9 */

test('o pedido do WhatsApp ganha o percentual do Simples', () => {
  const d = aplicarPadroes(SIMPLES, PEDIDO_DO_WHATSAPP);
  assert.strictEqual(d.valores.percentualTotalTributosSN, 6);
});

test('e com ele o <totTrib> volta ao XML', () => {
  /* É a asserção que faltava: nenhuma das 458 anteriores emitia pelo caminho da
     solicitação com uma empresa do Simples, e por isso todas passavam com o
     defeito no lugar. */
  const dados = aplicarPadroes(SIMPLES, PEDIDO_DO_WHATSAPP);
  const xml = montarDps(SIMPLES, dados,
    { tpAmb: '2', verAplic: 'teste', idDps: 'X', serie: '1', numero: 1 });

  assert.match(xml, /<totTrib><pTotTribSN>6\.00<\/pTotTribSN><\/totTrib>/,
    'o grupo que a Sefin recusou por ausência precisa estar aqui');
});

test('sem os padrões, o XML é o que a Sefin recusou', () => {
  /* Guarda o contrário: se alguém remover a aplicação dos padrões, este teste
     mostra exatamente o que volta a acontecer. */
  const xml = montarDps(SIMPLES, PEDIDO_DO_WHATSAPP,
    { tpAmb: '2', verAplic: 'teste', idDps: 'X', serie: '1', numero: 1 });
  assert.ok(!/<totTrib>/.test(xml),
    'sem padrão, o grupo some — e é o E1235 da nota 9');
});

test('o serviço de emissão aplica os padrões antes de conferir o leiaute', () => {
  /* Conferir antes de preencher recusaria a nota por falta de um campo que o
     próprio gateway ia completar. */
  const s = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'emissaoService.js'), 'utf8');
  /* Casa com a CHAMADA, não com o nome do argumento: ele já mudou uma vez, de
     `dadosRecebidos` para `comHeranca`, quando a substituição passou a herdar
     da nota original — e o teste quebrou sem que nada de errado tivesse
     acontecido. O que precisa valer é a ordem. */
  const aplica = s.indexOf('aplicarPadroes(empresa,');
  const confere = s.indexOf('conferirEmissao(dados)');
  assert.ok(aplica > 0, 'emitir() precisa continuar aplicando os padrões da empresa');
  assert.ok(confere > 0, 'e continuar conferindo o leiaute');
  assert.ok(aplica < confere, 'preencher vem antes de conferir');
  /* E o que se confere é o resultado do preenchimento, não o pedido cru. */
  assert.match(s, /const dados = aplicarPadroes\(empresa,/);
});

test('todo caminho de emissão passa pelo mesmo lugar', () => {
  /* A raiz do defeito era ter dois lugares que preenchiam e dois que não.
     WhatsApp, portal e API pública chamam emitir(); se ele aplica, todos
     aplicam. */
  const ponte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ponteNuvem.js'), 'utf8');
  assert.match(ponte, /const \{ emitir \} = require\('\.\/emissaoService'\)/);

  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'nfse.js'), 'utf8');
  assert.match(rota, /await emitir\(b\.cnpjEmpresa, b,/);
});

/* ------------------------------------------- o que o chamador manda vence */

test('padrão não sobrescreve o que a pessoa digitou', () => {
  const d = aplicarPadroes(SIMPLES, {
    servico: { codigoTributacaoNacional: '070101', descricao: 'Outra coisa' },
    valores: { valorServico: 100, percentualTotalTributosSN: 4.5 }
  });
  assert.strictEqual(d.servico.codigoTributacaoNacional, '070101');
  assert.strictEqual(d.servico.descricao, 'Outra coisa');
  assert.strictEqual(d.valores.percentualTotalTributosSN, 4.5);
});

test('zero informado continua valendo zero', () => {
  /* `|| padrão` trocaria um zero legítimo pelo padrão da empresa. */
  const d = aplicarPadroes(SIMPLES, { valores: { valorServico: 10, percentualTotalTributosSN: 0 } });
  assert.strictEqual(d.valores.percentualTotalTributosSN, 0);

  const e = aplicarPadroes(FORA_DO_SIMPLES, { valores: { valorServico: 10, aliquotaIss: 0 } });
  assert.strictEqual(e.valores.aliquotaIss, 0);
});

test('o pedido original não é alterado', () => {
  /* A solicitação fica gravada no banco como pedido do cliente; mexer nela por
     baixo mudaria o que se registrou que ele pediu. */
  const original = JSON.parse(JSON.stringify(PEDIDO_DO_WHATSAPP));
  aplicarPadroes(SIMPLES, PEDIDO_DO_WHATSAPP);
  assert.deepStrictEqual(PEDIDO_DO_WHATSAPP, original);
});

/* --------------------------------------------------- Simples e não-Simples */

test('optante do Simples não recebe alíquota de ISS', () => {
  /* O optante recolhe pelo DAS; declarar alíquota é o que a Sefin recusa. */
  const comAliquota = Object.assign({}, SIMPLES, { aliquota_iss_padrao: '5.00' });
  const d = aplicarPadroes(comAliquota, PEDIDO_DO_WHATSAPP);
  assert.strictEqual(d.valores.aliquotaIss, undefined);
});

test('fora do Simples recebe alíquota e não recebe pTotTribSN', () => {
  const d = aplicarPadroes(FORA_DO_SIMPLES, PEDIDO_DO_WHATSAPP);
  assert.strictEqual(d.valores.aliquotaIss, 5);
  assert.strictEqual(d.valores.percentualTotalTributosSN, undefined);
});

test('número solto fora do Simples não vira três zeros', () => {
  /* Antes, `.federal` de um número era undefined e o `|| 0` completava:
     saía <pTotTribFed>0,0</pTotTribFed>, declarando ausência de tributo federal
     onde o que houve foi ausência de informação. */
  const xml = montarDps(FORA_DO_SIMPLES,
    { servico: PEDIDO_DO_WHATSAPP.servico, tomador: PEDIDO_DO_WHATSAPP.tomador,
      valores: { valorServico: 100, percentualTotalTributos: 12.5 } },
    { tpAmb: '2', verAplic: 'teste', idDps: 'X', serie: '1', numero: 1 });

  assert.ok(!/<pTotTribFed>0\.00<\/pTotTribFed>/.test(xml), 'zero inventado não vai no documento fiscal');
  assert.match(xml, /<indTotTrib>0<\/indTotTrib>/, 'sem repartição, declara "sem informação"');
});

test('a repartição por esfera continua funcionando', () => {
  const xml = montarDps(FORA_DO_SIMPLES,
    { servico: PEDIDO_DO_WHATSAPP.servico, tomador: PEDIDO_DO_WHATSAPP.tomador,
      valores: { valorServico: 100,
                 percentualTotalTributos: { federal: 8, estadual: 0, municipal: 4.5 } } },
    { tpAmb: '2', verAplic: 'teste', idDps: 'X', serie: '1', numero: 1 });
  assert.match(xml, /<pTotTribFed>8\.00<\/pTotTribFed>/);
  assert.match(xml, /<pTotTribMun>4\.50<\/pTotTribMun>/);
});

/* --------------------------------------- natureza da tributação e retenção */

test('natureza 1 não é enviada: é o que o construtor já assume', () => {
  const d = aplicarPadroes(SIMPLES, PEDIDO_DO_WHATSAPP);
  assert.strictEqual(d.valores.tributacaoIssqn, undefined);
});

test('natureza diferente de 1 vai junto', () => {
  const isenta = Object.assign({}, SIMPLES, { tributacao_issqn_padrao: 3 });
  const d = aplicarPadroes(isenta, PEDIDO_DO_WHATSAPP);
  assert.strictEqual(d.valores.tributacaoIssqn, 3);
});

test('ISS retido padrão chega ao pedido', () => {
  const retido = Object.assign({}, SIMPLES, { iss_retido_padrao: true });
  assert.strictEqual(aplicarPadroes(retido, PEDIDO_DO_WHATSAPP).valores.issRetido, true);
  /* false é uma resposta, não uma ausência. */
  assert.strictEqual(aplicarPadroes(SIMPLES, PEDIDO_DO_WHATSAPP).valores.issRetido, false);
});

/* ------------------------------------------------- avisar antes de doer */

test('a empresa do Simples sem percentual é apontada antes do primeiro pedido', () => {
  /* Ela emite pelo formulário, onde alguém digita, e falha por todos os outros
     caminhos. Sem esta conferência, isso só apareceria quando o cliente
     mandasse a primeira mensagem. */
  const sem = Object.assign({}, SIMPLES, { perc_total_tributos: null });
  const falta = faltaParaEmitirSemFormulario(sem);
  assert.ok(falta.some(f => /Simples|PGDAS/.test(f)));
});

test('empresa completa não acusa falta', () => {
  assert.deepStrictEqual(faltaParaEmitirSemFormulario(SIMPLES), []);
});

test('fora do Simples não precisa do percentual do PGDAS', () => {
  const sem = Object.assign({}, FORA_DO_SIMPLES, { perc_total_tributos: null });
  assert.ok(!faltaParaEmitirSemFormulario(sem).some(f => /PGDAS/.test(f)));
});

/* ------------------------------------------- a comparação com o que valeu */

/* O bloco <valores> da NFS-e 1231 — emitida em Curitiba, em produção, pelo
   formulário, e autorizada pela Sefin em 19/08/2026. É a única referência
   confiável que existe de "assim a Sefin aceita". */
const VALORES_DA_NOTA_AUTORIZADA =
  '<valores><vServPrest><vServ>3.00</vServ></vServPrest>' +
  '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>' +
  '<totTrib><pTotTribSN>6.00</pTotTribSN></totTrib></trib></valores>';

test('o pedido do WhatsApp gera o mesmo <valores> que a Sefin autorizou', () => {
  /* O caminho da solicitação manda só o valor. Depois dos padrões, o bloco
     precisa sair igual ao da nota que passou — é o que separa a nota 8 da 9. */
  const dados = aplicarPadroes(SIMPLES,
    Object.assign({}, PEDIDO_DO_WHATSAPP, { valores: { valorServico: 3 } }));
  const xml = montarDps(Object.assign({}, SIMPLES, { omitir_im: true }), dados,
    { tpAmb: '1', verAplic: 'x', idDps: 'X', serie: '2', numero: 99 });

  const bloco = (xml.match(/<valores>[\s\S]*?<\/valores>/) || [''])[0];
  assert.strictEqual(bloco, VALORES_DA_NOTA_AUTORIZADA);
});

/* -------------------------------- as telas param de mandar o numero errado */

test('a página conversacional não manda alíquota de ISS como percentual do PGDAS', () => {
  /* `servicos.aliquota_iss` está descrita no esquema como "usada fora do
     Simples Nacional" — e esta tela a mandava como percentualTotalTributosSN
     para quem ESTÁ no Simples. Enquanto o servidor não preenchia nada, número
     errado era melhor que nenhum. Agora que ele aplica o perc_total_tributos da
     empresa, mandar daqui só sobrescreveria o certo pelo errado. */
  const s = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'emitir.js'), 'utf8');
  /* A palavra ainda aparece — no comentário que explica por que ela saiu.
     O que não pode voltar é a ATRIBUIÇÃO. */
  assert.ok(!/percentualTotalTributosSN\s*=/.test(s),
    'a tela não decide mais o percentual do Simples');
  assert.match(s, /op_simp_nac\)\) < 0 && s\.aliquota_iss/,
    'fora do Simples a alíquota do serviço continua valendo');
});

test('o formulário completo continua mandando o que a pessoa digitou', () => {
  /* nota.js pré-preenche o campo com o padrão da empresa e manda o que estiver
     lá. Isso continua certo: quem digitou vence, e é uma pessoa olhando. */
  const s = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'nota.js'), 'utf8');
  assert.match(s, /if \(optanteSN\) valores\.percentualTotalTributosSN = num\('fTotTrib'\)/);
});

test('a lista de empresas diz o que falta nos padrões fiscais', () => {
  /* A falta aparece onde ela se conserta, e não só quando o cliente manda a
     primeira mensagem e a Sefin recusa. */
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'empresas.js'), 'utf8');
  assert.match(rota, /falta_padroes: faltaParaEmitirSemFormulario\(e\)/);
  assert.match(rota, /e\.perc_total_tributos,/, 'a consulta precisa trazer o campo');

  const painel = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'painel.js'), 'utf8');
  assert.match(painel, /e\.falta_padroes \|\| \[\]/);
});

test('ligar o registro duas vezes não duplica cada linha do log', () => {
  /* O scripts/iniciar.js liga antes de esperar o banco e o server.js liga de
     novo ao subir. Sem guarda, o console sairia envolvido duas vezes. */
  const s = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'registro.js'), 'utf8');
  assert.match(s, /if \(ligado\) return;/);
});
