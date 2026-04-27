#!/usr/bin/env bash

set -euo pipefail

APP_NAME="ollama-router"
APP_USER="ollama-router"
APP_GROUP="ollama-router"
INSTALL_DIR="/opt/ollama-router"
DATA_DIR="/var/lib/ollama-router"
ENV_FILE="/etc/ollama-router.env"
SERVICE_FILE="/etc/systemd/system/ollama-router.service"

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

if [[ ! -f "${SOURCE_DIR}/package.json" || ! -f "${SOURCE_DIR}/index.js" ]]; then
  echo "Could not find a valid ollama-router source directory: ${SOURCE_DIR}"
  exit 1
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home "${INSTALL_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
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

if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT:-8000}
OLLAMA_NODES=${OLLAMA_NODES:-127.0.0.1:11434}
AUTO_DISCOVER=${AUTO_DISCOVER:-false}
NETWORK_SCAN_INTERVAL=${NETWORK_SCAN_INTERVAL:-300000}
METRICS_FILE=${METRICS_FILE:-/var/lib/ollama-router/model-metrics.json}
INFERENCE_TIMEOUT=${INFERENCE_TIMEOUT:-0}
EOF
fi

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Ollama Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/env node ${INSTALL_DIR}/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

chown -R "${APP_USER}:${APP_GROUP}" "${INSTALL_DIR}" "${DATA_DIR}"
chmod 640 "${ENV_FILE}"

systemctl daemon-reload
systemctl enable --now "${APP_NAME}"

echo
echo "Installation complete."
echo "Service status: systemctl status ${APP_NAME}"
echo "Logs: journalctl -u ${APP_NAME} -f"
echo "Health: curl http://127.0.0.1:8000/health"
echo "Configuration: ${ENV_FILE}"
