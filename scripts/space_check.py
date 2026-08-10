#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
📦 空間體檢 —— 一次看完「用了多少、還剩多少、快爆的是哪一個」

⭐ 為什麼要這支:GitHub 的容量限制**分散在四個完全不同的地方**,
   而且網頁設定頁只看得到其中兩個。憑印象猜會猜錯 —— 真正會先爆的是
   **GitHub Pages 的 1GB 站台上限**,不是 repo 大小,也不是 Actions 分鐘數。

⛔ 這支只讀不寫:不碰 gh-pages/data、不採礦、不刪任何東西。
⛔ 安全:只用 workflow 自己的 GITHUB_TOKEN,不需要任何額外金鑰。

四個額度各自獨立(⛔ 別混為一談):
  ① GitHub Pages 站台大小 —— 上限 1 GB /**每個 repo 各自算**  ← 本專案最緊的一個
  ② repo 的 git 大小       —— 建議 <1 GB,超過 5 GB 會收到官方來信
  ③ Actions 執行分鐘數     —— **公開 repo 免費無上限**(私有才有 2,000 分/月)
  ④ Actions artifact 儲存  —— **公開 repo 免費**;但過期天數沒設會一直堆
"""
import json
import os
import sys
import urllib.error
import urllib.request

OWNER = os.getenv('GH_OWNER', 'xin7355-collab')
REPO = os.getenv('GH_REPO', 'StockAI-DB')
TOKEN = os.getenv('GITHUB_TOKEN', '')
API = 'https://api.github.com'
GB = 1073741824
MB = 1048576
PAGES_LIMIT = 1 * GB          # GitHub Pages 站台大小上限(每個 repo)


def gh(path, timeout=30):
    req = urllib.request.Request(API + path, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'space-check',
        **({'Authorization': f'Bearer {TOKEN}'} if TOKEN else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8')), None
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode('utf-8', 'replace'))
            msg = str(body.get('message'))[:120]
        except Exception:
            msg = ''
        return None, f'HTTP {e.code} {msg}'
    except Exception as e:
        return None, f'{type(e).__name__}: {str(e)[:80]}'


def bar(used, total, width=28):
    """⭐ 進度條 —— 使用者說「看不懂程式碼」,一條長條比一堆數字直覺得多"""
    if not total:
        return '(無上限)'
    p = max(0.0, min(1.0, used / total))
    n = int(p * width)
    return f"[{'█' * n}{'░' * (width - n)}] {p * 100:5.1f}%"


def human(b):
    return f'{b / GB:.2f} GB' if b >= GB else f'{b / MB:.1f} MB'


def main():
    print('=' * 62)
    print(f'📦 空間體檢 — {OWNER}/{REPO}')
    print('=' * 62)

    repo, err = gh(f'/repos/{OWNER}/{REPO}')
    if err:
        print(f'❌ 讀不到 repo 資訊:{err}')
        return 1
    public = not repo.get('private')
    git_bytes = (repo.get('size') or 0) * 1024      # API 的 size 單位是 KB

    # ── ① GitHub Pages 站台大小(最緊的一個)──────────────────────────
    print('\n① 🌐 網站空間(GitHub Pages)—— ⚠️ 本專案最先會爆的就是這個')
    pages, perr = gh(f'/repos/{OWNER}/{REPO}/pages')
    site = None
    if pages:
        # build 資訊裡才有實際站台大小
        b, _ = gh(f'/repos/{OWNER}/{REPO}/pages/builds/latest')
        if b:
            print(f"   最後一次部署:{(b.get('created_at') or '')[:19].replace('T', ' ')} ・{b.get('status')}")
    # ⚠️ API 不直接給站台大小 → 由 gh-pages 分支的檔案總和推估(這才是真正被算的東西)
    tree, terr = gh(f'/repos/{OWNER}/{REPO}/git/trees/gh-pages?recursive=1')
    if tree and tree.get('tree'):
        blobs = [t for t in tree['tree'] if t.get('type') == 'blob']
        site = sum(t.get('size') or 0 for t in blobs)
        print(f'   已用 {human(site)} / 1.00 GB  {bar(site, PAGES_LIMIT)}')
        print(f'   還可以放 {human(PAGES_LIMIT - site)}(共 {len(blobs):,} 個檔案)')
        if tree.get('truncated'):
            print('   ⚠️ 檔案太多,API 只回了一部分 → 這個數字是**低估**的')
        # 佔最大的前幾個資料夾
        agg = {}
        for t in blobs:
            p = t['path'].split('/')
            k = '/'.join(p[:2]) if len(p) > 2 else (p[0] if len(p) == 1 else '/'.join(p[:1]))
            agg[k] = agg.get(k, 0) + (t.get('size') or 0)
        print('   佔最多的:')
        for k, v in sorted(agg.items(), key=lambda x: -x[1])[:5]:
            print(f'      {human(v):>10}  {k}')
    else:
        print(f'   ⚠️ 讀不到 gh-pages 內容({terr or perr or "沒有這個分支"})')

    # ── ② repo 本身的 git 大小 ────────────────────────────────────
    print('\n② 📚 程式碼倉庫大小(git)')
    print(f'   已用 {human(git_bytes)}  ・建議 <1 GB,超過 5 GB 官方會來信')
    print(f'   {bar(git_bytes, 5 * GB)} (對 5 GB 的警戒線)')

    # ── ③ Actions 執行時間 ───────────────────────────────────────
    print('\n③ ⚙️ 雲端後台執行時間(Actions)')
    if public:
        print('   ✅ 這是**公開**倉庫 → 執行分鐘數**免費、無上限**(標準機器)')
        print('   ⛔ 所以不管跑幾次採礦都不會扣額度、不會被收費')
    else:
        print('   ⚠️ 這是私有倉庫 → 免費方案每月 2,000 分鐘')
    runs, _ = gh(f'/repos/{OWNER}/{REPO}/actions/runs?per_page=1')
    if runs:
        print(f"   目前保留著的執行紀錄:{runs.get('total_count', 0):,} 筆")

    # ── ④ artifact 儲存(過期天數沒設會一直堆)─────────────────────
    print('\n④ 🗃️ 執行產物暫存(artifact)')
    live_n = live_b = exp_n = 0
    scanned = 0
    for p in range(1, 31):
        d, _e = gh(f'/repos/{OWNER}/{REPO}/actions/artifacts?per_page=100&page={p}')
        arr = (d or {}).get('artifacts') or []
        if not arr:
            break
        scanned += len(arr)
        for a in arr:
            if a.get('expired'):
                exp_n += 1
            else:
                live_n += 1
                live_b += a.get('size_in_bytes') or 0
    print(f'   還沒過期 {live_n} 個 → 佔 {human(live_b)}(已過期 {exp_n} 個,不佔空間)')
    print(f'   {"✅ 公開倉庫 → 這一項也是免費的" if public else "⚠️ 私有倉庫 → 免費方案共 500 MB"}')
    if scanned >= 3000:
        print(f'   ⚠️ 只掃了前 {scanned} 個,實際更多 → 上面是**低估**')

    # ── 結論 ────────────────────────────────────────────────────
    print('\n' + '=' * 62)
    if site is not None:
        left = PAGES_LIMIT - site
        print(f'📌 一句話:網站空間用了 {site / PAGES_LIMIT * 100:.0f}%,還剩 {human(left)}。')
        if site > 0.85 * PAGES_LIMIT:
            print('   🚨 快滿了 —— 要開始清舊資料或把大檔改成只推 data 分支(前端不讀的就別放網站)。')
        elif site > 0.6 * PAGES_LIMIT:
            print('   ⚠️ 過半了 —— 還能撐,但新增大檔前先想想放哪。')
        else:
            print('   ✅ 空間充裕。')
    print('⭐ 每個 repo 各有自己的 1 GB 網站空間 → 再開新專案不會吃掉這個的額度。')
    print('=' * 62)
    return 0


if __name__ == '__main__':
    sys.exit(main())
