import * as ACE from './ace.mjs';
import { createRequestHash } from './create-contract.mjs';
import { normalizeModel } from '../music/core.mjs';

const OBJECT = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function fail(code, message) {
    throw Object.assign(new Error(message), { code, submission_unknown: false });
}

function baseOrigin(cfg) {
    let url;
    try { url = new URL(cfg.baseUrl); } catch { fail('CREATE_BASE_URL', '生成服務網址無效。'); }
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((!loopback && url.origin !== 'https://acemusic.ai') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        fail('CREATE_BASE_URL', '生成只支援 ACE Music 官方 HTTPS 網址或隔離測試的本機回環網址。');
    }
    return url.origin;
}

function validatePrepared(prepared) {
    if (!OBJECT(prepared) || prepared.ok !== true || !OBJECT(prepared.request) || !OBJECT(prepared.request.body) ||
        !/^[a-f0-9]{64}$/i.test(prepared.request_hash || '') || typeof prepared.requested_model !== 'string' || !prepared.requested_model ||
        !['idea', 'custom'].includes(prepared.mode) || typeof prepared.has_upload !== 'boolean' || typeof prepared.has_references !== 'boolean') {
        fail('CREATE_PREPARED_REQUIRED', '需要由建立器核驗的生成請求。');
    }
    const endpoint = prepared.mode === 'idea' ? '/api/idea' : '/api/custom';
    if (prepared.request.endpoint !== endpoint || prepared.request.body.model !== prepared.requested_model ||
        createRequestHash(prepared.request) !== prepared.request_hash.toLowerCase()) {
        fail('CREATE_PREPARED_MISMATCH', '生成請求的摘要、模型或模式不一致，請重新準備。');
    }
    if (prepared.has_upload) fail('CREATE_UPLOAD_UNSUPPORTED', '目前傳輸器尚未支援上傳素材。');
    const bodyInput = prepared.request.body;
    const hasMaterial = !!(bodyInput.references?.length || bodyInput.media?.length || bodyInput.covers?.length || bodyInput.step?.ref_url || bodyInput.step?.ref_song);
    if (!Array.isArray(bodyInput.references) || prepared.has_references !== hasMaterial) {
        fail('CREATE_PREPARED_MISMATCH', '參考素材標記與實際請求不一致。');
    }
    let body;
    try { body = JSON.parse(JSON.stringify(prepared.request.body)); } catch { fail('CREATE_PREPARED_REQUIRED', '生成內容必須是可序列化的 JSON。'); }
    return { ...prepared, request: { endpoint, body }, request_hash: prepared.request_hash.toLowerCase() };
}

function parseJson(response, { submitting = false } = {}) {
    if (!response.ok) fail(submitting ? 'CREATE_SUBMISSION_UNKNOWN' : 'CREATE_HTTP', `ACE Music 回應 HTTP ${response.status}。`);
    return response.json().then((data) => {
        if (!OBJECT(data) || data.ok === false || data.error) fail(submitting ? 'CREATE_SUBMISSION_UNKNOWN' : 'CREATE_RESPONSE', 'ACE Music 未回傳可核驗的資料。');
        return data;
    }).catch(() => fail(submitting ? 'CREATE_SUBMISSION_UNKNOWN' : 'CREATE_RESPONSE', 'ACE Music 回應格式無法辨識。'));
}

function timestamp(value) {
    const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(result) || result < 0) fail('CREATE_RECEIPT', '生成請求缺少可核驗的建立時間。');
    return result;
}

