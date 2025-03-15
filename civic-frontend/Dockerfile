# Build stage
FROM node:18-alpine as build

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Set the API base URL for production - use port 5002
ENV REACT_APP_API_URL=http://api:5002
ENV BACKEND_PORT=5002

# Build the application
RUN npm run build

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
