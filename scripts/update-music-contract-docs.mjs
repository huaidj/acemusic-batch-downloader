import fs from 'node:fs';
import { MUSIC_CONTRACT } from '../agent/lib/music-contract.mjs';
import { CREATE_CONTRACT } from '../agent/lib/create-tools.mjs';
const contracts = [...MUSIC_CONTRACT, ...CREATE_CONTRACT];
function update(file, tag, content) {
  const source = fs.readFileSync(file, 'utf8');
  const start = `<!-- ${tag}:start -->`, end = `<!-- ${tag}:end -->`;
  const section = `${start}\n${content}\n${end}`;
  const begin = source.indexOf(start), finish = source.indexOf(end);
  fs.writeFileSync(file, begin >= 0 && finish >= begin ? source.slice(0, begin) + section + source.slice(finish + end.length) : source.trimEnd() + '\n\n' + section + '\n');
}
update('agent/HUB.md', 'music-contract', `## 音樂中樞完整端點（由共用契約產生）\n\n| Method | Path | 功能 |\n|---|---|---|\n${contracts.map(row => `| ${row.method} | \`${row.path}\` | ${row.description.replaceAll('|', '／')} |`).join('\n')}\n\n準備、授權、遠端受理、實際產物與人類試聽分開記錄。參見 [WORKFLOW.md](WORKFLOW.md)。`);
update('agent/README-AGENT.md', 'music-tools', `## 音樂中樞工具（由共用契約產生）\n\n| Tool | 功能 |\n|---|---|\n${contracts.map(row => `| \`${row.name}\` | ${row.description.replaceAll('|', '／')} |`).join('\n')}\n\n長時間操作短回任務識別；後續查狀態或事件。供應商費用、素材上傳、自動繼續與播放分開授權。`);
console.log(JSON.stringify({ endpoints: contracts.length, tools: contracts.length }));
