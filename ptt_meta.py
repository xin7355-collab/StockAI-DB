#!/usr/bin/env python3
"""💬 V82.1.9 PTT 股板「只收列表頁的中繼資料」(使用者 11/12:「PTT爬蟲照做」)。

收什麼:看板列表頁上看得到的 —— 文章 id(網址裡的時間戳 = 發文時間)、標題、分類([標的] / [新聞] / [請益]…)、
  推文數(爆 = 100、X1 = −10)、標題裡的股票代號、[標的] 的多 / 空。
⛔ 不收:內文(⛔ 打開文章頁)、作者帳號、推文內容。⛔ 偽裝瀏覽器(UA 寫明 StockAI-DB,lib_http.Gate)。
⛔ 繞過任何擋(18 禁確認頁 / 403 / 驗證)—— 碰到就停,寫原因。
守規矩:每一輪先讀 robots.txt,不允許就整輪不抓(紅燈);同一個網站間隔 3 秒;被擋斷路 ⛔ 重試;每輪最多 MAX_PAGES 頁。
存放:orphan 分支 ptt_meta 的 ptt/<看板>/<YYYY-MM>.json(⛔ 進 gh-pages / App;研究用,RESEARCH_ONLY)。

跑法:python3 ptt_meta.py probe              → 只讀 robots.txt + 第一頁,印結果(⛔ 寫檔)
      python3 ptt_meta.py mine [--out DIR]    → 抓最新幾頁、併進月檔
      python3 ptt_meta.py --selftest           → 離線(網路換成假的)
"""
import json
import os
import re
import sys
import time
import urllib.robotparser
from datetime import datetime, timezone, timedelta

import lib_http

BASE = 'https://www.ptt.cc'
BOARD = os.environ.get('PTT_BOARD') or 'Stock'
MAX_PAGES = int(os.environ.get('PTT_MAX_PAGES') or 30)
FIRST_PAGES = int(os.environ.get('PTT_FIRST_PAGES') or 10)   # 第一次跑(沒有舊資料)只抓這麼多頁,⛔ 一路往回挖
OVERLAP_H = 36            # 往回翻到「比已存最新那篇還早 36 小時」就停(推文數還在變的那段重抓一次)
GAP = 3.0
TW = timezone(timedelta(hours=8))


def robots_ok(txt, paths, agent='StockAI-DB'):
    """robots.txt 文字 → {path: True/False}(標準庫 robotparser;沒有點名我們 → 照 * 那組)"""
    rp = urllib.robotparser.RobotFileParser()
    rp.parse((txt or '').splitlines())
    return {p: rp.can_fetch(agent, BASE + p) for p in paths}


def push_num(s):
    s = (s or '').strip()
    if s == '爆':
        return 100
    if s == 'XX':
        return -100
    m = re.fullmatch(r'X(\d)', s)
    if m:
        return -10 * int(m.group(1))
    return int(s) if s.isdigit() else 0


_CAT = re.compile(r'^\s*(Re:\s*|Fw:\s*)?\[([^\]]{1,6})\]\s*(.*)$')
_CODE = re.compile(r'(?<![0-9A-Za-z])(\d{4}[A-Z]?|00\d{3,4}[A-Z]?)(?![0-9A-Za-z])')


def title_meta(title):
    """標題 → (分類, 是不是回文, 代號清單, [標的] 的多 / 空)"""
    m = _CAT.match(title or '')
    cat, re_, rest = (m.group(2), bool(m.group(1)), m.group(3)) if m else ('', False, title or '')
    codes = sorted(set(_CODE.findall(rest)))
    d = None
    if cat == '標的':
        tail = re.sub(r'[\s\-_/|]+', ' ', rest)
        if re.search(r'(作|做)?空(單)?(\s|$)', tail) and not re.search(r'(作|做)?多(單)?(\s|$)', tail):
            d = '空'
        elif re.search(r'(作|做)?多(單)?(\s|$)', tail) and not re.search(r'(作|做)?空(單)?(\s|$)', tail):
            d = '多'
    return cat, re_, codes, d


