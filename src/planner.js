// planner.js — songs + options → 下載清單（純函式，不做任何網路或 chrome API 呼叫）。
// 依賴 naming.js（globalThis.AceDLNaming），載入順序：naming.js → planner.js。
// 同時供 content script、service worker 與 Node 單元測試使用（classic script）。
(() => {
  'use strict';

  const N = globalThis.AceDLNaming;
  if (!N) throw new Error('planner.js: 需先載入 naming.js');

  const FILE_KINDS = Object.freeze(['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover']);
  const KIND_LABELS = Object.freeze({ stems: '分軌', midi: 'MIDI', musicxml: 'MusicXML', mp3: 'MP3', wav: 'WAV', cover: '封面' });

  function normalizeOptions(options) {
    const o = options || {};
    let types;
    if (Array.isArray(o.types)) types = o.types.filter((t) => FILE_KINDS.includes(t));
    else if (o.types && typeof o.types === 'object') types = FILE_KINDS.filter((t) => !!o.types[t]);
    else types = ['stems', 'midi', 'wav'];
    return {
      types: new Set(types),
      root: (typeof o.root === 'string' && o.root.trim()) || 'ai音樂',
      typeFolders: !!o.typeFolders,
      force: !!o.force,
      lossyModels: o.lossyModels && typeof o.lossyModels.has === 'function' ? o.lossyModels : Array.isArray(o.lossyModels) ? new Set(o.lossyModels) : null,
      origin: String(o.origin || 'https://acemusic.ai').replace(/\/+$/, ''),
    };
  }

  /** 站點判定「這首歌可以下載檔案」的條件：完成且有音檔 */
  function isDone(song) {
    return !!song && song.status === 'succeeded' && !!song.local_audio;
  }

  /** 站點目前只有 acemusic-v1.1 模型提供 WAV；其他模型抓 ?kind=wav 會 404 */
  /**
   * WAV 可用性＝站點規則（public/app.js：`hasWav = (s) => !modelPicker.of(s.model)?.lossy`，且只有生成歌曲有 WAV）：
   * 模型在 /api/status 標 lossy（ACE-Step 系列：來源是 m4a）就沒有 WAV；acemusic-v1／v1.1／之後的新模型都有。
   * lossyModels：/api/status 讀到的 lossy 模型集合；沒有時用後備規則「ace-step* 視為 lossy」。
   */
  const LOSSY_FALLBACK = /^ace-step/i;
  function supportsWav(song, lossyModels) {
    const originalAudio = String((song && song.local_audio) || '').split(/[?#]/)[0];
    if (/\.wav$/i.test(originalAudio)) return true; // 上傳／轉錄的原檔本身就是 WAV。
    const model = String((song && song.model) || '');
    if (!model) return false; // 上傳的歌（沒有模型）只有原檔
    if (song.capability && song.capability !== 'music_generate') return false;
    if (lossyModels && typeof lossyModels.has === 'function' && lossyModels.size) return !lossyModels.has(model);
    return !LOSSY_FALLBACK.test(model);
  }

  /** 站點判定 MIDI / MusicXML 可用的條件（見 public/app.js dlOptions） */
  function midiAvailable(song) {
    return isDone(song) && (song.capability === 'music_generate' || song.capability === 'music_transcribe');
  }

  /** 產品範圍：只有使用者已請求站點分軌的這個 task，才補 MIDI / MusicXML。 */
  function notationRequested(song) {
    if (!midiAvailable(song) || !song.stems || typeof song.stems !== 'object') return false;
    const requestedJob = (job) => {
      if (!job || typeof job !== 'object' || Array.isArray(job)) return false;
      const status = String(job.status || '').toLowerCase();
      return /^(queued|pending|starting|running|processing|done|succeeded|completed|failed|error|cancelled|canceled)$/.test(status)
        || Number(job.started_at) > 0 || Number(job.finished_at) > 0
        || (Array.isArray(job.tracks) && job.tracks.some((track) => track && (track.id || track.local_audio)));
    };
    if (['0', '2'].some((mode) => requestedJob(song.stems[mode]))) return true;
    const jobs = Array.isArray(song.stems) ? song.stems : song.stems.jobs;
    if (Array.isArray(jobs)) return jobs.some(requestedJob);
    return !!jobs && typeof jobs === 'object' && Object.values(jobs).some(requestedJob);
  }

  /** 選分軌群組：優先 mode "2"（全部分軌），否則 mode "0"（人聲+伴奏） */
  function pickStemGroup(stems) {
    if (!stems || typeof stems !== 'object') return null;
    for (const mode of ['2', '0']) {
      const job = stems[mode];
      if (!job || job.status !== 'done' || !Array.isArray(job.tracks) || !job.tracks.length) continue;
      const tracks = job.tracks.filter((t) => t && !t.empty && t.local_audio);
      if (tracks.length) return { mode, tracks };
    }
    return null;
  }

  /** 從封面 URL 取副檔名（預設 .jpg） */
  function coverExtension(url) {
    const s = String(url || '');
    const m = s.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|#|$)/i);
    if (!m) return '.jpg';
    const ext = m[1].toLowerCase();
    return ext === 'jpeg' ? '.jpg' : '.' + ext;
  }

  function absolutize(url, origin) {    const s = String(url == null ? '' : url);
    if (!s) return '';
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    const base = String(origin || 'https://acemusic.ai').replace(/\/+$/, '');
    if (s.startsWith('/')) return base + s;
    return base + '/' + s;
  }

  /** 以 storage 內的歷史與資料夾指派，決定 skipped / 新資料夾 */
  function buildDownloadPlan({ songs, options, state, origin }) {
    const opts = normalizeOptions({ ...(options || {}), origin: origin || (options && options.origin) });
    const folders = { ...((state && state.folderByTask) || {}) };
    const owners = { ...((state && state.ownerByFolder) || {}) };
    const history = (state && state.history) || {};
    const unavailable = (state && state.unavailable) || {};
    const tasks = [];
    const warnings = [];
    const seen = new Set();
    let total = 0;
    let skipped = 0;
    let toDownload = 0;

    for (const song of songs || []) {
      if (!song || !song.task_id || seen.has(song.task_id)) continue;
      seen.add(song.task_id);
      if (!isDone(song)) {
        warnings.push({ task_id: song.task_id, reason: 'not_ready', title: (song.meta && song.meta.title) || '' });
        continue;
      }

      let folder = folders[song.task_id];
      if (!folder) {
        folder = N.assignFolderName(N.songFolderLabel((song.meta && song.meta.title) || ''), song.task_id, owners);
        folders[song.task_id] = folder;
        owners[folder.toLowerCase()] = song.task_id;
      }

      const names = N.fileNamesFor(folder);
      const used = new Set();
      const files = [];

      const push = (file) => {
        const base = file.filename;
        file.filename = N.uniqueFileName(base, used);
        file.path = N.buildRelativePath({
          root: opts.root,
          folder,
          typeDir: N.TYPE_DIRS[file.kind],
          filename: file.filename,
          typeFolders: opts.typeFolders,
        });
        const hist = history[song.task_id] && history[song.task_id].files && history[song.task_id].files[file.key];
        file.skip = !opts.force && !!hist && hist.path === file.path;
        // 站點已回 no_download 的檔案（例如這首歌沒有 MIDI）：不再請求；force 可重試
        if (!file.skip && !opts.force && file.kind !== 'wav' && isUnavailable(unavailable, song.task_id, file.kind)) {
          file.skip = true;
          file.unavailable = true;
        }
        total += 1;
        if (file.skip) skipped += 1;
        else toDownload += 1;
        files.push(file);
      };

      if (opts.types.has('stems')) {
        const group = pickStemGroup(song.stems);
        for (const track of group ? group.tracks : []) {
          const label = N.stemLabel(track.type);
          push({
            key: 'stem:' + track.id,
            kind: 'stems',
            source: 'url',
            stemType: track.type,
            label,
            filename: names.stems(label),
            sourceUrl: absolutize(track.local_audio, opts.origin),
          });
        }
      }

      if (opts.types.has('midi') && notationRequested(song)) {
        push({ key: 'midi', kind: 'midi', source: 'api', apiKind: 'full', label: 'MIDI', filename: names.midi() });
      }

      if (opts.types.has('musicxml') && notationRequested(song)) {
        push({ key: 'musicxml', kind: 'musicxml', source: 'api', apiKind: 'musicxml', label: 'MusicXML', filename: names.musicxml() });
      }

      if (opts.types.has('mp3') && isDone(song) && !(song.capability !== 'music_generate' && /\.wav$/i.test(String(song.local_audio || '').split(/[?#]/)[0]))) {
        // 上傳類歌曲的 /file?kind=mp3 會 404，直接抓 local_audio（生成歌曲兩者相同）
        const mp3Url = song.local_audio
          ? `${opts.origin}${song.local_audio}`
          : `${opts.origin}/api/songs/${encodeURIComponent(song.task_id)}/file?kind=mp3`;
        push({
          key: 'mp3',
          kind: 'mp3',
          source: 'file',
          label: 'MP3',
          filename: names.mp3(),
          sourceUrl: mp3Url,
        });
      }

      if (opts.types.has('wav') && isDone(song) && supportsWav(song, opts.lossyModels)) {
        push({
          key: 'wav',
          kind: 'wav',
          source: 'file',
          label: 'WAV',
          filename: names.wav(),
          sourceUrl: (song.capability !== 'music_generate' && /\.wav$/i.test(String(song.local_audio || '').split(/[?#]/)[0]))
            ? absolutize(song.local_audio, opts.origin)
            : `${opts.origin}/api/songs/${encodeURIComponent(song.task_id)}/file?kind=wav`,
        });
      }

      if (opts.types.has('cover') && song.local_cover) {
        const ext = coverExtension(song.local_cover);
        push({
          key: 'cover',
          kind: 'cover',
          source: 'url',
          label: '封面',
          filename: names.cover(ext),
          sourceUrl: absolutize(song.local_cover, opts.origin),
        });
      }

      if (!files.length) continue;
      tasks.push({
        task_id: song.task_id,
        title: (song.meta && song.meta.title) || folder,
        folder,
        capability: song.capability || '',
        stemsMode: pickStemGroup(song.stems) ? pickStemGroup(song.stems).mode : null,
        files,
      });
    }

    return { options: opts, tasks, total, toDownload, skipped, warnings, folderByTask: folders, ownerByFolder: owners };
  }

  /** 把一次成功的下載寫進歷史（回傳新物件，不修改傳入值） */
  function mergeHistory(history, taskId, folder, file, absoluteFilename) {
    const h = { ...(history || {}) };
    const prev = h[taskId];
    const entry = { folder, files: { ...((prev && prev.files) || {}) } };
    if (prev && prev.title) entry.title = prev.title;
    entry.files[file.key] = {
      path: file.path,
      filename: file.filename,
      at: Date.now(),
      absolute: absoluteFilename || '',
    };
    h[taskId] = entry;
    return h;
  }

  /**
   * 檔名索引：一次解析所有檔名，之後每首歌 O(1) 查詢。
   * 語義等同舊的逐檔 regex：^<標題>(?: \(\d+\))?(?: - (.+))?\.([a-z0-9]+)$（不分大小寫）。
   * 每個檔名在「每個 ' - ' 切點」都登記一次前綴（標題本身可能含 ' - '），並另外登記去掉 take 編號的前綴。
   */
  function buildNameIndex(names) {
    const index = new Map();
    const add = (key, entry) => {
      const list = index.get(key);
      if (list) list.push(entry);
      else index.set(key, [entry]);
    };
    for (const name of names || []) {
      const m = /^(.*)\.([a-z0-9]+)$/i.exec(String(name));
      if (!m) continue;
      const base = m[1];
      const ext = m[2].toLowerCase();
      const splits = [[base, '']];
      for (let i = base.indexOf(' - '); i !== -1; i = base.indexOf(' - ', i + 1)) {
        const suffix = base.slice(i + 3);
        if (suffix.length) splits.push([base.slice(0, i), suffix]);
      }
      for (const [prefix, suffix] of splits) {
        const entry = { name, suffix: suffix.trim().toLowerCase(), ext };
        const key = prefix.toLowerCase();
        add(key, entry);
        const take = / \(\d+\)$/.exec(key);
        if (take) add(key.slice(0, take.index), entry);
      }
    }
    return index;
  }

  /** 查某個標題候選的所有檔案（去重；同一檔名只回一次） */
  function lookupNames(index, candidates) {
    const out = [];
    const seen = new Set();
    for (const candidate of candidates || []) {
      const list = index.get(String(candidate).toLowerCase());
      if (!list) continue;
      for (const entry of list) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        out.push(entry);
      }
    }
    return out;
  }

  /** 站點不提供的檔案種類（no_download）：{ [taskId]: { [kind]: { code, at } } } */
  function isUnavailable(map, taskId, kind) {
    return !!(map && taskId && kind && map[taskId] && map[taskId][kind]);
  }

  /** 記一筆「站點不提供」（回傳新物件，不修改傳入值） */
  function markUnavailable(map, taskId, kind, code) {
    const next = { ...(map || {}) };
    if (!taskId || !kind) return next;
    next[taskId] = { ...(next[taskId] || {}), [kind]: { code: code || 'no_download', at: Date.now() } };
    return next;
  }

  /** 合併多個來源（面板 storage＋agent-state），同一項取較新的紀錄 */
  function mergeUnavailable(...maps) {
    const out = {};
    for (const map of maps) {
      for (const [taskId, kinds] of Object.entries(map || {})) {
        if (!kinds || typeof kinds !== 'object') continue;
        for (const [kind, info] of Object.entries(kinds)) {
          const prev = out[taskId] && out[taskId][kind];
          if (!prev || Number((info && info.at) || 0) > Number(prev.at || 0)) {
            out[taskId] = { ...(out[taskId] || {}), [kind]: info || { code: 'no_download', at: 0 } };
          }
        }
      }
    }
    return out;
  }

  /**
   * 狀態明細的一項：站點不提供且本機沒有 → 標 N/A（不計入 total，不偽裝已下載）；
   * 檔案其實存在就照常算已下載。
   */
  function statusItem(type, label, have, na) {
    if (na && !have) return { type, label, have: 0, total: 0, done: true, na: true };
    return { type, label, have: have ? 1 : 0, total: 1, done: !!have };
  }

  /** 面板狀態只計這次勾選的類型；MP3／WAV 與其他檔案使用同一完成規則。 */
  function downloadStatusForTypes(song, { types = [], downloaded = {}, unavailable = {}, lossyModels = null } = {}) {
    const requested = new Set(types);
    const detail = [];
    const add = (kind, have, na = false) => detail.push(statusItem(kind, KIND_LABELS[kind], have, na));
    const group = pickStemGroup(song && song.stems);
    if (requested.has('stems') && group) {
      const total = group.tracks.length;
      const have = Math.max(0, Math.min(total, Number(downloaded.stems) || 0));
      detail.push({ type: 'stems', label: KIND_LABELS.stems, have, total, done: have >= total });
    }
    for (const kind of ['midi', 'musicxml']) {
      if (requested.has(kind) && notationRequested(song)) add(kind, downloaded[kind], isUnavailable(unavailable, song.task_id, kind));
    }
    if (requested.has('mp3') && isDone(song)) {
      const originalWav = song.capability !== 'music_generate' && /\.wav$/i.test(String(song.local_audio || '').split(/[?#]/)[0]);
      add('mp3', downloaded.mp3, originalWav);
      if (originalWav && !downloaded.mp3) detail[detail.length - 1].reason = '原始檔為 WAV';
    }
    if (requested.has('wav') && isDone(song)) {
      add('wav', downloaded.wav, !supportsWav(song, lossyModels));
      if (!supportsWav(song, lossyModels) && !downloaded.wav) detail[detail.length - 1].reason = '此模型不提供 WAV';
    }
    if (requested.has('cover') && song && song.local_cover) add('cover', downloaded.cover);
    const have = detail.reduce((sum, item) => sum + item.have, 0);
    const total = detail.reduce((sum, item) => sum + item.total, 0);
    return { have, total, allDone: detail.every((item) => item.done), any: have > 0, detail };
  }

  /** 篩選與選擇共用同一範圍，隱藏歌曲不能被「全選」或舊勾選偷偷送出。 */
  function filterDownloadSongs(songs, { onlyUndownloaded = false, onlyFavorites = false, statusForSong = () => ({}), isFavorite = () => false } = {}) {
    return (songs || []).filter((song) => (!onlyUndownloaded || !statusForSong(song).allDone) && (!onlyFavorites || isFavorite(song.task_id)));
  }

  function selectedDownloadSongs(visibleSongs, selectedIds) {
    return (visibleSongs || []).filter((song) => selectedIds && selectedIds.has(song.task_id));
  }

  const api = {
    FILE_KINDS,
    buildNameIndex,
    lookupNames,
    isUnavailable,
    markUnavailable,
    mergeUnavailable,
    statusItem,
    downloadStatusForTypes,
    filterDownloadSongs,
    selectedDownloadSongs,
    KIND_LABELS,
    normalizeOptions,
    isDone,
    midiAvailable,
    notationRequested,
    supportsWav,
    pickStemGroup,
    absolutize,
    buildDownloadPlan,
    mergeHistory,
  };
  globalThis.AceDLPlanner = api;
})();

