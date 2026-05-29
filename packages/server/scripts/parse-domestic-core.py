#!/usr/bin/env python3
"""
解析 zzqklm 中文核心目录原始 HTML → 结构化 JSON。
表格两列: 分类行(col1=学科名, col2=中图法代码), 期刊行(col1=序号 x:num, col2=刊名), 编/标题行用 colspan.
用法: python3 parse-domestic-core.py <raw.html> <catalog> <year> <out.json>
  catalog: pku-core | cssci | cssci-ext | cscd | sci-core
"""
import re, json, sys

def txt(s):
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace('&amp;', '&').replace('&nbsp;', ' ')
    return re.sub(r'\s+', ' ', s).strip()

def parse(html, catalog, year):
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S)
    out, cur_disc, cur_code = [], None, None
    for r in rows:
        cells = re.findall(r'<td([^>]*)>(.*?)</td>', r, re.S)
        if not cells or any('colspan' in a for a, _ in cells):
            continue  # 编/标题行
        if len(cells) < 2:
            continue
        a_attr, a = cells[0]; b_attr, b = cells[1]
        at, bt = txt(a), txt(b)
        if at == '排序' and bt == '中文刊名':
            continue  # 表头
        if 'x:num' in a_attr or re.fullmatch(r'\d+', at):
            if bt:
                out.append({"name": bt, "discipline": cur_disc, "disciplineCode": cur_code,
                            "catalog": catalog, "catalogYear": year})
        else:
            cur_disc, cur_code = at, bt  # 分类行
    return out

if __name__ == "__main__":
    raw, catalog, year, outp = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    html = open(raw, encoding="utf-8", errors="replace").read()
    data = parse(html, catalog, year)
    json.dump(data, open(outp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"解析 {len(data)} 条 → {outp}")