function modelsFromResponse(data, requestedModel, requestedIds) {
    const songs = [data.song, ...(Array.isArray(data.songs) ? data.songs : []), ...(Array.isArray(data.items) ? data.items : [])]
        .filter((song) => OBJECT(song) && typeof song.task_id === 'string' && TASK_ID.test(song.task_id));
    const taskIds = requestedIds || [...new Set([data.task_id, ...(Array.isArray(data.task_ids) ? data.task_ids : []), ...songs.map((song) => song.task_id)]
        .filter((id) => typeof id === 'string' && TASK_ID.test(id)))];
    const actualModels = [...new Set(songs.map((song) => song.model).filter((model) => typeof model === 'string' && model))];
    const byId = new Map();
    for (const song of songs) {
        if (typeof song.model !== 'string' || !song.model) continue;
        const models = byId.get(song.task_id) || new Set();
        models.add(song.model);
        byId.set(song.task_id, models);
    }
    const mismatch = taskIds.filter((id) => [...(byId.get(id) || [])].some((model) => normalizeModel(model) !== normalizeModel(requestedModel)));
    const unknown = taskIds.filter((id) => !byId.has(id));
    return {
        task_ids: taskIds, requested_model: requestedModel, actual_models: actualModels,
        model_mismatch_task_ids: mismatch, model_unknown_task_ids: unknown,
        model_verified: taskIds.length > 0 && mismatch.length === 0 && unknown.length === 0,
        artifact_verified: false,
    };
}

