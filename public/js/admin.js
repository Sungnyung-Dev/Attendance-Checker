// /public/js/admin.js

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || '요청 실패';
    throw new Error(msg);
  }
  return data;
}

function $(sel) {
  return document.querySelector(sel);
}

function setAlert(type, msg) {
  const box = $('#result');
  box.className = `alert alert-${type}`;
  box.textContent = msg;
  box.classList.remove('d-none');
}

function getToken() {
  return localStorage.getItem('eco_admin_token') || '';
}

function setToken(v) {
  localStorage.setItem('eco_admin_token', v || '');
}

function fmtWeekId(id) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(id || '');
  return m ? `${m[1]}-W${m[2].padStart(2, '0')}` : (id || '');
}

const KRW = new Intl.NumberFormat('ko-KR');
function fmtWon(n) {
  return KRW.format(Number(n) || 0) + '원';
}

function escapeHTML(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getTodayLocalDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let memberMap = null;
let adminMembers = [];
const memberSelectIds = [
  'excuseMemberId',
  'memberWeekMemberId',
  'extraFineMemberId',
  'passMemberId'
];
const weekSelectIds = [
  'excuseWeekId',
  'memberWeekId',
  'extraFineWeekId',
  'passWeekId',
  'fundExpenseWeekId'
];

async function ensureMemberMap() {
  if (memberMap) return memberMap;
  try {
    const list = await fetchJSON('/api/members');
    memberMap = {};
    list.forEach(m => {
      memberMap[m.id] = m.name || m.id;
    });
  } catch {
    memberMap = {};
  }
  return memberMap;
}

async function loadWeek() {
  try {
    const info = await fetchJSON('/api/week');
    $('#weekInfo').textContent =
      `${fmtWeekId(info.weekId)} · ${info.start} ~ ${info.end}` +
      (info.finalized ? ' (마감됨)' : '');

    $('#excuseDate').value = getTodayLocalDateString();
  } catch {
    $('#weekInfo').textContent = '주 정보 로딩 실패';
    $('#excuseDate').value = getTodayLocalDateString();
  }
}

async function loadExcuseControls() {
  await ensureMemberMap();

  try {
    const members = await fetchJSON('/api/members');
    memberSelectIds.forEach(id => {
      const memberSel = document.getElementById(id);
      if (!memberSel) return;
      const selected = memberSel.value;
      memberSel.innerHTML = `<option value="">멤버를 선택하세요</option>`;
      members.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name || m.id} (${m.id})`;
        memberSel.appendChild(opt);
      });
      if (selected) memberSel.value = selected;
    });
  } catch {
    memberSelectIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">멤버 불러오기 실패</option>`;
    });
  }

  try {
    const hist = await fetchJSON('/api/ledger?summary=week');

    const weekIds = new Set((hist.rows || []).map(r => r.weekId));
    const current = await fetchJSON('/api/week');
    if (current?.weekId) weekIds.add(current.weekId);

    const sorted = Array.from(weekIds).sort((a, b) => (a > b ? -1 : 1));

    weekSelectIds.forEach(id => {
      const weekSel = document.getElementById(id);
      if (!weekSel) return;
      const selected = weekSel.value;
      weekSel.innerHTML = `<option value="">주차를 선택하세요</option>`;
      sorted.forEach(weekId => {
        const opt = document.createElement('option');
        opt.value = weekId;
        opt.textContent = fmtWeekId(weekId);
        weekSel.appendChild(opt);
      });
      weekSel.value = selected || current?.weekId || '';
    });
  } catch {
    weekSelectIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">주차 불러오기 실패</option>`;
    });
  }
}

function renderPassMemberStatus() {
  const memberId = $('#passMemberId').value;
  const status = $('#passMemberStatus');
  const member = adminMembers.find(item => item.id === memberId);

  if (!memberId) {
    status.textContent = '멤버를 선택하세요.';
    return;
  }
  if (!member) {
    status.textContent = '까방권 정보를 불러오지 못했습니다.';
    return;
  }

  status.textContent =
    `사용 ${Number(member.passUsedCount) || 0}/${Number(member.passLimit) || 3}`;
}

