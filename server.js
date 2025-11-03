import express from 'express';
import dotenv from 'dotenv';
import { getCurrentWeek, getWeekFilePath } from './utils/week.js';
import { readJson, writeJson } from './utils/filedb.js';
import { startAutoTasks } from './utils/auto.js';
import { promises as fsp } from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

dotenv.config();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// 멤버별 금주 고유 출석일 수 집계
app.get('/api/week', async (req, res) => {
  try {
    const { weekId, start, end, now } = getCurrentWeek();
    const weekPath = getWeekFilePath(weekId);
    const week = await readJson(weekPath, { weekId, start, end, checkins: [], finalized: false });

    // 같은 멤버가 같은 날짜에 여러 번 찍어도 1회로 취급
    const uniq = new Set(week.checkins.map(c => `${c.memberId}|${c.date.slice(0, 10)}`));
    const perMember = {};
    uniq.forEach(k => {
      const [mid] = k.split('|');
      perMember[mid] = (perMember[mid] || 0) + 1;
    });

    res.json({
      weekId,
      start,
      end,
      finalized: week.finalized || false,
      today: now.slice(0, 10),
      perMember
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

// 관리자 인증 미들웨어
const authAdmin = (req, res, next) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};

// POST /api/finalize  : 주간 마감
app.post('/api/finalize', authAdmin, async (req, res) => {
  try {
    const { weekId, start, end } = getCurrentWeek();
    const weekPath = getWeekFilePath(weekId);

    const week = await readJson(weekPath, { weekId, start, end, checkins: [], finalized: false });
    if (week.finalized) return res.json({ ok: true, message: 'already finalized' });

    // 멤버 목록
    const members = (await readJson('data/members.json', { members: [] })).members
      .filter(m => m.active !== false);

    // 멤버별 출석일 집계
    const unique = new Set(week.checkins.map(c => `${c.memberId}|${c.date.slice(0, 10)}`));
    const counts = {};
    unique.forEach(k => {
      const [mid] = k.split('|');
      counts[mid] = (counts[mid] || 0) + 1;
    });

    // ledger 읽기
    const ledger = await readJson('data/ledger.json', { entries: [] });

    // 각 멤버 벌금 계산
    members.forEach(m => {
      const count = counts[m.id] || 0;
      const deficit = Math.max(0, 4 - count);
      if (deficit > 0) {
        ledger.entries.push({
          weekId,
          memberId: m.id,
          deficit,
          fine: deficit * 10000,
          finalizedAt: new Date().toISOString()
        });
      }
    });

    week.finalized = true;
    await writeJson(weekPath, week);
    await writeJson('data/ledger.json', ledger);

    res.json({ ok: true, message: 'week finalized', weekId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/members', async (req, res) => {
  const data = await readJson('data/members.json', { members: [] });
  const activeMembers = data.members.filter(m => m.active !== false);
  res.json(activeMembers);
});

// 오늘 1일 1회만 인정, 주 파일 없으면 자동 생성
app.post('/api/checkin', async (req, res) => {
  try {
    const { memberId } = req.body || {};
    if (!memberId) return res.status(400).json({ error: 'memberId required' });

    // 멤버 유효성 검사(비활성 제외)
    const members = (await readJson('data/members.json', { members: [] })).members
      .filter(m => m.active !== false);
    if (!members.some(m => m.id === memberId)) {
      return res.status(404).json({ error: 'member not found or inactive' });
    }

    const { weekId, start, end, now } = getCurrentWeek(); // Asia/Seoul 기준
    const weekPath = getWeekFilePath(weekId);
    const week = await readJson(weekPath, { weekId, start, end, checkins: [], finalized: false });
    if (week.finalized) return res.status(400).json({ error: 'week already finalized' });

    const today = now.slice(0, 10); // YYYY-MM-DD
    const already = week.checkins.some(
      c => c.memberId === memberId && c.date.slice(0, 10) === today
    );
    if (already) return res.status(409).json({ error: 'already checked in today' });

    week.checkins.push({ memberId, date: now }); // ISO 문자열 저장
    await writeJson(weekPath, week);
    return res.json({ ok: true, weekId, date: now });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/ledger', async (req, res) => {
  try {
    const { weekId, memberId, summary, unpaidOnly } = req.query;

    const ledger = await readJson('data/ledger.json', { entries: [] });
    let entries = ledger.entries.map(e => {
      const fine = Number(e.fine) || 0;
      const paid = Array.isArray(e.payments)
        ? e.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
        : 0;
      const outstanding = Math.max(0, fine - paid);
      return { ...e, fine, totalPaid: paid, outstanding };
    });

    // 필터링
    if (weekId) entries = entries.filter(e => e.weekId === weekId);
    if (memberId) entries = entries.filter(e => e.memberId === memberId);
    if (String(unpaidOnly) === 'true') entries = entries.filter(e => e.outstanding > 0);

    // 정렬: 최신 주차 우선 → 멤버ID
    entries = entries.slice().sort((a, b) => {
      if (a.weekId === b.weekId) return (a.memberId > b.memberId ? 1 : -1);
      return (a.weekId > b.weekId ? -1 : 1);
    });

    // 요약 안 하면 raw 반환
    if (!summary) {
      return res.json({ entries });
    }

    if (summary === 'member') {
      // 멤버별 합계(미납 포함)
      const byMember = {};
      for (const e of entries) {
        if (!byMember[e.memberId]) {
          byMember[e.memberId] = {
            memberId: e.memberId,
            totalDeficit: 0,
            totalFine: 0,
            totalPaid: 0,
            outstanding: 0,
            weeks: new Set()
          };
        }
        byMember[e.memberId].totalDeficit += e.deficit || 0;
        byMember[e.memberId].totalFine += e.fine;
        byMember[e.memberId].totalPaid += e.totalPaid;
        byMember[e.memberId].outstanding += e.outstanding;
        byMember[e.memberId].weeks.add(e.weekId);
      }
      const rows = Object.values(byMember).map(x => ({
        memberId: x.memberId,
        totalDeficit: x.totalDeficit,
        totalFine: x.totalFine,
        totalPaid: x.totalPaid,
        outstanding: x.outstanding,
        fullyPaid: x.outstanding === 0,
        weeks: Array.from(x.weeks).sort()
      })).sort((a,b)=> a.memberId > b.memberId ? 1 : -1);
      return res.json({ summary: 'member', rows });
    }

    if (summary === 'week') {
      // 주차별 합계(미납 포함)
      const byWeek = {};
      for (const e of entries) {
        if (!byWeek[e.weekId]) {
          byWeek[e.weekId] = {
            weekId: e.weekId,
            totalDeficit: 0,
            totalFine: 0,
            totalPaid: 0,
            outstanding: 0,
            members: new Set(),
            fullyPaidCount: 0
          };
        }
        const w = byWeek[e.weekId];
        w.totalDeficit += e.deficit || 0;
        w.totalFine += e.fine;
        w.totalPaid += e.totalPaid;
        w.outstanding += e.outstanding;
        w.members.add(e.memberId);
        if (e.outstanding === 0) w.fullyPaidCount += 1;
      }
      const rows = Object.values(byWeek).map(w => ({
        weekId: w.weekId,
        totalDeficit: w.totalDeficit,
        totalFine: w.totalFine,
        totalPaid: w.totalPaid,
        outstanding: w.outstanding,
        membersCount: w.members.size,
        fullyPaidCount: w.fullyPaidCount
      })).sort((a,b)=> a.weekId > b.weekId ? -1 : 1);
      return res.json({ summary: 'week', rows });
    }

    return res.status(400).json({ error: 'invalid summary (use "member" or "week")' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/ledger/pay', authAdmin, async (req, res) => {
  try {
    const { weekId, memberId, paidAmount, method, note } = req.body || {};

    if (!weekId || !memberId) {
      return res.status(400).json({ error: 'weekId and memberId are required' });
    }
    const amount = Number(paidAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'paidAmount must be a positive number' });
    }
    if (!method) {
      return res.status(400).json({ error: 'method is required (e.g., cash, transfer)' });
    }

    const ledger = await readJson('data/ledger.json', { entries: [] });
    const entry = ledger.entries.find(e => e.weekId === weekId && e.memberId === memberId);

    if (!entry) {
      return res.status(404).json({ error: 'ledger entry not found (check weekId & memberId)' });
    }

    // payments 배열 초기화 후 결제 내역 추가
    if (!Array.isArray(entry.payments)) entry.payments = [];
    const payment = {
      amount,
      method,
      note: note || '',
      paidAt: new Date().toISOString()
    };
    entry.payments.push(payment);

    // 총 납부액 계산
    const totalPaid = entry.payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const fine = Number(entry.fine) || 0;
    const outstanding = Math.max(0, fine - totalPaid);
    const fullyPaid = outstanding === 0;

    await writeJson('data/ledger.json', ledger);

    return res.json({
      ok: true,
      weekId,
      memberId,
      fine,
      addedPayment: payment,
      totalPaid,
      outstanding,
      fullyPaid
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/attendance/current', async (req, res) => {
  try {
    const wk = getCurrentWeek(); // { weekId, start, end, now }
    const weekId = wk.weekId;

    // 멤버
    const membersPath = path.resolve('data', 'members.json');
    const membersJson = JSON.parse(await fsp.readFile(membersPath, 'utf-8'));
    const members = Array.isArray(membersJson.members) ? membersJson.members : [];

    // 주 파일 로드 (없으면 기본형)
    const weekFile = path.resolve('data', `attendance-${weekId}.json`);
    let wdata = { weekId, start: wk.start, end: wk.end, finalized: false };
    try {
      const raw = await fsp.readFile(weekFile, 'utf-8');
      const parsed = JSON.parse(raw);
      wdata = { ...wdata, ...parsed };
    } catch (_) {
      // 파일 없으면 기본값
    }

    // ---------- 유틸: 멤버ID/날짜 파싱 ----------
    const toDateStr = (v) => {
      if (typeof v === 'number') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString().slice(0,10);
      }
      if (typeof v === 'string' && v.trim()) {
        const s = v.trim();
        const m = s.match(/\d{4}-\d{2}-\d{2}/);
        if (m) return m[0];
        if (s.length >= 10 && s[4] === '-' && s[7] === '-') return s.slice(0,10);
      }
      return '';
    };
    const getId = (obj) =>
      obj?.memberId || obj?.memberID || obj?.id || obj?.userId || obj?.userID || obj?.uid;

    // ---------- 1) 배열 기반 로그 스캔 ----------
    const dateMap = new Map();     // memberId -> Set('YYYY-MM-DD')
    const rawCountMap = new Map(); // memberId -> number(날짜 불명 로그 카운트)

    const touch = (mid, ds) => {
      if (!mid) return;
      if (!dateMap.has(mid)) dateMap.set(mid, new Set());
      if (!rawCountMap.has(mid)) rawCountMap.set(mid, 0);
      if (ds) dateMap.get(mid).add(ds);
      else rawCountMap.set(mid, rawCountMap.get(mid) + 1);
    };

    const scanArray = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const rec of arr) {
        const mid = getId(rec);
        const ds =
          toDateStr(rec?.date) ||
          toDateStr(rec?.checkedAt) ||
          toDateStr(rec?.createdAt) ||
          toDateStr(rec?.created_at) ||
          toDateStr(rec?.timestamp) ||
          toDateStr(rec?.ts) ||
          toDateStr(rec?.time) ||
          toDateStr(rec?.at) ||
          '';
        touch(mid, ds);
      }
    };

    scanArray(wdata.records);
    scanArray(wdata.entries);
    scanArray(wdata.checkins);
    scanArray(wdata.logs);

    // ---------- 2) 맵 기반 구조 스캔 ----------
    // perMemberDates / perMemberDays / memberDates: { memberId: ['2025-11-03', ...] } 또는 { memberId: { '2025-11-03': true, ... } }
    const scanMemberDatesMap = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [mid, v] of Object.entries(obj)) {
        if (!dateMap.has(mid)) dateMap.set(mid, new Set());
        if (Array.isArray(v)) {
          v.forEach(d => { const ds = toDateStr(d); if (ds) dateMap.get(mid).add(ds); });
        } else if (v && typeof v === 'object') {
          Object.keys(v).forEach(k => { const ds = toDateStr(k); if (ds && v[k]) dateMap.get(mid).add(ds); });
        }
      }
    };

    scanMemberDatesMap(wdata.perMemberDates);
    scanMemberDatesMap(wdata.perMemberDays);
    scanMemberDatesMap(wdata.memberDates);

    // byDate: { '2025-11-03': ['u01','u02'] } 혹은 { '2025-11-03': { u01:true, u02:true } }
    const scanByDate = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const ds = toDateStr(k);
        if (!ds) continue;
        if (Array.isArray(v)) {
          v.forEach(mid => touch(mid, ds));
        } else if (v && typeof v === 'object') {
          Object.entries(v).forEach(([mid, flag]) => { if (flag) touch(mid, ds); });
        }
      }
    };
    scanByDate(wdata.byDate);

    // ---------- 3) 카운트 필드 계열 ----------
    // perMember / perMemberCount / counts: { memberId: number }
    const getCountFromAny = (obj, mid) => {
      if (!obj || typeof obj !== 'object') return 0;
      const v = obj[mid];
      return Number.isFinite(Number(v)) ? Number(v) : 0;
    };

    const countsCandidate = wdata.perMemberCount || wdata.counts || {};
    const perMember = wdata.perMember || {};

    // ---------- 4) 최종 리스트 ----------
    const list = members.map(m => {
      const id = m.id;
      const datesSet = dateMap.get(id) || new Set();
      const dates = Array.from(datesSet).sort();
      const fromDates = datesSet.size;
      const fromPerMember = getCountFromAny(perMember, id);
      const fromCounts = getCountFromAny(countsCandidate, id);
      const fromRaw = rawCountMap.get(id) || 0;

      // ✅ 주(週) 출석은 "고유 날짜 수"가 가장 신뢰 높음
      const bestDates = fromDates;
      const bestNumeric = Math.max(fromPerMember, fromCounts, fromRaw);

      const count = Math.max(bestDates, bestNumeric);
      const lastCheckedAt = dates.length ? dates[dates.length - 1] : null;

      return {
        id,
        name: m.name || id,
        count,
        lastCheckedAt,
        dates
      };
    });

    const checkedIn = list.filter(x => (x.count || 0) > 0).length;

    res.set('Cache-Control', 'no-store');
    res.json({
      weekId,
      start: wdata.start,
      end: wdata.end,
      finalized: !!wdata.finalized,
      totalMembers: members.length,
      checkedIn,
      list
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'failed to load current attendance' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  startAutoTasks(); // ✅ 자동 스케줄러 시작
});