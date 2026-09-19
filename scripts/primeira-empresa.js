#!/usr/bin/env node
/**
 * A primeira empresa, o primeiro serviço e o primeiro número autorizado.
 *
 * Chamado só na instalação NOVA, quando o assistente ofereceu comissionar e a
 * pessoa aceitou. Existe porque "instalado" e "pronto para emitir" são estados
 * diferentes, e a distância entre eles era invisível:
 *
 *   - sem empresa, não há o que emitir;
 *   - sem serviço, o pedido por WhatsApp responde "fale com o escritório" e
 *     encerra — educadamente, sem erro em log nenhum, que é a falha mais cara
 *     de diagnosticar;
 *   - sem número autorizado, ninguém chega sequer a fazer o pedido.
 *
 * Os três eram tarefa de "depois, no painel". Depois costuma ser nunca.
 *
 * AMBIENTE: a empresa nasce em HOMOLOGAÇÃO, sempre. Uma instalação recém-feita
 * com certificado recém-enviado emitindo direto em produção é como se descobre,
 * pela via cara, que o código do município estava errado. Quem vira a chave é
 * uma pessoa, no painel, depois de ver uma nota de teste sair certa.
 *
 * NADA aqui é fatal. Cada etapa que falha vira pendência no relatório e a
 * instalação segue: um CNPJ digitado errado não pode custar o gateway inteiro.
 * O que este script não conseguir fazer, ele escreve — em vez de fingir.
 *
 * Os dados vêm pela variável NFSE_PRIMEIRA_EMPRESA, em JSON. Não por argumento
 * de linha de comando: a senha do certificado está aí dentro, e linha de comando
 * aparece no gerenciador de tarefas.
 */
const fs = require('fs');
const crypto = require('crypto');
const db = require('../src/db');

const pendencias = [];
const feito = [];

function pendente(o_que, por_que) {
  pendencias.push({ item: o_que, motivo: por_que });
}

/* ------------------------------------------------------------- a empresa */

async function garantirEmpresa(d) {
  const cnpj = String(d.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) {
    pendente('empresa', 'CNPJ com ' + cnpj.length + ' dígitos, esperava 14');
    return null;
  }

  /* Idempotente de propósito: reinstalar por cima não pode criar uma segunda
     empresa com o mesmo CNPJ, nem estourar no UNIQUE e derrubar o resto. */
  const existe = await db.query('SELECT id, razao_social FROM empresas WHERE cnpj = $1', [cnpj]);
  if (existe.rows.length) {
    feito.push('empresa ' + cnpj + ' já existia — reaproveitada');
    return existe.rows[0].id;
  }

  /* O regime é DESTA empresa, não do escritório.
   *
   * A contabilidade atende dezenas de clientes com enquadramentos diferentes —
   * um MEI, um ME do Simples, uma sociedade no lucro presumido — e o regime
   * decide PARA ONDE a nota vai: ME/EPP do Simples emitem exclusivamente pelo
   * Emissor Nacional. Por isso ele é campo do cadastro da empresa, aqui e no
   * painel, e não uma configuração da instalação.
   *
   * 1 = não optante · 2 = MEI · 3 = ME/EPP do Simples. Valor fora disso vira 1,
   * que é o que a rota de cadastro também assume — e fica corrigível no painel. */
  const regime = [1, 2, 3].includes(Number(d.regime)) ? Number(d.regime) : 1;

  const r = await db.query(
    `INSERT INTO empresas (cnpj, razao_social, inscricao_municipal, codigo_municipio,
                           op_simp_nac, reg_esp_trib, ambiente)
     VALUES ($1,$2,$3,$4,$5,$6,'homologacao')
     RETURNING id`,
    [cnpj, String(d.razaoSocial || '').trim(),
     String(d.inscricaoMunicipal || '').trim() || null,
     String(d.municipio || '').replace(/\D/g, ''),
     regime, 0]
  );
  const id = r.rows[0].id;

  /* A numeração dos dois ambientes nasce junto, como na rota de cadastro: a
     série precisa poder ser definida antes da primeira emissão. */
  await db.query(
    `INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
     VALUES ($1,'homologacao','1',1), ($1,'producao','1',1)
     ON CONFLICT (empresa_id, ambiente) DO NOTHING`, [id]);

  /* E os tokens de integração, pelo mesmo motivo que na rota: a empresa nasce
     pronta para integrar, sem passo manual depois. Eles não são exibidos aqui —
     ninguém lê o log da instalação com o cuidado que uma credencial pede. Quem
     precisar gera outro no painel, que é onde aparece uma vez só. */
  for (const ambiente of ['homologacao', 'producao']) {
    await db.query(
      `INSERT INTO empresa_tokens (empresa_id, ambiente, token_hash, descricao)
       VALUES ($1,$2,$3,'Gerado na instalação')
       ON CONFLICT (empresa_id, ambiente) DO NOTHING`,
      [id, ambiente,
       crypto.createHash('sha256').update(crypto.randomBytes(24).toString('hex'))
         .digest('hex')]);
  }

  const NOME_REGIME = { 1: 'não optante', 2: 'MEI', 3: 'ME/EPP do Simples' };
  feito.push('empresa ' + cnpj + ' cadastrada em homologação, ' +
    NOME_REGIME[regime] + ' pelo Simples Nacional');
  return id;
}

