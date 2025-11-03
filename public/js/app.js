// /public/js/app.js

function $(sel) { return document.querySelector(sel); }

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

// ---------- 공통: 주차 표기 ----------
function fmtWeekId(id){
  const m = /^(\d{4})-W(\d{1,2})$/.exec(id || '');
  return m ? `${m[1]}-W${m[2].padStart(2, '0')}` : (id || '');
}

// ---------- 주차 정보 & 오늘 표시 ----------
async function loadWeekInfo() {
  try {
    const info = await fetchJSON('/api/week');

    // weekId 보정
    const displayWeekId = fmtWeekId(info.weekId);

    $('#weekInfo').textContent = `${displayWeekId} (${info.start} ~ ${info.end})`;

    const today = new Date().toLocaleDateString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      weekday: 'long'
    });
    $('#dateInfo').textContent = `오늘은 ${today}`;
  } catch (e) {
    $('#weekInfo').textContent = '주차 정보를 불러오지 못했습니다.';
  }
}

// ---------- 멤버 목록 ----------
async function loadMembers() {
  try {
    const list = await fetchJSON('/api/members'); // active only
    const sel = $('#memberSelect');
    sel.innerHTML = `<option value="">-- 이름을 선택하세요 --</option>` +
      list.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  } catch (e) {
    alert('멤버 목록 불러오기 실패');
  }
}

// ---------- 현재 주차 출석 현황 ----------
async function loadCurrentAttendance(){
  const tbody = document.querySelector('#currentWeekBody');
  const label = document.querySelector('#curWeekLabel');
  const bar = document.querySelector('#currentProgressBar');

  // 현황 카드가 없는 페이지면 무시
  if (!tbody || !label || !bar) return;

  tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">로딩 중…</td></tr>`;
  try{
    const data = await fetchJSON('/api/attendance/current');

    label.textContent = `${fmtWeekId(data.weekId)} · ${data.start} ~ ${data.end}` + (data.finalized ? ' (마감됨)' : '');

    const total = Number(data.totalMembers || 0);
    const checked = Number(data.checkedIn || 0);
    const pct = total > 0 ? Math.round(checked * 100 / total) : 0;
    bar.style.width = `${pct}%`;
    bar.textContent = `${checked} / ${total} (${pct}%)`;

    const rows = data.list || [];
    if (!rows.length){
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">멤버 데이터 없음</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const badge = (r.count || 0) > 0
        ? `<span class="badge text-bg-success">출석</span>`
        : `<span class="badge text-bg-secondary">미출석</span>`;
      const dates = Array.isArray(r.dates) && r.dates.length
        ? r.dates.join(', ')
        : '<span class="text-muted small">-</span>';
      return `
        <tr>
          <td>${r.name} <span class="text-muted small">(${r.id})</span></td>
          <td>${r.count ?? 0}회 ${badge}</td>
          <td>${r.lastCheckedAt || '-'}</td>
          <td class="small text-muted">${dates}</td>
        </tr>
      `;
    }).join('');
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="4" class="text-danger text-center">${e.message || '불러오기 실패'}</td></tr>`;
  }
}

// ---------- 출석 버튼 ----------
async function handleCheckin() {
  const memberId = $('#memberSelect').value;
  const resBox = $('#result');

  if (!memberId) {
    resBox.className = 'alert alert-warning text-center';
    resBox.textContent = '이름을 선택해주세요!';
    resBox.classList.remove('d-none');
    return;
  }

  try {
    const r = await fetch('/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId })
    });

    if (!r.ok) {
      const j = await r.json().catch(()=>({}));
      const msg = (j && j.error) || '출석 실패';
      const nicified =
        msg.includes('already checked in') ? '오늘은 이미 출석했습니다.' :
        msg.includes('finalized')          ? '이번 주는 마감되어 출석할 수 없습니다.' :
        msg;
      throw new Error(nicified);
    }

    resBox.className = 'alert alert-success text-center';
    resBox.textContent = '출석 완료! 오늘 기록되었어요 ✅';
    resBox.classList.remove('d-none');

    // ✅ 현황 즉시 갱신
    await loadCurrentAttendance();

  } catch (err) {
    resBox.className = 'alert alert-danger text-center';
    resBox.textContent = err.message || '출석 실패';
    resBox.classList.remove('d-none');
  }
}

// ---------- 초기 구동 ----------
window.addEventListener('DOMContentLoaded', async () => {
  await loadWeekInfo();
  await loadMembers();
  $('#checkinBtn').addEventListener('click', handleCheckin);

  // [NEW] 현재 주차 현황 로드 & 새로고침 버튼
  const refreshBtn = document.querySelector('#refreshCurrentBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadCurrentAttendance);
  loadCurrentAttendance();

  // (선택) 30초 자동 새로고침
  // setInterval(loadCurrentAttendance, 30000);
});
