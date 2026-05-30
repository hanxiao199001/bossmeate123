#!/usr/bin/env python3
"""
解析中文核心目录原始数据 → 结构化 JSON。
支持三种源:
  - 北大核心 (zzqklm HTML): 2 列表格, 分类行(col1=学科名,col2=中图法码) + 期刊行(col1=序号,col2=刊名)
  - CSSCI    (zzqklm HTML): 3 列表格, 每行 = 序号 | 刊名 | 学科(col3 自带)
  - CSCD     (图书馆 PDF→pdftotext -layout): 序号 期刊名 ISSN 库标识(核心库/扩展库), 带 ISSN
用法:
  python3 parse-domestic-core.py html <raw.html> <catalog> <year> <out.json>
  python3 parse-domestic-core.py cscd <cscd.txt> <year> <out.json>
"""
import re, json, sys

def txt(s):
    s = re.sub(r'<[^>]+>', '', s).replace('&amp;', '&').replace('&nbsp;', ' ')
    return re.sub(r'\s+', ' ', s).strip()

def parse_html(html, catalog, year):
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S)
    out, cur_disc, cur_code = [], None, None
    for r in rows:
        cells = re.findall(r'<td([^>]*)>(.*?)</td>', r, re.S)
        if not cells or any('colspan' in a for a, _ in cells):
            continue  # 编/标题/提示行
        attrs = [a for a, _ in cells]
        cols = [txt(t) for _, t in cells]
        is_num = ('x:num' in attrs[0]) or bool(re.fullmatch(r'\d+', cols[0]))
        if is_num and len(cols) >= 2 and cols[1]:
            disc = cols[2] if len(cols) >= 3 and cols[2] else cur_disc  # CSSCI 第3列, 否则北大核心当前分类
            out.append({"name": cols[1], "discipline": disc, "disciplineCode": cur_code if len(cols) < 3 else None,
                        "catalog": catalog, "catalogYear": year})
        elif len(cols) == 2 and cols[0] not in ('排序',):
            cur_disc, cur_code = cols[0], cols[1]  # 北大核心分类行
    return out

def parse_cscd(text, year):
    out = []
    pat = re.compile(r'^\s*\d+\s+(.+?)\s+(\d{4}-\d{3}[\dXx])\s+(核心库|扩展库)\s*$')
    pat_noissn = re.compile(r'^\s*\d+\s+(.+?)\s+(核心库|扩展库)\s*$')
    for line in text.splitlines():
        m = pat.match(line)
        if m:
            out.append({"name": m.group(1).strip(), "issn": m.group(2).upper(),
                        "cscdLevel": m.group(3), "catalog": "cscd", "catalogYear": year})
        else:
            m2 = pat_noissn.match(line)
            if m2 and not re.search(r'期刊名称|库标识', line):
                out.append({"name": m2.group(1).strip(), "issn": None,
                            "cscdLevel": m2.group(2), "catalog": "cscd", "catalogYear": year})
    return out

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "html":
        raw, catalog, year, outp = sys.argv[2:6]
        data = parse_html(open(raw, encoding="utf-8", errors="replace").read(), catalog, year)
    elif mode == "cscd":
        raw, year, outp = sys.argv[2:5]
        data = parse_cscd(open(raw, encoding="utf-8", errors="replace").read(), year)
    else:
        sys.exit("mode 必须是 html 或 cscd")
    json.dump(data, open(outp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"解析 {len(data)} 条 → {outp}")
