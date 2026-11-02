#!/usr/bin/env python3
"""🗽 V80.2.1 川普本人在 Truth Social 的發文 → 散戶 App「消息面 › 🗽 川普」那一格 + 研究存檔(評估紀錄 53)

來源(2026-11-02 macro_probe which=trump_src 實測,run 41514932373):
  ① CNN 存檔 CSV ix.cnn.io/data/truth-social/truth_archive.csv —— 14.9 MB、37,706 列、2022-02-14 起、最新的排最前面;
     欄位 id / created_at / content / url / media / replies_count / reblogs_count / favourites_count;created_at 是 UTC(…Z);
     有 Last-Modified + ETag,帶 If-Modified-Since / If-None-Match 會回 304(沒新的就不用整份重抓);
     轉貼的內文是「RT: <網址>」或「RT @…」;內文空白 = 只有圖 / 影片。
  ② trumpstruth RSS www.trumpstruth.org/feed —— 最近 100 則(約一天)、pubDate +0000、truth:originalId = CNN 的 id;
     兩邊對得上 96%、同一則時間差 0 分 → RSS 只拿來補 CNN 還沒收的最新幾則 + 對帳。
  抓取一律 lib_http.Gate(expect='any'):被擋就停、退避、身分寫明(⛔ 偽裝瀏覽器、⛔ 登入、⛔ 繞 Cloudflare)。

產出:
  data/trump_posts.json(給手機,小):
    posts  最近 14 天「有分類」的原創發文(轉貼 / 只有圖的不算){id, t, cls[], en, zh, ze, url},新的在前
    recent 最近 4 天每一則 [t, 轉貼 0/1, '類別,類別'](App 自己算「上個台股收盤後到現在」)
    days   最近 30 個台北日期每天幾則 {n, rt, c:{類別: 則數}}
    src    兩個來源各自 ok / 則數 / 錯誤 / 對帳率;latest 最新一則的時間;updated(ISO …Z)
  trump_deep/{YYYY-MM}.json.gz(研究存檔,workflow 推 orphan 分支 trump_deep):全部發文 {id, t, x, u, rt, m, zh?, ze?, zt?}
    + trump_deep/_meta.json(上次的 Last-Modified / ETag)。⭐ 只增不減(id 聯集);讀不出來的月份 ⛔ 覆蓋。
分類 / 對台股日 / 文字清理一律 lib_trump(全 repo 唯一一份)。

翻譯:只翻「新的、有分類的原創發文」,每輪最多 TR_CAP(15)則;universal_radar._groq_json(模型 / 金鑰輪替都在裡面);
  翻完 confcall_deck.num_gate(中文, 原文):有原文找不到的數字 → ⛔ 用這份翻譯(ze 寫原因,畫面顯示原文)。
  失敗會重試,同一則最多 3 次(zt)。沒有金鑰 / SKIP_AI=1 → 只放原文。

跑法:OUT=data/trump_posts.json DEEP_DIR=trump_deep python3 trump_posts_miner.py
      FULL=1(⛔ 帶 304 條件、整份重併;研究存檔掉了才用)・python3 trump_posts_miner.py --selftest
結束碼:兩個來源都抓不到而且研究存檔是空的(= 什麼都給不出來)→ 1;其他 0。GITHUB_OUTPUT:push_app / push_deep。
"""
import csv
import gzip
import io
import json
import os
import re
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_trump import CLS, classify, clean_text, iso_z, parse_ts, TW  # noqa: E402
from lib_jsonsafe import load_json_safe  # noqa: E402

CNN_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.csv'
RSS_URL = 'https://www.trumpstruth.org/feed'
NS = {'truth': 'https://truthsocial.com/ns'}
POST_DAYS, RECENT_DAYS, COUNT_DAYS = 14, 4, 30
TR_CAP, TR_TRIES, EN_MAX, TR_GAP = 15, 3, 600, 2.5
_QUOTA = re.compile(r'上限|冷卻|429|quota|rate', re.I)
csv.field_size_limit(10 ** 7)
_PLACEHOLDER = re.compile(r'^(Video|Image|Photo|Quote|Link|Poll) post from ', re.I)


