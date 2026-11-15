# ==============================================================================
# DOCKERFILE - LUNAR LANDING SITE NAVIGATOR
# NASA Space Apps Challenge 2026 - Equipo 01 (eq01)
# Optimized for Google Cloud Run / Container Platforms
# ==============================================================================

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# Install ca-certificates (required for WSS connection to Cloud Broker) and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and install python dependencies using pre-built binary wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application code, preprocessed scientific data, and static dashboard
COPY . .

# Expose standard container port (Google Cloud Run injects $PORT at runtime)
EXPOSE 8080

# Start ASGI Uvicorn server dynamically using Cloud Run's $PORT
CMD ["sh", "-c", "exec uvicorn src.api.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
