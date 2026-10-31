#!/usr/bin/env python3
"""📰 逐檔新聞熱度採礦(V79.9.5)—— 每一檔每天「被報導幾則 / 幾家媒體 / 幾則講到分析師、目標價」

為什麼要有這支(使用者 10/27):
  「富喬最近分析師、新聞都在講、又連跌好幾天 → 是不是該賣」—— 想測這件事,先要有「每一檔每天幾則新聞」。
  本站以前只抓 12 個大盤新聞 RSS,再從標題比對股名(universal_radar → news_hist.json):48 天 667 則、富喬 2 則。
  `news_src_probe`(10/27 Actions 實測):逐檔問 Google 新聞 RSS(「名字 代號」一次 100 則、富喬近 7 天 29 則 / 12 家)、
  鉅亨個股新聞(富喬 37 / 聯茂 78 則)、鉅亨關鍵字搜尋(最多翻 4 頁 ≈ 400 則,小型股約一年、大型股幾個月)。

做法:
  ・每天(收盤後,掛 daily_miner 後面):母體 = 成交額前 N 檔 + 所有概念股成員(stock_tags.json),逐檔問 Google 新聞 RSS(近 3 天)
    + 鉅亨個股新聞;標題要真的講到這一檔(股名或代號,過 universal_radar 那份股名誤配守門,⛔ 第二份);
    同一則(去掉「- 媒體名」後一樣)只算一次;同一天同一件事用 universal_radar 那份 `_same_event` 歸群(⛔ 第二份)。
  ・`--backfill`:鉅亨關鍵字搜尋翻 4 頁 + Google 新聞指定月份(近 12 個月)—— ⚠️ 越舊抓到的越少(來源自己的限制),
    回補的那幾天標 `bf:1`,研究時要分開看。
  ・輸出 data/news_buzz.json(累積檔,走 lib_jsonsafe.load_accum —— 讀壞了 ⛔ 用今天蓋掉歷史)。

⛔ 這支只「數」,不判斷利多利空、不叫 AI。
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

TPE = timezone(timedelta(hours=8))
DATA = Path(os.getenv('DATA_DIR') or 'data')
OUT = DATA / 'news_buzz.json'
TOPN = int(os.getenv('BUZZ_TOPN') or 300)          # 成交額前幾檔
SLEEP = float(os.getenv('BUZZ_SLEEP') or 1.2)      # 每次請求間隔(秒)
MAX_MIN = float(os.getenv('BUZZ_MAX_MIN') or 50)   # 一輪最多跑幾分(超過就停,下一輪接著)
DAYS_KEPT = 400
TITLE_DAYS = 10                                     # 最近幾天保留標題(歸群 / 去重用);更早只留數字
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
ANA_RE = re.compile(r'分析師|目標價|評等|調升|調降|喊買|上修|下修|外資報告|券商|法人看好|研究報告|研調|投顧')


# ── 共用:同一份歸群 / 誤配規則(⛔ 第二份)─────────────────────────
def _radar():
    import universal_radar as ur   # 只拿純函式(_norm_title / _same_event / _NAME_FP / _NAME_NEED)
    return ur


def norm_title(t):
    return _radar()._norm_title(t)


def mentions(title, name, sym):
    """標題有沒有真的講到這一檔:代號、或股名(先蓋掉誤配詞;常用詞股名要額外證據)。"""
    ur = _radar()
    t = str(title or '')
    if sym and re.search(r'(?<!\d)' + re.escape(sym) + r'(?!\d)', t):
        return True
    if not name:
        return False
    masked = t
    for w in ur._NAME_FP:
        if w in masked:
            masked = masked.replace(w, '□' * len(w))
    if name not in masked:
        return False
    need = ur._NAME_NEED.get(name)
    return not need or bool(re.search(need, t))


def tkey(title):
    return hashlib.md5(norm_title(title).encode('utf-8')).hexdigest()[:10]


def tpe_day(dt):
    return dt.astimezone(TPE).strftime('%Y-%m-%d') if dt else None


# ── 抓 ─────────────────────────────────────────────────────────
def _get(url, timeout=20):
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9'})
    for k in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read().decode('utf-8', 'replace')
        except Exception as e:
            code = getattr(e, 'code', None)
            if code in (400, 404):
                return code, ''
            time.sleep(2 * (2 ** k))                 # 指數退避 2 / 4 / 8 秒
    return None, ''


def parse_rss(xml):
    out = []
    for it in re.findall(r'<item>(.*?)</item>', xml or '', re.S):
        t = re.search(r'<title>(.*?)</title>', it, re.S)
        d = re.search(r'<pubDate>(.*?)</pubDate>', it, re.S)
        s = re.search(r'<source[^>]*>(.*?)</source>', it, re.S)
        title = re.sub(r'<!\[CDATA\[|\]\]>', '', t.group(1)).strip() if t else ''
        title = title.replace('&amp;', '&').replace('&quot;', '"').replace('&#39;', "'")
        dt = None
        if d:
            try:
                dt = parsedate_to_datetime(d.group(1).strip())
            except Exception:
                dt = None
        if title and dt:
            out.append({'t': title, 'dt': dt, 'src': (s.group(1).strip() if s else '')[:20]})
    return out


def google_news(name, sym, extra='when:3d'):
    q = f'"{name}" {sym} {extra}'.strip()
    url = 'https://news.google.com/rss/search?' + urllib.parse.urlencode({'q': q, 'hl': 'zh-TW', 'gl': 'TW', 'ceid': 'TW:zh-Hant'})
    code, body = _get(url)
    return parse_rss(body) if code == 200 else None


def cnyes_symbol(sym):
    code, body = _get(f'https://api.cnyes.com/media/api/v1/newslist/TWS:{sym}:STOCK/symbolNews?limit=100&page=1')
    if code != 200:
        return None
    try:
        data = ((json.loads(body).get('items') or {}).get('data')) or []
    except Exception:
        return None
    out = []
    for x in data:
        ts = x.get('publishAt')
        if ts and x.get('title'):
            out.append({'t': str(x['title']), 'dt': datetime.fromtimestamp(int(ts), timezone.utc), 'src': '鉅亨'})
    return out


def cnyes_keyword(name, pages=4):
    out = []
    for pg in range(1, pages + 1):
        code, body = _get('https://ess.api.cnyes.com/ess/api/v1/news/keyword?' + urllib.parse.urlencode({'q': name, 'limit': 100, 'page': pg}))
        if code != 200:
            break
        try:
            items = ((json.loads(body).get('data') or {}).get('items')) or []
        except Exception:
            break
        if not items:
            break
        for x in items:
            ts = x.get('publishAt')
            if ts and x.get('title'):
                out.append({'t': re.sub(r'</?mark>', '', str(x['title'])), 'dt': datetime.fromtimestamp(int(ts), timezone.utc), 'src': '鉅亨'})
        time.sleep(SLEEP)
    return out


# ── 併進累積檔 ───────────────────────────────────────────────────
def merge_items(rec, items, name, sym, bf=False):
    """items → rec[date] = {n 則, e 件事, m 家媒體, a 講到分析師/目標價, t 標題(最近 TITLE_DAYS 天), k 去重鍵}。
    只收標題真的講到這一檔的;同一則(去掉媒體名一樣)只算一次;同一天同一件事(_same_event)算一件。回新增幾則。"""
    ur = _radar()
    add = 0
    for it in items or []:
        if not mentions(it['t'], name, sym):
            continue
        d = tpe_day(it['dt'])
        if not d:
            continue
        day = rec.setdefault(d, {'n': 0, 'e': 0, 'm': [], 'a': 0, 't': [], 'k': []})
        # 🐛 V80.1.2 那一天已經被 prune 壓成只剩數字(超過 TITLE_DAYS 天,沒有去重鍵 k)→ 那天的數字已經定了,
        #   ⛔ 再加(分不出是不是同一則,會重複算)。10/30 起每一輪都在這裡 KeyError: 'k' 整支掛掉(news_buzz 停在 10/27)。
        if not isinstance(day.get('k'), list):
            continue
        k = tkey(it['t'])
        if k in day['k']:
            continue
        day['k'].append(k)
        day['n'] += 1
        add += 1
        if it['src'] and it['src'] not in day['m']:
            day['m'].append(it['src'])
        if ANA_RE.search(it['t']):
            day['a'] += 1
        if not any(ur._same_event(it['t'], o) for o in day['t']):
            day['e'] += 1
        day['t'].append(norm_title(it['t'])[:80])
        if bf:
            day['bf'] = 1
    return add


def prune(rec, today):
    """超過 DAYS_KEPT 天的刪掉;超過 TITLE_DAYS 天的只留數字(n / e / a / 幾家媒體)。"""
    cut = (datetime.strptime(today, '%Y-%m-%d') - timedelta(days=DAYS_KEPT)).strftime('%Y-%m-%d')
    tcut = (datetime.strptime(today, '%Y-%m-%d') - timedelta(days=TITLE_DAYS)).strftime('%Y-%m-%d')
    for d in list(rec.keys()):
        if d < cut:
            del rec[d]
        elif d < tcut and isinstance(rec[d].get('m'), list):
            day = rec[d]
            rec[d] = {k: v for k, v in {'n': day['n'], 'e': day['e'], 'm': len(day['m']), 'a': day['a'], 'bf': day.get('bf')}.items() if v is not None}


def universe():
    def jl(p):
        try:
            return json.loads((DATA / p).read_text(encoding='utf-8'))
        except Exception:
            return {}
    names = {s: v[0] for s, v in (jl('stock_names.json').get('names') or {}).items() if isinstance(v, list) and v}
    scr = jl('screener.json')
    cols = scr.get('cols') or []
    ia = cols.index('amt20') if 'amt20' in cols else None
    rows = scr.get('rows') or {}
    ranked = sorted(((s, (r[ia] or 0) if ia is not None and ia < len(r) else 0) for s, r in rows.items()
                     if re.fullmatch(r'[1-9]\d{3}', s)), key=lambda x: -x[1])
    syms = [s for s, _ in ranked[:TOPN]]
    for s in (jl('stock_tags.json').get('by_stock') or {}):
        if re.fullmatch(r'[1-9]\d{3}', s) and s not in syms:
            syms.append(s)
    return [(s, names.get(s)) for s in syms if names.get(s)], len(ranked)


def run(backfill=False):
    from lib_jsonsafe import load_accum
    t0 = time.time()
    today = datetime.now(TPE).strftime('%Y-%m-%d')
    J, can_write = load_accum(OUT, {'s': {}}, what='news_buzz.json')
    if not can_write:
        return 1
    S = J.setdefault('s', {})
    U, nrank = universe()
    if len(U) < 50:
        print(f'❌ 母體只有 {len(U)} 檔(screener {nrank} 檔)→ 資料沒還原到,不跑')
        return 1
    print(f'📰 母體 {len(U)} 檔(成交額前 {TOPN} + 概念股成員)・{"回補" if backfill else "每天"}模式')
    st = {'ok': 0, 'fail': 0, 'add': 0, 'g_fail': 0, 'c_fail': 0}
    start = int(J.get('cursor') or 0) if backfill else 0
    done_i = start
    for i in range(start, len(U)):
        if (time.time() - t0) / 60 > MAX_MIN:
            print(f'⏱️ 到時間上限 {MAX_MIN} 分 → 停在第 {i} 檔,下一輪接著')
            break
        sym, nm = U[i]
        rec = S.setdefault(sym, {})
        got = 0
        if backfill:
            got += merge_items(rec, cnyes_keyword(nm), nm, sym, bf=True)
            now = datetime.now(TPE)
            for k in range(1, 13):
                a = (now.replace(day=1) - timedelta(days=30 * (k - 1))).replace(day=1)
                b = (a + timedelta(days=32)).replace(day=1)
                g = google_news(nm, sym, f'after:{a:%Y-%m-%d} before:{b:%Y-%m-%d}')
                if g is None:
                    st['g_fail'] += 1
                got += merge_items(rec, g or [], nm, sym, bf=True)
                time.sleep(SLEEP)
        else:
            g = google_news(nm, sym)
            if g is None:
                st['g_fail'] += 1
            got += merge_items(rec, g or [], nm, sym)
            time.sleep(SLEEP)
            c = cnyes_symbol(sym)
            if c is None:
                st['c_fail'] += 1
            got += merge_items(rec, c or [], nm, sym)
            time.sleep(SLEEP)
        prune(rec, today)
        st['add'] += got
        st['ok'] += 1
        done_i = i + 1
    if backfill:
        J['cursor'] = done_i if done_i < len(U) else 0
        J['bf_done'] = done_i >= len(U)
    tried = st['ok']
    # 🚧 空過守門:兩個來源都幾乎全掛 = 被擋了 → ⛔ 寫檔(保留舊的)
    if tried and st['g_fail'] >= tried * (12 if backfill else 1) * 0.8 and st['c_fail'] >= tried * 0.8 * (0 if backfill else 1):
        print(f'❌ 來源幾乎全部失敗(Google {st["g_fail"]} / 鉅亨 {st["c_fail"]})→ 不寫檔')
        return 1
    J.update({'updated': datetime.now(TPE).strftime('%Y-%m-%d %H:%M'), 'days_kept': DAYS_KEPT, 'title_days': TITLE_DAYS,
              'src': 'Google 新聞 RSS(名字 + 代號)+ 鉅亨個股新聞;回補:鉅亨關鍵字搜尋 4 頁 + Google 指定月份(bf:1)',
              'fields': {'n': '被報導幾則(同一則只算一次)', 'e': '同一天幾件事(同一件事多家報算一件)', 'm': '幾家媒體', 'a': '幾則講到分析師 / 目標價 / 評等', 'bf': '回補來的(越舊越少)'},
              'n_syms': len(S)})
    OUT.write_text(json.dumps(J, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'✅ {tried} 檔 ・新增 {st["add"]} 則 ・Google 失敗 {st["g_fail"]} ・鉅亨失敗 {st["c_fail"]} ・{(time.time() - t0) / 60:.1f} 分 → {OUT}')
    return 0


def _selftest():
    bad = []

    def ok(n, c, e=''):
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:200]}")
        if not c:
            bad.append(n)
    xml = ('<rss><item><title><![CDATA[富喬10月營收創新高 - 工商時報]]></title><pubDate>Mon, 26 Oct 2026 17:00:00 GMT</pubDate><source url="x">工商時報</source></item>'
           '<item><title>富喬10月營收創新高 - 自由時報</title><pubDate>Mon, 26 Oct 2026 18:00:00 GMT</pubDate><source url="y">自由時報</source></item>'
           '<item><title>分析師喊買富喬 目標價上看300元</title><pubDate>Tue, 27 Oct 2026 02:00:00 GMT</pubDate><source url="z">鉅亨</source></item>'
           '<item><title>緯創女子公開賽開打</title><pubDate>Tue, 27 Oct 2026 02:00:00 GMT</pubDate></item></rss>')
    it = parse_rss(xml)
    ok('① RSS 解析 4 則、日期 / 媒體都有', len(it) == 4 and it[0]['src'] == '工商時報', it)
    ok('② 台北日期:UTC 10-26 17:00 = 台北 10-27', tpe_day(it[0]['dt']) == '2026-10-27', tpe_day(it[0]['dt']))
    rec = {}
    n = merge_items(rec, it, '富喬', '1815')
    d = rec.get('2026-10-27', {})
    ok('③ 同一則換個媒體名只算一次(去掉「- 媒體名」後一樣)、沒講到這檔的不收', n == 2 and d.get('n') == 2, (n, d))
    ok('③ 講到分析師 / 目標價 → a 記 1', d.get('a') == 1, d)
    n2 = merge_items(rec, it, '富喬', '1815')
    ok('④ 同一份再跑一次 → 0 則(冪等)', n2 == 0 and rec['2026-10-27']['n'] == 2, (n2, rec))
    r2 = {}
    merge_items(r2, [{'t': '富喬8月營收9.39億元 年增82%', 'dt': it[0]['dt'], 'src': 'A'},
                     {'t': '玻纖布漲價 富喬8月營收9.39億元創新高', 'dt': it[0]['dt'], 'src': 'B'}], '富喬', '1815')
    ok('⑤ 同一天同一件事兩家報 → n=2 / e=1(universal_radar 的 _same_event)', r2['2026-10-27']['n'] == 2 and r2['2026-10-27']['e'] == 1, r2)
    ok('⑥ 股名誤配守門:「東南亞」⛔ 算南亞;代號 1303 算', not mentions('東南亞市場', '南亞', '1303') and mentions('台塑四寶 1303 走強', '南亞', '1303'))
    ok('⑥ 代號要整個數字:「21815」⛔ 算 1815', not mentions('編號21815', '富喬', '1815'))
    old = {'2025-01-01': {'n': 3, 'e': 2, 'm': ['A', 'B'], 'a': 0, 't': ['x'], 'k': ['k']}, '2026-10-20': {'n': 1, 'e': 1, 'm': ['A'], 'a': 0, 't': ['y'], 'k': ['k2']},
           '2026-10-01': {'n': 2, 'e': 1, 'm': ['A', 'B'], 'a': 1, 't': ['z'], 'k': ['k3'], 'bf': 1}}
    prune(old, '2026-10-27')
    ok('⑦ 超過 400 天刪掉;超過 10 天只留數字(m 變家數、bf 留著);10 天內原樣', '2025-01-01' not in old and old['2026-10-01'] == {'n': 2, 'e': 1, 'm': 2, 'a': 1, 'bf': 1}
       and old['2026-10-20']['t'] == ['y'], old)
    # ⑧ 🐛 V80.1.2 新抓到一則「已經壓成只剩數字那天」的新聞 → ⛔ 當掉(以前 KeyError: 'k')、⛔ 重複算;決定性對照:沒壓過的那天照收
    snap = json.dumps(old, sort_keys=True)
    try:
        n8 = merge_items(old, [{'t': '富喬法說會釋出展望', 'dt': datetime(2026, 10, 1, 2, 0, tzinfo=timezone.utc), 'src': 'C'}], '富喬', '1815'); e8 = None
    except Exception as e:
        n8, e8 = None, e
    ok('⑧ 已經壓成只剩數字的那天又抓到新聞 → ⛔ 當掉、⛔ 加(那天的數字不動)', e8 is None and n8 == 0 and json.dumps(old, sort_keys=True) == snap, (n8, e8))
    n8b = merge_items(old, [{'t': '富喬法說會釋出展望', 'dt': datetime(2026, 10, 20, 2, 0, tzinfo=timezone.utc), 'src': 'C'}], '富喬', '1815')
    ok('⑧b 決定性對照:還沒壓過的那天(10/20)照收 1 則', n8b == 1 and old['2026-10-20']['n'] == 2, (n8b, old['2026-10-20']))
    print('\n✅ NEWS_BUZZ_SELFTEST_PASS' if not bad else f'\n❌ NEWS_BUZZ_SELFTEST_FAIL {len(bad)}')
    return 1 if bad else 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(_selftest())
    sys.exit(run(backfill='--backfill' in sys.argv))
