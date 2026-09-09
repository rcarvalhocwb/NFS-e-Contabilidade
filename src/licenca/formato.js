const crypto = require('crypto');

/* A licença: um JSON assinado que cabe numa linha.
 *
 * O que ela É: uma declaração assinada de quem contratou, até quando, e com
 * quantos terminais. Verificável sem internet, impossível de alterar sem a
 * chave privada.
 *
 * O que ela NÃO É: uma trava. Quem tem a máquina apaga a conferência — o
 * gateway é JavaScript legível em disco. O que a assinatura garante não é que
 * ninguém burle: é que ninguém FABRIQUE uma licença que o gateway aceite. São
 * coisas diferentes, e só a segunda é alcançável.
 *
 * Ed25519 e não RSA: a assinatura tem 64 bytes contra 256, e a licença inteira
 * cabe num e-mail sem quebrar linha. Vem do próprio Node, sem dependência nova
 * — e dependência nova num sistema que assina documento fiscal é coisa que se
 * evita por princípio.
 *
 * FORMATO NA LINHA:  <corpo em base64url>.<assinatura em base64url>
 *
 * O corpo NÃO é cifrado, de propósito. Não há segredo nele: o cliente tem o
 * direito de ler o que contratou, e uma licença que só o fornecedor entende é
 * um convite à desconfiança de quem paga.
 */

const VERSAO_FORMATO = 1;

/* Campos que toda licença precisa ter para ser aceita. A ausência de qualquer
   um significa licença de outra versão, ou adulterada de forma canhestra. */
const OBRIGATORIOS = ['v', 'id', 'escritorio', 'plano', 'emitido_em', 'valido_ate'];

const PLANOS = ['mensal', 'anual'];

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(txt) {
  const s = String(txt).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - s.length % 4) % 4), 'base64');
}

/* Serialização estável: a assinatura cobre BYTES, e `JSON.stringify` não
   promete ordem de chave entre versões do Node. Ordenar aqui evita uma
   licença que verifica numa máquina e falha na outra — o tipo de defeito que
   só aparece no cliente, meses depois. */
function canonico(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonico).join(',') + ']';
  const chaves = Object.keys(obj).sort();
  return '{' + chaves.map(k => JSON.stringify(k) + ':' + canonico(obj[k])).join(',') + '}';
}

/**
 * Assina os dados e devolve a licença em uma linha.
 * @param dados   o conteúdo da licença (sem `v`, que é acrescentado aqui)
 * @param chavePrivadaPem  PEM Ed25519 — NUNCA sai da máquina de quem emite
 */
function assinar(dados, chavePrivadaPem) {
  const corpo = Object.assign({ v: VERSAO_FORMATO }, dados);
  conferirForma(corpo);
  const bytes = Buffer.from(canonico(corpo), 'utf8');
  const chave = crypto.createPrivateKey(chavePrivadaPem);
  if (chave.asymmetricKeyType !== 'ed25519') {
    throw new Error('A chave de assinatura precisa ser Ed25519.');
  }
  const assinatura = crypto.sign(null, bytes, chave);
  return b64url(bytes) + '.' + b64url(assinatura);
}

/**
 * Confere a assinatura e devolve o conteúdo.
 *
 * Devolve SEMPRE um objeto — nunca lança por licença ruim. Quem chama precisa
 * decidir o que fazer com uma licença inválida, e no gateway a decisão é
 * "avisa e segue emitindo". Uma exceção aqui viraria, lá em cima, um
 * `catch` genérico e a tentação de tratar como falha do sistema.
 *
 * @returns { valida, motivo, dados }
 */
function verificar(licenca, chavePublicaPem) {
  if (!licenca || typeof licenca !== 'string') {
    return { valida: false, motivo: 'sem licença', dados: null };
  }
  const partes = licenca.trim().split('.');
  if (partes.length !== 2) {
    return { valida: false, motivo: 'formato irreconhecível', dados: null };
  }

  let bytes, dados;
  try {
    bytes = deB64url(partes[0]);
    dados = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    return { valida: false, motivo: 'conteúdo ilegível', dados: null };
  }

  let confere = false;
  try {
    confere = crypto.verify(null, bytes, crypto.createPublicKey(chavePublicaPem),
      deB64url(partes[1]));
  } catch (_) {
    return { valida: false, motivo: 'assinatura ilegível', dados: null };
  }
  if (!confere) {
    /* O caso que importa: alguém editou o vencimento ou o CNPJ. Os dados VÃO
       junto na resposta, porque quem atende o telefone precisa saber o que a
       pessoa tentou usar — mas com `valida: false`, e nenhum caminho do
       sistema pode agir sobre dados de licença não verificada. */
    return { valida: false, motivo: 'assinatura não confere', dados };
  }

  try {
    conferirForma(dados);
  } catch (e) {
    return { valida: false, motivo: e.message, dados };
  }
  if (dados.v !== VERSAO_FORMATO) {
    return { valida: false, motivo: 'licença de outra versão do formato (v' + dados.v + ')', dados };
  }

  return { valida: true, motivo: null, dados };
}

function conferirForma(d) {
  for (const campo of OBRIGATORIOS) {
    if (d[campo] === undefined || d[campo] === null) {
      throw new Error('licença sem o campo "' + campo + '"');
    }
  }
  if (!PLANOS.includes(d.plano)) {
    throw new Error('plano desconhecido: ' + d.plano);
  }
  if (!d.escritorio.cnpj || !/^\d{14}$/.test(String(d.escritorio.cnpj))) {
    throw new Error('CNPJ do escritório inválido na licença');
  }
  for (const data of ['emitido_em', 'valido_ate']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d[data]))) {
      throw new Error('data "' + data + '" fora do formato AAAA-MM-DD');
    }
  }
}

/* Gera o par de chaves. Roda UMA VEZ, na máquina de quem emite licenças.
   A privada nunca entra no repositório: o repositório é privado, mas o
   instalador é montado a partir dele — chave lá dentro é chave que um dia
   viaja dentro de um .exe. */
function gerarParDeChaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publica: publicKey.export({ type: 'spki', format: 'pem' }),
    privada: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

module.exports = { assinar, verificar, gerarParDeChaves, canonico, VERSAO_FORMATO, PLANOS };