async function loadAdminMembers() {
  const tbody = $('#adminMemberBody');
  const token = getToken();

  if (!token) {
    adminMembers = [];
    tbody.innerHTML =
      `<tr><td colspan="5" class="text-center text-muted">관리자 토큰 저장 후 조회할 수 있습니다.</td></tr>`;
    renderPassMemberStatus();
    return;
  }

  tbody.innerHTML =
    `<tr><td colspan="5" class="text-center text-muted">로딩 중...</td></tr>`;

  try {
    const data = await fetchJSON('/api/admin/members', {
      headers: { 'x-admin-token': token }
    });
    adminMembers = data.members || [];
    if (!memberMap) memberMap = {};
    adminMembers.forEach(member => {
      memberMap[member.id] = member.name || member.id;
    });

    if (!adminMembers.length) {
      tbody.innerHTML =
        `<tr><td colspan="5" class="text-center text-muted">등록된 멤버가 없습니다.</td></tr>`;
      renderPassMemberStatus();
      return;
    }

    tbody.innerHTML = adminMembers.map(member => {
      const active = member.active !== false;
      const statusBadge = active
        ? '<span class="badge text-bg-success">활성</span>'
        : '<span class="badge text-bg-secondary">비활성</span>';
      const statusButton = active
        ? `<button class="btn btn-outline-secondary btn-sm member-status-btn"
                   data-member-id="${escapeHTML(member.id)}" data-active="false">비활성화</button>`
        : `<button class="btn btn-outline-primary btn-sm member-status-btn"
                   data-member-id="${escapeHTML(member.id)}" data-active="true">활성화</button>`;

      return `
        <tr${active ? '' : ' class="text-muted"'}>
          <td>${escapeHTML(member.name || member.id)}</td>
          <td><span class="text-muted small">${escapeHTML(member.id)}</span></td>
          <td>사용 ${Number(member.passUsedCount) || 0}/${Number(member.passLimit) || 3}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="d-flex flex-wrap gap-1">
              ${statusButton}
              <button class="btn btn-outline-danger btn-sm delete-member-btn"
                      data-member-id="${escapeHTML(member.id)}">삭제</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    renderPassMemberStatus();
  } catch (err) {
    adminMembers = [];
    tbody.innerHTML =
      `<tr><td colspan="5" class="text-center text-danger">조회 실패: ${escapeHTML(err.message || '오류')}</td></tr>`;
    renderPassMemberStatus();
    setAlert('danger', err.message || '멤버 목록 조회 실패');
  }
}

async function refreshMemberManagement() {
  memberMap = null;
  await loadExcuseControls();
  await loadAdminMembers();
  await loadMemberSummary();
}

async function addMember() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const name = $('#newMemberName').value.trim();
    if (!name) throw new Error('새 멤버 이름을 입력하세요.');

    const data = await fetchJSON('/api/admin/members', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ name })
    });

    $('#newMemberName').value = '';
    setAlert('success', `${data.member.name} (${data.member.id}) 멤버를 추가했습니다.`);
    await refreshMemberManagement();
  } catch (err) {
    setAlert('danger', err.message || '멤버 추가 실패');
  }
}

async function setMemberStatus(memberId, active) {
  const member = adminMembers.find(item => item.id === memberId);
  const name = member?.name || memberId;
  const verb = active ? '활성화' : '비활성화';
  if (!confirm(`${name} 멤버를 ${verb}하시겠습니까?`)) return;

  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    await fetchJSON(`/api/admin/members/${encodeURIComponent(memberId)}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ active })
    });

    setAlert('success', `${name} 멤버를 ${verb}했습니다.`);
    await refreshMemberManagement();
  } catch (err) {
    setAlert('danger', err.message || `멤버 ${verb} 실패`);
  }
}

