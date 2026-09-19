const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { somenteAdmin, somenteOperador } = require('../middleware/escopo');
const registro = require('../services/registro');
const copia = require('../services/copiaBackup');
const auditoria = require('../services/auditoria');

const router = express.Router();

/* Tudo aqui é de administrador: backup carrega certificado e tokens.

   Algumas rotas exigem mais que isso. Endereço e certificado TLS do servidor,
   destinos de backup em disco, reiniciar, pacote de migração: nada disso é de
   um escritório, é da máquina em que todos estão. Num servidor com vários
   inquilinos, deixá-las com o administrador de um é deixar um cliente mexer na
   infraestrutura dos outros — elas levam `somenteOperador`, que numa
   instalação de mesa continua aceitando o administrador, porque lá ele é o
   operador. */
router.use(somenteAdmin);

const RAIZ = path.join(__dirname, '..', '..');
const PASTA_BACKUPS = process.env.BACKUP_PASTA || path.join(RAIZ, 'backups');

/* Roda um script da pasta scripts/ em processo separado.
   Separado, e não em linha, porque um backup grande não pode segurar o event
   loop que atende a emissão de notas. */
function rodarScript(nome, args, env) {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [path.join(RAIZ, 'scripts', nome), ...args], {
      cwd: RAIZ,
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let saida = '';
    filho.stdout.on('data', d => { saida += d; });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('close', codigo => {
      if (codigo === 0) resolve(saida);
      else reject(Object.assign(new Error(saida.trim().split('\n').pop() || 'falhou'), { status: 400 }));
    });
    filho.on('error', reject);
  });
}

