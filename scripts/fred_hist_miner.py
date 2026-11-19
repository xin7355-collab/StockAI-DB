#!/usr/bin/env python3
"""💱 V82.5.6 匯率 / 美債 / 信用利差 / 油 / 比特幣 每日歷史(FRED)→ data/fred_hist.json

為什麼要有這支(「App 加上人性」第 6 期):
  產業作戰室「🧠 人性」頁的匯率表要「20 日」「一年位置」、外資座位要「這一波用美元算跌多少」、
  群眾那段要「美國信用利差」—— macro_risk.json 只有今天一個值,沒有歷史(第 5 期那幾格寫「⏳ 第 6 期」)。

來源:FRED(聖路易聯準銀行)graph CSV,免金鑰。一律走 lib_official.fred_series(lib_http.Gate:UA 寫明身分、
  ⛔ 冒充瀏覽器、被擋就斷路 ⛔ 換身分重試、忙就退避)。
  ⚠️ FRED 的匯率(H.10)一週才更新一次(週一補上一週每天的值)、美債(H.15)晚一天
  → 這份只當「歷史基準」;今天的值照舊用 macro_risk.json(mood_build 那邊先比一次兩邊是不是同一把尺才接)。
  ⛔ 美元指數不收:FRED 只有「廣義美元指數」,跟 App 用的美元指數(ICE 那條公式)不是同一個東西(陷阱 #17)。
  ⛔ 黃金 / 銅不收:FRED 沒有每天的(黃金 2022 起停了、銅只有月資料)。

做法:
  第一次(沒有上一份):每一條從自己的起點抓全部。之後:每一條從上一份最後一天往前 OVERLAP 天抓,跟上一份合併(同一天用新的)。
  守門(每一條各自判;沒過的那條沿用上一份、原因寫進 src_error,⛔ 拖垮別條):
    ① 這次抓到的最後一天不可以比上一份還早(FRED 回舊資料 / 換了序列)
    ② 重疊那幾天的值要對得上:差超過 0.5% 的天數超過兩成 → 這次的不收(同一把尺守門)
  上一份讀不出來(壞檔)→ ⛔ 用這一輪蓋掉歷史:exit 1、不寫(下一輪再試,壞檔留著等人修)。
  一條都沒拿到、也沒有上一份 → exit 1、不寫。
  「這段期間沒有值」(假日、FRED 還沒更新)不算錯,安靜沿用。

產物:{v, updated, src, series: {key: {sid, name, unit, from, to, n, d: {YYYY-MM-DD: 值}}}, src_error: {key: 原因}}
  只推 data 分支(研究與 mood_build 在 Actions 上讀;⛔ 進 gh-pages —— 手機用不到 1 MB 的歷史)。

跑法:python3 scripts/fred_hist_miner.py [--selftest]
      環境變數 PREV=上一份(預設 data/fred_hist.json)・OUT=輸出(預設同 PREV)・ONLY=usdtwd,baa10y(只跑這幾條,手動除錯用)
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import lib_official as LO          # noqa: E402
from lib_jsonsafe import load_accum   # noqa: E402

# key, FRED 代號, 名稱, 單位, 起點(第一次抓全部時從這天開始)
SERIES = [
    ('usdtwd', 'DEXTAUS', '美元 / 台幣', '台幣', '2000-01-01'),
    ('jpy', 'DEXJPUS', '美元 / 日圓', '日圓', '2000-01-01'),
    ('krw', 'DEXKOUS', '美元 / 韓元', '韓元', '2000-01-01'),
    ('cny', 'DEXCHUS', '美元 / 人民幣', '人民幣', '2000-01-01'),
    ('ust10y', 'DGS10', '美債 10 年殖利率', '%', '2000-01-01'),
    ('us2y', 'DGS2', '美債 2 年殖利率', '%', '2000-01-01'),
    ('baa10y', 'BAA10Y', '美國信用利差(Baa 公司債 − 10 年美債)', '個百分點', '1986-01-01'),
    ('wti', 'DCOILWTICO', '西德州原油(現貨)', '美元', '2000-01-01'),   # ⚠️ 研究用:App 的油價是期貨近月,⛔ 跟這條接在一起(mood_build FX_FRED 沒有它)
    ('btc', 'CBBTCUSD', '比特幣(Coinbase)', '美元', '2015-01-01'),
]
OVERLAP = 45          # 之後每一輪往前多抓幾天(FRED 匯率一週才補一次 + 偶爾修正)
TOL = 0.005           # 重疊那幾天差多少算對不上(0.5%)
BAD_SHARE = 0.2       # 對不上的天數超過幾成就不收這次的
MIN_OV = 5            # 重疊幾天以上才判 ②(太少不判)


def _tw_now():
    return datetime.now(timezone(timedelta(hours=8)))


def merge(prev_d, pts):
    """prev_d = {iso: 值}(上一份);pts = [(iso, 值)…](這次抓到的,由舊到新)→ (合併後, 不收的原因 / '')。"""
    prev_d = prev_d or {}
    if not pts:
        return dict(prev_d), ''
    if prev_d:
        last_prev, last_new = max(prev_d), pts[-1][0]
        if last_new < last_prev:
            return dict(prev_d), f'這次抓到的最後一天 {last_new} 比上一份的 {last_prev} 還早 → 這次的不收'
        ov = [(d, v) for d, v in pts if d in prev_d]
        if len(ov) >= MIN_OV:
            bad = sum(1 for d, v in ov if abs(v - prev_d[d]) > TOL * max(abs(prev_d[d]), 1e-9))
            if bad > BAD_SHARE * len(ov):
                return dict(prev_d), f'重疊 {len(ov)} 天有 {bad} 天差超過 {TOL * 100:g}%(不像同一條序列)→ 這次的不收'
    out = dict(prev_d)
    out.update({d: v for d, v in pts})
    return out, ''


def run(gate, prev, today, only=None, log=print):
    """→ (產物, 有幾條這一輪有拿到新的或沿用得上)。prev = 上一份(dict 或 None)。"""
    prev_series = (prev or {}).get('series') or {}
    out = {'v': 1, 'updated': _tw_now().strftime('%Y-%m-%d %H:%M +0800'), 'src': 'FRED graph CSV(fred.stlouisfed.org,免金鑰)',
           'series': {}, 'src_error': {}}
    good = 0
    for key, sid, name, unit, start in SERIES:
        if only and key not in only:
            if key in prev_series:
                out['series'][key] = prev_series[key]
            continue
        old = (prev_series.get(key) or {}).get('d') or {}
        if old:
            frm = (date.fromisoformat(max(old)) - timedelta(days=OVERLAP))
        else:
            frm = date.fromisoformat(start)
        days = max(1, (today - frm).days)
        st, pts, why = LO.fred_series(gate, sid, days=days, today=today)
        note = ''
        if st == 'ok':
            merged, note = merge(old, pts)
        elif st == 'none':
            merged = dict(old)
        else:
            merged, note = dict(old), f'FRED {sid} 抓不到:{why}'
        if note:
            out['src_error'][key] = note
        if merged:
            ds = sorted(merged)
            out['series'][key] = {'sid': sid, 'name': name, 'unit': unit, 'from': ds[0], 'to': ds[-1], 'n': len(ds),
                                  'd': {d: merged[d] for d in ds}}
            good += 1
        log(f"  {'✅' if merged and not note else ('⚠️' if merged else '❌')} {key}({sid}):"
            f"{'沒有資料' if not merged else str(len(merged)) + ' 天 ' + min(merged) + ' ~ ' + max(merged)}"
            f"{'(這次 ' + str(len(pts)) + ' 天)' if st == 'ok' else ''}{' ・' + note if note else ''}")
    return out, good


def main():
    prev_path = os.environ.get('PREV') or os.path.join(ROOT, 'data', 'fred_hist.json')
    out_path = os.environ.get('OUT') or prev_path
    only = set(x.strip() for x in (os.environ.get('ONLY') or '').split(',') if x.strip()) or None
    prev, can_write = load_accum(Path(prev_path), None, what='fred_hist.json')
    if not can_write:
        print('❌ 上一份 fred_hist.json 讀不出來 → ⛔ 這輪不寫(⛔ 用這一輪蓋掉整段歷史)')
        return 1
    print(f"💱 FRED 每日歷史:{len(SERIES) if not only else len(only)} 條 ・上一份 {'有 ' + str(len((prev or {}).get('series') or {})) + ' 條' if prev else '沒有(第一次,抓全部)'}")
    out, good = run(LO.make_gate(), prev, _tw_now().date(), only=only)
    if not good:
        print('❌ 一條都沒有(也沒有上一份可以沿用)→ ⛔ 不寫')
        return 1
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, out_path)
    print(f"✅ 寫入 {out_path}:{good} 條 ・{os.path.getsize(out_path):,} bytes ・沒收這次的 {len(out['src_error'])} 條")
    return 0


# ───────────────────────── selftest(網路 / 時間 / 睡眠全換假的,走正式入口 run / main)─────────────────────────
def selftest():
    import tempfile
    bad = []

    def ok(n, c, e=''):
        print(f"{'✅' if c else '❌'} {n}{'' if c else '  ' + str(e)[:300]}")
        if not c:
            bad.append(n)

    class R:
        def __init__(self, code, body):
            self.status_code = code
            self.content = body.encode('utf-8')

    def csv_of(sid, pts):
        return 'observation_date,' + sid + '\n' + ''.join(f'{d},{v}\n' for d, v in pts)

    mk0 = LO.make_gate   # ⑦ 會把 LO.make_gate 換掉 → fake 一律用原本那支(⛔ 自己呼叫自己)

    def fake(routes):
        """routes:FRED 代號 → 回應(R / Exception);沒列的 → 404。回 (gate, 呼叫的網址)。"""
        calls, t = [], [0.0]

        def send(method, url, **kw):
            calls.append(url)
            for sid, v in routes.items():
                if f'id={sid}&' in url:
                    if isinstance(v, Exception):
                        raise v
                    return v
            return R(404, 'not found')
        LO.clear_cache()
        return mk0(send=send, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0]), calls

    today = date(2026, 11, 20)
    days = [(date(2026, 10, 1) + timedelta(days=k)).isoformat() for k in range(45)]
    twd = [(d, round(32.0 + k * 0.01, 4)) for k, d in enumerate(days)]
    full = {sid: R(200, csv_of(sid, twd if sid == 'DEXTAUS' else [(d, 1.0 + k * 0.001) for k, d in enumerate(days)])) for _, sid, *_ in SERIES}

    # ① 第一次(沒有上一份):每條從自己的起點抓全部
    g, calls = fake(full)
    out, good = run(g, None, today, log=lambda *_: None)
    tw = out['series'].get('usdtwd') or {}
    ok('① 第一次:9 條都拿到、日期由舊到新、from / to / n 對', good == len(SERIES) and tw.get('n') == 45 and tw.get('from') == days[0]
       and tw.get('to') == days[-1] and list(tw['d'])[:2] == days[:2], (good, {k: v for k, v in tw.items() if k != 'd'}))
    c_twd = [u for u in calls if 'id=DEXTAUS&' in u][0]
    c_baa = [u for u in calls if 'id=BAA10Y&' in u][0]
    ok('①b 第一次從各自的起點抓(台幣 2000 起、信用利差 1986 起)', 'cosd=2000-01-01' in c_twd and 'cosd=1986-01-01' in c_baa, (c_twd, c_baa))
    ok('①c 一條一個請求(9 條 = 9 次)', len(calls) == len(SERIES), len(calls))

    # ② 之後:只往前抓 45 天、合併(同一天用新的、上一份更早的留著)
    prev = json.loads(json.dumps(out))
    new_days = [(date(2026, 11, 1) + timedelta(days=k)).isoformat() for k in range(19)]
    twd2 = [(d, round(32.0 + (31 + k) * 0.01, 4)) for k, d in enumerate(new_days)]   # 11/01 起跟上一份同一條線
    g, calls = fake({**full, 'DEXTAUS': R(200, csv_of('DEXTAUS', twd2))})
    out2, good2 = run(g, prev, today, log=lambda *_: None)
    tw2 = out2['series']['usdtwd']
    c2 = [u for u in calls if 'id=DEXTAUS&' in u][0]
    ok('② 之後:從上一份最後一天往前 45 天抓(cosd = 11/14 − 45 天)', f'cosd={(date.fromisoformat(days[-1]) - timedelta(days=OVERLAP)).isoformat()}' in c2, c2)
    ok('②b 合併:上一份更早的留著、新的接上去(10/01 ~ 11/19,50 天)', tw2['from'] == days[0] and tw2['to'] == new_days[-1] and tw2['n'] == 50
       and 'usdtwd' not in out2['src_error'], ({k: v for k, v in tw2.items() if k != 'd'}, out2['src_error']))

    # ③ 守門 ①:這次的最後一天比上一份還早 → 不收、原因寫進 src_error、沿用上一份
    g, _ = fake({**full, 'DEXTAUS': R(200, csv_of('DEXTAUS', twd[:20]))})
    out3, _ = run(g, prev, today, log=lambda *_: None)
    ok('③ 這次的最後一天比上一份早 → 沿用上一份、src_error 寫原因', out3['series']['usdtwd']['to'] == days[-1]
       and '還早' in out3['src_error'].get('usdtwd', ''), out3['src_error'])

    # ④ 守門 ②:重疊那幾天對不上(單位換了:×100)→ 不收;⭐ 決定性對照:同一份資料不乘 → 收
    shifted = [(d, v * 100) for d, v in twd[-10:]] + [('2026-11-20', 3300.0)]
    g, _ = fake({**full, 'DEXTAUS': R(200, csv_of('DEXTAUS', shifted))})
    out4, _ = run(g, prev, today, log=lambda *_: None)
    ok('④ 重疊 10 天全部差 100 倍 → 這次的不收、沿用上一份', out4['series']['usdtwd']['to'] == days[-1]
       and '對不上' in out4['src_error'].get('usdtwd', '') or '不像同一條' in out4['src_error'].get('usdtwd', ''), out4['src_error'])
    same = twd[-10:] + [('2026-11-20', 32.5)]
    g, _ = fake({**full, 'DEXTAUS': R(200, csv_of('DEXTAUS', same))})
    out4b, _ = run(g, prev, today, log=lambda *_: None)
    ok('④b 決定性對照:同一份資料不乘 100 → 收(接到 11/20)', out4b['series']['usdtwd']['to'] == '2026-11-20'
       and 'usdtwd' not in out4b['src_error'], (out4b['series']['usdtwd']['to'], out4b['src_error']))

    # ⑤ 這段期間沒有值(假日 / 還沒更新)→ 安靜沿用,⛔ 不算錯
    g, _ = fake({**full, 'DEXTAUS': R(200, 'observation_date,DEXTAUS\n2026-11-19,.\n')})
    out5, _ = run(g, prev, today, log=lambda *_: None)
    ok('⑤ FRED 回「.」(沒有值)→ 沿用上一份、⛔ 寫 src_error', out5['series']['usdtwd']['to'] == days[-1] and 'usdtwd' not in out5['src_error'], out5['src_error'])

    # ⑥ FRED 回網頁(擋頁)→ 整個網站停手(lib_http 斷路:⛔ 被擋還一直打)、每一條都沿用上一份並寫原因、檔案照寫
    g, calls6 = fake({**full, 'DEXTAUS': R(200, '<html>blocked</html>')})
    out6, good6 = run(g, prev, today, log=lambda *_: None)
    ok('⑥ 第一條就被擋 → 只問了那一次就停手、9 條都沿用上一份、每條都寫原因', len(calls6) == 1 and good6 == len(SERIES)
       and all(out6['series'][k]['to'] == prev['series'][k]['to'] for k, *_ in SERIES) and len(out6['src_error']) == len(SERIES)
       and '擋' in out6['src_error']['usdtwd'], (len(calls6), out6['src_error'].get('usdtwd')))
    # ⑥b 沒被擋、只是那一條 404(代號改了)→ 只有那條寫原因、其他照常(404 ⛔ 斷路)
    g, calls6b = fake({k: v for k, v in full.items() if k != 'DEXJPUS'})
    out6b, _ = run(g, prev, today, log=lambda *_: None)
    ok('⑥b 一條 404 → 只有那條沿用 + 寫原因,其他 8 條照常', list(out6b['src_error']) == ['jpy'] and len(calls6b) == len(SERIES), out6b['src_error'])

    # ⑦ 走 main():上一份是壞檔 → exit 1、⛔ 寫;沒有上一份又全部抓不到 → exit 1、⛔ 寫
    td = tempfile.mkdtemp()
    p = os.path.join(td, 'fred_hist.json')
    with open(p, 'w', encoding='utf-8') as f:
        f.write('{"v":1,"series":{"usdtwd":')
    before = open(p, encoding='utf-8').read()
    os.environ['PREV'] = p
    os.environ.pop('OUT', None)
    _mk = LO.make_gate
    try:
        LO.make_gate = lambda *a, **k: fake(full)[0]
        rc = main()
        ok('⑦ 上一份讀不出來 → exit 1、壞檔一個字都沒動(⛔ 用這一輪蓋掉歷史)', rc == 1 and open(p, encoding='utf-8').read() == before, rc)
        os.remove(p)
        LO.make_gate = lambda *a, **k: fake({})[0]
        rc2 = main()
        ok('⑦b 沒有上一份、又一條都抓不到 → exit 1、⛔ 寫檔', rc2 == 1 and not os.path.exists(p), rc2)
        LO.make_gate = lambda *a, **k: fake(full)[0]
        rc3 = main()
        j = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
        ok('⑦c 正常 → exit 0、寫進去、讀得回來', rc3 == 0 and len(j.get('series') or {}) == len(SERIES), rc3)
    finally:
        LO.make_gate = _mk
        os.environ.pop('PREV', None)

    # ⑧ UA 寫明身分、⛔ 冒充瀏覽器(沿用 lib_official / lib_http 的守門)
    seen = []

    def send(method, url, **kw):
        seen.append(kw.get('headers') or {})
        return R(200, csv_of('DEXTAUS', twd))
    LO.clear_cache()
    gg = LO.make_gate(send=send, sleep=lambda s: None, clock=lambda: 0.0)
    run(gg, None, today, only={'usdtwd'}, log=lambda *_: None)
    ua = (seen[0] if seen else {}).get('User-Agent', '')
    ok('⑧ UA 寫明 StockAI-DB、⛔ 冒充瀏覽器', 'StockAI-DB' in ua and 'Chrome' not in ua and 'Safari' not in ua, ua)
    ok('⑧b ONLY=usdtwd → 只問那一條', len(seen) == 1, len(seen))
    LO.clear_cache()

    print('\n✅ 全部通過' if not bad else f'\n❌ {len(bad)} 條沒過')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
