# ============================================
# install-conclave-service.sh - 安装 Conclave 开机自启动 (Linux/macOS)
# 用法: sudo bash install-conclave-service.sh
# ============================================
#!/usr/bin/env bash
set -e

CONCLAVE_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(whoami)"

cat > /etc/systemd/system/conclave.service <<EOF
[Unit]
Description=Conclave Multi-Model Deliberation Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=${CONCLAVE_DIR}
ExecStart=$(command -v node) src/js/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:${CONCLAVE_DIR}/logs/server.log
StandardError=append:${CONCLAVE_DIR}/logs/server.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable conclave.service
systemctl start conclave.service
echo "[OK] Conclave 已注册并启动 (systemd: conclave.service)"
systemctl status conclave.service --no-pager