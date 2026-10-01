FROM node:24-alpine AS build
WORKDIR /app
# Build context: the mia-ai-memory-app directory (docker build -t ai-memory-console .).
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
