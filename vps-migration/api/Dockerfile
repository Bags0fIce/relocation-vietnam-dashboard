FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY api/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY api/server.js api/import-data.js ./
COPY schema.sql ./
COPY site /site
USER node
EXPOSE 3000
CMD ["node", "server.js"]
