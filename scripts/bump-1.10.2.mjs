import fs from 'node:fs';

const next = '1.10.2';
for (const f of ['package.json', 'manifest.json']) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.version = next;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
for (const f of ['agent/cli.mjs', 'agent/mcp.mjs']) {
    let t = fs.readFileSync(f, 'utf8');
    t = t.replace(/1\.10\.1/g, next);
    fs.writeFileSync(f, t);
}
const cl = 'CHANGELOG.md';
let t = fs.readFileSync(cl, 'utf8');
const entry = `## 1.10.2 — ${new Date().toISOString().slice(0, 10)}（商店包修正）

- 修正：\`npm run pack\` 產生的 store zip 會剝掉 manifest 的 \`key\`（與 \`update_url\`）。Chrome Web Store 上傳時會拒絕含 \`key\` 欄位的清單（「清单文件中不得包含 key 字段」）；本機載入未封裝所需的固定 ID 不受影響，完整包仍保留。
- 版本字串同步 1.10.2；單元與 e2e 全綠。

`;
t = t.replace('# Changelog\n\n', '# Changelog\n\n' + entry);
fs.writeFileSync(cl, t);
console.log('bumped to', next);
