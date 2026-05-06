#!/usr/bin/env python3
"""
PR Q.1.1：scrapling stealth fetcher，用于 wechat-batch-crawler 反爬 fallback。
sogou 跳转 url 用标准 fetch 命中"antispider"短响应（5742B），改用 scrapling
StealthyFetcher 突破。

用法：python3 wechat_fetch.py <url>
stdout：html_content（失败为空）
stderr：log
"""
import sys

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: wechat_fetch.py <url>\n")
        sys.exit(1)
    url = sys.argv[1]
    try:
        from scrapling.fetchers import StealthyFetcher
        fetcher = StealthyFetcher(auto_match=False)
        res = fetcher.fetch(url, headless=True, network_idle=True, timeout=20000)
        if res and res.status == 200:
            sys.stdout.write(res.html_content or "")
            sys.exit(0)
        sys.stderr.write(f"scrapling failed status={res.status if res else 'none'}\n")
        sys.exit(2)
    except Exception as e:
        sys.stderr.write(f"scrapling error: {e}\n")
        sys.exit(3)

if __name__ == "__main__":
    main()
