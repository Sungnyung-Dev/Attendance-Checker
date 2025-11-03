// utils/reset-data.js
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve('data');

// 백업 폴더
const ts = new Date().toISOString().replace(/[:.]/g,'-');
const backupDir = path.join(dataDir, 'backups', `reset-${ts}`);
fs.mkdirSync(backupDir, { recursive: true });

// 백업 & 삭제
for (const f of fs.readdirSync(dataDir)) {
  if (f === 'members.json' || f === 'backups') continue; // 멤버는 그대로, 백업폴더 제외
  const p = path.join(dataDir, f);
  if (fs.statSync(p).isFile()) {
    fs.copyFileSync(p, path.join(backupDir, f));
    fs.unlinkSync(p);
  }
}

// ledger 초기화
fs.writeFileSync(path.join(dataDir, 'ledger.json'), JSON.stringify({ entries: [] }, null, 2));

console.log('[OK] data reset. Backup ->', backupDir);
