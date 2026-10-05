# Pods gateway runtime (S05 §5).
FROM node:22-slim

# Non-root user (platforms may override with their own UID).
RUN useradd --create-home --uid 1001 pods
WORKDIR /app

# Install production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime sources only; the control plane stays in the Next.js image.
COPY gateway ./gateway
COPY lib ./lib

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
USER pods

CMD ["node", "gateway/server.mjs"]
