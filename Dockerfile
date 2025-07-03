# Multi-stage build for production efficiency
FROM node:20-alpine AS builder

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
FROM node:20-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S dollhouse -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/personas ./personas

# Change ownership to non-root user
RUN chown -R dollhouse:nodejs /app
USER dollhouse

# Expose port (if needed for future HTTP interface)
EXPOSE 3000

# No health check needed for stdio-based MCP servers
# MCP servers initialize, load personas, and exit when no input stream available

# Set environment variables
ENV NODE_ENV=production
ENV PERSONAS_DIR=/app/personas

# Default command
CMD ["node", "dist/index.js"]