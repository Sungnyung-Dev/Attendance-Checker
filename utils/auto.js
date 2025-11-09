// /utils/auto.js
import cron from 'node-cron';
import fs from 'fs-extra';
import axios from 'axios';
import { getCurrentWeek, getWeekFilePath } from './week.js';
import { readJson, writeJson } from './filedb.js';

/**
 * 자동 스케줄러
 * - 일요일 23:59 → 자동 마감 (/api/finalize)
 * - 월요일 00:00 → 새 주차 생성 및 ledger.json 백업
 * (Asia/Seoul 기준)
 */
export function startAutoTasks() {
  console.log('[AUTO] 자동 스케줄러 초기화됨.');

  // ────────────────────────────────
  // ① 매주 일요일 23:59 → 자동 마감 실행
  // ────────────────────────────────
  cron.schedule(
    '59 23 * * 0',
    async () => {
      try {
        const port = process.env.PORT || 25565;
        const token = process.env.ADMIN_TOKEN;
        const serverUrl = `http://localhost:${port}/api/finalize`;

        console.log(`[AUTO] 주간 자동 마감 시도 → ${serverUrl}`);

        await axios.post(
          serverUrl,
          {},
          { headers: { 'x-admin-token': token } }
        );

        console.log('[AUTO] ✅ 주간 자동 마감 완료');
      } catch (err) {
        console.error('[AUTO] ❌ 자동 마감 실패:', err.message);
      }
    },
    {
      scheduled: true,
      timezone: 'Asia/Seoul',
    }
  );

  // ────────────────────────────────
  // ② 매주 월요일 00:00 → 새 주차 생성 & ledger 백업
  // ────────────────────────────────
  cron.schedule(
    '0 0 * * 1',
    async () => {
      try {
        const { weekId, start, end } = getCurrentWeek();
        const weekPath = getWeekFilePath(weekId);

        // 파일이 이미 있으면 건너뜀
        if (await fs.pathExists(weekPath)) {
          console.log(`[AUTO] 이미 ${weekId} 파일이 존재. 건너뜀.`);
          return;
        }

        // 1️⃣ ledger.json 백업
        const ledgerPath = 'data/ledger.json';
        if (await fs.pathExists(ledgerPath)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const backupDir = 'data/backups';
          await fs.ensureDir(backupDir);
          await fs.copy(ledgerPath, `${backupDir}/${ts}-ledger.json`);
          console.log(`[AUTO] ledger.json 백업 완료 (${ts})`);
        }

        // 2️⃣ 새 주차 파일 생성
        const newWeek = {
          weekId,
          start,
          end,
          checkins: [],
          finalized: false,
        };
        await writeJson(weekPath, newWeek);
        console.log(`[AUTO] 새 주차 생성됨: ${weekId}`);
      } catch (err) {
        console.error('[AUTO] 스케줄러 오류:', err);
      }
    },
    {
      scheduled: true,
      timezone: 'Asia/Seoul',
    }
  );

  // ────────────────────────────────
  // 확인용 로그
  // ────────────────────────────────
  setTimeout(() => {
    console.log('[AUTO] 매주 일요일 23:59 자동 마감 / 월요일 00:00 롤오버 예약됨');
  }, 10000);
}
