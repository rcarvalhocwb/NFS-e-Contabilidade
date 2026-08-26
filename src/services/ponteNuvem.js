/* Ponte com o portal do cliente na nuvem.
 *
 * O escritório opera este gateway numa máquina local; os clientes dele pedem a
 * emissão por um portal na internet. Este módulo é o laço entre os dois.
 *
 * A DIREÇÃO DA CONEXÃO É A DECISÃO CENTRAL. Quem inicia é sempre o gateway: ele
 * busca as solicitações, emite e devolve o resultado. O portal nunca alcança
 * esta máquina.
 *
 * O motivo não é preferência de arquitetura. Esta máquina guarda os
 * certificados A1 e as notas de todos os clientes do escritório. Para o portal
 * alcançá-la, a contabilidade precisaria abrir uma porta no roteador — trocando
 * a segurança do conjunto pela conveniência de um recurso. Puxando, o gateway
 * funciona atrás de qualquer roteador, sem configuração de rede, e o
 * certificado nunca sai daqui.
 *
 * O QUE O PORTAL PRECISA OFERECER (contrato):
 *
 *   GET  {url}/solicitacoes?limite=N
 *        Cabeçalho: Authorization: Bearer {chave}
 *        Devolve: { solicitacoes: [ { id, cnpjEmpresa, servico, valores,
 *                                     tomador, referencia? } ] }
 *
 *   POST {url}/solicitacoes/{id}/resultado
 *        Cabeçalho: Authorization: Bearer {chave}
 *        Corpo: { situacao, chaveAcesso?, numero?, serie?, motivo? }
 *
 * O portal responde 200 com lista vazia quando não há nada — não 404.
 */
const db = require('../db');
const config = require('../config');
const { encrypt, decrypt } = require('../secretbox');
const auditoria = require('./auditoria');

const TIMEOUT_MS = 20000;
let timer = null;

/* Endereços que o gateway se recusa a chamar.
 *
 * A URL é digitada por quem configura, e uma requisição de saída para um
 * endereço interno transforma o gateway num scanner da rede da contabilidade —
 * é a forma clássica de SSRF. Portal de verdade está na internet, com https. */
function validarUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch (_) {
    throw Object.assign(new Error('Endereço inválido. Use o endereço completo, começando com https://'),
      { status: 400 });
  }

  const permiteHttp = process.env.PONTE_PERMITE_HTTP === 'true';
  if (u.protocol !== 'https:' && !permiteHttp) {
    throw Object.assign(new Error(
      'O endereço precisa ser https. As solicitações levam CNPJ, valores e ' +
      'descrição de serviço — dado fiscal de terceiro não trafega em claro.'),
      { status: 400 });
  }

  const host = u.hostname.toLowerCase();
  const interno =
    host === 'localhost' || host.endsWith('.localhost') ||
    /^127\./.test(host) || host === '::1' || host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);          // metadados de nuvem
  if (interno && !permiteHttp) {
    throw Object.assign(new Error(
      'Endereço de rede interna não é aceito. O portal fica na internet; ' +
      'apontar para a rede local faria o gateway varrer a própria rede.'),
      { status: 400 });
  }
  return u.toString().replace(/\/+$/, '');
}

async function ler() {
  const r = await db.query(
    `SELECT id, ativo, url, intervalo_seg, lote, emitir_automatico,
            ultimo_contato, ultimo_erro, erro_em, atualizado_em,
            (chave_cifrada IS NOT NULL) AS tem_chave
       FROM config_nuvem WHERE id = TRUE`);
  return r.rows[0] || {};
}

async function chave() {
  const r = await db.query('SELECT chave_cifrada FROM config_nuvem WHERE id = TRUE');
  if (!r.rows[0] || !r.rows[0].chave_cifrada) return null;
  try {
    return decrypt(r.rows[0].chave_cifrada).toString('utf8');
  } catch (_) {
    throw Object.assign(new Error(
      'Não foi possível abrir a chave do portal. Isso acontece quando a ' +
      'MASTER_KEY do .env muda depois de a chave ser salva. Grave a chave de novo.'),
      { status: 500 });
  }
}

async function salvar(dados = {}) {
  const campos = [];
  const valores = [];
  const põe = (coluna, valor) => {
    valores.push(valor);
    campos.push(`${coluna} = $${valores.length}`);
  };

  if (dados.url !== undefined) {
    põe('url', dados.url ? validarUrl(dados.url) : null);
  }
  if (dados.ativo !== undefined) põe('ativo', !!dados.ativo);
  if (dados.emitirAutomatico !== undefined) põe('emitir_automatico', !!dados.emitirAutomatico);
  if (dados.intervaloSeg !== undefined) {
    const s = Number(dados.intervaloSeg);
    if (!Number.isInteger(s) || s < 15 || s > 3600) {
      throw Object.assign(new Error('O intervalo vai de 15 segundos a 1 hora.'), { status: 400 });
    }
    põe('intervalo_seg', s);
  }
  if (dados.lote !== undefined) {
    const l = Number(dados.lote);
    if (!Number.isInteger(l) || l < 1 || l > 100) {
      throw Object.assign(new Error('O lote vai de 1 a 100 solicitações.'), { status: 400 });
    }
    põe('lote', l);
  }
  // Vazio significa "manter a chave guardada", não apagá-la
  if (dados.chave) põe('chave_cifrada', encrypt(String(dados.chave)));
  if (dados.removerChave) põe('chave_cifrada', null);

  if (campos.length) {
    valores.push(true);
    await db.query(
      `UPDATE config_nuvem SET ${campos.join(', ')}, atualizado_em = now()
        WHERE id = $${valores.length}`, valores);
  }
  return ler();
}

