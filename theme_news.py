#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔥 夜間情報採礦(theme_news):兩個輸出、各自守門,零金鑰零 AI

A. data/theme_news.json — 題材脈動:對 ~25 個題材關鍵字抓 Google News RSS(公開、零金鑰),
   算 3 日新聞熱度 + 最新標題。守門:至少 THEME_MIN_HIT 個題材有新聞才寫檔(否則保留舊檔)。
B. data/biz_profile.json — 公司本業:TWSE/TPEX OpenAPI 官方「公司基本資料」的主要經營業務,
   一次抓全市場。守門:至少 BIZ_MIN_HITS 家公司才寫檔。
   ⚠️ 實證教訓(V54.9):部分 TWSE openapi 資料集對 GitHub IP 回空 → 欄位自動偵測 + 印 debug
   到 stdout(免下載 artifact 校準),抓不到就守門跳過,絕不寫空檔蓋掉舊資料。

exit code:0=至少一個輸出成功;2=兩個都失敗(workflow 不部署)。
"""
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

DATA_DIR = Path('data')
THEME_OUT = DATA_DIR / 'theme_news.json'
BIZ_OUT = DATA_DIR / 'biz_profile.json'

TPE = timezone(timedelta(hours=8))
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'}

# 題材關鍵字 — ⚠️ 連動:與 index.html `_potentialHotThemes` 保持同步(前端顯示以這份輸出為準)
THEMES = ['AI', 'CoWoS', '矽光子', '記憶體', 'HBM', '重電', '軍工', '低軌衛星', '散熱',
          'ABF', 'PCB', '機器人', '矽智財', '光通訊', '先進封裝', '半導體', '電動車',
          '伺服器', '5G', '面板', '被動元件', '矽晶圓', 'DRAM', '航運', '生技']

THEME_MIN_HIT = int(os.getenv('THEME_MIN_HIT', '5'))     # 至少 N 個題材抓到新聞才算成功
BIZ_MIN_HITS = int(os.getenv('BIZ_MIN_HITS', '300'))     # 至少 N 家公司本業才算成功
RSS_SLEEP = float(os.getenv('RSS_SLEEP', '1.2'))         # RSS 節流秒數


def _now_iso():
    return datetime.now(TPE).strftime('%Y-%m-%d %H:%M')


# ── A. 題材脈動(Google News RSS) ────────────────────────────────────────────
def fetch_theme_rss(kw):
    """單一題材 RSS → {'kw', 'heat'(3日則數), 'items':[{t,src,d,u}] 最新3則};失敗回 None。"""
    url = ('https://news.google.com/rss/search?q=' + requests.utils.quote(kw)
           + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant')
    try:
        r = requests.get(url, headers=UA, timeout=15)
        if r.status_code != 200 or not r.content:
            print(f'  ✗ {kw}: HTTP {r.status_code}')
            return None
        root = ET.fromstring(r.content)
        now = datetime.now(timezone.utc)
        heat = 0
        items = []
        for it in root.iter('item'):
            title = (it.findtext('title') or '').strip()
            link = (it.findtext('link') or '').strip()
            pub = (it.findtext('pubDate') or '').strip()
            src_el = it.find('source')
            src = (src_el.text or '').strip() if src_el is not None else ''
            if not title:
                continue
            dt = None
            try:
                dt = parsedate_to_datetime(pub)
            except Exception:
                pass
            fresh = dt is not None and (now - dt) <= timedelta(days=3)
            if fresh:
                heat += 1
            if len(items) < 3:
                # Google News 標題常帶「 - 媒體名」尾巴,砍掉省空間(來源另存)
                t = re.sub(r'\s+-\s+[^-]{1,30}$', '', title)[:80]
                items.append({'t': t, 'src': src[:20],
                              'd': dt.astimezone(TPE).strftime('%m/%d') if dt else '',
                              'u': link[:300]})
        return {'kw': kw, 'heat': heat, 'items': items}
    except Exception as e:
        print(f'  ✗ {kw}: {type(e).__name__} {e}')
        return None


def build_theme_news():
    out = []
    for kw in THEMES:
        r = fetch_theme_rss(kw)
        if r is not None:
            out.append(r)
            print(f'  ✓ {kw}: 3日 {r["heat"]} 則 / 樣本 {len(r["items"])}')
        time.sleep(RSS_SLEEP)
    hit = sum(1 for t in out if t['items'])
    if hit < THEME_MIN_HIT:
        print(f'❌ 題材脈動:只有 {hit} 個題材抓到新聞(< {THEME_MIN_HIT}),疑似被擋 → 不寫檔,保留舊檔')
        return False
    out.sort(key=lambda t: -t['heat'])
    DATA_DIR.mkdir(exist_ok=True)
    THEME_OUT.write_text(json.dumps({'updated': _now_iso(), 'themes': out},
                                    ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'✅ theme_news.json:{hit}/{len(THEMES)} 個題材有新聞,熱度第一「{out[0]["kw"]}」{out[0]["heat"]} 則')
    return True


# ── B. 公司本業(TWSE/TPEX OpenAPI 官方基本資料) ────────────────────────────
BIZ_SOURCES = [
    ('TWSE上市', 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L'),
    ('TPEX上櫃', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O'),
]
_BIZ_FIELD_PAT = ('主要經營業務', '營業項目', '所營事業', '主要業務',
                  'MainBusiness', 'Business')   # run#2 實測:TPEX openapi 欄位是英文
_SYM_FIELD_PAT = ('公司代號', 'SecuritiesCompanyCode', 'CompanyCode', 'Code')


def _detect_field(sample, patterns):
    """在官方 JSON 的 keys 裡自動找欄位(對 GitHub IP 各資料集欄名不一的防禦)。"""
    for k in sample.keys():
        for p in patterns:
            if p in k:
                return k
    return None


def build_biz_profile():
    profiles = {}
    for label, url in BIZ_SOURCES:
        try:
            r = requests.get(url, headers={**UA, 'Accept': 'application/json'}, timeout=30)
            print(f'  [{label}] HTTP {r.status_code} / bytes {len(r.content)}')
            if r.status_code != 200:
                continue
            arr = r.json()
            if not isinstance(arr, list) or not arr:
                print(f'  [{label}] 回空或非陣列(GitHub IP 可能被擋) → 跳過')
                continue
            biz_k = _detect_field(arr[0], _BIZ_FIELD_PAT)
            sym_k = _detect_field(arr[0], _SYM_FIELD_PAT)
            print(f'  [{label}] 欄位偵測:sym={sym_k} biz={biz_k} / 全部 keys={list(arr[0].keys())}')
            if not biz_k or not sym_k:
                continue
            n0 = len(profiles)
            for row in arr:
                sym = str(row.get(sym_k, '')).strip()
                biz = str(row.get(biz_k, '')).strip().replace('\n', ' ').replace('\r', '')
                if sym and biz and (sym.isdigit() and 4 <= len(sym) <= 6):
                    profiles[sym] = {'biz': biz[:120]}
            print(f'  [{label}] 收 {len(profiles) - n0} 家')
        except Exception as e:
            print(f'  [{label}] ✗ {type(e).__name__} {e}')
    if len(profiles) < BIZ_MIN_HITS:
        print(f'❌ 公司本業:只收到 {len(profiles)} 家(< {BIZ_MIN_HITS})→ 不寫檔,保留舊檔')
        return False
    DATA_DIR.mkdir(exist_ok=True)
    BIZ_OUT.write_text(json.dumps({'updated': _now_iso(), 'profiles': profiles},
                                  ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'✅ biz_profile.json:{len(profiles)} 家公司本業')
    return True


def main():
    print('🔥 夜間情報採礦啟動', _now_iso())
    ok_a = build_theme_news()
    ok_b = build_biz_profile()
    if not ok_a and not ok_b:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