async function deleteMember(memberId) {
  const member = adminMembers.find(item => item.id === memberId);
  const name = member?.name || memberId;
  if (!confirm(`${name} 멤버를 삭제하시겠습니까? 기록이 있는 멤버는 삭제되지 않습니다.`)) return;

  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    await fetchJSON(`/api/admin/members/${encodeURIComponent(memberId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': token }
    });

    setAlert('warning', `${name} 멤버를 삭제했습니다.`);
    await refreshMemberManagement();
  } catch (err) {
    setAlert('danger', err.message || '멤버 삭제 실패');
  }
}

async function grantPass() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#passMemberId').value;
    if (!memberId) throw new Error('멤버를 선택하세요.');
    const member = adminMembers.find(item => item.id === memberId);
    const name = member?.name || memberMap?.[memberId] || memberId;
    if (!confirm(`${name} 멤버의 까방권 사용 한도를 1회 늘리시겠습니까?`)) return;

    const data = await fetchJSON(
      `/api/admin/members/${encodeURIComponent(memberId)}/pass-grant`,
      {
        method: 'POST',
        headers: { 'x-admin-token': token }
      }
    );

    setAlert(
      'success',
      `${name} · 까방권 추가 완료 (사용 ${data.passUsedCount}/${data.passLimit})`
    );
    await loadAdminMembers();
    await loadMemberSummary();
  } catch (err) {
    setAlert('danger', err.message || '까방권 추가 실패');
  }
}

async function finalizeWeek() {
  const btn = $('#finalizeBtn');
  btn.disabled = true;
  setAlert('secondary', '마감 처리 중…');

  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const res = await fetchJSON('/api/finalize', {
      method: 'POST',
      headers: { 'x-admin-token': token }
    });

    if (res.message === 'already finalized') {
      setAlert('info', `이미 마감된 주입니다. (${fmtWeekId(res.weekId)})`);
    } else {
      setAlert('success', `마감 완료! (${fmtWeekId(res.weekId)})`);
    }

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (e) {
    setAlert('danger', e.message || '마감 실패');
  } finally {
    btn.disabled = false;
  }
}

async function approveSingleAttendance() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#excuseMemberId').value;
    const date = $('#excuseDate').value;

    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!date) throw new Error('날짜를 선택하세요.');

    const name = memberMap?.[memberId] || memberId;

    const res = await fetchJSON('/api/admin/attendance/excuse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, date })
    });

    const addedText = res.added ? '출석 1건이 추가되었습니다.' : '이미 출석 처리된 날짜입니다.';
    const recalcText = res.ledgerRecalculated ? ' 마감된 주차라 정산도 다시 계산했습니다.' : '';

    setAlert(
      'success',
      `${name} · ${date} · ${addedText}${recalcText}`
    );

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '출석 인정 실패');
  }
}

async function cancelSingleAttendance() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#excuseMemberId').value;
    const date = $('#excuseDate').value;

    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!date) throw new Error('날짜를 선택하세요.');

    const name = memberMap?.[memberId] || memberId;

    const ok = confirm(`${name}의 ${date} 출석을 취소하시겠습니까?`);
    if (!ok) return;

    const res = await fetchJSON('/api/admin/attendance/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, date })
    });

    const removedText = res.removed
      ? '출석 1건을 취소했습니다.'
      : '해당 날짜의 출석 기록이 없었습니다.';
    const recalcText = res.ledgerRecalculated
      ? ' 마감된 주차라 정산도 다시 계산했습니다.'
      : '';

    setAlert('warning', `${name} · ${date} · ${removedText}${recalcText}`);

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '출석 취소 실패');
  }
}

async function approveWholeWeek() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const weekId = $('#excuseWeekId').value;
    if (!weekId) throw new Error('주차를 선택하세요.');

    const ok = confirm(`${fmtWeekId(weekId)}의 월~금 전체 멤버 출석을 인정하시겠습니까?`);
    if (!ok) return;

    const res = await fetchJSON('/api/admin/attendance/excuse-week', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ weekId })
    });

    const recalcText = res.ledgerRecalculated ? ' 정산도 다시 계산했습니다.' : '';
    setAlert(
      'success',
      `${fmtWeekId(weekId)} · 총 ${res.addedCount || 0}건의 출석을 추가했습니다.${recalcText}`
    );

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '시험 주간 출석 인정 실패');
  }
}

async function approveMemberWeek() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#memberWeekMemberId').value;
    const weekId = $('#memberWeekId').value;
    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!weekId) throw new Error('주차를 선택하세요.');

    const name = memberMap?.[memberId] || memberId;
    const ok = confirm(`${name}의 ${fmtWeekId(weekId)} 월~목 4일 출석을 인정하시겠습니까?`);
    if (!ok) return;

    const res = await fetchJSON('/api/admin/attendance/excuse-member-week', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, weekId })
    });

    const recalcText = res.ledgerRecalculated ? ' 정산도 다시 계산했습니다.' : '';
    setAlert(
      'success',
      `${name} · ${fmtWeekId(res.weekId)} · 총 ${res.addedCount || 0}건의 출석을 추가했습니다.${recalcText}`
    );

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '멤버별 주차 출석 인정 실패');
  }
}

async function cancelMemberWeek() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#memberWeekMemberId').value;
    const weekId = $('#memberWeekId').value;
    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!weekId) throw new Error('주차를 선택하세요.');

    const name = memberMap?.[memberId] || memberId;
    const ok = confirm(`${name}의 ${fmtWeekId(weekId)} 월~목 출석 기록을 모두 취소하시겠습니까?`);
    if (!ok) return;

    const res = await fetchJSON('/api/admin/attendance/cancel-member-week', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, weekId })
    });

    const recalcText = res.ledgerRecalculated ? ' 정산도 다시 계산했습니다.' : '';
    setAlert(
      'warning',
      `${name} · ${fmtWeekId(res.weekId)} · 총 ${res.removedCount || 0}건의 출석을 취소했습니다.${recalcText}`
    );

    await loadWeek();
    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '멤버별 주차 출석 취소 실패');
  }
}

async function saveExtraFine() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#extraFineMemberId').value;
    const weekId = $('#extraFineWeekId').value;
    const amount = Number($('#extraFineAmount').value || 0);
    const reason = $('#extraFineReason').value.trim();

    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!weekId) throw new Error('주차를 선택하세요.');
    if (!Number.isFinite(amount) || amount < 0) throw new Error('추가 벌금은 0원 이상이어야 합니다.');

    const res = await fetchJSON('/api/admin/ledger/extra-fine', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, weekId, amount, reason })
    });

    const name = memberMap?.[memberId] || memberId;
    setAlert(
      'success',
      `${name} · ${fmtWeekId(res.weekId)} · 추가 벌금 ${fmtWon(res.extraFine)} 저장 완료`
    );

    await loadExcuseControls();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '추가 벌금 저장 실패');
  }
}

async function setPassUsage(used) {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const memberId = $('#passMemberId').value;
    const weekId = $('#passWeekId').value;
    if (!memberId) throw new Error('멤버를 선택하세요.');
    if (!weekId) throw new Error('주차를 선택하세요.');

    const name = memberMap?.[memberId] || memberId;
    const verb = used ? '사용' : '해제';
    const ok = confirm(`${name}의 ${fmtWeekId(weekId)} 까방권을 ${verb}하시겠습니까?`);
    if (!ok) return;

    const res = await fetchJSON('/api/admin/ledger/pass', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, weekId, used })
    });

    setAlert(
      'success',
      `${name} · ${fmtWeekId(res.weekId)} · 까방권 ${verb} 완료 (사용 ${res.passUsedCount}/${res.passLimit})`
    );

    await loadExcuseControls();
    await loadAdminMembers();
    await loadMemberSummary();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '까방권 처리 실패');
  }
}

function renderFundSummary(data) {
  $('#fundTotalCollected').textContent = fmtWon(data.totalCollected);
  $('#fundTotalSpent').textContent = fmtWon(data.totalSpent);
  $('#fundAvailableBalance').textContent = fmtWon(data.availableBalance);
}

async function loadFundLedger() {
  const tbody = $('#fundExpenseBody');
  const token = getToken();

  if (!token) {
    $('#fundTotalCollected').textContent = '-';
    $('#fundTotalSpent').textContent = '-';
    $('#fundAvailableBalance').textContent = '-';
    tbody.innerHTML =
      `<tr><td colspan="5" class="text-center text-muted">관리자 토큰 저장 후 조회할 수 있습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML =
    `<tr><td colspan="5" class="text-center text-muted">로딩 중...</td></tr>`;

  try {
    const data = await fetchJSON('/api/admin/fund', {
      headers: { 'x-admin-token': token }
    });
    renderFundSummary(data);

    const expenses = data.expenses || [];
    if (!expenses.length) {
      tbody.innerHTML =
        `<tr><td colspan="5" class="text-center text-muted">사용 내역이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = expenses.map(expense => {
      const spentDate = (expense.spentAt || '').split('T')[0] || '-';
      const canceledDate = (expense.canceledAt || '').split('T')[0] || '';
      const status = expense.canceledAt
        ? `<span class="badge text-bg-secondary">취소됨</span>${canceledDate ? `<br><span class="text-muted small">${canceledDate}</span>` : ''}`
        : `<button class="btn btn-outline-danger btn-sm cancel-fund-expense-btn"
                   data-expense-id="${escapeHTML(expense.id)}">취소</button>`;

      return `
        <tr${expense.canceledAt ? ' class="text-muted"' : ''}>
          <td>${fmtWeekId(expense.weekId)}</td>
          <td>${fmtWon(expense.amount)}</td>
          <td>${escapeHTML(expense.reason)}</td>
          <td>${spentDate}</td>
          <td>${status}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    $('#fundTotalCollected').textContent = '-';
    $('#fundTotalSpent').textContent = '-';
    $('#fundAvailableBalance').textContent = '-';
    tbody.innerHTML =
      `<tr><td colspan="5" class="text-center text-danger">조회 실패: ${escapeHTML(err.message || '오류')}</td></tr>`;
    setAlert('danger', err.message || '벌금 사용 내역 조회 실패');
  }
}

async function saveFundExpense() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const weekId = $('#fundExpenseWeekId').value;
    const amount = Number($('#fundExpenseAmount').value);
    const reason = $('#fundExpenseReason').value.trim();

    if (!weekId) throw new Error('주차를 선택하세요.');
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('사용 금액은 1원 이상의 정수여야 합니다.');
    }
    if (!reason) throw new Error('사용 사유를 입력하세요.');

    const data = await fetchJSON('/api/admin/fund/expenses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ weekId, amount, reason })
    });

    $('#fundExpenseAmount').value = '';
    $('#fundExpenseReason').value = '';
    setAlert(
      'success',
      `${fmtWeekId(data.expense.weekId)} · ${fmtWon(data.expense.amount)} 사용 내역을 저장했습니다.`
    );
    await loadFundLedger();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '벌금 사용 내역 저장 실패');
  }
}

