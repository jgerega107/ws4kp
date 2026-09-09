FROM node:26.8.1-alpine
WORKDIR /app

RUN npm install --global npm@12.0.2

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .

RUN npm run build

EXPOSE 8080

ENV DIST=1
CMD ["npm", "start"]
