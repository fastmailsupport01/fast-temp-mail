# Fast Temp Mail — multi-stage Docker build (Bun).
#
# Build:  docker build -t fasttempmail .
# Run:    docker run --env-file .env -p 3000:3000 fasttempmail
# The server listens on $PORT (Render/Railway set it automatically).

FROM oven/bun:1.4.2 AS build
WORKDIR /app


COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile


COPY . .
RUN bun run build


FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production


COPY --from=build /app/package.json /app/bun.lock* ./
RUN bun install --production --frozen-lockfile


COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/drizzle ./drizzle


EXPOSE 3000
CMD ["sh", "-c", "bun ./server/src/index.ts"]

