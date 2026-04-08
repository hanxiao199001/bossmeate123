#!/usr/bin/env python3
"""
Springer Link 期刊批量爬虫 —— 基于 Scrapling

用法:
  # 爬取某个学科下的期刊列表
  python3 springer_browse_crawler.py --subject medicine-and-public-health

  # 爬取所有学科
  python3 springer_browse_crawler.py --all

  # 爬取指定学科 + 通过代理访问
  python3 springer_browse_crawler.py --subject computer-science --proxy http://127.0.0.1:7890

  # 只列出学科不爬取
  python3 springer_browse_crawler.py --list-subjects

数据源:
  1. link.springer.com/journals/browse-subject/{subject} — 期刊列表
  2. link.springer.com/journal/{id} — 期刊详情页

输出: JSON 到 stdout，供 Node.js 子进程读取
"""

import sys
import json
import argparse
import re
import time
import random
import os
import traceback

# ============ 代理支持 ============

def setup_proxy(proxy_url: str | None):
    """设置 HTTP/HTTPS 代理环境变量（只影响当前进程）"""
    if proxy_url:
        os.environ["http_proxy"] = proxy_url
        os.environ["https_proxy"] = proxy_url
        print(json.dumps({"info": f"Proxy set to {proxy_url}"}), file=sys.stderr)


# ============ Scrapling 导入 ============

try:
    from scrapling.fetchers import FetcherSession, StealthySession
    HAS_SCRAPLING = True
except ImportError:
    HAS_SCRAPLING = False

# ============ Springer 学科定义 ============

SPRINGER_SUBJECTS = [
    {"slug": "biological-sciences", "label": "Biological Sciences", "code": "biology"},
    {"slug": "biomedical-sciences", "label": "Biomedical Sciences", "code": "medicine"},
    {"slug": "business-and-management", "label": "Business and Management", "code": "economics"},
    {"slug": "chemistry", "label": "Chemistry", "code": "chemistry"},
    {"slug": "computer-science", "label": "Computer Science", "code": "computer"},
    {"slug": "earth-sciences-and-geography", "label": "Earth Sciences and Geography", "code": "environment"},
    {"slug": "economics-and-finance", "label": "Economics and Finance", "code": "economics"},
    {"slug": "education", "label": "Education", "code": "education"},
    {"slug": "engineering", "label": "Engineering", "code": "engineering"},
    {"slug": "environment", "label": "Environment", "code": "environment"},
    {"slug": "food-science-and-nutrition", "label": "Food Science and Nutrition", "code": "agriculture"},
    {"slug": "law", "label": "Law", "code": "law"},
    {"slug": "life-sciences", "label": "Life Sciences", "code": "biology"},
    {"slug": "materials-science", "label": "Materials Science", "code": "materials"},
    {"slug": "mathematics", "label": "Mathematics", "code": "math"},
    {"slug": "medicine-and-public-health", "label": "Medicine and Public Health", "code": "medicine"},
    {"slug": "pharmacy", "label": "Pharmacy", "code": "medicine"},
    {"slug": "physics", "label": "Physics", "code": "physics"},
    {"slug": "psychology", "label": "Psychology", "code": "psychology"},
    {"slug": "social-sciences", "label": "Social Sciences", "code": "education"},
    {"slug": "statistics", "label": "Statistics", "code": "math"},
]

BROWSE_URL = "https://link.springer.com/journals/browse-subject/{subject}?page={page}"
JOURNAL_URL = "https://link.springer.com/journal/{journal_id}"


# ============ 爬取期刊列表 ============

def crawl_subject_list(session, subject_slug: str, use_stealthy: bool = False, max_pages: int = 10) -> list[dict]:
    """爬取某学科下的所有期刊基本信息（名称、链接、ISSN）"""
    journals = []

    for page_num in range(1, max_pages + 1):
        url = BROWSE_URL.format(subject=subject_slug, page=page_num)

        try:
            if use_stealthy:
                page = session.fetch(url)
            else:
                page = session.get(url, stealthy_headers=True)

            if page.status != 200:
                print(json.dumps({
                    "warning": f"Subject {subject_slug} page {page_num} returned {page.status}"
                }), file=sys.stderr)
                break

            # 解析期刊卡片/列表项
            # Springer 的期刊列表通常是 <a> 标签链接到 /journal/{id}
            journal_links = page.css("a[href*='/journal/']")

            if not journal_links:
                # 没有更多期刊了
                break

            seen_this_page = set()
            for link in journal_links:
                href = link.attrib.get("href", "")
                name = (link.text or "").strip()

                # 提取 journal ID（数字）
                jid_match = re.search(r"/journal/(\d+)", href)
                if not jid_match:
                    continue

                journal_id = jid_match.group(1)

                # 去重（同一页面可能多次出现同一期刊）
                if journal_id in seen_this_page:
                    continue
                seen_this_page.add(journal_id)

                journals.append({
                    "springerJournalId": journal_id,
                    "name": name if name else None,
                    "url": f"https://link.springer.com/journal/{journal_id}",
                    "subjectSlug": subject_slug,
                })

            print(json.dumps({
                "progress": f"Subject {subject_slug} page {page_num}: found {len(seen_this_page)} journals"
            }), file=sys.stderr)

            # 检查是否有下一页
            next_link = page.css("a[rel='next'], a.next, a[aria-label='next']")
            if not next_link:
                break

            # 请求间隔：2-4 秒随机
            time.sleep(2 + random.random() * 2)

        except Exception as e:
            print(json.dumps({
                "warning": f"Error crawling {subject_slug} page {page_num}: {str(e)}"
            }), file=sys.stderr)
            break

    return journals


