# Multi-stage build for production efficiency and security
# Using slim (Debian-based) instead of Alpine for better ARM64 compatibility
FROM node:24-slim AS builder

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
COPY data/personas/ ./data/personas/

# Build the application
RUN npm run build

# Production stage with security hardening
# Using slim (Debian-based) instead of Alpine for better ARM64 compatibility
FROM node:24-slim AS production

# Install only essential runtime dependencies and remove unnecessary packages
# This reduces attack surface by removing tools commonly used in exploits
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && apt-get remove -y --purge \
    curl \
    wget \
    git \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create non-root user for security
# Using specific UID/GID for consistency across containers
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/false -m dollhouse && \
    mkdir -p /app && \
    chown -R dollhouse:nodejs /app

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data/personas ./data/personas

# Security hardening - Set proper permissions
RUN chmod -R 750 /app && \
    chown -R dollhouse:nodejs /app

# Create writable directories with restricted permissions
RUN mkdir -p /app/tmp /app/logs && \
    chown -R dollhouse:nodejs /app/tmp /app/logs && \
    chmod -R 700 /app/tmp /app/logs

# Switch to non-root user
USER dollhouse

# No ports exposed - stdio-based MCP servers don't need network access

# Add security labels for container metadata
LABEL security.non-root="true" \
      security.no-new-privileges="true" \
      security.read-only-root="true"

# Set environment variables with security considerations
ENV NODE_ENV=production \
    PERSONAS_DIR=/app/personas \
    NODE_OPTIONS="--max-old-space-size=256" \
    DOLLHOUSE_DISABLE_UPDATES=true \
    DOLLHOUSE_SECURITY_MODE=strict \
    PATH="/app/node_modules/.bin:$PATH"

# Default command with explicit platform handling
CMD ["node", "--trace-warnings", "dist/index.js"]