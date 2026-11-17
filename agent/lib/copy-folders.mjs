// copy-folders.mjs — 只放「複本」的頂層資料夾清單（唯一來源）。
// 這些資料夾裡的檔案都是從曲庫複製出來給人用的：歌曲索引、檔案索引、去重、分類、整理、音頻分析一律跳過，
// 否則同一首歌會被算兩次，或複本被去重搬走。新增複本資料夾只要加在這裡。
export const FAVORITES_COPY_FOLDER = '收藏';
export const OUTPUT_COPY_FOLDER = '整理輸出';
export const LIKED_FOLDER = '已點讚';
// 使用者自己放的成品（電臺節目、母帶）也要保護：歸檔／分類／去重／分析一律跳過，
// 不然節目的 FLAC 會被當成「未分類音檔」搬進 _未對應／音頻分類。
export const PROGRAM_FOLDER = '節目';
export const COPY_FOLDERS = Object.freeze([FAVORITES_COPY_FOLDER, OUTPUT_COPY_FOLDER, LIKED_FOLDER, PROGRAM_FOLDER]);

const lowerNames = new Set(COPY_FOLDERS.map((name) => name.toLowerCase()));

/** name 是否為複本資料夾的名字（大小寫不敏感）。 */
export function isCopyFolderName(name) {
    return lowerNames.has(String(name || '').toLowerCase());
}