/* -------------------------------------------------------- o certificado */

async function guardarCertificado(empresaId, d) {
  if (!d.certificadoArquivo) {
    pendente('certificado A1',
      'não foi informado na instalação. Sem ele o sistema cadastra e organiza, ' +
      'mas não assina nota. Envie no painel, em Empresas > Certificado.');
    return;
  }

  let pfx;
  try {
    pfx = fs.readFileSync(d.certificadoArquivo);
  } catch (e) {
    pendente('certificado A1', 'não consegui ler o arquivo: ' + e.message);
    return;
  }

  try {
    const { salvarCertificado } = require('../src/services/certificadoService');
    const info = await salvarCertificado(empresaId, pfx, String(d.certificadoSenha || ''));
    feito.push('certificado guardado, válido até ' +
      new Date(info.valido_ate).toLocaleDateString('pt-BR'));

    /* O CNPJ do certificado tem de bater com o da empresa. Não bater não impede
       de guardar — mas impede de assinar, e é melhor descobrir agora do que na
       primeira nota. */
    const cnpjEmpresa = (await db.query('SELECT cnpj FROM empresas WHERE id = $1',
      [empresaId])).rows[0].cnpj;
    if (info.cnpj_cert && info.cnpj_cert.replace(/\D/g, '') !== cnpjEmpresa) {
      pendente('certificado A1',
        'o certificado é do CNPJ ' + info.cnpj_cert + ', e a empresa cadastrada ' +
        'é ' + cnpjEmpresa + '. Um não assina pelo outro.');
    }
  } catch (e) {
    /* Senha errada é o caso comum, e `lerPfx` já devolve a mensagem certa. */
    pendente('certificado A1', e.message);
  }
}

/* ------------------------------------------------------------ o serviço */

async function criarServico(empresaId, d) {
  const apelido = String(d.apelido || '').trim();
  const codigo = String(d.codigoTributacao || '').replace(/\D/g, '');
  const descricao = String(d.descricao || '').trim();

  if (!apelido || codigo.length !== 6 || !descricao) {
    pendente('primeiro serviço',
      'faltou apelido, código de tributação (6 dígitos) ou descrição. Sem ao ' +
      'menos um serviço, o pedido por WhatsApp responde "fale com o escritório" ' +
      'e para por aí.');
    return;
  }

  /* Vírgula decimal: é como se digita valor no Brasil, e o assistente aceita
     assim. `Number('1500,00')` é NaN e gravaria nulo em silêncio. */
  const bruto = String(d.valorPadrao || '').trim().replace(/\./g, '').replace(',', '.');
  const valor = bruto && !Number.isNaN(Number(bruto)) ? Number(bruto) : null;

  await db.query(
    `INSERT INTO servicos (empresa_id, apelido, codigo_tributacao, descricao, valor_padrao)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (empresa_id, apelido) DO NOTHING`,
    [empresaId, apelido, codigo, descricao, valor]);

  feito.push('serviço "' + apelido + '" cadastrado');
}

/* -------------------------------------------------- o número autorizado */

