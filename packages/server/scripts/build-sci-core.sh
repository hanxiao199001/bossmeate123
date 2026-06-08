#!/usr/bin/env bash
# 生成「科技核心(中国科技核心期刊/统计源)自然科学卷 2023」目录数据 → src/data/sci-core-2023.json
# 来源: 中国科学技术信息研究所(ISTIC)官方 PDF。需在能直连 chinagp.net 的机器上跑(如生产服务器),
# 依赖 poppler-utils(pdftotext)。产出 JSON 后由 ingest-domestic-core.ts 入库打 sci-core 标签。
set -euo pipefail
URL="https://www.chinagp.net/attached/file/20230920/20230920154017_97.pdf"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"           # packages/server
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "[sci-core] 下载 ISTIC PDF..."
curl -fsSL "$URL" -o "$TMP/kjhx.pdf"
echo "[sci-core] pdftotext..."
pdftotext -layout -enc UTF-8 "$TMP/kjhx.pdf" "$TMP/kjhx.txt"
echo "[sci-core] 解析..."
python3 "$HERE/parse-domestic-core.py" kjhx "$TMP/kjhx.txt" 2023 "$ROOT/src/data/sci-core-2023.json"
echo "[sci-core] 完成 → src/data/sci-core-2023.json"