def is_rt(text):
    t = (text or '').lstrip()
    return t.startswith('RT:') or t.startswith('RT @')


def cnn_rows(text):
    """CSV 全文 → [{id, t, x, u, rt, m}](時間讀不出來 / 沒有 id 的列不收)"""
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        pid = str(r.get('id') or '').strip()
        t = parse_ts(r.get('created_at'))
        if not pid or t is None:
            continue
        raw = r.get('content') or ''
        x = clean_text(raw)
        out.append({'id': pid, 't': iso_z(t), 'x': x, 'u': (r.get('url') or '').strip(),
                    'rt': 1 if is_rt(x) else 0, 'm': 1 if (r.get('media') or '').strip() else 0})
    return out


def rss_rows(blob):
    """RSS → 同上格式(只收有 originalId 的;[No Title] 那種用內文)"""
    root = ET.fromstring(blob)
    out = []
    for it in root.findall('.//item'):
        def g(tag, ns=None):
            el = it.find(tag, ns) if ns else it.find(tag)
            return (el.text or '').strip() if el is not None and el.text else ''
        pid = g('truth:originalId', NS)
        t = parse_ts(g('pubDate'))
        if not pid or t is None:
            continue
        title, desc = g('title'), g('description')
        x = clean_text(desc) if desc else ('' if '[No Title]' in title else clean_text(title))
        if _PLACEHOLDER.match(x):          # RSS 對只有圖 / 影片 / 引用的發文給「Video post from …」這種佔位字 → 當成沒有內文
            x = ''
        out.append({'id': pid, 't': iso_z(t), 'x': x, 'u': g('truth:originalUrl', NS) or g('link'),
                    'rt': 1 if is_rt(x) else 0, 'm': 0})
    return out


def month_of(t):
    return t[:7]


def load_deep(deep_dir, log=print):
    """→ (posts{id: post}, meta, bad_months{月份})。讀不出來的月份記起來 ⛔ 之後覆蓋。"""
    posts, bad = {}, set()
    d = Path(deep_dir)
    meta, st, _ = load_json_safe(d / '_meta.json', {}, log=log, what='trump_deep/_meta.json')
    for f in sorted(d.glob('*.json.gz')):
        m = f.name[:7]
        try:
            with gzip.open(f, 'rt', encoding='utf-8') as fh:
                obj = json.load(fh)
            for p in obj.get('posts') or []:
                if p.get('id'):
                    posts[p['id']] = p
        except Exception as e:  # noqa: BLE001
            bad.add(m)
            log(f'❌ trump_deep/{f.name} 讀不出來({type(e).__name__})→ 這輪 ⛔ 覆蓋這個月')
    return posts, (meta or {}) if st != 'corrupt' else {}, bad


def merge(posts, rows):
    """id 聯集:新的加進來;已經有的只更新內文(⛔ 刪任何一則、⛔ 動翻譯)。回新增幾則。"""
    add = 0
    for r in rows:
        old = posts.get(r['id'])
        if old is None:
            posts[r['id']] = dict(r)
            add += 1
        else:
            for k in ('t', 'u', 'rt', 'm'):
                if r.get(k) not in (None, ''):
                    old[k] = r[k]
            if r.get('x') and r['x'] != old.get('x'):
                old['x'] = r['x']
                for k in ('zh', 'ze', 'zt'):      # 內文改了 → 舊翻譯不算數
                    old.pop(k, None)
    return add


