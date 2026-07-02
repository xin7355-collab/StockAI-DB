#!/usr/bin/env python3
"""🏷️ 概念股採礦(megatime)— 自我診斷版

爬 pchome.megatime.com.tw 的族群/概念股 → data/concept_stocks.json

輸出格式:
  {
    "updated": "2026-07-02T21:40:00+08:00",
    "source": "megatime",
    "group_count": 123,
    "groups":   { "AI伺服器": ["2317","2382", ...], ... },   # 族群→成分股
    "by_stock": { "2317": ["AI伺服器","蘋果供應鏈"], ... }    # 個股→所屬族群(前端用)
  }

⚠️ 這個開發沙盒連不到 megatime(403),此腳本設計成「跑在 GitHub Actions」。
第一次跑會把 index 的連結、前幾個族群頁的樣本 print 出來,方便對結構後再收斂解析。
純標準庫(urllib + re),無外部相依。
"""
import re
import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta
import urllib.request
import urllib.error

BASE = "https://pchome.megatime.com.tw"
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")
DATA = Path(__file__).parent / "data"
TPE = timezone(timedelta(hours=8))

# 第一批要探的 index 候選(mobile / desktop / 可能的 API)
INDEX_CANDIDATES = [
    BASE + "/m/group/",
    BASE + "/group/",
    BASE + "/m/group/index.html",
]

TAG_RE = re.compile(r"<[^>]+>")
A_RE = re.compile(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.I | re.S)


def _txt(s):
    return TAG_RE.sub("", s or "").strip()


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                enc = r.headers.get_content_charset() or "utf-8"
                return raw.decode(enc, errors="ignore"), r.status
        except urllib.error.HTTPError as e:
            print(f"   HTTP {e.code} ← {url}")
            if e.code in (403, 404):
                return None, e.code
        except Exception as e:
            print(f"   ERR {url}: {e}")
        time.sleep(1.5 * (attempt + 1))
    return None, 0


def abs_url(href):
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return BASE + href
    return BASE + "/" + href


def extract_codes(html):
    """從一頁 HTML 抽 4 碼股票代號(多種 pattern 取聯集)。"""
    codes = set()
    # pattern 1: /stock/sid2330.html 或 sid=2330
    for m in re.findall(r"sid[=/]?(\d{4})\b", html):
        codes.add(m)
    # pattern 2: /stock/2330.html
    for m in re.findall(r"/stock/(\d{4})", html):
        codes.add(m)
    # pattern 3: 純 4 碼(1000-9999)出現在標籤文字,較雜,僅當上兩者皆空時退而求其次
    if not codes:
        for m in re.findall(r"\b([1-9]\d{3})\b", html):
            codes.add(m)
    return codes


def discover_group_links(index_html):
    """從 index 抽出族群連結 [(name, url)]。"""
    out = []
    seen = set()
    for href, inner in A_RE.findall(index_html):
        name = _txt(inner)
        low = href.lower()
        if "group" not in low:
            continue
        u = abs_url(href)
        if u in seen or u.rstrip("/") in {c.rstrip("/") for c in INDEX_CANDIDATES}:
            continue
        seen.add(u)
        out.append((name, u))
    return out


def main():
    DATA.mkdir(exist_ok=True)
    print(f"🏷️ concept_miner 啟動 {datetime.now(TPE).isoformat(timespec='seconds')}")

    index_html = None
    used_index = None
    for cand in INDEX_CANDIDATES:
        html, status = get(cand)
        print(f"index try {cand} → status={status} len={len(html) if html else 0}")
        if html and len(html) > 500:
            index_html, used_index = html, cand
            break

    if not index_html:
        print("❌ 所有 index 候選都拿不到,結束(可能被擋或改版)")
        sys.exit(1)

    # 🔎 診斷:印出 index 前 40 條 anchor,方便對 URL pattern
    anchors = A_RE.findall(index_html)
    print(f"\n=== index anchors: {len(anchors)} 條(前 40)===")
    for href, inner in anchors[:40]:
        print(f"  [{_txt(inner)[:16]:<16}] {href}")

    groups = discover_group_links(index_html)
    print(f"\n=== 疑似族群連結:{len(groups)} 個(前 30)===")
    for name, u in groups[:30]:
        print(f"  {name[:20]:<20} {u}")

    if not groups:
        print("⚠️ index 沒抽到族群連結 → 印 index 前 3000 字給人看結構")
        print(index_html[:3000])
        # 仍寫一個空檔,讓 workflow 有產物
        _write({}, {}, used_index, note="no_groups")
        return

    # 逐族群抓成分股(第一次跑 cap 上限,避免太久;確認結構後再放寬)
    cap = int(os.environ.get("CONCEPT_GROUP_CAP", "500"))
    group_map = {}
    for i, (name, u) in enumerate(groups[:cap]):
        html, status = get(u)
        if not html:
            continue
        codes = extract_codes(html)
        # 用頁面 title 補強族群名(index 文字可能太短)
        if not name:
            mt = re.search(r"<title>(.*?)</title>", html, re.S)
            name = _txt(mt.group(1)) if mt else u
        if codes:
            group_map.setdefault(name, set()).update(codes)
        if i < 3:
            print(f"\n--- 樣本族群[{i}] {name} ({u}) status={status} codes={len(codes)} ---")
            print("   codes:", sorted(codes)[:20])
        time.sleep(0.25)

    # 收斂 + 反查表
    groups_out = {k: sorted(v) for k, v in group_map.items() if v}
    by_stock = {}
    for gname, syms in groups_out.items():
        for s in syms:
            by_stock.setdefault(s, [])
            if gname not in by_stock[s]:
                by_stock[s].append(gname)

    print(f"\n✅ 族群 {len(groups_out)} 個 / 個股 {len(by_stock)} 檔有標籤")
    _write(groups_out, by_stock, used_index)


def _write(groups_out, by_stock, used_index, note=""):
    payload = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "source": "megatime",
        "index": used_index,
        "note": note,
        "group_count": len(groups_out),
        "groups": groups_out,
        "by_stock": by_stock,
    }
    out = DATA / "concept_stocks.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"💾 已寫 {out}  ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
