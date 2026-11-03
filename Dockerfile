# Use official lightweight Node.js 26 Alpine image
FROM node:26-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Install dependencies (only production)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY src ./src

# Create persistent data directory and grant permissions to non-root user
RUN mkdir -p /app/data/apps && chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose internal HTTP port
EXPOSE 3000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start the HTMLDropHub Engine
CMD ["node", "src/index.js"]
