import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Windows PowerShell 5.1 reads BOM-less scripts as the ANSI code page, so any non-ASCII text
// (Chinese messages) corrupts strings and breaks parsing. Scripts with non-ASCII need a UTF-8 BOM.
test('PowerShell scripts with non-ASCII text carry a UTF-8 BOM', () => {
    const offenders = [];
    for (const dir of ['native', 'scripts']) {
        const full = path.join(root, dir);
        if (!fs.existsSync(full)) continue;
        for (const name of fs.readdirSync(full)) {
            if (!name.toLowerCase().endsWith('.ps1')) continue;
            const bytes = fs.readFileSync(path.join(full, name));
            const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
            if (!bom && bytes.some((b) => b > 127)) offenders.push(`${dir}/${name}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('installer reads JSON files as UTF-8', () => {
    for (const name of ['install-update.ps1', 'build-host.ps1']) {
        const text = fs.readFileSync(path.join(root, 'native', name), 'utf8');
        const reads = text.match(/Get-Content[^\n|]*\|\s*ConvertFrom-Json/g) || [];
        for (const line of reads) assert.match(line, /-Encoding UTF8/, `${name}: ${line}`);
    }
});
