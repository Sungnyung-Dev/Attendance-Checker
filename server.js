import express from 'express';
import dotenv from 'dotenv';
import { getCurrentWeek, getWeekFilePath } from './utils/week.js';
import { readJson, writeJson } from './utils/filedb.js';
import { startAutoTasks } from './utils/auto.js';
import { promises as fsp } from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(isoWeek);
dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
app.use(express.json());
app.use(express.static('public'));

dotenv.config();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const REQUIRED_DAYS = 4;
const PASS_LIMIT = 3;
const ADMIN_ZONE = 'Asia/Seoul';

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

function getWeekInfoFromDate(dateStr) {
  const d = dayjs(dateStr);
  if (!d.isValid()) throw new Error('invalid date');

  const monday = d.startOf('isoWeek');
  const sunday = d.endOf('isoWeek');

  return {
    weekId: `${monday.isoWeekYear()}-W${String(monday.isoWeek()).padStart(2, '0')}`,
    start: monday.format('YYYY-MM-DD'),
    end: sunday.format('YYYY-MM-DD')
  };
}

function getWeekInfoFromWeekId(weekId) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(weekId || '');
  if (!m) throw new Error('invalid weekId');

  const year = Number(m[1]);
  const week = Number(m[2]);

  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    throw new Error('invalid weekId');
  }

  // ISO week 1은 1월 4일이 속한 주
  const mondayOfWeek1 = dayjs(`${year}-01-04`).startOf('isoWeek');
  const monday = mondayOfWeek1.add(week - 1, 'week');
  const sunday = monday.endOf('isoWeek');

  return {
    weekId: `${monday.isoWeekYear()}-W${String(monday.isoWeek()).padStart(2, '0')}`,
    start: monday.format('YYYY-MM-DD'),
    end: sunday.format('YYYY-MM-DD')
  };
}

