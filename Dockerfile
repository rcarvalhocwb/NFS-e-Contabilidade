FROM node:20-alpine

# Fuso horário: o Alpine (musl libc) só resolve fusos nomeados com o pacote
# tzdata instalado — sem ele, TZ=America/Sao_Paulo é ignorado e o container
# roda em UTC, o que gera dhEmi/dCompet errados na DPS.
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
