// utils/seed-members.js
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve('data');
const membersPath = path.join(dataDir, 'members.json');

// 원하는 멤버 명단 여기서 관리
const members = [
  { id: 'u01', name: '강준서', active: true },
  { id: 'u02', name: '박진환', active: true },
  { id: 'u03', name: '안정우', active: true },
  { id: 'u04', name: '이현민', active: true },
  { id: 'u05', name: '임현웅', active: true },
];

fs.writeFileSync(membersPath, JSON.stringify({ members }, null, 2));
console.log('[OK] members seeded:', members.length);
