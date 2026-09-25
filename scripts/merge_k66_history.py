#!/usr/bin/env python3
"""📚 V77.6.2 把外部資料集 k66inthesky/tw-stock(2010-01 ~ 2023-12,上市 997 檔,證交所原始日 K)
接到本站的 K 線深歷史前面,做成 2010 起的回測資料夾。

⛔ 外部資料**不進本 repo**(別人的資料)—— 這支只在本機/暫存資料夾用:
    git clone --depth 1 https://github.com/k66inthesky/tw-stock <K66_DIR>
    python3 scripts/merge_k66_history.py <K66_DIR>/stocks_full <本站合併資料夾(klines_deep+data)> <輸出資料夾>

做的四件事(順序不可換):
  ① k66 那段是**原始價**:減資 / 除權 / 分割都沒還原 → 超過當時漲跌停(2015-06-01 前 ±7%、之後 ±10%)的單日跳動
     一律視為公司行動,回頭調整舊價(⛔ 每檔前 5 根不判 —— 新上市前 5 日沒有漲跌停)。
     實測 552 次不可能的跳動 → 調整 1,417 次後只剩 3 次。
  ② 接點 = 兩邊第一個共同日期(本站資料的前 20 根內找);k66 那段乘上「本站收盤 ÷ k66 收盤」對齊本站已做過的調整。
  ③ 接完整條再跑一次本站的 `miner._backadjust_splits`(同一把尺)。
  ④ 加權指數本站只到 2021-09 → 2010 ~ 2021-09 用**等權代理**(k66 上市股每日報酬的平均,單日 ±10% 截尾)
     往回接到真的加權第一天。⚠️ 它**不是加權指數**(不是市值加權、沒有上櫃),只拿來當日期軸與「嚴格空頭」判斷;
     每一列都標 `proxy: 1`。實測年報酬:2011 −28.3% / 2015 −12.0% / 2018 −10.1% / 2020 +21.8%(方向跟真的加權一致)。

⑤ V77.6.3 `--idx-long <data/idx_long.json>`:用真的加權 + 0050 取代 ④ 的代理(見 apply_idx_long)。
   已經合併過的資料夾可以只換這一段:`--idx-long-only <DD> <OUT> --idx-long <file>`。
   ⛔ 不帶這個參數時,輸出跟 V77.6.2 那一版逐位元組相同。

⚠️ 限制(回報時一定要寫):只有上市、沒有上櫃;只有 2023 年底還活著的股票(倖存者偏誤);
   2010~2020 沒有 0050(ETF 不在那份資料裡)→ 那幾年只能跟等權代理比。
"""
import csv, glob, json, os, shutil, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import miner  # noqa: E402

num = lambda x: float(x.replace(',', '')) if x not in ('', '--', None) else None


def load_k66(path):
    rows = []
    for r in list(csv.reader(open(path)))[1:]:
        o, h, l, c, v = num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[1])
        if not c or not o or not h or not l:
            continue
        rows.append(dict(date=r[0].replace('-', '/'), open=o, high=h, low=l, close=c, volume=v or 0))
    return rows


def adjust_corporate_actions(rows):
    """① 超過當時漲跌停的單日跳動 → 回頭調整舊價;回傳調整次數"""
    raw = [r['close'] for r in rows]
    fac = [1.0] * len(rows); f_ = 1.0; n = 0
    for i in range(len(rows) - 1, 0, -1):
        lim = 0.07 if rows[i]['date'] < '2015/06/01' else 0.10
        r = raw[i] / raw[i - 1]
        if i >= 5 and (r > 1 + lim + 0.005 or r < 1 - lim - 0.005):
            f_ *= r; n += 1
        fac[i - 1] = f_
    for r, fx in zip(rows, fac):
        if fx != 1.0:
            for k in ('open', 'high', 'low', 'close'):
                r[k] = r[k] * fx
            r['volume'] = r['volume'] / fx
    return n


