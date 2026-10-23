#!/usr/bin/env python3
"""🧟 daily_miner 這一輪是不是已經被「新的一輪」取代了?(2026-10-23)

為什麼要問:
  daily_miner 的 workflow 層級 concurrency 是 `cancel-in-progress: true` —— 新的一輪一來,
  舊的那輪就被取消(V16.1:省配額、避免不同版本同寫 gh-pages)。
  但部署 job 刻意寫 `if: ${{ always() }}`(某個採礦節點跑滿 90 分被砍時,已採到的仍要部署),
  而 always() 連「整輪被新的一輪取代」也照跑:
    10/23 #640:採礦 21 個 job 12:53~12:55 全部被 #641 取消,部署 job 照樣從 12:55 跑到 13:21
    (26 分,一直佔著共用部署鎖 gh-pages-push,而且用的是舊版程式寫 gh-pages)
    → 新的那輪 #641 只能排隊,13:21 才開始(workflow 層級 concurrency:舊的那輪沒結束就不開始)。

判斷(只做這一件事):
  同一支 workflow、同一個分支,有編號比這輪大、而且還沒結束的 run → 這輪被取代了 → go=0(不部署,
  新的那輪會部署)。否則 go=1(照常部署)。
  ⛔ 問不到(沒有金鑰 / 沒權限 / 網路錯 / 格式不對)一律 go=1 —— 寧可多部署一次(= 以前的行為),
     也不可讓正常那輪不部署。
  ⛔ 使用者自己按「Cancel workflow」(沒有新的一輪)→ 照常部署已採到的部分(CLAUDE.md V16.1 寫的「完全無風險」照舊)。

用法(workflow 裡):python3 scripts/miner_superseded.py daily_miner.yml
  讀環境變數 GITHUB_REPOSITORY / GITHUB_RUN_NUMBER / GITHUB_RUN_ID / GITHUB_REF_NAME / GH_TOKEN(或 GITHUB_TOKEN),
  把 `go=0|1` 寫進 $GITHUB_OUTPUT。
  測試:SUPERSEDE_RUNS_JSON=<檔案> 用假的 run 清單(⛔ 不打網路);--selftest 跑內建案例。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.github.com'


def decide(runs, my_number, branch, my_id=None):
    """回 (go, 一句說明)。runs = API 的 workflow_runs 陣列(新到舊、舊到新都可以)。

    被取代 = 同分支、run_number 比這輪大、status 不是 completed。
    ⛔ 已經結束的新 run 不算(例:新的那輪排隊時被使用者手動取消 → 沒有人會部署 → 這輪照常部署)。
    """
    try:
        me = int(my_number)
    except (TypeError, ValueError):
        return 1, f'⚠️ 不知道這輪的編號({my_number!r})→ 照常部署'
    if not isinstance(runs, list):
        return 1, '⚠️ run 清單格式不對 → 照常部署'
    newer = []
    for r in runs:
        if not isinstance(r, dict):
            continue
        if my_id is not None and str(r.get('id')) == str(my_id):
            continue
        if branch and r.get('head_branch') != branch:
            continue
        try:
            n = int(r.get('run_number'))
        except (TypeError, ValueError):
            continue
        if n > me and r.get('status') != 'completed':
            newer.append((n, r.get('event') or '?', r.get('status') or '?'))
    if newer:
        newer.sort()
        txt = '、'.join(f'#{n}({ev},{st})' for n, ev, st in newer)
        return 0, f'🧟 這輪 #{me} 已經被 {txt} 取代 → ⛔ 不部署(新的那輪會部署;部署鎖不佔)'
    return 1, f'✅ 沒有比 #{me} 新、還沒結束的 run → 照常部署'


def fetch_runs(repo, workflow, branch, token, get=None, tries=3):
    """問 GitHub 同一支 workflow、同一個分支最近 30 筆 run。拿不到回 (None, 原因)。

    ⛔ 不無限重試:最多 3 次、間隔 2 / 4 秒(指數退避)。
    """
    if not repo or not workflow:
        return None, '沒有 repo / workflow 名稱'
    if not token:
        return None, '沒有 GH_TOKEN'
    url = f'{API}/repos/{repo}/actions/workflows/{workflow}/runs?per_page=30'
    if branch:
        url += f'&branch={urllib.parse.quote(branch)}'
    hdr = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
           'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stockai-miner-superseded'}
    last = ''
    for k in range(tries):
        try:
            if get is not None:
                body = get(url, hdr)
            else:
                req = urllib.request.Request(url, headers=hdr)
                with urllib.request.urlopen(req, timeout=15) as resp:
                    body = resp.read().decode('utf-8', 'replace')
            j = json.loads(body)
            runs = j.get('workflow_runs') if isinstance(j, dict) else None
            if isinstance(runs, list):
                return runs, ''
            last = f'回應沒有 workflow_runs(開頭 {str(body)[:80]!r})'
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code}'
            if e.code in (401, 403, 404):
                break          # 權限 / 路徑問題,重試也一樣
        except Exception as e:  # 網路 / 解析
            last = f'{type(e).__name__}: {str(e)[:80]}'
        if k + 1 < tries:
            time.sleep(2 ** (k + 1))
    return None, last


def main(argv):
    if '--selftest' in argv:
        return selftest()
    workflow = argv[1] if len(argv) > 1 else ''
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    me = os.environ.get('GITHUB_RUN_NUMBER', '')
    my_id = os.environ.get('GITHUB_RUN_ID') or None
    branch = os.environ.get('GITHUB_REF_NAME', '')
    token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN') or ''
    fake = os.environ.get('SUPERSEDE_RUNS_JSON', '')
    if fake:
        try:
            with open(fake, encoding='utf-8') as fh:
                j = json.load(fh)
            runs, why = (j.get('workflow_runs') if isinstance(j, dict) else j), ''
        except Exception as e:
            runs, why = None, f'讀不到假清單 {fake}: {e}'
    else:
        runs, why = fetch_runs(repo, workflow, branch, token)
    if runs is None:
        go, msg = 1, f'⚠️ 問不到 run 清單({why})→ 照常部署'
    else:
        go, msg = decide(runs, me, branch, my_id)
    print(msg, flush=True)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a', encoding='utf-8') as fh:
            fh.write(f'go={go}\n')
    else:
        print(f'go={go}')
    return 0           # ⛔ 永遠 exit 0:這一步出錯也不可擋到部署(fail-open)


def selftest():
    bad = 0

    def chk(name, cond):
        nonlocal bad
        print(('✅ ' if cond else '❌ ') + name)
        bad += 0 if cond else 1

    def R(n, st, br='main', ev='push', i=None):
        return {'id': i or 1000 + n, 'run_number': n, 'status': st, 'head_branch': br, 'event': ev}

    # ① 10/23 實例:#640 跑到一半,#641(push)來了還在排隊 → 不部署
    g, m = decide([R(641, 'queued'), R(640, 'in_progress'), R(639, 'completed')], 640, 'main', 1640)
    chk('① #641 排隊中 → #640 不部署', g == 0 and '#641' in m)
    # ② 沒有比較新的 → 照常部署(⭐ 決定性對照:同一份清單換成 #641 自己問)
    g, _ = decide([R(641, 'in_progress'), R(640, 'completed'), R(639, 'completed')], 641, 'main', 1641)
    chk('② 最新那輪自己 → 照常部署', g == 1)
    # ③ 新的那輪已經結束(排隊時被手動取消)→ 不算取代
    g, _ = decide([R(642, 'completed'), R(641, 'in_progress')], 641, 'main')
    chk('③ 新的那輪已結束 → 照常部署', g == 1)
    # ④ 別的分支的新 run 不算(concurrency group 是分支層級)
    g, _ = decide([R(642, 'queued', br='claude/x'), R(641, 'in_progress')], 641, 'main')
    chk('④ 別的分支的新 run → 照常部署', g == 1)
    # ⑤ 排程那輪取代 push 那輪也算
    g, m = decide([R(642, 'waiting', ev='schedule'), R(641, 'in_progress')], 641, 'main')
    chk('⑤ 排程那輪等著 → 不部署', g == 0 and 'schedule' in m)
    # ⑥ 舊的、編號比較小的不算
    g, _ = decide([R(640, 'queued'), R(641, 'in_progress')], 641, 'main')
    chk('⑥ 編號比較小的 → 照常部署', g == 1)
    # ⑦ 問不到 / 格式不對 → 照常部署(fail-open)
    chk('⑦a 清單不是陣列 → 照常部署', decide({'x': 1}, 641, 'main')[0] == 1)
    chk('⑦b 不知道自己的編號 → 照常部署', decide([R(642, 'queued')], '', 'main')[0] == 1)
    calls = []

    def boom(url, hdr):
        calls.append(url)
        raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
    runs, why = fetch_runs('o/r', 'daily_miner.yml', 'main', 'tok', get=boom)
    chk('⑦c 403 → 拿不到、只問一次(權限問題不重試)', runs is None and 'HTTP 403' in why and len(calls) == 1)
    chk('⑦d 沒有金鑰 → 不打網路', fetch_runs('o/r', 'daily_miner.yml', 'main', '', get=boom)[0] is None and len(calls) == 1)

    def okget(url, hdr):
        calls.append(url)
        assert hdr['Authorization'] == 'Bearer tok'
        return json.dumps({'workflow_runs': [R(5, 'queued')]})
    runs, _ = fetch_runs('o/r', 'daily_miner.yml', 'main', 'tok', get=okget)
    chk('⑦e 網址帶 workflow 與分支、回得到清單', runs and 'workflows/daily_miner.yml/runs' in calls[-1] and 'branch=main' in calls[-1])
    print(f'selftest {"OK" if not bad else f"FAIL {bad}"}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
