// /public/js/admin.js

// ===== 공통 헬퍼 =====
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || '요청 실패';
    throw new Error(msg);
  }
  return data;
}
function $(sel) { return document.querySelector(sel); }
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

// 주차 표시 포맷: "YYYY-W05"
function fmtWeekId(id) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(id || '');
  return m ? `${m[1]}-W${m[2].padStart(2, '0')}` : (id || '');
}

// 금액 포맷
const KRW = new Intl.NumberFormat('ko-KR');
function fmtWon(n) { return KRW.format(Number(n) || 0) + '원'; }

// ===== 데이터 캐시 =====
let memberMap = null; // { id -> name }
async function ensureMemberMap() {
  if (memberMap) return memberMap;
  try {
    const list = await fetchJSON('/api/members');
    memberMap = {};
    list.forEach(m => memberMap[m.id] = m.name || m.id);
  } catch {
    memberMap = {};
  }
  return memberMap;
}

// ===== 현재 주 정보 =====
async function loadWeek() {
  try {
    const info = await fetchJSON('/api/week');
    $('#weekInfo').textContent =
      `${fmtWeekId(info.weekId)} · ${info.start} ~ ${info.end}` +
      (info.finalized ? ' (마감됨)' : '');
  } catch (e) {
    $('#weekInfo').textContent = '주 정보 로딩 실패';
  }
}

// ===== 주간 마감 =====
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
    await loadMemberSummary(); // 마감 후 표 갱신
    await loadLedgerChart();   // 차트 갱신
  } catch (e) {
    setAlert('danger', e.message || '마감 실패');
  } finally {
    btn.disabled = false;
  }
}

// ===== 멤버별 합계 표 =====
async function loadMemberSummary() {
  const tbody = $('#memberSummaryBody');
  tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">로딩 중…</td></tr>`;

  try {
    await ensureMemberMap();

    const unpaidOnly = $('#unpaidOnlyChk').checked;
    const qs = new URLSearchParams({ summary: 'member' });
    if (unpaidOnly) qs.set('unpaidOnly', 'true');

    const data = await fetchJSON('/api/ledger?' + qs.toString());
    const rows = data?.rows || [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">데이터가 없습니다.</td></tr>`;
      $('#sumDeficit').textContent = '-';
      $('#sumFine').textContent = '-';
      $('#sumPaid').textContent = '-';
      $('#sumOutstanding').textContent = '-';
      return;
    }

    // 합계
    let sDef = 0, sFine = 0, sPaid = 0, sOut = 0;

    const trs = rows.map(r => {
      const name = memberMap[r.memberId] || r.memberId;

      sDef += r.totalDeficit || 0;
      sFine += r.totalFine || 0;
      sPaid += r.totalPaid || 0;
      sOut += r.outstanding || 0;

      const weeks = (r.weeks || []).map(fmtWeekId).join(', ');

      // 미납이면: [납부] + [내역], 완납이면: 뱃지
      const statusCell = r.fullyPaid
        ? `<span class="badge text-bg-success">완납</span>`
        : `<div class="d-flex gap-1">
             <button class="btn btn-warning btn-sm pay-btn"
                     title="납부 입력"
                     data-member="${r.memberId}"
                     data-weeks="${(r.weeks || []).join(',')}">납부</button>
             <button class="btn btn-outline-secondary btn-sm log-btn"
                     data-member="${r.memberId}">내역</button>
           </div>`;

      return `
        <tr>
          <td>${name} <span class="text-muted small">(${r.memberId})</span></td>
          <td>${r.totalDeficit ?? 0}</td>
          <td>${fmtWon(r.totalFine ?? 0)}</td>
          <td>${fmtWon(r.totalPaid ?? 0)}</td>
          <td>${fmtWon(r.outstanding ?? 0)}</td>
          <td>${statusCell}</td>
          <td class="small text-muted">${weeks}</td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = trs;

    // 합계 표시
    $('#sumDeficit').textContent = sDef;
    $('#sumFine').textContent = fmtWon(sFine);
    $('#sumPaid').textContent = fmtWon(sPaid);
    $('#sumOutstanding').textContent = fmtWon(sOut);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-danger text-center">로드 실패: ${e.message || '에러'}</td></tr>`;
  }
}

// ===== 납부 입력 / 납부 내역 모달 =====
let payModal = null;
let paymentLogModal = null;

function openPayModal(memberId, weeksCsv) {
  const weeks = (weeksCsv || '').split(',').filter(Boolean);
  const weekId = weeks.at(-1) || ''; // 가장 최근 주차 (원본 weekId 사용)
  const name = memberMap?.[memberId] || memberId;

  $('#payMemberId').value = memberId;
  $('#payMemberName').value = name;
  $('#payWeekId').value = weekId;
  $('#payAmount').value = '';
  $('#payMethod').value = '';
  $('#payNote').value = '';

  payModal.show();
}

async function submitPayment() {
  try {
    const token = getToken();
    if (!token) throw new Error('관리자 토큰이 없습니다.');

    const memberId = $('#payMemberId').value;
    const weekId = $('#payWeekId').value;
    const paidAmount = Number($('#payAmount').value);
    const method = $('#payMethod').value;
    const note = $('#payNote').value;

    if (!weekId || !memberId || !paidAmount || !method) {
      alert('모든 필드를 입력하세요.');
      return;
    }

    const res = await fetchJSON('/api/ledger/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token
      },
      body: JSON.stringify({ weekId, memberId, paidAmount, method, note })
    });

    alert(`납부 완료!\n총 납부액: ${res.totalPaid.toLocaleString()}원\n미납액: ${res.outstanding.toLocaleString()}원`);
    payModal.hide();
    loadMemberSummary();
    loadLedgerChart();
  } catch (err) {
    alert('납부 실패: ' + (err.message || '오류'));
  }
}

