/**
 * rank.js — 热度榜（公开榜单，免登录）
 *
 * 数据源：https://www.taptap.cn/webapiv2/app-top/v2/hits
 *   type_name = hot（热门榜 150）/ new（新品榜 100）/ game_jam（聚光灯榜 100）
 *   热度 = app.stat.hits_total（与游戏页「热度」一致，实时增长）
 *
 * 变化趋势：官方不提供历史，靠本机每小时快照（主进程写入 rank-history.json）计算
 */
(function () {
  'use strict';

  const BOARDS = [
    { key: 'hot', label: '热门榜', total: 150 },
    { key: 'new', label: '新品榜', total: 100 },
    { key: 'game_jam', label: '聚光灯榜', total: 100 }
  ];
  const MAKER_TAG = 'TapTap制造';
  const PAGE_SIZE = 10;
  const REFRESH_MS = 20 * 60 * 1000; // 对齐官方「每 20 分钟更新」

  const state = {
    board: 'hot',          // 当前榜单 or 'summary' / 'maker'
    tag: '',               // 标签筛选（'' = 全部）
    data: {},              // key -> items[]
    history: {},           // key -> snapshots[]
    loadedAt: null,
    loading: false,
    timer: null
  };

  const $ = (id) => document.getElementById(id);

  function api() {
    return (window.electronAPI && typeof window.electronAPI.rankBoard === 'function') ? window.electronAPI : null;
  }

  // ---------- 格式化 ----------
  function fmtHeat(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(2) + '亿';
    if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万';
    return v.toLocaleString('zh-CN');
  }
  function fmtDelta(n) {
    if (n == null || !Number.isFinite(n) || n === 0) return { text: '—', cls: 'flat' };
    const abs = Math.abs(n);
    const text = (n > 0 ? '+' : '-') + fmtHeat(abs);
    return { text, cls: n > 0 ? 'up' : 'down' };
  }
  function fmtPct(cur, prev) {
    if (!prev || !cur) return '';
    const p = ((cur - prev) / prev) * 100;
    if (!Number.isFinite(p) || Math.abs(p) < 0.005) return '';
    return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 数据加载 ----------
  async function fetchBoard(key, total) {
    const bridge = api();
    if (!bridge) throw new Error('当前端不支持榜单');
    const items = [];
    let from = 0;
    let guard = 0;
    while (from < total && guard < 30) {
      guard++;
      const res = await bridge.rankBoard(key, from, PAGE_SIZE);
      if (!res || !res.ok) throw new Error('榜单请求失败' + (res && res.status ? ' ' + res.status : ''));
      const json = JSON.parse(res.body);
      const list = (json.data && json.data.list) || [];
      const realTotal = (json.data && json.data.total) || total;
      list.forEach((it, i) => {
        const app = it.app || {};
        const stat = app.stat || {};
        items.push({
          id: String(app.id),
          rank: from + i + 1,
          title: app.title || '',
          icon: app.icon && (app.icon.small_url || app.icon.url),
          score: stat.rating && stat.rating.score,
          hits: stat.hits_total,
          reviews: stat.review_count,
          fans: stat.fans_count,
          labels: app.title_labels || [],
          tags: (app.tags || []).map(t => (t && t.value) || '').filter(Boolean),
          isAd: !!it.is_ad
        });
      });
      from += PAGE_SIZE;
      if (from >= realTotal) break;
    }
    return items;
  }

  async function loadAll(force) {
    if (state.loading) return;
    state.loading = true;
    $('rank-list').innerHTML = '<div class="loading-tip">榜单加载中…</div>';
    try {
      const bridge = api();
      const results = await Promise.all(BOARDS.map(b => fetchBoard(b.key, b.total).catch(e => ({ error: String(e.message || e) }))));
      BOARDS.forEach((b, i) => {
        const r = results[i];
        state.data[b.key] = Array.isArray(r) ? r : [];
      });
      // 读取历史快照（用于计算涨幅与走势）
      if (bridge && typeof bridge.rankHistory === 'function') {
        const hists = await Promise.all(BOARDS.map(b => bridge.rankHistory(b.key, null, true).catch(() => null)));
        BOARDS.forEach((b, i) => {
          state.history[b.key] = (hists[i] && hists[i].snapshots) || [];
        });
      }
      state.loadedAt = Date.now();
      // 写入当前整点快照
      if (bridge && typeof bridge.rankSaveSnapshot === 'function') {
        BOARDS.forEach(b => {
          const items = state.data[b.key];
          if (items && items.length) bridge.rankSaveSnapshot(b.key, items).catch(() => {});
        });
      }
      render();
    } catch (e) {
      $('rank-list').innerHTML = '<div class="loading-tip">榜单加载失败：' + (e.message || e) + '</div>';
    } finally {
      state.loading = false;
    }
  }

  // ---------- 变化计算 ----------
  // 取「约 1 小时前」的快照作为基准；不足 1 小时则用最早的一条
  function baseline(key) {
    const arr = state.history[key] || [];
    if (!arr.length) return null;
    const target = Date.now() - 60 * 60 * 1000;
    let pick = null;
    for (const s of arr) if (s.ts <= target) pick = s;
    return pick || arr[0];
  }
  function deltaFor(key, item) {
    const base = baseline(key);
    if (!base) return null;
    const prev = (base.items || []).find(i => String(i.id) === item.id);
    if (!prev) return { heat: null, rank: null, isNew: true };
    return {
      heat: (item.hits != null && prev.hits != null) ? item.hits - prev.hits : null,
      rank: (prev.rank && item.rank) ? prev.rank - item.rank : null,
      isNew: false
    };
  }
  function sparkFor(key, id) {
    const arr = state.history[key] || [];
    const pts = [];
    for (const s of arr.slice(-24)) {
      const hit = (s.items || []).find(i => String(i.id) === String(id));
      pts.push(hit && hit.hits != null ? hit.hits : null);
    }
    return pts;
  }

  function sparkSVG(pts, w, h) {
    const real = pts.filter(v => v != null);
    if (real.length < 2) return '<span class="rank-spark-empty">—</span>';
    const min = Math.min(...real), max = Math.max(...real);
    const span = max - min || 1;
    const step = w / (pts.length - 1 || 1);
    let d = '';
    pts.forEach((v, i) => {
      if (v == null) return;
      const x = i * step;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      d += (d ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    const up = real[real.length - 1] >= real[0];
    return '<svg class="rank-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<path d="' + d + '" fill="none" stroke="' + (up ? '#ef4444' : '#10b981') + '" stroke-width="1.4"/></svg>';
  }

  // ---------- 渲染 ----------
  // 标签筛选：统计三榜出现过的标签，按频次排序
  function allTags() {
    const count = new Map();
    for (const b of BOARDS) {
      for (const it of (state.data[b.key] || [])) {
        for (const t of (it.tags || [])) {
          if (!t) continue;
          count.set(t, (count.get(t) || 0) + 1);
        }
      }
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  }

  function renderTags() {
    const bar = $('rank-tags');
    if (!bar) return;
    const tags = allTags();
    if (!tags.length) { bar.innerHTML = ''; return; }
    const priority = [MAKER_TAG, '模拟经营', '模拟', '放置', '角色扮演', '休闲', '养成', '策略'];
    const head = priority.filter(t => tags.includes(t));
    const rest = tags.filter(t => !head.includes(t)).slice(0, 12);
    const list = [''].concat(head).concat(rest);
    bar.innerHTML = list.map(t => {
      const label = t === '' ? '全部' : t;
      const active = (state.tag === t) ? ' is-active' : '';
      return '<button type="button" class="rank-tag' + active + '" data-tag="' + esc(t) + '">' + esc(label) + '</button>';
    }).join('');
  }

  function matchTag(item) {
    if (!state.tag) return true;
    return (item.tags || []).includes(state.tag);
  }

  function rowHTML(item, key) {
    const d = (item.preDelta !== undefined)
      ? { heat: item.preDelta, rank: null, isNew: false }
      : (deltaFor(key, item) || {});
    const heatDelta = fmtDelta(d.heat);
    const rankDelta = d.rank == null ? '' : (d.rank > 0 ? '<span class="rank-up">↑' + d.rank + '</span>' : (d.rank < 0 ? '<span class="rank-down">↓' + Math.abs(d.rank) + '</span>' : ''));
    const labels = (item.labels || []).map(l => '<span class="rank-label">' + l + '</span>').join('');
    const pct = d.heat != null ? fmtPct(item.hits, item.hits - d.heat) : '';
    const spark = sparkSVG(sparkFor(key, item.id), 56, 18);
    return '<div class="rank-row" data-app-id="' + item.id + '" data-board="' + key + '">' +
      '<div class="rank-no">' + item.rank + rankDelta + '</div>' +
      '<img class="rank-icon" src="' + (item.icon || 'app-icon.png') + '" alt="" loading="lazy">' +
      '<div class="rank-main">' +
        '<div class="rank-title">' + esc(item.title) + labels + '</div>' +
        '<div class="rank-sub">评分 ' + (item.score || '—') + ' · 评价 ' + fmtHeat(item.reviews || 0) + ' · 粉丝 ' + fmtHeat(item.fans || 0) + '</div>' +
      '</div>' +
      '<div class="rank-heat">' +
        '<div class="rank-heat-val">' + fmtHeat(item.hits) + '</div>' +
        '<div class="rank-heat-delta ' + heatDelta.cls + '">' + heatDelta.text + (pct ? ' ' + pct : '') + '</div>' +
      '</div>' +
      '<div class="rank-spark-wrap">' + spark + '</div>' +
    '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    const board = state.board;
    const list = $('rank-list');
    const summary = $('rank-summary');
    hideDetail();
    renderTags();
    $('rank-updated').textContent = state.loadedAt ? ('更新于 ' + fmtTime(state.loadedAt) + ' · 每 20 分钟') : '尚未加载';

    if (board === 'summary') {
      list.hidden = true;
      summary.hidden = false;
      renderSummary();
      updateScrollButtons();
      return;
    }
    if (board === 'maker') {
      list.hidden = false;
      summary.hidden = true;
      renderMakerBoard();
      return;
    }
    list.hidden = false;
    summary.hidden = true;

    const items = (state.data[board] || []).filter(matchTag);
    if (!items.length) {
      list.innerHTML = '<div class="loading-tip">' + (state.tag ? ('该榜单暂无「' + state.tag + '」标签的游戏') : '暂无数据') + '</div>';
      return;
    }
    const base = baseline(board);
    list.innerHTML =
      '<div class="rank-hint">' + (state.tag ? ('筛选：' + state.tag + ' · 共 ' + items.length + ' 款 · ') : '') + (base ? ('变化基准：' + fmtTime(base.ts) + (base.ts > Date.now() - 3600000 ? '（运行不足 1 小时，暂用最早快照）' : '')) : '首次运行，本小时后开始记录变化') + '</div>' +
      items.map(it => rowHTML(it, board)).join('');
    bindRows();
    updateScrollButtons();
  }

  // TapTap 制造榜：三榜里带「TapTap制造」标签的游戏，按热度排序
  function makerItems() {
    const map = new Map();
    for (const b of BOARDS) {
      for (const it of (state.data[b.key] || [])) {
        if (!(it.tags || []).includes(MAKER_TAG)) continue;
        const cur = map.get(it.id);
        const d = deltaFor(b.key, it) || {};
        if (!cur) {
          map.set(it.id, { ...it, board: b.key, boardLabel: b.label, heatDelta: d.heat });
        } else if ((it.hits || 0) > (cur.hits || 0)) {
          map.set(it.id, { ...it, board: b.key, boardLabel: b.label, heatDelta: d.heat });
        }
      }
    }
    return [...map.values()].sort((a, b2) => (b2.hits || 0) - (a.hits || 0));
  }

  function renderMakerBoard() {
    const list = $('rank-list');
    const items = makerItems().filter(matchTag);
    if (!items.length) {
      list.innerHTML = '<div class="rank-hint">三个榜里暂时没有符合「' + (state.tag || MAKER_TAG) + '」标签的制造游戏（该标签来自游戏在 TapTap 上的分类）</div><div class="loading-tip">暂无数据</div>';
      updateScrollButtons();
      return;
    }
    list.innerHTML =
      '<div class="rank-hint">共 ' + items.length + ' 款 TapTap 制造游戏在榜' + (state.tag ? ('（筛选：' + state.tag + '）') : '') + ' · 按热度排序</div>' +
      items.map((it, i) => rowHTML({ ...it, rank: i + 1, preDelta: it.heatDelta }, 'maker')).join('');
    bindRows();
    updateScrollButtons();
  }

  // 汇总：三榜合并去重，涨幅榜 / 新进榜 / 热度榜
  function renderSummary() {
    const wrap = $('rank-summary');
    const merged = new Map();
    for (const b of BOARDS) {
      for (const it of (state.data[b.key] || [])) {
        const d = deltaFor(b.key, it) || {};
        const cur = merged.get(it.id);
        const row = { ...it, board: b.key, boardLabel: b.label, heatDelta: d.heat, rankDelta: d.rank, isNew: d.isNew };
        if (!cur || (row.hits || 0) > (cur.hits || 0)) merged.set(it.id, row);
      }
    }
    const all = [...merged.values()].filter(matchTag);
    const withDelta = all.filter(x => x.heatDelta != null).sort((a, b) => b.heatDelta - a.heatDelta);
    const newOnes = all.filter(x => x.isNew);
    const topHeat = [...all].sort((a, b) => (b.hits || 0) - (a.hits || 0)).slice(0, 30);

    const card = (title, note, rows, showDelta) => {
      if (!rows.length) return '<section class="rank-sum-card"><h3>' + title + '</h3><div class="rank-empty">暂无数据</div></section>';
      return '<section class="rank-sum-card"><h3>' + title + '<span>' + note + '</span></h3>' +
        rows.slice(0, 20).map((r, i) => {
          const dv = fmtDelta(r.heatDelta);
          return '<div class="rank-sum-row" data-app-id="' + r.id + '" data-board="' + r.board + '">' +
            '<span class="rank-sum-idx">' + (i + 1) + '</span>' +
            '<img class="rank-sum-icon" src="' + (r.icon || 'app-icon.png') + '" alt="" loading="lazy">' +
            '<span class="rank-sum-title">' + esc(r.title) + '</span>' +
            '<span class="rank-sum-board">' + r.boardLabel + '</span>' +
            '<span class="rank-sum-heat">' + fmtHeat(r.hits) + '</span>' +
            '<span class="rank-sum-delta ' + dv.cls + '">' + (showDelta ? dv.text : ('#' + r.rank)) + '</span>' +
          '</div>';
        }).join('') + '</section>';
    };

    wrap.innerHTML =
      (state.tag ? '<div class="rank-hint">汇总筛选：' + esc(state.tag) + '</div>' : '') +
      '<div class="rank-sum-grid">' +
        card('涨幅榜', '近 1 小时热度增长', withDelta, true) +
        card('新进榜', '最近才出现在榜单里', newOnes, false) +
        card('热度榜', '当前热度 Top 30', topHeat, false) +
      '</div>';
    wrap.querySelectorAll('.rank-sum-row').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.appId, el.dataset.board, el));
    });
  }

  // ---------- 搜索 ----------
  function doSearch() {
    const q = String(($('rank-search-input').value || '')).trim().toLowerCase();
    const box = $('rank-search-result');
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    const hits = [];
    for (const b of BOARDS) {
      for (const it of (state.data[b.key] || [])) {
        if (String(it.id) === q || (it.title || '').toLowerCase().includes(q)) {
          hits.push({ ...it, board: b.key, boardLabel: b.label });
        }
      }
    }
    if (!hits.length) {
      box.hidden = false;
      box.innerHTML = '<div class="rank-empty">三个榜里都没有匹配的游戏' + (/^\d+$/.test(q) ? '，正在按 APP ID 查询详情…' : '') + '</div>';
      if (/^\d+$/.test(q)) openDetail(q, null);
      return;
    }
    box.hidden = false;
    box.innerHTML = hits.slice(0, 20).map(h =>
      '<div class="rank-sum-row" data-app-id="' + h.id + '" data-board="' + h.board + '">' +
        '<span class="rank-sum-idx">#' + h.rank + '</span>' +
        '<span class="rank-sum-title">' + esc(h.title) + '</span>' +
        '<span class="rank-sum-board">' + h.boardLabel + '</span>' +
        '<span class="rank-sum-heat">' + fmtHeat(h.hits) + '</span>' +
        '<span class="rank-sum-delta">评分 ' + (h.score || '—') + '</span>' +
      '</div>'
    ).join('');
    box.querySelectorAll('.rank-sum-row').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.appId, el.dataset.board, el));
    });
  }

  // ---------- 详情（就地展开在点击的那一行下方） ----------
  function hideDetail() {
    const p = $('rank-detail');
    if (p) p.hidden = true;
  }
  function placeDetail(anchor) {
    const p = $('rank-detail');
    if (!p) return;
    if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', p);
    p.hidden = false;
  }

  async function openDetail(appId, board, anchor) {
    const panel = $('rank-detail');
    placeDetail(anchor && anchor.nodeType === 1 ? anchor : null);
    panel.hidden = false;
    $('rank-detail-title').textContent = '加载中…';
    $('rank-detail-sub').textContent = '';
    $('rank-detail-stats').innerHTML = '';
    $('rank-detail-chart').innerHTML = '';

    // 先在已加载榜单里找
    let found = null, foundBoard = null;
    for (const b of BOARDS) {
      const hit = (state.data[b.key] || []).find(x => String(x.id) === String(appId));
      if (hit) { found = hit; foundBoard = b; break; }
    }
    if (found) {
      $('rank-detail-icon').src = found.icon || 'app-icon.png';
      $('rank-detail-title').textContent = found.title;
      const sub = [];
      if (foundBoard) sub.push(foundBoard.label + ' #' + found.rank);
      if ((found.labels || []).length) sub.push(found.labels.join('/'));
      $('rank-detail-sub').textContent = sub.join(' · ');
    }

    // 趋势（来自本机快照）
    let series = [];
    if (board || foundBoard) {
      const bkey = board || foundBoard.key;
      const bridge = api();
      if (bridge && typeof bridge.rankHistory === 'function') {
        const r = await bridge.rankHistory(bkey, appId, false).catch(() => null);
        series = (r && r.series) || [];
      }
    }
    renderDetailChart(series);

    // 详情接口（含热度、所在榜名次、评分、评价数）
    const bridge = api();
    if (bridge && typeof bridge.rankAppDetail === 'function') {
      const d = await bridge.rankAppDetail(appId).catch(() => null);
      if (d && d.ok && d.app) {
        const a = d.app;
        $('rank-detail-icon').src = a.icon || 'app-icon.png';
        $('rank-detail-title').textContent = a.title;
        $('rank-detail-sub').textContent = [a.rankTitle && (a.rankTitle + ' ' + a.rankText), (a.tags || []).join('/')].filter(Boolean).join(' · ');
        $('rank-detail-stats').innerHTML =
          statTile('热度', fmtHeat(a.hits)) +
          statTile('评分', a.score || '—') +
          statTile('评价数', fmtHeat(a.reviewCount || 0)) +
          statTile('粉丝', fmtHeat(a.fans || 0));
      } else {
        $('rank-detail-stats').innerHTML = statTile('热度', fmtHeat(found && found.hits)) + statTile('评分', (found && found.score) || '—');
      }
    } else if (found) {
      $('rank-detail-stats').innerHTML = statTile('热度', fmtHeat(found.hits)) + statTile('评分', found.score || '—');
    }
  }

  function statTile(label, value) {
    return '<div class="rank-stat"><span class="rank-stat-label">' + label + '</span><strong class="rank-stat-value">' + value + '</strong></div>';
  }

  function renderDetailChart(series) {
    const el = $('rank-detail-chart');
    const pts = series.filter(s => s.hits != null);
    if (pts.length < 2) {
      el.innerHTML = '<div class="rank-empty">趋势数据不足（需本机持续运行，每小时记录一个点）</div>';
      return;
    }
    const w = 520, h = 120, pad = 6;
    const vals = pts.map(p => p.hits);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const step = (w - pad * 2) / (pts.length - 1);
    let d = '';
    pts.forEach((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p.hits - min) / span) * (h - pad * 2);
      d += (d ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    const up = vals[vals.length - 1] >= vals[0];
    const color = up ? '#ef4444' : '#10b981';
    el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="rank-chart-svg" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.8"/></svg>' +
      '<div class="rank-chart-meta"><span>' + fmtTime(pts[0].ts) + '</span><span>' + fmtTime(pts[pts.length - 1].ts) + '</span></div>';
  }

  // ---------- 视图切换 ----------
  function bindViewTabs() {
    const tabs = $('view-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.view-tab');
      if (!btn) return;
      const view = btn.getAttribute('data-view');
      tabs.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('is-active', b === btn));
      $('view-home').hidden = view !== 'home';
      $('view-rank').hidden = view !== 'rank';
      if (view === 'rank' && !state.loadedAt) loadAll();
    });
  }

  // ---------- 事件绑定 ----------
  function bindRows() {
    document.querySelectorAll('#rank-list .rank-row').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.appId, el.dataset.board, el));
    });
  }

  // ---------- 回顶 / 到底 ----------
  let lastScrollY = 0;
  function updateScrollButtons() {
    const topBtn = $('rank-scroll-top');
    const botBtn = $('rank-scroll-bottom');
    if (!topBtn || !botBtn) return;
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const max = (document.documentElement.scrollHeight - window.innerHeight);
    const view = $('view-rank');
    const active = view && !view.hidden;
    topBtn.classList.toggle('is-show', active && y > 200);
    botBtn.classList.toggle('is-show', active && max - y > 200);
    const dir = y > lastScrollY ? 'down' : (y < lastScrollY ? 'up' : '');
    lastScrollY = y;
    if (dir) {
      topBtn.classList.toggle('is-hint', dir === 'up');
      botBtn.classList.toggle('is-hint', dir === 'down');
    }
  }
  function bindScrollButtons() {
    const topBtn = $('rank-scroll-top');
    const botBtn = $('rank-scroll-bottom');
    if (topBtn) topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    if (botBtn) botBtn.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
    window.addEventListener('scroll', updateScrollButtons, { passive: true });
    updateScrollButtons();
  }

  function bind() {
    bindViewTabs();
    bindScrollButtons();
    $('rank-boards').addEventListener('click', (e) => {
      const btn = e.target.closest('.rank-board');
      if (!btn) return;
      state.board = btn.getAttribute('data-board');
      $('rank-boards').querySelectorAll('.rank-board').forEach(b => b.classList.toggle('is-active', b === btn));
      render();
    });
    $('rank-refresh').addEventListener('click', () => loadAll(true));
    const tagBar = $('rank-tags');
    if (tagBar) {
      tagBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.rank-tag');
        if (!btn) return;
        state.tag = btn.getAttribute('data-tag') || '';
        render();
      });
    }
    $('rank-search-btn').addEventListener('click', doSearch);
    $('rank-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    $('rank-detail-close').addEventListener('click', () => { $('rank-detail').hidden = true; });

    // 每 20 分钟自动刷新（仅在热度榜视图可见时）
    state.timer = setInterval(() => {
      const v = $('view-rank');
      if (v && !v.hidden) loadAll(true);
    }, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