async function chamar(caminho, opcoes = {}) {
  const c = await ler();
  if (!c.url) throw Object.assign(new Error('Portal não configurado.'), { status: 400 });
  const k = await chave();
  if (!k) throw Object.assign(new Error('Chave do portal não configurada.'), { status: 400 });

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(c.url + caminho, {
      method: opcoes.method || 'GET',
      signal: controle.signal,
      headers: Object.assign({
        authorization: 'Bearer ' + k,
        'user-agent': 'nfse-gateway/' + require('../../package.json').version
      }, opcoes.body ? { 'content-type': 'application/json' } : {}),
      body: opcoes.body,
      // O portal não deve redirecionar; seguir um redirecionamento levaria a
      // credencial para um endereço que ninguém configurou.
      redirect: 'error'
    });
    const texto = await resp.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch (_) { dados = { bruto: texto.slice(0, 400) }; }
    return { status: resp.status, dados };
  } finally {
    clearTimeout(prazo);
  }
}

/* Guarda as solicitações trazidas. O id do portal é único aqui: se a mesma
   solicitação vier duas vezes — retentativa, portal reenviando —, ela não vira
   duas notas. */
async function guardar(lista) {
  let novas = 0;
  for (const s of lista) {
    if (!s || !s.id) continue;
    const cnpj = String(s.cnpjEmpresa || '').replace(/[^0-9A-Za-z]/g, '');
    const emp = cnpj
      ? await db.query('SELECT id FROM empresas WHERE cnpj = $1 AND ativo', [cnpj])
      : { rows: [] };

    const r = await db.query(
      `INSERT INTO solicitacoes (id_externo, empresa_id, cnpj_informado, payload, situacao, motivo)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id_externo) DO NOTHING
       RETURNING id`,
      [String(s.id).slice(0, 80), emp.rows[0] ? emp.rows[0].id : null, cnpj || null,
       JSON.stringify(s),
       emp.rows[0] ? 'aguardando' : 'erro',
       emp.rows[0] ? null : `Nenhuma empresa ativa com o CNPJ ${cnpj || '(não informado)'}.`]);
    novas += r.rowCount;
  }
  return novas;
}

/* Campos que uma solicitação vinda da internet pode preencher.
 *
 * Lista fechada, e não por precaução genérica: `numero` e `serie` são aceitos
 * por emitir() para reemissão manual, e quem os controlasse pelo portal
 * escolheria a posição na sequência fiscal da empresa — furando a numeração ou
 * colidindo com nota já emitida. `substituicao` cancela e substitui um
 * documento que já existe; isso é decisão do escritório, não de um formulário
 * na web. O que não está aqui é ignorado, mesmo que o portal mande. */
const CAMPOS_DO_PORTAL = ['tomador', 'servico', 'valores', 'intermediario',
                          'dataCompetencia', 'ibsCbs', 'regApTribSN'];

/* Emite uma solicitação aprovada. Separado da busca de propósito: aprovar é
   decisão, emitir é consequência — e o worker precisa poder reemitir uma que
   falhou sem buscar tudo de novo. */
async function emitirSolicitacao(solicitacao, contexto = {}) {
  const { emitir } = require('./emissaoService');
  const payload = solicitacao.payload || {};

  /* O CNPJ sai da empresa já resolvida, nunca do payload — mesma regra do
     certificado. O empresa_id foi determinado quando a solicitação chegou, e
     é ele que o contador viu e aprovou na tela. Reler o CNPJ do payload aqui
     abriria a porta para a nota sair numa empresa diferente da que foi
     aprovada. */
  const emp = await db.query(
    'SELECT cnpj, razao_social FROM empresas WHERE id = $1 AND ativo',
    [solicitacao.empresa_id]);
  if (!emp.rows.length) {
    const erro = 'A empresa desta solicitação não existe mais ou foi desativada.';
    await db.query(
      `UPDATE solicitacoes SET situacao = 'erro', motivo = $2, devolvida_em = NULL
        WHERE id = $1`, [solicitacao.id, erro]);
    return { ok: false, erro };
  }

  const dados = {
    // A referência amarra a solicitação à nota: se o portal reenviar, a
    // idempotência por referência devolve a mesma nota em vez de emitir outra.
    referencia: 'portal-' + solicitacao.id_externo
  };
  for (const campo of CAMPOS_DO_PORTAL) {
    if (payload[campo] !== undefined) dados[campo] = payload[campo];
  }

  try {
    const r = await emitir(emp.rows[0].cnpj, dados, contexto);

    await db.query(
      `UPDATE solicitacoes SET situacao = 'emitida', nota_id = $2, devolvida_em = NULL
        WHERE id = $1`, [solicitacao.id, r.notaId]);
    return { ok: true, notaId: r.notaId };
  } catch (e) {
    await db.query(
      `UPDATE solicitacoes SET situacao = 'erro', motivo = $2, devolvida_em = NULL
        WHERE id = $1`, [solicitacao.id, e.message]);
    return { ok: false, erro: e.message };
  }
}

