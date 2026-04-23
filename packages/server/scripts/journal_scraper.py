#!/usr/bin/env python3
"""
BossMate 期刊数据爬虫 —— 基于 Scrapling

用法:
  python3 journal_scraper.py --name "Experimental Hematology & Oncology"
  python3 journal_scraper.py --name "ES&T" --issn "0013-936X"
  python3 journal_scraper.py --keyword "肿瘤免疫治疗"

数据源:
  1. LetPub（中文，完整数据：IF/分区/录用率/审稿周期/预警等）
  2. Springer Nature Link（英文，APC/范围/编辑等）

输出: JSON 到 stdout，供 Node.js 子进程读取
"""

import sys
import json
import argparse
import re
import time
import traceback

# ============ Scrapling 导入 ============

try:
    from scrapling.fetchers import FetcherSession, StealthySession
    HAS_SCRAPLING = True
except ImportError:
    HAS_SCRAPLING = False

# ============ LetPub 爬虫 ============

LETPUB_SEARCH_URL = "https://www.letpub.com.cn/index.php?page=journalapp&view=search"
LETPUB_DETAIL_URL = "https://www.letpub.com.cn/index.php?journalid={}&page=journalapp&view=detail"


def _letpub_search_post(session, search_params: dict, use_stealthy: bool = False):
    """LetPub 搜索——FetcherSession 用 .post()，StealthySession 用 .fetch() + URL 编码"""
    if use_stealthy:
        # StealthySession 不支持 POST data，需要把参数拼到 URL
        query_parts = []
        for k, v in search_params.items():
            query_parts.append(f"{k}={v}")
        url = LETPUB_SEARCH_URL + "&" + "&".join(query_parts)
        return session.fetch(url)
    else:
        # FetcherSession 用 .post()
        return session.post(
            LETPUB_SEARCH_URL,
            data=search_params,
            stealthy_headers=True,
        )


def search_letpub_by_name(session, journal_name: str, use_stealthy: bool = False) -> dict | None:
    """在 LetPub 按期刊名搜索，返回详情页数据"""
    try:
        search_params = {
            "searchname": journal_name,
            "searchissn": "",
            "searchfield": "",
            "searchopen": "",
            "searchsub": "",
            "searchletter": "",
            "searchsort": "relevance",
            "searchimpactlow": "",
            "searchimpacthigh": "",
            "currentpage": "1",
        }

        page = _letpub_search_post(session, search_params, use_stealthy)

        if page.status != 200:
            return None

        # 找到第一个匹配的期刊链接
        links = page.css("a[href*='journalid']")
        if not links:
            # 尝试在表格行中查找
            rows = page.css("tr")
            for row in rows:
                text = row.text or ""
                if journal_name.lower() in text.lower():
                    link = row.css("a[href*='journalid']")
                    if link:
                        links = link
                        break

        if not links:
            return None

        href = links[0].attrib.get("href", "")
        jid_match = re.search(r"journalid=(\d+)", href)
        if not jid_match:
            return None

        journal_id = jid_match.group(1)
        time.sleep(1)  # rate limit

        return fetch_letpub_detail(session, journal_id, use_stealthy)

    except Exception as e:
        print(json.dumps({"error": f"LetPub search failed: {str(e)}"}), file=sys.stderr)
        return None


def search_letpub_by_issn(session, issn: str, use_stealthy: bool = False) -> dict | None:
    """在 LetPub 按 ISSN 搜索"""
    try:
        search_params = {
            "searchname": "",
            "searchissn": issn,
            "searchfield": "",
            "searchopen": "",
            "searchsub": "",
            "searchletter": "",
            "searchsort": "relevance",
            "searchimpactlow": "",
            "searchimpacthigh": "",
            "currentpage": "1",
        }

        page = _letpub_search_post(session, search_params, use_stealthy)

        if page.status != 200:
            return None

        links = page.css("a[href*='journalid']")
        if not links:
            return None

        href = links[0].attrib.get("href", "")
        jid_match = re.search(r"journalid=(\d+)", href)
        if not jid_match:
            return None

        time.sleep(1)
        return fetch_letpub_detail(session, jid_match.group(1), use_stealthy)

    except Exception as e:
        print(json.dumps({"error": f"LetPub ISSN search failed: {str(e)}"}), file=sys.stderr)
        return None


