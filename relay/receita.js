/* Consulta pública de CNPJ, feita AQUI e não no gateway.
 *
 * A resolução morava do outro lado, e por isso o cliente nunca via os dados: a
 * conversa acabava, o gateway buscava o CNPJ minutos depois, e se a razão
 * social estivesse desatualizada ninguém percebia até a nota sair errada.
 *
 * Consultando aqui, os dados aparecem na hora e a pessoa confirma ou corrige —
 * ela conhece o cliente dela melhor do que uma base pública que pode estar
 * meses atrasada.
 *
 * O gateway continua conferindo o dígito verificador e o cadastro por conta
 * própria. Isto aqui é conveniência, não autoridade: nada do que este arquivo
 * devolve entra numa nota sem o outro lado aprovar.
 *
 * BrasilAPI, pública e sem chave. Se estiver fora do ar, a conversa segue pelo
 * caminho manual em vez de travar.
 */

const TIMEOUT_MS = Number(process.env.CONSULTA_TIMEOUT_MS || 6000);

function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

async function consultarCnpj(cnpj) {
  const c = soDigitos(cnpj);
  if (c.length !== 14) return null;

  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + c, {
      signal: ctrl.signal,
      // A BrasilAPI recusa (403) o User-Agent padrão do fetch
      headers: { Accept: 'application/json', 'User-Agent': 'nfse-relay' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.razao_social) return null;

    const ibge = String(j.codigo_municipio_ibge || j.municipio_ibge || '');
    return {
      documento: c,
      nome: j.razao_social,
      fantasia: j.nome_fantasia || null,
      situacao: j.descricao_situacao_cadastral || null,
      logradouro: [j.descricao_tipo_de_logradouro, j.logradouro]
        .filter(Boolean).join(' ').trim() || null,
      numero: j.numero || null,
      complemento: j.complemento || null,
      bairro: j.bairro || null,
      cep: soDigitos(j.cep) || null,
      uf: j.uf || null,
      municipio: j.municipio || null,
      codigoMunicipio: /^\d{7}$/.test(ibge) ? ibge : null
    };
  } catch (_) {
    /* Timeout ou base fora do ar. Devolver null é de propósito: a conversa cai
       no caminho manual em vez de travar num serviço que não é nosso. */
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

/* O endereço como se lê, para a pessoa conferir. Uma linha só — no WhatsApp
   ninguém lê um bloco de seis campos. */
function enderecoEmUmaLinha(d) {
  if (!d || !d.logradouro) return null;
  const rua = [d.logradouro, d.numero].filter(Boolean).join(', ');
  const resto = [d.bairro, d.municipio, d.uf].filter(Boolean).join(' · ');
  return [rua, resto].filter(Boolean).join(' — ');
}

module.exports = { consultarCnpj, enderecoEmUmaLinha, soDigitos };
