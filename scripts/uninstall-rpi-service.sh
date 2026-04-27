#!/usr/bin/env bash

set -euo pipefail

APP_NAME="ollama-router"
APP_USER="ollama-router"
INSTALL_DIR="/opt/ollama-router"
DATA_DIR="/var/lib/ollama-router"
ENV_FILE="/etc/ollama-router.env"
SERVICE_FILE="/etc/systemd/system/ollama-router.service"
PURGE=false

if [[ "${1:-}" == "--purge" ]]; then
  PURGE=true
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must be run with sudo or as root."
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^${APP_NAME}\.service"; then
    systemctl disable --now "${APP_NAME}" || true
  fi
fi

rm -f "${SERVICE_FILE}"
systemctl daemon-reload || true

if [[ "${PURGE}" == "true" ]]; then
  rm -rf "${INSTALL_DIR}" "${DATA_DIR}"
  rm -f "${ENV_FILE}"

  if id -u "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" || true
  fi

  echo "Uninstall complete. Service, application files, data, configuration, and service user were removed."
else
  echo "Uninstall complete. Service registration was removed."
  echo "Application files kept: ${INSTALL_DIR}"
  echo "Data kept: ${DATA_DIR}"
  echo "Configuration kept: ${ENV_FILE}"
  echo "Run with --purge to remove everything."
fi
