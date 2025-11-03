// /utils/week.js
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import isoWeek from 'dayjs/plugin/isoWeek.js'; // ✅ 추가

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek); // ✅ 추가

const ZONE = 'Asia/Seoul';

/**
 * 월요일~일요일 기준 ISO 주차 정보
 */
export function getCurrentWeek(now = dayjs().tz(ZONE)) {
  const dow = now.day(); // 0=일, 1=월, ... 6=토
  const monday = now.subtract((dow + 6) % 7, 'day').startOf('day');
  const sunday = monday.add(6, 'day').endOf('day');

  const weekNum = monday.isoWeek();       // ✅ ISO 주차 번호 (1~53)
  const year = monday.isoWeekYear();      // ✅ ISO 주차 기준 연도
  const weekId = `${year}-W${String(weekNum).padStart(2, '0')}`;

  return {
    weekId,
    start: monday.format('YYYY-MM-DD'),
    end: sunday.format('YYYY-MM-DD'),
    now: now.format()
  };
}

export function getWeekFilePath(weekId) {
  return `data/attendance-${weekId}.json`;
}
