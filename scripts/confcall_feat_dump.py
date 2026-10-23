#!/usr/bin/env python3
"""🧾 法說會簡報特徵 → 研究用事件表(scripts/confcall_content_probe.mjs 的輸入)。

⭐ 一律呼叫 confcall_deck 自己的 load_all / novelty_all / tone_of / _has_figure(⛔ 不複製判定邏輯 ——
   畫面上的「這次第一次提到」跟研究用的必須是同一個東西,不然研究結論套不回畫面)。
⛔ 只讀 cc_deep 的特徵檔、只寫一個 JSON;不下載、不碰任何分支。

每一列(一份讀成功的簡報 = 一個事件):
  s 代號 ・d 法說會日期 ・f 檔名 ・inv 1 = 券商邀請場
  first  True = 這家公司第一份被收錄的簡報(⛔ 沒有上一份可比 → 不判「新」)
  n_new  這次第一次提到幾個詞(first 時為 None)
  pos / neg  講到之後那幾句裡的正向詞 / 保守詞次數(confcall_deck.tone_of)
  n_ol   講到之後的句子幾句 ・ol_fig 其中有給數字的幾句 ・n_nums 公司給的數字句幾句 ・pages 頁數

跑法:CC_DIR=$S/ccd python3 scripts/confcall_feat_dump.py $S/ccfeat.json
      ($S/ccd 裡放 cc/feat/*.json.gz:git archive origin/cc_deep | tar -x -C $S/ccd)
      python3 scripts/confcall_feat_dump.py --selftest
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import confcall_deck as cd  # noqa: E402


def events(recs_by_month):
    """{YYYY-MM: [rec…]} → 事件列(日期由舊到新)。只收讀成功、有日期的。"""
    recs = [r for rs in recs_by_month.values() for r in rs
            if isinstance(r, dict) and r.get('st') == 'ok' and r.get('d') and r.get('s')]
    nov = cd.novelty_all(recs)
    out = []
    for r in sorted(recs, key=lambda x: (x['d'], x.get('f') or '')):
        nv = nov.get(r.get('f')) or {}
        ol = r.get('outlook') or []
        pos, neg = cd.tone_of(ol)
        out.append({
            's': r['s'], 'd': r['d'], 'f': r.get('f'), 'inv': 1 if r.get('inv') else 0,
            'first': bool(nv.get('first')) or not nv,
            'n_new': None if (nv.get('first') or not nv) else int(nv.get('n_new') or 0),
            'pos': pos, 'neg': neg,
            'n_ol': len(ol), 'ol_fig': sum(1 for _, t in ol if cd._has_figure(t)),
            'n_nums': len(r.get('nums') or []), 'pages': r.get('pages') or 0,
        })
    return out


def main(argv):
    if '--selftest' in argv:
        return selftest()
    if len(argv) < 2:
        print('用法:CC_DIR=<cc_deep 解開的目錄> python3 scripts/confcall_feat_dump.py out.json ・--selftest')
        return 1
    cc_dir = os.getenv('CC_DIR') or 'cc_deep'
    cd.CC = Path(cc_dir)
    allr = cd.load_all()
    if not allr:
        print(f'❌ {cc_dir}/cc/feat/ 裡沒有任何特徵檔(先 git archive origin/cc_deep | tar -x -C {cc_dir})')
        return 1
    ev = events(allr)
    if not ev:
        print('❌ 特徵檔裡沒有任何讀成功的簡報 → ⛔ 不寫空檔')
        return 1
    Path(argv[1]).write_text(json.dumps(ev, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    nf = sum(1 for e in ev if e['first'])
    print(f'🧾 {len(ev)} 份簡報 ・{ev[0]["d"]} ~ {ev[-1]["d"]} ・第一份(沒得比){nf} ・可判新詞 {len(ev) - nf}'
          f' ・券商邀請 {sum(e["inv"] for e in ev)} → {argv[1]}')
    return 0


def selftest():
    fail = 0

    def ok(name, cond, extra=''):
        nonlocal fail
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
        if not cond:
            fail += 1

    def rec(s, d, f, terms, outlook=(), nums=(), st='ok', inv=0):
        return {'s': s, 'd': d, 'f': f, 'st': st, 'inv': inv, 'terms': dict(terms), 'pages': 10,
                'outlook': [list(x) for x in outlook], 'nums': [list(x) for x in nums], 'titles': []}

    allr = {'2024-01': [rec('2330', '2024-01-18', 'a1.pdf', {'CoWoS': 3, 'HBM': 4},
                            [(5, '預計明年營收成長 20%'), (6, '下半年需求回溫')])],
            '2024-04': [rec('2330', '2024-04-18', 'a2.pdf', {'CoWoS': 3, 'HBM': 4, 'CPO': 9},
                            [(5, '需求疲弱,保守看待')], nums=[(7, '毛利率 53.1%')]),
                        rec('2330', '2024-04-20', 'bad.pdf', {'X': 1}, st='parse_fail')],
            '2024-07': [rec('2317', '2024-07-10', 'b1.pdf', {'GB200': 2}, inv=1)]}
    ev = events(allr)
    by = {e['f']: e for e in ev}
    ok('① 讀失敗的不算事件', 'bad.pdf' not in by and len(ev) == 3, [e['f'] for e in ev])
    ok('② 第一份 → first=True、n_new=None(⛔ 沒上一份不判新)', by['a1.pdf']['first'] and by['a1.pdf']['n_new'] is None, by['a1.pdf'])
    ok('③ 第二份多講 CPO → n_new=1(呼叫 confcall_deck.novelty_all,同一套規則)',
       by['a2.pdf']['first'] is False and by['a2.pdf']['n_new'] == 1, by['a2.pdf'])
    ok('④ 語氣 = confcall_deck.tone_of(成長 / 回溫 → 正;疲弱 / 保守 → 負)',
       (by['a1.pdf']['pos'], by['a1.pdf']['neg']) == tuple(cd.tone_of(allr['2024-01'][0]['outlook']))
       and by['a1.pdf']['pos'] >= 2 and by['a2.pdf']['neg'] >= 2, (by['a1.pdf'], by['a2.pdf']))
    ok('⑤ 有給數字的展望句才算 ol_fig(「下半年需求回溫」⛔ 算)', by['a1.pdf']['ol_fig'] == 1 and by['a1.pdf']['n_ol'] == 2, by['a1.pdf'])
    ok('⑥ 券商邀請場標 inv=1、日期由舊到新', by['b1.pdf']['inv'] == 1 and [e['d'] for e in ev] == sorted(e['d'] for e in ev))
    # ⑦ 正式入口:從 cc_deep 目錄讀 → 寫檔;空目錄 → exit 1 ⛔ 寫空檔
    with tempfile.TemporaryDirectory() as tmp:
        cd.CC = Path(tmp) / 'cc_deep'
        for m, rs in allr.items():
            cd._save_json(cd.month_file(m + '-01'), rs)
        os.environ['CC_DIR'] = str(cd.CC)
        out = Path(tmp) / 'out.json'
        rc = main(['x', str(out)])
        got = json.loads(out.read_text(encoding='utf-8')) if out.exists() else []
        ok('⑦ 正式入口讀 cc/feat/*.json.gz → 寫出 3 列', rc == 0 and len(got) == 3, (rc, len(got)))
        os.environ['CC_DIR'] = str(Path(tmp) / 'empty')
        out2 = Path(tmp) / 'out2.json'
        rc2 = main(['x', str(out2)])
        ok('⑦b 沒有特徵檔 → exit 1、⛔ 寫空檔', rc2 == 1 and not out2.exists(), rc2)
    print('❌ %d 條失敗' % fail if fail else '✅ CONFCALL_FEAT_DUMP_SELFTEST_PASS')
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