# ============ 爬取期刊详情 ============

def crawl_journal_detail(session, journal_id: str, use_stealthy: bool = False) -> dict | None:
    """爬取单本期刊详情页，提取投稿指标"""
    url = JOURNAL_URL.format(journal_id=journal_id)

    try:
        if use_stealthy:
            page = session.fetch(url)
        else:
            page = session.get(url, stealthy_headers=True)

        if page.status != 200:
            return None

        text = page.text or ""
        result = {"springerJournalId": journal_id, "source": "springer-link"}

        # 期刊名
        title = page.css("h1")
        if title:
            result["nameEn"] = title[0].text.strip()

        # ISSN（电子版和印刷版）
        issn_matches = re.findall(r"(\d{4}-\d{3}[\dxX])", text)
        if issn_matches:
            result["issn"] = issn_matches[0]
            if len(issn_matches) > 1:
                result["eissn"] = issn_matches[1]

        # Impact Factor
        if_match = re.search(r"(?:Impact\s*Factor|Journal\s*Impact\s*Factor)[^\d]*?([\d.]+)", text, re.I)
        if if_match:
            result["impactFactor"] = float(if_match.group(1))

        # CiteScore
        cs_match = re.search(r"CiteScore[^\d]*?([\d.]+)", text, re.I)
        if cs_match:
            result["citeScore"] = float(cs_match.group(1))

        # APC 费用
        apc_match = re.search(r"(?:APC|article.processing.charge|publication.fee)[^\d]*?(?:EUR|USD|\$|€)\s*(\d[,\d]+)", text, re.I)
        if apc_match:
            apc_str = apc_match.group(1).replace(",", "")
            result["apcFee"] = float(apc_str)

        # 审稿时间相关
        tfd_match = re.search(r"(?:time.to.first.decision|first.decision)[^\d]*?(\d+)\s*(days?|weeks?)", text, re.I)
        if tfd_match:
            days = int(tfd_match.group(1))
            if "week" in tfd_match.group(2).lower():
                days *= 7
            result["timeToFirstDecisionDays"] = days
            result["timeToFirstDecision"] = tfd_match.group(0).strip()

        sta_match = re.search(r"(?:submission.to.acceptance|acceptance.time)[^\d]*?(\d+)\s*(days?|weeks?|months?)", text, re.I)
        if sta_match:
            result["submissionToAcceptance"] = sta_match.group(0).strip()

        # Open Access 状态
        if re.search(r"\bfully\s+open\s+access\b", text, re.I):
            result["isOA"] = True
        elif re.search(r"\bhybrid\b", text, re.I):
            result["isOA"] = False
            result["isHybrid"] = True

        # Publisher
        pub_match = re.search(r"(?:Published\s+by|Publisher)[:\s]*([^<\n]{3,50})", text, re.I)
        if pub_match:
            result["publisher"] = pub_match.group(1).strip().rstrip(".")

        # Aims & Scope
        scope_section = page.css(
            ".c-journal-about, "
            "[data-test='aims-and-scope'], "
            ".aims-and-scope, "
            "#aims-and-scope, "
            ".about-this-journal"
        )
        if scope_section:
            scope_text = scope_section[0].text
            if scope_text and len(scope_text) > 50:
                result["scopeDescription"] = scope_text.strip()[:2000]

        # 期刊官网
        result["website"] = url

        return result

    except Exception as e:
        print(json.dumps({
            "warning": f"Error fetching journal {journal_id}: {str(e)}"
        }), file=sys.stderr)
        return None


# ============ 批量爬取 ============

