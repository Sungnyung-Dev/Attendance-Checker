// /public/js/history.js

// ---- helpers ----
function $(s){ return document.querySelector(s); }
const KRW = new Intl.NumberFormat('ko-KR');
const fmtWon = n => KRW.format(n||0) + '원';

async function fetchJSON(url, opts = {}){
  const r = await fetch(url, opts);
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error || '요청 실패');
  return j;
}

// 주차 표시 포맷: "YYYY-W05" 같은 형태로 강제
function fmtWeekId(id){
  const m = /^(\d{4})-W(\d{1,2})$/.exec(id || '');
  return m ? `${m[1]}-W${m[2].padStart(2, '0')}` : (id || '');
}

let memberMap = null;
async function ensureMemberMap(){
  if (memberMap) return memberMap;
  try{
    const list = await fetchJSON('/api/members');
    memberMap = {};
    list.forEach(m => memberMap[m.id] = m.name || m.id);
  }catch{
    memberMap = {};
  }
  return memberMap;
}

// ---- weeks list ----
async function loadWeekList(){
  const box = $('#weekList');
  box.innerHTML = `<div class="list-group-item text-muted">로딩 중…</div>`;
  try{
    // 주차별 요약으로 weekId 목록 확보
    const data = await fetchJSON('/api/ledger?summary=week');
    const rows = (data.rows || [])
      // 최신 → 오래된 순 정렬
      .slice()
      .sort((a, b) => (a.weekId > b.weekId ? -1 : 1));

    if (!rows.length){
      box.innerHTML = `<div class="list-group-item text-muted">데이터 없음</div>`;
      return;
    }
    // 버튼 목록 렌더
    box.innerHTML = rows.map(r => `
      <button class="list-group-item list-group-item-action week-btn" data-week="${r.weekId}">
        <div class="d-flex justify-content-between">
          <div class="fw-semibold">${fmtWeekId(r.weekId)}</div>
          <div class="small text-muted">총 벌금 ${fmtWon(r.totalFine || 0)} / 미납 ${fmtWon(r.outstanding || 0)}</div>
        </div>
        <div class="small text-muted">인원 ${r.membersCount ?? 0} · 완납 ${r.fullyPaidCount ?? 0}</div>
      </button>
    `).join('');
  }catch(e){
    box.innerHTML = `<div class="list-group-item text-danger">불러오기 실패: ${e.message}</div>`;
  }
}

// ---- week detail ----
async function loadWeekDetail(weekId){
  const tbody = $('#histBody');
  $('#currentWeekLabel').textContent = weekId ? fmtWeekId(weekId) : '-';
  tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">로딩 중…</td></tr>`;
  try{
    await ensureMemberMap();
    const unpaidOnly = $('#histUnpaidOnly').checked;
    const qs = new URLSearchParams({ summary: 'member', weekId });
    if (unpaidOnly) qs.set('unpaidOnly','true');

    const { rows=[] } = await fetchJSON('/api/ledger?' + qs.toString());

    if (!rows.length){
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">해당 주차 데이터 없음</td></tr>`;
      $('#hSumDef').textContent = '-';
      $('#hSumFine').textContent = '-';
      $('#hSumPaid').textContent = '-';
      $('#hSumOut').textContent = '-';
      return;
    }

    let sDef=0, sFine=0, sPaid=0, sOut=0;
    const trs = rows.map(r=>{
      const name = memberMap[r.memberId] || r.memberId;
      sDef += r.totalDeficit||0;
      sFine += r.totalFine||0;
      sPaid += r.totalPaid||0;
      sOut += r.outstanding||0;
      const status = r.fullyPaid
        ? `<span class="badge text-bg-success">완납</span>`
        : `<span class="badge text-bg-warning">미납</span>`;
      return `
        <tr>
          <td>${name} <span class="text-muted small">(${r.memberId})</span></td>
          <td>${r.totalDeficit ?? 0}</td>
          <td>${fmtWon(r.totalFine)}</td>
          <td>${fmtWon(r.totalPaid)}</td>
          <td>${fmtWon(r.outstanding)}</td>
          <td>${status}</td>
        </tr>
      `;
    }).join('');
    tbody.innerHTML = trs;

    $('#hSumDef').textContent = sDef;
    $('#hSumFine').textContent = fmtWon(sFine);
    $('#hSumPaid').textContent = fmtWon(sPaid);
    $('#hSumOut').textContent = fmtWon(sOut);

    // CSV export 데이터 캐시
    window.__histRows = rows;
    window.__histWeekId = weekId;
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="6" class="text-danger text-center">${e.message||'불러오기 실패'}</td></tr>`;
  }
}

// ---- CSV export ----
function rowsToCSV(rows){
  const header = ['memberId','name','totalDeficit','totalFine','totalPaid','outstanding','fullyPaid'];
  const lines = [header.join(',')];
  rows.forEach(r=>{
    const line = [
      r.memberId,
      (memberMap?.[r.memberId]||'').replaceAll(',',' '),
      r.totalDeficit||0,
      r.totalFine||0,
      r.totalPaid||0,
      r.outstanding||0,
      r.fullyPaid ? 'Y':'N'
    ].join(',');
    lines.push(line);
  });
  return lines.join('\n');
}
function downloadCSV(filename, text){
  const blob = new Blob([text], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- events ----
window.addEventListener('DOMContentLoaded', ()=>{
  loadWeekList();

  // 주차 버튼 클릭
  document.body.addEventListener('click', e=>{
    const btn = e.target.closest('.week-btn');
    if (!btn) return;
    const weekId = btn.dataset.week; // 원본 값 유지
    loadWeekDetail(weekId);
    // 선택 표시
    document.querySelectorAll('.week-btn').forEach(b=> b.classList.remove('active'));
    btn.classList.add('active');
  });

  // 미납만 보기
  $('#histUnpaidOnly').addEventListener('change', ()=>{
    const weekId = window.__histWeekId;
    if (weekId) loadWeekDetail(weekId);
  });

  // 새로고침
  $('#refreshWeeksBtn').addEventListener('click', loadWeekList);

  // CSV 내보내기
  $('#exportCsvBtn').addEventListener('click', ()=>{
    const rows = window.__histRows || [];
    const weekId = window.__histWeekId || 'unknown-week';
    if (!rows.length) return alert('먼저 주차를 선택하세요.');
    const csv = rowsToCSV(rows);
    const fname = `ecomacho-${weekId ? fmtWeekId(weekId) : 'unknown-week'}.csv`;
    downloadCSV(fname, csv);
  });
});
