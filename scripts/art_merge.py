#!/usr/bin/env python3
"""🧩 daily_miner 20 個採礦節點的產物怎麼收、怎麼合併(2026-10-24 #647 實例)。

🚨 #647 發生的事(兩個病,同一個根):
   每個採礦節點開頭都把整個 data 分支還原到 data/,結束時把**整個 data/** 上傳(只修剪掉別批的股票)。
   → 每一包 artifact 都帶著一份「開跑那一刻」的 confcall.json / screener.json / playbook_edge.json…
   ① 🧟 改回舊版:節點開跑之後 playbook_scan 推了新的 playbook_edge.json;部署時「鋪底層」拿到的是新的,
      但 artifact 疊上去的是舊的 →「🛟 撿回」看「本機跟底層不同」就當成本輪改的 → 把新的蓋回舊的。
   ② 💥 寫壞:節點不是同一秒開跑(機器要排隊),有的拿到舊版、有的拿到新版;
      download-artifact `merge-multiple: true` 一次解好幾包到**同一個資料夾** → 同一個檔被兩包同時寫
      → 「短的那份完整 JSON + 長的那份多出來的尾巴」(confcall.json / confcall_digest.json)、
      或兩份交錯成亂碼(screener.json 第 988,772 個位元組不是 UTF-8)。全綠、零訊息。
⭐ 修法(三段,這支一份):
   snap  節點還原完當下,記下 data/ 每個檔的指紋
   trim  上傳前把「跟還原時一模一樣」的檔拿掉 → artifact 只帶本批真的改過 / 新產的檔
         (部署那邊用最新的 data 分支當底層,⛔ 不需要節點再帶一份舊的)
   merge 部署時一包一包依序寫(節點 0 最後寫,它負責共用的檔);同一個檔兩包都有而且內容不同 → 印出來;
         artifact 裡壞掉的 JSON ⛔ 不寫進去
   guard 部署前把 data/ 每個 .json 解析一次;壞的換回部署前那份(data 分支)/ 遠端最新那份,都救不回才原樣留著
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys


def _md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def _walk(d):
    for root, _, files in os.walk(d):
        for fn in files:
            yield os.path.join(root, fn)


def _json_ok(b):
    try:
        json.loads(b.decode('utf-8'))
        return True, ''
    except Exception as e:
        return False, f'{type(e).__name__}: {str(e)[:70]}'


def snap(d, out):
    m = {}
    if os.path.isdir(d):
        for p in _walk(d):
            try:
                m[os.path.normpath(p)] = _md5(p)
            except OSError:
                pass
    with open(out, 'w') as f:
        json.dump(m, f)
    print(f'🧩 還原時的指紋:{len(m)} 檔 → {out}')
    return 0


def trim(d, snapfile):
    try:
        with open(snapfile) as f:
            base = json.load(f)
    except Exception as e:
        print(f'⚠️ 讀不到還原時的指紋({e})→ 不修剪,整包照舊上傳')
        return 0
    if not base:
        print('⚠️ 還原時的指紋是空的(沒有還原到 data 分支)→ 不修剪')
        return 0
    same = changed = new = 0
    for p in list(_walk(d)) if os.path.isdir(d) else []:
        k = os.path.normpath(p)
        b = base.get(k)
        if b is None:
            new += 1
            continue
        try:
            if _md5(p) == b:
                os.remove(p)
                same += 1
            else:
                changed += 1
        except OSError:
            pass
    print(f'🧹 跟還原時一模一樣的 {same} 檔不上傳(部署那邊用最新的 data 分支當底層)'
          f' ・本批改過 {changed} 檔 ・新產的 {new} 檔')
    return 0


def _batch_no(name):
    m = re.search(r'(\d+)$', name)
    return int(m.group(1)) if m else -1


def merge(art_root, dest):
    if not os.path.isdir(art_root):
        print(f'❌ 找不到 {art_root}(artifact 沒下載到)→ 只有底層')
        return 0
    arts = sorted((x for x in os.listdir(art_root) if os.path.isdir(os.path.join(art_root, x))),
                  key=_batch_no, reverse=True)          # 19 → 0:節點 0 最後寫(共用的檔它負責)
    seen = {}                                          # rel → (md5, 哪一包)
    conflicts, bad = [], []
    n_files = 0
    per = []
    for a in arts:
        root = os.path.join(art_root, a)
        cnt = 0
        for p in _walk(root):
            rel = os.path.relpath(p, root)
            with open(p, 'rb') as f:
                b = f.read()
            if rel.endswith('.json'):
                okj, why = _json_ok(b)
                if not okj:
                    bad.append((rel, a, why))
                    continue
            h = hashlib.md5(b).hexdigest()
            if rel in seen and seen[rel][0] != h:
                conflicts.append((rel, seen[rel][1], a))
            seen[rel] = (h, a)
            out = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
            tmp = out + '.art_tmp'
            with open(tmp, 'wb') as f:
                f.write(b)
            os.replace(tmp, out)                       # ⭐ 先寫暫存檔再換名:⛔ 不會留下寫一半的檔
            cnt += 1
        n_files += cnt
        per.append(f'{a.replace("mine-data-", "#")}:{cnt}')
    print(f'🧩 依序合併 {len(arts)} 包 → {n_files} 個檔(' + ' '.join(per) + ')')
    if conflicts:
        print(f'⚠️ {len(conflicts)} 個檔被兩包以上改過、內容不同 → 以編號小的那包為準(節點 0 最優先):')
        for rel, x, y in conflicts[:20]:
            print(f'   ≠ {rel}({x} 被 {y} 蓋過)')
    if bad:
        print(f'❌ {len(bad)} 個 artifact 裡的 JSON 壞了 → ⛔ 不寫進去(保留底層那份):')
        for rel, a, why in bad[:20]:
            print(f'   ❌ {rel}({a}){why}')
    return 0


def _git_show(ref, rel):
    if not ref:
        return None
    try:
        r = subprocess.run(['git', 'show', f'{ref}:{rel}'], capture_output=True, timeout=60)
        return r.stdout if r.returncode == 0 and r.stdout else None
    except Exception:
        return None


def guard(paths, base_ref=None, alt_dir=None):
    total = 0
    broken = []
    for d in paths:
        files = [d] if os.path.isfile(d) else (list(_walk(d)) if os.path.isdir(d) else [])
        for p in files:
            if not p.endswith('.json'):
                continue
            total += 1
            try:
                with open(p, 'rb') as f:
                    b = f.read()
            except OSError as e:
                broken.append((p, f'讀不到 {e}'))
                continue
            okj, why = _json_ok(b)
            if not okj:
                broken.append((p, why))
    fixed = lost = 0
    for p, why in broken:
        rel = os.path.normpath(p)
        cands = [('部署前那份(data 分支)', _git_show(base_ref, rel))]
        if alt_dir:
            ap = os.path.join(alt_dir, rel)
            try:
                with open(ap, 'rb') as f:
                    cands.append(('遠端最新那份', f.read()))
            except OSError:
                pass
        for label, b in cands:
            if b and _json_ok(b)[0]:
                with open(p + '.guard_tmp', 'wb') as f:
                    f.write(b)
                os.replace(p + '.guard_tmp', p)
                print(f'❌→✅ {rel} 壞了({why})→ 換回{label}')
                fixed += 1
                break
        else:
            print(f'❌ {rel} 壞了({why}),而且找不到讀得出來的那份 → 原樣保留(下一個產出它的流程要重寫)')
            lost += 1
    print(f'🩺 部署前 JSON 體檢:{total} 檔 ・壞 {len(broken)} 檔 ・換回 {fixed} 檔 ・救不回 {lost} 檔')
    return 0


# ───────────────────────── selftest ─────────────────────────
def _selftest():
    import tempfile
    res = []
    ok = lambda n, c, extra='': res.append((n, bool(c), extra))
    cwd0 = os.getcwd()
    tmp = tempfile.mkdtemp(prefix='artm_')
    W = lambda p, s: (os.makedirs(os.path.dirname(p) or '.', exist_ok=True), open(p, 'w', encoding='utf-8').write(s))
    R = lambda p: open(p, encoding='utf-8').read()
    try:
        os.chdir(tmp)
        import io, contextlib

        # ① snap + trim:沒動的拿掉、改過的留著、新的留著
        os.makedirs('b1/data/chips', exist_ok=True)
        os.chdir('b1')
        W('data/A.json', '{"v":1}'); W('data/B.json', '{"v":1}'); W('data/chips/C.json', '{"v":1}')
        with contextlib.redirect_stdout(io.StringIO()):
            snap('data', '../snap1.json')
        W('data/B.json', '{"v":2}'); W('data/N.json', '{"new":1}')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            trim('data', '../snap1.json')
        ok('① 沒動的 A、chips/C 拿掉', not os.path.exists('data/A.json') and not os.path.exists('data/chips/C.json'))
        ok('① 改過的 B 留著、新產的 N 留著', os.path.exists('data/B.json') and os.path.exists('data/N.json'))
        ok('① 印出幾檔沒上傳', '一模一樣的 2 檔不上傳' in buf.getvalue(), buf.getvalue())
        os.chdir(tmp)
        # ①b 指紋檔不在 → 不修剪(⛔ 不可把整包刪光)
        os.makedirs('b2/data', exist_ok=True); os.chdir('b2'); W('data/A.json', '{}')
        with contextlib.redirect_stdout(io.StringIO()):
            trim('data', '../nope.json')
        ok('①b 沒有指紋 → 一個都不刪', os.path.exists('data/A.json'))
        os.chdir(tmp)

        # ② merge:編號小的贏(節點 0 最後寫)+ 印出衝突;壞 JSON ⛔ 寫進去
        for b, v in ((0, 'zero'), (3, 'three'), (12, 'twelve')):
            W(f'art/mine-data-{b}/data/S.json', f'{{"v":"{v}"}}')
        W('art/mine-data-3/data/only3.json', '{"x":3}')
        W('art/mine-data-12/data/bad.json', '{"x":1}tail"}')
        W('dest/data/bad.json', '{"keep":"base"}')
        W('art/mine-data-0/futures_cache.json', '{"f":1}')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            merge('art', 'dest')
        o = buf.getvalue()
        ok('② 同一個檔三包都有 → 節點 0 的贏', '"zero"' in R('dest/data/S.json'), R('dest/data/S.json'))
        ok('② 衝突要印出來(2 次覆蓋)', '2 個檔被兩包以上改過' in o, o)
        ok('② 只有一包有的照寫', os.path.exists('dest/data/only3.json'))
        ok('② artifact 裡壞掉的 JSON ⛔ 寫進去(底層那份留著)', '"base"' in R('dest/data/bad.json'), R('dest/data/bad.json'))
        ok('② 根目錄的快取檔也收', os.path.exists('dest/futures_cache.json'))
        ok('② 不留暫存檔', not any(x.endswith('.art_tmp') for x in _walk('dest')))

        # ③ guard:壞的換回部署前那份(真的 git repo)/ 遠端那份 / 救不回原樣留著
        os.makedirs('g/data', exist_ok=True); os.chdir('g')
        subprocess.run('git init -q -b data . && git config user.email t@t && git config user.name t', shell=True, check=True)
        W('data/X.json', '{"good":"base"}'); W('data/Y.json', '{"y":1}'); W('data/Z.json', '{"z":1}')
        subprocess.run('git add -A && git commit -qm base', shell=True, check=True)
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        W('data/X.json', '{"good":"new"}方向實測"}')           # #647 的形狀
        W('data/Y.json', '{"y":1')                             # 截斷:底層也沒有好的? 底層有 → 換回
        W('data/W.json', '{"w":')                              # 新檔:底層沒有、遠端有
        W('../relay/data/W.json', '{"w":"remote"}')
        W('data/Q.json', '{"q":')                              # 哪裡都沒有 → 原樣
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            guard(['data'], base_ref=sha, alt_dir='../relay')
        o = buf.getvalue()
        ok('③ X(完整 JSON + 尾巴)→ 換回部署前那份', R('data/X.json') == '{"good":"base"}', R('data/X.json'))
        ok('③ Y(截斷)→ 換回部署前那份', R('data/Y.json') == '{"y":1}', R('data/Y.json'))
        ok('③ W(底層沒有)→ 換成遠端那份', R('data/W.json') == '{"w":"remote"}', R('data/W.json'))
        ok('③ Q(哪裡都沒有好的)→ 原樣保留、印 ❌', R('data/Q.json') == '{"q":' and '救不回 1 檔' in o, o)
        ok('③ 好的 Z ⛔ 動', R('data/Z.json') == '{"z":1}')
        ok('③ 總結一行', '壞 4 檔 ・換回 3 檔 ・救不回 1 檔' in o, o)
        os.chdir(tmp)

        # ④ ⭐⭐ 決定性對照:重現 #647 的「改回舊版」
        #    節點還原時 X=old → 別支在節點跑的時候推了 X=new → 部署鋪底層拿到 new → 疊 artifact
        def run_deploy(use_trim):
            d = f'case_{int(use_trim)}'
            os.makedirs(f'{d}/node/data', exist_ok=True)
            W(f'{d}/node/data/X.json', '{"v":"old"}')          # 節點開跑時還原到的
            W(f'{d}/node/data/2330.json', '{"k":"before"}')
            here = os.getcwd(); os.chdir(f'{d}/node')
            with contextlib.redirect_stdout(io.StringIO()):
                snap('data', '../snap.json')
            W('data/2330.json', '{"k":"mined-today"}')        # 本批真的採到的
            if use_trim:
                with contextlib.redirect_stdout(io.StringIO()):
                    trim('data', '../snap.json')
            os.chdir(here)
            shutil.copytree(f'{d}/node', f'{d}/art/mine-data-0')
            W(f'{d}/ws/data/X.json', '{"v":"new-by-playbook_scan"}')   # 部署鋪底層(data 分支最新)
            W(f'{d}/ws/data/2330.json', '{"k":"before"}')
            with contextlib.redirect_stdout(io.StringIO()):
                merge(f'{d}/art', f'{d}/ws')
            return R(f'{d}/ws/data/X.json'), R(f'{d}/ws/data/2330.json')
        x_old, k_old = run_deploy(False)
        x_new, k_new = run_deploy(True)
        ok('④ 決定性對照:舊做法(整包上傳)→ X 被改回 old(重現 #647)', '"old"' in x_old, x_old)
        ok('④ ⭐ 新做法(只上傳改過的)→ X 留著別支剛推的新版', 'new-by-playbook_scan' in x_new, x_new)
        ok('④ 兩種做法本批採到的 2330 都要進去', 'mined-today' in k_old and 'mined-today' in k_new, f'{k_old} {k_new}')
    finally:
        os.chdir(cwd0)
        shutil.rmtree(tmp, ignore_errors=True)
    bad = [r for r in res if not r[1]]
    for n, c, extra in res:
        print(('✅ ' if c else '❌ ') + n + ('' if c else f'  ← {str(extra)[:200]}'))
    print('✅ art_merge selftest 全過' if not bad else f'❌ art_merge selftest {len(bad)} 條沒過')
    return 1 if bad else 0


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    cmd = argv[0]
    if cmd == '--selftest':
        return _selftest()
    if cmd == 'snap' and len(argv) == 3:
        return snap(argv[1], argv[2])
    if cmd == 'trim' and len(argv) == 3:
        return trim(argv[1], argv[2])
    if cmd == 'merge' and len(argv) == 3:
        return merge(argv[1], argv[2])
    if cmd == 'guard':
        paths, base_ref, alt = [], None, None
        i = 1
        while i < len(argv):
            if argv[i] == '--base-ref' and i + 1 < len(argv):
                base_ref = argv[i + 1].strip() or None; i += 2
            elif argv[i] == '--alt-dir' and i + 1 < len(argv):
                alt = argv[i + 1]; i += 2
            else:
                paths.append(argv[i]); i += 1
        return guard(paths or ['data'], base_ref, alt)
    print(f'❌ 看不懂的參數:{argv}')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