/** One transport per Hub; the independent authority is the only submission gate. */
export function createAceTransport(cfg, { authority } = {}) {
    const base = baseOrigin(cfg);

    async function readSession() {
        try { return await ACE.loadSession(cfg); }
        catch { fail('CREATE_AUTH_REQUIRED', '找不到可用的本機登入狀態，請重新同步 ACE Music 登入。'); }
    }

    function request(session, route, options = {}) {
        return fetch(base + route, {
            ...options,
            headers: {
                'User-Agent': session.ua || cfg.ua,
                Accept: 'application/json', Origin: base, Referer: base + '/create/', Cookie: session.cookie,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            redirect: 'error', signal: AbortSignal.timeout(45000),
        });
    }

    async function readPreview(prepared) {
        const session = await readSession();
        let data;
        try { data = await parseJson(await request(session, '/api/status')); }
        catch { fail('CREATE_PREVIEW_UNAVAILABLE', '無法讀取即時模型、費用或登入狀態，未送出生成。'); }
        const model = Array.isArray(data.models) && data.models.find((entry) => OBJECT(entry) && entry.id === prepared.requested_model);
        if (!model) fail('CREATE_MODEL_UNAVAILABLE', '目前帳戶未提供要求的模型。');
        // Public app.js model-picker cost(): selectedModel.free ? 0 : costs.song.
        // Existing visual references can add video charges whose duration is not
        // present in this prepared contract. Never guess their total price.
        if (prepared.request.body.media?.length) fail('CREATE_COST_UNKNOWN', '視覺參考可能另有影片費用，目前無法確認總額，未送出生成。');
        const cost = model.free === true ? 0 : data.costs?.song;
        const credits = data.user?.credits;
        if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) {
            fail('CREATE_COST_UNKNOWN', '無法確認即時生成費用與可用額度，未送出生成。');
        }
        if (!OBJECT(model.limits)) fail('CREATE_LIMITS_UNKNOWN', '無法確認此模型的即時文字限制。');
        const limits = {};
        for (const field of ['prompt', 'style', 'lyrics']) {
            if (prepared.request.body[field] === undefined) continue;
            const value = prepared.request.body[field];
            const limit = model.limits[field];
            if (typeof value !== 'string' || !Number.isSafeInteger(limit) || limit <= 0) fail('CREATE_LIMITS_UNKNOWN', '無法確認此模型的即時文字限制。');
            if ([...value].length > limit) fail('CREATE_TEXT_LIMIT', '生成內容超過目前模型的文字限制，請重新準備。');
            limits[field] = limit;
        }
        return { session, preview: {
            ok: true, dry_run: true, model: prepared.requested_model, requested_model: prepared.requested_model,
            mode: prepared.mode, estimated_credits: cost, credits_before: credits, limits,
            request_hash: prepared.request_hash,
            ...(typeof data.user?.plan === 'string' ? { plan: data.user.plan } : {}),
        } };
    }

    function boundReceipt(prepared, key) {
        if (!authority || typeof authority.getReceipt !== 'function' || typeof authority.canSubmit !== 'function' || typeof authority.recordOutcome !== 'function') {
            fail('CREATE_AUTHORIZATION_REQUIRED', '缺少獨立的伺服器生成授權。');
        }
        if (typeof key !== 'string' || !key.trim() || key.length > 128) fail('CREATE_RECEIPT', '需要有效的原始冪等鍵。');
        const result = authority.getReceipt(key);
        const reservation = result?.reservation;
        if (result?.ok !== true || !OBJECT(reservation)) fail('CREATE_AUTHORIZATION_REQUIRED', '缺少有效的獨立生成收據。');
        if (reservation.request_hash !== prepared.request_hash || normalizeModel(reservation.model) !== normalizeModel(prepared.requested_model) || reservation.mode !== prepared.mode ||
            reservation.has_upload !== (prepared.has_upload || prepared.has_references)) {
            fail('CREATE_RECEIPT_MISMATCH', '收據與請求內容、模型、模式或素材範圍不一致。');
        }
        if (typeof reservation.estimated_credits !== 'number' || !Number.isFinite(reservation.estimated_credits) || reservation.estimated_credits < 0) {
            fail('CREATE_RECEIPT', '生成收據缺少可核驗的額度預留。');
        }
        return result;
    }

    function reserved(prepared, key) {
        const result = boundReceipt(prepared, key);
        if (result.status !== 'reserved' || result.reservation.state !== 'reserved' || authority.canSubmit(key) !== true) {
            fail('CREATE_AUTHORIZATION_REQUIRED', '此收據未獲准提交或已經處理；不會重送。');
        }
        return result.reservation;
    }

    return {
        async preview(preparedInput) {
            const prepared = validatePrepared(preparedInput);
            return (await readPreview(prepared)).preview;
        },
        async status(input = {}) {
            if (!OBJECT(input) || Object.keys(input).some((key) => !['task_ids', 'requested_model'].includes(key)) ||
                !Array.isArray(input.task_ids) || input.task_ids.length < 1 || input.task_ids.length > 10 ||
                input.task_ids.some((id) => typeof id !== 'string' || !TASK_ID.test(id)) ||
                typeof input.requested_model !== 'string' || !input.requested_model ||
                !['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'].includes(normalizeModel(input.requested_model))) {
                fail('CREATE_STATUS_INPUT', '需要 1–10 個有效任務 ID，以及明確的要求模型。');
            }
            const taskIds = [...new Set(input.task_ids)];
            const session = await readSession();
            let data;
            try { data = await parseJson(await request(session, '/api/songs?ids=' + encodeURIComponent(taskIds.join(',')))); }
            catch { fail('CREATE_STATUS_UNAVAILABLE', '無法讀取原任務狀態；不會重新提交生成。'); }
            if (!Array.isArray(data.items)) fail('CREATE_RESPONSE', 'ACE Music 未提供可核驗的任務清單。');
            const wanted = new Set(taskIds);
            const songs = data.items.filter((song) => OBJECT(song) && wanted.has(song.task_id)).map((song) => {
                const clean = { task_id: song.task_id };
                for (const key of ['status', 'model']) {
                    if (typeof song[key] === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(song[key])) clean[key] = song[key];
                }
                if (typeof song.local_audio === 'string') {
                    try {
                        const url = new URL(song.local_audio, base);
                        if (url.origin === base && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith('/data/')) clean.local_audio = url.pathname;
                    } catch { /* An untrusted audio URL does not establish availability. */ }
                }
                return clean;
            });
            const statuses = new Map();
            for (const song of songs) {
                if (!song.status) continue;
                const values = statuses.get(song.task_id) || new Set();
                values.add(song.status);
                statuses.set(song.task_id, values);
            }
            const conflicts = taskIds.filter((id) => (statuses.get(id)?.size || 0) > 1);
            const conflictSet = new Set(conflicts);
            const coherent = songs.filter((song) => !conflictSet.has(song.task_id));
            const failed = [...new Set(coherent.filter((song) => ['failed', 'interrupted', 'cancelled', 'canceled'].includes(song.status)).map((song) => song.task_id))];
            const succeeded = [...new Set(coherent.filter((song) => song.status === 'succeeded').map((song) => song.task_id))];
            const audio = [...new Set(coherent.filter((song) => song.status === 'succeeded' && song.local_audio).map((song) => song.task_id))];
            const terminal = new Set([...failed, ...succeeded]);
            const found = new Set(songs.map((song) => song.task_id));
            return {
                ok: true, ...modelsFromResponse({ items: songs }, input.requested_model, taskIds), songs,
                missing_task_ids: taskIds.filter((id) => !found.has(id)), conflicting_task_ids: conflicts,
                failed_task_ids: failed, succeeded_task_ids: succeeded,
                pending_task_ids: taskIds.filter((id) => !terminal.has(id)),
                complete: taskIds.every((id) => terminal.has(id)), failed: failed.length > 0,
                remote_audio_available_task_ids: audio, remote_audio_available: taskIds.every((id) => audio.includes(id)),
                real_success: false,
            };
        },
        async submit(preparedInput, idempotencyKey) {
            const prepared = validatePrepared(preparedInput);
            const existing = boundReceipt(prepared, idempotencyKey);
            if (existing.reservation.state !== 'reserved') {
                return {
                    ...existing, reused: true, request_hash: prepared.request_hash, requested_model: prepared.requested_model,
                    task_ids: existing.reservation.remote_task_ids || [], artifact_verified: false,
                    submission_unknown: existing.reservation.state === 'outcome_unknown',
                    submission_state: ['submitted', 'settled'].includes(existing.reservation.state) ? 'accepted' : existing.reservation.state === 'not_submitted' ? 'not_submitted' : 'unresolved',
                };
            }
            reserved(prepared, idempotencyKey);
            const { session, preview } = await readPreview(prepared);
            // These authority calls are synchronous. No await may separate the final
            // eligibility check from persisting the irreversible submission intent.
            const reservation = reserved(prepared, idempotencyKey);
            // Preserve an explicitly reviewed, hash-bound native timestamp. Only
            // an omitted timestamp is filled from the independent reservation.
            const createdAt = timestamp(prepared.request.body.created_at ?? reservation.created_at);
            const submittedRequest = { endpoint: prepared.request.endpoint, body: { ...prepared.request.body, created_at: createdAt } };
            const submittedRequestHash = createRequestHash(submittedRequest);
            if (preview.estimated_credits > reservation.estimated_credits || preview.credits_before < preview.estimated_credits) {
                fail('CREATE_BUDGET_CHANGED', '即時費用或餘額不符原預留，未送出生成。');
            }
            const marked = authority.recordOutcome(idempotencyKey, { state: 'outcome_unknown' });
            if (marked?.ok !== true || marked.status !== 'outcome_unknown' || marked.reused !== false) {
                fail('CREATE_RECEIPT_WRITE', '無法獨立保存送出狀態，未送出生成。');
            }
            const unknown = (code, taskInfo = {}) => ({
                ok: false, status: 'outcome_unknown', submission_state: 'unresolved', submission_unknown: true, error_code: code,
                request_hash: prepared.request_hash, requested_model: prepared.requested_model, mode: prepared.mode,
                submitted_request_hash: submittedRequestHash, artifact_verified: false, ...taskInfo,
                message: '生成請求可能已受理；保留額度預留及原冪等鍵，需核對原任務，勿重送。',
            });
            let data;
            try {
                data = await parseJson(await request(session, submittedRequest.endpoint, {
                    method: 'POST', body: JSON.stringify(submittedRequest.body),
                }), { submitting: true });
            } catch { return unknown('CREATE_SUBMISSION_UNKNOWN'); }
            const taskInfo = modelsFromResponse(data, prepared.requested_model);
            if (!taskInfo.task_ids.length || taskInfo.task_ids.length > 20) return unknown('CREATE_TASK_IDS_UNKNOWN', taskInfo);
            let recorded;
            try { recorded = authority.recordOutcome(idempotencyKey, { state: 'submitted', remote_task_ids: taskInfo.task_ids }); }
            catch { return unknown('CREATE_RECEIPT_WRITE', taskInfo); }
            if (recorded?.ok !== true || recorded.status !== 'submitted') return unknown('CREATE_RECEIPT_WRITE', taskInfo);
            return {
                ok: true, status: 'submitted', submission_state: 'accepted', submission_unknown: false, request_hash: prepared.request_hash,
                submitted_request_hash: submittedRequestHash, mode: prepared.mode, created_at: createdAt, estimated_credits: preview.estimated_credits, ...taskInfo,
            };
        },
    };
}
