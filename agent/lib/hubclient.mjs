// hubclient.mjs — 連本機 Agent Hub 的 HTTP 客戶端。
// 不用全域 fetch：Node 的 fetch（undici）在 Windows 對 localhost 每次請求有 ~15 ms 的底（計時器粒度），
// node:http＋keep-alive 實測 0.3–1 ms。閒置 socket 會 unref，CLI 用完可正常結束。
import http from 'node:http';

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
agent.on('free', (socket) => socket.unref());

export const HUB_URL = process.env.ACE_HUB_URL || 'http://127.0.0.1:8788';

/** 呼叫 Hub；回傳 { status, data }。連線失敗或逾時丟錯。 */
export function hubRequest(pathname, { method = 'GET', body, timeoutMs = 2000, base = HUB_URL } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(pathname, base);
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
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
                res.on('error', reject);
            },
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error('hub timeout ' + timeoutMs + 'ms')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** 成功（2xx 且 ok !== false）才回 data，否則丟錯（訊息取 Hub 的 error） */
export async function hubJson(pathname, opts = {}) {
    const { status, data } = await hubRequest(pathname, opts);
    if (status < 200 || status >= 300 || !data || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + status);
    return data;
}
