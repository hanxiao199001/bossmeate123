#!/usr/bin/env python3
"""
PR Q.1.2: 改用 scrapling.Fetcher（curl_cffi TLS 指纹伪装）替代 StealthyFetcher。

5-7 实测 StealthyFetcher 需 playwright + chromium（系统库 + 下载 ~300MB）；
Fetcher 仅用 curl_cffi 即可突破 sogou TLS 指纹反爬。sogou 微信搜索结果是
HTML + 302 redirect 跳转，不需要 JS 渲染层，curl_cffi 已够。

用法：python3 wechat_fetch.py <url>
stdout：html_content（失败为空）
exit code：0 成功 / 2 状态非 200 / 3 异常
"""
import sys

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: wechat_fetch.py <url>\n")
        sys.exit(1)
    url = sys.argv[1]
    try:
        from scrapling.fetchers import Fetcher
        res = Fetcher.get(url, timeout=20, stealthy_headers=True, follow_redirects=True)
        if res and res.status == 200:
            sys.stdout.write(res.html_content or "")
            sys.exit(0)
        sys.stderr.write(f"scrapling Fetcher failed status={res.status if res else 'none'}\n")
        sys.exit(2)
    except Exception as e:
        sys.stderr.write(f"scrapling error: {e}\n")
        sys.exit(3)

if __name__ == "__main__":
    main()
