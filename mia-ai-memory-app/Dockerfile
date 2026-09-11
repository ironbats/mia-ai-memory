FROM node:22-alpine AS build
WORKDIR /app
COPY apps/cognitive-console/package.json ./package.json
RUN npm install
COPY apps/cognitive-console .
RUN npm run build

FROM nginx:1.29-alpine
COPY apps/cognitive-console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
