import path from 'node:path';

const ADAPTER_ID = 'baddj-mixcore-readonly';
const ADAPTER_VERSION = '1.0.0';
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const knownPositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const checkedCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const now = () => new Date().toISOString();

function inspectAsset(asset) {
    if (!OBJECT(asset) || typeof asset.id !== 'string' || !ID.test(asset.id)) return failure('invalid_asset', '缺少有效的產物識別碼。');
    if (asset.rejected === true || asset.status === 'rejected' || asset.review_status === 'rejected' || asset.human_decision === 'rejected') return failure('rejected', '已拒絕的產物不得加入演出庫存。');
    if (asset.technical_verified !== true) return failure('unverified_asset', '產物尚未通過技術核驗。');
    if (asset.human_accepted !== true) return failure('awaiting_listen', '必須先由人類明確接受此產物。');
    if (typeof asset.path !== 'string' || !asset.path || /[\r\n\0]/.test(asset.path) || !(path.win32.isAbsolute(asset.path) || path.posix.isAbsolute(asset.path)) ||
        typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) return failure('unverified_asset', '已核產物需要絕對路徑與 SHA-256。');
    const duration = asset.duration_seconds == null ? null : knownPositive(asset.duration_seconds);
    if (asset.duration_seconds != null && duration === null) return failure('invalid_duration', '已知時長必須是有限的正秒數；未知請保留空值。');
    return { ok: true, asset: {
        id: asset.id, path: asset.path, sha256: asset.sha256.toLowerCase(), duration_seconds: duration,
        title: typeof asset.title === 'string' ? asset.title.slice(0, 300) : asset.id,
        technical_verified: true, human_accepted: true,
    } };
}

function inventory(assets, seen = new Set()) {
    const eligible = [];
    const excluded = [];
    for (const input of Array.isArray(assets) ? assets : []) {
        const checked = inspectAsset(input);
        if (!checked.ok) { excluded.push({ artifact_id: typeof input?.id === 'string' ? input.id : null, reason: checked.status }); continue; }
        if (seen.has(checked.asset.sha256)) { excluded.push({ artifact_id: checked.asset.id, reason: 'duplicate_audio' }); continue; }
        seen.add(checked.asset.sha256);
        eligible.push(checked.asset);
    }
    const known = eligible.filter(asset => asset.duration_seconds !== null);
    const rawSum = known.reduce((total, asset) => total + asset.duration_seconds, 0);
    const sum = Number.isFinite(rawSum) ? rawSum : null;
    const unknown = eligible.length - known.length;
    return {
        assets: eligible, excluded,
        count: eligible.length, known_duration_seconds: sum, unknown_duration_count: unknown,
        duration_seconds: unknown ? null : sum,
    };
}

