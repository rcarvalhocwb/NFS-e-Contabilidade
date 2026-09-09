#!/usr/bin/env node
/**
 * Emite uma licença. Roda SÓ na máquina de quem vende.
 *
 * Este arquivo fica no repositório; a CHAVE PRIVADA, não. Ela mora em
 * %USERPROFILE%\.nfse\licenca.key por padrão, fora da árvore do projeto — o
 * repositório é privado, mas o instalador é montado a partir dele, e chave
 * aqui dentro é chave que um dia viaja dentro de um .exe.
 *
 * PERDER A CHAVE PRIVADA é perder a capacidade de emitir e renovar licenças
 * para todos os clientes de uma vez. Guarde uma cópia offline no dia em que
 * gerar o par, não depois.
 *
 * Uso:
 *   node scripts/licenca-emitir.js --gerar-chaves
 *
 *   node scripts/licenca-emitir.js \
 *     --cnpj 11222333000181 --nome "Contabilidade Exemplo" \
 *     --plano anual --terminais 3
 *
 *   node scripts/licenca-emitir.js --renovar LIC-2026-0001
 *
 * Toda emissão entra em licencas.csv. Não é burocracia: "qual licença esse
 * cliente tem?" é a primeira pergunta de todo atendimento, e responder
 * "não sei" na frente do cliente custa caro.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { assinar, verificar, gerarParDeChaves } = require('../src/licenca/formato');

const PASTA = process.env.NFSE_LICENCA_DIR || path.join(os.homedir(), '.nfse');
const ARQ_PRIVADA = path.join(PASTA, 'licenca.key');
const ARQ_PUBLICA = path.join(PASTA, 'licenca.pub');
const ARQ_REGISTRO = path.join(PASTA, 'licencas.csv');

function arg(nome, padrao) {
  const i = process.argv.indexOf('--' + nome);
  if (i === -1) return padrao;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
function morrer(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }

/* -------------------------------------------------------- gerar as chaves */

function gerarChaves() {
  if (fs.existsSync(ARQ_PRIVADA)) {
    morrer('Já existe uma chave em ' + ARQ_PRIVADA + '.\n  ' +
           'Gerar outra INVALIDA todas as licenças já emitidas. Se é isso mesmo,\n  ' +
           'mova a antiga para outro lugar antes.');
  }
  fs.mkdirSync(PASTA, { recursive: true });
  const par = gerarParDeChaves();
  fs.writeFileSync(ARQ_PRIVADA, par.privada, { mode: 0o600 });
  fs.writeFileSync(ARQ_PUBLICA, par.publica);

  console.log('\n  Par de chaves criado.\n');
  console.log('  privada:  ' + ARQ_PRIVADA + '   (nunca saia daqui)');
  console.log('  pública:  ' + ARQ_PUBLICA);
  console.log('\n  Agora, dois passos que não podem esperar:\n');
  console.log('  1. Copie a chave PÚBLICA abaixo para src/licenca/chave-publica.js');
  console.log('     — é ela que vai dentro do produto, em todo cliente.\n');
  console.log(par.publica.trim().split('\n').map(l => '     ' + l).join('\n'));
  console.log('\n  2. Guarde uma cópia OFFLINE da chave privada. Perdê-la é perder');
  console.log('     a capacidade de renovar licença de qualquer cliente.\n');
}

/* --------------------------------------------------------------- registro */

function lerRegistro() {
  if (!fs.existsSync(ARQ_REGISTRO)) return [];
  const linhas = fs.readFileSync(ARQ_REGISTRO, 'utf8').trim().split('\n');
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(';');
  return linhas.slice(1).map(l => {
    const c = l.split(';');
    const o = {};
    cab.forEach((k, i) => { o[k] = c[i]; });
    return o;
  });
}

function anotar(linha) {
  const campos = ['id', 'cnpj', 'nome', 'plano', 'terminais', 'emitido_em',
                  'valido_ate', 'ativacao', 'observacao'];
  const novo = !fs.existsSync(ARQ_REGISTRO);
  fs.mkdirSync(PASTA, { recursive: true });
  if (novo) fs.writeFileSync(ARQ_REGISTRO, campos.join(';') + '\n');
  fs.appendFileSync(ARQ_REGISTRO,
    campos.map(c => String(linha[c] == null ? '' : linha[c]).replace(/;/g, ',')).join(';') + '\n');
}

/* Código de ativação: o que uma pessoa dita ao telefone sem errar.
   Sem O, 0, I, 1 — as confusões clássicas — e em blocos de quatro. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function codigoAtivacao() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALFABETO[bytes[i] % ALFABETO.length];
  return 'RECAL-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
}

function proximoId() {
  const ano = new Date().getFullYear();
  const usados = lerRegistro()
    .map(l => (l.id || '').match(new RegExp('^LIC-' + ano + '-(\\d+)$')))
    .filter(Boolean).map(m => Number(m[1]));
  const n = usados.length ? Math.max(...usados) + 1 : 1;
  return 'LIC-' + ano + '-' + String(n).padStart(4, '0');
}

function somarMeses(iso, meses) {
  const [a, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 + meses, d));
  /* 31/01 + 1 mês não existe em fevereiro; o JS empurra para março, o que
     daria ao cliente dias de graça sem querer. Recua para o último dia do mês
     pretendido, que é como todo contrato mensal se comporta. */
  if (base.getUTCMonth() !== ((m - 1 + meses) % 12 + 12) % 12) base.setUTCDate(0);
  return base.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- emitir */

