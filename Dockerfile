FROM oven/bun:1.1.21

WORKDIR /app

COPY package.json bun.lock package-lock.json* ./
RUN bun install --production

COPY . .

EXPOSE 4747

CMD ["bun", "src/index.ts"]
