FROM node:20-alpine

# Fuso horário: o Alpine (musl libc) só resolve fusos nomeados com o pacote
# tzdata instalado — sem ele, TZ=America/Sao_Paulo é ignorado e o container
# roda em UTC, o que gera dhEmi/dCompet errados na DPS.
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo
ENV NODE_ENV=production

WORKDIR /app

# Instala dependências numa camada própria: só refaz quando o lockfile muda.
# `npm ci` respeita o package-lock (build reproduzível), ao contrário de install.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Roda como usuário sem privilégios. A imagem node já traz o usuário "node";
# se o processo for comprometido, não é root dentro do container.
USER node

EXPOSE 3000

# Health check para o orquestrador saber se o processo está saudável, e não
# apenas se a porta abriu.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# As migrações rodam antes do servidor: subir uma versão nova aplica o schema
# pendente automaticamente. São idempotentes (schema_migrations controla o que
# já foi aplicado), então reiniciar não repete nada.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
