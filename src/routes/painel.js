const express = require('express');
const db = require('../db');
const { version } = require('../../package.json');
const { empresasVisiveis } = require('../middleware/escopo');

const router = express.Router();

/**
 * Resumo para a tela inicial.
 *
 * Uma chamada só: a página de entrada precisa abrir preenchida, e fazer seis
 * requisições em paralelo para montar os cartões deixaria a tela piscando.
 */
router.get('/resumo', async (req, res, next) => {
  try {
    // null = todas as empresas. Cada consulta abaixo repassa isso como $1, e o
    // `IS NULL OR` deixa o filtro inerte nesse caso.
    const ids = empresasVisiveis(req);
    const [notasMes, porStatus, empresas, certificados, ultimas, pendencias] = await Promise.all([
      // Volume e faturamento do mês corrente
      db.query(`
        SELECT count(*)::int AS total,
               coalesce(sum(CASE WHEN status = 'autorizada' THEN 1 ELSE 0 END), 0)::int AS autorizadas
          FROM notas
         WHERE criado_em >= date_trunc('month', now())
           AND ($1::int[] IS NULL OR empresa_id = ANY($1::int[]))`, [ids]),

      db.query(`
        SELECT status, count(*)::int AS total
          FROM notas
         WHERE criado_em >= date_trunc('month', now())
           AND ($1::int[] IS NULL OR empresa_id = ANY($1::int[]))
         GROUP BY status`, [ids]),

      db.query(`
        SELECT count(*)::int AS total,
               coalesce(sum(CASE WHEN ambiente = 'producao' THEN 1 ELSE 0 END), 0)::int AS em_producao
          FROM empresas WHERE ativo
           AND ($1::int[] IS NULL OR id = ANY($1::int[]))`, [ids]),

      // Certificados vencidos ou a vencer: é o que trava a emissão sem aviso
      db.query(`
        SELECT e.cnpj, e.razao_social, c.valido_ate,
               EXTRACT(DAY FROM (c.valido_ate - now()))::int AS dias
          FROM empresas e
          JOIN certificados c ON c.empresa_id = e.id AND c.ativo
         WHERE e.ativo AND c.valido_ate < now() + interval '30 days'
           AND ($1::int[] IS NULL OR e.id = ANY($1::int[]))
         ORDER BY c.valido_ate`, [ids]),

      db.query(`
        SELECT n.id, n.serie, n.numero, n.status, n.chave_acesso, n.ambiente,
               n.criado_em, e.razao_social, e.cnpj
          FROM notas n JOIN empresas e ON e.id = n.empresa_id
         WHERE $1::int[] IS NULL OR n.empresa_id = ANY($1::int[])
         ORDER BY n.id DESC LIMIT 8`, [ids]),

      // Empresas cadastradas que ainda não podem emitir
      db.query(`
        SELECT e.cnpj, e.razao_social
          FROM empresas e
         WHERE e.ativo
           AND NOT EXISTS (SELECT 1 FROM certificados c
                            WHERE c.empresa_id = e.id AND c.ativo)
           AND ($1::int[] IS NULL OR e.id = ANY($1::int[]))`, [ids])
    ]);

    const status = {};
    porStatus.rows.forEach(r => { status[r.status] = r.total; });

    res.json({
      versao: version,
      mes: {
        total: notasMes.rows[0].total,
        autorizadas: notasMes.rows[0].autorizadas,
        porStatus: status
      },
      empresas: empresas.rows[0],
      alertas: {
        certificados: certificados.rows,
        semCertificado: pendencias.rows
      },
      ultimasNotas: ultimas.rows
    });
  } catch (e) { next(e); }
});

module.exports = router;