def write_deep(deep_dir, posts, bad, months_before, log=print):
    """只寫內容有變的月份;讀不出來的月份 ⛔ 碰。回寫了幾個月。"""
    d = Path(deep_dir)
    d.mkdir(parents=True, exist_ok=True)
    by = {}
    for p in posts.values():
        by.setdefault(month_of(p['t']), []).append(p)
    n = 0
    for m, ps in sorted(by.items()):
        if m in bad:
            continue
        ps.sort(key=lambda p: (p['t'], p['id']))
        blob = json.dumps({'m': m, 'n': len(ps), 'posts': ps}, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        if months_before.get(m) == blob:
            continue
        with gzip.open(d / f'{m}.json.gz', 'wt', encoding='utf-8') as fh:
            fh.write(blob)
        n += 1
    return n


def snapshot_months(posts):
    by = {}
    for p in posts.values():
        by.setdefault(month_of(p['t']), []).append(p)
    out = {}
    for m, ps in by.items():
        ps = sorted(ps, key=lambda p: (p['t'], p['id']))
        out[m] = json.dumps({'m': m, 'n': len(ps), 'posts': ps}, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    return out


def default_translate(text):
    """→ (中文 | None, 原因)。universal_radar._groq_json(延後 import:selftest / 沒有金鑰不用載入)"""
    if os.environ.get('SKIP_AI', '0') == '1':
        return None, '沒翻譯(SKIP_AI)'
    import universal_radar as U   # noqa: E402
    if not U.GROQ_API_KEYS:
        return None, '沒翻譯(沒有金鑰)'
    payload = {
        'model': None,
        'messages': [{'role': 'user', 'content':
                      '把下面這則美國總統川普在 Truth Social 上的發文翻成繁體中文(台灣用語)。'
                      '只翻譯,不要評論、不要補充、不要加任何原文沒有的資訊;數字、人名、國名照原文的意思翻。'
                      '只輸出 JSON:{"zh":"…"}\n原文:' + text[:EN_MAX]}],
        'max_tokens': 900,
        'temperature': 0.2,
    }
    parsed, err = U._groq_json(payload, label='trump_post')
    zh = str((parsed or {}).get('zh') or '').strip()
    return (zh, '') if zh else (None, err or '翻譯回空的')


def default_num_gate(zh, en):
    from confcall_deck import num_gate   # noqa: E402
    return num_gate(zh, en)


def build_app(posts, now, src):
    """研究存檔 → 給手機的那一份(⛔ 這裡不打網路)"""
    tw_now = now.astimezone(TW)
    cut_post = iso_z(now - timedelta(days=POST_DAYS))
    cut_recent = iso_z(now - timedelta(days=RECENT_DAYS))
    cut_days = (tw_now - timedelta(days=COUNT_DAYS - 1)).strftime('%Y-%m-%d')
    out_posts, recent, days, latest = [], [], {}, ''
    for p in sorted(posts.values(), key=lambda p: (p['t'], p['id']), reverse=True):
        t = p['t']
        if t > iso_z(now + timedelta(minutes=5)):
            continue                                   # 時間比現在還晚 = 對方時鐘錯 → 不收
        latest = latest or t
        orig = not p.get('rt') and bool(p.get('x'))
        cls = classify(p['x']) if orig else []
        if t >= cut_recent:
            recent.append([t, 1 if p.get('rt') else 0, ','.join(cls)])
        d = parse_ts(t).astimezone(TW).strftime('%Y-%m-%d')
        if d >= cut_days:
            e = days.setdefault(d, {'n': 0, 'rt': 0, 'c': {}})
            e['n'] += 1
            e['rt'] += 1 if p.get('rt') else 0
            for c in cls:
                e['c'][c] = e['c'].get(c, 0) + 1
        if cls and t >= cut_post:
            out_posts.append({'id': p['id'], 't': t, 'cls': cls, 'en': p['x'][:EN_MAX], 'zh': p.get('zh'),
                              'ze': p.get('ze'), 'url': p.get('u') or ''})
    return {'v': 1, 'updated': iso_z(now), 'latest': latest, 'cls': list(CLS), 'src': src,
            'posts': out_posts, 'recent': recent, 'days': dict(sorted(days.items(), reverse=True))}


def run(out, deep_dir, now=None, gate=None, translate=None, numgate=None, full=False, log=print, sleep=None):
    """→ (結束碼, {push_app, push_deep, ...})。網路 / 時間 / 翻譯全部可以換成假的(selftest)"""
    now = now or datetime.now(timezone.utc)
    translate = translate or default_translate
    numgate = numgate or default_num_gate
    sleep = sleep if sleep is not None else time.sleep
    if gate is None:
        from lib_http import Gate   # noqa: E402
        gate = Gate(gaps={'ix.cnn.io': 3.0, 'www.trumpstruth.org': 3.0}, timeout=180)
    posts, meta, bad = load_deep(deep_dir, log=log)
    before = snapshot_months(posts)
    n0 = len(posts)
    src = {'cnn': {'ok': False, 'status': '', 'n': 0, 'add': 0, 'error': None},
           'rss': {'ok': False, 'n': 0, 'add': 0, 'match': None, 'error': None}}
    # ① CNN(研究存檔是空的 / FULL → ⛔ 帶條件)
    hdr = {}
    if not full and n0 and not bad:
        if meta.get('lm'):
            hdr['If-Modified-Since'] = meta['lm']
        if meta.get('etag'):
            hdr['If-None-Match'] = meta['etag']
    res, why = gate.get(CNN_URL, expect='any', **({'headers': hdr} if hdr else {}))
    if res is not None:
        try:
            rows = cnn_rows((res.content or b'').decode('utf-8', errors='replace'))
        except Exception as e:  # noqa: BLE001
            rows, why = [], f'CSV 讀不出來 {type(e).__name__}'
        if rows:
            src['cnn'].update(ok=True, status='200', n=len(rows), add=merge(posts, rows))
            h = getattr(res, 'headers', {}) or {}
            meta = {'lm': h.get('Last-Modified'), 'etag': h.get('ETag'), 'n': len(rows), 'at': iso_z(now)}
        else:
            src['cnn'].update(status='bad', error=why or 'CSV 是空的')
    elif '304' in (why or ''):
        src['cnn'].update(ok=True, status='304')
    else:
        src['cnn'].update(status='err', error=why)
    # ② RSS(補最新 + 對帳)
    res, why = gate.get(RSS_URL, expect='any')
    if res is not None:
        try:
            rr = rss_rows(res.content or b'')
        except Exception as e:  # noqa: BLE001
            rr, why = [], f'RSS 讀不出來 {type(e).__name__}'
        if rr:
            hit = sum(1 for r in rr if r['id'] in posts)
            add = merge(posts, [r for r in rr if r['id'] not in posts])   # 已經有的 ⛔ 拿 RSS 蓋(CNN 的內文比較完整)
            src['rss'].update(ok=True, n=len(rr), add=add, match=round((hit / len(rr)) * 100, 1))
        else:
            src['rss'].update(error=why or 'RSS 是空的')
    else:
        src['rss'].update(error=why)
    # ③ 翻譯(新的、有分類、原創、最近 14 天;新的先)
    cut = iso_z(now - timedelta(days=POST_DAYS))
    todo = [p for p in posts.values() if p['t'] >= cut and not p.get('rt') and p.get('x') and classify(p['x'])
            and not p.get('zh') and (p.get('zt') or 0) < TR_TRIES and not str(p.get('ze') or '').startswith('數字對不上')]
    todo.sort(key=lambda p: p['t'], reverse=True)
    tr = {'done': 0, 'fail': 0, 'gate': 0, 'quota': 0, 'left': max(0, len(todo) - TR_CAP)}
    for k, p in enumerate(todo[:TR_CAP]):
        if k:
            sleep(TR_GAP)                                   # 同 universal_radar:每則隔 2.5 秒(⛔ 一口氣打 → 撞每分鐘上限)
        zh, err = translate(p['x'])
        if not zh and _QUOTA.search(err or ''):
            # 🧯 額度用完 / 金鑰冷卻:這輪不再叫、這一則 ⛔ 算失敗次數(下一輪再翻)
            tr['quota'] = len(todo[:TR_CAP]) - k
            p['ze'] = (err or '')[:80]
            break
        p['zt'] = (p.get('zt') or 0) + 1
        if zh:
            miss = numgate(zh, p['x'])
            if miss:
                p['ze'] = f'數字對不上({",".join(miss[:3])})→ 顯示原文'
                p.pop('zh', None)
                tr['gate'] += 1
            else:
                p['zh'] = zh[:1200]
                p.pop('ze', None)
                tr['done'] += 1
        else:
            p['ze'] = (err or '翻譯失敗')[:80]
            tr['fail'] += 1
    src['tr'] = tr
    # ④ 寫研究存檔(只增不減)
    if len(posts) < n0:
        log(f'❌ 合併後 {len(posts)} 則 < 原本 {n0} 則(不應該發生)→ ⛔ 寫')
        return 1, {'push_app': 0, 'push_deep': 0}
    nm = write_deep(deep_dir, posts, bad, before, log=log)
    if src['cnn']['status'] == '200':
        Path(deep_dir).mkdir(parents=True, exist_ok=True)
        (Path(deep_dir) / '_meta.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
    # ⑤ 給手機的那一份
    if not posts:
        log('❌ 兩個來源都沒拿到東西、研究存檔也是空的 → ⛔ 寫 data/trump_posts.json(保留上一份)')
        return 1, {'push_app': 0, 'push_deep': 0}
    app = build_app(posts, now, src)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(app, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    log(f'✅ 研究存檔 {n0:,} → {len(posts):,} 則(CNN {src["cnn"]["status"]} 新增 {src["cnn"]["add"]}、RSS 新增 {src["rss"]["add"]}'
        f'、對帳 {src["rss"]["match"]}%)・寫了 {nm} 個月 ・給手機 {len(app["posts"])} 則有分類 / 最近 {RECENT_DAYS} 天 {len(app["recent"])} 則'
        f' ・翻譯 {tr}')
    return 0, {'push_app': 1, 'push_deep': 1 if nm or src['cnn']['status'] == '200' else 0}


# ───────────────────────────── selftest ─────────────────────────────
def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {str(got)[:300]}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body=b'', headers=None):
            self.status_code, self.content, self.headers = code, body, headers or {}

    def csv_of(rows):
        b = io.StringIO()
        w = csv.writer(b)
        w.writerow(['id', 'created_at', 'content', 'url', 'media', 'replies_count', 'reblogs_count', 'favourites_count'])
        for r in rows:
            w.writerow(r)
        return b.getvalue().encode('utf-8')

    def rss_of(items):
        x = '<?xml version="1.0"?><rss xmlns:truth="https://truthsocial.com/ns"><channel>'
        for pid, t, title, desc in items:
            x += (f'<item><title>{title}</title><description>{desc}</description><pubDate>{t}</pubDate><guid>g{pid}</guid>'
                  f'<truth:originalId>{pid}</truth:originalId><truth:originalUrl>https://truthsocial.com/@x/{pid}</truth:originalUrl></item>')
        return (x + '</channel></rss>').encode('utf-8')

    class FakeGate:
        def __init__(self, script):
            self.script, self.calls = list(script), []

        def get(self, url, expect='json', headers=None, **kw):
            self.calls.append((url, dict(headers or {})))
            x = self.script.pop(0)
            if isinstance(x, str):
                return None, x
            return x, ''

    NOW = datetime(2026, 11, 3, 0, 30, tzinfo=timezone.utc)          # 台北 11/03 08:30
    rows = [
        ['900', '2026-11-02T23:50:00.000Z', 'China will pay big TARIFFS of 25%!', 'https://truthsocial.com/@x/900', '', 1, 2, 3],
        ['899', '2026-11-02T13:00:00.000Z', 'RT: https://truthsocial.com/users/x/statuses/1', 'https://truthsocial.com/@x/899', 'm', 1, 2, 3],
        ['903', '2026-11-02T20:00:00.000Z', 'RT @foxnews: China TARIFFS are working', 'https://truthsocial.com/@x/903', '', 1, 2, 3],
        ['898', '2026-11-02T05:20:00.000Z', '', 'https://truthsocial.com/@x/898', 'https://img', 1, 2, 3],
        ['897', '2026-10-30T02:00:00.000Z', 'A great DEAL with Japan', 'https://truthsocial.com/@x/897', '', 1, 2, 3],
        ['850', '2026-10-10T02:00:00.000Z', 'Taiwan took our chips business', 'https://truthsocial.com/@x/850', '', 1, 2, 3],
        ['100', '2022-02-14T15:54:32.528Z', 'Get Ready!', 'https://truthsocial.com/@x/100', '', 1, 2, 3],
    ]
    CSV1 = csv_of(rows)
    RSS1 = rss_of([('901', 'Tue, 03 Nov 2026 00:10:00 +0000', '[No Title]', '&lt;p&gt;Xi called me about TARIFFS&lt;/p&gt;'),
                   ('900', 'Mon, 02 Nov 2026 23:50:00 +0000', 'China will pay', '&lt;p&gt;China will pay big TARIFFS of 25%!&lt;/p&gt;'),
                   ('902', 'Tue, 03 Nov 2026 00:20:00 +0000', '[No Title]', 'Video post from November 3, 2026')])
    LM = {'Last-Modified': 'Mon, 02 Nov 2026 23:55:00 GMT', 'ETag': '"e1"'}
    trs = []

    def fake_tr(text):
        trs.append(text)
        if 'Xi' in text:
            return '習近平打給我談關稅,稅率 30%', ''        # 原文沒有 30 → 數字核對要擋
        return '翻好的:' + text[:20] + (' 25%' if '25%' in text else ''), ''

    def ng(zh, en):
        from confcall_deck import num_gate
        return num_gate(zh, en)

    with tempfile.TemporaryDirectory() as td:
        out, deep = Path(td) / 'data' / 'trump_posts.json', Path(td) / 'trump_deep'
        g = FakeGate([R(200, CSV1, LM), R(200, RSS1)])
        rc, flags = run(out, deep, now=NOW, gate=g, translate=fake_tr, numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        app = json.loads(out.read_text(encoding='utf-8'))
        ok('① 第一次跑:⛔ 帶 304 條件(研究存檔是空的)', g.calls[0][1] == {}, g.calls[0])
        ok('① 結束碼 0、兩邊都要推', rc == 0 and flags == {'push_app': 1, 'push_deep': 1}, (rc, flags))
        ids = [p['id'] for p in app['posts']]
        ok('① 給手機:最近 14 天有分類的原創(900 中國關稅 / 901 RSS 補的 / 897 協議),新的在前;轉貼(就算講到中國關稅)/ 只有圖 / 20 天前的 ⛔',
           ids == ['901', '900', '897'], ids)
        ok('① 類別照 lib_trump', app['posts'][1]['cls'] == ['tariff', 'china'], app['posts'][1])
        ok('① RSS「Video post from…」佔位字當成沒有內文 → 不分類', all(p['id'] != '902' for p in app['posts']))
        ok('① 對帳率:RSS 3 則裡 1 則 CNN 已經有 → 33.3%', app['src']['rss']['match'] == 33.3, app['src']['rss'])
        # 時區:23:50Z = 台北 11/03 07:50 → 算在 11/03;13:00Z 轉貼 = 台北 11/02 21:00
        ok('② 台北日期:23:50Z 算 11/03、13:00Z 算 11/02', app['days'].get('2026-11-03', {}).get('c', {}).get('china') == 2
           and app['days'].get('2026-11-02', {}).get('rt') == 1, app['days'])
        ok('② recent 只收最近 4 天(10/30 那則還在、10/10 ⛔)', [r[0] for r in app['recent']][-1] == '2026-10-30T02:00:00Z'
           and len(app['recent']) == 7, app['recent'])
        z = {p['id']: p for p in app['posts']}
        ok('③ 翻譯:數字對得上 → 用', z['900']['zh'] and '25%' in z['900']['zh'] and not z['900'].get('ze'), z['900'])
        ok('③ 翻譯:原文沒有的數字(30)→ ⛔ 用、寫原因', z['901']['zh'] is None and '數字對不上' in (z['901']['ze'] or ''), z['901'])
        mon = sorted(p.name for p in deep.glob('*.json.gz'))
        ok('④ 研究存檔每月一檔(含 2022-02、沒分類的也存)', mon == ['2022-02.json.gz', '2026-10.json.gz', '2026-11.json.gz'], mon)
        meta = json.loads((deep / '_meta.json').read_text())
        ok('④ 記下 Last-Modified / ETag', meta.get('lm') == LM['Last-Modified'] and meta.get('etag') == '"e1"', meta)
        # ⑤ 第二次:CNN 304、RSS 一樣 → 帶條件、不重翻已經翻好的、數字對不上的 ⛔ 再翻
        trs.clear()
        st0 = {p.name: p.stat().st_mtime_ns for p in deep.glob('*.json.gz')}
        time.sleep(0.01)
        g2 = FakeGate(['HTTP 304', R(200, RSS1)])
        rc2, _ = run(out, deep, now=NOW + timedelta(hours=1), gate=g2, translate=fake_tr, numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        app2 = json.loads(out.read_text(encoding='utf-8'))
        ok('⑤ 第二次帶 If-Modified-Since + If-None-Match', g2.calls[0][1] == {'If-Modified-Since': LM['Last-Modified'], 'If-None-Match': '"e1"'},
           g2.calls[0])
        ok('⑤ 304 → 研究存檔沿用、給手機的照樣有內容', rc2 == 0 and [p['id'] for p in app2['posts']] == ['901', '900', '897']
           and app2['src']['cnn']['status'] == '304', app2['src'])
        ok('⑤ 翻好的不重翻、數字對不上的 ⛔ 再翻', trs == [], trs)
        ok('⑤ 沒變的月份 ⛔ 重寫', {p.name: p.stat().st_mtime_ns for p in deep.glob('*.json.gz')} == st0)
        # ⑥ CNN 這輪只回最新 2 列(被截斷)→ 研究存檔 ⛔ 少(id 聯集)
        g3 = FakeGate([R(200, csv_of(rows[:2]), {'Last-Modified': 'x2', 'ETag': '"e2"'}), 'HTTP 503'])
        rc3, _ = run(out, deep, now=NOW, gate=g3, translate=fake_tr, numgate=ng, full=True, log=lambda *_: None, sleep=lambda *_: None)
        posts3, _, _ = load_deep(deep, log=lambda *_: None)
        ok('⑥ CNN 被截斷 → 研究存檔照樣 9 則(⛔ 少)', rc3 == 0 and len(posts3) == 9, len(posts3))
        ok('⑥ FULL → ⛔ 帶條件', g3.calls[0][1] == {})
        ok('⑥ RSS 失敗要寫原因', json.loads(out.read_text())['src']['rss']['error'] == 'HTTP 503')
        # ⑦ 壞掉的月份 ⛔ 覆蓋
        (deep / '2026-10.json.gz').write_bytes(b'not gzip')
        g4 = FakeGate([R(200, CSV1, LM), R(200, RSS1)])
        run(out, deep, now=NOW, gate=g4, translate=fake_tr, numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        ok('⑦ 讀不出來的月份 ⛔ 覆蓋(留著等人修)', (deep / '2026-10.json.gz').read_bytes() == b'not gzip')
        ok('⑦ 有壞月份 → ⛔ 帶 304 條件(要整份重拿)', g4.calls[0][1] == {}, g4.calls[0])
    # ⑧ 兩個都失敗、研究存檔空的 → 1、⛔ 寫檔(保留上一份)
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / 'trump_posts.json'
        out.write_text('{"old":1}', encoding='utf-8')
        g5 = FakeGate(['斷路:HTTP 403', '斷路:HTTP 403'])
        rc5, fl5 = run(out, Path(td) / 'deep', now=NOW, gate=g5, translate=fake_tr, numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        ok('⑧ 兩個都失敗而且沒有存檔 → 1、⛔ 推、舊檔不動', rc5 == 1 and fl5['push_app'] == 0 and out.read_text() == '{"old":1}', (rc5, fl5))
    # ⑨ 翻譯上限:20 則有分類的新發文 → 只翻 15 則,下一輪接著翻
    with tempfile.TemporaryDirectory() as td:
        out, deep = Path(td) / 'p.json', Path(td) / 'd'
        many = [[str(1000 + i), f'2026-11-02T{10 + i // 6:02d}:{(i % 6) * 9:02d}:00.000Z', f'China tariffs note {i}', '', '', 0, 0, 0] for i in range(20)]
        cnt = []
        run(out, deep, now=NOW, gate=FakeGate([R(200, csv_of(many), LM), 'HTTP 503']),
            translate=lambda t: (cnt.append(t), ('中國關稅 ' + t.split()[-1], ''))[1], numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        a = json.loads(out.read_text())
        ok('⑨ 每輪最多 15 則', len(cnt) == 15 and a['src']['tr']['left'] == 5, (len(cnt), a['src']['tr']))
        cnt.clear()
        run(out, deep, now=NOW, gate=FakeGate(['HTTP 304', 'HTTP 503']),
            translate=lambda t: (cnt.append(t), ('中國關稅 ' + t.split()[-1], ''))[1], numgate=ng, log=lambda *_: None, sleep=lambda *_: None)
        ok('⑨ 下一輪把剩下 5 則翻完', len(cnt) == 5, len(cnt))
    # ⑨b 額度用完:第 3 則撞到 → 這輪停、撞到的那則 ⛔ 算失敗次數、每則之間有隔
    with tempfile.TemporaryDirectory() as td:
        out, deep = Path(td) / 'p.json', Path(td) / 'd'
        many = [[str(2000 + i), f'2026-11-02T1{i}:00:00.000Z', f'China tariffs note {i}', '', '', 0, 0, 0] for i in range(6)]
        calls, naps = [], []
        def tr_q(t):
            calls.append(t)
            return (None, 'AI 用量到上限(全部 1 把金鑰冷卻中)') if len(calls) == 3 else ('中國關稅 ' + t.split()[-1], '')
        run(out, deep, now=NOW, gate=FakeGate([R(200, csv_of(many), LM), 'HTTP 503']), translate=tr_q, numgate=ng,
            log=lambda *_: None, sleep=lambda s: naps.append(s))
        a = json.loads(out.read_text())
        posts9, _, _ = load_deep(deep, log=lambda *_: None)
        hit = [p for p in posts9.values() if '冷卻' in str(p.get('ze') or '')]
        ok('⑨b 撞到額度 → 這輪停(只叫了 3 次)、剩下的 4 則記在 quota', len(calls) == 3 and a['src']['tr']['quota'] == 4, (len(calls), a['src']['tr']))
        ok('⑨b 撞到的那則 ⛔ 算失敗次數(zt 沒加)', len(hit) == 1 and not hit[0].get('zt'), hit)
        ok('⑨b 每則之間隔 2.5 秒', naps == [2.5, 2.5], naps)
    # ⑩ 決定性對照:分類 / 時區 / 只增不減 各拿掉一個 → 結果一定不一樣
    p_tw = parse_ts('2026-11-02T23:50:00Z').astimezone(TW).strftime('%Y-%m-%d')
    p_naive = parse_ts('2026-11-02T23:50:00Z').strftime('%Y-%m-%d')
    ok('⑩ 決定性對照:不轉台北時間 → 日期差一天(11/02 vs 11/03)', p_tw == '2026-11-03' and p_naive == '2026-11-02')
    d1 = {'1': {'id': '1', 't': '2026-11-01T00:00:00Z', 'x': 'a'}}
    merge(d1, [{'id': '2', 't': '2026-11-02T00:00:00Z', 'x': 'b', 'u': '', 'rt': 0, 'm': 0}])
    ok('⑩ 決定性對照:聯集 → 2 則(換成整份覆蓋就只剩 1 則)', len(d1) == 2)
    print(f'\n{"✅ 全部通過" if not fails else "❌ " + str(len(fails)) + " 條沒過"}')
    return 0 if not fails else 1


def main():
    if '--selftest' in sys.argv:
        return selftest()
    out = os.environ.get('OUT') or 'data/trump_posts.json'
    deep = os.environ.get('DEEP_DIR') or 'trump_deep'
    full = (os.environ.get('FULL') or '0') == '1'
    rc, flags = run(out, deep, full=full)
    gho = os.environ.get('GITHUB_OUTPUT')
    if gho:
        with open(gho, 'a', encoding='utf-8') as fh:
            for k, v in flags.items():
                fh.write(f'{k}={v}\n')
    return rc


if __name__ == '__main__':
    sys.exit(main())
