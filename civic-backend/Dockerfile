# Multi-stage build to minimize disk space usage
FROM python:3.10-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache gcc musl-dev libsndfile-dev

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Final stage with minimal runtime dependencies
FROM python:3.10-alpine

WORKDIR /app

# Install only runtime dependencies
RUN apk add --no-cache libsndfile

# Copy Python packages from builder stage
COPY --from=builder /usr/local/lib/python3.10/site-packages/ /usr/local/lib/python3.10/site-packages/
COPY --from=builder /usr/local/bin/ /usr/local/bin/

# Copy application code
COPY . .

# Create upload directory
RUN mkdir -p uploads

# Expose port
EXPOSE 5002

# Run the application
CMD ["python", "run.py"]