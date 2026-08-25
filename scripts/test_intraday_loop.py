#!/usr/bin/env python3
"""
🔁 盤中常駐迴圈(V73.9.0)測試 —— 節拍計算器 + workflow 接線

🚨 為什麼有這一版:V73.7.9 判定「盤中採礦是被 concurrency 擠掉」,搬出共用 group 之後
   `live_quotes.json` 確實第一次上得了 gh-pages —— **但仍然一天只跑一輪**。
   去查 run 清單才看到真因(2026-08-19 ~ 08-25,全部 workflow 都 state=active):

     live_snapshot  cron 要求 ~58/天 → 6 天只有 3 筆 run
     tick_flow      cron 要求 ~27/天 → **0 筆**
     stock_futures  cron 要求   2/天 → **0 筆(total_count=0,從來沒跑過)**
     theme_news / daily_miner / fund_sweep(每天 1~2 次)→ ✅ 全部正常,但**每一筆都遲到 24~49 分**

   ⭐⭐ 全 repo 一天只有 **7~10 筆** schedule run 進得來,而 cron 要求超過 100 筆
      → 這是**每個 repo 的排程配額**,先到先得;高頻的那兩支把配額吃光,
        連 stock_futures 那種一天只要 2 次的都擠不進來。
   ⛔ 而且被丟掉的**不是 `cancelled`,是連 run 都沒產生** → Actions 頁面一片乾淨。

   → 修法:把 85 次/天的排程需求壓成 5 次,節拍改在 job 裡自己跑。

⛔ 這支要釘死的七件事:
  ① 窗口邊界:收盤那一拍(quotes 13:30 / ticks 13:23)**必須跑得到**。
  ② 週末 → DONE(台股沒有盤)。
  ③ SLEEP ⛔ 不可回 0(bash 空轉燒 CPU)。
  ④ 兩支 workflow 的 cron **總數必須壓到個位數**,⛔ 不可有 `*/N` 這種高頻寫法。
  ⑤ workflow 迴圈裡**每輪都要回到主程式碼**(deploy 結束在 gh-pages/data 分支,
     那裡沒有採礦機)—— ⛔ 少了這行第二輪就開始失敗,而且只有實跑才看得到。
  ⑥ 節拍計算器要**複製到 /tmp** 再呼叫(gh-pages 分支上沒有 scripts/)。
  ⑦ 空過守門:一拍都沒成功 → 必須紅燈(⛔ 不可全綠沒資料,陷阱 #9)。
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIN = os.path.join(ROOT, 'scripts', 'intraday_window.py')
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:240]}")
    if not cond:
        fails.append(name)


def win(profile, hhmm, weekday=1):
    r = subprocess.run([sys.executable, WIN, profile, '--now', hhmm, '--weekday', str(weekday)],
                       capture_output=True, text=True)
    return r.stdout.strip()


# ── ① 窗口邊界 ────────────────────────────────────────────────────
ok('①a 盤前第一拍 08:45 要跑(台指期比現貨早開)', win('quotes', '08:45') == 'RUN', win('quotes', '08:45'))
ok('①b 08:44 還沒到 → SLEEP', win('quotes', '08:44').startswith('SLEEP'), win('quotes', '08:44'))
ok('①c 🚨 收盤那一拍 13:30 必須跑得到(收盤價就在那一拍)',
   win('quotes', '13:30') == 'RUN', win('quotes', '13:30'))
ok('①d 13:35 已過窗口 → DONE', win('quotes', '13:35') == 'DONE', win('quotes', '13:35'))
ok('①e ticks 首拍 09:03', win('ticks', '09:03') == 'RUN', win('ticks', '09:03'))
ok('①f 🚨 ticks 末拍 13:23 必須跑得到', win('ticks', '13:23') == 'RUN', win('ticks', '13:23'))
ok('①g ticks 13:30 已過自己的窗口 → DONE', win('ticks', '13:30') == 'DONE', win('ticks', '13:30'))
# 節拍正確性
ok('①h quotes 每 5 分:09:05 RUN / 09:07 不 RUN',
   win('quotes', '09:05') == 'RUN' and win('quotes', '09:07').startswith('SLEEP'))
ok('①i ticks 每 10 分且偏移 3(⭐ 刻意錯開 quotes 的整 5 分,免得同時 push gh-pages)',
   win('ticks', '09:13') == 'RUN' and win('ticks', '09:15').startswith('SLEEP'),
   f"09:13={win('ticks','09:13')} 09:15={win('ticks','09:15')}")

# ── ② 週末 ────────────────────────────────────────────────────────
for wd, nm in ((5, '週六'), (6, '週日')):
    ok(f'② {nm} → DONE(台股沒有盤)', win('quotes', '10:00', wd) == 'DONE', win('quotes', '10:00', wd))
ok('②b 平日同一時間要 RUN/SLEEP(⛔ 證明上面不是恆 DONE 的假綠燈)',
   win('quotes', '10:00', 1) in ('RUN',) or win('quotes', '10:00', 1).startswith('SLEEP'))

# ── ③ SLEEP 不可為 0 ──────────────────────────────────────────────
bad = []
for prof, lo, hi in (('quotes', 8, 14), ('ticks', 9, 14)):
    for h in range(lo, hi):
        for m in range(0, 60):
            s = win(prof, f'{h:02d}:{m:02d}') if (h == lo and m % 17 == 0) else None
            if s and s.startswith('SLEEP') and int(s.split()[1]) < 5:
                bad.append(f'{prof} {h:02d}:{m:02d} → {s}')
ok('③ SLEEP ⛔ 永不小於 5 秒(bash `sleep 0` = 空轉燒 CPU)', not bad, bad[:5])

# ── ④ workflow 的 cron 總數 ──────────────────────────────────────
WFS = {
    'live_snapshot': os.path.join(ROOT, '.github/workflows/live_snapshot.yml'),
    'tick_flow': os.path.join(ROOT, '.github/workflows/tick_flow.yml'),
}
srcs = {k: open(v, encoding='utf-8').read() for k, v in WFS.items()}
total = 0
for k, s in srcs.items():
    crons = re.findall(r"- cron: *['\"]([^'\"]+)['\"]", s)
    n = len(crons)
    total += n
    ok(f'④ {k} 的 cron 條數 ≤3(實測高頻排程會被 GitHub 整批丟掉)', n <= 3, crons)
    ok(f'④b {k} ⛔ 不可再出現 `*/N` 或逗號列舉的高頻寫法',
       all('*/' not in c.split()[0] and ',' not in c.split()[0] for c in crons), crons)
ok('④c 兩支合計 cron ≤5(修前是 85 次/天,吃光了整個 repo 的排程配額)', total <= 5, total)

# ── ⑤⑥⑦ workflow 迴圈接線(靜態,但每條都對應一個「只有實跑才看得到」的失敗) ──
for k, s in srcs.items():
    body = s.split('🔁 盤中常駐迴圈', 2)[-1]
    ok(f'⑤ {k} 每輪開頭有 `git checkout -f "$BASE_SHA"`(⛔ 少了它第二輪必失敗)',
       'git checkout -f "$BASE_SHA"' in body)
    ok(f'⑥ {k} 節拍計算器複製到 /tmp 再呼叫(gh-pages 上沒有 scripts/)',
       'cp scripts/intraday_window.py /tmp/win.py' in body and 'python3 /tmp/win.py' in body)
    ok(f'⑦ {k} 空過守門:一拍都沒成功要 exit 1',
       re.search(r'OKN.*-eq 0.*FIRST_RC.*-ne 0', body, re.S) is not None and 'exit 1' in body)
    ok(f'⑦b {k} 先無條件跑一輪(手動觸發測試靠這輪)', 'FIRST_RC=0' in body and 'once || FIRST_RC=$?' in body)
    ok(f'⑦c {k} ⛔ 連續失敗要收工,不可空轉整個窗口', 'STREAK' in body and '-ge 5' in body)
    ok(f'⑦d {k} 採礦前先刪舊產物(⛔ 免得失敗時部署上一輪的舊檔)',
       re.search(r'rm -f (live_quotes\.json live_index\.json|tick_flow\.json)', body) is not None)
    ok(f'⑦e {k} push retry 迴圈還在(離開共用 group 後唯一的防撞)',
       'git pull --rebase origin gh-pages' in body)
    ok(f'⑦f {k} timeout 要蓋得住整個窗口(≥270 分)',
       int(re.search(r'timeout-minutes: (\d+)', s).group(1)) >= 270,
       re.search(r'timeout-minutes: (\d+)', s).group(1))

# tick_flow 專屬:累積型 tick_hist 不可在切分支時弄丟
tb = srcs['tick_flow']
ok('⑧ tick_flow 的累積歷史每輪都要還原(⛔ 否則每一拍都從零開始)',
   '/tmp/th_keep.json' in tb and tb.count('/tmp/th_keep.json') >= 3, tb.count('/tmp/th_keep.json'))

# 兩支都必須是 cancel-in-progress: true(接手的排程要殺得掉還活著的主迴圈)
for k, s in srcs.items():
    ok(f'⑨ {k} cancel-in-progress: true(接手排程必須殺得掉主迴圈)',
       re.search(r'cancel-in-progress: true', s) is not None)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ INTRADAY_LOOP_PASS(全部通過)')
sys.exit(1 if fails else 0)