async function cancelFundExpense(expenseId) {
  const ok = confirm('이 벌금 사용 내역을 취소하시겠습니까? 취소한 금액은 사용 가능액으로 복구됩니다.');
  if (!ok) return;

  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰을 먼저 저장하세요.');

    const data = await fetchJSON(
      `/api/admin/fund/expenses/${encodeURIComponent(expenseId)}/cancel`,
      {
        method: 'POST',
        headers: { 'x-admin-token': token }
      }
    );

    setAlert(
      data.alreadyCanceled ? 'info' : 'warning',
      data.alreadyCanceled
        ? '이미 취소된 사용 내역입니다.'
        : `${fmtWon(data.expense.amount)} 사용 내역을 취소했습니다.`
    );
    await loadFundLedger();
    await loadLedgerChart();
  } catch (err) {
    setAlert('danger', err.message || '벌금 사용 내역 취소 실패');
  }
}

async function loadMemberSummary() {
  const tbody = $('#memberSummaryBody');
  tbody.innerHTML =
    `<tr><td colspan="7" class="text-center text-muted">로딩 중…</td></tr>`;

  try {
    await ensureMemberMap();

    const unpaidOnly = $('#unpaidOnlyChk').checked;
    const qs = new URLSearchParams({ summary: 'member' });
    if (unpaidOnly) qs.set('unpaidOnly', 'true');

    const data = await fetchJSON('/api/ledger?' + qs.toString());
    const rows = data?.rows || [];

    if (!rows.length) {
      tbody.innerHTML =
        `<tr><td colspan="7" class="text-center text-muted">데이터가 없습니다.</td></tr>`;
      $('#sumDeficit').textContent = '-';
      $('#sumFine').textContent = '-';
      $('#sumPaid').textContent = '-';
      $('#sumOutstanding').textContent = '-';
      return;
    }

    let sDef = 0;
    let sFine = 0;
    let sPaid = 0;
    let sOut = 0;

    const trs = rows
      .map(r => {
        const name = memberMap[r.memberId] || r.memberId;

        sDef += r.totalDeficit || 0;
        sFine += r.totalFine || 0;
        sPaid += r.totalPaid || 0;
        sOut += r.outstanding || 0;

        const statusCell = r.fullyPaid
          ? `<span class="badge text-bg-success">완납</span>`
          : `<div class="d-flex gap-1">
               <button class="btn btn-warning btn-sm pay-btn"
                       title="납부 입력"
                       data-member="${r.memberId}">납부</button>
               <button class="btn btn-outline-secondary btn-sm log-btn"
                       data-member="${r.memberId}">내역</button>
             </div>`;
        const passUsedCount = Number(r.passUsedCount) || 0;
        const passLimit = Number(r.passLimit) || 3;

        return `
          <tr>
            <td>${name} <span class="text-muted small">(${r.memberId})</span></td>
            <td>${r.totalDeficit ?? 0}</td>
            <td>${fmtWon(r.totalFine ?? 0)}</td>
            <td>${fmtWon(r.totalPaid ?? 0)}</td>
            <td>${fmtWon(r.outstanding ?? 0)}</td>
            <td>사용 ${passUsedCount}/${passLimit}</td>
            <td>${statusCell}</td>
          </tr>
        `;
      })
      .join('');

    tbody.innerHTML = trs;

    $('#sumDeficit').textContent = sDef;
    $('#sumFine').textContent = fmtWon(sFine);
    $('#sumPaid').textContent = fmtWon(sPaid);
    $('#sumOutstanding').textContent = fmtWon(sOut);
  } catch (e) {
    tbody.innerHTML =
      `<tr><td colspan="7" class="text-danger text-center">로드 실패: ${e.message || '에러'}</td></tr>`;
  }
}

