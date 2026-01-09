# Use Playwright base image (includes Chromium)
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install ALL dependencies (need devDeps for build)
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Copy static files for server
COPY src/server/public ./dist/server/public
COPY src/db/schema.sql ./dist/db/schema.sql

# Create data directory for SQLite (Railway volume mount point)
RUN mkdir -p /app/data

# Expose port
EXPOSE 3456

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3456
ENV DB_PATH=/app/data/tcg_sales.db

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3456/api/summary || exit 1

# Run the dashboard (use compiled JS)
CMD ["node", "dist/server/index.js"]

