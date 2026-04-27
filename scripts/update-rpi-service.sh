#!/usr/bin/env bash

set -euo pipefail

APP_NAME="ollama-router"
APP_USER="ollama-router"
APP_GROUP="ollama-router"
INSTALL_DIR="/opt/ollama-router"
DATA_DIR="/var/lib/ollama-router"
ENV_FILE="/etc/ollama-router.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must be run with sudo or as root."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Please install Node.js 20 LTS first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Please install Node.js including npm first."
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync was not found. Please install rsync first."
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "${INSTALL_DIR}" ]]; then
  echo "Install directory is missing: ${INSTALL_DIR}"
  echo "Please run scripts/install-rpi-service.sh first."
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Configuration file is missing: ${ENV_FILE}"
  echo "Please run scripts/install-rpi-service.sh first."
  exit 1
fi

mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"

rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude coverage \
  --exclude .nyc_output \
  --exclude .DS_Store \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

cd "${INSTALL_DIR}"

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

chown -R "${APP_USER}:${APP_GROUP}" "${INSTALL_DIR}" "${DATA_DIR}"

systemctl daemon-reload
systemctl restart "${APP_NAME}"

echo
echo "Update complete."
echo "Service status: systemctl status ${APP_NAME}"
echo "Logs: journalctl -u ${APP_NAME} -f"
echo "Health: curl http://127.0.0.1:8000/health"
