FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
