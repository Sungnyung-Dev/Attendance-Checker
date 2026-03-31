// utils/seed-members.js
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve('data');
const membersPath = path.join(dataDir, 'members.json');

// 원하는 멤버 명단 여기서 관리
const members = [
  { id: 'u01', name: '강준서', active: true },
  { id: 'u02', name: '김승현', active: true },
  { id: 'u03', name: '김태은', active: true },
  { id: 'u04', name: '박진환', active: true },
  { id: 'u05', name: '백승진', active: true },
  { id: 'u06', name: '서정원', active: true },
  { id: 'u07', name: '손진건', active: true },
  { id: 'u08', name: '오승필', active: true },
  { id: 'u09', name: '임현웅', active: true },
  { id: 'u10', name: '조영환', active: true },
  { id: 'u11', name: '조재영', active: true },
  { id: 'u12', name: '천지훈', active: true },
  { id: 'u13', name: '황동하', active: true },
  { id: 'u14', name: '김이열', active: true },
  { id: 'u15', name: '송윤수', active: true}
];

fs.writeFileSync(membersPath, JSON.stringify({ members }, null, 2));
console.log('[OK] members seeded:', members.length);