function emitir() {
  if (!fs.existsSync(ARQ_PRIVADA)) {
    morrer('Não achei a chave privada em ' + ARQ_PRIVADA + '.\n  ' +
           'Rode primeiro:  node scripts/licenca-emitir.js --gerar-chaves');
  }
  const privada = fs.readFileSync(ARQ_PRIVADA, 'utf8');

  const renovar = arg('renovar');
  let cnpj, nome, plano, terminais, recursos, id;

  if (renovar && renovar !== true) {
    const anterior = lerRegistro().filter(l => l.id === renovar).pop();
    if (!anterior) morrer('Não achei a licença ' + renovar + ' no registro.');
    cnpj = anterior.cnpj;
    nome = anterior.nome;
    plano = arg('plano', anterior.plano);
    terminais = Number(arg('terminais', anterior.terminais));
    /* Renovação mantém o MESMO id: é o mesmo contrato, num período novo. O
       id é o que liga a licença ao cliente no atendimento e na telemetria —
       trocá-lo a cada mês tornaria o histórico ilegível. */
    id = renovar;
  } else {
    cnpj = String(arg('cnpj', '')).replace(/\D/g, '');
    nome = String(arg('nome', ''));
    plano = String(arg('plano', 'anual'));
    terminais = Number(arg('terminais', 1));
    id = proximoId();
  }

  if (!/^\d{14}$/.test(cnpj)) morrer('Informe --cnpj com 14 dígitos.');
  if (!nome || nome === 'true') morrer('Informe --nome "Razão Social do escritório".');
  if (!['mensal', 'anual'].includes(plano)) morrer('--plano precisa ser mensal ou anual.');
  if (!Number.isInteger(terminais) || terminais < 1) morrer('--terminais precisa ser 1 ou mais.');

  recursos = String(arg('recursos', 'whatsapp,portal,atualizacoes'))
    .split(',').map(s => s.trim()).filter(Boolean);

  const hoje = new Date().toISOString().slice(0, 10);
  const meses = plano === 'mensal' ? 1 : 12;
  const validoAte = arg('ate') !== undefined && arg('ate') !== true
    ? String(arg('ate')) : somarMeses(hoje, meses);

  /* A carência é o que impede um relógio errado ou um boleto atrasado de
     desligar um cliente adimplente. No mensal ela é proporcionalmente maior
     porque o vencimento chega doze vezes mais vezes. */
  const carencia = Number(arg('carencia', plano === 'mensal' ? 10 : 30));

  const licenca = assinar({
    id,
    escritorio: { cnpj, nome },
    plano,
    emitido_em: hoje,
    valido_ate: validoAte,
    carencia_dias: carencia,
    /* Sem limite de empresas atendidas: a cobrança é por escritório, e contar
       CNPJ atendido seria cobrar o cliente por crescer. */
    terminais,
    recursos
  }, privada);

  /* Confere a própria assinatura antes de entregar. Custa um milissegundo e
     evita entregar ao cliente uma licença que não abre — o pior primeiro
     contato possível com o produto. */
  const conferida = verificar(licenca, fs.readFileSync(ARQ_PUBLICA, 'utf8'));
  if (!conferida.valida) morrer('A licença gerada não passou na própria conferência: ' + conferida.motivo);

  const ativacao = codigoAtivacao();
  anotar({ id, cnpj, nome, plano, terminais, emitido_em: hoje,
           valido_ate: validoAte, ativacao, observacao: renovar ? 'renovação' : '' });

  console.log('\n  ' + (renovar ? 'Licença renovada' : 'Licença emitida') + ': ' + id);
  console.log('  ' + nome + '  ·  ' + cnpj);
  console.log('  ' + plano + ', válida até ' + validoAte + ' (+ ' + carencia + ' dias de carência)');
  console.log('  ' + terminais + ' terminal(is) contratado(s), empresas atendidas sem limite');
  console.log('\n  Código de ativação (dite este ao cliente):\n');
  console.log('      ' + ativacao);
  console.log('\n  Licença assinada (alternativa para rede fechada):\n');
  console.log('      ' + licenca);
  console.log('\n  Anotado em ' + ARQ_REGISTRO + '\n');
}

function listar() {
  const linhas = lerRegistro();
  if (!linhas.length) return console.log('\n  Nenhuma licença emitida ainda.\n');
  console.log('\n  ' + 'ID'.padEnd(16) + 'ESCRITÓRIO'.padEnd(32) + 'PLANO'.padEnd(9) +
              'TERM'.padEnd(6) + 'VÁLIDA ATÉ');
  for (const l of linhas) {
    console.log('  ' + String(l.id).padEnd(16) + String(l.nome).slice(0, 30).padEnd(32) +
                String(l.plano).padEnd(9) + String(l.terminais).padEnd(6) + l.valido_ate);
  }
  console.log('');
}

if (arg('gerar-chaves')) gerarChaves();
else if (arg('listar')) listar();
else emitir();
