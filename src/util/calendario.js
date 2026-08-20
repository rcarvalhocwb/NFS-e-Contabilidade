/* Compromissos no formato iCalendar (.ics), RFC 5545.
 *
 * É como o prazo chega ao celular do contador. O arquivo vai anexado ao aviso
 * por e-mail; quem recebe toca uma vez e o compromisso entra na agenda — Google,
 * Outlook, Apple, qualquer uma — já com alarme.
 *
 * Por que não integrar direto com a API do Google Agenda: exigiria projeto no
 * Google Cloud, tela de consentimento, verificação do aplicativo e guarda de
 * tokens de terceiro; ou então que o Google alcançasse este gateway pela
 * internet, o que a instalação evita de propósito. O .ics entrega a mesma
 * notificação no celular sem nada disso, e não amarra o escritório a um
 * fornecedor de agenda.
 */

/* Datas em UTC, no formato compacto que o RFC pede: 20260920T110000Z */
function carimbo(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/* Dia inteiro usa data local pura (VALUE=DATE), sem hora nem fuso: um prazo é
   do dia, não das 9h do dia. */
function dia(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}` +
         `${String(d.getDate()).padStart(2, '0')}`;
}

/* Escapa conforme o RFC: vírgula, ponto e vírgula, barra invertida e quebra de
   linha têm significado no formato e passariam a cortar o campo. */
function esc(texto) {
  return String(texto == null ? '' : texto)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/* Linhas acima de 75 octetos precisam ser dobradas, senão agendas rigorosas
   recusam o arquivo inteiro. A continuação começa com um espaço. */
function dobrar(linha) {
  const bytes = Buffer.from(linha, 'utf8');
  if (bytes.length <= 75) return linha;
  const partes = [];
  let atual = '';
  for (const ch of linha) {
    const tentativa = atual + ch;
    if (Buffer.from(tentativa, 'utf8').length > (partes.length ? 74 : 75)) {
      partes.push(atual);
      atual = ch;
    } else {
      atual = tentativa;
    }
  }
  if (atual) partes.push(atual);
  return partes[0] + '\r\n ' + partes.slice(1).join('\r\n ');
}

/**
 * Monta um .ics com um ou mais compromissos.
 *
 * @param eventos  [{ id, titulo, descricao, data (Date|YYYY-MM-DD),
 *                    alarmeDias (padrão 1) }]
 * @param opcoes   { nome } nome do calendário, que a agenda mostra
 */
function montarIcs(eventos, opcoes = {}) {
  const agora = carimbo(new Date());
  const linhas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NFS-e Gateway//Obrigacoes//PT-BR',
    'CALSCALE:GREGORIAN',
    // PUBLISH: são compromissos informados, não convites que pedem resposta
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(opcoes.nome || 'Obrigações do escritório')}`
  ];

  for (const ev of eventos) {
    const data = ev.data instanceof Date ? ev.data : new Date(String(ev.data) + 'T12:00:00');
    const fim = new Date(data.getTime() + 24 * 3600 * 1000);
    const alarme = ev.alarmeDias === undefined ? 1 : Number(ev.alarmeDias);

    linhas.push(
      'BEGIN:VEVENT',
      // UID estável: reenviar o mesmo prazo ATUALIZA o compromisso na agenda em
      // vez de criar um segundo igual
      `UID:${esc(ev.id)}@nfse-gateway`,
      `DTSTAMP:${agora}`,
      `DTSTART;VALUE=DATE:${dia(data)}`,
      `DTEND;VALUE=DATE:${dia(fim)}`,
      dobrar(`SUMMARY:${esc(ev.titulo)}`),
      ev.descricao ? dobrar(`DESCRIPTION:${esc(ev.descricao)}`) : null,
      'TRANSP:TRANSPARENT',   // prazo não ocupa a agenda como reunião
      'BEGIN:VALARM',
      `TRIGGER:-P${Math.max(0, alarme)}D`,
      'ACTION:DISPLAY',
      dobrar(`DESCRIPTION:${esc(ev.titulo)}`),
      'END:VALARM',
      'END:VEVENT'
    );
  }

  linhas.push('END:VCALENDAR');
  // CRLF é exigido pelo RFC; agenda que aceita LF é tolerância, não regra
  return linhas.filter(Boolean).join('\r\n') + '\r\n';
}

module.exports = { montarIcs };
