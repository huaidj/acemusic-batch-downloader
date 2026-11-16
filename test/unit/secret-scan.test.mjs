// secret-scan：打包前的脫敏掃描（金鑰、Bearer token、私密狀態檔都不能進發佈物）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanText, scanTree, assertNoSecrets } from '../../agent/lib/secret-scan.mjs';

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-secret-scan-'));
    const write = (name, value) => {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
        return file;
    };
    return { dir, write };
}

const FAKE_KEY = 'sk-' + 'f'.repeat(32);

test('secret-scan：乾淨的發佈物不回報', () => {
    const s = sandbox();
    s.write('README.md', '# ACE Music\n沒有金鑰，只有 <https://example.com>。');
    s.write('src/content.js', 'const key = "";\n');
    assert.deepEqual(scanTree(s.dir), []);
    assert.equal(assertNoSecrets(s.dir).ok, true);
});

test('secret-scan：命中 OpenAI 樣式金鑰、Bearer token、GitHub token', () => {
    const s = sandbox();
    s.write('a.json', JSON.stringify({ key: FAKE_KEY }));
    s.write('b.md', 'Authorization: Bearer ' + 'a'.repeat(30));
    s.write('c.yml', 'token: ghp_' + 'b'.repeat(32));
    const hits = scanTree(s.dir);
    assert.ok(hits.length >= 3);
    assert.deepEqual([...new Set(hits.map((hit) => hit.rule))].sort(), ['bearer_token', 'github_token', 'openai_like_key']);
    assert.throws(() => assertNoSecrets(s.dir), (error) => error.code === 'PACK_SECRETS_FOUND');
});

test('secret-scan：執行環境的實際金鑰命中就中止，且錯誤訊息不含金鑰', () => {
    const s = sandbox();
    const key = 'sk-' + 'c'.repeat(32);
    s.write('docs/privacy.html', `<script>const k = "${key}"</script>`);
    const hits = scanTree(s.dir, { keys: [key] });
    assert.ok(hits.some((hit) => hit.rule === 'configured_key'));
    try {
        assertNoSecrets(s.dir, { keys: [key] });
        assert.fail('應該要中止打包');
    } catch (error) {
        assert.equal(error.code, 'PACK_SECRETS_FOUND');
        assert.equal(error.message.includes(key), false, '錯誤訊息不能帶出金鑰');
    }
});

test('secret-scan：私密狀態檔與 symlink 一律擋下；二進位檔不掃', () => {
    const s = sandbox();
    s.write('agent/session.json', '{"cookie":"secret"}');
    s.write('music-agent/research/research.sqlite', 'binary');
    fs.writeFileSync(path.join(s.dir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const rules = scanTree(s.dir).map((hit) => hit.rule);
    assert.ok(rules.includes('private_state_file'));
    assert.equal(rules.filter((rule) => rule === 'private_state_file').length, 2, 'session.json 與 sqlite 都要算');
    assert.equal(rules.includes('oversized_text_file'), false);
});

test('secret-scan：文字比對可單獨使用，sample 只留前綴', () => {
    const text = 'key=' + FAKE_KEY;
    const hits = scanText(text, { keys: [] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule, 'openai_like_key');
    assert.equal(hits[0].sample, 'sk-f…');
    assert.equal(hits[0].sample.includes(FAKE_KEY), false);
});
