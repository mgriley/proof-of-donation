FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/index.js"]
