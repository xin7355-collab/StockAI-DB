#!/usr/bin/env python3
"""🔎 V80.2.1 川普發文來源探路(評估紀錄 53)—— 只讀、只印 log,⛔ 不寫檔、⛔ 不碰任何分支、⛔ 不需要任何機密。

沙箱連不到 CNN / trumpstruth → 只能在 GitHub Actions 跑(macro_probe.yml which=trump_src)。
看完 log 才寫採礦(陷阱 #60:先拿真實回應,⛔ 憑想像編測資)。

問三件事:
  ① CNN 存檔 CSV(ix.cnn.io/data/truth-social/truth_archive.csv):大小、欄位、列數、最早 / 最新時間與時區、
     有沒有轉貼欄位、亂碼修復幾列;再送一次 If-Modified-Since / If-None-Match 看回不回 304
  ② trumpstruth RSS(www.trumpstruth.org/feed):則數、最新時間、有沒有 truth:originalId / originalUrl
  ③ 兩邊用 id 對得上幾 %、對上的時間差中位數(驗時區)
抓取一律走 lib_http.Gate(expect='any'):被擋就停、退避、身分寫明(⛔ 偽裝瀏覽器、⛔ 登入、⛔ 繞 Cloudflare)。

跑法:python3 scripts/trump_src_probe.py   ・  python3 scripts/trump_src_probe.py --selftest(假網路)
結束碼:兩個來源都抓不到 → 1(Actions 紅燈 = 沒驗到);至少一個抓到 → 0。
"""
import csv
import io
import statistics as st
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib_http import Gate  # noqa: E402
from lib_trump import classify, clean_text, iso_z, parse_ts, tw_slot  # noqa: E402

CNN_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.csv'
RSS_URL = 'https://www.trumpstruth.org/feed'
NS = {'truth': 'https://truthsocial.com/ns'}
csv.field_size_limit(10 ** 7)


def _h(res, k):
    try:
        return res.headers.get(k)
    except Exception:  # noqa: BLE001
        return None


def parse_cnn(text):
    """CSV 全文 → (欄位名, 列[dict])。⛔ 不在這裡挑欄位(就是要看它長什麼樣)"""
    rd = csv.DictReader(io.StringIO(text))
    rows = list(rd)
    return list(rd.fieldnames or []), rows


def parse_rss(blob):
    """RSS → 每則 {id, guid, url, t, text};讀不出來丟例外(讓呼叫端記錄)"""
    root = ET.fromstring(blob)
    out = []
    for it in root.findall('.//item'):
        def g(tag, ns=None):
            el = it.find(tag, ns) if ns else it.find(tag)
            return (el.text or '').strip() if el is not None and el.text else ''
        title, desc = g('title'), g('description')
        text = title if title and '[No Title]' not in title else clean_text(desc)
        out.append({'id': g('truth:originalId', NS), 'guid': g('guid'), 'url': g('truth:originalUrl', NS) or g('link'),
                    't': g('pubDate'), 'text': clean_text(text)})
    return out


