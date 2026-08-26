const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { somenteAdmin } = require('../middleware/escopo');
const registro = require('../services/registro');
const copia = require('../services/copiaBackup');
const auditoria = require('../services/auditoria');

const router = express.Router();

/* Tudo aqui é de administrador: backup carrega certificado e tokens. */
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

/* Situação da manutenção: o que existe e quando foi a última cópia. */
router.get('/', (_req, res) => {
  const backups = listarArquivos(/^nfse-backup-.*\.json$/);
  const pacotes = listarArquivos(/\.nfsepkg$/);
  res.json({
    pasta: PASTA_BACKUPS,
    pastaLogs: registro.caminhoPasta(),
    ultimoBackup: backups[0] || null,
    backups: backups.slice(0, 20),
    pacotesMigracao: pacotes.slice(0, 10)
  });
});

router.post('/backup', async (_req, res, next) => {
  try {
    const saida = await rodarScript('backup.js', []);
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
      backups: listarArquivos(/^nfse-backup-.*\.json$/).slice(0, 20) });
  } catch (e) { next(e); }
});

/* ------------------------------------------- cópia para fora da máquina */

router.get('/copias', async (_req, res, next) => {
  try { res.json(await copia.situacao()); } catch (e) { next(e); }
});

router.post('/copias', async (req, res, next) => {
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

router.delete('/copias/:id', async (req, res, next) => {
  try {
    await copia.remover(req.params.id);
    await auditoria.registrar(req, null, 'backup.destino',
      'Removeu um destino de backup');
    res.json(await copia.situacao());
  } catch (e) { next(e); }
});

/* Copia agora, sem esperar o backup do dia. É como se confere que o pen drive
   está conectado e que a pasta de rede responde. */
router.post('/copias/copiar', async (req, res, next) => {
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
router.post('/migracao', async (req, res, next) => {
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
  const caminho = path.join(PASTA_BACKUPS, nome);
  if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  fs.unlinkSync(caminho);
  res.json({ ok: true });
});

module.exports = router;
