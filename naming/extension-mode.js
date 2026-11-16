// 命名爐 × ACE 批量下載器
// 在擴充功能頁面中直接讀取使用者授權的「ai音樂」資料夾，掃描 manifest，
// 命名後可把改名直接套用到檔案（File System Access API）。
(() => {
  'use strict';
  if (!/^chrome-extension:/.test(location.protocol) || !globalThis.chrome?.runtime?.id) return;

  const DB = 'nomen-furnace';
  const STORE = 'handles';
  const KEY = 'root';
  const ROOT_MANIFEST = '音頻分類/_manifest.json';
  const TITLE_MANIFEST = '成品MP3/_manifest.json';
  // 改名紀錄：本機索引把它當成搬移紀錄（與 removedPaths 相同語意），改名後歌曲的下載證據仍可追到新檔名，也可據此復原。
  const JOURNAL = '_命名爐改名紀錄.json';
  const JOURNAL_SCHEMA = 'ace_naming_journal_v1';

  let root = null;
  const ends = (name) => String(name || '').split('/').filter(Boolean);

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet() {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (_) { return null; }
  }
  async function idbSet(handle) {
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(handle, KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) { /* 無法持久化時，本次仍可用 */ }
  }

  async function ensureDir(parts) {
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return dir;
  }
  function safeParts(rel) {
    const parts = ends(rel);
    if (parts[0] === root.name) parts.shift();
    if (!parts.length || parts.some(p => p === '..' || p === '.' || !p)) throw new Error('invalid path');
    return parts;
  }
  async function fileHandleFor(rel) {
    const parts = safeParts(rel);
    const name = parts.pop();
    const dir = await ensureDir(parts);
    return dir.getFileHandle(name);
  }
  async function readJson(rel) {
    const handle = await fileHandleFor(rel);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  }
  async function permissionGranted(handle) {
    if (!handle) return false;
    if (typeof handle.queryPermission !== 'function') return true;
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  async function scan() {
    if (!root) throw new Error('尚未連接資料夾');
    if (!(await permissionGranted(root))) throw new Error('資料夾權限已失效，請重新連接');
    const analysis = await readJson(ROOT_MANIFEST);
    let titles = [];
    try {
      const t = await readJson(TITLE_MANIFEST);
      titles = [...new Set((t.items || []).map(x => x.title).filter(Boolean))];
    } catch (_) { /* 成品MP3 manifest 可能不存在 */ }

    const tracks = [];
    let missing = 0;
    for (const item of analysis.items || []) {
      const link = (item.links && item.links[0]) || '';
      if (!link.startsWith('完整歌曲') && !link.startsWith('分軌')) continue;
      const rel = item.relative || '';
      if (!rel) continue;
      let handle = null;
      let file = null;
      try {
        handle = await fileHandleFor(rel);
        file = await handle.getFile();
      } catch (_) { missing++; continue; }
      const ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
      const name = file.name.replace(/\.[^.]+$/, '');
      const parts = ends(rel);
      if (parts[0] === root.name) parts.shift();
      tracks.push({
        rel: root.name + '/' + parts.join('/'),
        name,
        kind: link.startsWith('完整歌曲') ? 'full' : 'stem',
        bpm: Math.round(Number(item.bpm) || 0),
        key: item.key || '',
        cam: item.camelot || '',
        dur: Math.round(Number(item.duration) || 0),
        en: Number(item.energy) || 0,
        size: Number(item.size) || file.size,
        ext,
        file,
        handle
      });
    }
    return { tracks, titles, rootName: root.name, missing };
  }

  async function connect() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('這個 Chrome 不支援資料夾授權；請把資料夾拖進頁面');
    }
    let handle = await idbGet();
    if (handle) {
      try {
        const state = typeof handle.requestPermission === 'function'
          ? await handle.requestPermission({ mode: 'readwrite' })
          : 'granted';
        if (state === 'granted') { root = handle; return scan(); }
      } catch (_) { /* 舊 handle 失效，改用 picker */ }
    }
    handle = await window.showDirectoryPicker({ id: 'ace-naming', mode: 'readwrite' });
    if (!(await permissionGranted(handle)) && typeof handle.requestPermission === 'function') {
      const state = await handle.requestPermission({ mode: 'readwrite' });
      if (state !== 'granted') throw new Error('需要資料夾的讀寫權限才能改名');
    }
    root = handle;
    await idbSet(handle);
    return scan();
  }

  async function restoreAndScan() {
    const handle = await idbGet();
    if (!handle || !(await permissionGranted(handle))) return null;
    root = handle;
    return scan();
  }

  async function targetExists(rel, name) {
    const parts = safeParts(rel);
    parts.pop();
    try {
      const dir = await ensureDir(parts);
      await dir.getFileHandle(name);
      return true;
    } catch (err) {
      return err && err.name === 'TypeMismatchError';
    }
  }

  async function readJournal() {
    try {
      const handle = await root.getFileHandle(JOURNAL);
      const value = JSON.parse(await (await handle.getFile()).text());
      if (value && value.schema === JOURNAL_SCHEMA && Array.isArray(value.entries)) return value;
      throw new Error('改名紀錄格式不正確，已停止改名以免覆蓋');
    } catch (err) {
      if (err && err.name === 'NotFoundError') return { schema: JOURNAL_SCHEMA, entries: [] };
      throw err;
    }
  }
  async function writeJournal(journal) {
    const handle = await root.getFileHandle(JOURNAL, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(journal, null, 2));
    await writable.close();
  }

  async function apply(records, onProgress) {
    if (!root) throw new Error('尚未連接資料夾');
    // 先確認能讀寫改名紀錄；讀不到既有紀錄就不改名，避免留下無法追蹤的改名。
    const journal = await readJournal();
    const batch = new Date().toISOString();
    let renamed = 0;
    let failed = 0;
    const errors = [];
    let i = 0;
    for (const rec of records) {
      i++;
      try {
        const entry = rec.entry;
        let handle = entry.fileHandle;
        if (!handle) handle = await fileHandleFor(entry.rel);
        if (typeof handle.move !== 'function') throw new Error('此 Chrome 不支援檔案改名（FileSystemFileHandle.move）');
        let name = rec.newName;
        if (await targetExists(entry.rel, name)) {
          const ext = (name.match(/\.[^.]+$/) || [''])[0];
          const base = ext ? name.slice(0, -ext.length) : name;
          let n = 2;
          while (await targetExists(entry.rel, base + ' (' + n + ')' + ext)) n++;
          name = base + ' (' + n + ')' + ext;
        }
        const fromParts = safeParts(entry.rel);
        const before = await handle.getFile().catch(() => null);
        await handle.move(name);
        renamed++;
        const toParts = fromParts.slice(0, -1).concat(name);
        journal.entries.push({ batch, at: new Date().toISOString(), from: fromParts.join('/'), to: toParts.join('/'), bytes: before ? before.size : null });
        // 每改一個就寫一次紀錄：中途關頁也不會留下沒有紀錄的改名。
        await writeJournal(journal);
      } catch (err) {
        failed++;
        errors.push({ file: rec.entry.rel, error: String((err && err.message) || err) });
      }
      if (onProgress) onProgress(`改名 ${i} / ${records.length}…`);
      if (i % 12 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return { renamed, failed, errors };
  }

  window.NOMEN_EXT_MODE = true;
  window.NOMEN_EXT = { connect, scan, restoreAndScan, apply, isExtension: true };
})();
