#!/usr/bin/env node
/**
 * Recria o cadastro do gateway num banco vazio.
 *
 * Escrito depois que o projeto Supabase `crznsitaiuwrlzxelduk` desapareceu em
 * 2026-08-17, levando junto empresa, numeração e histórico de notas. Os valores
 * abaixo vieram do painel, consultado pouco antes da perda.
 *
 * O que NÃO restaura, porque não estava do lado do gateway:
 *   - certificado A1 — reanexe o .pfx pelo painel (aba Certificado)
 *   - histórico de notas — as autorizadas continuam na Sefin Nacional; o que se
 *     perdeu foi a cópia local
 *
 * ATENÇÃO À NUMERAÇÃO. Os números de DPS já transmitidos ficam queimados na
 * Sefin mesmo que a nota tenha sido cancelada. Recomeçar do 1 faria a Sefin
 * recusar por duplicidade. Por isso a numeração é restaurada onde parou, não
 * do zero.
 *
 * Uso:  node scripts/restaurar-cadastro.js
 *       node scripts/restaurar-cadastro.js --conferir   (só mostra, não grava)
 */
require('dotenv').config();
const db = require('../src/db');

const soConferir = process.argv.includes('--conferir');

const EMPRESA = {
  cnpj: '21583854000118',
  razaoSocial: 'RECALCATTI SEGURANCA PRIVADA LTDA',
  nomeFantasia: 'GRUPO RECALCATTI',
  // Sem a IM a Sefin rejeita com E0116 quando o município exige o
  // cadastro do prestador — foi o que faltou na primeira restauração.
  inscricaoMunicipal: '1102709463',
  codigoMunicipio: '4106902',      // Curitiba/PR
  uf: 'PR',
  opSimpNac: 3,                    // ME/EPP do Simples Nacional
  regEspTrib: 0,
  ambiente: 'homologacao',         // volta em teste; mude no painel quando quiser
  email: 'financeirogruporecalcatti@hotmail.com',
  telefone: '41999372241'
};

/* Última DPS transmitida em cada ambiente, conforme o painel antes da perda:
     homologação  série 1, nº 1  (rejeitada)
     produção     série 2, nº 4  (cancelada)
   O próximo número é o seguinte ao último usado. */
const NUMERACAO = [
  { ambiente: 'homologacao', serie: '1', proxNumero: 2 },
  { ambiente: 'producao',    serie: '2', proxNumero: 5 }
];

const MUNICIPIOS = [
  { codigo: '4107652', nome: 'Fazenda Rio Grande', uf: 'PR', modo: 'proprio' }
];

const TOMADORES = [
  { documento: '14073521000183', razaoSocial: 'RAYZER SERVICOS E TECNOLOGIA LTDA',
    codigoMunicipio: '4106902', uf: 'PR' }
];

async function principal() {
  if (soConferir) {
    console.log('Modo conferência — nada será gravado.\n');
    console.log('Empresa    :', EMPRESA.razaoSocial, '(' + EMPRESA.cnpj + ')');
    NUMERACAO.forEach(n =>
      console.log('Numeração  :', n.ambiente.padEnd(12), 'série', n.serie, '· próximo', n.proxNumero));
    MUNICIPIOS.forEach(m => console.log('Município  :', m.codigo, m.nome, '→', m.modo));
    TOMADORES.forEach(t => console.log('Cliente    :', t.documento, t.razaoSocial));
    console.log('\nFalta reanexar o certificado A1 pelo painel.');
    return;
  }

  const cliente = await db.pool.connect();
  try {
    await cliente.query('BEGIN');

    const emp = await cliente.query(
      `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, inscricao_municipal,
                             codigo_municipio, uf,
                             op_simp_nac, reg_esp_trib, ambiente, email, telefone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social
       RETURNING id, (xmax = 0) AS criada`,
      [EMPRESA.cnpj, EMPRESA.razaoSocial, EMPRESA.nomeFantasia, EMPRESA.inscricaoMunicipal,
       EMPRESA.codigoMunicipio,
       EMPRESA.uf, EMPRESA.opSimpNac, EMPRESA.regEspTrib, EMPRESA.ambiente,
       EMPRESA.email, EMPRESA.telefone]);
    const empresaId = emp.rows[0].id;
    console.log((emp.rows[0].criada ? 'Empresa criada' : 'Empresa já existia') +
                `: ${EMPRESA.razaoSocial}`);

    for (const n of NUMERACAO) {
      // GREATEST: se o banco já tiver um número maior, ele vence. Baixar a
      // numeração é o único erro irreversível aqui.
      await cliente.query(
        `INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (empresa_id, ambiente) DO UPDATE SET
           prox_numero = GREATEST(numeracao_dps.prox_numero, EXCLUDED.prox_numero),
           atualizado_em = now()`,
        [empresaId, n.ambiente, n.serie, n.proxNumero]);
      console.log(`Numeração ${n.ambiente}: série ${n.serie}, próximo ${n.proxNumero}`);
    }

    // Tokens de integração: novos, já que os antigos se foram com o banco
    await cliente.query(
      `INSERT INTO empresa_tokens (empresa_id, ambiente, token, descricao)
       SELECT $1, a.ambiente, encode(gen_random_bytes(24), 'hex'),
              'Recriado na restauração de 2026-08-17'
       FROM (VALUES ('homologacao'), ('producao')) AS a(ambiente)
       ON CONFLICT (empresa_id, ambiente) DO NOTHING`, [empresaId]);
    console.log('Tokens de integração gerados (os antigos não valem mais)');

    for (const m of MUNICIPIOS) {
      await cliente.query(
        `INSERT INTO municipios (codigo_municipio, nome, uf, modo_emissao, fonte)
         VALUES ($1,$2,$3,$4,'manual')
         ON CONFLICT (codigo_municipio) DO UPDATE SET
           modo_emissao = EXCLUDED.modo_emissao, nome = EXCLUDED.nome, uf = EXCLUDED.uf`,
        [m.codigo, m.nome, m.uf, m.modo]);
      console.log(`Município ${m.codigo} ${m.nome}: ${m.modo}`);
    }

    for (const t of TOMADORES) {
      await cliente.query(
        `INSERT INTO tomadores (empresa_id, documento, razao_social, codigo_municipio, uf)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (empresa_id, documento) DO NOTHING`,
        [empresaId, t.documento, t.razaoSocial, t.codigoMunicipio, t.uf]);
      console.log(`Cliente ${t.documento} ${t.razaoSocial}`);
    }

    await cliente.query('COMMIT');

    console.log('\nFalta fazer pelo painel:');
    console.log('  1. Anexar o certificado A1 (.pfx) na aba Certificado');
    console.log('  2. Conferir a numeração antes de emitir em produção');
    console.log('  3. Reconfigurar os webhooks, se houver sistema conectado');
    console.log('  4. Entregar os tokens novos aos sistemas clientes');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
}

principal()
  .then(() => db.pool.end())
  .catch(async e => {
    console.error('Falhou:', e.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
