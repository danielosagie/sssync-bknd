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

# Install dependencies with platform-specific flags for Sharp
RUN npm ci --only=production --platform=linux --arch=x64

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies and ensure Sharp is properly installed for Linux
RUN npm prune --production && \
    npm install --platform=linux --arch=x64 sharp

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
