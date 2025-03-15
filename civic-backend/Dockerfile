FROM python:3.10-slim

WORKDIR /app

# Minimal install of essential libraries for audio processing
# Uses a two-phase approach to avoid downloading packages twice
RUN apt-get update --allow-insecure-repositories && \
    mkdir -p /tmp/apt-cache && \
    apt-get -o Dir::Cache::Archives=/tmp/apt-cache \
        -y --allow-unauthenticated --no-install-recommends \
        install libsndfile1 libgomp1 && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install build tools only if absolutely necessary
RUN apt-get update --allow-insecure-repositories && \
    apt-get -y --allow-unauthenticated --no-install-recommends \
        install gcc && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create upload directory
RUN mkdir -p uploads

# Expose port
EXPOSE 5002

# Run the application
CMD ["python", "run.py"]
