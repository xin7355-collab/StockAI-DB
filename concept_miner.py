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
import urllib.parse

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


def get(url, timeout=25, data=None):
    hdr = {
        "User-Agent": UA,
        "Referer": BASE + "/m/group/newgroup",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
    }
    body = urllib.parse.urlencode(data).encode() if data else None
    if body:
        hdr["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    req = urllib.request.Request(url, data=body, headers=hdr)
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


def plist_probe():
    """.plist data-type='X_Y' 是族群;連到 /m/groupinfo/mkt{X}/st{Y}.html。掃四頁 data-type + 跟一頁看成分股結構。"""
    print("📇 PLIST PROBE 模式")
    pages = [BASE + "/m/group/newgroup", BASE + "/m/group/mkt0/",
             BASE + "/m/group/mkt1/", BASE + "/m/group/mkt5/"]
    all_dt = []
    for pg in pages:
        html, st = get(pg)
        print(f"\n########## {pg} status={st} len={len(html) if html else 0} ##########")
        if not html:
            continue
        # data-type 的元素(div/a/li 皆可),抓 data-type + 內文
        pairs = re.findall(r'data-type="([^"]+)"[^>]*>(.*?)</', html, re.S)
        clean = [(dt, _txt(t)[:20]) for dt, t in pairs]
        print(f"  data-type 元素:{len(clean)}")
        for dt, nm in clean[:70]:
            print(f"    {dt:<10} {nm}")
        all_dt += [dt for dt, _ in clean]
    # 跟第一個 X_Y 進 groupinfo 看成分股結構
    uniq = []
    for dt in all_dt:
        if "_" in dt and dt not in uniq:
            uniq.append(dt)
    print(f"\n  唯一 data-type(含底線):{len(uniq)},前 20:", uniq[:20])
    for dt in uniq[:2]:
        x, y = dt.split("_", 1)
        gi = f"{BASE}/m/groupinfo/mkt{x}/st{y}.html"
        html, st = get(gi)
        print(f"\n===== GROUPINFO {gi} status={st} len={len(html) if html else 0} =====")
        if html:
            title = re.search(r"<title>(.*?)</title>", html, re.S)
            print("  title:", _txt(title.group(1)) if title else "?")
            sids = re.findall(r"/m/stock/sid(\d{4})", html)
            print(f"  sid 股票代號({len(sids)}):", sorted(set(sids))[:30])
            # 若沒抓到 sid,印片段
            if not sids:
                print("  (無 sid,前 1200 字)", html[:1200].replace("\n", " "))


def catalog_probe():
    """POST /m/ajax.php mode=market_catalog cat=0..N,印回傳的 .plist 族群清單。"""
    print("🗂️ CATALOG PROBE 模式")
    for cat in range(0, 16):
        html, st = get(BASE + "/m/ajax.php", data={"mode": "market_catalog", "cat": cat})
        if not html or html.strip() == "ERROR":
            print(f"\ncat={cat} → status={st} EMPTY/ERROR")
            continue
        # 抓 .plist data-type + 名稱
        items = re.findall(r'data-type="([^"]+)"[^>]*>(.*?)</', html, re.S)
        names = re.findall(r'data-type="([^"]+)"[^>]*>\s*([^<>]{1,20})', html)
        print(f"\n========== cat={cat} status={st} len={len(html)} items={len(items)} ==========")
        # 印所有 data-type + 清理後文字
        seen = []
        for dt, raw in re.findall(r'data-type="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
            seen.append((dt, _txt(raw)[:16]))
        if not seen:
            for dt, raw in items:
                seen.append((dt, _txt(raw)[:16]))
        for dt, nm in seen[:60]:
            print(f"    {dt:<10} {nm}")
        if not seen:
            print("    (無 data-type,印前 800 字)")
            print("   ", html[:800].replace("\n", " "))


def ajax_probe():
    """已知資料端點 /m/ajax.php + 個股頁 /m/stock/sid。挖 ajax.php 呼叫方式 + 概念族群清單。"""
    print("🛰️ AJAX PROBE 模式")
    # 1) 印小 JS 全文,看 ajax.php 怎麼被呼叫(帶什麼參數)
    for js_url in [BASE + "/m/js/m_all.js?20200326", BASE + "/m/js/swipe.js?20210325"]:
        js, st = get(js_url)
        print(f"\n===== JS {js_url} status={st} len={len(js) if js else 0} =====")
        if js:
            print(js)
    # 2) newgroup 頁的 inline <script> 全印(概念族群清單/ajax 呼叫多半在這)
    html, st = get(BASE + "/m/group/newgroup")
    print(f"\n===== newgroup inline scripts status={st} =====")
    if html:
        for i, block in enumerate(re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)):
            b = block.strip()
            if b:
                print(f"\n--- inline script[{i}] ({len(b)} chars) ---")
                print(b[:2500])
        # HTML 內 group_/cate_/cid token
        toks = sorted(set(re.findall(r"\b((?:group|cate|cid|gid|class|concept)_?[A-Za-z0-9]{1,10})\b", html, re.I)))
        print(f"\n  group/cate tokens ({len(toks)}):", toks[:80])
    # 3) 直接試打 ajax.php 幾種常見參數,看回什麼
    for q in ["", "?type=group", "?mode=group", "?act=group", "?type=newgroup",
              "?type=market&id=TW50", "?type=group&id=01", "?group=01"]:
        u = BASE + "/m/ajax.php" + q
        r, st = get(u)
        head = (r or "")[:300].replace("\n", " ")
        print(f"\n  ajax.php{q} → status={st} len={len(r) if r else 0} head={head}")


def endpoint_probe():
    """頁面是 JS 動態渲染,真正資料在 AJAX/JSON 端點。掃 HTML + JS bundle 找端點。"""
    print("🛰️ ENDPOINT PROBE 模式")
    pages = [BASE + "/m/group/newgroup", BASE + "/m/market/newmarket"]
    ENDPOINT_RE = re.compile(r"""['"(]\s*(/?[\w./?=&%-]*?(?:ajax|api|json|getdata|group|market|stock|quote)[\w./?=&%-]*?)['")\s]""", re.I)
    src_re = re.compile(r'<script[^>]+src="([^"]+)"', re.I)
    for pg in pages:
        html, status = get(pg)
        print(f"\n########## PAGE {pg} status={status} len={len(html) if html else 0} ##########")
        if not html:
            continue
        srcs = src_re.findall(html)
        print(f"  <script src> ({len(srcs)}):")
        for s in srcs:
            print("    ", s)
        # HTML 內疑似端點字串
        hits = sorted(set(m for m in ENDPOINT_RE.findall(html) if len(m) > 6 and not m.lower().endswith((".js", ".css"))))
        print(f"  HTML 疑似端點 ({len(hits)}):")
        for h in hits[:60]:
            print("    ", h)
        # 掃前 3 支站內 JS bundle 找端點
        for s in srcs:
            su = abs_url(s)
            if "megatime" not in su:
                continue
            js, st = get(su)
            if not js:
                continue
            jh = sorted(set(m for m in ENDPOINT_RE.findall(js) if len(m) > 6 and not m.lower().endswith((".js", ".css"))))
            print(f"\n  --- JS {su} status={st} len={len(js)} 端點({len(jh)}) ---")
            for h in jh[:80]:
                print("      ", h)


def deep_probe():
    """探勘各分類頁的結構,把族群連結 + 股票連結 pattern 印出來。"""
    print("🔬 DEEP PROBE 模式")
    targets = [
        BASE + "/m/group/newgroup",
        BASE + "/m/group/mkt0/",
        BASE + "/m/group/mkt5/",
    ]
    NAV_HOSTS = ("shopping", "24h", "member", "news", "show", "ruten", "travel",
                 "car.pchome", "sms", "live", "webhosting", "myname", "mypaper",
                 "global.pchome", "piapp", "pchomepay", "interpay", "rakuya",
                 "faq.pchome", "apis.pchome", "books", "pchomeec", "www.pchome",
                 "www.m.pchome", "cloudmax", "office-sms")
    for url in targets:
        html, status = get(url)
        print(f"\n########## {url} status={status} len={len(html) if html else 0} ##########")
        if not html:
            continue
        anchors = A_RE.findall(html)
        # 過濾掉 PChome 大選單/頁尾,只留 megatime 站內、且非首頁導覽
        keep = []
        for href, inner in anchors:
            low = href.lower()
            if any(h in low for h in NAV_HOSTS):
                continue
            if "megatime" not in low and not href.startswith("/"):
                continue
            keep.append((_txt(inner)[:18], href))
        print(f"  站內 anchors: {len(keep)} (全印)")
        for name, href in keep:
            print(f"    [{name:<18}] {href}")
        # 找股票連結 pattern:印出含 4 碼數字的 href 樣本
        code_hrefs = [h for _, h in keep if re.search(r"\d{4}", h)]
        print(f"  含4碼 href 樣本({len(code_hrefs)}):", code_hrefs[:15])


def main():
    DATA.mkdir(exist_ok=True)
    print(f"🏷️ concept_miner 啟動 {datetime.now(TPE).isoformat(timespec='seconds')}")
    if os.environ.get("CONCEPT_PROBE") == "5":
        plist_probe()
        return
    if os.environ.get("CONCEPT_PROBE") == "4":
        catalog_probe()
        return
    if os.environ.get("CONCEPT_PROBE") == "3":
        ajax_probe()
        return
    if os.environ.get("CONCEPT_PROBE") == "2":
        endpoint_probe()
        return
    if os.environ.get("CONCEPT_PROBE") == "1":
        deep_probe()
        return

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
