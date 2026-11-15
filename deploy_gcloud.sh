#!/usr/bin/env bash
# ==============================================================================
# ONE-CLICK GOOGLE CLOUD RUN DEPLOYMENT SCRIPT
# NASA Space Apps Challenge 2026 - Team 01 (eq01)
# ==============================================================================

set -e

SERVICE_NAME="lunar-landing-navigator"
REGION="${GCLOUD_REGION:-southamerica-west1}"

echo "=============================================================================="
echo "  DEPLOYING LUNAR LANDING SITE NAVIGATOR TO GOOGLE CLOUD RUN"
echo "  Service : ${SERVICE_NAME}"
echo "  Region  : ${REGION} (Santiago, Low Latency)"
echo "=============================================================================="

if ! command -v gcloud &> /dev/null; then
    echo "[ERROR] 'gcloud' CLI is not installed locally."
    echo "You can either:"
    echo "  1. Run this script inside Google Cloud Shell (https://shell.cloud.google.com)"
    echo "  2. Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "(unset)" ]; then
    echo "[INFO] No active Google Cloud project set."
    echo "Listing available projects:"
    gcloud projects list
    read -rp "Enter your Google Cloud PROJECT_ID: " PROJECT_ID
    gcloud config set project "${PROJECT_ID}"
fi

echo "[1/2] Enabling required Google Cloud APIs (Cloud Run & Cloud Build)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "[2/2] Building container and deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --memory 512Mi \
    --cpu 1 \
    --timeout 3600 \
    --session-affinity \
    --max-instances 3

echo "=============================================================================="
echo "  [PASS] DEPLOYMENT COMPLETE!"
echo "  Open the Service URL printed above to access your live 3D Mission Control."
echo "=============================================================================="