def parse_index(html):
    """列表頁 → (文章清單, 上一頁網址);置底公告(r-list-sep 之後)、已刪文不收;⛔ 作者帳號不收"""
    body = html.split('r-list-sep')[0]
    out = []
    for blk in re.findall(r'<div class="r-ent">(.*?)<div class="mark">', body, flags=re.S):
        a = re.search(r'<a href="(/bbs/[^"]+/(M\.(\d{9,11})\.A\.[0-9A-F]{3})\.html)">(.*?)</a>', blk, flags=re.S)
        if not a:
            continue                                  # 已刪文(沒有連結)
        nrec = re.search(r'<div class="nrec">(?:<span[^>]*>)?([^<]*)', blk)
        title = re.sub(r'<[^>]+>', '', a.group(4)).replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').strip()
        cat, re_, codes, d = title_meta(title)
        out.append({'id': a.group(2), 'ts': int(a.group(3)), 'title': title[:80], 'cat': cat, 're': re_,
                    'push': push_num(nrec.group(1) if nrec else ''), 'codes': codes, 'dir': d})
    prev = re.search(r'<a class="btn wide" href="(/bbs/[^"]+/index\d+\.html)">[^<]*上頁', html)
    return out, (prev.group(1) if prev else None)


def is_gate_page(html):
    """18 禁確認頁 / 不是看板列表 → True(⛔ 送 over18 cookie 繞過)"""
    return ('over18' in html and 'r-ent' not in html) or ('r-list-container' not in html and 'r-ent' not in html)


def month_file(out_dir, ts):
    return os.path.join(out_dir, 'ptt', BOARD, datetime.fromtimestamp(ts, TW).strftime('%Y-%m') + '.json')


def load_month(path):
    try:
        with open(path, encoding='utf-8') as f:
            j = json.load(f)
        return j if isinstance(j, dict) and isinstance(j.get('posts'), dict) else {'posts': {}}
    except FileNotFoundError:
        return {'posts': {}}


def merge(out_dir, posts, today):
    """併進月檔:同一篇更新推文數 / 標題(seen 留第一次看到那天)→ (新增幾篇, 更新幾篇)"""
    by = {}
    for p in posts:
        by.setdefault(month_file(out_dir, p['ts']), []).append(p)
    new = upd = 0
    for path, ps in by.items():
        j = load_month(path)
        for p in ps:
            old = j['posts'].get(p['id'])
            rec = {k: p[k] for k in ('ts', 'title', 'cat', 're', 'push', 'codes', 'dir')}
            rec['seen'] = old.get('seen', today) if old else today
            rec['last'] = today
            if old is None:
                new += 1
            elif any(old.get(k) != rec[k] for k in ('push', 'title')):
                upd += 1
            j['posts'][p['id']] = rec
        j['_meta'] = {'board': BOARD, 'n': len(j['posts']), 'updated': datetime.now(TW).strftime('%Y-%m-%d %H:%M'),
                      'fields': 'ts=發文時間(網址時間戳)・push 爆=100 X1=−10・dir 只看 [標的] 標題的多 / 空・⛔ 內文 / 作者'}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(j, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, path)
    return new, upd


def newest_ts(out_dir):
    d = os.path.join(out_dir, 'ptt', BOARD)
    best = 0
    if os.path.isdir(d):
        for f in sorted(os.listdir(d))[-2:]:
            if f.endswith('.json'):
                for p in load_month(os.path.join(d, f))['posts'].values():
                    best = max(best, int(p.get('ts') or 0))
    return best


