#!/usr/bin/env bash
# =============================================================
# BossMate PostgreSQL 每日备份（Phase 1a, 2026-06-10）
#
# 服务器安装（在 ubuntu@生产机 上执行一次）:
#   chmod +x /home/projects/bossmate/packages/server/scripts/backup-db.sh
#   crontab -e 加一行（每天 03:30）:
#   30 3 * * * /home/projects/bossmate/packages/server/scripts/backup-db.sh >> /home/projects/backups/db/backup.log 2>&1
#
# 恢复演练（强烈建议每月做一次）:
#   gunzip -c bossmate-2026-06-10-0330.sql.gz | psql "$DATABASE_URL_RESTORE_TARGET"
#
# 异地容灾: 配置了 OSS_BACKUP_BUCKET 且装了 ossutil 时自动上传。
#   没配也至少有本地 14 天滚动备份（比没有强 100 倍）。
# =============================================================
set -euo pipefail

# --- 配置 ---
ENV_FILE="${ENV_FILE:-/home/projects/bossmate/packages/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/projects/backups/db}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OSS_BACKUP_BUCKET="${OSS_BACKUP_BUCKET:-}"   # 如 oss://bossmate-backup/db/

# --- 读 DATABASE_URL（优先环境变量, 否则从 .env 抓） ---
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] FATAL: DATABASE_URL 未配置（环境变量或 $ENV_FILE）" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F-%H%M)
OUT="$BACKUP_DIR/bossmate-$STAMP.sql.gz"

echo "[backup] $(date '+%F %T') 开始备份 → $OUT"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
# 备份完整性哨兵: gzip 能解开且体积不为 0
if ! gunzip -t "$OUT" 2>/dev/null || [ ! -s "$OUT" ]; then
  echo "[backup] FATAL: 备份文件损坏或为空: $OUT" >&2
  exit 1
fi
echo "[backup] 完成: $OUT ($SIZE)"

# --- 滚动清理 ---
DELETED=$(find "$BACKUP_DIR" -name "bossmate-*.sql.gz" -mtime +"$KEEP_DAYS" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "[backup] 清理 $DELETED 个超过 ${KEEP_DAYS} 天的旧备份"

# --- 可选: OSS 异地上传 ---
if [ -n "$OSS_BACKUP_BUCKET" ] && command -v ossutil >/dev/null 2>&1; then
  if ossutil cp "$OUT" "$OSS_BACKUP_BUCKET" -f >/dev/null 2>&1; then
    echo "[backup] 已上传 OSS: $OSS_BACKUP_BUCKET$(basename "$OUT")"
  else
    echo "[backup] WARN: OSS 上传失败（本地备份不受影响）" >&2
  fi
fi