let payModal = null;
let paymentLogModal = null;

function openPayModal(memberId) {
  const name = memberMap?.[memberId] || memberId;

  $('#payMemberId').value = memberId;
  $('#payMemberName').value = name;
  $('#payAmount').value = '';

  payModal.show();
}

async function submitPayment() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰이 없습니다.');

    const memberId = $('#payMemberId').value;
    const paidAmount = Number($('#payAmount').value);

    if (!memberId || !paidAmount) {
      alert('납부 금액을 입력하세요.');
      return;
    }

    const res = await fetchJSON('/api/ledger/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ memberId, paidAmount })
    });

    const appliedText =
      Array.isArray(res.allocations) && res.allocations.length
        ? res.allocations
            .map(a => `${fmtWeekId(a.weekId)}: ${fmtWon(a.appliedAmount)}`)
            .join('\n')
        : '배분 내역 없음';

    alert(
      `납부 완료!\n\n배분 내역:\n${appliedText}\n\n남은 총 미납액: ${fmtWon(res.memberOutstanding)}`
    );

    payModal.hide();
    await loadMemberSummary();
    await loadLedgerChart();
    await loadFundLedger();
  } catch (err) {
    alert('납부 실패: ' + (err.message || '오류'));
  }
}

async function openPaymentLog(memberId) {
  const memberName = memberMap?.[memberId] || memberId;
  $('#paymentLogBody').innerHTML =
    `<div class="text-center text-muted">불러오는 중...</div>`;
  paymentLogModal.show();

  try {
    const res = await fetchJSON('/api/ledger?memberId=' + memberId);
    const entries = res.entries || [];

    if (!entries.length) {
      $('#paymentLogBody').innerHTML =
        `<div class="text-center text-muted">${memberName}님의 납부 기록이 없습니다.</div>`;
      return;
    }

    let html = `<h6 class="mb-3">${memberName} (${memberId})</h6>`;
    html += `<div class="table-responsive"><table class="table table-sm table-striped align-middle">
      <thead><tr><th>주차</th><th>출석벌금</th><th>추가벌금</th><th>까방권</th><th>총 벌금</th><th>납부내역</th><th>총 납부액</th><th>미납</th></tr></thead><tbody>`;

    for (const e of entries) {
      const pays = Array.isArray(e.payments) && e.payments.length
        ? e.payments
            .map(
              p =>
                `${fmtWon(p.amount)}<br><span class="text-muted small">${(p.paidAt || '').split('T')[0] || ''}</span>`
            )
            .join('<hr class="my-1">')
        : '<span class="text-muted small">없음</span>';

      const totalPaid =
        e.totalPaid ??
        (e.payments?.reduce((s, p) => s + (Number(p.amount) || 0), 0) || 0);

      const outstanding =
        e.outstanding ??
        Math.max(0, (Number(e.fine) || 0) - totalPaid);

      html += `<tr>
        <td>${fmtWeekId(e.weekId)}</td>
        <td>${fmtWon(e.attendanceFine)}</td>
        <td>${fmtWon(e.extraFine)}${e.extraFineReason ? `<br><span class="text-muted small">${escapeHTML(e.extraFineReason)}</span>` : ''}</td>
        <td>${e.passUsed ? '<span class="badge text-bg-success">사용</span>' : '<span class="text-muted small">-</span>'}</td>
        <td>${fmtWon(e.fine)}</td>
        <td>${pays}</td>
        <td>${fmtWon(totalPaid)}</td>
        <td>${fmtWon(outstanding)}</td>
      </tr>`;
    }

    html += `</tbody></table></div>`;
    $('#paymentLogBody').innerHTML = html;
  } catch (err) {
    $('#paymentLogBody').innerHTML =
      `<div class="text-danger">불러오기 실패: ${err.message || '오류'}</div>`;
  }
}

