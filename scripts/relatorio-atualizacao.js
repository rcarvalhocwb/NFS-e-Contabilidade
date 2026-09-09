#!/usr/bin/env node
/**
 * O relatório que a atualização mostra no fim.
 *
 * Duas metades, e a segunda é a que interessa a quem opera:
 *
 *   O QUE MUDOU        — vem das notas das releases, entre a versão que estava
 *                        instalada e a nova. Quem pula da 1.4 para a 1.7
 *                        precisa ver as três, e é justamente quem mais precisa.
 *
 *   NESTA MÁQUINA      — vem do próprio sistema, depois de subir: quantas
 *                        migrações rodaram, onde ficou a cópia, quais chaves
 *                        entraram no .env, e quais empresas ainda não emitem.
 *
 * É a diferença entre um changelog e um relatório. O primeiro qualquer um
 * publica; o segundo só o sistema que acabou de ser atualizado sabe montar.
 *
 * Uso:  node scripts/relatorio-atualizacao.js --saida ultima-atualizacao.json
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

function argumento(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const RAIZ = path.join(__dirname, '..');

/* Quais migrações entraram nesta atualização. `schema_migrations` guarda
   quando cada uma foi aplicada; as desta rodada são as dos últimos minutos. */
async function migracoesRecentes() {
  const r = await db.query(
    `SELECT arquivo, aplicado_em FROM schema_migrations
      WHERE aplicado_em > now() - interval '30 minutes'
      ORDER BY arquivo`).catch(() => ({ rows: [] }));
  return r.rows;
}

/* A cópia feita antes de atualizar. Se ela não existir, algo saiu da ordem —
   e vale dizer isso em voz alta em vez de omitir a linha. */
function copiaAnterior() {
  const pasta = path.join(RAIZ, 'backups');
  if (!fs.existsSync(pasta)) return null;
  const arquivos = fs.readdirSync(pasta)
    .filter(n => n.startsWith('nfse-antes-de-atualizar-'))
    .map(n => ({ nome: n, st: fs.statSync(path.join(pasta, n)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (!arquivos.length) return null;
  const a = arquivos[0];
  return {
    arquivo: a.nome,
    megabytes: Math.round(a.st.size / 1048576 * 10) / 10,
    em: a.st.mtime.toISOString()
  };
}

/* Chaves acrescentadas ao .env nesta rodada — o configurar.ps1 escreve um
   comentário datado antes delas. */
function chavesNovas() {
  const env = path.join(RAIZ, '.env');
  if (!fs.existsSync(env)) return [];
  const txt = fs.readFileSync(env, 'utf8');
  const bloco = txt.split(/^# Acrescentado pelo instalador.*$/m).slice(1).pop();
  if (!bloco) return [];
  return bloco.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=')[0]);
}

/* O que ainda impede alguma empresa de emitir. É a informação que faz o
   relatório valer a leitura: a atualização terminou, mas a Rayzer continua sem
   certificado — e melhor descobrir agora do que na primeira nota. */
async function empresasQueNaoEmitem() {
  const prontidao = require('../src/services/prontidaoEmpresa');
  const r = await db.query('SELECT cnpj, razao_social FROM empresas WHERE ativo ORDER BY id')
    .catch(() => ({ rows: [] }));
  const pendentes = [];
  for (const e of r.rows) {
    try {
      const p = await prontidao.conferir(e.cnpj);
      if (!p.pronta) {
        pendentes.push({
          empresa: p.razaoSocial,
          faltas: p.itens.filter(i => i.estado === 'falta').map(i => i.o_que)
        });
      }
    } catch (_) { /* empresa que não responde não trava o relatório */ }
  }
  return pendentes;
}

async function principal() {
  const versao = require('../package.json').version;

  const relatorio = {
    gerado_em: new Date().toISOString(),
    versao_agora: versao,
    /* A versão anterior vem do INSTALADOR, por parâmetro. Não dá para
       descobri-la aqui: quando este script roda, os arquivos já foram
       trocados e o package.json já é o novo. Quem sabe é o Inno Setup, que
       lê a chave de registro antes de sobrescrevê-la.
       (A tabela `atualizacao` não serve: ela guarda a versão DISPONÍVEL que o
       gateway viu no repositório, que é a nova, não a antiga.) */
    versao_antes: argumento('versao-antes') || null,
    nesta_maquina: {
      migracoes: await migracoesRecentes(),
      copia_antes: copiaAnterior(),
      chaves_novas_no_env: chavesNovas(),
      empresas_que_nao_emitem: await empresasQueNaoEmitem()
    }
  };

  /* As notas da release: o que mudou, escrito por quem publicou. */
  const a = await db.query(
    'SELECT notas, versao_disponivel FROM atualizacao WHERE id = 1')
    .catch(() => ({ rows: [] }));
  if (a.rows.length) relatorio.o_que_mudou = a.rows[0].notas || null;

  const saida = argumento('saida') || path.join(RAIZ, 'ultima-atualizacao.json');
  fs.writeFileSync(saida, JSON.stringify(relatorio, null, 2), 'utf8');

  /* Resumo em texto para o log do instalador: quem lê configuracao.log quer
     saber o que aconteceu sem abrir outro arquivo. */
  const m = relatorio.nesta_maquina;
  console.log('migrações aplicadas: ' + m.migracoes.length);
  console.log('cópia antes: ' + (m.copia_antes
    ? m.copia_antes.arquivo + ' (' + m.copia_antes.megabytes + ' MB)'
    : 'NÃO ENCONTRADA'));
  if (m.chaves_novas_no_env.length) {
    console.log('chaves novas no .env: ' + m.chaves_novas_no_env.join(', '));
  }
  for (const p of m.empresas_que_nao_emitem) {
    console.log('ATENÇÃO: ' + p.empresa + ' não emite — ' + p.faltas.join('; '));
  }

  await db.pool.end();
}

principal().catch(e => {
  console.error(e.message);
  process.exit(1);
});