def run(gate, log=print):
    """→ 結束碼。所有輸出都走 log(selftest 換成收集器)"""
    rep = {'cnn': None, 'rss': None}
    # ① CNN
    log('=' * 70 + '\n① CNN 存檔 CSV')
    res, why = gate.get(CNN_URL, expect='any')
    cnn_ids = {}
    if res is None:
        log(f'❌ 抓不到:{why}')
    else:
        raw = getattr(res, 'content', b'') or b''
        lm, etag = _h(res, 'Last-Modified'), _h(res, 'ETag')
        log(f'狀態 200 ・{len(raw):,} bytes ・Content-Type {_h(res, "Content-Type")} ・Last-Modified {lm} ・ETag {etag}'
            f' ・Content-Length {_h(res, "Content-Length")} ・Accept-Ranges {_h(res, "Accept-Ranges")}')
        text = raw.decode('utf-8', errors='replace')
        bad = text.count('�')
        log(f'utf-8 解不出來的字元 {bad} 個;開頭 160 字:{text[:160]!r}')
        try:
            cols, rows = parse_cnn(text)
        except Exception as e:  # noqa: BLE001
            cols, rows = [], []
            log(f'❌ CSV 讀不出來:{type(e).__name__} {e}')
        log(f'欄位({len(cols)}):{cols}')
        log(f'列數 {len(rows):,}')
        if rows:
            ts = [(parse_ts(r.get('created_at')), r) for r in rows]
            good = [(t, r) for t, r in ts if t is not None]
            log(f'created_at 讀得出來 {len(good):,} / {len(rows):,};原樣前 3 個:{[r.get("created_at") for r in rows[:3]]}')
            if good:
                good.sort(key=lambda x: x[0])
                log(f'最早 {iso_z(good[0][0])} ・最新 {iso_z(good[-1][0])}(檔案順序:第一列 {rows[0].get("created_at")} / 最後一列 {rows[-1].get("created_at")})')
                last = good[-1][0]
                rec = [(t, r) for t, r in good if t >= last - timedelta(days=30)]
                per = Counter(tw_slot(iso_z(t))[0] for t, _ in rec)
                cls_n = sum(1 for _, r in rec if classify(clean_text(r.get('content'))))
                log(f'最近 30 天 {len(rec)} 則(平均一天 {len(rec) / 30:.1f})・有分類 {cls_n} 則;台北日期每天幾則(最後 7 天):'
                    f'{sorted(per.items())[-7:]}')
            fixed = sum(1 for r in rows if r.get('content') and clean_text(r['content']) != ' '.join(str(r['content']).split()))
            log(f'清理後跟原文不一樣的列 {fixed:,}(亂碼修復 / html 跳脫 / 標籤)')
            for k in cols:
                if any(w in k.lower() for w in ('reblog', 'retweet', 'repost', 'quote', 'reply', 'media', 'url')):
                    vals = Counter((r.get(k) or '')[:30] for r in rows[:2000])
                    log(f'  欄位 {k}:前 2,000 列最常見的值 {vals.most_common(4)}')
            rt = sum(1 for r in rows if (r.get('content') or '').lstrip().startswith('RT @'))
            empty = sum(1 for r in rows if not (r.get('content') or '').strip())
            log(f'內文以「RT @」開頭 {rt:,} 列 ・內文空白 {empty:,} 列(多半是只有圖 / 影片)')
            for r in rows[:2] + rows[-2:]:
                log(f'  例:{ {k: (str(v)[:90] if v else v) for k, v in r.items()} }')
            for r in rows:
                cid = str(r.get('id') or '').strip()
                t = parse_ts(r.get('created_at'))
                if cid and t:
                    cnn_ids[cid] = t
        rep['cnn'] = len(rows)
        # 304?
        hdr = {}
        if lm:
            hdr['If-Modified-Since'] = lm
        if etag:
            hdr['If-None-Match'] = etag
        if hdr:
            r2, why2 = gate.get(CNN_URL, expect='any', headers=hdr)
            if r2 is None:
                log(f'再送一次帶 {list(hdr)} → {why2}({"✅ 支援 304,沒新的時候不用整份重抓" if "304" in why2 else "⚠️ 不是 304"})')
            else:
                log(f'再送一次帶 {list(hdr)} → 200 {len(r2.content or b""):,} bytes(⚠️ 不支援 304:每次都要整份重抓)')
        else:
            log('⚠️ 沒有 Last-Modified / ETag → 沒辦法問「有沒有新的」')
    # ② RSS
    log('=' * 70 + '\n② trumpstruth RSS')
    res, why = gate.get(RSS_URL, expect='any')
    items = []
    if res is None:
        log(f'❌ 抓不到:{why}')
    else:
        raw = getattr(res, 'content', b'') or b''
        log(f'狀態 200 ・{len(raw):,} bytes ・Content-Type {_h(res, "Content-Type")} ・開頭 {raw[:120]!r}')
        try:
            items = parse_rss(raw)
        except Exception as e:  # noqa: BLE001
            log(f'❌ RSS 讀不出來:{type(e).__name__} {e}')
        log(f'則數 {len(items)} ・有 originalId {sum(1 for x in items if x["id"])} ・有 originalUrl {sum(1 for x in items if x["url"])}')
        ts = [parse_ts(x['t']) for x in items]
        ok_t = [t for t in ts if t]
        if ok_t:
            log(f'pubDate 原樣前 2 個 {[x["t"] for x in items[:2]]} → 最新 {iso_z(max(ok_t))} ・最舊 {iso_z(min(ok_t))}')
        for x in items[:3]:
            log(f'  例:{ {k: (str(v)[:90] if v else v) for k, v in x.items()} }')
        rep['rss'] = len(items)
    # ③ 對帳
    log('=' * 70 + '\n③ RSS 對 CNN')
    if items and cnn_ids:
        hit = [(x, cnn_ids.get(x['id'])) for x in items if x['id']]
        both = [(x, t) for x, t in hit if t is not None]
        log(f'RSS 有 originalId 的 {len(hit)} 則裡,CNN 也有 {len(both)} 則({(len(both) / len(hit) * 100 if hit else 0):.0f}%)')
        diffs = [(parse_ts(x['t']) - t).total_seconds() / 60 for x, t in both if parse_ts(x['t'])]
        if diffs:
            log(f'同一則時間差(RSS − CNN,分鐘):中位 {st.median(diffs):.1f} ・最小 {min(diffs):.1f} ・最大 {max(diffs):.1f}'
                f'(≈ 0 = 時區一致;±240 / ±300 = 有一邊沒轉時區)')
        newest_cnn = max(cnn_ids.values())
        newer = [x for x in items if parse_ts(x['t']) and parse_ts(x['t']) > newest_cnn]
        log(f'RSS 比 CNN 最新那則還新的有 {len(newer)} 則(= CNN 更新落後多少)')
    else:
        log('⏭️ 少一邊,沒辦法對帳')
    log('=' * 70)
    log(f'結論:CNN {"✅ " + str(rep["cnn"]) + " 列" if rep["cnn"] else "❌"} ・RSS {"✅ " + str(rep["rss"]) + " 則" if rep["rss"] else "❌"}'
        f' ・Gate {gate.stats} ・斷路 {gate.open}')
    return 0 if (rep['cnn'] or rep['rss']) else 1


