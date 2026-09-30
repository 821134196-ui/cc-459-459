#!/usr/bin/env bash
# 一条本地启动命令：重建演示库（含预约冲突 / 雨停 / 球数短缺样例）并启动服务。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"

echo "▶ 重建演示数据库并生成样例数据…"
python3 -m app.seed --reset

echo "▶ 启动服务 http://${HOST}:${PORT} （Ctrl+C 退出）"
exec python3 -m app.server --host "$HOST" --port "$PORT" --weather rain
