/**
 * detail-extras.js — 安卓详情页增量：REP 收益面板
 * 复用桥接：electronAPI.repToken(developerId) 取令牌 → httpGet 带鉴权头请求 REP 收益
 */
(function () {
  'use strict';

  const REP_URL = 'https://tap-op.tapapis.cn/rep/be/v1/dashboard/revenue';
  let repData = null, repLoading = false, repError = null, repDev = null;

  // 从可见授权页返回后自动重试
  window.__onRepAuth = function () {
    repError = null;
    repData = null;
    loadRep();
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function currentAppId() {
    try {
      const p = new URLSearchParams(location.search);
      const q = p.get('app_id');
      if (q) return q;
    } catch (_) {}
    try {
      const g = JSON.parse(sessionStorage.getItem('currentGame') || 'null');
      if (g && g.appId) return String(g.appId);
    } catch (_) {}
    return null;
  }

  async function devId() {
    if (repDev) return repDev;
    try {
      repDev = await window.electronAPI.getActiveDeveloperId();
      if (typeof repDev !== 'string' || !repDev) repDev = await window.electronAPI.getDeveloperId();
    } catch (_) {}
    return repDev;
  }

  function ensureSwitchButton() {
    const sw = $('view-switch');
    if (!sw) return null;
    let btn = sw.querySelector('.vs-btn[data-view="rep"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'vs-btn';
      btn.setAttribute('data-view', 'rep');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><circle cx="17" cy="14.6" r="1.3"/></svg><span>REP</span>';
      sw.appendChild(btn);
    }
    return { sw, btn };
  }

  function ensureRepCard() {
    let card = $('rep-card');
    if (card) return card;
    const header = document.querySelector('.cal-header');
    if (!header) return null;
    card = document.createElement('div');
    card.className = 'rep-card';
    card.id = 'rep-card';
    card.hidden = true;
    header.parentNode.insertBefore(card, header);
    return card;
  }

  function setActive(sw, view) {
    sw.querySelectorAll('.vs-btn').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-view') === view));
    // 三段式：同步容器状态，让高亮滑块按 1/3 宽度定位
    sw.classList.toggle('is-trend', view === 'trend');
    sw.classList.toggle('is-rep', view === 'rep');
  }

  function showRep() {
    const card = ensureRepCard();
    const trend = $('trend-card');
    const calHeader = document.querySelector('.cal-header');
    const grid = $('daily-grid');
    if (trend) trend.hidden = true;
    if (calHeader) calHeader.style.display = 'none';
    if (grid) grid.style.display = 'none';
    if (card) card.hidden = false;
    loadRep();
  }

  function hideRep() {
    const card = $('rep-card');
    if (card) card.hidden = true;
  }

  function render(rev) {
    const card = ensureRepCard();
    if (!card) return;
    const y = (fen) => {
      if (fen == null) return '—';
      const v = Number(fen) / 100;
      if (!isFinite(v)) return '—';
      return (v < 0 ? '-¥' : '¥') + fmt(Math.abs(v));
    };
    const cls = (fen) => { const v = Number(fen); if (!isFinite(v) || v === 0) return ''; return v > 0 ? ' rep-pos' : ' rep-neg'; };
    card.innerHTML =
      '<div class="rep-title">REP 平台收益<span class="rep-unit">单位已换算为元</span>' +
        '<button class="rep-refresh" id="rep-refresh">刷新</button></div>' +
      '<div class="rep-grid">' +
        '<div class="rep-tile rep-main"><div class="rep-label">本月收益</div><div class="rep-value">' + y(rev.current_month_revenue) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">今日收益</div><div class="rep-value">' + y(rev.today_revenue) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">昨日收益</div><div class="rep-value">' + y(rev.yesterday_revenue) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">通用钱包余额</div><div class="rep-value">' + y(rev.default_wallet_balance) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">分平台钱包余额</div><div class="rep-value' + cls(rev.platform_wallet_balance) + '">' + y(rev.platform_wallet_balance) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">iOS 钱包余额</div><div class="rep-value' + cls(rev.ios_wallet_balance) + '">' + y(rev.ios_wallet_balance) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">Android 钱包余额</div><div class="rep-value' + cls(rev.android_wallet_balance) + '">' + y(rev.android_wallet_balance) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">昨日消耗</div><div class="rep-value">' + y(rev.yesterday_expense) + '</div></div>' +
        '<div class="rep-tile"><div class="rep-label">昨日 REP 转化</div><div class="rep-value">' + (rev.yesterday_transformation == null ? '—' : String(rev.yesterday_transformation)) + '</div></div>' +
      '</div>' +
      '<div class="rep-note">数据来自 REP 资源置换平台，与广告收益独立</div>';
    const btn = card.querySelector('#rep-refresh');
    if (btn) btn.addEventListener('click', () => { repData = null; repError = null; loadRep(); });
  }

  async function loadRep() {
    const card = ensureRepCard();
    if (!card) return;
    if (repData) { render(repData); return; }
    if (repLoading) return;
    if (repError) {
      card.innerHTML = '<div class="rep-empty">' + repError + '<button class="rep-refresh" id="rep-refresh">重试</button></div>';
      const b = card.querySelector('#rep-refresh');
      if (b) b.addEventListener('click', () => { repError = null; loadRep(); });
      return;
    }
    if (!window.electronAPI || !window.electronAPI.repToken) {
      card.innerHTML = '<div class="rep-empty">当前版本不支持 REP 数据</div>';
      return;
    }
    repLoading = true;
    card.innerHTML = '<div class="rep-empty">REP 收益同步中…</div>';
    try {
      const d = await devId();
      const appId = currentAppId();
      if (!d || !appId) throw new Error('缺少厂商或游戏 ID');
      // 先在后台 WebView 取 REP 令牌，再用 OkHttp 带鉴权头请求（接口已验证可用）
      // 加超时兜底：原生若卡住，不能让面板永远停在“同步中”
      const token = await Promise.race([
        window.electronAPI.repToken(d),
        new Promise((_, reject) => setTimeout(() => reject(new Error('REP 登录态获取超时，请重试')), 26000))
      ]);
      if (token === 'LOGIN_REQUIRED') throw new Error('当前账号的 TapTap 登录态已失效，请重新登录 App');
      if (!token) throw new Error('REP 登录态获取失败（未取到 op-jwt-token）');
      const res = await Promise.race([
        window.electronAPI.httpGet(REP_URL, {
          Authorization: token,
          'x-app-id': String(appId),
          'x-developer-id': String(d),
          Referer: 'https://rep.taptap.cn/'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('REP 接口请求超时，请重试')), 16000))
      ]);
      if (!res || !res.ok) {
        let msg = 'REP 接口请求失败' + (res && res.status ? ' (' + res.status + ')' : '');
        if (res && res.body && res.body.indexOf('非法厂商Id') >= 0) msg = '当前账号没有这个游戏的 REP 数据';
        throw new Error(msg);
      }
      repData = JSON.parse(res.body);
      render(repData);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      repError = 'REP 收益获取失败：' + msg;
      // 首次使用需要账号在 rep.taptap.cn 确认授权，给一个可见入口
      const needAuth = msg.indexOf('op-jwt-token') >= 0 || msg.indexOf('登录态已失效') >= 0;
      card.innerHTML = '<div class="rep-empty">' + repError +
        (needAuth ? '<button class="rep-refresh" id="rep-auth">去授权</button>' : '') +
        '<button class="rep-refresh" id="rep-refresh">重试</button></div>';
      const authBtn = card.querySelector('#rep-auth');
      if (authBtn) authBtn.addEventListener('click', async () => {
        try {
          const d2 = await devId();
          if (window.electronAPI && window.electronAPI.openRepAuth) {
            window.electronAPI.openRepAuth(d2);
          } else {
            throw new Error('当前版本不支持 REP 授权页');
          }
        } catch (err) {
          repError = 'REP 授权页打开失败：' + (err && err.message ? err.message : err);
          card.innerHTML = '<div class="rep-empty">' + repError + '</div>';
        }
      });
      const b = card.querySelector('#rep-refresh');
      if (b) b.addEventListener('click', () => { repError = null; loadRep(); });
    } finally {
      repLoading = false;
    }
  }

  function bind() {
    const t = ensureSwitchButton();
    if (!t) return;
    t.sw.addEventListener('click', (e) => {
      const btn = e.target.closest('.vs-btn');
      if (!btn) return;
      const view = btn.getAttribute('data-view');
      if (view === 'rep') { setActive(t.sw, 'rep'); showRep(); return; }
      hideRep();
      // 交回原有逻辑：恢复日历/趋势显示
      const trend = $('trend-card');
      const calHeader = document.querySelector('.cal-header');
      const grid = $('daily-grid');
      if (view === 'trend') {
        setActive(t.sw, 'trend');
        if (trend) trend.hidden = false;
        if (calHeader) calHeader.style.display = 'none';
        if (grid) grid.style.display = 'none';
      } else {
        setActive(t.sw, 'calendar');
        if (trend) trend.hidden = true;
        if (calHeader) calHeader.style.display = '';
        if (grid) grid.style.display = '';
      }
    });
  }

  function waitSwitch() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (ensureSwitchButton()) { clearInterval(timer); bind(); }
      else if (tries > 40) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitSwitch);
  else waitSwitch();
})();

