const express = require('express');
const nodemailer = require('nodemailer');
const configEmail = require('../services/configEmail');
const resumoPrazos = require('../services/resumoPrazos');
const auditoria = require('../services/auditoria');
const { somenteAdmin } = require('../middleware/escopo');

const router = express.Router();

router.get('/', somenteAdmin, async (_req, res, next) => {
  try {
    res.json({
      config: await configEmail.ler(),
      provedores: configEmail.PROVEDORES,
      // Diz de onde a configuração em uso está vindo, para a tela não afirmar
      // "desligado" quando o .env está configurado
      emUso: !!(await configEmail.efetiva())
    });
  } catch (e) { next(e); }
});

router.put('/', somenteAdmin, async (req, res, next) => {
  try {
    const salvo = await configEmail.salvar(req.body || {});
    await auditoria.registrar(req, null, 'email.config',
      'Alterou a configuração de e-mail',
      { detalhe: { host: salvo.host, ativo: salvo.ativo, resumo: salvo.resumo_diario } });
    res.json(salvo);
  } catch (e) { next(e); }
});

/* Envia um e-mail de teste para o endereço informado.
   Existe porque erro de SMTP aparece tarde: sem o teste, o primeiro sinal de
   configuração errada seria uma nota que não chegou ao cliente. */
router.post('/testar', somenteAdmin, async (req, res, next) => {
  try {
    const destino = (req.body || {}).para;
    if (!destino) return res.status(400).json({ erro: 'Informe o endereço de destino.' });

    const cfg = await configEmail.efetiva();
    if (!cfg) return res.status(400).json({ erro: 'Configure o servidor de e-mail antes de testar.' });

    const t = nodemailer.createTransport({
      host: cfg.host, port: cfg.porta, secure: cfg.seguro,
      auth: cfg.usuario ? { user: cfg.usuario, pass: cfg.senha } : undefined
    });

    try {
      await t.verify();
      await t.sendMail({
        from: cfg.remetente,
        to: destino,
        subject: 'Teste de envio — NFS-e Gateway',
        text: 'Se você recebeu esta mensagem, o envio de e-mail do gateway está funcionando.\n\n' +
              'A partir daqui o sistema pode mandar a nota ao cliente e o resumo de prazos.'
      });
      await configEmail.registrarTeste(null);
      res.json({ ok: true, destino, servidor: cfg.host, origem: cfg.origem });
    } catch (e) {
      await configEmail.registrarTeste(e.message);
      /* A mensagem do servidor SMTP é críptica. Traduzir os casos comuns evita
         que o contador desista achando que o sistema está quebrado. */
      let dica = null;
      if (/invalid login|username and password not accepted|535/i.test(e.message)) {
        dica = 'Usuário ou senha recusados. No Gmail é preciso usar uma SENHA DE APP ' +
               '(myaccount.google.com/apppasswords), não a senha da conta.';
      } else if (/ENOTFOUND|EAI_AGAIN/i.test(e.message)) {
        dica = 'O endereço do servidor não foi encontrado. Confira o campo Servidor.';
      } else if (/ETIMEDOUT|ECONNREFUSED/i.test(e.message)) {
        dica = 'A conexão não foi aceita. Confira a porta (587 com STARTTLS, 465 com TLS) ' +
               'e se o antivírus ou firewall da máquina bloqueia a saída.';
      } else if (/self.signed|certificate/i.test(e.message)) {
        dica = 'O certificado do servidor não foi aceito. Em servidor próprio, confira o TLS.';
      }
      res.status(422).json({ erro: e.message, dica });
    }
  } catch (e) { next(e); }
});

/* Manda o resumo de prazos agora, sem esperar a hora marcada. */
router.post('/resumo', somenteAdmin, async (req, res, next) => {
  try {
    const r = await resumoPrazos.enviar({ forcar: true });
    await auditoria.registrar(req, null, 'email.resumo',
      'Enviou o resumo de prazos para ' + (r.destino || '—'));
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