function normalizeCheckinDate(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

async function loadActiveMembers() {
  const membersData = await readJson('data/members.json', { members: [] });
  const members = Array.isArray(membersData)
    ? membersData
    : (membersData.members || []);
  return members.filter(m => m.active !== false);
}

async function loadMembersStore() {
  const data = await readJson('data/members.json', { members: [] });
  if (Array.isArray(data)) {
    return { data: { members: data }, members: data };
  }

  if (!Array.isArray(data.members)) data.members = [];
  return { data, members: data.members };
}

function getPassBonus(member) {
  const bonus = Number(member?.passBonus);
  return Number.isInteger(bonus) && bonus > 0 ? bonus : 0;
}

function getPassLimit(member) {
  return PASS_LIMIT + getPassBonus(member);
}

function getRecordMemberId(record) {
  return record?.memberId || record?.memberID || record?.userId ||
    record?.userID || record?.uid || record?.id || null;
}

function collectMemberIds(value, ids = new Set()) {
  if (Array.isArray(value)) {
    value.forEach(item => collectMemberIds(item, ids));
    return ids;
  }
  if (!value || typeof value !== 'object') return ids;

  const recordId = getRecordMemberId(value);
  if (recordId) ids.add(String(recordId));

  for (const [key, nested] of Object.entries(value)) {
    if (/^u\d+$/i.test(key)) ids.add(key);
    collectMemberIds(nested, ids);
  }
  return ids;
}

async function loadAttendanceFiles() {
  let names = [];
  try {
    names = await fsp.readdir(path.resolve('data'));
  } catch {
    return [];
  }

  const files = names.filter(name => /^attendance-.+\.json$/.test(name));
  return Promise.all(files.map(async name => ({
    name,
    data: await readJson(path.join('data', name), {})
  })));
}

async function generateMemberId(members) {
  const ids = new Set(members.map(member => String(member.id || '')));
  const ledger = await readJson('data/ledger.json', { entries: [] });
  collectMemberIds(ledger, ids);

  const attendanceFiles = await loadAttendanceFiles();
  attendanceFiles.forEach(file => collectMemberIds(file.data, ids));

  let max = 0;
  for (const id of ids) {
    const match = /^u(\d+)$/i.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `u${String(max + 1).padStart(2, '0')}`;
}

async function memberHasHistoricalRecords(memberId) {
  const ledger = await readJson('data/ledger.json', { entries: [] });
  const hasLedger = (ledger.entries || []).some(entry => entry.memberId === memberId);
  if (hasLedger) return true;

  const attendanceFiles = await loadAttendanceFiles();
  return attendanceFiles.some(file => collectMemberIds(file.data).has(memberId));
}

async function loadWeekAttendanceByWeekId(weekId, fallbackStart, fallbackEnd) {
  const weekPath = getWeekFilePath(weekId);
  const week = await readJson(weekPath, {
    weekId,
    start: fallbackStart,
    end: fallbackEnd,
    checkins: [],
    finalized: false
  });

  if (!Array.isArray(week.checkins)) week.checkins = [];
  if (!week.start) week.start = fallbackStart;
  if (!week.end) week.end = fallbackEnd;
  if (typeof week.finalized !== 'boolean') week.finalized = false;

  return { week, weekPath };
}

function hasCheckinOnDate(week, memberId, dateStr) {
  return (week.checkins || []).some(c =>
    c.memberId === memberId && normalizeCheckinDate(c.date) === dateStr
  );
}

function addExcusedCheckin(week, memberId, dateStr) {
  if (!Array.isArray(week.checkins)) week.checkins = [];
  if (hasCheckinOnDate(week, memberId, dateStr)) return false;

  week.checkins.push({
    memberId,
    date: `${dateStr}T00:00:00.000+09:00`,
    excused: true,
    source: 'admin'
  });
  return true;
}

function removeCheckinOnDate(week, memberId, dateStr) {
  if (!Array.isArray(week.checkins)) week.checkins = [];

  const before = week.checkins.length;

  week.checkins = week.checkins.filter(c => {
    return !(
      c.memberId === memberId &&
      normalizeCheckinDate(c.date) === dateStr
    );
  });

  return before !== week.checkins.length;
}

function removeCheckinsOnDates(week, memberId, dateStrs) {
  if (!Array.isArray(week.checkins)) week.checkins = [];

  const targetDates = new Set(dateStrs);
  const before = week.checkins.length;

  week.checkins = week.checkins.filter(c => {
    return !(
      c.memberId === memberId &&
      targetDates.has(normalizeCheckinDate(c.date))
    );
  });

  return before - week.checkins.length;
}

function countUniqueAttendanceDays(week, memberId) {
  const dates = new Set(
    (week.checkins || [])
      .filter(c => c.memberId === memberId)
      .map(c => normalizeCheckinDate(c.date))
      .filter(Boolean)
  );
  return dates.size;
}

function toMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeLedgerEntry(e) {
  const extraFine = toMoney(e.extraFine);
  const legacyFine = toMoney(e.fine);
  const hasAttendanceFine = e.attendanceFine !== undefined && e.attendanceFine !== null;
  const attendanceFine = hasAttendanceFine
    ? toMoney(e.attendanceFine)
    : Math.max(0, legacyFine - extraFine);
  const passUsed = e.passUsed === true;
  const fine = attendanceFine + extraFine;

  return {
    ...e,
    attendanceFine,
    extraFine,
    extraFineReason: e.extraFineReason || '',
    passUsed,
    passUsedAt: passUsed ? (e.passUsedAt || null) : null,
    fine
  };
}

function applyLedgerFine(entry, attendanceFine, deficit) {
  const normalized = normalizeLedgerEntry(entry);
  const extraFine = normalized.extraFine;
  const passUsed = normalized.passUsed;

  entry.deficit = deficit;
  entry.attendanceFine = passUsed ? 0 : attendanceFine;
  entry.extraFine = extraFine;
  entry.extraFineReason = normalized.extraFineReason;
  entry.passUsed = passUsed;
  entry.passUsedAt = passUsed ? normalized.passUsedAt : null;
  entry.fine = entry.attendanceFine + entry.extraFine;
  if (!Array.isArray(entry.payments)) entry.payments = [];

  return entry;
}

function calculateAttendancePenalty(week, memberId) {
  const count = countUniqueAttendanceDays(week, memberId);
  const deficit = Math.max(0, REQUIRED_DAYS - count);
  const attendanceFine = count >= REQUIRED_DAYS ? 0 : 10000;
  return { count, deficit, attendanceFine };
}

async function validateActiveMember(memberId) {
  const members = await loadActiveMembers();
  const member = members.find(m => m.id === memberId);
  if (!member) return null;
  return member;
}

async function findOrCreateLedgerEntry(ledger, weekId, memberId) {
  const info = getWeekInfoFromWeekId(weekId);
  const { week } = await loadWeekAttendanceByWeekId(info.weekId, info.start, info.end);
  const { deficit, attendanceFine } = calculateAttendancePenalty(week, memberId);

  let entry = (ledger.entries || []).find(
    e => e.weekId === info.weekId && e.memberId === memberId
  );

  if (!entry) {
    entry = {
      weekId: info.weekId,
      memberId,
      finalizedAt: new Date().toISOString(),
      payments: []
    };
    if (!Array.isArray(ledger.entries)) ledger.entries = [];
    ledger.entries.push(entry);
  }

  applyLedgerFine(entry, attendanceFine, deficit);
  return { entry, week, info };
}

function countPassesForMember(ledger, memberId, excludeWeekId = null) {
  return (ledger.entries || []).filter(e =>
    e.memberId === memberId &&
    e.weekId !== excludeWeekId &&
    normalizeLedgerEntry(e).passUsed
  ).length;
}

function normalizeFundExpenses(ledger) {
  return Array.isArray(ledger.fundExpenses)
    ? ledger.fundExpenses.map(expense => ({
        ...expense,
        amount: toMoney(expense.amount),
        reason: String(expense.reason || ''),
        canceledAt: expense.canceledAt || null
      }))
    : [];
}

function calculateFundSummary(ledger) {
  const totalCollected = (ledger.entries || []).reduce((entrySum, entry) => {
    const paid = Array.isArray(entry.payments)
      ? entry.payments.reduce(
          (paymentSum, payment) => paymentSum + toMoney(payment.amount),
          0
        )
      : 0;
    return entrySum + paid;
  }, 0);

  const expenses = normalizeFundExpenses(ledger);
  const totalSpent = expenses.reduce(
    (sum, expense) => expense.canceledAt ? sum : sum + expense.amount,
    0
  );

  return {
    totalCollected,
    totalSpent,
    availableBalance: totalCollected - totalSpent,
    expenses
  };
}

function calculateFundTrend(ledger) {
  const byWeek = new Map();
  const ensureWeek = weekId => {
    if (!byWeek.has(weekId)) {
      byWeek.set(weekId, {
        weekId,
        weeklyFine: 0,
        weeklyCollected: 0,
        weeklySpent: 0
      });
    }
    return byWeek.get(weekId);
  };

  for (const rawEntry of ledger.entries || []) {
    const entry = normalizeLedgerEntry(rawEntry);
    if (!entry.weekId) continue;

    ensureWeek(entry.weekId).weeklyFine += toMoney(entry.fine);

    const payments = Array.isArray(entry.payments) ? entry.payments : [];
    for (const payment of payments) {
      let paymentWeekId = entry.weekId;
      if (payment.paidAt) {
        const paidAt = dayjs(payment.paidAt);
        if (paidAt.isValid()) {
          const paidInSeoul = paidAt.tz(ADMIN_ZONE);
          paymentWeekId =
            `${paidInSeoul.isoWeekYear()}-W${String(paidInSeoul.isoWeek()).padStart(2, '0')}`;
        }
      }
      ensureWeek(paymentWeekId).weeklyCollected += toMoney(payment.amount);
    }
  }

  for (const expense of normalizeFundExpenses(ledger)) {
    if (!expense.weekId || expense.canceledAt) continue;
    ensureWeek(expense.weekId).weeklySpent += expense.amount;
  }

  let cumulativeFine = 0;
  let cumulativeCollected = 0;
  let cumulativeSpent = 0;

  return Array.from(byWeek.values())
    .sort((a, b) => a.weekId.localeCompare(b.weekId))
    .map(row => {
      cumulativeFine += row.weeklyFine;
      cumulativeCollected += row.weeklyCollected;
      cumulativeSpent += row.weeklySpent;

      return {
        ...row,
        cumulativeFine,
        cumulativeCollected,
        cumulativeSpent,
        availableBalance: cumulativeCollected - cumulativeSpent
      };
    });
}

async function recalcLedgerForWeek(weekId, week) {
  const ledger = await readJson('data/ledger.json', { entries: [] });
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  const members = await loadActiveMembers();

  const finalizedAt = new Date().toISOString();

  for (const m of members) {
    const { deficit, attendanceFine } = calculateAttendancePenalty(week, m.id);

    const existing = (ledger.entries || []).find(
      e => e.weekId === weekId && e.memberId === m.id
    );

    if (existing) {
      applyLedgerFine(existing, attendanceFine, deficit);
      existing.finalizedAt = existing.finalizedAt || finalizedAt;
    } else {
      const entry = {
        weekId,
        memberId: m.id,
        finalizedAt,
        payments: []
      };
      applyLedgerFine(entry, attendanceFine, deficit);
      ledger.entries.push(entry);
    }
  }

  await writeJson('data/ledger.json', ledger);
}

// POST /api/finalize  : 주간 마감
app.post('/api/finalize', authAdmin, async (req, res) => {
  try {
    const { weekId, start, end } = getCurrentWeek();
    const weekPath = getWeekFilePath(weekId);

    const week = await readJson(weekPath, {
      weekId,
      start,
      end,
      checkins: [],
      finalized: false,
    });
    if (week.finalized) {
      return res.json({ ok: true, message: 'already finalized', weekId });
    }

    // ===== 파일 저장 =====
    week.finalized = true;
    await writeJson(weekPath, week);
    await recalcLedgerForWeek(weekId, week);

    return res.json({ ok: true, message: 'week finalized', weekId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/members', async (req, res) => {
  const data = await readJson('data/members.json', { members: [] });
  const activeMembers = data.members.filter(m => m.active !== false);
  res.json(activeMembers);
});

app.get('/api/admin/members', authAdmin, async (req, res) => {
  try {
    const { members } = await loadMembersStore();
    const ledger = await readJson('data/ledger.json', { entries: [] });
    const passCounts = {};

    for (const entry of ledger.entries || []) {
      if (normalizeLedgerEntry(entry).passUsed) {
        passCounts[entry.memberId] = (passCounts[entry.memberId] || 0) + 1;
      }
    }

    const rows = members.map(member => {
      const passUsedCount = passCounts[member.id] || 0;
      const passBonus = getPassBonus(member);
      const passLimit = getPassLimit(member);
      return {
        ...member,
        active: member.active !== false,
        passBonus,
        passLimit,
        passUsedCount,
        passRemaining: Math.max(0, passLimit - passUsedCount)
      };
    });

    return res.json({ members: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/members', authAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, members } = await loadMembersStore();
    const normalizedName = name.toLocaleLowerCase('ko-KR');
    const duplicate = members.some(member =>
      String(member.name || '').trim().toLocaleLowerCase('ko-KR') === normalizedName
    );
    if (duplicate) {
      return res.status(409).json({ error: '같은 이름의 멤버가 이미 있습니다.' });
    }

    const member = {
      id: await generateMemberId(members),
      name,
      active: true,
      passBonus: 0
    };
    members.push(member);
    data.members = members;
    await writeJson('data/members.json', data);

    return res.status(201).json({
      ok: true,
      member: {
        ...member,
        passLimit: PASS_LIMIT,
        passUsedCount: 0,
        passRemaining: PASS_LIMIT
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.patch('/api/admin/members/:memberId/status', authAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'boolean active is required' });
    }

    const { data, members } = await loadMembersStore();
    const member = members.find(item => item.id === memberId);
    if (!member) {
      return res.status(404).json({ error: 'member not found' });
    }

    member.active = active;
    data.members = members;
    await writeJson('data/members.json', data);
    return res.json({ ok: true, member });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/admin/members/:memberId', authAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const { data, members } = await loadMembersStore();
    const index = members.findIndex(member => member.id === memberId);
    if (index < 0) {
      return res.status(404).json({ error: 'member not found' });
    }

    if (await memberHasHistoricalRecords(memberId)) {
      return res.status(409).json({
        error: '출석 또는 정산 기록이 있는 멤버는 삭제할 수 없습니다. 비활성화를 사용하세요.'
      });
    }

    const [member] = members.splice(index, 1);
    data.members = members;
    await writeJson('data/members.json', data);
    return res.json({ ok: true, member });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/members/:memberId/pass-grant', authAdmin, async (req, res) => {
  try {
    const { memberId } = req.params;
    const { data, members } = await loadMembersStore();
    const member = members.find(item => item.id === memberId);
    if (!member) {
      return res.status(404).json({ error: 'member not found' });
    }
    if (member.active === false) {
      return res.status(400).json({ error: '비활성 멤버에게는 까방권을 추가할 수 없습니다.' });
    }

    member.passBonus = getPassBonus(member) + 1;
    data.members = members;
    await writeJson('data/members.json', data);

    const ledger = await readJson('data/ledger.json', { entries: [] });
    const passUsedCount = countPassesForMember(ledger, memberId);
    const passLimit = getPassLimit(member);
    return res.json({
      ok: true,
      memberId,
      passBonus: member.passBonus,
      passLimit,
      passUsedCount,
      passRemaining: Math.max(0, passLimit - passUsedCount)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
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
    const allEntries = (ledger.entries || []).map(e => normalizeLedgerEntry(e));
    const { members } = await loadMembersStore();
    const passLimitByMember = Object.fromEntries(
      members.map(member => [member.id, getPassLimit(member)])
    );
    const passCounts = {};
    for (const e of allEntries) {
      if (e.passUsed) passCounts[e.memberId] = (passCounts[e.memberId] || 0) + 1;
    }

    let entries = allEntries.map(e => {
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
            totalAttendanceFine: 0,
            totalExtraFine: 0,
            totalPaid: 0,
            outstanding: 0,
            weeks: new Set(),
            passUsedCount: passCounts[e.memberId] || 0,
            passUsedInRows: 0
          };
        }
        byMember[e.memberId].totalDeficit += e.deficit || 0;
        byMember[e.memberId].totalFine += e.fine;
        byMember[e.memberId].totalAttendanceFine += e.attendanceFine || 0;
        byMember[e.memberId].totalExtraFine += e.extraFine || 0;
        byMember[e.memberId].totalPaid += e.totalPaid;
        byMember[e.memberId].outstanding += e.outstanding;
        byMember[e.memberId].weeks.add(e.weekId);
        if (e.passUsed) byMember[e.memberId].passUsedInRows += 1;
      }
      const rows = Object.values(byMember).map(x => {
        const passLimit = passLimitByMember[x.memberId] || PASS_LIMIT;
        return {
          memberId: x.memberId,
          totalDeficit: x.totalDeficit,
          totalFine: x.totalFine,
          totalAttendanceFine: x.totalAttendanceFine,
          totalExtraFine: x.totalExtraFine,
          totalPaid: x.totalPaid,
          outstanding: x.outstanding,
          fullyPaid: x.outstanding === 0,
          passUsedCount: x.passUsedCount,
          passUsedInRows: x.passUsedInRows,
          passLimit,
          passRemaining: Math.max(0, passLimit - x.passUsedCount),
          weeks: Array.from(x.weeks).sort()
        };
      }).sort((a,b)=> a.memberId > b.memberId ? 1 : -1);
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
    const { memberId, paidAmount } = req.body || {};

    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    const amount = Number(paidAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'paidAmount must be a positive number' });
    }

    const ledger = await readJson('data/ledger.json', { entries: [] });

    const memberEntries = (ledger.entries || [])
      .filter(e => e.memberId === memberId)
      .map(e => {
        const normalized = normalizeLedgerEntry(e);
        const fine = Number(normalized.fine) || 0;
        const paid = Array.isArray(e.payments)
          ? e.payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
          : 0;
        const outstanding = Math.max(0, fine - paid);
        return { entry: e, fine, paid, outstanding };
      })
      .filter(x => x.outstanding > 0)
      .sort((a, b) => (a.entry.weekId > b.entry.weekId ? 1 : -1)); // 오래된 주차부터

    if (!memberEntries.length) {
      return res.status(400).json({ error: '해당 멤버의 미납 내역이 없습니다.' });
    }

    const totalOutstanding = memberEntries.reduce((sum, x) => sum + x.outstanding, 0);
    if (amount > totalOutstanding) {
      return res.status(400).json({
        error: `납부 금액이 총 미납액(${totalOutstanding.toLocaleString()}원)을 초과합니다.`
      });
    }

    let remaining = amount;
    const paidAt = new Date().toISOString();
    const batchId = `pay_${Date.now()}_${memberId}`;
    const allocations = [];

    for (const item of memberEntries) {
      if (remaining <= 0) break;

      const appliedAmount = Math.min(item.outstanding, remaining);
      if (appliedAmount <= 0) continue;

      if (!Array.isArray(item.entry.payments)) item.entry.payments = [];
      item.entry.payments.push({
        amount: appliedAmount,
        paidAt,
        batchId
      });

      allocations.push({
        weekId: item.entry.weekId,
        appliedAmount
      });

      remaining -= appliedAmount;
    }

    await writeJson('data/ledger.json', ledger);

    const refreshedEntries = (ledger.entries || [])
      .filter(e => e.memberId === memberId)
      .map(e => {
        const normalized = normalizeLedgerEntry(e);
        const fine = Number(normalized.fine) || 0;
        const totalPaid = Array.isArray(e.payments)
          ? e.payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
          : 0;
        const outstanding = Math.max(0, fine - totalPaid);
        return { fine, totalPaid, outstanding };
      });

    const memberTotalFine = refreshedEntries.reduce((sum, e) => sum + e.fine, 0);
    const memberTotalPaid = refreshedEntries.reduce((sum, e) => sum + e.totalPaid, 0);
    const memberOutstanding = refreshedEntries.reduce((sum, e) => sum + e.outstanding, 0);

    return res.json({
      ok: true,
      memberId,
      paidAmount: amount,
      allocations,
      memberTotalFine,
      memberTotalPaid,
      memberOutstanding,
      fullyPaid: memberOutstanding === 0
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/admin/fund', authAdmin, async (req, res) => {
  try {
    const ledger = await readJson('data/ledger.json', { entries: [] });
    const summary = calculateFundSummary(ledger);
    const expenses = summary.expenses
      .slice()
      .sort((a, b) => String(b.spentAt || '').localeCompare(String(a.spentAt || '')));

    return res.json({
      totalCollected: summary.totalCollected,
      totalSpent: summary.totalSpent,
      availableBalance: summary.availableBalance,
      expenses,
      trend: calculateFundTrend(ledger)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/fund/expenses', authAdmin, async (req, res) => {
  try {
    const { weekId, amount, reason } = req.body || {};

    if (!weekId) {
      return res.status(400).json({ error: 'weekId is required' });
    }

    let info;
    try {
      info = getWeekInfoFromWeekId(weekId);
    } catch {
      return res.status(400).json({ error: 'invalid weekId' });
    }

    const expenseAmount = Number(amount);
    if (!Number.isInteger(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive integer' });
    }

    const expenseReason = String(reason || '').trim();
    if (!expenseReason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const ledger = await readJson('data/ledger.json', { entries: [] });
    const summary = calculateFundSummary(ledger);

    if (expenseAmount > summary.availableBalance) {
      return res.status(400).json({
        error: `사용 금액이 현재 사용 가능액(${summary.availableBalance.toLocaleString()}원)을 초과합니다.`
      });
    }

    if (!Array.isArray(ledger.fundExpenses)) ledger.fundExpenses = [];

    const spentAt = new Date().toISOString();
    const expense = {
      id: `fund_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      weekId: info.weekId,
      amount: expenseAmount,
      reason: expenseReason,
      spentAt,
      canceledAt: null
    };

    ledger.fundExpenses.push(expense);
    await writeJson('data/ledger.json', ledger);

    const refreshed = calculateFundSummary(ledger);
    return res.json({
      ok: true,
      expense,
      totalCollected: refreshed.totalCollected,
      totalSpent: refreshed.totalSpent,
      availableBalance: refreshed.availableBalance
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/fund/expenses/:expenseId/cancel', authAdmin, async (req, res) => {
  try {
    const { expenseId } = req.params;
    const ledger = await readJson('data/ledger.json', { entries: [] });

    if (!Array.isArray(ledger.fundExpenses)) ledger.fundExpenses = [];
    const expense = ledger.fundExpenses.find(item => item.id === expenseId);

    if (!expense) {
      return res.status(404).json({ error: 'fund expense not found' });
    }

    let alreadyCanceled = true;
    if (!expense.canceledAt) {
      expense.canceledAt = new Date().toISOString();
      alreadyCanceled = false;
      await writeJson('data/ledger.json', ledger);
    }

    const summary = calculateFundSummary(ledger);
    return res.json({
      ok: true,
      expense,
      alreadyCanceled,
      totalCollected: summary.totalCollected,
      totalSpent: summary.totalSpent,
      availableBalance: summary.availableBalance
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
    const activeMembers = members.filter(m => m.active !== false);

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
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
      if (typeof v === 'string' && v.trim()) {
        const s = v.trim();
        const m = s.match(/\d{4}-\d{2}-\d{2}/);
        if (m) return m[0];
        if (s.length >= 10 && s[4] === '-' && s[7] === '-') return s.slice(0, 10);
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
    const scanMemberDatesMap = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [mid, v] of Object.entries(obj)) {
        if (!dateMap.has(mid)) dateMap.set(mid, new Set());
        if (Array.isArray(v)) {
          v.forEach(d => {
            const ds = toDateStr(d);
            if (ds) dateMap.get(mid).add(ds);
          });
        } else if (v && typeof v === 'object') {
          Object.keys(v).forEach(k => {
            const ds = toDateStr(k);
            if (ds && v[k]) dateMap.get(mid).add(ds);
          });
        }
      }
    };

    scanMemberDatesMap(wdata.perMemberDates);
    scanMemberDatesMap(wdata.perMemberDays);
    scanMemberDatesMap(wdata.memberDates);

    const scanByDate = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const ds = toDateStr(k);
        if (!ds) continue;
        if (Array.isArray(v)) {
          v.forEach(mid => touch(mid, ds));
        } else if (v && typeof v === 'object') {
          Object.entries(v).forEach(([mid, flag]) => {
            if (flag) touch(mid, ds);
          });
        }
      }
    };

    scanByDate(wdata.byDate);

    // ---------- 3) 카운트 필드 계열 ----------
    const getCountFromAny = (obj, mid) => {
      if (!obj || typeof obj !== 'object') return 0;
      const v = obj[mid];
      return Number.isFinite(Number(v)) ? Number(v) : 0;
    };

    const countsCandidate = wdata.perMemberCount || wdata.counts || {};
    const perMember = wdata.perMember || {};

    // ---------- 4) 최종 리스트 ----------
    const list = activeMembers.map(m => {
      const id = m.id;
      const datesSet = dateMap.get(id) || new Set();
      const dates = Array.from(datesSet).sort();
      const fromDates = datesSet.size;
      const fromPerMember = getCountFromAny(perMember, id);
      const fromCounts = getCountFromAny(countsCandidate, id);
      const fromRaw = rawCountMap.get(id) || 0;

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

    // 진행 현황도 주 4회 기준으로 표시
    const REQUIRED_DAYS = 4;
    const totalSlots = activeMembers.length * REQUIRED_DAYS;
    const filledSlots = list.reduce(
      (sum, m) => sum + Math.min((m.count || 0), REQUIRED_DAYS),
      0
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      weekId,
      start: wdata.start,
      end: wdata.end,
      finalized: !!wdata.finalized,
      totalMembers: activeMembers.length,
      checkedIn,
      requiredPerMember: REQUIRED_DAYS,
      totalSlots,
      filledSlots,
      list
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'failed to load current attendance' });
  }
});

app.post('/api/admin/attendance/excuse', authAdmin, async (req, res) => {
  try {
    const { memberId, date } = req.body || {};

    if (!memberId || !date) {
      return res.status(400).json({ error: 'memberId and date are required' });
    }

    const members = await loadActiveMembers();
    const member = members.find(m => m.id === memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const info = getWeekInfoFromDate(date);
    const { week, weekPath } = await loadWeekAttendanceByWeekId(
      info.weekId,
      info.start,
      info.end
    );

    const added = addExcusedCheckin(week, memberId, date);

    await writeJson(weekPath, week);

    let ledgerRecalculated = false;
    if (week.finalized) {
      await recalcLedgerForWeek(info.weekId, week);
      ledgerRecalculated = true;
    }

    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      date,
      added,
      finalized: !!week.finalized,
      ledgerRecalculated
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/attendance/cancel', authAdmin, async (req, res) => {
  try {
    const { memberId, date } = req.body || {};

    if (!memberId || !date) {
      return res.status(400).json({ error: 'memberId and date are required' });
    }

    const members = await loadActiveMembers();
    const member = members.find(m => m.id === memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const info = getWeekInfoFromDate(date);
    const { week, weekPath } = await loadWeekAttendanceByWeekId(
      info.weekId,
      info.start,
      info.end
    );

    const removed = removeCheckinOnDate(week, memberId, date);

    await writeJson(weekPath, week);

    let ledgerRecalculated = false;
    if (week.finalized) {
      await recalcLedgerForWeek(info.weekId, week);
      ledgerRecalculated = true;
    }

    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      date,
      removed,
      finalized: !!week.finalized,
      ledgerRecalculated
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/attendance/excuse-member-week', authAdmin, async (req, res) => {
  try {
    const { memberId, weekId } = req.body || {};

    if (!memberId || !weekId) {
      return res.status(400).json({ error: 'memberId and weekId are required' });
    }

    const member = await validateActiveMember(memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const info = getWeekInfoFromWeekId(weekId);
    const { week, weekPath } = await loadWeekAttendanceByWeekId(
      info.weekId,
      info.start,
      info.end
    );

    const monday = dayjs(info.start);
    const targetDates = [0, 1, 2, 3].map(offset =>
      monday.add(offset, 'day').format('YYYY-MM-DD')
    );

    let addedCount = 0;
    for (const dateStr of targetDates) {
      const added = addExcusedCheckin(week, memberId, dateStr);
      if (added) addedCount += 1;
    }

    await writeJson(weekPath, week);

    let ledgerRecalculated = false;
    if (week.finalized) {
      await recalcLedgerForWeek(info.weekId, week);
      ledgerRecalculated = true;
    }

    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      dates: targetDates,
      addedCount,
      finalized: !!week.finalized,
      ledgerRecalculated
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/attendance/cancel-member-week', authAdmin, async (req, res) => {
  try {
    const { memberId, weekId } = req.body || {};

    if (!memberId || !weekId) {
      return res.status(400).json({ error: 'memberId and weekId are required' });
    }

    const member = await validateActiveMember(memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const info = getWeekInfoFromWeekId(weekId);
    const { week, weekPath } = await loadWeekAttendanceByWeekId(
      info.weekId,
      info.start,
      info.end
    );

    const monday = dayjs(info.start);
    const targetDates = [0, 1, 2, 3].map(offset =>
      monday.add(offset, 'day').format('YYYY-MM-DD')
    );

    const removedCount = removeCheckinsOnDates(week, memberId, targetDates);

    await writeJson(weekPath, week);

    let ledgerRecalculated = false;
    if (week.finalized) {
      await recalcLedgerForWeek(info.weekId, week);
      ledgerRecalculated = true;
    }

    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      dates: targetDates,
      removedCount,
      finalized: !!week.finalized,
      ledgerRecalculated
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/attendance/excuse-week', authAdmin, async (req, res) => {
  try {
    const { weekId } = req.body || {};

    if (!weekId) {
      return res.status(400).json({ error: 'weekId is required' });
    }

    const info = getWeekInfoFromWeekId(weekId);
    const { week, weekPath } = await loadWeekAttendanceByWeekId(
      info.weekId,
      info.start,
      info.end
    );

    const members = await loadActiveMembers();

    const monday = dayjs(info.start);
    const targetDates = [0, 1, 2, 3, 4].map(offset =>
      monday.add(offset, 'day').format('YYYY-MM-DD')
    );

    let addedCount = 0;

    for (const m of members) {
      for (const dateStr of targetDates) {
        const added = addExcusedCheckin(week, m.id, dateStr);
        if (added) addedCount += 1;
      }
    }

    await writeJson(weekPath, week);

    let ledgerRecalculated = false;
    if (week.finalized) {
      await recalcLedgerForWeek(info.weekId, week);
      ledgerRecalculated = true;
    }

    return res.json({
      ok: true,
      weekId: info.weekId,
      dates: targetDates,
      addedCount,
      finalized: !!week.finalized,
      ledgerRecalculated
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/ledger/extra-fine', authAdmin, async (req, res) => {
  try {
    const { memberId, weekId, amount, reason } = req.body || {};

    if (!memberId || !weekId) {
      return res.status(400).json({ error: 'memberId and weekId are required' });
    }

    const member = await validateActiveMember(memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const extraFine = Number(amount);
    if (!Number.isFinite(extraFine) || extraFine < 0) {
      return res.status(400).json({ error: 'amount must be a non-negative number' });
    }

    const ledger = await readJson('data/ledger.json', { entries: [] });
    const { entry, info } = await findOrCreateLedgerEntry(ledger, weekId, memberId);

    entry.extraFine = Math.round(extraFine);
    entry.extraFineReason = entry.extraFine > 0 ? String(reason || '').trim() : '';
    applyLedgerFine(entry, entry.attendanceFine, entry.deficit || 0);

    await writeJson('data/ledger.json', ledger);

    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      ...normalizeLedgerEntry(entry)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/admin/ledger/pass', authAdmin, async (req, res) => {
  try {
    const { memberId, weekId, used } = req.body || {};

    if (!memberId || !weekId || typeof used !== 'boolean') {
      return res.status(400).json({ error: 'memberId, weekId and boolean used are required' });
    }

    const member = await validateActiveMember(memberId);
    if (!member) {
      return res.status(404).json({ error: 'active member not found' });
    }

    const ledger = await readJson('data/ledger.json', { entries: [] });
    const { entry, week, info } = await findOrCreateLedgerEntry(ledger, weekId, memberId);

    const current = normalizeLedgerEntry(entry);
    const usedCountExcludingCurrent = countPassesForMember(ledger, memberId, info.weekId);
    const passLimit = getPassLimit(member);

    if (used && !current.passUsed && usedCountExcludingCurrent >= passLimit) {
      return res.status(400).json({ error: `까방권은 이 멤버에게 최대 ${passLimit}회까지 사용할 수 있습니다.` });
    }

    entry.passUsed = used;
    entry.passUsedAt = used ? (current.passUsedAt || new Date().toISOString()) : null;

    const { deficit, attendanceFine } = calculateAttendancePenalty(week, memberId);
    applyLedgerFine(entry, attendanceFine, deficit);

    await writeJson('data/ledger.json', ledger);

    const passUsedCount = countPassesForMember(ledger, memberId);
    return res.json({
      ok: true,
      weekId: info.weekId,
      memberId,
      passUsedCount,
      passLimit,
      passRemaining: Math.max(0, passLimit - passUsedCount),
      ...normalizeLedgerEntry(entry)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  startAutoTasks(); // ✅ 자동 스케줄러 시작
});