def selftest():
    fails = []

    def ok(name, cond, got=''):
        print(f'{"✅" if cond else "❌"} {name}' + ('' if cond else f' → {got}'))
        if not cond:
            fails.append(name)

    class R:
        def __init__(self, code, body=b'', headers=None):
            self.status_code, self.content, self.headers = code, body, headers or {}

    CSV = ('id,created_at,content,url,media\n'
           '115001,2026-11-02T13:00:00.000Z,"China must pay TARIFFS! Itâ\u0080\u0099s time",https://truthsocial.com/@x/115001,\n'
           '115002,2026-11-02T14:30:00.000Z,"&lt;p&gt;Great day&lt;/p&gt;",https://truthsocial.com/@x/115002,\n'
           '115003,2026-11-03T02:15:00.000Z,"",https://truthsocial.com/@x/115003,https://img\n').encode('utf-8')
    RSS = ('<?xml version="1.0"?><rss xmlns:truth="https://truthsocial.com/ns"><channel>'
           '<item><title>China must pay TARIFFS!</title><description>&lt;p&gt;China&lt;/p&gt;</description>'
           '<pubDate>Mon, 02 Nov 2026 08:00:00 -0500</pubDate><guid>g1</guid>'
           '<truth:originalId>115001</truth:originalId><truth:originalUrl>https://truthsocial.com/@x/115001</truth:originalUrl></item>'
           '<item><title>[No Title]</title><description>&lt;p&gt;Brand new&lt;/p&gt;</description>'
           '<pubDate>Tue, 03 Nov 2026 08:00:00 +0000</pubDate><guid>g9</guid><truth:originalId>115009</truth:originalId></item>'
           '</channel></rss>').encode('utf-8')

    def make(script):
        calls, seq = [], list(script)

        def send(method, url, **kw):
            calls.append((url, dict(kw.get('headers') or {})))
            x = seq.pop(0)
            if isinstance(x, Exception):
                raise x
            return x
        return Gate(send=send, sleep=lambda s: None, clock=lambda: 0.0, backoff=()), calls

    out = []
    g, calls = make([R(200, CSV, {'Last-Modified': 'Mon, 02 Nov 2026 15:00:00 GMT', 'ETag': '"abc"'}),
                     R(304), R(200, RSS)])
    rc = run(g, log=out.append)
    txt = '\n'.join(out)
    ok('① 兩個都通 → 0', rc == 0, rc)
    ok('① 列數 3、欄位 5', '列數 3' in txt and "['id', 'created_at', 'content', 'url', 'media']" in txt, txt[:400])
    ok('① 最早 / 最新(照時間排,⛔ 照檔案順序)', '最早 2026-11-02T13:00:00Z ・最新 2026-11-03T02:15:00Z' in txt)
    ok('① 內文空白 1 列', '內文空白 1 列' in txt)
    ok('① 304 有被問到而且帶了兩個標頭', calls[1][1].get('If-None-Match') == '"abc"' and 'If-Modified-Since' in calls[1][1]
       and '支援 304' in txt, calls[1])
    ok('② RSS 2 則、[No Title] 改用內文', '則數 2' in txt and "'text': 'Brand new'" in txt, txt[-900:])
    ok('③ RSS 時區轉對了(08:00 −0500 = 13:00Z → 差 0 分)', '中位 0.0' in txt, txt[-600:])
    ok('③ CNN 對得上 1/2(50%)', 'CNN 也有 1 則(50%)' in txt)
    ok('③ RSS 比 CNN 新 1 則', '還新的有 1 則' in txt)
    # 決定性對照:RSS 的時間如果被當成 UTC(⛔ 轉時區)→ 差 −300 分
    out2 = []
    g2, _ = make([R(200, CSV), R(200, RSS.replace(b'-0500', b'+0000'))])
    run(g2, log=out2.append)
    ok('③ 決定性對照:時區弄錯 → 中位 −300', '中位 -300.0' in '\n'.join(out2), '\n'.join(out2)[-500:])
    # 兩個都被擋 → 1;403 ⛔ 重試
    out3 = []
    g3, calls3 = make([R(403), R(403)])
    ok('④ 兩個都被擋 → 1', run(g3, log=out3.append) == 1)
    ok('④ 403 只問一次(⛔ 重試、⛔ 換身分)', len(calls3) == 2, len(calls3))
    ok('④ 身分寫明 StockAI-DB', all('StockAI-DB' in c[1].get('User-Agent', '') for c in calls3), calls3)
    # 只有 RSS 通 → 0
    out4 = []
    g4, _ = make([R(403), R(200, RSS)])
    ok('⑤ CNN 擋、RSS 通 → 0', run(g4, log=out4.append) == 0)
    print(f'\n{"✅ 全部通過" if not fails else "❌ " + str(len(fails)) + " 條沒過"}')
    return 0 if not fails else 1


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    sys.exit(run(Gate(gaps={'ix.cnn.io': 3.0, 'www.trumpstruth.org': 3.0}, timeout=180)))
