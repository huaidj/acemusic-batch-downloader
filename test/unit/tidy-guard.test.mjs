// tidy-guard：連續觸發的「一鍵整理」要合併成一輪，不排隊重跑完整管線
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    acquireTidyRun, releaseTidyRun, takePendingTidyRun, peekTidyRun, markTidyPending,
    TIDY_LOCK_FILE, TIDY_PENDING_FILE,
} from '../../agent/lib/tidy-guard.mjs';

const TEMP = process.env.ACE_TEST_TEMP || os.tmpdir();
function sandbox() {
    const base = fs.mkdtempSync(path.join(TEMP, 'ace-tidy-guard-'));
    const stateDir = path.join(base, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    return { base, stateDir, cfg: { stateDir } };
}
const lockPath = (cfg) => path.join(cfg.stateDir, TIDY_LOCK_FILE);
const pendingPath = (cfg) => path.join(cfg.stateDir, TIDY_PENDING_FILE);

test('tidy-guard：第一個取得整理權，第二個只合併（不重跑），釋放後可再取得', async () => {
    const s = sandbox();
    const first = await acquireTidyRun(s.cfg, { root: 'ai音樂' });
    assert.equal(first.acquired, true);
    assert.ok(fs.existsSync(lockPath(s.cfg)));

    const second = await acquireTidyRun(s.cfg, { root: 'ai音樂' });
    assert.equal(second.acquired, false);
    assert.equal(second.coalesced, true);
    assert.equal(second.owner.pid, process.pid, '持有者是目前這個活著的行程');

    assert.equal(await releaseTidyRun(first), true);
    assert.equal(fs.existsSync(lockPath(s.cfg)), false);
    const third = await acquireTidyRun(s.cfg, { root: 'ai音樂' });
    assert.equal(third.acquired, true);
    await releaseTidyRun(third);
});

test('tidy-guard：過期鎖（持有者行程已結束）會被清掉並取得整理權', async () => {
    const s = sandbox();
    fs.writeFileSync(lockPath(s.cfg), JSON.stringify({ pid: 99999999, token: 'dead', startedAt: new Date().toISOString(), root: 'ai音樂' }));
    assert.equal(await peekTidyRun(s.cfg), null, '死掉的持有者不算在跑');
    const guard = await acquireTidyRun(s.cfg, { root: 'ai音樂' });
    assert.equal(guard.acquired, true);
    const owner = JSON.parse(fs.readFileSync(lockPath(s.cfg), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.token, guard.token);
    await releaseTidyRun(guard);
});

test('tidy-guard：釋放時比對 token，不會刪掉別人的鎖', async () => {
    const s = sandbox();
    fs.writeFileSync(lockPath(s.cfg), JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: new Date().toISOString(), root: 'ai音樂' }));
    const guard = { acquired: true, token: 'mine', lockFile: lockPath(s.cfg), startedAt: new Date().toISOString() };
    assert.equal(await releaseTidyRun(guard), false);
    assert.ok(fs.existsSync(lockPath(s.cfg)), '別人的鎖要留著');
    assert.equal(JSON.parse(fs.readFileSync(lockPath(s.cfg), 'utf8')).token, 'someone-else');
});

test('tidy-guard：這一輪開始後才來的觸發才會補跑一輪；更早的舊要求直接丟掉', async () => {
    const s = sandbox();
    const guard = await acquireTidyRun(s.cfg, { root: 'ai音樂', now: () => '2026-11-17T10:00:00.000Z' });
    assert.equal(guard.acquired, true);

    // 這一輪開始之前就存在的舊要求：已被這一輪涵蓋
    await markTidyPending(s.cfg, { root: 'ai音樂', requestedAt: '2026-11-17T09:59:00.000Z' });
    assert.equal(await takePendingTidyRun(guard), false);
    assert.equal(fs.existsSync(pendingPath(s.cfg)), false, '舊要求要清掉');

    // 執行期間進來的新要求：要補跑一輪
    await markTidyPending(s.cfg, { root: 'ai音樂', requestedAt: '2026-11-17T10:02:00.000Z' });
    assert.equal(await takePendingTidyRun(guard), true);
    assert.equal(fs.existsSync(pendingPath(s.cfg)), false);
    assert.equal(await takePendingTidyRun(guard), false, '補跑只做一次，不會無限循環');

    await releaseTidyRun(guard);
});

test('tidyAll：已經有一輪在跑時只登記 pending，不進管線', async () => {
    const s = sandbox();
    // 模擬另一輪正在跑：用本行程 pid 造一個活著的鎖
    fs.writeFileSync(lockPath(s.cfg), JSON.stringify({ pid: process.pid, token: 'running', startedAt: new Date().toISOString(), root: 'ai音樂' }));
    const { tidyAll } = await import('../../agent/lib/ace.mjs');
    const result = await tidyAll({ root: 'ai音樂', cfg: s.cfg });
    assert.equal(result.coalesced, true);
    assert.deepEqual(result.steps, []);
    assert.equal(result.runningPid, process.pid);
    assert.ok(fs.existsSync(pendingPath(s.cfg)), '要留下「結束後補一輪」的登記');
    assert.equal(JSON.parse(fs.readFileSync(pendingPath(s.cfg), 'utf8')).root, 'ai音樂');
});
