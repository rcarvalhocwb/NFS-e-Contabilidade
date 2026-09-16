#!/usr/bin/env node
/**
 * As portas estão livres?
 *
 * São quatro processos com vidas separadas — gateway, repassador, módulo do
 * WhatsApp e monitor — e nada conferia se as portas escolhidas já estavam
 * ocupadas. O sintoma de uma colisão é o pior que existe: o segundo processo
 * não sobe, o ícone abre e fecha, e não há erro em lugar nenhum que ligue isso
 * à porta. Descobre-se por eliminação, dias depois.
 *
 * Conferir é barato: tenta escutar, e solta. Quem responde "EADDRINUSE" já
 * respondeu tudo que precisava.
 *
 * Uso:
 *   node scripts/conferir-portas.js 3000 8080 3200 3100
 *   node scripts/conferir-portas.js --json 3000 3200
 *
 * Sai 0 se todas livres, 1 se alguma está ocupada. Quem chama decide o que
 * fazer com isso — este script não escolhe porta por ninguém: trocar a porta
 * do painel por conta própria deixaria os atalhos dos terminais apontando para
 * o lugar errado, e ninguém saberia por quê.
 */
const net = require('net');

/* Escuta em 0.0.0.0 e não em 127.0.0.1, de propósito.
 *
 * Um processo que já escute em 0.0.0.0:3000 NÃO impede outro de escutar em
 * 127.0.0.1:3000 no Windows — a ligação funciona, e a colisão só aparece
 * quando alguém acessa pela rede e cai no programa errado. Testar no endereço
 * mais abrangente é o único jeito de a resposta valer para os dois casos. */
function livre(porta) {
  return new Promise(resolve => {
    const s = net.createServer();

    s.once('error', e => resolve({ porta, livre: false, codigo: e.code }));
    s.once('listening', () => s.close(() => resolve({ porta, livre: true })));

    /* exclusive: o Node por padrão permite compartilhar a porta entre workers
       do mesmo processo; sem isto o teste responderia "livre" para uma porta
       que o próprio gateway está usando. */
    s.listen({ port: porta, host: '0.0.0.0', exclusive: true });
  });
}

async function principal() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const portas = args
    .filter(a => !a.startsWith('--'))
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0 && n < 65536);

  if (!portas.length) {
    console.error('uso: node scripts/conferir-portas.js [--json] <porta> [porta...]');
    process.exit(2);
  }

  /* Repetida na mesma lista é colisão tão real quanto com um programa de fora,
     e o teste de escuta não a pegaria: a primeira é solta antes da segunda ser
     tentada. É o caso de quem digita 3000 no painel e 3000 no módulo. */
  const vistas = new Set();
  const repetidas = portas.filter(p => vistas.size === vistas.add(p).size);

  const resultados = await Promise.all([...vistas].map(livre));
  const ocupadas = resultados.filter(r => !r.livre);

  if (json) {
    console.log(JSON.stringify({
      ok: !ocupadas.length && !repetidas.length,
      ocupadas: ocupadas.map(o => o.porta),
      repetidas: [...new Set(repetidas)]
    }));
  } else {
    for (const r of resultados) {
      console.log('  ' + r.porta + ': ' + (r.livre ? 'livre' : 'OCUPADA (' + r.codigo + ')'));
    }
    for (const p of new Set(repetidas)) {
      console.log('  ' + p + ': REPETIDA — dois programas não cabem na mesma porta');
    }
  }

  process.exit(ocupadas.length || repetidas.length ? 1 : 0);
}

principal().catch(e => {
  console.error(e.message);
  process.exit(2);
});
