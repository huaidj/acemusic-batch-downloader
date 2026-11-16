'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const paths = {
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5v14M17 5v14" stroke-width="4"/>',
    previous: '<path d="M5 5v14m14-14L8 12l11 7Z"/>',
    next: '<path d="M19 5v14M5 5l11 7-11 7Z"/>',
    shuffle: '<path d="M3 6h3c4 0 8 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 5-5m2-2c2-3 3-5 5-5h3m-4-4 4 4-4 4"/>',
    repeat: '<path d="m17 2 4 4-4 4M3 10V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14 0v2a2 2 0 0 1-2 2H3"/>',
    repeatOne: '<path d="m17 2 4 4-4 4M3 10V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14 0v2a2 2 0 0 1-2 2H3m9-8v5m-2-3 2-2"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    library: '<path d="M4 3v18M9 3v18M15 4l5 16M3 21h18"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3Z"/>',
    playlist: '<path d="M4 5h16M4 10h16M4 15h9m5 0v6m-3-3h6"/>',
    history: '<path d="M3 12a9 9 0 1 0 2-6M3 3v5h5m4-1v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    volume: '<path d="m11 5-6 5H2v4h3l6 5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    muted: '<path d="m11 5-6 5H2v4h3l6 5Zm5 4 5 6m-5 0 5-6"/>',
    up: '<path d="m6 14 6-6 6 6"/>',
    down: '<path d="m6 10 6 6 6-6"/>',
    reveal: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3Zm6 7h6m-3-3 3 3-3 3"/>',
  };
  const icon = (name, filled = false) => `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.play}</svg>`;
  const statusNames = { verified: '已核對', recorded: '有紀錄', uncertain: '待核對', missing: '缺檔', unsupported: '不提供', damaged: '損壞' };
  const audioFormats = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'webm']);
  let library = { tracks: [], files: [], summary: {}, hub: {} };
  let state = { revision: 0, queue: [], playlists: [], favorites: [], history: [], volume: .8, repeat: 'off', shuffle: false, currentFileId: null, currentTime: 0 };
  let files = new Map();
  let tracks = new Map();
  let trackForSong = new Map();
  let view = 'library';
  let selection = null;
  let inspectorTab = 'details';
  let sort = { key: 'title', direction: 1 };
  let query = '';
  let statusFilter = 'all';
  let formatFilter = 'all';
  let preferredFormat = 'auto';
  let initialized = false;
  let loading = false;
  let saving = false;
  let saveConflict = false;
  let saveTimer = 0;
  let saveVersion = 0;
  let savedVersion = 0;
  let lastTimeSave = 0;
  let toastTimer = 0;
  let editingPlaylistId = null;
  let addingFileIds = [];
  let pendingSeek = 0;
  let previousVolume = .8;
  let failedFiles = new Set();
  let activeFileId = null;
  let playbackSnapshot = null;
  const SHUFFLE_KEY = 'huaidj-player-shuffle-cycle-v1';
  let shuffleCycle = { order: [], cursor: -1, signature: '' };
  let followingShuffleCycle = null;
  const JOURNAL_PREFIX = 'huaidj-player-pending-v1:';
  const JOURNAL_KEY = JOURNAL_PREFIX + crypto.randomUUID();
  let inFlightSnapshot = null;
  let lastSavedSnapshot = '';
  let journalStorageFailed = false;
  let recoveryDrafts = [];
  let recoveryServerState = null;
  let applyingRecoveryKey = null;
  let restoringAudio = false;
  let playbackRequested = false;
  let selectionSerial = null;
  let selectionPoller = 0;
  let selectionPolling = false;
  let libraryPoller = 0;
  let libraryPolling = false;
  let aliasResolutionIssues = [];
  let cyclesLoaded = false;
  const LINEAR_KEY = 'huaidj-player-linear-cycle-v1';
  let linearCycle = { order: [], cursor: -1, signature: '' };
  const audio = $('audio');
  const preloadAudio = $('preload-audio');

  function formatOf(file) { return String(file && file.format || '').replace(/^\./, '').toLowerCase(); }
  function validityOf(file) {
    const value = file && file.validity;
    const status = typeof value === 'object' && value ? value.status : value;
    return statusNames[status] ? status : 'uncertain';
  }
  function fileStatusText(file) {
    const value = typeof file?.validity === 'object' ? file.validity.status : file?.validity;
    if (value === 'valid') return '檔頭可讀';
    if (value === 'unknown') return '格式待核對';
    return statusNames[validityOf(file)];
  }
  function fileStatusBadge(file) {
    return `<span class="status ${validityOf(file)}">${esc(fileStatusText(file))}</span>`;
  }
  function playable(file) { return !!(file && audioFormats.has(formatOf(file)) && !['damaged', 'missing', 'unsupported'].includes(validityOf(file))); }
  function time(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function size(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
  }
  function statusBadge(status, count) {
    const key = statusNames[status] ? status : 'uncertain';
    return `<span class="status ${key}">${esc(statusNames[key])}${Number(count) > 1 ? ` · ${count}` : ''}</span>`;
  }
  function formatStatus(track, format) {
    return track && track.formats && track.formats[format] || { status: 'missing', count: 0 };
  }
  function currentTrack(fileId = state.currentFileId) {
    const file = files.get(fileId);
    return file && trackForSong.get(file.songId) || [...tracks.values()].find((track) => (track.files || []).some((item) => item.id === fileId) || (track.stems && track.stems.files || []).some((item) => item.id === fileId)) || null;
  }
  function favorite(trackId) { return state.favorites.includes(trackId); }
  function preferredFile(track) {
    if (!track) return null;
    const available = (track.files || []).map((item) => files.get(item.id) || item).filter(playable);
    const preferred = available.find((item) => item.id === track.preferredFileId);
    const format = preferredFormat === 'auto' ? 'mp3' : preferredFormat;
    return available.find((item) => formatOf(item) === format) || (preferredFormat === 'auto' ? preferred || available[0] : null) || null;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }
  function notice(message, reload = false) {
    const node = $('notice');
    node.hidden = !message;
    node.innerHTML = esc(message) + (reload ? ' <button id="reload-state">重新載入播放資料</button>' : '');
    if (reload) $('reload-state').addEventListener('click', reloadState);
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 409 ? '播放資料已由另一個視窗更新' : typeof data.error === 'string' ? data.error : `本機服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function normalizedState(value) {
    const input = value || {};
    return {
      revision: Number(input.revision) || 0,
      queue: Array.isArray(input.queue) ? input.queue.filter((id) => typeof id === 'string') : [],
      playlists: Array.isArray(input.playlists) ? input.playlists.map((item) => ({ id: String(item.id), name: String(item.name || '未命名清單'), fileIds: Array.isArray(item.fileIds) ? item.fileIds : [] })) : [],
      favorites: Array.isArray(input.favorites) ? input.favorites : [],
      history: Array.isArray(input.history) ? input.history : [],
      volume: Math.min(1, Math.max(0, Number.isFinite(input.volume) ? input.volume : .8)),
      repeat: ['off', 'all', 'one'].includes(input.repeat) ? input.repeat : 'off',
      shuffle: !!input.shuffle,
      currentFileId: typeof input.currentFileId === 'string' ? input.currentFileId : null,
      currentTime: Math.max(0, Number(input.currentTime) || 0),
    };
  }
  function mutableSnapshot(value = state) {
    const { revision, ...mutable } = normalizedState(value);
    return JSON.parse(JSON.stringify(mutable));
  }
  function canonicalSnapshot(value) { return JSON.stringify(mutableSnapshot(value)); }
  function journalFailure() { journalStorageFailed = true; renderRecoveryNotice(); }
  function persistPendingJournal() {
    if (!initialized) return;
    try {
      const pending = mutableSnapshot();
      if (!inFlightSnapshot && !aliasResolutionIssues.length && JSON.stringify(pending) === lastSavedSnapshot) { localStorage.removeItem(JOURNAL_KEY); return; }
      localStorage.setItem(JOURNAL_KEY, JSON.stringify({ schema: 1, updatedAt: Date.now(), baseRevision: state.revision, pending, inFlight: inFlightSnapshot, aliasIssues: aliasResolutionIssues }));
    } catch (_) { journalFailure(); }
  }
  function archiveCurrentJournal() {
    persistPendingJournal();
    try {
      const raw = localStorage.getItem(JOURNAL_KEY);
      if (raw) { localStorage.setItem(JOURNAL_PREFIX + crypto.randomUUID(), raw); localStorage.removeItem(JOURNAL_KEY); }
    } catch (_) { journalFailure(); }
  }
  function discoverRecoveryDrafts() {
    const found = [];
    try {
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key) => key?.startsWith(JOURNAL_PREFIX) && (key !== JOURNAL_KEY || aliasResolutionIssues.length));
      for (const key of keys) {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) { continue; }
        if (saved?.schema !== 1 || !saved.pending || !Number.isSafeInteger(saved.baseRevision) || saved.baseRevision < 0) continue;
        // A previous page may close after the server committed but before its reply.
        const issues = new Map();
        const mapped = mapStateFileAliases(saved.pending, issues);
        if (!issues.size && canonicalSnapshot(mapped) === canonicalSnapshot(state)) { localStorage.removeItem(key); continue; }
        found.push({ ...saved, key });
      }
    } catch (_) { journalFailure(); }
    recoveryDrafts = found.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    renderRecoveryNotice();
  }
  function renderRecoveryNotice() {
    const node = $('recovery-notice');
    if (!node) return;
    node.hidden = !recoveryDrafts.length && !journalStorageFailed && !aliasResolutionIssues.length;
    node.innerHTML = (journalStorageFailed ? '瀏覽器無法保存本機草稿，關窗前請確認「已儲存」。' : '') + (aliasResolutionIssues.length ? ` ${aliasResolutionIssues.length} 個音檔對應有循環或失聯，原始播放資料已保留；請刷新曲庫核對。` : '') + (recoveryDrafts.length ? ` 有 ${recoveryDrafts.length} 份未儲存草稿，尚未覆蓋目前資料。 <button id="review-recovery" type="button">查看草稿</button>` : '');
    $('review-recovery')?.addEventListener('click', reviewRecovery);
  }
  function draftCanApply(draft, serverState) {
    if (!draft || !serverState || saving) return false;
    const issues = new Map();
    mapStateFileAliases(draft.pending, issues);
    if (issues.size) return false;
    if (draft.baseRevision === serverState.revision) return true;
    const sent = draft.inFlight;
    // Rebase only when exact content proves that particular in-flight PUT was accepted.
    return !!sent?.pending && Number.isSafeInteger(sent.baseRevision) && serverState.revision === sent.baseRevision + 1 && canonicalSnapshot(serverState) === canonicalSnapshot(sent.pending);
  }
  function recoverySummary(value, heading) {
    const data = normalizedState(value);
    const fileName = (id) => currentTrack(id)?.title || files.get(id)?.name || '曲庫目前找不到的檔案';
    return `<section><h3>${esc(heading)}</h3><p>音量 ${Math.round(data.volume * 100)}% · ${{ off: '不循環', all: '清單循環', one: '單曲循環' }[data.repeat]}${data.shuffle ? ' · 隨機' : ''}<br>目前：${esc(data.currentFileId ? fileName(data.currentFileId) : '未選曲')} ${time(data.currentTime)}</p><details><summary>播放佇列 ${data.queue.length} 個檔案</summary><ol>${data.queue.map((id) => `<li>${esc(fileName(id))}</li>`).join('') || '<li>空佇列</li>'}</ol></details><details><summary>收藏 ${data.favorites.length} 首</summary><ul>${data.favorites.map((id) => `<li>${esc(tracks.get(id)?.title || '曲庫目前找不到的歌曲')}</li>`).join('') || '<li>沒有收藏</li>'}</ul></details><p>播放清單 ${data.playlists.length} 張</p><ul>${data.playlists.map((item) => `<li>${esc(item.name)} · ${item.fileIds.length} 首</li>`).join('') || '<li>沒有播放清單</li>'}</ul></section>`;
  }
  function renderRecoveryComparison() {
    const draft = recoveryDrafts.find((item) => item.key === $('recovery-choice').value);
    const allowed = draftCanApply(draft, recoveryServerState);
    const issues = new Map();
    const mapped = mapStateFileAliases(draft?.pending, issues);
    $('recovery-comparison').innerHTML = recoverySummary(recoveryServerState, `伺服器目前 · v${recoveryServerState?.revision ?? '?'}`) + recoverySummary(mapped, `本機草稿 · 基於 v${draft?.baseRevision ?? '?'}`);
    $('apply-recovery').disabled = !allowed;
    $('recovery-reason').textContent = issues.size ? '音檔對應尚未完成或形成循環，不能直接套用；原始草稿仍保留，請先刷新曲庫核對。' : allowed ? '套用前會再次核對伺服器版本；此草稿將以目前版本儲存，播放保持暫停。' : '伺服器已有其他較新變更，不能直接覆蓋。草稿仍保留，可匯出後逐項比對。';
  }
  async function reviewRecovery() {
    discoverRecoveryDrafts();
    if (!recoveryDrafts.length) return;
    try { recoveryServerState = normalizedState(await request('/api/state')); }
    catch (error) { return toast(`暫時無法比對伺服器版本：${error.message}`); }
    $('recovery-choice').innerHTML = recoveryDrafts.map((item) => `<option value="${esc(item.key)}">${esc(new Date(Number(item.updatedAt) || 0).toLocaleString())} · ${item.pending.playlists?.length || 0} 張清單</option>`).join('');
    renderRecoveryComparison();
    $('recovery-dialog').showModal();
  }
  async function applyRecoveryDraft() {
    const draft = recoveryDrafts.find((item) => item.key === $('recovery-choice').value);
    if (!draft) return;
    try {
      recoveryServerState = normalizedState(await request('/api/state'));
      if (!draftCanApply(draft, recoveryServerState)) { renderRecoveryComparison(); return; }
      archiveCurrentJournal();
      state = normalizedState({ ...draft.pending, revision: recoveryServerState.revision });
      lastSavedSnapshot = canonicalSnapshot(recoveryServerState);
      saveVersion = savedVersion = 0;
      saveConflict = false;
      inFlightSnapshot = null;
      applyingRecoveryKey = draft.key;
      cyclesLoaded = false;
      applyLibraryFileAliases();
      loadShuffleCycle();
      loadLinearCycle();
      cyclesLoaded = true;
      restoreCurrentFile();
      renderAll(); notice('');
      $('recovery-dialog').close();
      changed(0);
      toast('已套用草稿，正在儲存；播放保持暫停');
    } catch (error) { toast(`草稿仍保留：${error.message}`); }
  }
  function changed(delay = 180) {
    saveVersion += 1;
    persistPendingJournal();
    $('save-status').textContent = saveConflict ? '儲存衝突 · 請重新載入' : aliasResolutionIssues.length ? '檔案對應待核對 · 草稿已保留' : '儲存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, delay);
  }
  async function flushSave(keepalive = false) {
    clearTimeout(saveTimer);
    persistPendingJournal();
    if (initialized && aliasResolutionIssues.length) { $('save-status').textContent = '檔案對應待核對 · 草稿已保留'; return; }
    if (!initialized || saving || saveConflict || savedVersion === saveVersion) return;
    if (!inFlightSnapshot && canonicalSnapshot(state) === lastSavedSnapshot) { savedVersion = saveVersion; $('save-status').textContent = '已儲存'; return; }
    saving = true;
    const version = saveVersion;
    const sent = mutableSnapshot();
    inFlightSnapshot = { baseRevision: state.revision, pending: sent };
    persistPendingJournal();
    try {
      const result = await request('/api/state', { method: 'PUT', body: JSON.stringify({ ...sent, expectedRevision: state.revision }), keepalive: !!keepalive });
      state.revision = Number(result.revision ?? result.state?.revision) || state.revision;
      savedVersion = version;
      lastSavedSnapshot = JSON.stringify(sent);
      inFlightSnapshot = null;
      if (applyingRecoveryKey) {
        try { localStorage.removeItem(applyingRecoveryKey); } catch (_) { journalFailure(); }
        applyingRecoveryKey = null;
        discoverRecoveryDrafts();
      }
      persistPendingJournal();
      $('save-status').textContent = '已儲存';
    } catch (error) {
      if (error.status === 409) {
        inFlightSnapshot = null;
        saveConflict = true;
        notice('另一個視窗已更新播放資料。請重新載入後再編輯，避免覆蓋。', true);
        $('save-status').textContent = '儲存衝突';
        persistPendingJournal();
      } else {
        $('save-status').textContent = '尚未儲存 · 本機服務無回應';
        toast(`播放資料尚未儲存：${error.message}`);
        persistPendingJournal();
      }
    } finally {
      saving = false;
      if (!saveConflict && savedVersion !== saveVersion && savedVersion === version) saveTimer = setTimeout(flushSave, 80);
    }
  }
  async function reloadState() {
    try {
      archiveCurrentJournal();
      restoringAudio = true;
      audio.pause();
      state = normalizedState(await request('/api/state'));
      lastSavedSnapshot = canonicalSnapshot(state);
      inFlightSnapshot = null;
      saveConflict = false;
      saveVersion = savedVersion = 0;
      if (!saveConflict) notice('');
      cyclesLoaded = false;
      applyLibraryFileAliases();
      loadShuffleCycle();
      loadLinearCycle();
      cyclesLoaded = true;
      restoreCurrentFile();
      renderAll();
      discoverRecoveryDrafts();
      toast('已重新載入播放資料；播放保持暫停');
    } catch (error) { toast(error.message); }
  }
  function indexLibrary(value) {
    if (activeFileId && files.has(activeFileId)) playbackSnapshot = { file: files.get(activeFileId), track: currentTrack(activeFileId) };
    library = { ...value, tracks: Array.isArray(value.tracks) ? value.tracks : [], files: Array.isArray(value.files) ? value.files : [] };
    files = new Map(library.files.map((item) => [item.id, item]));
    tracks = new Map(library.tracks.map((item) => [item.id, item]));
    trackForSong = new Map();
    for (const track of library.tracks) {
      if (track.songId) trackForSong.set(track.songId, track);
      for (const item of [...(track.files || []), ...(track.stems && track.stems.files || [])]) if (!files.has(item.id)) files.set(item.id, item);
    }
  }
  function resolveFileAlias(id, issues = new Map()) {
    if (typeof id !== 'string' || !id) return id;
    const aliases = library.fileAliases;
    if (!aliases || typeof aliases !== 'object' || !Object.hasOwn(aliases, id)) return id;
    const seen = new Set();
    let current = id;
    for (let hops = 0; hops <= 32; hops += 1) {
      if (seen.has(current)) { issues.set(id, { fileId: id, reason: 'cycle' }); return id; }
      seen.add(current);
      if (!Object.hasOwn(aliases, current)) {
        if (files.has(current)) return current;
        issues.set(id, { fileId: id, reason: 'unknown-target' }); return id;
      }
      if (hops === 32 || typeof aliases[current] !== 'string' || !aliases[current]) {
        issues.set(id, { fileId: id, reason: hops === 32 ? 'hop-limit' : 'invalid-target' }); return id;
      }
      current = aliases[current];
    }
    return id;
  }
  function mapStateFileAliases(value, issues = new Map()) {
    const mapped = normalizedState(value);
    mapped.currentFileId = resolveFileAlias(mapped.currentFileId, issues);
    mapped.queue = mapped.queue.map((id) => resolveFileAlias(id, issues));
    mapped.playlists = mapped.playlists.map((item) => ({ ...item, fileIds: item.fileIds.map((id) => resolveFileAlias(id, issues)) }));
    mapped.history = mapped.history.map((item) => ({ ...item, fileId: resolveFileAlias(item.fileId, issues) }));
    return mapped;
  }
  function mapCycleAliases(saved) {
    if (!saved || !Array.isArray(saved.order)) return saved;
    let signature = saved.signature;
    try { const ids = JSON.parse(signature); if (Array.isArray(ids)) signature = JSON.stringify(ids.map((id) => resolveFileAlias(id))); } catch (_) { /* Invalid saved cycles are reconstructed by their loader. */ }
    return { ...saved, currentFileId: resolveFileAlias(saved.currentFileId), order: saved.order.map((id) => resolveFileAlias(id)), signature };
  }
  function applyLibraryFileAliases() {
    const issues = new Map();
    state = mapStateFileAliases(state, issues);
    activeFileId = resolveFileAlias(activeFileId, issues);
    failedFiles = new Set([...failedFiles].map((id) => resolveFileAlias(id)));
    if (selection?.kind === 'file') selection = { ...selection, id: resolveFileAlias(selection.id) };
    if (cyclesLoaded) {
      shuffleCycle = mapCycleAliases(shuffleCycle);
      linearCycle = mapCycleAliases(linearCycle);
      if (followingShuffleCycle) followingShuffleCycle = followingShuffleCycle.map((id) => resolveFileAlias(id));
      saveShuffleCycle(); saveLinearCycle();
    }
    aliasResolutionIssues = [...issues.values()];
    // Resolving identifiers is local only. Keep the last acknowledged revision;
    // the next normal save still uses CAS and cannot overwrite a newer server.
    persistPendingJournal();
    if (aliasResolutionIssues.length) discoverRecoveryDrafts();
    else renderRecoveryNotice();
  }
  function libraryRefreshDeferred() {
    return loading || saving || saveConflict || !!document.querySelector('dialog[open]') || !!document.activeElement?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog');
  }
  async function loadLibrary(refresh = false, quiet = false) {
    if (loading) return;
    loading = true;
    if (!quiet) {
      $('refresh-library').disabled = true;
      $('refresh-library').textContent = refresh ? '掃描中…' : '讀取中…';
    }
    try {
      const next = await request(`/api/library${refresh ? '?refresh=1' : ''}`);
      if (quiet && (next.revision === library.revision || saving || saveConflict || document.querySelector('dialog[open]') || document.activeElement?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog'))) return;
      indexLibrary(next);
      applyLibraryFileAliases();
      if (!quiet && !saveConflict) notice('');
      if (selection && !(selection.kind === 'track' ? tracks : files).has(selection.id)) selection = null;
      renderAll();
    } catch (error) {
      if (quiet) return;
      notice(`無法讀取曲庫：${error.message}。請確認本機播放器服務仍在運行。`);
      $('scope-count').textContent = '曲庫未連接';
      $('empty-state').innerHTML = '<strong>本機曲庫尚未就緒</strong>服務恢復後，按「刷新曲庫」重試。';
      $('empty-state').hidden = false;
      $('hub-status').textContent = '本機服務未連接';
    } finally {
      loading = false;
      if (!quiet) {
        $('refresh-library').disabled = false;
        $('refresh-library').textContent = '刷新曲庫';
      }
    }
  }
  function isPlaylistView() { return view.startsWith('playlist:'); }
  function activePlaylist() { return isPlaylistView() ? state.playlists.find((item) => item.id === view.slice(9)) : null; }
  function rowsForView() {
    let rows;
    if (view === 'local') rows = library.files.map((file) => ({ kind: 'file', id: file.id, file }));
    else if (view === 'history') rows = state.history.map((entry, index) => ({ kind: 'file', id: entry.fileId, file: files.get(entry.fileId), historyAt: entry.at, index })).filter((row) => row.file);
    else if (isPlaylistView()) rows = (activePlaylist()?.fileIds || []).map((id, index) => ({ kind: 'file', id, file: files.get(id), index }));
    else rows = library.tracks.filter((track) => view !== 'favorites' || favorite(track.id)).map((track) => ({ kind: 'track', id: track.id, track }));
    const needle = query.trim().toLocaleLowerCase();
    rows = rows.filter((row) => {
      if (row.kind === 'track') {
        const track = row.track;
        const ownFiles = [...(track.files || []), ...(track.stems?.files || [])];
        if (needle && ![track.title, ...ownFiles.flatMap((file) => [file.name, file.relativePath])].some((text) => String(text || '').toLocaleLowerCase().includes(needle))) return false;
        const formats = ['mp3', 'wav'].includes(formatFilter) ? [formatFilter] : ['mp3', 'wav'];
        const statuses = formats.map((format) => formatStatus(track, format).status);
        if (statusFilter === 'missing' && !statuses.includes('missing')) return false;
        if (statusFilter === 'uncertain' && !statuses.includes('uncertain')) return false;
        if (statusFilter === 'damaged' && !statuses.includes('damaged')) return false;
        if (statusFilter === 'available' && !preferredFile(track)) return false;
        if (formatFilter === 'stem' && !track.stems?.count) return false;
        if (['mp3', 'wav'].includes(formatFilter) && statusFilter !== 'missing' && !formatStatus(track, formatFilter).count) return false;
      } else {
        const file = row.file;
        if (!file) return !needle && statusFilter !== 'available';
        if (needle && ![file.title, file.name, file.relativePath].some((text) => String(text || '').toLocaleLowerCase().includes(needle))) return false;
        if (formatFilter === 'stem' ? file.kind !== 'stem' : formatFilter !== 'all' && formatOf(file) !== formatFilter) return false;
        if (statusFilter === 'missing') return false;
        if (statusFilter === 'uncertain' && validityOf(file) !== 'uncertain') return false;
        if (statusFilter === 'damaged' && validityOf(file) !== 'damaged') return false;
        if (statusFilter === 'available' && !playable(file)) return false;
      }
      return true;
    });
    if (sort.key !== 'order') rows.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-Hant', { numeric: true })) * sort.direction;
    });
    return rows;
  }
  function sortValue(row, key) {
    const entry = row.track || row.file || {};
    if (key === 'duration') return Number(entry.duration) || 0;
    if (key === 'bytes') return Number(entry.bytes) || 0;
    if (key === 'mp3' || key === 'wav') return formatStatus(row.track, key).status;
    if (key === 'stems') return Number(row.track?.stems?.count) || 0;
    if (key === 'format') return formatOf(row.file);
    if (key === 'path') return entry.relativePath || '';
    return entry.title || entry.name || '';
  }
  function actionButton(action, id, title, glyph, extra = '') {
    return `<button class="icon-button" data-action="${action}" data-id="${esc(id)}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(glyph)}</button>`;
  }
  function renderNavigation() {
    const navItems = [['library', '曲庫', 'library', library.tracks.length], ['local', '本機檔案', 'folder', library.files.length], ['favorites', '收藏', 'heart', state.favorites.filter((id) => tracks.has(id)).length], ['history', '播放歷史', 'history', state.history.length]];
    $('navigation').innerHTML = navItems.map(([id, name, glyph, count]) => `<button class="nav-button ${view === id ? 'active' : ''}" data-view="${id}" ${view === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span><small>${count}</small></button>`).join('');
    $('playlists').innerHTML = state.playlists.map((list) => `<button class="nav-button ${view === `playlist:${list.id}` ? 'active' : ''}" data-view="playlist:${esc(list.id)}" title="${esc(list.name)}">${icon('playlist')}<span>${esc(list.name)}</span><small>${list.fileIds.length}</small></button>`).join('') || '<span class="empty-playlists">按 ＋ 建立播放清單</span>';
    const title = ({ library: '曲庫', local: '本機檔案', favorites: '收藏', history: '播放歷史' })[view] || activePlaylist()?.name || '播放清單';
    $('view-title').textContent = title;
    $('hub-status').textContent = library.hub?.online ? 'ACE Hub 已連接' : '本機曲庫 · Hub 離線';
    $('hub-status').classList.toggle('online', !!library.hub?.online);
    const summary = library.summary || {};
    $('library-summary').textContent = `${summary.songs ?? library.tracks.length} 首歌曲 · ${summary.files ?? library.files.length} 個檔案 · MP3 ${summary.mp3 ?? 0} · WAV ${summary.wav ?? 0}${summary.uncertain ? ` · 待核對 ${summary.uncertain}` : ''}`;
  }
  function renderTable() {
    const rows = rowsForView();
    const fileView = ['local', 'history'].includes(view) || isPlaylistView();
    $('library-table').classList.toggle('file-table', fileView);
    const head = (key, label, cls = '') => `<th class="${cls}" aria-sort="${sort.key === key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}"><button data-sort="${key}" class="${sort.key === key ? 'sort-active' : ''}">${label}${sort.key === key ? sort.direction === 1 ? ' ↑' : ' ↓' : ''}</button></th>`;
    $('table-head').innerHTML = `<tr><th class="play-cell"></th>${head('title', fileView ? '檔案' : '曲名', 'title-cell')}${head('duration', '長度', 'duration-cell')}${fileView ? `${head('format', '格式')}${head('bytes', '大小')}<th>狀態</th>${isPlaylistView() ? '<th>順序</th>' : ''}` : `${head('mp3', 'MP3', 'status-cell')}${head('wav', 'WAV', 'status-cell')}${head('stems', '分軌', 'status-cell')}`}<th class="row-actions"></th></tr>`;
    $('table-body').innerHTML = rows.map((row) => {
      const file = row.file || preferredFile(row.track);
      const title = row.track?.title || row.file?.title || row.file?.name || '檔案已不存在';
      const ownTrack = row.track || currentTrack(row.id);
      const selected = selection && selection.kind === row.kind && selection.id === row.id;
      const playing = activeFileId && (fileView ? activeFileId === row.id : ownTrack && currentTrack(activeFileId)?.id === ownTrack.id);
      const subtitle = fileView ? row.file?.relativePath || '清單仍保留此項目，可移除' : file?.name || (formatStatus(row.track, 'mp3').status === 'uncertain' || formatStatus(row.track, 'wav').status === 'uncertain' ? '本機檔案來源待核對' : '尚無可播放的本機音檔');
      const rowId = `${row.kind}:${row.id}`;
      const buttons = file ? actionButton('queue-add', file.id, '加入播放佇列', 'plus') : '';
      return `<tr data-row="${esc(rowId)}" data-index="${row.index ?? ''}" class="${selected ? 'selected' : ''} ${playing ? 'playing' : ''}" tabindex="0" aria-selected="${!!selected}"><td class="play-cell">${actionButton('row-play', rowId, `播放 ${title}`, 'play', playable(file) ? '' : 'disabled')}</td><td class="title-cell"><span class="song-title" title="${esc(title)}">${esc(title)}</span><span class="song-subtitle" title="${esc(subtitle)}">${esc(subtitle)}</span></td><td class="duration-cell">${time(row.track?.duration || row.file?.duration)}</td>${fileView ? `<td>${esc(formatOf(row.file).toUpperCase() || '—')}</td><td class="duration-cell">${row.file ? size(row.file.bytes) : '—'}</td><td class="status-cell">${row.file ? fileStatusBadge(row.file) : statusBadge('missing')}</td>${isPlaylistView() ? `<td class="order-cell">${actionButton('playlist-up', row.index, '向上移動', 'up', row.index === 0 ? 'disabled' : '')}${actionButton('playlist-down', row.index, '向下移動', 'down', row.index === activePlaylist().fileIds.length - 1 ? 'disabled' : '')}${actionButton('playlist-remove', row.index, '從清單移除', 'close')}</td>` : ''}` : `<td class="status-cell">${statusBadge(formatStatus(row.track, 'mp3').status, formatStatus(row.track, 'mp3').count)}</td><td class="status-cell">${statusBadge(formatStatus(row.track, 'wav').status, formatStatus(row.track, 'wav').count)}</td><td class="status-cell">${statusBadge(row.track.stems?.status || 'missing', row.track.stems?.count)}</td>`}<td class="row-actions">${buttons}${ownTrack ? actionButton('favorite', ownTrack.id, favorite(ownTrack.id) ? '取消收藏' : '收藏', 'heart', `aria-pressed="${favorite(ownTrack.id)}"`) : ''}</td></tr>`;
    }).join('');
    $('scope-count').textContent = `顯示 ${rows.length} ${fileView ? '個檔案' : '首歌曲'}${query || statusFilter !== 'all' || formatFilter !== 'all' ? ' · 已篩選' : ''}`;
    const actions = [];
    if (rows.some((row) => playable(row.file || preferredFile(row.track)))) actions.push('<button data-command="play-visible">播放目前清單</button>');
    if (isPlaylistView()) actions.push('<button data-command="rename-playlist">改名</button><button data-command="delete-playlist">刪除清單</button>');
    if (view === 'history' && state.history.length) actions.push('<button data-command="clear-history">清除歷史</button>');
    $('view-actions').innerHTML = actions.join('');
    $('empty-state').hidden = rows.length > 0;
    $('empty-state').innerHTML = `<strong>${query || statusFilter !== 'all' || formatFilter !== 'all' ? '沒有符合的項目' : view === 'favorites' ? '還沒有收藏歌曲' : isPlaylistView() ? '這張清單還沒有音樂' : view === 'history' ? '播放過的檔案會留在這裡' : '本機曲庫目前沒有歌曲'}</strong>${isPlaylistView() ? '選一首歌曲，在右側加入這張清單。' : '調整篩選條件，或刷新本機曲庫。'}`;
  }
  function selectRow(kind, id) {
    selection = { kind, id };
    document.querySelectorAll('#table-body tr').forEach((row) => { const selected = row.dataset.row === `${kind}:${id}`; row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); });
    inspectorTab = 'details';
    renderInspector();
  }
  function fileCard(file, kind = '') {
    if (!file) return '';
    return `<div class="file-card"><div class="file-card-head"><strong>${esc(kind || formatOf(file).toUpperCase())}</strong>${fileStatusBadge(file)}</div><p>${esc(file.relativePath || file.name)}</p><div class="file-meta"><span>${size(file.bytes)}${file.duration ? ` · ${time(file.duration)}` : ''}</span><span class="file-buttons">${actionButton('file-play', file.id, '播放此檔案', 'play', playable(file) ? '' : 'disabled')}${actionButton('queue-add', file.id, '加入播放佇列', 'plus', playable(file) ? '' : 'disabled')}${actionButton('reveal', file.id, '開啟所在資料夾', 'reveal')}</span></div></div>`;
  }
  function renderInspector() {
    $('detail-tab').setAttribute('aria-selected', String(inspectorTab === 'details'));
    $('queue-tab').setAttribute('aria-selected', String(inspectorTab === 'queue'));
    $('detail-content').hidden = inspectorTab !== 'details';
    $('queue-content').hidden = inspectorTab !== 'queue';
    const selectedTrack = selection?.kind === 'track' ? tracks.get(selection.id) : selection ? currentTrack(selection.id) : null;
    const selectedFile = selection?.kind === 'file' ? files.get(selection.id) : preferredFile(selectedTrack);
    if (!selection) $('detail-content').innerHTML = '<div class="inspector-empty">選一首歌曲，查看實際檔案、格式與下載狀態。<br><br>「有紀錄」與「待核對」不代表來源已驗證。</div>';
    else {
      const title = selectedTrack?.title || selectedFile?.title || selectedFile?.name || '檔案已不存在';
      const fullFiles = selection.kind === 'file' ? selectedFile ? [selectedFile] : [] : selectedTrack?.files || [];
      const stemFiles = selection.kind === 'track' ? selectedTrack?.stems?.files || [] : [];
      $('detail-content').innerHTML = `<h2>${esc(title)}</h2><div class="detail-kicker">${time(selectedTrack?.duration || selectedFile?.duration)} · ${selection.kind === 'file' ? '本機檔案' : '歌曲與本機音檔'}</div><div class="detail-actions"><button class="primary" data-action="file-play" data-id="${esc(selectedFile?.id || '')}" ${playable(selectedFile) ? '' : 'disabled'}>播放</button><button data-action="add-to-playlist" data-id="${esc(selectedFile?.id || '')}" ${selectedFile ? '' : 'disabled'}>加入清單</button>${selectedTrack ? `<button data-action="favorite" data-id="${esc(selectedTrack.id)}">${favorite(selectedTrack.id) ? '已收藏' : '收藏'}</button>` : ''}</div>${selectedTrack ? `<div class="file-meta">MP3 ${statusBadge(formatStatus(selectedTrack, 'mp3').status)} · WAV ${statusBadge(formatStatus(selectedTrack, 'wav').status)}</div>` : ''}<div class="section-caption"><span>本機檔案</span><span>${fullFiles.length}</span></div>${fullFiles.map((file) => fileCard(files.get(file.id) || file)).join('') || '<p class="muted">尚未找到可對應的本機音檔。</p>'}${stemFiles.length ? `<div class="section-caption"><span>分軌檔案</span><span>${stemFiles.length} 軌</span></div>${stemFiles.map((file) => fileCard(files.get(file.id) || file, file.name)).join('')}` : ''}`;
    }
    renderQueue();
  }
  function renderQueue() {
    $('queue-count').textContent = state.queue.length;
    $('clear-queue').disabled = !state.queue.length;
    $('queue-list').innerHTML = state.queue.map((id, index) => {
      const file = files.get(id);
      return `<li class="queue-row ${id === state.currentFileId ? 'current' : ''}"><span class="queue-number">${index + 1}</span><button class="queue-name" data-action="queue-play" data-id="${esc(id)}" ${playable(file) ? '' : 'disabled'}>${esc(currentTrack(id)?.title || file?.title || file?.name || '檔案已不存在')}<small>${esc(formatOf(file).toUpperCase())}${file?.duration ? ` · ${time(file.duration)}` : ''}</small></button>${actionButton('queue-remove', index, '移出播放佇列', 'close')}</li>`;
    }).join('') || '<li class="inspector-empty queue-empty">佇列還是空的。按歌曲旁的 ＋ 加入。</li>';
  }
  function renderTransport() {
    const actualFile = files.get(state.currentFileId);
    const fallback = state.currentFileId === activeFileId ? playbackSnapshot : null;
    const file = actualFile || fallback?.file;
    const track = currentTrack() || fallback?.track;
    $('now-title').textContent = track?.title || file?.title || file?.name || '選一首歌，開始播放';
    $('now-subtitle').textContent = file ? `${formatOf(file).toUpperCase()} · ${file.kind === 'stem' ? '分軌' : '本機音檔'} · ${actualFile ? fileStatusText(file) : '檔案對應待核對'}` : '點兩下歌曲，或按歌曲旁的播放鍵';
    $('play-pause').innerHTML = icon(audio.paused ? 'play' : 'pause');
    $('play-pause').setAttribute('aria-label', audio.paused ? '播放' : '暫停');
    $('shuffle').innerHTML = icon('shuffle');
    $('shuffle').setAttribute('aria-pressed', String(state.shuffle));
    $('repeat').innerHTML = icon(state.repeat === 'one' ? 'repeatOne' : 'repeat');
    $('repeat').classList.toggle('active', state.repeat !== 'off');
    $('repeat').setAttribute('aria-label', ({ off: '循環關閉', all: '清單循環', one: '單曲循環' })[state.repeat]);
    $('repeat').title = ({ off: '循環：關閉', all: '循環：整份佇列', one: '循環：單曲' })[state.repeat];
    $('now-favorite').disabled = !track;
    $('now-favorite').innerHTML = icon('heart', !!track && favorite(track.id));
    $('now-favorite').setAttribute('aria-pressed', String(!!track && favorite(track.id)));
    $('volume').value = Math.round(state.volume * 100);
    $('volume-value').textContent = Math.round(state.volume * 100);
    $('mute').innerHTML = icon(state.volume === 0 ? 'muted' : 'volume');
    $('mute').setAttribute('aria-label', state.volume === 0 ? '恢復音量' : '靜音');
    updateTime();
  }
  function renderAll() { renderNavigation(); renderTable(); renderInspector(); renderTransport(); }
  function selectExternalSong(id) {
    const track = tracks.get(id) || trackForSong.get(id);
    if (!track) { toast('目前曲庫找不到這首歌，請刷新後再試'); return; }
    // The opaque ID selects an existing record only; it is never a URL or request payload.
    document.body.classList.remove('compact-mode');
    view = 'library'; query = ''; statusFilter = formatFilter = 'all';
    $('search').value = ''; $('status-filter').value = 'all'; $('format-filter').value = 'all';
    renderAll();
    selectRow('track', track.id);
    if (matchMedia('(max-width: 1080px)').matches) {
      document.body.classList.add('inspector-open');
      $('toggle-inspector').setAttribute('aria-expanded', 'true');
    }
    const row = [...$('table-body').querySelectorAll('[data-row]')].find((node) => node.dataset.row === 'track:' + track.id);
    row?.scrollIntoView({ block: 'nearest' });
  }
  function selectRequestedSong() {
    const id = new URLSearchParams(location.search).get('song');
    if (id) selectExternalSong(id);
  }
  async function pollExternalSelection() {
    if (!initialized || selectionPolling) return;
    selectionPolling = true;
    try {
      const selected = await request('/api/selection', { signal: AbortSignal.timeout(2000) });
      if (!Number.isSafeInteger(selected.serial) || selected.serial < 0) return;
      const initial = selectionSerial === null;
      if (!initial && selected.serial <= selectionSerial) return;
      selectionSerial = selected.serial;
      // An explicit launch query takes precedence over an older server selection.
      if (initial && new URLSearchParams(location.search).has('song')) return;
      if (typeof selected.songId === 'string' && selected.songId) selectExternalSong(selected.songId);
    } catch (_) { /* Losing the local selection channel never interrupts audio. */ }
    finally { selectionPolling = false; }
  }
  function startSelectionPolling() {
    clearInterval(selectionPoller);
    selectionPoller = setInterval(pollExternalSelection, 1000);
    pollExternalSelection();
  }
  async function pollLibraryRevision() {
    if (!initialized || libraryPolling || loading) return;
    libraryPolling = true;
    try {
      const head = await request('/api/library/revision', { signal: AbortSignal.timeout(4000) });
      if (!head.ok || typeof head.revision !== 'string' || !head.revision || head.revision === library.revision || libraryRefreshDeferred()) return;
      await loadLibrary(false, true);
    } catch (_) { /* Quiet refresh must never replace playback or an editing draft with an error screen. */ }
    finally { libraryPolling = false; }
  }
  function startLibraryPolling() {
    clearInterval(libraryPoller);
    libraryPoller = setInterval(pollLibraryRevision, 5000);
  }
  function switchView(next) {
    view = next;
    sort = { key: isPlaylistView() || view === 'history' ? 'order' : 'title', direction: 1 };
    renderAll();
  }
  function toggleFavorite(id) {
    if (!tracks.has(id)) return;
    state.favorites = favorite(id) ? state.favorites.filter((item) => item !== id) : [...state.favorites, id];
    changed();
    renderAll();
  }
  function queueAdd(id) {
    if (!playable(files.get(id))) return toast('此檔案目前無法播放');
    if (state.queue.includes(id)) return toast('此檔案已在播放佇列');
    state.queue.push(id);
    changed();
    renderQueue();
    preloadNext();
    toast('已加入播放佇列');
  }
  function visibleFileIds() { return rowsForView().map((row) => row.file || preferredFile(row.track)).filter(playable).map((file) => file.id); }
  function playFromTable(kind, id) {
    const file = kind === 'track' ? preferredFile(tracks.get(id)) : files.get(id);
    if (!playable(file)) return toast(preferredFormat === 'wav' ? '此歌曲沒有可播放的本機 WAV；可切換播放格式' : '尚無可播放的本機音檔');
    selectRow(kind, id);
    state.queue = visibleFileIds();
    if (!state.queue.includes(file.id)) state.queue.push(file.id);
    playFile(file.id);
  }
  function rememberHistory(id) {
    state.history.unshift({ fileId: id, at: Date.now() });
    state.history = state.history.slice(0, 500);
    changed();
    renderNavigation();
  }
  function shuffled(ids) {
    const out = [...ids];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [out[index], out[target]] = [out[target], out[index]];
    }
    return out;
  }
  function saveShuffleCycle() {
    try { localStorage.setItem(SHUFFLE_KEY, JSON.stringify({ ...shuffleCycle, currentFileId: state.currentFileId })); } catch (_) { /* The in-memory cycle remains finite if storage is unavailable. */ }
  }
  function resetShuffleCycle(anchor = state.currentFileId) {
    const queue = state.queue.filter((id) => playable(files.get(id)));
    const rest = [...queue];
    const index = rest.indexOf(anchor);
    if (index !== -1) rest.splice(index, 1);
    shuffleCycle = { order: index !== -1 ? [anchor, ...shuffled(rest)] : shuffled(rest), cursor: index !== -1 ? 0 : -1, signature: JSON.stringify(queue) };
    followingShuffleCycle = null;
    saveShuffleCycle();
  }
  function reconcileShuffleCycle() {
    const queue = state.queue.filter((id) => playable(files.get(id)));
    const signature = JSON.stringify(queue);
    if (!shuffleCycle.signature) { resetShuffleCycle(); return; }
    if (signature === shuffleCycle.signature) return;
    // Preserve the consumed prefix even if the currently playing file was removed.
    // Rebuilding from just currentFileId would put already-played songs back in front.
    const consumed = shuffleCycle.order.slice(0, shuffleCycle.cursor + 1);
    const counts = new Map();
    for (const id of queue) counts.set(id, (counts.get(id) || 0) + 1);
    for (const id of consumed) if (counts.get(id)) counts.set(id, counts.get(id) - 1);
    const remaining = [];
    for (const id of shuffleCycle.order.slice(shuffleCycle.cursor + 1)) {
      if (!counts.get(id)) continue;
      remaining.push(id); counts.set(id, counts.get(id) - 1);
    }
    const added = [];
    for (const [id, count] of counts) for (let n = 0; n < count; n += 1) added.push(id);
    for (const id of shuffled(added)) remaining.splice(Math.floor(Math.random() * (remaining.length + 1)), 0, id);
    shuffleCycle = { order: [...consumed, ...remaining], cursor: consumed.length - 1, signature };
    followingShuffleCycle = null;
    saveShuffleCycle();
  }
  function loadShuffleCycle() {
    try {
      const saved = mapCycleAliases(JSON.parse(localStorage.getItem(SHUFFLE_KEY)));
      if (saved && Array.isArray(saved.order) && saved.order.length <= 10000 && saved.order.every((id) => typeof id === 'string') && Number.isInteger(saved.cursor) && saved.cursor >= -1 && saved.cursor < saved.order.length && typeof saved.signature === 'string' && saved.currentFileId === state.currentFileId) {
        shuffleCycle = { order: saved.order, cursor: saved.cursor, signature: saved.signature };
        reconcileShuffleCycle();
        return;
      }
    } catch (_) { /* Reconstruct a single finite cycle when the saved order is unavailable. */ }
    resetShuffleCycle();
  }
  function shuffleNeighbor(direction = 1) {
    reconcileShuffleCycle();
    for (let index = shuffleCycle.cursor + direction; index >= 0 && index < shuffleCycle.order.length; index += direction) {
      const id = shuffleCycle.order[index];
      if (playable(files.get(id)) && !failedFiles.has(id)) return { id, index, restart: false };
    }
    if (direction < 0 || state.repeat !== 'all') return null;
    const queue = state.queue.filter((id) => playable(files.get(id)) && !failedFiles.has(id));
    if (!queue.length) return null;
    if (!followingShuffleCycle) {
      followingShuffleCycle = shuffled(queue);
      if (followingShuffleCycle.length > 1 && followingShuffleCycle[0] === state.currentFileId) {
        const other = followingShuffleCycle.findIndex((id) => id !== state.currentFileId);
        if (other !== -1) [followingShuffleCycle[0], followingShuffleCycle[other]] = [followingShuffleCycle[other], followingShuffleCycle[0]];
      }
    }
    return { id: followingShuffleCycle[0], index: 0, restart: true };
  }
  function advanceShuffle(plan) {
    if (plan.restart) {
      shuffleCycle = { order: followingShuffleCycle, cursor: plan.index, signature: JSON.stringify(state.queue.filter((id) => playable(files.get(id)))) };
      followingShuffleCycle = null;
    } else shuffleCycle.cursor = plan.index;
    saveShuffleCycle();
  }
  function saveLinearCycle() {
    try { localStorage.setItem(LINEAR_KEY, JSON.stringify({ ...linearCycle, currentFileId: state.currentFileId })); } catch (_) { /* In-memory cursor still keeps repeated file IDs finite. */ }
  }
  function resetLinearCycle(anchor = state.currentFileId) {
    const order = state.queue.filter((id) => playable(files.get(id)));
    linearCycle = { order, cursor: order.indexOf(anchor), signature: JSON.stringify(order) };
    saveLinearCycle();
  }
  function reconcileLinearCycle() {
    const queue = state.queue.filter((id) => playable(files.get(id)));
    const signature = JSON.stringify(queue);
    if (!linearCycle.signature) { resetLinearCycle(); return; }
    if (signature === linearCycle.signature) return;
    const consumed = linearCycle.order.slice(0, linearCycle.cursor + 1);
    const counts = new Map();
    for (const id of queue) counts.set(id, (counts.get(id) || 0) + 1);
    for (const id of consumed) if (counts.get(id)) counts.set(id, counts.get(id) - 1);
    const remaining = queue.filter((id) => { if (!counts.get(id)) return false; counts.set(id, counts.get(id) - 1); return true; });
    linearCycle = { order: [...consumed, ...remaining], cursor: consumed.length - 1, signature };
    saveLinearCycle();
  }
  function loadLinearCycle() {
    try {
      const saved = mapCycleAliases(JSON.parse(localStorage.getItem(LINEAR_KEY)));
      if (saved && Array.isArray(saved.order) && saved.order.length <= 10000 && saved.order.every((id) => typeof id === 'string') && Number.isInteger(saved.cursor) && saved.cursor >= -1 && saved.cursor < saved.order.length && typeof saved.signature === 'string' && saved.currentFileId === state.currentFileId) {
        linearCycle = { order: saved.order, cursor: saved.cursor, signature: saved.signature };
        reconcileLinearCycle(); return;
      }
    } catch (_) { /* Reconstruct from the current queue when there is no saved cursor. */ }
    resetLinearCycle();
  }
  function linearNeighbor(direction = 1) {
    reconcileLinearCycle();
    for (let index = linearCycle.cursor + direction; index >= 0 && index < linearCycle.order.length; index += direction) {
      const id = linearCycle.order[index];
      if (playable(files.get(id)) && !failedFiles.has(id)) return { id, index };
    }
    if (state.repeat !== 'all') return null;
    const order = state.queue.filter((id) => playable(files.get(id)));
    for (let index = direction > 0 ? 0 : order.length - 1; index >= 0 && index < order.length; index += direction) {
      if (!failedFiles.has(order[index])) return { id: order[index], index, order };
    }
    return null;
  }
  function advanceLinear(plan) {
    if (plan.order) linearCycle = { order: plan.order, cursor: plan.index, signature: JSON.stringify(state.queue.filter((id) => playable(files.get(id)))) };
    else linearCycle.cursor = plan.index;
    saveLinearCycle();
  }
  async function playFile(id, { keepFailures = false, resume = 0, sequence = false } = {}) {
    const file = files.get(id);
    if (!playable(file)) return toast('此檔案目前無法播放；請查看檔案狀態');
    playbackSnapshot = { file, track: currentTrack(id) };
    if (!keepFailures) failedFiles = new Set();
    playbackRequested = true;
    restoringAudio = false;
    state.currentFileId = id;
    if (state.shuffle && !sequence) resetShuffleCycle(id);
    if (!sequence) resetLinearCycle(id);
    if (activeFileId !== id) {
      activeFileId = id;
      state.currentFileId = id;
      state.currentTime = resume;
      pendingSeek = resume;
      audio.src = `/media/${encodeURIComponent(id)}`;
      audio.load();
      rememberHistory(id);
      setMediaMetadata(file);
    } else if (sequence) { audio.currentTime = resume || 0; rememberHistory(id); }
    else if (resume) audio.currentTime = resume;
    if (state.shuffle) saveShuffleCycle();
    else saveLinearCycle();
    changed();
    renderTable();
    renderQueue();
    renderTransport();
    try { await audio.play(); preloadNext(); }
    catch (error) {
      if (error.name === 'NotAllowedError') toast('按播放鍵開始播放');
      else if (error.name !== 'AbortError') handlePlaybackError();
    }
  }
  function restoreCurrentFile() {
    const file = files.get(state.currentFileId);
    restoringAudio = true;
    playbackRequested = false;
    audio.pause();
    audio.volume = state.volume;
    if (!playable(file)) { activeFileId = null; audio.removeAttribute('src'); audio.load(); restoringAudio = false; return; }
    playbackSnapshot = { file, track: currentTrack(file.id) };
    activeFileId = file.id;
    pendingSeek = state.currentTime;
    audio.src = `/media/${encodeURIComponent(file.id)}`;
    audio.load();
    setMediaMetadata(file);
  }
  async function togglePlay() {
    if (audio.src && activeFileId) {
      if (!audio.paused) audio.pause();
      else {
        failedFiles = new Set();
        playbackRequested = true;
        try { await audio.play(); } catch (error) { if (error.name !== 'AbortError') toast('無法播放此檔案，請檢查本機服務與檔案狀態'); }
      }
      return;
    }
    if (!state.queue.length) state.queue = visibleFileIds();
    const plan = state.shuffle ? shuffleNeighbor(1) : null;
    const first = state.shuffle ? plan?.id : state.queue.find((id) => playable(files.get(id)));
    if (first) { if (plan) advanceShuffle(plan); await playFile(first, { sequence: !!plan }); }
    else toast('目前沒有可播放的本機音檔');
  }
  function nextFileId(direction = 1) {
    if (state.shuffle) return shuffleNeighbor(direction)?.id || null;
    return linearNeighbor(direction)?.id || null;
  }
  function next(direction = 1, ended = false) {
    if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; state.currentTime = 0; changed(); return; }
    if (ended && state.repeat === 'one' && activeFileId) { audio.currentTime = 0; audio.play().catch(() => toast('請按播放鍵繼續')); return; }
    const shufflePlan = state.shuffle ? shuffleNeighbor(direction) : null;
    const linearPlan = state.shuffle ? null : linearNeighbor(direction);
    const id = state.shuffle ? shufflePlan?.id : linearPlan?.id;
    if (id) { if (shufflePlan) advanceShuffle(shufflePlan); if (linearPlan) advanceLinear(linearPlan); playFile(id, { keepFailures: ended, sequence: true }); }
    else if (ended) { audio.pause(); audio.currentTime = 0; state.currentTime = 0; changed(); renderTransport(); }
    else toast(direction < 0 ? '已是佇列第一首' : '已是佇列最後一首');
  }
  function preloadNext() {
    const id = nextFileId(1);
    const nextSource = id && id !== state.currentFileId ? `/media/${encodeURIComponent(id)}` : '';
    if (!nextSource) { preloadAudio.removeAttribute('src'); preloadAudio.load(); return; }
    if (preloadAudio.getAttribute('src') !== nextSource) { preloadAudio.src = nextSource; preloadAudio.load(); }
  }
  function handlePlaybackError() {
    restoringAudio = false;
    if (!playbackRequested) { renderTransport(); return; }
    if (!activeFileId || failedFiles.has(activeFileId)) return;
    failedFiles.add(activeFileId);
    const shufflePlan = state.shuffle ? shuffleNeighbor(1) : null;
    const linearPlan = state.shuffle ? null : linearNeighbor(1);
    const nextId = state.shuffle ? shufflePlan?.id : linearPlan?.id;
    if (nextId && !failedFiles.has(nextId)) {
      toast('這個檔案無法播放，已跳到下一個可用檔案');
      if (shufflePlan) advanceShuffle(shufflePlan);
      if (linearPlan) advanceLinear(linearPlan);
      playFile(nextId, { keepFailures: true, sequence: true });
    } else {
      audio.pause();
      toast('佇列中的可用檔案無法播放，已停止；請檢查檔案狀態');
      renderTransport();
    }
  }
  function setMediaMetadata(file) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: currentTrack(file.id)?.title || file.title || file.name, artist: '壞 DJ · 本機曲庫', album: file.kind === 'stem' ? '分軌' : 'HuaiDJ PLAYER' }); } catch (_) { /* Older hosts may not expose MediaMetadata. */ }
  }
  function updateTime() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number(files.get(state.currentFileId)?.duration) || 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : state.currentTime || 0;
    $('elapsed').textContent = time(current);
    $('duration').textContent = time(duration);
    $('seek').disabled = !duration || !activeFileId;
    if (document.activeElement !== $('seek')) $('seek').value = duration ? Math.round(current / duration * 1000) : 0;
    if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.duration, current) }); } catch (_) { /* Position reporting is optional. */ }
    }
  }
  function openPlaylistDialog(id = null) {
    editingPlaylistId = id;
    $('playlist-dialog-title').textContent = id ? '重新命名播放清單' : '新增播放清單';
    $('playlist-name').value = state.playlists.find((item) => item.id === id)?.name || '';
    $('playlist-dialog').showModal();
    $('playlist-name').focus();
  }
  function addToPlaylist(ids) {
    addingFileIds = ids.filter((id) => files.has(id));
    if (!addingFileIds.length) return;
    if (!state.playlists.length) { toast('請先在左側按 ＋ 建立播放清單'); return; }
    $('add-playlist-choice').innerHTML = state.playlists.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    $('add-description').textContent = `加入 ${addingFileIds.length} 個本機音檔。`;
    $('add-dialog').showModal();
  }
  function editPlaylistFile(action, index) {
    const list = activePlaylist();
    if (!list || !Number.isInteger(index) || index < 0 || index >= list.fileIds.length) return;
    if (action === 'playlist-remove') list.fileIds.splice(index, 1);
    else {
      const target = index + (action === 'playlist-up' ? -1 : 1);
      if (target < 0 || target >= list.fileIds.length) return;
      [list.fileIds[index], list.fileIds[target]] = [list.fileIds[target], list.fileIds[index]];
      sort = { key: 'order', direction: 1 };
    }
    changed();
    renderAll();
  }
  async function dispatchAction(action, id) {
    if (action === 'row-play') { const split = id.indexOf(':'); playFromTable(id.slice(0, split), id.slice(split + 1)); }
    else if (action === 'file-play' || action === 'queue-play') { if (!state.queue.includes(id)) state.queue.push(id); playFile(id); }
    else if (action === 'queue-add') queueAdd(id);
    else if (action === 'favorite') toggleFavorite(id);
    else if (action === 'queue-remove') { state.queue.splice(Number(id), 1); changed(); renderQueue(); preloadNext(); }
    else if (action === 'reveal') { try { await request('/api/reveal', { method: 'POST', body: JSON.stringify({ fileId: id }) }); } catch (error) { toast(`無法開啟資料夾：${error.message}`); } }
    else if (action === 'add-to-playlist') addToPlaylist([id]);
    else if (action.startsWith('playlist-')) editPlaylistFile(action, Number(id));
  }
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) { dispatchAction(action.dataset.action, action.dataset.id); return; }
    const nav = event.target.closest('[data-view]');
    if (nav) { switchView(nav.dataset.view); return; }
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) { sort = { key: sortButton.dataset.sort, direction: sort.key === sortButton.dataset.sort ? -sort.direction : 1 }; renderTable(); return; }
    const row = event.target.closest('tr[data-row]');
    if (row) { const split = row.dataset.row.indexOf(':'); selectRow(row.dataset.row.slice(0, split), row.dataset.row.slice(split + 1)); }
    const command = event.target.closest('[data-command]')?.dataset.command;
    if (command === 'play-visible') { state.queue = visibleFileIds(); if (state.queue[0]) playFile(state.queue[0]); }
    else if (command === 'rename-playlist') openPlaylistDialog(activePlaylist()?.id);
    else if (command === 'delete-playlist') {
      const list = activePlaylist();
      if (list && confirm(`刪除播放清單「${list.name}」？本機音檔會保留。`)) { state.playlists = state.playlists.filter((item) => item.id !== list.id); changed(); switchView('library'); }
    } else if (command === 'clear-history') { state.history = []; changed(); renderAll(); }
  });
  $('table-body').addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    const row = event.target.closest('[data-row]');
    if (row) { const split = row.dataset.row.indexOf(':'); playFromTable(row.dataset.row.slice(0, split), row.dataset.row.slice(split + 1)); }
  });
  $('table-body').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('tr[data-row]')) { const id = event.target.dataset.row; const split = id.indexOf(':'); playFromTable(id.slice(0, split), id.slice(split + 1)); }
  });
  $('search').addEventListener('input', (event) => { query = event.target.value; renderTable(); });
  $('status-filter').addEventListener('change', (event) => { statusFilter = event.target.value; renderTable(); });
  $('format-filter').addEventListener('change', (event) => { formatFilter = event.target.value; renderTable(); });
  $('play-format').addEventListener('change', (event) => {
    preferredFormat = event.target.value;
    try { localStorage.setItem('huaidj-player-format', preferredFormat); } catch (_) { /* Local UI preferences are optional. */ }
    renderTable(); renderInspector();
    toast('播放格式已更新；目前播放保持不變');
  });
  $('refresh-library').addEventListener('click', () => initialized ? loadLibrary(true) : start());
  function compactMode(enabled) {
    document.body.classList.toggle('compact-mode', enabled);
    document.body.classList.remove('inspector-open');
    $('toggle-inspector').setAttribute('aria-expanded', 'false');
    try { localStorage.setItem('huaidj-player-compact', String(enabled)); } catch (_) { /* This presentation choice is optional. */ }
  }
  $('compact-toggle').addEventListener('click', () => compactMode(true));
  $('compact-exit').addEventListener('click', () => compactMode(false));
  $('toggle-inspector').addEventListener('click', () => { const open = document.body.classList.toggle('inspector-open'); $('toggle-inspector').setAttribute('aria-expanded', String(open)); });
  $('close-inspector').addEventListener('click', () => { document.body.classList.remove('inspector-open'); $('toggle-inspector').setAttribute('aria-expanded', 'false'); });
  $('detail-tab').addEventListener('click', () => { inspectorTab = 'details'; renderInspector(); });
  $('queue-tab').addEventListener('click', () => { inspectorTab = 'queue'; renderInspector(); });
  $('clear-queue').addEventListener('click', () => { state.queue = []; changed(); renderQueue(); preloadNext(); toast('佇列已清空；目前播放保持不變'); });
  $('new-playlist').addEventListener('click', () => openPlaylistDialog());
  $('cancel-playlist').addEventListener('click', () => $('playlist-dialog').close());
  $('cancel-add').addEventListener('click', () => $('add-dialog').close());
  $('recovery-choice').addEventListener('change', renderRecoveryComparison);
  $('close-recovery').addEventListener('click', () => $('recovery-dialog').close());
  $('apply-recovery').addEventListener('click', applyRecoveryDraft);
  $('export-recovery').addEventListener('click', () => {
    const draft = recoveryDrafts.find((item) => item.key === $('recovery-choice').value);
    if (!draft) return;
    const { key, ...saved } = draft;
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'huaidj-player-draft-' + Date.now() + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  $('discard-recovery').addEventListener('click', () => {
    const draft = recoveryDrafts.find((item) => item.key === $('recovery-choice').value);
    if (!draft || !confirm('捨棄這份本機未儲存草稿？伺服器已儲存的資料會保留。')) return;
    try { localStorage.removeItem(draft.key); } catch (_) { return journalFailure(); }
    $('recovery-dialog').close(); discoverRecoveryDrafts();
  });
  $('playlist-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('playlist-name').value.trim();
    if (!name) return;
    const existing = state.playlists.find((item) => item.id === editingPlaylistId);
    if (existing) existing.name = name;
    else state.playlists.push({ id: crypto.randomUUID(), name, fileIds: [] });
    changed();
    $('playlist-dialog').close();
    renderAll();
  });
  $('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const list = state.playlists.find((item) => item.id === $('add-playlist-choice').value);
    if (!list) return;
    list.fileIds.push(...addingFileIds);
    changed();
    $('add-dialog').close();
    renderAll();
    toast(`已加入「${list.name}」`);
  });
  $('play-pause').addEventListener('click', togglePlay);
  $('previous').innerHTML = icon('previous');
  $('next').innerHTML = icon('next');
  $('previous').addEventListener('click', () => next(-1));
  $('next').addEventListener('click', () => next(1));
  $('shuffle').addEventListener('click', () => { state.shuffle = !state.shuffle; if (state.shuffle) resetShuffleCycle(); else resetLinearCycle(); changed(); renderTransport(); preloadNext(); });
  $('repeat').addEventListener('click', () => { state.repeat = ({ off: 'all', all: 'one', one: 'off' })[state.repeat]; changed(); renderTransport(); preloadNext(); });
  $('now-favorite').addEventListener('click', () => { const track = currentTrack(); if (track) toggleFavorite(track.id); });
  $('volume').addEventListener('input', (event) => { state.volume = Number(event.target.value) / 100; audio.volume = state.volume; changed(); renderTransport(); });
  $('mute').addEventListener('click', () => { if (state.volume) { previousVolume = state.volume; state.volume = 0; } else state.volume = previousVolume || .8; audio.volume = state.volume; changed(); renderTransport(); });
  $('seek').addEventListener('input', (event) => { const duration = Number.isFinite(audio.duration) ? audio.duration : 0; $('elapsed').textContent = time(Number(event.target.value) / 1000 * duration); });
  $('seek').addEventListener('change', (event) => { if (Number.isFinite(audio.duration)) { audio.currentTime = Number(event.target.value) / 1000 * audio.duration; state.currentTime = audio.currentTime; changed(); updateTime(); } });
  audio.addEventListener('loadedmetadata', () => { if (pendingSeek && Number.isFinite(audio.duration)) audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - .1)); pendingSeek = 0; restoringAudio = false; updateTime(); });
  audio.addEventListener('timeupdate', () => {
    if (restoringAudio) { updateTime(); return; }
    state.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    updateTime();
    if (!audio.paused && Date.now() - lastTimeSave > 5000) { lastTimeSave = Date.now(); changed(); }
  });
  audio.addEventListener('play', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; renderTransport(); });
  audio.addEventListener('pause', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; if (initialized && !restoringAudio) changed(); renderTransport(); });
  audio.addEventListener('ended', () => next(1, true));
  audio.addEventListener('error', handlePlaybackError);
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"],dialog') || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space' && !event.altKey && !event.target.closest('button')) { event.preventDefault(); togglePlay(); }
    if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); next(event.key === 'ArrowLeft' ? -1 : 1); }
    if (event.key === 'Escape') { document.body.classList.remove('inspector-open'); $('toggle-inspector').setAttribute('aria-expanded', 'false'); }
  });
  window.addEventListener('pagehide', () => { clearInterval(selectionPoller); clearInterval(libraryPoller); if (!restoringAudio && Number.isFinite(audio.currentTime)) state.currentTime = audio.currentTime; saveVersion += 1; persistPendingJournal(); saveShuffleCycle(); saveLinearCycle(); flushSave(true); });
  if ('mediaSession' in navigator) {
    const handlers = { play: () => { if (audio.paused) togglePlay(); }, pause: () => audio.pause(), previoustrack: () => next(-1), nexttrack: () => next(1), seekto: (details) => { if (Number.isFinite(details.seekTime)) { audio.currentTime = details.seekTime; state.currentTime = details.seekTime; changed(); } }, seekbackward: (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); }, seekforward: (details) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10)); } };
    for (const [name, handler] of Object.entries(handlers)) try { navigator.mediaSession.setActionHandler(name, handler); } catch (_) { /* Hosts expose different media key sets. */ }
  }
  async function start() {
    try {
      const saved = localStorage.getItem('huaidj-player-format');
      if (['auto', 'mp3', 'wav'].includes(saved)) preferredFormat = saved;
      document.body.classList.toggle('compact-mode', localStorage.getItem('huaidj-player-compact') === 'true');
    } catch (_) { /* Private windows may block storage. */ }
    $('play-format').value = preferredFormat;
    renderTransport();
    try {
      const [libraryData, stateData] = await Promise.all([request('/api/library'), request('/api/state')]);
      indexLibrary(libraryData);
      state = normalizedState(stateData);
      lastSavedSnapshot = canonicalSnapshot(state);
      initialized = true;
      applyLibraryFileAliases();
      loadShuffleCycle();
      loadLinearCycle();
      cyclesLoaded = true;
      restoreCurrentFile();
      renderAll();
      selectRequestedSong();
      discoverRecoveryDrafts();
      startSelectionPolling();
      startLibraryPolling();
      $('save-status').textContent = '播放資料已載入';
    } catch (error) {
      notice(`本機播放器尚未就緒：${error.message}。請確認服務已啟動，再刷新頁面。`);
      $('scope-count').textContent = '無法讀取本機曲庫';
      $('empty-state').innerHTML = '<strong>本機服務未連接</strong>曲庫與播放資料尚未載入；不會修改原有資料。';
      $('empty-state').hidden = false;
    }
  }
  start();
})();