/* ==================== 趋势数值明细（收入/日活/ARPU/环比） ==================== */
(function () {
  'use strict';
  var API = 'https://developer.taptap.cn/api';
  var built = false;

  function appId() {
    try { var q = new URLSearchParams(location.search).get('app_id'); if (q) return q; } catch (e) {}
    try { var g = JSON.parse(sessionStorage.getItem('currentGame') || 'null'); if (g && g.appId) return String(g.appId); } catch (e) {}
    return null;
  }
  async function devId() {
    try {
      var d = await window.electronAPI.getActiveDeveloperId();
      if (!d) d = await window.electronAPI.getDeveloperId();
      return String(d || '');
    } catch (e) { return ''; }
  }
  async function getJson(url) {
    var r = await window.electronAPI.fetch(url);
    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
    return JSON.parse(r.body);
  }

  function monthRange() {
    var d = new Date();
    var y = d.getFullYear(), m = d.getMonth() + 1;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var start = y + '-' + pad(m) + '-01';
    var end = y + '-' + pad(m) + '-' + pad(d.getDate());
    return { start: start, end: end };
  }

  function card() {
    var el = document.getElementById('trend-detail-card');
    if (el) return el;
    var trend = document.getElementById('trend-card');
    if (!trend) return null;
    el = document.createElement('div');
    el.id = 'trend-detail-card';
    el.className = 'trend-detail-card';
    el.hidden = true;
    trend.parentNode.insertBefore(el, trend.nextSibling);
    return el;
  }

  function render(rows) {
    var el = card();
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="rep-empty">暂无每日数据</div>'; return; }
    var html = '<div class="tdc-title">每日数值明细</div><div class="tdc-table">' +
      '<div class="tdc-row tdc-head"><span>日期</span><span>收入</span><span>日活</span><span>ARPU</span><span>环比</span></div>';
    rows.forEach(function (r, i) {
      var prev = rows[i - 1];
      var mom = (prev && prev.rev > 0) ? ((r.rev - prev.rev) / prev.rev * 100) : null;
      var momTxt = mom == null ? '—' : ((mom > 0 ? '+' : '') + mom.toFixed(1) + '%');
      var momCls = mom == null ? '' : (mom > 0 ? 'up' : (mom < 0 ? 'down' : ''));
      html += '<div class="tdc-row">' +
        '<span>' + r.date.slice(5) + '</span>' +
        '<span>¥' + r.rev.toFixed(2) + '</span>' +
        '<span>' + (r.dau == null ? '—' : r.dau) + '</span>' +
        '<span>' + (r.dau ? '¥' + (r.rev / r.dau).toFixed(4) : '—') + '</span>' +
        '<span class="' + momCls + '">' + momTxt + '</span>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  async function load() {
    var el = card();
    if (!el) return;
    var app = appId(), dev = await devId();
    if (!app || !dev) return;
    var rg = monthRange();
    el.hidden = false;
    el.innerHTML = '<div class="rep-empty">数值明细加载中…</div>';
    try {
      var revUrl = API + '/mini-app/v1/ad/payout-report-data?developer_id=' + dev + '&app_id=' + app +
        '&start_time=' + rg.start + '&end_time=' + rg.end;
      var dauUrl = API + '/mini-app/v1/stats-by-day/device?developer_id=' + dev + '&app_id=' + app +
        '&start_date=' + rg.start + '&end_date=' + rg.end;
      var both = await Promise.all([getJson(revUrl).catch(function () { return null; }), getJson(dauUrl).catch(function () { return null; })]);
      var revList = (both[0] && both[0].data && both[0].data.list) || [];
      var dauList = (both[1] && both[1].data && both[1].data.list) || [];
      var dauMap = {};
      dauList.forEach(function (d) { dauMap[d.date] = d.active_device_num; });
      var rows = revList.map(function (r) {
        return { date: r.date, rev: Number(r.revenue) || 0, dau: dauMap[r.date] == null ? null : dauMap[r.date] };
      });
      render(rows);
    } catch (e) {
      el.innerHTML = '<div class="rep-empty">数值明细加载失败：' + (e.message || e) + '</div>';
    }
  }

  function bind() {
    var sw = document.getElementById('view-switch');
    if (sw && !built) {
      built = true;
      sw.addEventListener('click', function (e) {
        var btn = e.target.closest('.vs-btn');
        if (!btn) return;
        var v = btn.getAttribute('data-view');
        var el = card();
        if (!el) return;
        if (v === 'trend') { el.hidden = false; if (!el.dataset.loaded) { el.dataset.loaded = '1'; load(); } }
        else if (v === 'rep') { el.hidden = true; }
        else { el.hidden = true; }
      });
    }
  }
  function wait() {
    var n = 0;
    var t = setInterval(function () {
      n++;
      if (document.getElementById('view-switch')) { clearInterval(t); bind(); }
      else if (n > 40) clearInterval(t);
    }, 500);
  }

  // ==================== 备案状态徽标（累计收益右侧） ====================
  (function () {
    var LABELS = {
      PENDING: { t: '备案审核中', c: 'credit' },
      PASSED: { t: '备案已通过', c: 'ok' },
      REJECTED: { t: '备案已驳回', c: 'warn' }
    };
    var timer = null;
    // 本文件有两个 IIFE，这里自带辅助函数，避免作用域问题
    function filingAppId() {
      try { var q = new URLSearchParams(location.search).get('app_id'); if (q) return q; } catch (e) {}
      try { var g = JSON.parse(sessionStorage.getItem('currentGame') || 'null'); if (g && g.appId) return String(g.appId); } catch (e) {}
      return null;
    }
    async function filingDev() {
      try {
        var d = await window.electronAPI.getActiveDeveloperId();
        if (typeof d === 'string' && d) return d;
      } catch (e) {}
      try { return await window.electronAPI.getDeveloperId(); } catch (e) { return null; }
    }
    async function filingJson(url) {
      var r = await window.electronAPI.fetch(url);
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      return JSON.parse(r.body);
    }
    function ensureBadge() {
      var tile = document.getElementById('detail-grand-mini');
      if (!tile) return null;
      var b = document.getElementById('filing-badge');
      if (!b) {
        b = document.createElement('span');
        b.id = 'filing-badge';
        b.className = 'op-badge muted';
        b.textContent = '备案…';
        tile.parentNode.insertBefore(b, tile.nextSibling);
      }
      return b;
    }
    async function refreshFiling() {
      var b = ensureBadge();
      if (!b) return;
      var app = filingAppId();
      var d = await filingDev();
      if (!app || !d) { b.textContent = '备案 —'; b.className = 'op-badge muted'; return; }
      try {
        var j = await filingJson('https://developer.taptap.cn/api/mini-app/v1/ad/info?app_id=' +
          encodeURIComponent(app) + '&developer_id=' + encodeURIComponent(d));
        var st = (j && j.data && j.data.game_filing_status) || '';
        var m = LABELS[st] || { t: '未备案', c: 'muted' };
        b.textContent = m.t;
        b.className = 'op-badge ' + m.c;
        b.title = '小游戏备案状态：' + (st || 'NOT_SUBMITTED');
      } catch (e) {
        b.textContent = '状态未知';
        b.className = 'op-badge muted';
      }
    }
    function start() { stop(); refreshFiling(); timer = setInterval(refreshFiling, 20000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    var n = 0;
    var iv = setInterval(function () {
      if (ensureBadge()) { clearInterval(iv); start(); }
      else if (n++ > 40) clearInterval(iv);
    }, 500);
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wait);
  else wait();
})();