def batch_crawl_subject(
    subject_slug: str,
    discipline_code: str,
    use_stealthy: bool = False,
    fetch_details: bool = True,
    max_detail_count: int = 50,
) -> list[dict]:
    """完整流程：列表页 → 逐个详情页"""

    if use_stealthy:
        session_ctx = StealthySession(
            headless=True,
            solve_cloudflare=True,
            hide_canvas=True,
            block_webrtc=True,
        )
    else:
        session_ctx = FetcherSession(impersonate="chrome")

    with session_ctx as session:
        # Step 1: 爬取期刊列表
        journal_list = crawl_subject_list(session, subject_slug, use_stealthy)

        print(json.dumps({
            "info": f"Subject {subject_slug}: found {len(journal_list)} journals total"
        }), file=sys.stderr)

        if not fetch_details:
            # 只返回列表，不爬详情
            for j in journal_list:
                j["discipline"] = discipline_code
            return journal_list

        # Step 2: 逐个爬详情页（限制数量避免被封）
        results = []
        detail_count = min(len(journal_list), max_detail_count)

        for i, journal in enumerate(journal_list[:detail_count]):
            jid = journal["springerJournalId"]

            print(json.dumps({
                "progress": f"Fetching detail {i+1}/{detail_count}: journal {jid}"
            }), file=sys.stderr)

            detail = crawl_journal_detail(session, jid, use_stealthy)

            if detail:
                # 合并列表信息和详情信息
                merged = {**journal, **detail}
                merged["discipline"] = discipline_code
                results.append(merged)
            else:
                # 详情爬取失败，保留列表信息
                journal["discipline"] = discipline_code
                results.append(journal)

            # 请求间隔：3-6 秒随机（Springer 限速约 50 请求）
            time.sleep(3 + random.random() * 3)

        # 没爬详情的也保留
        if detail_count < len(journal_list):
            for j in journal_list[detail_count:]:
                j["discipline"] = discipline_code
                results.append(j)

        return results


# ============ 主入口 ============

def main():
    parser = argparse.ArgumentParser(description="Springer Link Journal Browser Crawler")
    parser.add_argument("--subject", help="学科 slug（如 medicine-and-public-health）")
    parser.add_argument("--all", action="store_true", help="爬取所有学科")
    parser.add_argument("--list-subjects", action="store_true", help="列出所有学科")
    parser.add_argument("--stealthy", action="store_true", help="使用 StealthySession")
    parser.add_argument("--no-details", action="store_true", help="只爬列表不爬详情")
    parser.add_argument("--max-details", type=int, default=50, help="每个学科最多爬多少个详情")
    parser.add_argument("--proxy", help="HTTP 代理地址（如 http://127.0.0.1:7890）")

    args = parser.parse_args()

    # 列出学科
    if args.list_subjects:
        for s in SPRINGER_SUBJECTS:
            print(f"  {s['slug']:40s}  {s['label']:30s}  → {s['code']}")
        return

    if not args.subject and not args.all:
        print(json.dumps({"error": "请提供 --subject 或 --all"}))
        sys.exit(1)

    if not HAS_SCRAPLING:
        print(json.dumps({"error": "Scrapling 未安装，请运行: pip install scrapling"}))
        sys.exit(1)

    # 设置代理
    setup_proxy(args.proxy)

    # 确定要爬哪些学科
    if args.all:
        subjects_to_crawl = SPRINGER_SUBJECTS
    else:
        subjects_to_crawl = [s for s in SPRINGER_SUBJECTS if s["slug"] == args.subject]
        if not subjects_to_crawl:
            print(json.dumps({"error": f"未知学科: {args.subject}，用 --list-subjects 查看"}))
            sys.exit(1)

    # 执行爬取
    all_results = []

    for subject in subjects_to_crawl:
        print(json.dumps({
            "info": f"Starting subject: {subject['label']} ({subject['slug']})"
        }), file=sys.stderr)

        try:
            results = batch_crawl_subject(
                subject_slug=subject["slug"],
                discipline_code=subject["code"],
                use_stealthy=args.stealthy,
                fetch_details=not args.no_details,
                max_detail_count=args.max_details,
            )
            all_results.extend(results)

            print(json.dumps({
                "info": f"Subject {subject['slug']} done: {len(results)} journals"
            }), file=sys.stderr)

        except Exception as e:
            print(json.dumps({
                "error": f"Subject {subject['slug']} failed: {str(e)}"
            }), file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

        # 学科间间隔
        if len(subjects_to_crawl) > 1:
            time.sleep(5 + random.random() * 5)

    # 输出最终结果
    output = {
        "source": "springer-link-browse",
        "totalJournals": len(all_results),
        "subjects": list(set(s["slug"] for s in subjects_to_crawl)),
        "journals": all_results,
        "crawledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