let ledgerChart = null;

function showLedgerChartMessage(message, isError = false) {
  const messageBox = $('#ledgerChartMessage');
  const chartWrap = $('#ledgerChartWrap');

  chartWrap.classList.add('d-none');
  messageBox.className =
    `text-center py-5 ${isError ? 'text-danger' : 'text-muted'}`;
  messageBox.textContent = message;
}

async function loadLedgerChart() {
  const token = getToken();
  if (!token) {
    if (ledgerChart) {
      ledgerChart.destroy();
      ledgerChart = null;
    }
    showLedgerChartMessage('관리자 토큰 저장 후 조회할 수 있습니다.');
    return;
  }

  showLedgerChartMessage('그래프를 불러오는 중...');

  try {
    const data = await fetchJSON('/api/admin/fund', {
      headers: { 'x-admin-token': token }
    });
    const rows = data.trend || [];

    if (!rows.length) {
      if (ledgerChart) {
        ledgerChart.destroy();
        ledgerChart = null;
      }
      showLedgerChartMessage('표시할 정산 데이터가 없습니다.');
      return;
    }

    const labels = rows.map(r => fmtWeekId(r.weekId));

    const ctx = document.getElementById('ledgerChart');
    if (!ctx) return;

    $('#ledgerChartMessage').classList.add('d-none');
    $('#ledgerChartWrap').classList.remove('d-none');

    const chartData = {
      labels,
      datasets: [
        {
          label: '누적 총 벌금',
          data: rows.map(r => Number(r.cumulativeFine) || 0),
          type: 'line',
          borderColor: '#0d6efd',
          backgroundColor: '#0d6efd',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.25,
          order: 1
        },
        {
          label: '현재 벌금 잔고',
          data: rows.map(r => Number(r.availableBalance) || 0),
          type: 'line',
          borderColor: '#198754',
          backgroundColor: '#198754',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.25,
          order: 1
        },
        {
          label: '사용 금액',
          data: rows.map(r => Number(r.weeklySpent) || 0),
          type: 'bar',
          backgroundColor: 'rgba(220, 53, 69, 0.65)',
          borderColor: '#dc3545',
          borderWidth: 1,
          borderRadius: 3,
          order: 2
        }
      ]
    };

    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: val => fmtWon(val)
          },
          title: {
            display: true,
            text: '금액(원)'
          }
        },
        x: {
          title: {
            display: true,
            text: '주차'
          }
        }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}`
          }
        }
      }
    };

    if (ledgerChart) ledgerChart.destroy();
    ledgerChart = new Chart(ctx, {
      type: 'line',
      data: chartData,
      options: chartOptions
    });
    ledgerChart.resize();
  } catch (err) {
    console.error('Chart load error:', err);
    if (ledgerChart) {
      ledgerChart.destroy();
      ledgerChart = null;
    }
    showLedgerChartMessage(
      `그래프 조회 실패: ${err.message || '오류'}`,
      true
    );
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const input = $('#adminToken');
  input.value = getToken();

  $('#saveTokenBtn').addEventListener('click', async () => {
    setToken(input.value.trim());
    setAlert('success', '토큰 저장 완료');
    await loadFundLedger();
    await loadAdminMembers();
    await loadMemberSummary();
    await loadLedgerChart();
  });

  $('#finalizeBtn').addEventListener('click', () => {
    if (
      confirm(
        '이번 주를 마감하시겠습니까? 마감 후에는 출석 수정이 제한될 수 있습니다.'
      )
    ) {
      finalizeWeek();
    }
  });

  $('#approveSingleBtn').addEventListener('click', approveSingleAttendance);
  $('#cancelSingleBtn').addEventListener('click', cancelSingleAttendance);
  $('#approveMemberWeekBtn').addEventListener('click', approveMemberWeek);
  $('#cancelMemberWeekBtn').addEventListener('click', cancelMemberWeek);
  $('#approveWeekBtn').addEventListener('click', approveWholeWeek);
  $('#saveExtraFineBtn').addEventListener('click', saveExtraFine);
  $('#usePassBtn').addEventListener('click', () => setPassUsage(true));
  $('#revokePassBtn').addEventListener('click', () => setPassUsage(false));
  $('#grantPassBtn').addEventListener('click', grantPass);
  $('#passMemberId').addEventListener('change', renderPassMemberStatus);
  $('#saveFundExpenseBtn').addEventListener('click', saveFundExpense);
  $('#addMemberBtn').addEventListener('click', addMember);
  $('#newMemberName').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMember();
  });

  $('#refreshMemberSummaryBtn').addEventListener('click', loadMemberSummary);
  $('#unpaidOnlyChk').addEventListener('change', loadMemberSummary);
  $('#refreshChartBtn').addEventListener('click', loadLedgerChart);

  payModal = new bootstrap.Modal(document.getElementById('payModal'));
  paymentLogModal = new bootstrap.Modal(document.getElementById('paymentLogModal'));

  document.body.addEventListener('click', e => {
    const payBtn = e.target.closest('.pay-btn');
    if (payBtn) {
      openPayModal(payBtn.dataset.member);
      return;
    }

    const logBtn = e.target.closest('.log-btn');
    if (logBtn) {
      openPaymentLog(logBtn.dataset.member);
      return;
    }

    const cancelFundBtn = e.target.closest('.cancel-fund-expense-btn');
    if (cancelFundBtn) {
      cancelFundExpense(cancelFundBtn.dataset.expenseId);
      return;
    }

    const statusBtn = e.target.closest('.member-status-btn');
    if (statusBtn) {
      setMemberStatus(statusBtn.dataset.memberId, statusBtn.dataset.active === 'true');
      return;
    }

    const deleteBtn = e.target.closest('.delete-member-btn');
    if (deleteBtn) {
      deleteMember(deleteBtn.dataset.memberId);
    }
  });

  $('#submitPayBtn').addEventListener('click', submitPayment);

  await loadWeek();
  await loadExcuseControls();
  await loadFundLedger();
  await loadAdminMembers();
  await loadMemberSummary();
  await loadLedgerChart();
});
