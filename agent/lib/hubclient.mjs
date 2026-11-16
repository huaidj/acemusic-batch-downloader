// hubclient.mjs — 連本機 Agent Hub 的 HTTP 客戶端。
// 不用全域 fetch：Node 的 fetch（undici）在 Windows 對 localhost 每次請求有 ~15 ms 的底（計時器粒度），
// node:http＋keep-alive 實測 0.3–1 ms。閒置 socket 會 unref，CLI 用完可正常結束。
import http from 'node:http';

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
agent.on('free', (socket) => socket.unref());

export const HUB_URL = process.env.ACE_HUB_URL || 'http://127.0.0.1:8788';

const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

/** 僅當這一次請求已證實未建立連線時，寫入才可改走本機；逾時／reset／HTTP 錯誤都不能重送。 */
export function canFallbackHubWrite(error) {
    return error?.hubSafeToFallback === true;
}

/** 呼叫 Hub；回傳 { status, data }。連線失敗或逾時丟錯。 */
export function hubRequest(pathname, { method = 'GET', body, timeoutMs = 2000, base = HUB_URL } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(pathname, base);
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        let connected = false;
        let responseReceived = false;
        const fail = (error) => {
            error.hubResponseReceived = responseReceived;
            error.hubSafeToFallback = !connected && !responseReceived && CONNECT_FAILURES.has(error.code);
            error.hubPhase = responseReceived ? 'response' : connected ? 'submitted' : 'connecting';
            reject(error);
        };
        const req = http.request(
            {
                host: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method,
                agent,
                headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
            },
            (res) => {
                responseReceived = true;
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    } catch {
                        data = null;
                    }
                    resolve({ status: res.statusCode || 0, data });
                });
                res.on('error', fail);
                res.on('aborted', () => fail(Object.assign(new Error('hub response aborted'), { code: 'ECONNRESET' })));
            },
        );
        req.on('socket', (socket) => {
            if (!socket.connecting) connected = true;
            else socket.once('connect', () => { connected = true; });
        });
        req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('hub timeout ' + timeoutMs + 'ms'), { code: 'HUB_TIMEOUT' })));
        req.on('error', fail);
        if (payload) req.write(payload);
        req.end();
    });
}

/** 成功（2xx 且 ok !== false）才回 data，否則丟錯（訊息取 Hub 的 error） */
export async function hubJson(pathname, opts = {}) {
    const { status, data } = await hubRequest(pathname, opts);
    if (status < 200 || status >= 300 || !data || data.ok === false) {
        const detail = data?.error;
        const message = typeof detail === 'string' ? detail : detail?.message || 'HTTP ' + status;
        throw Object.assign(new Error(message), { code: 'HUB_HTTP_ERROR', status, hubResponseReceived: true, hubSafeToFallback: false, hubPhase: 'response', ...(data?.jobId ? { jobId: data.jobId } : {}) });
    }
    return data;
}
