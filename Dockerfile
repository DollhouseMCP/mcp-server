# Multi-stage build for production efficiency
# Using slim (Debian-based) instead of Alpine for better ARM64 compatibility
FROM node:20-slim AS builder

# Install build dependencies for better cross-platform compatibility
# These are especially important for ARM64 builds
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY personas/ ./personas/

# Build the application
RUN npm run build

# Production stage
# Using slim (Debian-based) instead of Alpine for better ARM64 compatibility
FROM node:20-slim AS production

# Install runtime dependencies
# Minimal dependencies for production, helps with ARM64 compatibility
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
# Using Debian-style user creation instead of Alpine-style
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/bash -m dollhouse

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/personas ./personas

# Change ownership to non-root user
RUN chown -R dollhouse:nodejs /app
USER dollhouse

# No ports needed for stdio-based MCP servers

# No health check needed for stdio-based MCP servers
# MCP servers initialize, load personas, and exit when no input stream available

# Set environment variables
ENV NODE_ENV=production
ENV PERSONAS_DIR=/app/personas

# Default command
CMD ["node", "dist/index.js"]