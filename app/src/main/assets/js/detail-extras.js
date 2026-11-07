/**
 * detail-extras.js — 安卓详情页增量：REP 收益面板
 * 复用桥接：electronAPI.repToken(developerId) 取令牌 → httpGet 带鉴权头请求 REP 收益
 */
(function () {
  'use strict';

  const REP_URL = 'https://tap-op.tapapis.cn/rep/be/v1/dashboard/revenue';
  let repData = null, repLoading = false, repError = null, repDev = null;

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
      btn.innerHTML = '<span>REP</span>';
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
      const token = await window.electronAPI.repToken(d);
      if (!token) throw new Error('REP 登录态获取失败，请在 REP 后台确认一次授权');
      const res = await window.electronAPI.httpGet(REP_URL, {
        Authorization: token,
        'x-app-id': String(appId),
        'x-developer-id': String(d),
        Referer: 'https://rep.taptap.cn/'
      });
      if (!res || !res.ok) {
        let msg = 'REP 接口请求失败' + (res && res.status ? ' (' + res.status + ')' : '');
        if (res && res.body && res.body.indexOf('非法厂商Id') >= 0) msg = '当前账号没有这个游戏的 REP 数据';
        throw new Error(msg);
      }
      repData = JSON.parse(res.body);
      render(repData);
    } catch (e) {
      repError = 'REP 收益获取失败：' + (e && e.message ? e.message : e);
      card.innerHTML = '<div class="rep-empty">' + repError + '<button class="rep-refresh" id="rep-refresh">重试</button></div>';
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
