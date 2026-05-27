FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./

# Render injects PORT env var — bot's optional HTTP server binds to it
EXPOSE 3000

USER node

CMD ["node", "index.js"]