async function autorizarNumero(empresaId, d) {
  if (!d.whatsappNumero) return;

  try {
    const contatos = require('../src/services/contatosWhatsapp');
    await contatos.acrescentar({
      empresaId,
      telefone: String(d.whatsappNumero),
      nome: String(d.whatsappNome || 'Cadastrado na instalação'),
      cargo: null,
      limiteValor: null
    });
    feito.push('número ' + d.whatsappNumero + ' autorizado a pedir notas');

    /* E a empresa passa a aceitar pedido vindo de fora.
     *
     * `portal_liberado` nasce FALSE de propósito — "liberar é ato do contador",
     * diz a migração que a criou, e o padrão fechado existe para que credenciar
     * um cliente não credencie os outros nove por tabela.
     *
     * Autorizar um número a pedir nota em nome desta empresa É esse ato. Quem
     * digitou o número no assistente é o contador, e fez isso escolhendo a
     * empresa na tela anterior. Cadastrar a autorização e deixar a empresa
     * recusando produziria exatamente o que o ensaio pegou aqui: a conversa
     * respondendo "a contabilidade ainda não liberou" a quem acabou de ser
     * liberado — sem erro em log nenhum, e sem pista de onde resolver.
     *
     * O que NÃO se faz é liberar quem não pediu: sem número autorizado, a
     * empresa continua fechada, como sempre esteve. E a decisão fica assinada,
     * para a auditoria saber que veio da instalação e não de um clique perdido.
     */
    await db.query(
      `UPDATE empresas
          SET portal_liberado = TRUE,
              portal_decidido_por = 'instalação',
              portal_decidido_em = now()
        WHERE id = $1 AND NOT portal_liberado`, [empresaId]);
    feito.push('empresa liberada para receber pedidos pelo WhatsApp');
  } catch (e) {
    /* Número repetido não é erro: reinstalação passa por aqui de novo. */
    if (e.code === '23505') {
      feito.push('número ' + d.whatsappNumero + ' já estava autorizado');
      return;
    }
    pendente('número do WhatsApp', e.message);
  }
}

/* ---------------------------------------------------------------- saída */

async function principal() {
  const bruto = process.env.NFSE_PRIMEIRA_EMPRESA;
  if (!bruto) {
    console.error('NFSE_PRIMEIRA_EMPRESA não informada.');
    process.exit(2);
  }

  let d;
  try {
    d = JSON.parse(bruto);
  } catch (e) {
    console.error('NFSE_PRIMEIRA_EMPRESA não é JSON válido: ' + e.message);
    process.exit(2);
  }

  const empresaId = await garantirEmpresa(d);
  if (empresaId) {
    /* Em série e não em paralelo: se o certificado falhar, quero a pendência
       dele antes de o serviço reclamar de outra coisa. Relatório em ordem de
       causa é o que alguém consegue ler às onze da noite de uma sexta. */
    await guardarCertificado(empresaId, d);
    await criarServico(empresaId, d);
    await autorizarNumero(empresaId, d);
  }

  console.log(JSON.stringify({ feito, pendencias }, null, 2));
  await db.pool.end();

  /* Sai 0 mesmo com pendência: elas são recado, não falha. Sair diferente de
     zero faria o configurar.ps1 tratar uma empresa cadastrada sem certificado
     como instalação quebrada. */
  process.exit(0);
}

/* Em qual escritório a primeira empresa nasce.
 *
 * Toda tabela de inquilino tem `escritorio_id NOT NULL` com padrão
 * `inquilino_atual()`. Sem amarrar, o padrão devolve NULL e a gravação morre
 * com "null value in column escritorio_id" — foi assim que o ensaio de
 * instalação pegou isto, antes de o instalador chegar a uma máquina real.
 *
 * Numa instalação de mesa há um escritório só, e é nele. Num servidor com
 * vários, cadastrar a "primeira empresa" pela linha de comando é ambíguo:
 * exige --escritorio, porque escolher por conta própria seria pôr a empresa
 * na carteira de outra casa. */
async function escritorioAlvo() {
  const pedido = process.argv.indexOf('--escritorio');
  if (pedido >= 0 && process.argv[pedido + 1]) return Number(process.argv[pedido + 1]);

  const ids = (await db.comServidor(() => db.query(
    'SELECT * FROM escritorios_ativos() AS id'))).rows.map(r => r.id);

  if (!ids.length) {
    throw new Error('Nenhum escritório no banco. Rode as migrações antes.');
  }
  if (ids.length > 1) {
    throw new Error('Há ' + ids.length + ' escritórios neste servidor (' + ids.join(', ') +
                    '). Informe em qual cadastrar: --escritorio N');
  }
  return ids[0];
}

escritorioAlvo()
  .then(id => db.comInquilino(id, principal))
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
