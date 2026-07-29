/* Consulta de dados públicos para autopreenchimento do cadastro de empresa.
   Feita no servidor (não no navegador) para evitar CORS e normalizar a resposta
   num formato único, com os nomes de campo que o painel já usa.

   Fontes públicas, sem chave:
   - CNPJ: BrasilAPI  (traz razão social, nome fantasia, endereço e IBGE)
   - CEP:  ViaCEP     (traz logradouro, bairro, UF e o código IBGE do município) */

const TIMEOUT_MS = Number(process.env.CONSULTA_TIMEOUT_MS || 8000);

async function buscarJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // User-Agent explícito: a BrasilAPI recusa (403) o UA padrão do fetch.
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'nfse-gateway' }
    });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* não-JSON */ }
    return { status: res.status, json };
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Consulta externa expirou (timeout)'), { status: 504 });
    throw Object.assign(new Error('Falha na consulta externa: ' + e.message), { status: 502 });
  } finally {
    clearTimeout(t);
  }
}

function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

/* Formata "4197511742" -> "(41) 9751-1742" / "(41) 99751-1742"; mantém o que
   não casar como veio. */
function fmtTelefone(d) {
  d = soDigitos(d);
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return d || null;
}

async function consultarCnpj(cnpj) {
  const c = soDigitos(cnpj);
  if (c.length !== 14) throw Object.assign(new Error('CNPJ deve ter 14 dígitos'), { status: 400 });

  const { status, json } = await buscarJson(`https://brasilapi.com.br/api/cnpj/v1/${c}`);
  if (status === 404) throw Object.assign(new Error('CNPJ não encontrado na base pública'), { status: 404 });
  if (status !== 200 || !json) throw Object.assign(new Error('Não foi possível consultar o CNPJ agora'), { status: 502 });

  const ibge = json.codigo_municipio_ibge != null ? String(json.codigo_municipio_ibge) : null;
  return {
    cnpj: c,
    razaoSocial: json.razao_social || null,
    nomeFantasia: json.nome_fantasia || null,
    codigoMunicipio: ibge && /^\d{7}$/.test(ibge) ? ibge : null,
    municipioNome: json.municipio || null,
    uf: json.uf || null,
    cep: soDigitos(json.cep) || null,
    logradouro: json.logradouro || null,
    numero: json.numero || null,
    complemento: json.complemento || null,
    bairro: json.bairro || null,
    telefone: fmtTelefone(json.ddd_telefone_1),
    email: json.email || null
  };
}

async function consultarCep(cep) {
  const c = soDigitos(cep);
  if (c.length !== 8) throw Object.assign(new Error('CEP deve ter 8 dígitos'), { status: 400 });

  const { status, json } = await buscarJson(`https://viacep.com.br/ws/${c}/json/`);
  // ViaCEP responde 200 com { erro: true } para CEP inexistente.
  if (status !== 200 || !json || json.erro) {
    throw Object.assign(new Error('CEP não encontrado'), { status: 404 });
  }
  const ibge = json.ibge ? String(json.ibge) : null;
  return {
    cep: c,
    logradouro: json.logradouro || null,
    complemento: json.complemento || null,
    bairro: json.bairro || null,
    municipioNome: json.localidade || null,
    uf: json.uf || null,
    codigoMunicipio: ibge && /^\d{7}$/.test(ibge) ? ibge : null
  };
}

module.exports = { consultarCnpj, consultarCep };