/* Devolve ao portal o desfecho do que já foi decidido. */
async function devolverResultados() {
  const pendentes = await db.query(
    `SELECT s.*, n.chave_acesso, n.serie, n.numero, n.status AS status_nota
       FROM solicitacoes s LEFT JOIN notas n ON n.id = s.nota_id
      WHERE s.devolvida_em IS NULL
        AND s.situacao IN ('emitida','recusada','erro')
      ORDER BY s.id LIMIT 50`);

  let devolvidas = 0;
  for (const s of pendentes.rows) {
    // Nota ainda na fila da Sefin: o desfecho não é definitivo, espera a rodada
    if (s.situacao === 'emitida' && s.status_nota === 'processando') continue;

    const corpo = {
      situacao: s.situacao === 'emitida' && s.status_nota === 'rejeitada' ? 'rejeitada' : s.situacao,
      chaveAcesso: s.chave_acesso || undefined,
      serie: s.serie || undefined,
      numero: s.numero || undefined,
      motivo: s.motivo || undefined
    };
    try {
      const r = await chamar(`/solicitacoes/${encodeURIComponent(s.id_externo)}/resultado`,
        { method: 'POST', body: JSON.stringify(corpo) });
      if (r.status >= 200 && r.status < 300) {
        await db.query('UPDATE solicitacoes SET devolvida_em = now() WHERE id = $1', [s.id]);
        devolvidas++;
      }
    } catch (e) {
      console.warn('[ponte] não foi possível devolver a solicitação', s.id_externo + ':', e.message);
      break;   // portal fora do ar: para a rodada em vez de insistir item a item
    }
  }
  return devolvidas;
}

/* Uma rodada completa: busca, guarda, emite o que estiver liberado, devolve. */
async function sincronizar({ forcar = false } = {}) {
  const c = await ler();
  if (!c.ativo && !forcar) return { pulado: 'ponte desligada' };
  if (!c.url) return { pulado: 'portal não configurado' };

  const r = await chamar(`/solicitacoes?limite=${c.lote}`);
  if (r.status < 200 || r.status >= 300) {
    const erro = `O portal respondeu HTTP ${r.status}`;
    await db.query(
      'UPDATE config_nuvem SET ultimo_erro = $1, erro_em = now() WHERE id = TRUE', [erro]);
    throw Object.assign(new Error(erro), { status: 502 });
  }

  const lista = (r.dados && r.dados.solicitacoes) || [];
  const novas = await guardar(lista);

  let emitidas = 0;
  if (c.emitir_automatico) {
    const liberadas = await db.query(
      `SELECT * FROM solicitacoes WHERE situacao = 'aguardando' ORDER BY id LIMIT $1`, [c.lote]);
    for (const s of liberadas.rows) {
      const saida = await emitirSolicitacao(s);
      if (saida.ok) emitidas++;
    }
  }

  const devolvidas = await devolverResultados();

  await db.query(
    `UPDATE config_nuvem SET ultimo_contato = now(), ultimo_erro = NULL, erro_em = NULL
      WHERE id = TRUE`);

  return { recebidas: lista.length, novas, emitidas, devolvidas,
           modo: c.emitir_automatico ? 'automático' : 'aguardando aprovação' };
}

function iniciar() {
  if (timer) return;
  /* A porta dos fundos de desenvolvimento derruba as DUAS travas de endereço:
     o https e a recusa de rede interna. Numa instalação de verdade ela nunca
     deveria estar ligada, então o servidor diz em voz alta que está. */
  if (process.env.PONTE_PERMITE_HTTP === 'true') {
    console.warn('[ponte] ATENÇÃO: PONTE_PERMITE_HTTP=true — o portal pode ser ' +
                 'http e apontar para a rede interna. Só para desenvolvimento.');
  }
  const rodar = async () => {
    try {
      const c = await ler();
      if (!c.ativo) return;
      await sincronizar();
    } catch (e) {
      console.warn('[ponte] rodada falhou:', e.message);
    }
  };
  // O intervalo configurado governa a frequência; o timer roda no menor deles
  timer = setInterval(rodar, 15000);
  timer.unref();
  setTimeout(rodar, 45000).unref();
}

function parar() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  ler, salvar, chave, chamar, sincronizar, guardar, emitirSolicitacao,
  devolverResultados, validarUrl, iniciar, parar
};
