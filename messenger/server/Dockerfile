# Smartstack Messenger server — node:20-alpine.
FROM node:20-alpine

WORKDIR /app

# Зависимости (с кэшем слоёв).
COPY package.json ./
RUN npm install --no-audit --no-fund

# Prisma-схема + генерация клиента.
COPY prisma ./prisma
RUN npx prisma generate

# Исходники и сборка.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 3000

# Применяем миграции и стартуем.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