/** Stock estimate before overlaps or cue edits. No playback or generation occurs. */
export function planPerformanceBuffer({ assets = [], backup_assets = [], target_minutes, generation_p95_seconds } = {}) {
    const seen = new Set();
    const main = inventory(assets, seen);
    const backup = inventory(backup_assets, seen);
    const target = knownPositive(target_minutes);
    const p95 = knownPositive(generation_p95_seconds);
    const targetSeconds = target === null || !Number.isFinite(target * 60) ? null : target * 60;
    const required = targetSeconds === null || p95 === null || !Number.isFinite(targetSeconds + p95) ? null : targetSeconds + p95;
    const targetShortfall = main.duration_seconds === null || targetSeconds === null ? null : Math.max(0, targetSeconds - main.duration_seconds);
    const shortfall = main.duration_seconds === null || required === null ? null : Math.max(0, required - main.duration_seconds);
    const meanDuration = main.count > 0 && main.duration_seconds !== null ? main.duration_seconds / main.count : null;
    const suggestions = [];
    if (targetSeconds === null) suggestions.push({ code: 'set_target', text: '先設定明確的目標場次分鐘數。' });
    if (p95 === null) suggestions.push({ code: 'measure_generation_p95', text: '先量測生成至回收的 P95 等待秒數。' });
    if (main.unknown_duration_count || backup.unknown_duration_count) suggestions.push({ code: 'verify_durations', text: '補齊未知時長後才能確認完整庫存。' });
    if (!main.count) suggestions.push({ code: 'accept_and_queue_audio', text: '先人工試聽接受產物，再手動加入主佇列。' });
    if (shortfall > 0) suggestions.push({ code: 'prepare_more_accepted_audio', text: '主佇列不足以涵蓋目標與生成等待預留，請準備更多已接受音訊。' });
    if (shortfall === 0) suggestions.push({ code: 'stock_estimate_met', text: '目前全長庫存符合此估計；過渡、裁切與現場操作仍待驗證。' });
    return {
        ok: true, inventory_scope: 'approved_full_track_durations_before_transitions',
        target_minutes: target, generation_p95_seconds: p95, generation_timing_scope: 'caller_supplied', reserve_policy: 'one_generation_p95',
        target_seconds: targetSeconds, required_seconds: required,
        inventory_seconds: main.duration_seconds, known_inventory_seconds: main.known_duration_seconds,
        eligible_count: main.count, unknown_duration_count: main.unknown_duration_count,
        target_shortfall_seconds: targetShortfall, shortfall_seconds: shortfall,
        suggested_additional_tracks: shortfall === null || meanDuration === null ? null : Math.ceil(shortfall / meanDuration),
        status: shortfall === null ? 'unknown' : shortfall > 0 ? 'insufficient' : 'sufficient_estimate',
        backup: { count: backup.count, inventory_seconds: backup.duration_seconds, known_inventory_seconds: backup.known_duration_seconds, unknown_duration_count: backup.unknown_duration_count },
        excluded: [...main.excluded, ...backup.excluded], suggestions,
        mixed_output_duration_verified: false, auto_play: false,
    };
}