function listarArquivos(padrao) {
  if (!fs.existsSync(PASTA_BACKUPS)) return [];
  return fs.readdirSync(PASTA_BACKUPS)
    .filter(f => padrao.test(f))
    .map(f => {
      const st = fs.statSync(path.join(PASTA_BACKUPS, f));
      return { nome: f, tamanho: st.size, criado_em: st.mtime.toISOString() };
    })
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

/* Nome de arquivo de backup, com o escritório dentro: nfse-backup-e3-....json
   O escritório entra no NOME porque é o que permite recusar o download do
   arquivo alheio sem precisar abrir e inspecionar o conteúdo. */
function meusBackups(escritorioId) {
  return new RegExp(`^nfse-backup-e${Number(escritorioId)}-.*\\.json$`);
}

/* Um arquivo é meu quando o nome diz que é. Nome sem escritório é de antes da
   separação, quando o banco era de uma casa só — some da lista de todo mundo
   em vez de aparecer para qualquer um. */
function arquivoDoEscritorio(nome, escritorioId) {
  const m = String(nome).match(/^nfse-(?:backup|migracao|[\w.-]+)-e(\d+)-/);
  return !!m && Number(m[1]) === Number(escritorioId);
}

/* Situação da manutenção: o que existe e quando foi a última cópia. */
router.get('/', (req, res) => {
  const backups = listarArquivos(meusBackups(req.escritorioId));
  const pacotes = listarArquivos(/\.nfsepkg$/)
    .filter(a => arquivoDoEscritorio(a.nome, req.escritorioId));
  res.json({
    pasta: PASTA_BACKUPS,
    pastaLogs: registro.caminhoPasta(),
    ultimoBackup: backups[0] || null,
    backups: backups.slice(0, 20),
    pacotesMigracao: pacotes.slice(0, 10)
  });
});

/* O backup é DO ESCRITÓRIO de quem pediu.
   Antes era do banco inteiro, o que dava no mesmo quando o banco era de uma
   casa só. Agora seria a carteira de clientes de todo mundo num arquivo que
   um administrador qualquer baixa — por um caminho que não passa por consulta
   nenhuma, e que portanto a RLS não alcança. */
router.post('/backup', async (req, res, next) => {
  try {
    const escritorio = req.escritorioId;
    if (!escritorio) {
      return res.status(400).json({
        erro: 'Não sei de qual escritório é este backup. Entre pelo painel.'
      });
    }
    const saida = await rodarScript('backup.js', ['--escritorio', String(escritorio)]);
    const linha = saida.split('\n').find(l => l.includes('registros em')) || '';

    /* Gerar e levar para fora são um gesto só. Separar deixaria o backup de pé
       na tela com a cópia externa três dias atrasada e ninguém percebendo. */
    let externa = null;
    try {
      externa = await copia.copiar();
    } catch (e) {
      externa = { erro: e.message, destinos: [] };
    }

    res.json({ ok: true, resumo: linha.trim(), externa,
      backups: listarArquivos(meusBackups(escritorio)).slice(0, 20) });
  } catch (e) { next(e); }
});

/* Diagnóstico de rede. De administrador porque mostra os endereços da máquina
   na rede do escritório. */
/* Como está o sistema por baixo: início automático, banco, backup,
   certificado. Era um script de PowerShell — que funciona para quem escreve
   comandos e não para quem opera a contabilidade. */
router.get('/sistema', async (_req, res, next) => {
  try { res.json(await require('../services/saudeSistema').ler()); }
  catch (e) { next(e); }
});

/* Reiniciar o gateway por ele mesmo. É a operação que mais se repete, porque
   toda atualização pede uma. Só funciona quando ele foi aberto pela tarefa do
   Windows — do contrário não tem privilégio, e a resposta diz o que fazer. */
router.post('/sistema/reiniciar', somenteOperador, async (req, res, next) => {
  try {
    const r = await require('../services/saudeSistema').reiniciar();
    await auditoria.registrar(req, null, 'sistema.reiniciar',
      'Reiniciou o gateway pela tela');
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

/* De onde o painel aceita conexão, e se é criptografada. Saiu do .env porque
   editar arquivo de configuração no bloco de notas é onde o operador trava. */
router.get('/rede/config', somenteOperador, async (_req, res, next) => {
  try {
    const s = require('../services/configRede');
    const c = await s.ler();
    res.json(Object.assign(c, {
      enderecos: s.enderecosDaMaquina(),
      hostDoAmbiente: process.env.HOST || null
    }));
  } catch (e) { next(e); }
});

router.put('/rede/config', somenteOperador, async (req, res, next) => {
  try {
    const s = require('../services/configRede');
    const antes = await s.ler();
    const depois = await s.salvar(req.body || {});
    await auditoria.registrar(req, null, 'rede.config',
      'Alterou o acesso pela rede: escuta=' + depois.escuta +
      ', https=' + depois.https_ativo);
    res.json(Object.assign(depois, {
      precisaReiniciar: s.precisaReiniciar(antes, depois)
    }));
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

router.post('/rede/certificado', somenteOperador, async (req, res, next) => {
  try {
    const s = require('../services/configRede');
    const b = req.body || {};
    /* Gerar leva alguns segundos (2048 bits): é o preço de não depender de
       ninguém emitir certificado para uma rede de escritório. */
    const r = b.certPem && b.chavePem
      ? await s.guardarCertificado(b.certPem, b.chavePem)
      : await s.gerarCertificado();
    await auditoria.registrar(req, null, 'rede.certificado',
      'Gerou ou substituiu o certificado do painel: ' + r.assunto);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

router.get('/rede', async (_req, res, next) => {
  try { res.json(await require('../services/diagnosticoRede').completo()); }
  catch (e) { next(e); }
});

/* ------------------------------------------- cópia para fora da máquina */

router.get('/copias', somenteOperador, async (_req, res, next) => {
  try { res.json(await copia.situacao()); } catch (e) { next(e); }
});

router.post('/copias', somenteOperador, async (req, res, next) => {
  try {
    const d = await copia.acrescentar(req.body || {});
    await auditoria.registrar(req, null, 'backup.destino',
      'Cadastrou o destino de backup ' + (req.body || {}).caminho);
    res.status(201).json(await copia.situacao());
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

router.delete('/copias/:id', somenteOperador, async (req, res, next) => {
  try {
    await copia.remover(req.params.id);
    await auditoria.registrar(req, null, 'backup.destino',
      'Removeu um destino de backup');
    res.json(await copia.situacao());
  } catch (e) { next(e); }
});

/* Copia agora, sem esperar o backup do dia. É como se confere que o pen drive
   está conectado e que a pasta de rede responde. */
router.post('/copias/copiar', somenteOperador, async (req, res, next) => {
  try {
    res.json(await copia.copiar({ apenas: req.body && req.body.id ? Number(req.body.id) : undefined }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

/* Pacote de migração: leva dados E chaves para outra máquina. A senha vai por
   variável de ambiente, não por argumento — argumento aparece na lista de
   processos da máquina. */
router.post('/migracao', somenteOperador, async (req, res, next) => {
  try {
    const senha = (req.body || {}).senha;
    if (!senha || String(senha).length < 8) {
      return res.status(400).json({ erro: 'Escolha uma senha de ao menos 8 caracteres para o arquivo' });
    }
    const saida = await rodarScript('exportar-migracao.js', [], { NFSE_SENHA_MIGRACAO: String(senha) });
    const linha = saida.split('\n').find(l => l.includes('Pacote cifrado')) || '';
    res.json({ ok: true, resumo: linha.trim(), pacotes: listarArquivos(/\.nfsepkg$/).slice(0, 10) });
  } catch (e) { next(e); }
});

/* Baixar um arquivo da pasta de backups. */
router.get('/arquivo/:nome', (req, res) => {
  // Só o nome, nunca um caminho: sem isso um ../../.env sairia por aqui.
  const nome = path.basename(String(req.params.nome));
  if (!/^nfse-(backup-.*\.json|migracao-.*\.nfsepkg)$/.test(nome)) {
    return res.status(400).json({ erro: 'Arquivo inválido' });
  }
  /* A conferência decisiva. O backup de um escritório carrega o certificado
     A1 cifrado, os tokens e a carteira inteira de clientes dele; o nome do
     arquivo é previsível (data e id). Sem esta linha, bastava pedir o do
     vizinho para levar tudo — e nenhuma policy de RLS veria passar, porque
     não há consulta no caminho, só um fluxo de disco. */
  if (!arquivoDoEscritorio(nome, req.escritorioId)) {
    return res.status(404).json({ erro: 'Arquivo não encontrado' });
  }
  const caminho = path.join(PASTA_BACKUPS, nome);
  if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo não encontrado' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  fs.createReadStream(caminho).pipe(res);
});

router.delete('/arquivo/:nome', (req, res) => {
  const nome = path.basename(String(req.params.nome));
  if (!/^nfse-(backup-.*\.json|migracao-.*\.nfsepkg)$/.test(nome)) {
    return res.status(400).json({ erro: 'Arquivo inválido' });
  }
  // Apagar o backup do vizinho é tão grave quanto baixá-lo.
  if (!arquivoDoEscritorio(nome, req.escritorioId)) {
    return res.status(404).json({ erro: 'Arquivo não encontrado' });
  }
  const caminho = path.join(PASTA_BACKUPS, nome);
  if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  fs.unlinkSync(caminho);
  res.json({ ok: true });
});

module.exports = router;
