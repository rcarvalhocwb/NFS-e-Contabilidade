-- As palavras do robô: como o escritório se apresenta no WhatsApp.
--
-- POR QUE EXISTE: a conversa já se apresentava com o nome do escritório, mas o
-- resto do texto era fixo no código. Toda contabilidade instalada dizia
-- "Atendimento automático para emissão de notas" e assinava a saída para gente
-- com "a contabilidade" -- correto, e absolutamente genérico. Quem paga por um
-- sistema quer que ele soe como a casa dele.
--
-- O QUE NÃO ENTRA AQUI: nada que mude o que o robô FAZ. Estes campos trocam a
-- forma de dizer, nunca a regra. Um texto configurável que pudesse prometer
-- "emitimos em qualquer município" seria uma promessa que o sistema não cumpre,
-- feita com a voz do escritório -- e a reclamação viria para ele.
--
-- TUDO É OPCIONAL. Em branco, a conversa usa o padrão de antes, que funciona.
-- É por isso que não há NOT NULL nem DEFAULT de texto aqui: nulo significa
-- "use o padrão", e um default no banco esconderia a diferença entre
-- "escolheram este texto" e "ninguém preencheu".

CREATE TABLE IF NOT EXISTS chatbot (
  id            boolean PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- A linha logo abaixo do nome do escritório, na primeira mensagem.
  saudacao      text,

  -- Quem assina o atendimento humano. Um nome, não uma escala: o sistema não
  -- sabe quem está de plantão, não tem turno nem roteamento, e inventar uma
  -- lista de atendentes daria à pessoa a impressão de que a mensagem chega a
  -- alguém específico. Chega ao telefone do escritório, como sempre chegou.
  atendente     text,

  -- Ex: "seg a sex, 8h às 18h". Vai junto da saída para gente, para a pessoa
  -- saber se vale ligar agora. O sistema NÃO usa isso para se desligar fora do
  -- horário: o robô emite nota de madrugada sem problema nenhum, e recusar
  -- seria piorar o serviço para parecer humano.
  horario       text,

  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO chatbot (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE chatbot IS
  'Textos de apresentação do atendimento por WhatsApp. Nulo = usar o padrão do código.';
COMMENT ON COLUMN chatbot.atendente IS
  'Nome que assina o atendimento humano. Um nome, não uma escala -- o sistema não tem turno.';
COMMENT ON COLUMN chatbot.horario IS
  'Informativo. O robô continua atendendo fora dele.';