async function openPaymentLog(memberId) {
  const memberName = memberMap?.[memberId] || memberId;
  $('#paymentLogBody').innerHTML = `<div class="text-center text-muted">불러오는 중...</div>`;
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
      <thead><tr><th>주차</th><th>벌금</th><th>납부내역</th><th>총 납부액</th><th>미납</th></tr></thead><tbody>`;

    for (const e of entries) {
      const pays = Array.isArray(e.payments)
        ? e.payments.map(p =>
            `${fmtWon(p.amount)} (${p.method})<br><span class="text-muted small">${(p.paidAt || '').split('T')[0] || ''}</span>`
          ).join('<hr class="my-1">')
        : '<span class="text-muted small">없음</span>';

      const totalPaid = e.totalPaid ?? (e.payments?.reduce((s, p) => s + (Number(p.amount) || 0), 0) || 0);
      const outstanding = e.outstanding ?? Math.max(0, (Number(e.fine) || 0) - totalPaid);

      html += `<tr>
        <td>${fmtWeekId(e.weekId)}</td>
        <td>${fmtWon(e.fine)}</td>
        <td>${pays}</td>
        <td>${fmtWon(totalPaid)}</td>
        <td>${fmtWon(outstanding)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    $('#paymentLogBody').innerHTML = html;
  } catch (err) {
    $('#paymentLogBody').innerHTML = `<div class="text-danger text-center">${err.message || '불러오기 실패'}</div>`;
  }
}

// ===== 주차별 통계 차트 =====
let ledgerChart = null;

async function loadLedgerChart() {
  const ctx = document.getElementById('ledgerChart');
  if (!ctx) return;

  try {
    const data = await fetchJSON('/api/ledger?summary=week');
    // weekId 오름차순 정렬
    const rows = (data.rows || []).sort((a, b) => a.weekId > b.weekId ? 1 : -1);

    const labels = rows.map(r => fmtWeekId(r.weekId));

    // 🔹 주차별 합계를 "누적"으로 변환
    const fines = [];
    const outs  = [];
    let cumFine = 0;
    let cumOut  = 0;

    for (const r of rows) {
      const f = Number(r.totalFine || 0);
      const o = Number(r.outstanding || 0);
      cumFine += f;
      cumOut  += o;
      fines.push(cumFine);   // 누적 벌금
      outs.push(cumOut);     // 누적 미납액
    }

    const chartData = {
      labels,
      datasets: [
        {
          label: '누적 총 벌금',
          data: fines,
          fill: false,
          borderColor: 'rgba(54, 162, 235, 1)',
          backgroundColor: 'rgba(54, 162, 235, 0.3)',
          tension: 0.2,
          borderWidth: 2
        },
        {
          label: '누적 미납액',
          data: outs,
          fill: false,
          borderColor: 'rgba(255, 159, 64, 1)',
          backgroundColor: 'rgba(255, 159, 64, 0.3)',
          tension: 0.2,
          borderWidth: 2
        }
      ]
    };

    const chartOptions = {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: val => val.toLocaleString() + '원' },
          title: { display: true, text: '금액(원)' }
        },
        x: { title: { display: true, text: '주차' } }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.formattedValue}원`
          }
        }
      }
    };

    if (ledgerChart) ledgerChart.destroy();
    ledgerChart = new Chart(ctx, { type: 'line', data: chartData, options: chartOptions });
  } catch (err) {
    console.error('Chart load error:', err);
  }
}

// ===== 초기화 =====
window.addEventListener('DOMContentLoaded', () => {
  // 토큰 UI
  const input = $('#adminToken');
  input.value = getToken();
  $('#saveTokenBtn').addEventListener('click', () => {
    setToken(input.value.trim());
    setAlert('success', '토큰 저장 완료');
  });

  // 주 정보
  loadWeek();

  // 마감 버튼
  $('#finalizeBtn').addEventListener('click', () => {
    if (confirm('이번 주를 마감하시겠습니까? 마감 후에는 출석 수정이 제한될 수 있습니다.')) {
      finalizeWeek();
    }
  });

  // 멤버별 요약
  loadMemberSummary();
  $('#refreshMemberSummaryBtn').addEventListener('click', loadMemberSummary);
  $('#unpaidOnlyChk').addEventListener('change', loadMemberSummary);

  // 모달 초기화
  payModal = new bootstrap.Modal(document.getElementById('payModal'));
  paymentLogModal = new bootstrap.Modal(document.getElementById('paymentLogModal'));

  // 행 버튼들: 납부 / 내역
  document.body.addEventListener('click', (e) => {
    const payBtn = e.target.closest('.pay-btn');
    if (payBtn) {
      openPayModal(payBtn.dataset.member, payBtn.dataset.weeks || '');
      return;
    }
    const logBtn = e.target.closest('.log-btn');
    if (logBtn) {
      openPaymentLog(logBtn.dataset.member);
      return;
    }
  });

  // 납부 저장
  $('#submitPayBtn').addEventListener('click', submitPayment);

  // 차트
  loadLedgerChart();
  const btn = document.getElementById('refreshChartBtn');
  if (btn) btn.addEventListener('click', loadLedgerChart);
});
