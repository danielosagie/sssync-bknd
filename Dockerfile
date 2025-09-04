# Use Node.js 20 (LTS) to fix the Supabase deprecation warning
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install system dependencies needed for Sharp and other native modules
RUN apk add --no-cache \
    vips-dev \
    libc6-compat \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install ALL dependencies (including dev) needed for build
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Now install only production dependencies for runtime
# This will automatically install the correct Sharp binary for Linux
RUN rm -rf node_modules && npm ci --only=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Change ownership to non-root user
RUN chown -R nestjs:nodejs /app
USER nestjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1

# Start the application
CMD ["npm", "run", "start:prod"]