def crawl(gate, out_dir, mode='mine', log=print):
    """→ (ok, 說明, 統計)。ok=False = 真的壞了 / 不允許(紅燈)"""
    res, why = gate.get(BASE + '/robots.txt', expect='text')
    if res is None and not why.startswith('HTTP 404'):
        return False, f'robots.txt 讀不到:{why}', {}
    txt = res.text if res is not None else ''          # 404 = 沒有 robots.txt = 全部允許
    paths = [f'/bbs/{BOARD}/index.html', f'/bbs/{BOARD}/index1000.html', f'/bbs/{BOARD}/M.1700000000.A.123.html']
    allow = robots_ok(txt, paths)
    log(f'🤖 robots.txt({len(txt)} 字):' + '・'.join(f'{p} {"✅ 允許" if v else "⛔ 不允許"}' for p, v in allow.items()))
    if not (allow[paths[0]] and allow[paths[1]]):
        return False, 'robots.txt 不允許抓看板列表頁 → 整輪不抓(請把 ptt_meta workflow 停用)', {'robots': allow}
    stop_ts = newest_ts(out_dir) - OVERLAP_H * 3600 if mode == 'mine' else 0
    cap = (MAX_PAGES if stop_ts > 0 else FIRST_PAGES) if mode == 'mine' else 1
    url, pages, posts = BASE + f'/bbs/{BOARD}/index.html', 0, []
    while url and pages < cap:
        r, why = gate.get(url, expect='text')
        if r is None:
            if pages == 0:
                return False, f'第一頁就抓不到:{why}', {'robots': allow}
            log(f'⚠️ 第 {pages + 1} 頁抓不到({why})→ 這輪先停,已抓的照存')
            break
        html = r.text
        if is_gate_page(html):
            return False, '碰到 18 禁確認頁 / 不是看板列表(⛔ 繞過)→ 停', {'robots': allow}
        ps, prev = parse_index(html)
        pages += 1
        posts += ps
        if not ps and pages == 1:
            return False, '第一頁一篇都解析不到(PTT 改版?)', {'robots': allow}
        if stop_ts and ps and min(p['ts'] for p in ps) < stop_ts:
            break
        url = BASE + prev if prev else None
    st = {'robots': allow, 'pages': pages, 'posts': len(posts), 'sent': gate.stats['sent'],
          'cats': {}, 'dir': {'多': 0, '空': 0}}
    for p in posts:
        st['cats'][p['cat'] or '(無)'] = st['cats'].get(p['cat'] or '(無)', 0) + 1
        if p['dir']:
            st['dir'][p['dir']] += 1
    if mode == 'probe':
        log(f'🔎 第一頁 {len(posts)} 篇・分類 {st["cats"]}・[標的] 多 {st["dir"]["多"]} / 空 {st["dir"]["空"]}')
        for p in posts[:5]:
            log(f'   {datetime.fromtimestamp(p["ts"], TW):%m/%d %H:%M} 推 {p["push"]:>4} [{p["cat"]}] 代號 {p["codes"]} {p["dir"] or ""}')
        return True, 'probe 完成(⛔ 寫檔)', st
    new, upd = merge(out_dir, posts, datetime.now(TW).strftime('%Y-%m-%d'))
    st.update(new=new, upd=upd)
    return True, f'抓 {pages} 頁 {len(posts)} 篇:新增 {new}、更新 {upd}', st


