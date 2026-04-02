#!/bin/bash
# ============================================
# BossMate V4 Phase 1+2 完整验证脚本
# ============================================

BASE="http://localhost:3000/api/v1"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
PASS=0
FAIL=0
WARN=0

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAIL++)); }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; ((WARN++)); }
log_info() { echo -e "      $1"; }

echo "============================================"
echo "  BossMate V4 Phase 1+2 验证"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# ---- Step 0: 服务存活检测 ----
echo "--- [0] 服务存活检测 ---"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" ${BASE}/health)
if [ "$HEALTH" = "200" ]; then
  log_pass "Health 接口正常 (HTTP $HEALTH)"
else
  log_fail "Health 接口异常 (HTTP $HEALTH)，后续测试将失败"
  echo ""
  echo "总结: 服务未启动，请先启动服务"
  exit 1
fi
echo ""

# ---- Step 1: 获取 JWT Token ----
echo "--- [1] 获取认证 Token ---"
# 尝试用默认管理员登录（根据你的实际账号调整）
TOKEN_RESP=$(curl -s -X POST ${BASE}/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bossmate.com","password":"admin123"}')

TOKEN=$(echo "$TOKEN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  # 尝试注册
  log_warn "登录失败，尝试注册测试账号..."
  REG_RESP=$(curl -s -X POST ${BASE}/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"test@bossmate.com","password":"test123456","name":"V4 Tester","tenantName":"V4测试租户"}')
  TOKEN=$(echo "$REG_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$TOKEN" ]; then
  log_fail "无法获取 Token，认证体系可能未初始化"
  log_info "返回内容: $TOKEN_RESP"
  echo ""
  echo "提示: 需要先有一个可用账号。请手动创建后重新运行此脚本。"
  echo "  或者在 .env 中检查 JWT_SECRET 和数据库连接。"
  echo ""
  echo "--- 跳过认证接口测试，检查无认证部分 ---"
  TOKEN="NONE"
fi

if [ "$TOKEN" != "NONE" ]; then
  log_pass "获取 Token 成功"
  AUTH="Authorization: Bearer ${TOKEN}"
  log_info "Token: ${TOKEN:0:20}..."
else
  AUTH="Authorization: Bearer invalid"
fi
echo ""

# ---- Step 2: Knowledge CRUD ----
echo "--- [2] 知识库 CRUD 接口 ---"

if [ "$TOKEN" != "NONE" ]; then
  # 2.1 创建条目
  CREATE_RESP=$(curl -s -X POST ${BASE}/knowledge \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "title": "V4测试-术语条目",
      "content": "影响因子(Impact Factor)是衡量学术期刊影响力的重要指标，由Clarivate Analytics每年发布在JCR报告中。影响因子的计算方式是期刊前两年发表的论文在统计年被引用的总次数除以该期刊前两年发表的论文总数。",
      "category": "term",
      "source": "manual",
      "metadata": {"importance": "high", "test": true}
    }')
  CREATE_STATUS=$(echo "$CREATE_RESP" | grep -o '"id"' | head -1)
  ENTRY_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$CREATE_STATUS" ]; then
    log_pass "POST /knowledge 创建条目成功 (ID: ${ENTRY_ID:0:12}...)"
  else
    log_fail "POST /knowledge 创建条目失败"
    log_info "返回: $CREATE_RESP"
  fi

  # 2.2 查询单条
  if [ -n "$ENTRY_ID" ]; then
    GET_RESP=$(curl -s -X GET "${BASE}/knowledge/${ENTRY_ID}" -H "$AUTH")
    GET_STATUS=$(echo "$GET_RESP" | grep -o '"title"')
    if [ -n "$GET_STATUS" ]; then
      log_pass "GET /knowledge/:id 查询条目成功"
    else
      log_fail "GET /knowledge/:id 查询条目失败"
      log_info "返回: $GET_RESP"
    fi
  fi

  # 2.3 列表查询
  LIST_RESP=$(curl -s -X GET "${BASE}/knowledge?category=term&limit=5" -H "$AUTH")
  LIST_HAS=$(echo "$LIST_RESP" | grep -o '"entries"')
  if [ -n "$LIST_HAS" ]; then
    log_pass "GET /knowledge 列表查询成功"
  else
    # 也可能返回数组
    LIST_ARR=$(echo "$LIST_RESP" | grep -o '^\[')
    if [ -n "$LIST_ARR" ]; then
      log_pass "GET /knowledge 列表查询成功 (数组格式)"
    else
      log_fail "GET /knowledge 列表查询失败"
      log_info "返回: ${LIST_RESP:0:200}"
    fi
  fi

  # 2.4 更新条目
  if [ -n "$ENTRY_ID" ]; then
    UPDATE_RESP=$(curl -s -X PUT "${BASE}/knowledge/${ENTRY_ID}" \
      -H "Content-Type: application/json" \
      -H "$AUTH" \
      -d '{"title": "V4测试-术语条目(已更新)", "content": "影响因子(Impact Factor, IF)是衡量学术期刊影响力的核心指标。更新：2024年JCR已改用新算法。"}')
    UPDATE_OK=$(echo "$UPDATE_RESP" | grep -oE '"(id|success|updated)"')
    if [ -n "$UPDATE_OK" ]; then
      log_pass "PUT /knowledge/:id 更新条目成功"
    else
      log_fail "PUT /knowledge/:id 更新条目失败"
      log_info "返回: $UPDATE_RESP"
    fi
  fi

  echo ""

  # ---- Step 3: 语义搜索 ----
  echo "--- [3] 语义搜索接口 ---"

  SEARCH_RESP=$(curl -s -X POST "${BASE}/knowledge/search" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{"query": "什么是影响因子", "category": "term", "limit": 5}')
  SEARCH_OK=$(echo "$SEARCH_RESP" | grep -oE '"(results|entries|score)"')
  if [ -n "$SEARCH_OK" ]; then
    log_pass "POST /knowledge/search 语义搜索成功"
  else
    log_warn "POST /knowledge/search 语义搜索可能失败（需要 DeepSeek API Key）"
    log_info "返回: ${SEARCH_RESP:0:200}"
  fi

  HYBRID_RESP=$(curl -s -X POST "${BASE}/knowledge/hybrid-search" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{"query": "期刊影响因子", "categories": ["term", "keyword"], "limit": 5}')
  HYBRID_OK=$(echo "$HYBRID_RESP" | grep -oE '"(results|entries|score)"')
  if [ -n "$HYBRID_OK" ]; then
    log_pass "POST /knowledge/hybrid-search 混合搜索成功"
  else
    log_warn "POST /knowledge/hybrid-search 混合搜索可能失败"
    log_info "返回: ${HYBRID_RESP:0:200}"
  fi
  echo ""

  # ---- Step 4: 审核管道 ----
  echo "--- [4] 5-Gate 审核管道 ---"

  AUDIT_RESP=$(curl -s -X POST "${BASE}/knowledge/audit" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "title": "审核测试-SCI分区调整",
      "content": "2025年中科院SCI期刊分区表进行了重大调整。医学类期刊中，The Lancet从Q1调至超一区。计算机领域IEEE TPAMI维持Q1不变。本次调整涉及3000余本期刊，影响广泛。",
      "category": "insight",
      "source": "crawl:policy-monitor"
    }')
  AUDIT_OK=$(echo "$AUDIT_RESP" | grep -oE '"(passed|accepted|gates|result)"')
  if [ -n "$AUDIT_OK" ]; then
    log_pass "POST /knowledge/audit 单条审核成功"
    log_info "返回: ${AUDIT_RESP:0:300}"
  else
    log_warn "POST /knowledge/audit 审核可能失败（需要 DeepSeek API 做 gate4 去重）"
    log_info "返回: ${AUDIT_RESP:0:300}"
  fi

  # 批量审核
  BATCH_RESP=$(curl -s -X POST "${BASE}/knowledge/audit/batch" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "items": [
        {"title": "批量测试1", "content": "论文查重率要求一般本科不超过30%，硕士不超过15%，博士不超过10%。各高校标准略有不同。", "category": "redline", "source": "manual"},
        {"title": "批量测试2", "content": "太短", "category": "term", "source": "manual"}
      ]
    }')
  BATCH_OK=$(echo "$BATCH_RESP" | grep -oE '"(results|accepted|total)"')
  if [ -n "$BATCH_OK" ]; then
    log_pass "POST /knowledge/audit/batch 批量审核成功"
  else
    log_warn "POST /knowledge/audit/batch 批量审核返回异常"
    log_info "返回: ${BATCH_RESP:0:300}"
  fi
  echo ""

  # ---- Step 5: 冷启动 ----
  echo "--- [5] 冷启动流程 ---"

  COLD_RESP=$(curl -s -X POST "${BASE}/knowledge/cold-start" \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{
      "industry": "education",
      "seedCompetitors": [
        {"name": "学术圈日报", "platform": "wechat", "accountId": "xueshujuan"}
      ]
    }')
  COLD_OK=$(echo "$COLD_RESP" | grep -oE '"(progress|steps|completed|total)"')
  if [ -n "$COLD_OK" ]; then
    log_pass "POST /knowledge/cold-start 冷启动成功"
    log_info "返回: ${COLD_RESP:0:400}"
  else
    log_warn "POST /knowledge/cold-start 冷启动返回异常"
    log_info "返回: ${COLD_RESP:0:400}"
  fi
  echo ""

  # ---- Step 6: 统计接口 ----
  echo "--- [6] 统计接口 ---"

  STATS_RESP=$(curl -s -X GET "${BASE}/knowledge/stats" -H "$AUTH")
  STATS_OK=$(echo "$STATS_RESP" | grep -oE '"(total|categories|count)"')
  if [ -n "$STATS_OK" ]; then
    log_pass "GET /knowledge/stats 统计查询成功"
    log_info "返回: ${STATS_RESP:0:500}"
  else
    log_fail "GET /knowledge/stats 统计查询失败"
    log_info "返回: $STATS_RESP"
  fi
  echo ""

  # ---- Step 7: 清理测试数据 ----
  echo "--- [7] 清理测试数据 ---"
  if [ -n "$ENTRY_ID" ]; then
    DEL_RESP=$(curl -s -X DELETE "${BASE}/knowledge/${ENTRY_ID}" -H "$AUTH")
    DEL_OK=$(echo "$DEL_RESP" | grep -oE '"(success|deleted|ok)"')
    if [ -n "$DEL_OK" ]; then
      log_pass "DELETE /knowledge/:id 删除测试条目成功"
    else
      log_warn "DELETE /knowledge/:id 删除可能失败"
      log_info "返回: $DEL_RESP"
    fi
  fi
  echo ""

else
  log_warn "跳过所有认证接口测试（无可用 Token）"
  echo ""
fi

# ---- Step 8: 内存和进程检查 ----
echo "--- [8] 系统资源检查 ---"

if command -v free &>/dev/null; then
  MEM_USED=$(free -m | awk '/Mem:/ {print $3}')
  MEM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
else
  # macOS: 用 sysctl 获取总内存，vm_stat 估算已用
  MEM_TOTAL=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
  PAGES_ACTIVE=$(vm_stat | awk '/Pages active/ {gsub(/\./,"",$3); print $3}')
  PAGES_WIRED=$(vm_stat | awk '/Pages wired/ {gsub(/\./,"",$4); print $4}')
  MEM_USED=$(( (PAGES_ACTIVE + PAGES_WIRED) * 4096 / 1024 / 1024 ))
fi

if [ -n "$MEM_TOTAL" ] && [ "$MEM_TOTAL" -gt 0 ] 2>/dev/null; then
  MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
  if [ "$MEM_PCT" -lt 80 ]; then
    log_pass "内存使用率 ${MEM_PCT}% (${MEM_USED}MB / ${MEM_TOTAL}MB)"
  else
    log_warn "内存使用率较高 ${MEM_PCT}% (${MEM_USED}MB / ${MEM_TOTAL}MB)"
  fi
else
  log_warn "无法获取内存信息"
fi

NODE_PID=$(ps aux | grep -E "node.*(dist/index|src/index)" | grep -v grep | awk '{print $2}' | head -1)
NODE_MEM=$(ps aux | grep -E "node.*(dist/index|src/index)" | grep -v grep | awk '{print $6}' | head -1)
if [ -n "$NODE_PID" ]; then
  NODE_MEM_MB=$((NODE_MEM / 1024))
  log_pass "Node 进程运行中 (PID: $NODE_PID, 内存: ${NODE_MEM_MB}MB)"
else
  # 也尝试检测 tsx 进程
  NODE_PID=$(lsof -i :3000 2>/dev/null | grep LISTEN | awk '{print $2}' | head -1)
  if [ -n "$NODE_PID" ]; then
    log_pass "Node 进程运行中 (PID: $NODE_PID, 通过端口检测)"
  else
    log_fail "Node 进程未运行"
  fi
fi

# 检查 LanceDB 数据目录
if [ -d "./data/lancedb" ] || [ -d "/home/projects/bossmate/data/lancedb" ]; then
  LANCE_SIZE=$(du -sh ./data/lancedb 2>/dev/null || du -sh /home/projects/bossmate/data/lancedb 2>/dev/null)
  log_pass "LanceDB 数据目录存在 ($LANCE_SIZE)"
else
  log_warn "LanceDB 数据目录不存在（首次写入时会自动创建）"
fi
echo ""

# ---- 汇总 ----
echo "============================================"
echo "  验证结果汇总"
echo "============================================"
echo -e "  ${GREEN}通过: $PASS${NC}"
echo -e "  ${RED}失败: $FAIL${NC}"
echo -e "  ${YELLOW}警告: $WARN${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}>>> V4 Phase 1+2 验证通过！可以继续开发 Phase 3 <<<${NC}"
else
  echo -e "${RED}>>> 存在 $FAIL 个失败项，需要排查 <<<${NC}"
fi
echo ""
