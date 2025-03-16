# Multi-stage build to minimize disk space usage

# Builder stage
FROM python:3.10-slim AS builder
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libsndfile-dev \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install gunicorn  # Explicitly install gunicorn

# Final stage with minimal runtime dependencies
FROM python:3.10-slim
WORKDIR /app

# Install only runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Copy Python packages and executables from builder stage
COPY --from=builder /usr/local/lib/python3.10/site-packages/ /usr/local/lib/python3.10/site-packages/
COPY --from=builder /usr/local/bin/ /usr/local/bin/

# Copy the application code
COPY . .

# Create upload directory
RUN mkdir -p uploads

# Set environment variables for production
ENV FLASK_ENV=production
ENV FLASK_DEBUG=0

# Expose the port
EXPOSE 5002

# Run the application with Gunicorn in production
CMD ["gunicorn", "--workers=4", "--bind=0.0.0.0:5002", "wsgi:application"]