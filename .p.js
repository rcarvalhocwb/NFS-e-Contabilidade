/* Pergunta a propria Sefin sobre os dois municipios, com o certificado real.
   E leitura: nao cria documento nem consome numeracao. */
require('dotenv').config();
const db = require('./src/db');
const { carregarCertificadoAtivo } = require('./src/services/certificadoService');
const p = require('./src/nfse/parametrosClient');

const ALVOS = [
  ['4107652', 'Fazenda Rio Grande'],
  ['4125506', 'Sao Jose dos Pinhais'],
  ['4106902', 'Curitiba (controle: sabemos que emite pelo Nacional)']
];

(async () => {
  const emp = (await db.query("SELECT id FROM empresas WHERE cnpj='21583854000118'")).rows[0];
  const cert = await carregarCertificadoAtivo(emp.id);
  console.log('certificado carregado\n');

  for (const [cod, nome] of ALVOS) {
    console.log('=== ' + nome + ' (' + cod + ') ===');
    try {
      const r = await p.consultarParametros('producao', cod, cert);
      console.log('  HTTP ' + r.status);
      const corpo = r.json !== undefined && r.json !== null ? r.json : r.raw;
      console.log('  ' + JSON.stringify(corpo).slice(0, 700));
    } catch (e) {
      console.log('  ERRO: ' + e.message);
    }
    console.log('');
  }
  await db.pool.end();
})().catch(async e => { console.error('falhou:', e.message); await db.pool.end().catch(()=>{}); });