def fetch_letpub_detail(session, journal_id: str, use_stealthy: bool = False) -> dict | None:
    """抓取 LetPub 期刊详情页的所有数据"""
    url = LETPUB_DETAIL_URL.format(journal_id)

    if use_stealthy:
        page = session.fetch(url)
    else:
        page = session.get(url, stealthy_headers=True)

    if page.status != 200:
        return None

    text = page.text or ""
    result = {"source": "letpub", "letpub_id": journal_id}

    # 期刊名称
    title_el = page.css("h2") or page.css(".journal-title")
    if title_el:
        result["name"] = title_el[0].text.strip()

    # 解析 table 数据（LetPub 详情页通常是 table 布局）
    for row in page.css("tr"):
        cells = row.css("td")
        if len(cells) >= 2:
            label = (cells[0].text or "").strip()
            value = (cells[1].text or "").strip()
            _parse_letpub_field(result, label, value)

    # 尝试从正文文本提取更多数据
    _extract_from_text(result, text)

    return result


def _parse_letpub_field(result: dict, label: str, value: str):
    """解析 LetPub 详情页的字段"""
    label_lower = label.lower().replace(" ", "")

    if "issn" in label_lower:
        result["issn"] = value.strip()
    elif "出版" in label and "商" in label:
        result["publisher"] = value
    elif "publisher" in label_lower:
        result["publisher"] = value
    elif "影响因子" in label or "impactfactor" in label_lower:
        m = re.search(r"[\d.]+", value)
        if m:
            result["impactFactor"] = float(m.group())
    elif "分区" in label:
        result["partition"] = value
    elif "中科院" in label:
        if "预警" in label:
            result["isWarningList"] = "是" in value or "预警" in value
        else:
            result["casPartition"] = value
    elif "录用率" in label or "acceptance" in label_lower:
        m = re.search(r"[\d.]+", value)
        if m:
            rate = float(m.group())
            result["acceptanceRate"] = rate / 100 if rate > 1 else rate
    elif "审稿" in label or "review" in label_lower:
        result["reviewCycle"] = value
    elif "发文量" in label or "volume" in label_lower:
        m = re.search(r"\d+", value)
        if m:
            result["annualVolume"] = int(m.group())
    elif "学科" in label or "discipline" in label_lower or "领域" in label:
        result["discipline"] = value
    elif "开放获取" in label or "openaccess" in label_lower or "oa" in label_lower:
        result["isOA"] = "是" in value or "yes" in value.lower() or "open" in value.lower()
    elif "预警" in label or "warning" in label_lower:
        result["isWarningList"] = "是" in value or "在" in value
        if "不在" in value or "否" in value:
            result["isWarningList"] = False
    elif "自引率" in label or "self" in label_lower and "cit" in label_lower:
        m = re.search(r"[\d.]+", value)
        if m:
            result["selfCitationRate"] = float(m.group())
    elif "国人" in label or "中国" in label:
        result["chineseRatio"] = value


def _extract_from_text(result: dict, text: str):
    """从页面全文补充提取数据"""
    # IF
    if "impactFactor" not in result:
        m = re.search(r"(?:影响因子|IF)[^\d]*?([\d.]+)", text)
        if m:
            result["impactFactor"] = float(m.group(1))

    # ISSN
    if "issn" not in result:
        m = re.search(r"(\d{4}-\d{3}[\dxX])", text)
        if m:
            result["issn"] = m.group(1)

    # 分区
    if "partition" not in result:
        m = re.search(r"(Q[1-4])", text)
        if m:
            result["partition"] = m.group(1)

    # 预警
    if "isWarningList" not in result:
        if "不在预警" in text or "非预警" in text:
            result["isWarningList"] = False
        elif "预警期刊" in text:
            result["isWarningList"] = True


