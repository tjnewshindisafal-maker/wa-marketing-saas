FROM node:18-slim

RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

RUN mkdir -p uploads auth

EXPOSE 8080

CMD ["node", "server.js"]
