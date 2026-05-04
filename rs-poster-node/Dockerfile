FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY index.js ./
CMD ["node", "index.js"]