# ============ Springer 爬虫 ============

SPRINGER_JOURNAL_URL = "https://link.springer.com/journal/{}"
SPRINGER_SEARCH_URL = "https://link.springer.com/search?query={}&search-within=Journal"

def search_springer(session, journal_name: str, issn: str = None, use_stealthy: bool = False) -> dict | None:
    """从 Springer Nature Link 抓取期刊信息"""
    try:
        def _get_page(url):
            if use_stealthy:
                return session.fetch(url)
            else:
                return session.get(url, stealthy_headers=True)

        # 先尝试用 ISSN 直接访问
        if issn:
            issn_short = issn.replace("-", "")[-4:]
            page = _get_page(f"https://link.springer.com/journal/{issn_short}")
            if page.status == 200 and "journal" in (page.text or "").lower():
                return _parse_springer_page(page)

        # 搜索期刊名
        page = _get_page(SPRINGER_SEARCH_URL.format(journal_name.replace("&", "%26")))

        if page.status != 200:
            return None

        # 找到期刊链接
        journal_links = page.css("a[href*='/journal/']")
        if not journal_links:
            return None

        href = journal_links[0].attrib.get("href", "")
        if not href.startswith("http"):
            href = "https://link.springer.com" + href

        time.sleep(1)

        detail_page = _get_page(href)
        if detail_page.status != 200:
            return None

        return _parse_springer_page(detail_page)

    except Exception as e:
        print(json.dumps({"error": f"Springer search failed: {str(e)}"}), file=sys.stderr)
        return None


def _parse_springer_page(page) -> dict:
    """解析 Springer 期刊页面"""
    result = {"source": "springer"}
    text = page.text or ""

    # 期刊名
    title = page.css("h1")
    if title:
        result["nameEn"] = title[0].text.strip()

    # ISSN
    issn_match = re.search(r"(\d{4}-\d{3}[\dxX])", text)
    if issn_match:
        result["issn"] = issn_match.group(1)

    # APC / Open Access 费用
    apc_match = re.search(r"(?:APC|article.processing.charge|publication.fee)[^\d]*?(\d[,\d]+)", text, re.I)
    if apc_match:
        apc_str = apc_match.group(1).replace(",", "")
        result["apcFee"] = float(apc_str)

    # Impact Factor
    if_match = re.search(r"(?:Impact\s*Factor|IF)[^\d]*?([\d.]+)", text, re.I)
    if if_match:
        result["impactFactor"] = float(if_match.group(1))

    # CiteScore
    cs_match = re.search(r"CiteScore[^\d]*?([\d.]+)", text, re.I)
    if cs_match:
        result["citeScore"] = float(cs_match.group(1))

    # Time to first decision
    tfd_match = re.search(r"(?:time.to.first.decision|first.decision)[^\d]*?(\d+)\s*(?:days?|weeks?)", text, re.I)
    if tfd_match:
        result["timeToFirstDecision"] = tfd_match.group(0).strip()

    # Submission to acceptance
    sta_match = re.search(r"(?:submission.to.acceptance|accept)[^\d]*?(\d+)\s*(?:days?|weeks?|months?)", text, re.I)
    if sta_match:
        result["submissionToAcceptance"] = sta_match.group(0).strip()

    # Publisher
    pub_match = re.search(r"(?:Published by|Publisher)[:\s]*([^<\n]+)", text, re.I)
    if pub_match:
        result["publisher"] = pub_match.group(1).strip()

    # Scope / Aims
    scope_section = page.css(".aims-and-scope, .c-journal-about, [data-test='aims-and-scope']")
    if scope_section:
        scope_text = scope_section[0].text
        if scope_text and len(scope_text) > 50:
            result["scopeDescription"] = scope_text.strip()[:2000]

    # 官网链接
    journal_url = page.css("a[href*='biomedcentral'], a[href*='springer'], a[href*='nature']")
    for link in (journal_url or []):
        href = link.attrib.get("href", "")
        if "journal" in href or "biomedcentral" in href:
            result["website"] = href
            break

    return result


