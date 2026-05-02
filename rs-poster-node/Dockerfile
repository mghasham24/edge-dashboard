FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --ignore-scripts
COPY index.js .
CMD ["node", "index.js"]
