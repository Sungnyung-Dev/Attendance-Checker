// /utils/auto.js
import cron from 'node-cron';
import fs from 'fs-extra';
import { getCurrentWeek, getWeekFilePath } from './week.js';
import { readJson, writeJson } from './filedb.js';

/**
 * 매주 월요일 00:00 자동 롤오버 & 백업
 * (Asia/Seoul 기준)
 */
export function startAutoTasks() {
  console.log('[AUTO] 자동 스케줄러 초기화됨.');

  // 매주 월요일 00:00에 실행
  cron.schedule('0 0 * * 1', async () => {
    try {
      const { weekId, start, end } = getCurrentWeek();
      const weekPath = getWeekFilePath(weekId);

      // 파일이 이미 있으면 건너뜀
      if (await fs.pathExists(weekPath)) {
        console.log(`[AUTO] 이미 ${weekId} 파일이 존재. 건너뜀.`);
        return;
      }

      // 1️⃣ 이전 주차 백업
      const ledgerPath = 'data/ledger.json';
      if (await fs.pathExists(ledgerPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.copy(ledgerPath, `data/backups/${ts}-ledger.json`);
        console.log(`[AUTO] ledger.json 백업 완료`);
      }

      // 2️⃣ 새 주차 파일 생성
      const newWeek = {
        weekId,
        start,
        end,
        checkins: [],
        finalized: false
      };
      await writeJson(weekPath, newWeek);
      console.log(`[AUTO] 새 주차 생성됨: ${weekId}`);

    } catch (err) {
      console.error('[AUTO] 스케줄러 오류:', err);
    }
  }, {
    timezone: 'Asia/Seoul'
  });
}
