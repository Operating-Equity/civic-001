# Build stage using Alpine for minimal size
FROM node:18-alpine as build

# Set working directory and environment
WORKDIR /app

# Install only dependencies needed for building
COPY package.json package-lock.json ./
RUN npm install --production=false --no-audit --prefer-offline && \
    npm cache clean --force

# Copy source code
COPY . .

# Set the API base URL for production
ENV REACT_APP_API_URL=http://api:5002
ENV BACKEND_PORT=5002

# Build the application with aggressive cleanup
RUN npm run build && \
    npm prune --production && \
    rm -rf node_modules/.cache && \
    rm -rf src/ public/

# Production stage
FROM nginx:alpine

# Create environment for dynamic configuration
ENV BACKEND_HOST=api
ENV BACKEND_PORT=5002

# Copy built assets from the build stage
COPY --from=build /app/build /usr/share/nginx/html

# Copy our custom entrypoint script
COPY entrypoint.sh /entrypoint.sh

# Make it executable
RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 80

# Use our entrypoint script to ensure correct nginx configuration
ENTRYPOINT ["/entrypoint.sh"]
