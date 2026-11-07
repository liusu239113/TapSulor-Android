/**
 * rank-page.js — 安卓热度榜独立页
 * 数据：TapTap 公开榜接口（免登录），复用 electronAPI.fetch（OkHttp + 当前账号 Cookie）
 * 变化：每小时快照存 localStorage（rank_history_v1）
 */
(function () {
  'use strict';

  const BOARDS = [
    { key: 'hot', label: '热门榜', total: 150 },
    { key: 'new', label: '新品榜', total: 100 },
    { key: 'game_jam', label: '聚光灯榜', total: 100 }
  ];
  const MAKER_TAG = 'TapTap制造';
  const STORE = 'rank_history_v1';
  const PAGE = 10;
  const XUA = 'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&UID=' + 'zpad' + '&OS=Windows&OSV=10&DT=PC';
  function uuid() {
    let u = localStorage.getItem('rank_uuid');
    if (!u || u.length < 30) {
      u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 3 | 8); return v.toString(16); });
      localStorage.setItem('rank_uuid', u);
    }
    return u;
  }

  window.__imgErr = function (img) { img.onerror = null; img.src = 'app-icon.png'; };

  const state = { board: 'hot', tag: '', data: {}, hist: {}, loadedAt: null };
  const $ = (id) => document.getElementById(id);

  function uid() {
    let u = localStorage.getItem('rank_uid');
    if (!u) { u = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('rank_uid', u); }
    return u;
  }
  const xua = () => XUA.replace('zpad', uuid());
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtHeat = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e5 ? 0 : 1) + '万'; return String(v); };
  const fmtDelta = (n) => {
    if (n == null || !isFinite(n) || n === 0) return { text: '—', cls: 'flat' };
    return { text: (n > 0 ? '+' : '-') + fmtHeat(Math.abs(n)), cls: n > 0 ? 'up' : 'down' };
  };
  const fmtTime = (ts) => { const d = new Date(ts); const p = x => String(x).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

  async function getJson(url) {
    const res = await window.electronAPI.fetch(url);
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return JSON.parse(res.body);
  }

  async function fetchBoard(key, total) {
    const items = [];
    for (let from = 0, guard = 0; from < total && guard < 40; guard++) {
      const url = 'https://www.taptap.cn/webapiv2/app-top/v2/hits?type_name=' + key + '&from=' + from + '&limit=' + PAGE + '&X-UA=' + encodeURIComponent(xua());
      const j = await getJson(url);
      const list = (j.data && j.data.list) || [];
      const realTotal = (j.data && j.data.total) || total;
      list.forEach((it, i) => {
        const a = it.app || {}; const s = a.stat || {};
        items.push({
          id: String(a.id), rank: from + i + 1, title: a.title || '',
          icon: a.icon && (a.icon.small_url || a.icon.medium_url || a.icon.url),
          score: s.rating && s.rating.score, hits: s.hits_total,
          reviews: s.review_count, fans: s.fans_count,
          labels: a.title_labels || [],
          tags: (a.tags || []).map(t => (t && t.value) || '').filter(Boolean)
        });
      });
      from += PAGE;
      if (from >= realTotal) break;
    }
    return items;
  }

  function saveSnap(key, items) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) {}
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const arr = Array.isArray(all[key]) ? all[key] : [];
    const snap = { ts: hour, items: items.map(i => ({ id: i.id, rank: i.rank, hits: i.hits })) };
    const idx = arr.findIndex(s => s.ts === hour);
    if (idx >= 0) arr[idx] = snap; else arr.push(snap);
    arr.sort((a, b) => a.ts - b.ts);
    all[key] = arr.slice(-48);
    try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (_) {}
  }
  function loadHist() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { return {}; }
  }
  function baseline(key) {
    const arr = (state.hist[key] || []);
    if (!arr.length) return null;
    const target = Date.now() - 3600000;
    let pick = null;
    for (const s of arr) if (s.ts <= target) pick = s;
    return pick || arr[0];
  }
  function deltaFor(key, item) {
    const base = baseline(key);
    if (!base) return {};
    const prev = (base.items || []).find(i => i.id === item.id);
    if (!prev) return { isNew: true };
    return { heat: (item.hits != null && prev.hits != null) ? item.hits - prev.hits : null, rank: prev.rank - item.rank, isNew: false };
  }

  function allTags() {
    const m = new Map();
    for (const b of BOARDS) for (const it of (state.data[b.key] || [])) for (const t of (it.tags || [])) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  }
  function renderTags() {
    const tags = allTags();
    const priority = [MAKER_TAG, '模拟经营', '模拟', '放置', '角色扮演', '休闲', '养成'];
    const head = priority.filter(t => tags.includes(t));
    const rest = tags.filter(t => !head.includes(t)).slice(0, 10);
    $('tags').innerHTML = [''].concat(head, rest).map(t =>
      '<button class="rank-tag' + (state.tag === t ? ' is-active' : '') + '" data-tag="' + esc(t) + '">' + (t || '全部') + '</button>'
    ).join('');
  }
  const matchTag = (it) => !state.tag || (it.tags || []).includes(state.tag);

  function rowHTML(it, key, idx) {
    const d = deltaFor(key, it);
    const hd = fmtDelta(d.heat);
    const rd = d.rank == null ? '' : (d.rank > 0 ? '<span class="up">↑' + d.rank + '</span>' : (d.rank < 0 ? '<span class="down">↓' + Math.abs(d.rank) + '</span>' : ''));
    return '<div class="rank-row">' +
      '<div class="rank-no">' + (idx != null ? idx : it.rank) + rd + '</div>' +
      '<img class="rank-icon" src="' + (it.icon || '') + '">' +
      '<div class="rank-main"><div class="rank-title">' + esc(it.title) + '</div>' +
      '<div class="rank-sub">评分 ' + (it.score || '—') + ' · 评价 ' + fmtHeat(it.reviews || 0) + ' · 粉丝 ' + fmtHeat(it.fans || 0) + '</div></div>' +
      '<div class="rank-heat"><div class="rank-heat-val">' + fmtHeat(it.hits) + '</div><div class="rank-heat-delta ' + hd.cls + '">' + hd.text + '</div></div>' +
    '</div>';
  }

  function render() {
    renderTags();
    $('updated').textContent = state.loadedAt ? ('更新于 ' + fmtTime(state.loadedAt) + ' · 每 20 分钟') : '尚未加载';
    const list = $('list');
    const b = state.board;

    if (b === 'summary') {
      const merged = new Map();
      for (const bd of BOARDS) for (const it of (state.data[bd.key] || [])) {
        if (!matchTag(it)) continue;
        const cur = merged.get(it.id);
        if (!cur || (it.hits || 0) > (cur.hits || 0)) merged.set(it.id, Object.assign({}, it, { boardLabel: bd.label }));
      }
      const all = [...merged.values()];
      const up = all.filter(x => (deltaFor('hot', x).heat || 0) > 0).sort((a, b2) => (deltaFor('hot', b2).heat || 0) - (deltaFor('hot', a).heat || 0));
      const top = [...all].sort((a, b2) => (b2.hits || 0) - (a.hits || 0)).slice(0, 20);
      $('hint').textContent = state.tag ? ('汇总筛选：' + state.tag) : '三榜合并去重';
      const card = (title, rows, showDelta) => rows.length ? '<div class="rank-sum-card"><h3>' + title + '</h3>' + rows.slice(0, 15).map((r, i) => {
        const d = fmtDelta(deltaFor('hot', r).heat);
        return '<div class="rank-row">' +
          '<div class="rank-no">' + (i + 1) + '</div>' +
          '<img class="rank-icon" src="' + (r.icon || 'app-icon.png') + '" loading="lazy">' +
          '<div class="rank-main"><div class="rank-title">' + esc(r.title) + '</div><div class="rank-sub">' + esc(r.boardLabel) + ' · 热度 ' + fmtHeat(r.hits) + '</div></div>' +
          '<div class="rank-heat"><div class="rank-heat-val ' + d.cls + '">' + (showDelta ? d.text : '') + '</div></div></div>';
      }).join('') + '</div>' : '';
      list.innerHTML = card('涨幅榜', up, true) + card('热度榜', top, false) + (up.length || top.length ? '' : '<div class="empty">暂无数据</div>');
      return;
    }

    let items, maker = false;
    if (b === 'maker') {
      maker = true;
      const map = new Map();
      for (const bd of BOARDS) for (const it of (state.data[bd.key] || [])) {
        if (!(it.tags || []).includes(MAKER_TAG) || !matchTag(it)) continue;
        const cur = map.get(it.id);
        if (!cur || (it.hits || 0) > (cur.hits || 0)) map.set(it.id, it);
      }
      items = [...map.values()].sort((a, b2) => (b2.hits || 0) - (a.hits || 0));
    } else {
      items = (state.data[b] || []).filter(matchTag);
    }
    if (!items.length) { list.innerHTML = '<div class="empty">暂无数据</div>'; $('hint').textContent = ''; return; }
    const base = baseline(maker ? 'hot' : b);
    $('hint').textContent = (state.tag ? '筛选：' + state.tag + ' · ' : '') + (base ? ('变化基准 ' + fmtTime(base.ts)) : '首次运行，1 小时后开始记录变化');
    list.innerHTML = items.map((it, i) => rowHTML(it, maker ? 'hot' : b, maker ? i + 1 : null)).join('');
    list.querySelectorAll('.rank-row').forEach((el, idx) => { el.addEventListener('click', () => openDetail(items[idx].id, maker ? 'TapTap制造' : (BOARDS.find(x => x.key === b) || {}).label)); });
  }

  async function load(force) {
    $('list').innerHTML = '<div class="empty">榜单加载中…</div>';
    try {
      const errors = [];
      const results = await Promise.all(BOARDS.map(b => fetchBoard(b.key, b.total).catch(e => { errors.push(b.label + ': ' + (e.message || e)); return []; })));
      BOARDS.forEach((b, i) => { state.data[b.key] = results[i] || []; });
      if (errors.length === BOARDS.length) {
        $('list').innerHTML = '<div class="empty">榜单请求失败<br>' + errors.map(esc).join('<br>') + '</div>';
        return;
      }
      state.hist = loadHist();
      state.loadedAt = Date.now();
      BOARDS.forEach(b => { if ((state.data[b.key] || []).length) saveSnap(b.key, state.data[b.key]); });
      render();
    } catch (e) {
      $('list').innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

  function detailHTML(it, boardLabel) {
    const d = deltaFor('hot', it);
    const hd = fmtDelta(d.heat);
    const rd = d.rank == null ? '—' : (d.rank > 0 ? '+' + d.rank : (d.rank < 0 ? String(d.rank) : '0'));
    return '<div class="rank-detail-mask" id="rd-mask"></div>' +
      '<div class="rank-detail-panel" id="rd-panel">' +
      '<div class="rd-head"><img class="rd-icon" src="' + (it.icon || '') + '">' +
      '<div class="rd-info"><div class="rd-title">' + esc(it.title) + '</div>' +
      '<div class="rd-sub">' + (boardLabel || '') + (it.rank ? ' · 第 ' + it.rank + ' 名' : '') + '</div></div>' +
      '<button class="rd-close" id="rd-close">×</button></div>' +
      '<div class="rd-grid">' +
      '<div class="rd-cell"><span>热度</span><b>' + fmtHeat(it.hits) + '</b></div>' +
      '<div class="rd-cell"><span>1h 变化</span><b class="' + hd.cls + '">' + hd.text + '</b></div>' +
      '<div class="rd-cell"><span>名次变化</span><b class="' + (d.rank > 0 ? 'up' : (d.rank < 0 ? 'down' : '')) + '">' + rd + '</b></div>' +
      '<div class="rd-cell"><span>评分</span><b>' + (it.score || '—') + '</b></div>' +
      '<div class="rd-cell"><span>评价</span><b>' + fmtHeat(it.reviews || 0) + '</b></div>' +
      '<div class="rd-cell"><span>粉丝</span><b>' + fmtHeat(it.fans || 0) + '</b></div>' +
      '</div>' +
      '<div class="rd-tags">' + (it.tags || []).map(t => '<span class="rank-tag">' + esc(t) + '</span>').join('') + '</div>' +
      '</div>';
  }

  function openDetail(id, boardLabel) {
    let it = null;
    for (const b of BOARDS) { const f = (state.data[b.key] || []).find(x => x.id === String(id)); if (f) { it = f; if (!boardLabel) boardLabel = b.label; break; } }
    if (!it) for (const b of BOARDS) { const f = (state.data[b.key] || []).find(x => x.id === String(id)); if (f) it = f; }
    if (!it) return;
    const host = document.createElement('div');
    host.id = 'rd-host';
    host.innerHTML = detailHTML(it, boardLabel);
    document.body.appendChild(host);
    document.getElementById('rd-close').addEventListener('click', closeDetail);
    document.getElementById('rd-mask').addEventListener('click', closeDetail);
  }
  function closeDetail() { const h = document.getElementById('rd-host'); if (h) h.remove(); }

  function doSearch() {
    const q = ($('q').value || '').trim().toLowerCase();
    if (!q) { render(); return; }
    const hits = [];
    for (const b of BOARDS) for (const it of (state.data[b.key] || [])) {
      if (it.id === q || (it.title || '').toLowerCase().includes(q)) {
        hits.push(Object.assign({}, it, { boardLabel: b.label }));
      }
    }
    if (!hits.length) { $('list').innerHTML = '<div class="empty">三榜中未找到「' + esc(q) + '」</div>'; $('hint').textContent = ''; return; }
    $('hint').textContent = '找到 ' + hits.length + ' 个';
    $('list').innerHTML = hits.slice(0, 30).map(h =>
      '<div class="rank-row"><div class="rank-no">#' + h.rank + '</div>' +
      '<img class="rank-icon" src="' + (h.icon || '') + '" loading="lazy">' +
      '<div class="rank-main"><div class="rank-title">' + esc(h.title) + '</div><div class="rank-sub">' + esc(h.boardLabel) + ' · 评分 ' + (h.score || '—') + '</div></div>' +
      '<div class="rank-heat"><div class="rank-heat-val">' + fmtHeat(h.hits) + '</div></div></div>'
    ).join('');
  }

  function bind() {
    $('boards').addEventListener('click', (e) => {
      const btn = e.target.closest('.rank-board'); if (!btn) return;
      state.board = btn.dataset.board;
      $('boards').querySelectorAll('.rank-board').forEach(b => b.classList.toggle('is-active', b === btn));
      render();
    });
    $('tags').addEventListener('click', (e) => {
      const btn = e.target.closest('.rank-tag'); if (!btn) return;
      state.tag = btn.dataset.tag || '';
      render();
    });
    $('refresh').addEventListener('click', () => load(true));
    $('qbtn').addEventListener('click', doSearch);
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    load(false);
    setInterval(() => load(true), 20 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
