// secret-scan.mjs — 打包前脫敏：發佈物裡不能有 API 金鑰、Bearer token 或私密狀態檔。
// 只回報「哪個檔、哪條規則」，不把金鑰內容寫進錯誤訊息或日誌。
import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
    { rule: 'openai_like_key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
    { rule: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
    { rule: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];
const SCANNED_EXTENSIONS = /\.(mjs|cjs|js|json|md|html|css|cs|ps1|cmd|bat|yml|yaml|txt|xml)$/i;
const FORBIDDEN_FILES = /^(?:session|history|agent-state|verified-audio|browser-download-state|download-log|host-build)\.json$|^page-.*\.json$|\.sqlite(?:-wal|-shm)?$|^\.env(?:\..*)?$/i;

export function scanText(text, { keys = [] } = {}) {
    const hits = [];
    for (const key of keys) {
        if (typeof key === 'string' && key.length >= 16 && text.includes(key)) hits.push({ rule: 'configured_key', sample: key.slice(0, 4) + '…' });
    }
    for (const { rule, pattern } of SECRET_PATTERNS) {
        for (const match of text.matchAll(pattern)) hits.push({ rule, sample: match[0].slice(0, 4) + '…' });
    }
    return hits;
}

/** 走一個目錄樹；回傳 [{ file, rule, sample }]，空陣列代表乾淨。 */
export function scanTree(root, { keys = [], maxBytes = 4 * 1024 * 1024 } = {}) {
    const hits = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) { hits.push({ file: full, rule: 'symlink' }); continue; }
            if (entry.isDirectory()) { walk(full); continue; }
            const relative = path.relative(root, full);
            if (FORBIDDEN_FILES.test(entry.name)) { hits.push({ file: relative, rule: 'private_state_file' }); continue; }
            if (!SCANNED_EXTENSIONS.test(entry.name)) continue;
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size > maxBytes) { hits.push({ file: relative, rule: 'oversized_text_file' }); continue; }
            let text;
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            for (const hit of scanText(text, { keys })) hits.push({ file: relative, ...hit });
        }
    };
    walk(root);
    return hits;
}

/** 丟出可讀的錯誤；只列檔名與規則，不列金鑰。 */
export function assertNoSecrets(root, options = {}) {
    const hits = scanTree(root, options);
    if (!hits.length) return { ok: true, scanned: root };
    const lines = hits.slice(0, 20).map((hit) => `- ${hit.file} → ${hit.rule}`).join('\n');
    const error = new Error(`打包中止：發佈物中含有需要脫敏的內容\n${lines}${hits.length > 20 ? `\n（其餘 ${hits.length - 20} 筆省略）` : ''}`);
    error.code = 'PACK_SECRETS_FOUND';
    error.hits = hits;
    throw error;
}