function externalConfig(input) {
    if (!input?.base_url) return { base_url: null, owner: typeof input?.owner === 'string' ? input.owner : null };
    let url;
    try { url = new URL(input.base_url); } catch { throw new Error('外部混音引擎網址無效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('混音引擎僅支援明確配置的本機回環網址。');
    return { base_url: url.origin, owner: typeof input.owner === 'string' && input.owner.trim() ? input.owner : null };
}

function externalIdentity(data) {
    if (!OBJECT(data) || data.schema !== 'baddj.status.v1' || data.service !== 'baddj.mixcore' || data.server !== 'baddj-mixcore' ||
        data.api_version !== 1 || typeof data.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version)) return null;
    const capabilities = {};
    for (const key of ['full_analysis', 'full_mix_render', 'plan_all', 'alignment_metrics', 'adaptive_transitions', 'musical_cues', 'gap_aware_transitions']) {
        capabilities[key] = typeof data.capabilities?.[key] === 'boolean' ? data.capabilities[key] : null;
    }
    const counts = {};
    for (const key of ['audio_paths', 'analyzed', 'full_analyzed', 'full_mixes', 'unknown', 'errors', 'duplicates']) counts[key] = checkedCount(data.counts?.[key]);
    const clean = {
        service: data.service, schema: data.schema, server: data.server, api_version: data.api_version, version: data.version,
        algorithm_version: typeof data.algorithm_version === 'string' ? data.algorithm_version.slice(0, 150) : null,
        capabilities, counts,
    };
    if (OBJECT(data.job)) clean.job = {
        id: typeof data.job.id === 'string' || Number.isSafeInteger(data.job.id) ? data.job.id : null,
        kind: typeof data.job.kind === 'string' ? data.job.kind.slice(0, 50) : null,
        status: typeof data.job.status === 'string' ? data.job.status.slice(0, 50) : null,
    };
    return clean;
}

/** Local manual planning only. The external engine is contacted solely by GET. */
export function createMusicPerformance({ external = {}, assets = [], state = {} } = {}, { fetchImpl = globalThis.fetch, nowImpl = now } = {}) {
    const endpoint = externalConfig(external);
    let assetMap = new Map();
    const main = [];
    const backup = [];
    const history = [];
    let paused = state.paused !== false;
    let stopped = state.stopped === true;
    let mode = state.control_mode === 'takeover' ? 'takeover' : 'manual';
    let externalState = { available: null, checked_at: null, status: endpoint.base_url ? 'not_checked' : 'not_configured', current: null, last_known: null };

    function event(action, detail = {}) {
        history.push({ action, at: nowImpl(), ...detail });
        if (history.length > 100) history.shift();
    }
    function materialize(rows) { return rows.map(row => assetMap.get(row.artifact_id)).filter(Boolean); }
    function safeRows(rows) { return materialize(rows).map(asset => ({ artifact_id: asset.id, title: asset.title, duration_seconds: asset.duration_seconds })); }
    function getState() {
        return clone({
            status: stopped ? 'stopped' : mode === 'takeover' ? 'takeover' : paused ? 'paused' : 'ready',
            paused, stopped, control_mode: mode,
            queue: safeRows(main), backup: safeRows(backup), history,
            playback: 'not_connected', auto_play: false,
        });
    }
    function getCapabilities() {
        return clone({
            adapter_id: ADAPTER_ID, adapter_version: ADAPTER_VERSION,
            external_available: externalState.available,
            external: { ...endpoint, owner_source: endpoint.owner ? 'configured' : 'unknown', availability_scope: 'read_only_status_endpoint', health_path: '/api/status', ...externalState },
            operations: ['read_status', 'buffer_plan', 'manual_queue', 'pause', 'takeover', 'resume', 'stop', 'prepare_manifest'],
            external_writes: false, engine_start: false, playback: false, auto_play: false,
            acceptance: { external_identity: externalState.available === true ? 'verified' : 'unverified', source_runtime_match: 'unverified', alignment: 'unverified', mixed_listening: 'unverified', hardware: 'unverified' },
        });
    }
    function setAssets(inputs) {
        if (!Array.isArray(inputs)) return failure('invalid_assets', '產物清單必須是陣列。');
        const next = new Map();
        const deniedIds = new Set();
        const excluded = [];
        for (const input of inputs) {
            const checked = inspectAsset(input);
            if (!checked.ok) {
                if (typeof input?.id === 'string') { deniedIds.add(input.id); next.delete(input.id); }
                excluded.push({ artifact_id: input?.id || null, reason: checked.status }); continue;
            }
            if (deniedIds.has(checked.asset.id)) continue;
            if (next.has(checked.asset.id) && next.get(checked.asset.id).sha256 !== checked.asset.sha256) return failure('asset_conflict', '同一產物識別碼對應不同內容；保留原清單。');
            next.set(checked.asset.id, checked.asset);
        }
        assetMap = next;
        const removed = [];
        for (const rows of [main, backup]) {
            for (let index = rows.length - 1; index >= 0; index--) {
                if (!assetMap.has(rows[index].artifact_id)) removed.push(...rows.splice(index, 1).map(row => row.artifact_id));
            }
        }
        if (removed.length) event('assets_removed_from_buffer', { artifact_ids: removed });
        return { ok: true, accepted_count: assetMap.size, excluded, removed_from_buffer: removed };
    }
    function queue({ artifact_id, role = 'main', position } = {}) {
        if (stopped) return failure('stopped', '已停止新增佇列；請明確恢復後再加入。');
        if (!['main', 'backup'].includes(role)) return failure('invalid_role', '佇列角色必須是 main 或 backup。');
        const asset = assetMap.get(artifact_id);
        if (!asset) return failure('asset_not_accepted', '此產物尚未核驗且經人類接受，不能加入庫存。');
        const rows = role === 'main' ? main : backup;
        if (position !== undefined && (!Number.isInteger(position) || position < 0 || position > rows.length)) return failure('invalid_position', '佇列位置無效。');
        for (const row of [...main, ...backup]) {
            const existing = assetMap.get(row.artifact_id);
            if (existing.id === asset.id) return { ok: true, reused: true, state: getState() };
            if (existing.sha256 === asset.sha256) return failure('duplicate_audio', '同一音訊已在主佇列或備用庫存中。');
        }
        rows.splice(position ?? rows.length, 0, { artifact_id });
        event('manual_queue', { artifact_id, role });
        return { ok: true, state: getState() };
    }
    function dequeue({ artifact_id } = {}) {
        let removed = false;
        for (const rows of [main, backup]) {
            const index = rows.findIndex(row => row.artifact_id === artifact_id);
            if (index >= 0) { rows.splice(index, 1); removed = true; }
        }
        if (removed) event('manual_dequeue', { artifact_id });
        return { ok: true, removed, state: getState() };
    }
    function planBuffer(input = {}) {
        return planPerformanceBuffer({ ...input, assets: materialize(main), backup_assets: materialize(backup) });
    }
    setAssets(assets);
    // Restored entries remain metadata and are checked against the current
    // approved registry. No restore step starts playback or contacts a server.
    for (const [rows, inputs] of [[main, state.queue], [backup, state.backup]]) {
        for (const input of Array.isArray(inputs) ? inputs : []) {
            const id = typeof input === 'string' ? input : input?.artifact_id;
            if (!assetMap.has(id) || [...main, ...backup].some(row => assetMap.get(row.artifact_id).sha256 === assetMap.get(id).sha256)) continue;
            rows.push({ artifact_id: id });
        }
    }

    return {
        getCapabilities, getState, setAssets, queue, dequeue, planBuffer, bufferPlan: planBuffer,
        async probeExternal() {
            if (!endpoint.base_url) return { ok: false, status: 'not_configured', capabilities: getCapabilities() };
            const checkedAt = nowImpl();
            try {
                const response = await fetchImpl(endpoint.base_url + '/api/status', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
                if (!response.ok) throw new Error('unavailable');
                const identity = externalIdentity(await response.json());
                if (!identity) throw new Error('identity_mismatch');
                externalState = { available: true, checked_at: checkedAt, status: 'connected', current: identity, last_known: { ...identity, observed_at: checkedAt } };
                return { ok: true, status: 'connected', capabilities: getCapabilities() };
            } catch {
                externalState = { ...externalState, available: false, checked_at: checkedAt, status: 'unavailable', current: null };
                return { ok: false, status: 'unavailable', capabilities: getCapabilities(), message: '外部混音引擎暫不可讀；本地主佇列與備用庫存保留。' };
            }
        },
        pause({ reason } = {}) { paused = true; event('pause', { reason: typeof reason === 'string' ? reason.slice(0, 300) : null }); return { ok: true, state: getState() }; },
        takeover({ reason } = {}) { mode = 'takeover'; paused = true; event('takeover', { reason: typeof reason === 'string' ? reason.slice(0, 300) : null }); return { ok: true, state: getState() }; },
        resume() { mode = 'manual'; paused = false; stopped = false; event('resume'); return { ok: true, state: getState() }; },
        stop({ reason } = {}) { stopped = true; paused = true; event('user_stop', { reason: typeof reason === 'string' ? reason.slice(0, 300) : null }); return { ok: true, state: getState() }; },
        prepareManifest(input = {}) {
            const tracks = [...materialize(main).map((asset, order) => ({ ...asset, artifact_id: asset.id, role: 'main', order })),
                ...materialize(backup).map((asset, order) => ({ ...asset, artifact_id: asset.id, role: 'backup', order }))];
            return {
                ok: true, status: 'awaiting_user_review', manifest: {
                    schema: 'huaidj.performance-manifest.v1', created_at: nowImpl(),
                    adapter: { id: ADAPTER_ID, version: ADAPTER_VERSION }, external: { ...endpoint, last_known_version: externalState.last_known?.version ?? null },
                    tracks, control: getState(), buffer_plan: planBuffer(input),
                    execution: { user_review_required: true, auto_start: false, auto_play: false, external_write_performed: false },
                    acceptance: { source_registry: 'technical_verified_and_human_accepted', alignment: 'unverified', mixed_listening: 'unverified', hardware: 'unverified' },
                },
            };
        },
    };
}
