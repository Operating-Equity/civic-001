FROM python:3.10-slim

WORKDIR /app

# Install system dependencies for audio processing (required for Whisper)
RUN apt-get update --allow-insecure-repositories && \
    apt-get install -y --allow-unauthenticated --no-install-recommends \
    ffmpeg \
    libsm6 \
    libxext6 \
    libsndfile1 \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

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