# ============ 合并数据 ============

def merge_results(letpub_data: dict | None, springer_data: dict | None) -> dict:
    """合并 LetPub + Springer 数据，LetPub 优先（更完整的中文数据）"""
    merged = {}

    # LetPub 为主
    if letpub_data:
        merged.update(letpub_data)

    # Springer 补充缺失字段
    if springer_data:
        for key, value in springer_data.items():
            if key == "source":
                continue
            if key not in merged or merged[key] is None:
                merged[key] = value

    # 标记数据来源
    sources = []
    if letpub_data:
        sources.append("letpub")
    if springer_data:
        sources.append("springer")
    merged["sources"] = sources

    return merged


# ============ 主入口 ============

def main():
    parser = argparse.ArgumentParser(description="BossMate Journal Scraper")
    parser.add_argument("--name", help="期刊名称")
    parser.add_argument("--issn", help="期刊 ISSN")
    parser.add_argument("--keyword", help="研究方向关键词（搜索期刊用）")
    parser.add_argument("--stealthy", action="store_true", default=False,
                        help="使用 StealthySession（需要安装浏览器）")
    parser.add_argument("--letpub-only", action="store_true", help="只爬 LetPub")
    parser.add_argument("--springer-only", action="store_true", help="只爬 Springer")

    args = parser.parse_args()

    if not args.name and not args.issn and not args.keyword:
        print(json.dumps({"error": "请提供 --name, --issn 或 --keyword"}))
        sys.exit(1)

    if not HAS_SCRAPLING:
        print(json.dumps({"error": "Scrapling 未安装，请运行: pip install scrapling"}))
        sys.exit(1)

    search_name = args.name or args.keyword or ""

    letpub_data = None
    springer_data = None

    # LetPub 爬取
    if not args.springer_only:
        try:
            if args.stealthy:
                # StealthySession: 用 Patchright 无头浏览器绕过反爬
                with StealthySession(
                    headless=True,
                    solve_cloudflare=True,
                    hide_canvas=True,
                    block_webrtc=True,
                ) as session:
                    if args.issn:
                        letpub_data = search_letpub_by_issn(session, args.issn, use_stealthy=True)
                    if not letpub_data and search_name:
                        letpub_data = search_letpub_by_name(session, search_name, use_stealthy=True)
            else:
                # FetcherSession: 快速 HTTP 模拟浏览器
                with FetcherSession(impersonate="chrome") as session:
                    if args.issn:
                        letpub_data = search_letpub_by_issn(session, args.issn)
                    if not letpub_data and search_name:
                        letpub_data = search_letpub_by_name(session, search_name)
        except Exception as e:
            print(json.dumps({"warning": f"LetPub scraping failed: {str(e)}"}), file=sys.stderr)

    # Springer 爬取
    if not args.letpub_only:
        try:
            time.sleep(1)
            if args.stealthy:
                with StealthySession(
                    headless=True,
                    solve_cloudflare=True,
                ) as session:
                    springer_data = search_springer(session, search_name, args.issn, use_stealthy=True)
            else:
                with FetcherSession(impersonate="chrome") as session:
                    springer_data = search_springer(session, search_name, args.issn)
        except Exception as e:
            print(json.dumps({"warning": f"Springer scraping failed: {str(e)}"}), file=sys.stderr)

    # 合并输出
    result = merge_results(letpub_data, springer_data)

    if not result or (not letpub_data and not springer_data):
        print(json.dumps({"error": "No data found", "name": search_name}))
        sys.exit(1)

    # 确保有 name 字段
    if "name" not in result:
        result["name"] = search_name

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