def main(K, DD, OUT, idx_long=None):
    os.makedirs(OUT, exist_ok=True)
    stat = dict(joined=0, copied=0, noanchor=0, ca=0)
    for f in glob.glob(f'{DD}/*.json'):
        sym = os.path.basename(f)[:-5]
        kf = f'{K}/{sym}.csv'
        try:
            dd = json.load(open(f))
        except Exception:
            dd = None
        if not os.path.exists(kf) or not isinstance(dd, list) or not dd or 'date' not in dd[0]:
            shutil.copy(f, f'{OUT}/{sym}.json'); stat['copied'] += 1; continue
        rows = load_k66(kf)
        stat['ca'] += adjust_corporate_actions(rows)
        kmap = {r['date']: r for r in rows}
        anc = next(((kmap[x['date']], x) for x in dd[:20] if x['date'] in kmap and x['close'] > 0), None)
        if not anc:
            shutil.copy(f, f'{OUT}/{sym}.json'); stat['noanchor'] += 1; continue
        k = anc[1]['close'] / anc[0]['close']
        d0 = dd[0]['date']
        pre = [dict(r, open=round(r['open'] * k, 4), high=round(r['high'] * k, 4), low=round(r['low'] * k, 4),
                    close=round(r['close'] * k, 4), volume=round(r['volume'] / k)) for r in rows if r['date'] < d0]
        json.dump(miner._backadjust_splits(pre + dd, sym), open(f'{OUT}/{sym}.json', 'w'))
        stat['joined'] += 1
    for x in glob.glob(f'{DD}/*'):
        b = os.path.basename(x)
        if os.path.isdir(x):
            if not os.path.exists(f'{OUT}/{b}'):
                os.symlink(os.path.abspath(x), f'{OUT}/{b}')
        elif not os.path.exists(f'{OUT}/{b}'):
            shutil.copy(x, f'{OUT}/{b}')
    if idx_long:
        apply_idx_long(DD, OUT, idx_long)
        print(stat)
        return
    # ④ 加權等權代理
    T = json.load(open(f'{DD}/^TWII.json')); t0 = T[0]['date']; ret = {}
    for f in glob.glob(f'{OUT}/*.json'):
        b = os.path.basename(f)
        if not b[0].isdigit() or b.startswith('00'):
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if not isinstance(d, list) or len(d) < 30 or 'date' not in d[0]:
            continue
        for a, c in zip(d, d[1:]):
            if c['date'] > t0:
                break
            if (a.get('close') or 0) > 0 and (c.get('close') or 0) > 0:
                ret.setdefault(c['date'], []).append(max(-0.1, min(0.1, c['close'] / a['close'] - 1)))
    dates = sorted(x for x in ret if x <= t0 and len(ret[x]) >= 300)
    lvl = {t0: T[0]['close']}; cur = T[0]['close']
    for i in range(len(dates) - 1, 0, -1):
        m = sum(ret[dates[i]]) / len(ret[dates[i]]); cur = cur / (1 + m); lvl[dates[i - 1]] = cur
    pre = [dict(date=d, open=round(lvl[d], 2), high=round(lvl[d], 2), low=round(lvl[d], 2), close=round(lvl[d], 2), volume=0, proxy=1)
           for d in sorted(lvl) if d < t0]
    json.dump(pre + T, open(f'{OUT}/^TWII.json', 'w'))
    stat['proxy_days'] = len(pre)
    print(stat)


def apply_idx_long(DD, OUT, idx_path):
    """📚 V77.6.3 ⑤ 有 `data/idx_long.json`(idx_long.yml 抓的真加權 + 0050,2010 起)時,取代 ④ 的等權代理:
      ・^TWII.json = 真的加權(本站那份第一天以前)+ 本站那份;接點價差 >0.5% 就停手(⛔ 不硬接)
      ・_bench0050.json = 真的 0050(本站那份第一天以前)+ 本站那份 —— 給 portfolio_backtest 的 BENCH0050 用,
        ⛔ 不動股票池裡的 0050.json(那會改變 0050 當候選股的交易、交易快取就不能重用)
      ・_div0050.json = 0050 除息紀錄(dividends_hist 的格式),給 DIV 用(本站那份只從 2021 起)
    """
    J = json.load(open(idx_path))
    T = json.load(open(f'{DD}/^TWII.json')); t0 = T[0]['date']
    real = {r[0]: r for r in J['twii']}
    if t0 not in real or abs(real[t0][4] / T[0]['close'] - 1) > 0.005:
        sys.exit(f'❌ 加權接點對不上:{t0} 本站 {T[0]["close"]} vs 長歷史 {real.get(t0, ["", 0, 0, 0, None])[4]}')
    pre = [dict(date=r[0], open=r[1], high=r[2], low=r[3], close=r[4], volume=0, amount=r[5]) for r in J['twii'] if r[0] < t0]
    json.dump(pre + T, open(f'{OUT}/^TWII.json', 'w'))
    E = json.load(open(f'{DD}/0050.json')); e0 = E[0]['date']
    er = {r[0]: r for r in J['e0050']}
    if e0 not in er or abs(er[e0][4] / E[0]['close'] - 1) > 0.005:
        sys.exit(f'❌ 0050 接點對不上:{e0} 本站 {E[0]["close"]} vs 長歷史 {er.get(e0, ["", 0, 0, 0, None])[4]}')
    pe = [dict(date=r[0], open=r[1], high=r[2], low=r[3], close=r[4], volume=r[5]) for r in J['e0050'] if r[0] < e0]
    json.dump(pe + E, open(f'{OUT}/_bench0050.json', 'w'))
    dv = [[r[0].replace('/', '-'), r[1], r[2], r[3], r[4]] for r in J.get('div0050') or []]
    json.dump({'d': {'0050': {'h': dv}}}, open(f'{OUT}/_div0050.json', 'w'))
    print({'twii_real_days': len(pre), 'twii_from': pre[0]['date'] if pre else None,
           'e0050_days': len(pe), 'e0050_from': pe[0]['date'] if pe else None, 'div0050': len(dv)})


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    idx = sys.argv[sys.argv.index('--idx-long') + 1] if '--idx-long' in sys.argv else None
    if idx:
        args = [a for a in args if a != idx]
    if '--idx-long-only' in sys.argv and idx and len(args) == 2:
        apply_idx_long(args[0], args[1], idx)      # 已合併過的輸出資料夾:只換大盤與 0050 對照
    elif len(args) == 3:
        main(*args, idx_long=idx)
    else:
        print(__doc__); sys.exit(1)
