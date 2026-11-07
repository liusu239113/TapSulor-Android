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
  // TapTap「今日游戏」日历：按天返回首发 / 测试 / 预约，含 total
  const CAL_URL = 'https://www.taptap.cn/webapiv2/calendar/v1/event-list';
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

  const state = {
    board: 'hot', tag: '', data: {}, hist: {}, loadedAt: null,
    cal: null, calError: null, calAt: 0, calType: 'all', calSource: 'all'
  };
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

  const SNAP_MIN_MS = 5 * 60 * 1000;   // 5 分钟内重复刷新不重复记点
  const KEEP_POINTS = 96;             // 20 分钟一个点 ≈ 最近 32 小时
  const SPARK_POINTS = 12;            // 行内迷你走势最多 12 个点

  const pctOf = (cur, base) => (cur == null || base == null || base <= 0) ? null : (cur - base) / base * 100;

  function seriesFor(key, id) {
    const arr = state.hist[key] || [];
    const out = [];
    for (const s of arr) {
      const it = (s.items || []).find(x => x.id === id);
      if (it && it.hits != null) out.push(it.hits);
    }
    return out.slice(-SPARK_POINTS);
  }

  function sparkSVG(series, up) {
    if (!series || series.length < 2) return '';
    const w = 56, h = 15, pad = 1.5;
    const min = Math.min.apply(null, series), max = Math.max.apply(null, series);
    const span = (max - min) || 1;
    const xy = series.map((v, i) => {
      const x = pad + i * (w - pad * 2) / (series.length - 1);
      const y = h - pad - (v - min) / span * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const color = up ? '#ef4444' : '#10b981';
    const fill = up ? 'rgba(239,68,68,.14)' : 'rgba(16,185,129,.14)';
    const area = pad.toFixed(1) + ',' + (h - pad) + ' ' + xy.join(' ') + ' ' + (w - pad).toFixed(1) + ',' + (h - pad);
    return '<svg class="rank-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
      '<polygon points="' + area + '" fill="' + fill + '"/>' +
      '<polyline points="' + xy.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function winLabel(ms) {
    const m = Math.round(ms / 60000);
    if (m < 90) return Math.max(1, m) + '分钟';
    return Math.round(m / 60) + '小时';
  }

  function momentum(key, item) {
    const arr = state.hist[key] || [];
    const now = Date.now();
    const t1 = now - 3600000, t24 = now - 24 * 3600000;
    let base1 = null, base24 = null;
    for (const s of arr) { if (s.ts <= t1) base1 = s; if (s.ts <= t24) base24 = s; }
    // 历史不足 1 小时时，用最早一个 ≥3 分钟的点做基准（太短的窗口噪声大）
    if (!base1 && arr.length && now - arr[0].ts >= 3 * 60000) base1 = arr[0];
    const hitOf = (s) => {
      if (!s) return null;
      const x = (s.items || []).find(i => i.id === item.id);
      return x ? x.hits : null;
    };
    const h1 = hitOf(base1), h24 = hitOf(base24);
    const prevRank = base1 ? (((base1.items || []).find(i => i.id === item.id)) || {}).rank : null;
    return {
      p1: pctOf(item.hits, h1),
      p24: pctOf(item.hits, h24),
      h1Delta: (h1 != null && item.hits != null) ? item.hits - h1 : null,
      rankDelta: prevRank != null ? prevRank - item.rank : null,
      win1: base1 ? (now - base1.ts) : null,
      win24: base24 ? (now - base24.ts) : null,
      series: seriesFor(key, item.id)
    };
  }

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

  /** 今日游戏日历：一次请求拿到今天所有首发/测试/预约 */
  async function fetchCalendar() {
    const d = new Date();
    const day = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
    const url = CAL_URL + '?day=' + day + '&X-UA=' + encodeURIComponent(xua());
    const j = await getJson(url);
    if (!j || !j.data) throw new Error('今日游戏接口返回失败');
    const raw = [];
    ['list_a', 'list_b', 'list_c'].forEach(k => (j.data[k] || []).forEach(x => raw.push(x)));
    const map = new Map();
    raw.forEach(ev => {
      const a = ev.app_card_info || {};
      if (!a.id) return;
      const prev = map.get(a.id);
      // 同一游戏当天可能有多个事件：优先保留「首发」
      if (!prev || (ev.event_type === 1 && prev.event_type !== 1)) map.set(a.id, ev);
    });
    const items = [...map.values()].map(ev => {
      const a = ev.app_card_info || {};
      const s = a.stat || {};
      const tags = (a.tags || []).map(t => (t && t.value) || '').filter(Boolean);
      const devs = (a.developers || []).map(x => (x && x.name) || '').filter(Boolean);
      return {
        id: String(a.id),
        title: a.title || '',
        icon: a.icon && (a.icon.small_url || a.icon.medium_url || a.icon.url),
        type: ev.sub_event_type_title || '其他',
        eventType: ev.event_type || 0,
        startTime: (ev.start_time || 0) * 1000,
        dateOnly: !!ev.is_date_only,
        maker: tags.indexOf(MAKER_TAG) >= 0,
        tags,
        devs,
        reserve: s.reserve_count || 0,
        fans: s.fans_count || 0,
        reviews: s.review_count || 0,
        score: s.rating && s.rating.score
      };
    });
    return { total: j.data.game_total || items.length, items, at: Date.now() };
  }

  function saveSnap(key, items) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) {}
    const arr = Array.isArray(all[key]) ? all[key] : [];
    const now = Date.now();
    const snap = { ts: now, items: items.map(i => ({ id: i.id, rank: i.rank, hits: i.hits })) };
    const last = arr[arr.length - 1];
    // 5 分钟内重刷只更新最后一点，避免把曲线加密成一堆重复值
    if (last && now - last.ts < SNAP_MIN_MS) arr[arr.length - 1] = snap; else arr.push(snap);
    arr.sort((a, b) => a.ts - b.ts);
    all[key] = arr.slice(-KEEP_POINTS);
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

  function rowHTML(it, key, idx, isHot) {
    const m = momentum(key, it);
    const p1 = m.p1;
    const rd = m.rankDelta == null || m.rankDelta === 0 ? '' : (m.rankDelta > 0
      ? '<span class="rank-move up" title="比上次快照上升' + m.rankDelta + '名">↑' + m.rankDelta + '</span>'
      : '<span class="rank-move down" title="比上次快照下降' + Math.abs(m.rankDelta) + '名">↓' + Math.abs(m.rankDelta) + '</span>');
    let delta;
    if (p1 == null) {
      delta = '<div class="rank-heat-delta flat">' + (m.series.length > 1 ? '走势记录中' : '记录中') + '</div>';
    } else {
      const cls = p1 > 0.05 ? 'up' : (p1 < -0.05 ? 'down' : 'flat');
      const body = Math.abs(p1) < 0.05 ? '持平' : ((p1 > 0 ? '+' : '') + p1.toFixed(1) + '%');
      delta = '<div class="rank-heat-delta ' + cls + '">' + winLabel(m.win1 || 3600000) + ' ' + body + '</div>';
    }
    const hot = isHot ? ' is-hot' : '';
    return '<div class="rank-row' + hot + '">' +
      '<div class="rank-no">' + (idx != null ? idx : it.rank) + rd + '</div>' +
      '<img class="rank-icon" src="' + (it.icon || '') + '">' +
      '<div class="rank-main"><div class="rank-title">' + esc(it.title) + '</div>' +
      '<div class="rank-sub">评分 ' + (it.score || '—') + ' · 评价 ' + fmtHeat(it.reviews || 0) + ' · 粉丝 ' + fmtHeat(it.fans || 0) + '</div></div>' +
      '<div class="rank-heat"><div class="rank-heat-val">' + fmtHeat(it.hits) + '</div>' + delta + sparkSVG(m.series, p1 != null && p1 > 0) + '</div>' +
    '</div>';
  }

  /** 汇总页的“今日飙升”：三榜合并、跟随分类标签，按热度涨幅排 TOP5 */
  function moversCard() {
    const byId = new Map();
    for (const b of BOARDS) {
      for (const it of (state.data[b.key] || [])) {
        if ((it.hits || 0) < 5000) continue;
        if (!matchTag(it)) continue;
        const m = momentum(b.key, it);
        if (m.p1 == null || m.p1 <= 0.5 || m.h1Delta <= 0) continue;
        const prev = byId.get(it.id);
        if (!prev || m.p1 > prev.m.p1) byId.set(it.id, { it, m });
      }
    }
    const top = [...byId.values()].sort((a, b2) => b2.m.p1 - a.m.p1).slice(0, 5);
    if (!top.length) return '';
    const win = top[0].m.win1 ? winLabel(top[0].m.win1) : '1小时';
    return '<div class="rank-sum-card rank-movers-card"><h3>今日飙升<span>近' + win + '热度涨幅' +
      (state.tag ? ' · ' + esc(state.tag) : '') + '</span></h3>' +
      top.map(({ it, m }, i) =>
        '<div class="rm-row" data-id="' + esc(it.id) + '">' +
          '<span class="rm-no">' + (i + 1) + '</span>' +
          '<img class="rm-icon" src="' + (it.icon || '') + '" loading="lazy">' +
          '<span class="rm-name">' + esc(it.title) + '</span>' +
          '<span class="rm-pct">+' + m.p1.toFixed(1) + '%</span>' +
        '</div>'
      ).join('') + '</div>';
  }

  const fmtClock = (ts) => { const d = new Date(ts); const p = x => String(x).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()); };
  const calTypeRank = (t) => t === '首发' ? 0 : (t.indexOf('测试') >= 0 ? 1 : 2);
  const calBadgeCls = (t) => t === '首发' ? 'cal-b-launch' : (t.indexOf('测试') >= 0 ? 'cal-b-test' : 'cal-b-reserve');

  /** 「今日」分类：TapTap 今日游戏日历，首发/测试/预约 × 制造/非制造 */
  function renderToday(list) {
    $('tags').innerHTML = '';
    $('hint').textContent = '数据来自 TapTap 今日游戏日历';
    const cal = state.cal;
    if (state.calError && !cal) {
      list.innerHTML = '<div class="empty">今日游戏加载失败：' + esc(state.calError) + '</div>';
      return;
    }
    if (!cal) { list.innerHTML = '<div class="empty">今日游戏加载中…</div>'; return; }

    const items = cal.items || [];
    const isTest = (t) => t.indexOf('测试') >= 0;
    const count = {
      all: items.length,
      launch: items.filter(x => x.type === '首发').length,
      test: items.filter(x => isTest(x.type)).length,
      reserve: items.filter(x => x.type === '新游预约').length,
      maker: items.filter(x => x.maker).length
    };
    count.other = count.all - count.maker;

    const matchType = (x) => state.calType === 'all' ? true
      : state.calType === 'launch' ? x.type === '首发'
        : state.calType === 'test' ? isTest(x.type)
          : x.type === '新游预约';
    const matchSrc = (x) => state.calSource === 'all' ? true
      : (state.calSource === 'maker' ? x.maker : !x.maker);
    const shown = items.filter(x => matchType(x) && matchSrc(x))
      .sort((a, b) => calTypeRank(a.type) - calTypeRank(b.type) || (b.reserve - a.reserve));

    const d = new Date(cal.at || Date.now());
    const dateStr = (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
    const chip = (dim, val, label, n, active) =>
      '<button class="cal-chip' + (active ? ' is-active' : '') + '" data-dim="' + dim + '" data-v="' + val + '">' + label + ' <b>' + n + '</b></button>';

    const head = '<div class="cal-summary">' +
      '<div class="cal-summary-head"><b>今日上新 ' + count.all + ' 款</b><span>' + dateStr + '</span></div>' +
      '<div class="cal-summary-grid">' +
        '<div class="cal-sum-item is-launch"><b>' + count.launch + '</b><span>首发</span></div>' +
        '<div class="cal-sum-item is-test"><b>' + count.test + '</b><span>测试</span></div>' +
        '<div class="cal-sum-item is-reserve"><b>' + count.reserve + '</b><span>预约</span></div>' +
        '<div class="cal-sum-item is-maker"><b>' + count.maker + '</b><span>制造</span></div>' +
      '</div></div>';

    const filters = '<div class="cal-filters">' +
      '<div class="cal-chip-row">' +
        chip('type', 'all', '全部', count.all, state.calType === 'all') +
        chip('type', 'launch', '首发', count.launch, state.calType === 'launch') +
        chip('type', 'test', '测试', count.test, state.calType === 'test') +
        chip('type', 'reserve', '预约', count.reserve, state.calType === 'reserve') +
      '</div><div class="cal-chip-row">' +
        chip('source', 'all', '全部来源', count.all, state.calSource === 'all') +
        chip('source', 'maker', 'TapTap制造', count.maker, state.calSource === 'maker') +
        chip('source', 'other', '非制造', count.other, state.calSource === 'other') +
      '</div></div>';

    const rows = shown.map(it => {
      const meta = [
        it.dateOnly ? '今日' : fmtClock(it.startTime),
        Number(it.score) > 0 ? '评分 ' + it.score : '',
        it.tags.filter(t => t !== MAKER_TAG).slice(0, 2).join(' / ')
      ];
      return '<div class="cal-row" data-id="' + esc(it.id) + '">' +
        '<img class="rank-icon" src="' + (it.icon || '') + '" loading="lazy">' +
        '<div class="rank-main"><div class="rank-title">' + esc(it.title) +
          ' <span class="cal-badge ' + calBadgeCls(it.type) + '">' + esc(it.type) + '</span>' +
          (it.maker ? ' <span class="cal-badge cal-b-maker">制造</span>' : '') + '</div>' +
        '<div class="rank-sub">' + meta.filter(Boolean).map(esc).join(' · ') + '</div></div>' +
        '<div class="cal-reserve"><b>' + fmtHeat(it.reserve) + '</b><span>预约</span></div>' +
      '</div>';
    }).join('');

    list.innerHTML = head + filters + (shown.length ? rows : '<div class="empty">该筛选下暂无游戏</div>');
    list.querySelectorAll('.cal-chip').forEach(b => b.addEventListener('click', () => {
      const v = b.getAttribute('data-v');
      if (b.getAttribute('data-dim') === 'type') state.calType = v; else state.calSource = v;
      renderToday(list);
    }));
    list.querySelectorAll('.cal-row').forEach(el => el.addEventListener('click', () => {
      const it = shown.find(x => x.id === el.getAttribute('data-id'));
      if (it) openCalDetail(it);
    }));
  }

  function openCalDetail(it) {
    const cell = (k, v) => '<div class="rd-cell"><span>' + k + '</span><b>' + v + '</b></div>';
    const host = document.createElement('div');
    host.id = 'rd-host';
    host.innerHTML = '<div class="rank-detail-mask" id="rd-mask"></div>' +
      '<div class="rank-detail-panel" id="rd-panel">' +
      '<div class="rd-head"><img class="rd-icon" src="' + (it.icon || '') + '">' +
      '<div class="rd-info"><div class="rd-title">' + esc(it.title) + '</div>' +
      '<div class="rd-sub">' + esc(it.type) + (it.maker ? ' · TapTap制造' : '') + '</div></div>' +
      '<button class="rd-close" id="rd-close">×</button></div>' +
      '<div class="rd-grid">' +
        cell('类型', esc(it.type)) +
        cell('开始时间', it.dateOnly ? '今日' : fmtClock(it.startTime)) +
        cell('预约', fmtHeat(it.reserve)) +
        cell('粉丝', fmtHeat(it.fans)) +
        cell('评价', fmtHeat(it.reviews)) +
        cell('评分', Number(it.score) > 0 ? it.score : '—') +
      '</div>' +
      (it.devs.length ? '<div class="rd-dev">厂商：' + esc(it.devs.join(' / ')) + '</div>' : '') +
      '<div class="rd-tags">' + (it.tags || []).map(t => '<span class="rank-tag">' + esc(t) + '</span>').join('') + '</div>' +
      '</div>';
    document.body.appendChild(host);
    document.getElementById('rd-close').addEventListener('click', closeDetail);
    document.getElementById('rd-mask').addEventListener('click', closeDetail);
  }

  function render() {
    renderTags();
    $('updated').textContent = state.loadedAt ? ('更新于 ' + fmtTime(state.loadedAt) + ' · 每 20 分钟') : '尚未加载';
    const list = $('list');
    const b = state.board;

    if (b === 'today') { renderToday(list); return; }

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
      list.innerHTML = moversCard() + card('涨幅榜', up, true) + card('热度榜', top, false) +
        (up.length || top.length ? '' : '<div class="empty">暂无数据</div>');
      list.querySelectorAll('.rm-row').forEach(el => {
        el.addEventListener('click', () => openDetail(el.getAttribute('data-id'), '汇总'));
      });
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
    $('hint').textContent = (state.tag ? '筛选：' + state.tag + ' · ' : '') + (base ? ('涨幅基准 ' + fmtTime(base.ts)) : '已开始记录快照（每 20 分钟一次），攒够 1 小时就出涨幅');
    const rowKey = maker ? 'hot' : b;
    // 只给当前列表里涨得最猛的 5 个加深红标记，避免“人人都是红色”
    const hotIds = new Set(
      items.map(it => ({ id: it.id, p: momentum(rowKey, it).p1, hits: it.hits || 0 }))
        .filter(x => x.p != null && x.p > 0.5 && x.hits >= 5000)
        .sort((x, y) => y.p - x.p)
        .slice(0, 5)
        .map(x => x.id)
    );
    list.innerHTML = items.map((it, i) => rowHTML(it, rowKey, maker ? i + 1 : null, hotIds.has(it.id))).join('');
    list.querySelectorAll('.rank-row').forEach((el, idx) => { el.addEventListener('click', () => openDetail(items[idx].id, maker ? 'TapTap制造' : (BOARDS.find(x => x.key === b) || {}).label, rowKey)); });
  }

  async function load(force) {
    $('list').innerHTML = '<div class="empty">榜单加载中…</div>';
    try {
      const errors = [];
      const [results, cal] = await Promise.all([
        Promise.all(BOARDS.map(b => fetchBoard(b.key, b.total).catch(e => { errors.push(b.label + ': ' + (e.message || e)); return []; }))),
        fetchCalendar().catch(e => { state.calError = e.message || String(e); return null; })
      ]);
      if (cal) { state.cal = cal; state.calError = null; }
      BOARDS.forEach((b, i) => { state.data[b.key] = results[i] || []; });
      if (errors.length === BOARDS.length && !cal) {
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

  function detailHTML(it, boardLabel, key) {
    const m = momentum(key || 'hot', it);
    const pct = (v) => v == null ? '—' : ((v > 0 ? '+' : '') + v.toFixed(1) + '%');
    const rd = m.rankDelta == null ? '—' : (m.rankDelta > 0 ? '+' + m.rankDelta : String(m.rankDelta));
    const clsOf = (v) => v == null ? '' : (v > 0 ? 'up' : (v < 0 ? 'down' : ''));
    const spark = sparkSVG(m.series, m.p1 != null && m.p1 > 0);
    return '<div class="rank-detail-mask" id="rd-mask"></div>' +
      '<div class="rank-detail-panel" id="rd-panel">' +
      '<div class="rd-head"><img class="rd-icon" src="' + (it.icon || '') + '">' +
      '<div class="rd-info"><div class="rd-title">' + esc(it.title) + '</div>' +
      '<div class="rd-sub">' + (boardLabel || '') + (it.rank ? ' · 第 ' + it.rank + ' 名' : '') + '</div></div>' +
      '<button class="rd-close" id="rd-close">×</button></div>' +
      (spark ? '<div class="rd-spark">' + spark + '<span>' + (m.win1 ? '近' + winLabel(m.win1) : '最近') + '热度走势</span></div>' : '') +
      '<div class="rd-grid">' +
      '<div class="rd-cell"><span>热度</span><b>' + fmtHeat(it.hits) + '</b></div>' +
      '<div class="rd-cell"><span>' + (m.win1 ? winLabel(m.win1) : '1 小时') + '涨幅</span><b class="' + clsOf(m.p1) + '">' + pct(m.p1) + '</b></div>' +
      '<div class="rd-cell"><span>24 小时涨幅</span><b class="' + clsOf(m.p24) + '">' + pct(m.p24) + '</b></div>' +
      '<div class="rd-cell"><span>名次变化</span><b class="' + clsOf(m.rankDelta) + '">' + rd + '</b></div>' +
      '<div class="rd-cell"><span>评分</span><b>' + (Number(it.score) > 0 ? it.score : '—') + '</b></div>' +
      '<div class="rd-cell"><span>评价</span><b>' + fmtHeat(it.reviews || 0) + '</b></div>' +
      '<div class="rd-cell"><span>粉丝</span><b>' + fmtHeat(it.fans || 0) + '</b></div>' +
      '</div>' +
      '<div class="rd-tags">' + (it.tags || []).map(t => '<span class="rank-tag">' + esc(t) + '</span>').join('') + '</div>' +
      '</div>';
  }

  function openDetail(id, boardLabel, key) {
    let it = null;
    let foundKey = key || 'hot';
    for (const b of BOARDS) { const f = (state.data[b.key] || []).find(x => x.id === String(id)); if (f) { it = f; foundKey = b.key; if (!boardLabel) boardLabel = b.label; break; } }
    if (!it) for (const b of BOARDS) { const f = (state.data[b.key] || []).find(x => x.id === String(id)); if (f) it = f; }
    if (!it) return;
    const host = document.createElement('div');
    host.id = 'rd-host';
    host.innerHTML = detailHTML(it, boardLabel, foundKey);
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
        hits.push(Object.assign({}, it, { boardLabel: b.label, boardKey: b.key }));
      }
    }
    if (!hits.length) { $('list').innerHTML = '<div class="empty">三榜中未找到「' + esc(q) + '」</div>'; $('hint').textContent = ''; return; }
    $('hint').textContent = '找到 ' + hits.length + ' 个';
    const shown = hits.slice(0, 30);
    $('list').innerHTML = shown.map(h => {
      const m = momentum(h.boardKey, h);
      const p1 = m.p1;
      const cls = p1 == null ? 'flat' : (p1 > 0.05 ? 'up' : (p1 < -0.05 ? 'down' : 'flat'));
      const txt = p1 == null ? '记录中'
        : (winLabel(m.win1 || 3600000) + ' ' + (Math.abs(p1) < 0.05 ? '持平' : ((p1 > 0 ? '+' : '') + p1.toFixed(1) + '%')));
      return '<div class="rank-row' + (p1 != null && p1 >= 8 ? ' is-hot' : '') + '"><div class="rank-no">#' + h.rank + '</div>' +
        '<img class="rank-icon" src="' + (h.icon || '') + '" loading="lazy">' +
        '<div class="rank-main"><div class="rank-title">' + esc(h.title) + '</div><div class="rank-sub">' + esc(h.boardLabel) + ' · 评分 ' + (h.score || '—') + ' · 热度 ' + fmtHeat(h.hits) + '</div></div>' +
        '<div class="rank-heat"><div class="rank-heat-val">' + fmtHeat(h.hits) + '</div><div class="rank-heat-delta ' + cls + '">' + txt + '</div>' + sparkSVG(m.series, p1 != null && p1 > 0) + '</div></div>';
    }).join('');
    $('list').querySelectorAll('.rank-row').forEach((el, i) => {
      el.addEventListener('click', () => openDetail(shown[i].id, shown[i].boardLabel, shown[i].boardKey));
    });
  }

  /** 回到顶部 / 回到底部：滚动超过一屏才出现，避免挡住内容 */
  function bindScrollButtons() {
    const top = $('to-top'), bottom = $('to-bottom');
    if (!top || !bottom) return;
    let raf = 0;
    function update() {
      raf = 0;
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      top.classList.toggle('is-show', y > 320);
      bottom.classList.toggle('is-show', max - y > 320);
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // 列表内容变化（切换榜单/筛选/搜索）后页面高度会变，重新判断按钮显隐
    const list = $('list');
    if (list && window.MutationObserver) new MutationObserver(onScroll).observe(list, { childList: true, subtree: false });
    top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    bottom.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
    update();
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
    bindScrollButtons();
    load(false);
    setInterval(() => load(true), 20 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
