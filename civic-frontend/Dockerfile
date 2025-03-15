# Build stage using Alpine for minimal size
FROM node:18-alpine as build

WORKDIR /app

# (Optional) Install build tools if native modules are needed
RUN apk add --no-cache build-base

# Install only dependencies needed for building
COPY package.json package-lock.json ./
RUN npm install --production=false --no-audit --prefer-offline && \
    npm cache clean --force

# Copy source code
COPY . .

# Set environment variables for production
ENV REACT_APP_API_URL=http://api:5002
ENV BACKEND_PORT=5002

# Build the application and clean up unnecessary files
RUN npm run build && \
    npm prune --production && \
    rm -rf node_modules/.cache && \
    rm -rf src/ public/

# Production stage using nginx:alpine
FROM nginx:alpine

# Set dynamic configuration variables
ENV BACKEND_HOST=api
ENV BACKEND_PORT=5002

# Copy built assets from the build stage
COPY --from=build /app/build /usr/share/nginx/html

# Copy our custom entrypoint script
COPY entrypoint.sh /entrypoint.sh

# Make the entrypoint script executable
RUN chmod +x /entrypoint.sh

# Expose port 80 for HTTP traffic
EXPOSE 80

# Use our entrypoint script to configure nginx at startup
ENTRYPOINT ["/entrypoint.sh"]