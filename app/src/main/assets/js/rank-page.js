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
  const XUA = 'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&UID=' + 'zpad' + '&OS=Android&OSV=14&DT=Phone';
  function uuid() {
    let u = localStorage.getItem('rank_uuid');
    if (!u || u.length < 30) {
      u = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 3 | 8); return v.toString(16); });
      localStorage.setItem('rank_uuid', u);
    }
    return u;
  }

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
          icon: a.icon && (a.icon.small_url || a.icon.url),
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
      '<img class="rank-icon" src="' + (it.icon || 'app-icon.png') + '" loading="lazy">' +
      '<div class="main"><div class="title">' + esc(it.title) + '</div>' +
      '<div class="sub">评分 ' + (it.score || '—') + ' · 评价 ' + fmtHeat(it.reviews || 0) + ' · 粉丝 ' + fmtHeat(it.fans || 0) + '</div></div>' +
      '<div class="heat"><div class="heat-v">' + fmtHeat(it.hits) + '</div><div class="heat-d ' + hd.cls + '">' + hd.text + '</div></div>' +
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
      const card = (title, rows, showDelta) => rows.length ? '<div class="sum-card"><h3>' + title + '</h3>' + rows.slice(0, 15).map((r, i) => {
        const d = fmtDelta(deltaFor('hot', r).heat);
        return '<div class="row" style="margin:0 -12px;padding:8px 12px"><div class="no">' + (i + 1) + '</div>' +
          '<img class="rank-icon" src="' + (r.icon || 'app-icon.png') + '" loading="lazy">' +
          '<div class="main"><div class="title">' + esc(r.title) + '</div><div class="sub">' + r.boardLabel + ' · 热度 ' + fmtHeat(r.hits) + '</div></div>' +
          '<div class="heat"><div class="heat-v ' + d.cls + '">' + (showDelta ? d.text : '') + '</div></div></div>';
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
  }

  async function load(force) {
    $('list').innerHTML = '<div class="empty">榜单加载中…</div>';
    try {
      const results = await Promise.all(BOARDS.map(b => fetchBoard(b.key, b.total).catch(() => [])));
      BOARDS.forEach((b, i) => { state.data[b.key] = results[i] || []; });
      state.hist = loadHist();
      state.loadedAt = Date.now();
      BOARDS.forEach(b => { if ((state.data[b.key] || []).length) saveSnap(b.key, state.data[b.key]); });
      render();
    } catch (e) {
      $('list').innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

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
      '<div class="row"><div class="no">#' + h.rank + '</div>' +
      '<img class="rank-icon" src="' + (h.icon || 'app-icon.png') + '" loading="lazy">' +
      '<div class="main"><div class="title">' + esc(h.title) + '</div><div class="sub">' + h.boardLabel + ' · 评分 ' + (h.score || '—') + '</div></div>' +
      '<div class="heat"><div class="heat-v">' + fmtHeat(h.hits) + '</div></div></div>'
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
      const btn = e.target.closest('.tag'); if (!btn) return;
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