def selftest():
    import tempfile
    fails = []

    def ok(name, cond, got=None):
        print(('  ✅ ' if cond else '  ❌ ') + name + ('' if cond else f'  → {got!r}'))
        if not cond:
            fails.append(name)

    rb = 'User-agent: *\nDisallow: /bbs/Gossiping/\nDisallow: /cls/\n'
    a = robots_ok(rb, ['/bbs/Stock/index.html', '/bbs/Gossiping/index.html'])
    ok('① robots:Stock 允許、Gossiping 不允許', a['/bbs/Stock/index.html'] and not a['/bbs/Gossiping/index.html'], a)
    ok('①b robots 整站 Disallow: / → 不允許', not robots_ok('User-agent: *\nDisallow: /\n', ['/bbs/Stock/index.html'])['/bbs/Stock/index.html'])
    ok('② 推文數:爆 100・X1 −10・XX −100・空白 0・12', [push_num(x) for x in ['爆', 'X1', 'XX', '', '12']] == [100, -10, -100, 0, 12])
    ok('③ [標的] 多 / 空 + 代號', title_meta('[標的] 2330 台積電 多')[2:] == (['2330'], '多') and title_meta('[標的] 00631L 空單')[2:] == (['00631L'], '空')
       and title_meta('[標的] 2603 長榮 多空都有可能')[3] is None and title_meta('Re: [新聞] 台積電 2330 法說')[:2] == ('新聞', True), title_meta('[標的] 00631L 空單'))
    ent = lambda id_, nrec, title, author='someid': (f'<div class="r-ent"><div class="nrec">{nrec}</div><div class="title"><a href="/bbs/Stock/{id_}.html">{title}</a></div>'
                                                     f'<div class="meta"><div class="author">{author}</div><div class="date">11/11</div><div class="mark"></div></div></div>')
    html = ('<div class="r-list-container">'
            '<a class="btn wide" href="/bbs/Stock/index7000.html">&lsaquo; 上頁</a>'
            + ent('M.1762851000.A.1AB', '<span class="hl f3">爆</span>', '[標的] 2330 台積電 多')
            + '<div class="r-ent"><div class="nrec"></div><div class="title">(本文已被刪除) [xx]</div><div class="meta"><div class="author">-</div><div class="mark"></div></div></div>'
            + ent('M.1762852000.A.2CD', '<span class="hl f2">5</span>', 'Re: [請益] 0050 &amp; 00878 怎麼選')
            + '<div class="r-list-sep"></div>' + ent('M.1600000000.A.FFF', '', '[公告] 板規'))
    ps, prev = parse_index(html)
    ok('④ 列表頁:2 篇(已刪文、置底公告不收)、上一頁網址', len(ps) == 2 and prev == '/bbs/Stock/index7000.html' and ps[0]['push'] == 100 and ps[1]['cat'] == '請益', (len(ps), prev))
    ok('④b 發文時間 = 網址時間戳、標題還原 &amp;', ps[0]['ts'] == 1762851000 and '0050 & 00878' in ps[1]['title'] and ps[1]['codes'] == ['0050', '00878'], ps[1])
    ok('⑤ ⛔ 作者帳號(任何欄位都沒有 someid)', 'someid' not in json.dumps(ps, ensure_ascii=False))
    ok('⑥ 18 禁確認頁 / 不是列表 → 擋頁', is_gate_page('<form action="/ask/over18">') and not is_gate_page(html))

    class Res:
        def __init__(self, code, text):
            self.status_code, self.text, self.content, self.headers = code, text, text.encode('utf-8'), {}

    def mk_gate(pages, robots='User-agent: *\nDisallow: /bbs/Gossiping/\n', code=200):
        sent = []

        def send(method, url, **kw):
            sent.append((url, kw.get('headers', {}).get('User-Agent', '')))
            if url.endswith('/robots.txt'):
                return Res(200, robots)
            m = re.search(r'index(\d*)\.html', url)
            k = m.group(1) or 'top'
            return Res(code, pages.get(k, '<div class="r-list-container"></div>'))
        g = lib_http.Gate(gaps={'www.ptt.cc': GAP}, send=send, sleep=lambda s: None, clock=lambda: 0.0)
        return g, sent

    pg = lambda ids, prev: ('<div class="r-list-container">' + (f'<a class="btn wide" href="/bbs/Stock/index{prev}.html">&lsaquo; 上頁</a>' if prev else '')
                            + ''.join(ent(f'M.{t}.A.ABC', '1', f'[閒聊] {t}') for t in ids))
    pages = {'top': pg([1762900000, 1762900100], 6999), '6999': pg([1762800000], 6998), '6998': pg([1762700000], 6997), '6997': pg([1762600000], None)}
    d = tempfile.mkdtemp()
    g, sent = mk_gate(pages)
    okr, msg, st = crawl(g, d, log=lambda *a: None)
    ok('⑦ 第一次跑:robots 先讀、往回翻到底(4 頁)、寫月檔', okr and st['pages'] == 4 and sent[0][0].endswith('/robots.txt') and os.path.exists(month_file(d, 1762900000)), (okr, msg, st))
    ok('⑦b UA 寫明 StockAI-DB(⛔ 偽裝瀏覽器)', all('StockAI-DB' in ua for _, ua in sent))
    # 第二次:已有到 1762900100 → 只翻到比它早 36 小時(1762770500)以前就停
    g2, sent2 = mk_gate(pages)
    okr2, msg2, st2 = crawl(g2, d, log=lambda *a: None)
    ok('⑧ 第二次:翻到比已存最新那篇早 36 小時就停(⛔ 一路翻到底)', okr2 and st2['pages'] == 3 and st2['new'] == 0, (st2, msg2))
    g3, _ = mk_gate(pages, robots='User-agent: *\nDisallow: /bbs/\n')
    okr3, msg3, _ = crawl(g3, tempfile.mkdtemp(), log=lambda *a: None)
    ok('⑨ robots 不允許 → 整輪不抓(紅燈、寫原因)', not okr3 and 'robots' in msg3, msg3)
    g4, sent4 = mk_gate(pages, code=403)
    okr4, msg4, _ = crawl(g4, tempfile.mkdtemp(), log=lambda *a: None)
    ok('⑩ 被擋 403 → 停、⛔ 重試(robots 1 次 + 列表 1 次)', not okr4 and len(sent4) == 2, (msg4, len(sent4)))
    g5, _ = mk_gate({'top': '<form action="/ask/over18">確認</form>'})
    okr5, msg5, _ = crawl(g5, tempfile.mkdtemp(), log=lambda *a: None)
    ok('⑪ 18 禁確認頁 → 停(⛔ 繞過)', not okr5 and '18' in msg5, msg5)
    # ⑫ 決定性對照:推文數變了 → 更新那一篇、seen 留第一次那天
    j1 = load_month(month_file(d, 1762900000))['posts']['M.1762900000.A.ABC']
    pages['top'] = pages['top'].replace('<div class="nrec">1</div>', '<div class="nrec">9</div>', 1)
    g6, _ = mk_gate(pages)
    _, _, st6 = crawl(g6, d, log=lambda *a: None)
    j2 = load_month(month_file(d, 1762900000))['posts']['M.1762900000.A.ABC']
    ok('⑫ 推文數變了 → 更新(upd ≥1)、seen 不變', st6['upd'] >= 1 and j2['push'] == 9 and j2['seen'] == j1['seen'], (st6, j2))
    print(f"\n{'✅ 全過' if not fails else '❌ 失敗 ' + str(len(fails)) + ' 條'}")
    return 1 if fails else 0


def main():
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    mode = sys.argv[1] if len(sys.argv) > 1 else 'probe'
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'ptt_meta'
    gate = lib_http.Gate(gaps={'www.ptt.cc': GAP}, timeout=20, backoff=(2, 4))
    t0 = time.time()
    ok, msg, st = crawl(gate, out, mode)
    print(('✅ ' if ok else '❌ ') + msg + f'({time.time() - t0:.0f} 秒、送出 {gate.stats["sent"]} 次)')
    if st:
        print('📊 ' + json.dumps(st, ensure_ascii=False))
    summ = os.environ.get('GITHUB_STEP_SUMMARY')
    if summ:
        with open(summ, 'a', encoding='utf-8') as f:
            f.write(f'### 💬 PTT {BOARD}({mode})\n\n' + ('✅ ' if ok else '❌ ') + msg + '\n')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
