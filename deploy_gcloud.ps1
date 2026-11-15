# ==============================================================================
# ONE-CLICK GOOGLE CLOUD RUN DEPLOYMENT SCRIPT (Windows / PowerShell)
# Script de Despliegue Automatizado en Google Cloud Run
# NASA Space Apps Challenge 2026 - Equipo 01 (eq01)
# Uso: powershell -ExecutionPolicy Bypass -File .\deploy_gcloud.ps1
# ==============================================================================

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ServiceName = "lunar-landing-navigator"
$Region = if ($env:GCLOUD_REGION) { $env:GCLOUD_REGION } else { "southamerica-west1" }

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Error "gcloud CLI no esta instalado. https://cloud.google.com/sdk/docs/install"
}

$ProjectId = (gcloud config get-value project 2>$null)
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
    gcloud projects list
    $ProjectId = Read-Host "Ingresa tu PROJECT_ID de Google Cloud"
    gcloud config set project $ProjectId
}

Write-Host "Desplegando $ServiceName en proyecto $ProjectId, region $Region"

Write-Host "[1/2] Habilitando APIs (Cloud Run, Cloud Build, Artifact Registry)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

Write-Host "[2/2] Construyendo contenedor y desplegando en Cloud Run..."
gcloud run deploy $ServiceName `
    --source . `
    --region $Region `
    --platform managed `
    --allow-unauthenticated `
    --memory 512Mi `
    --cpu 1 `
    --timeout 3600 `
    --session-affinity `
    --max-instances 3 `
    --quiet

$Url = gcloud run services describe $ServiceName --region $Region --format "value(status.url)"
Write-Host "[PASS] Despliegue completo: $Url"
