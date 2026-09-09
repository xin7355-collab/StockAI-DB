// 🧪 sw.js 快取完整性守門測試(V71.7.7)
// 重現使用者回報的情境:手機裡存了一份「半截的」index.html → 每次開 App 都跳
// SyntaxError: Unexpected EOF,而且自己永遠好不了(SWR 每次都先吐快取)。
// 這支把 sw.js 的 fetch handler 放進假的 SW 環境跑,斷言:
//   ① 半截快取不可以被端出去,而且要被刪掉
//   ② 完整快取才可以秒回
//   ③ 半截的網路回應不可以被寫進快取(不然下次又中同一個坑)
import fs from 'fs';
const src = fs.readFileSync('/home/user/StockAI-DB/sw.js', 'utf8');

let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const WHOLE = '<html>' + 'x'.repeat(3000) + '</html>';
const HALF  = '<html>' + 'x'.repeat(3000);          // 寫到一半被中斷

function makeRes(body, ok_ = true) {
    return {
        ok: ok_,
        _body: body,
        clone() { return makeRes(body, ok_); },
        async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
    };
}

function run({ cachedBody, netBody, netFails }) {
    const store = new Map();
    if (cachedBody != null) store.set('doc', makeRes(cachedBody));
    const deleted = [];
    const put = [];
    const cacheObj = {
        put: async (_r, res) => { put.push(res._body); store.set('doc', res); },
        delete: async () => { deleted.push('doc'); store.delete('doc'); return true; },
    };
    const env = {
        CACHE_NAME_OUT: null,
        self: {
            location: { origin: 'https://x.test' },
            addEventListener: (t, fn) => { if (t === 'fetch') env._fetch = fn; },
            registration: { scope: 'https://x.test/' },
        },
        caches: {
            match: async () => store.get('doc'),
            open: async () => cacheObj,
            keys: async () => [],
            delete: async () => true,
        },
        clients: { claim: () => {} },
        fetch: async () => { if (netFails) throw new Error('offline'); return makeRes(netBody); },
        Response: class { constructor(b, i) { this._body = b; Object.assign(this, i); } },
        setTimeout, TextDecoder, Uint8Array, URL, Promise,
    };
    const fn = new Function(...Object.keys(env), src + '\n;return {h:__h};'
        .replace('__h', 'null'));
    // 直接執行 sw.js 取得 fetch handler
    const runner = new Function(...Object.keys(env), src + '\nreturn self.__fetchHandler;');
    env.self.addEventListener = (t, f) => { if (t === 'fetch') env.self.__fetchHandler = f; };
    const handler = runner(...Object.values(env));

    return new Promise(resolve => {
        const ev = {
            request: { method: 'GET', url: 'https://x.test/index.html', mode: 'navigate' },
            respondWith: p => resolve(Promise.resolve(p).then(async r => ({
                served: r && r._body, deleted, put,
            }))),
        };
        handler(ev);
    });
}

// ① 半截快取 → 不可端出去、要被刪、改用網路的完整版
let r = await run({ cachedBody: HALF, netBody: WHOLE });
ok('① 半截快取不被端出去', r.served === WHOLE, `served=${String(r.served).slice(0, 20)}…`);
ok('① 壞的那份有被刪掉(不然下次又中)', r.deleted.length === 1, JSON.stringify(r.deleted));

// ② 完整快取 → 秒回快取(不等網路)
r = await run({ cachedBody: WHOLE, netBody: WHOLE });
ok('② 完整快取照樣秒回', r.served === WHOLE);
ok('② 完整快取不會被誤刪', r.deleted.length === 0, JSON.stringify(r.deleted));

// ③ 網路回半截 → 不可寫進快取
r = await run({ cachedBody: null, netBody: HALF });
ok('③ 半截的網路回應不寫進快取', r.put.length === 0, JSON.stringify(r.put.map(x => x.length)));
ok('③ 但仍照樣端給使用者(總比白畫面好,下次開會重抓)', r.served === HALF);

// ④ 網路回完整 → 要寫進快取
r = await run({ cachedBody: null, netBody: WHOLE });
ok('④ 完整的網路回應有寫進快取', r.put.length === 1 && r.put[0] === WHOLE);

// ⑤ 快取半截 + 網路也掛掉 → 不可白畫面,退回舊快取(壞總比沒有好,至少不是 503)
r = await run({ cachedBody: HALF, netFails: true });
ok('⑤ 網路掛掉時仍有東西可端(不吐 503 空白)', r.served === HALF || r.served === 'offline', String(r.served).slice(0, 20));

console.log();
if (fails.length) { console.log('❌ SWCACHE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ SWCACHE_TEST_PASS');
