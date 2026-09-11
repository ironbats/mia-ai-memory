FROM node:22-alpine
WORKDIR /app
COPY services/cognitive-api/package.json ./package.json
RUN npm install --omit=dev
COPY services/cognitive-api/src ./src
COPY db/migrations ./db/migrations
ENV COGNITIVE_MIGRATIONS_DIR=/app/db/migrations
EXPOSE 8787
CMD ["npm", "start"]
