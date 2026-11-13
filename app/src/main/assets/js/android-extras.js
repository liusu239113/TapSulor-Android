/**
 * android-extras.js — 安卓端增量功能（不动压缩后的 main.js）
 *  1) 运营主体下方显示「已认证 · 信用等级 X」
 *  2) 设置里的「收益刮刮乐」开关（复用 scratch.js）
 *  3) 列表卡片上的「转化率」其实是 ARPU×100，改为正确的 ARPU 显示
 */
(function () {
  'use strict';

  const LEVEL = { 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' };

  // ---------- 信用等级 ----------
  async function loadBadges() {
    const el = document.getElementById('active-account-badges');
    if (!el || !window.electronAPI || !window.electronAPI.fetch) return;
    let devId = null;
    try {
      devId = await window.electronAPI.getActiveDeveloperId();
      if (typeof devId !== 'string') devId = await window.electronAPI.getDeveloperId();
    } catch (_) {}
    if (!devId) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="op-badge muted">信用等级加载中…</span>';
    try {
      const [c, i] = await Promise.all([
        window.electronAPI.fetch('https://developer.taptap.cn/api/developer/v1/credit-rating?developer_id=' + devId).catch(() => null),
        window.electronAPI.fetch('https://developer.taptap.cn/api/developer/v2/info?developer_id=' + devId).catch(() => null),
      ]);
      let level = null, verified = null;
      try {
        const j = JSON.parse(c && c.body);
        if (j && j.success && j.data) level = j.data.credit_level;
      } catch (_) {}
      try {
        const j = JSON.parse(i && i.body);
        if (j && j.success && j.data) {
          const ext = j.data.manufacturerExtendType || j.data.developerExtendType || '';
          verified = ext === 'DEVELOPER_EXTEND_TYPE_AUTHENTICATION';
        }
      } catch (_) {}
      const text = LEVEL[level] || '暂未评级';
      el.innerHTML =
        (verified === null ? '' : (verified ? '<span class="op-badge ok">已认证</span>' : '<span class="op-badge warn">未认证</span>')) +
        '<span class="op-badge credit">信用等级 ' + text + '</span>';
    } catch (_) {
      el.innerHTML = '<span class="op-badge muted">信用等级 —</span>';
    }
  }

  // 账号/工作室变化后刷新徽标
  function hookBadges() {
    loadBadges();
    try {
      window.electronAPI.onStudioSwitched && window.electronAPI.onStudioSwitched(() => loadBadges());
      window.electronAPI.onAccountUpdated && window.electronAPI.onAccountUpdated(() => loadBadges());
      window.electronAPI.onLoginSuccess && window.electronAPI.onLoginSuccess(() => loadBadges());
    } catch (_) {}
    // 兜底：主体名变化时再刷一次
    const nameEl = document.getElementById('active-account-name');
    if (nameEl) {
      let last = nameEl.textContent;
      setInterval(() => {
        if (nameEl.textContent !== last) { last = nameEl.textContent; loadBadges(); }
      }, 2000);
    }
  }

  // ---------- 刮刮乐开关 ----------
  function hookScratch() {
    const t = document.getElementById('scratch-toggle');
    if (!t || !window.ScratchMode) return;
    t.checked = window.ScratchMode.enabled();
    t.addEventListener('change', () => {
      window.ScratchMode.setEnabled(t.checked);
      if (window.ScratchMode.enabled()) setTimeout(() => window.ScratchMode.coverAll(), 100);
    });
  }

  // ---------- ARPU 修正：把「转化率 X%」还原为 ARPU ----------
  // 旧逻辑显示的是 revenue/dau*100（百分数），实际就是 ARPU×100，此处换算成金额。
  function fixArpuText() {
    document.querySelectorAll('.game-metric-sub').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt.startsWith('转化率')) return;
      const m = txt.match(/([0-9.]+)\s*%/);
      if (m) {
        const arpu = parseFloat(m[1]) / 100;
        el.textContent = 'ARPU ¥' + arpu.toFixed(4);
      } else {
        el.textContent = 'ARPU —';
      }
    });
  }

  function hookArpu() {
    fixArpuText();
    const list = document.getElementById('game-list');
    if (!list) return;
    const ob = new MutationObserver(() => fixArpuText());
    ob.observe(list, { childList: true, subtree: true, characterData: true });
  }

  function init() {
    hookBadges();
    hookScratch();
    hookArpu();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  else setTimeout(init, 300);
})();

// ==================== 一键提现（激励计划 AUTO_V1） ====================
(function () {
  'use strict';
  const API = 'https://developer.taptap.cn';
  const MIN_FEN = 10000; // 100 元
  let items = [], armed = false, armTimer = null, running = false;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toFixed(2);

  async function devId() {
    try {
      let d = await window.electronAPI.getActiveDeveloperId();
      if (!d) d = await window.electronAPI.getDeveloperId();
      return String(d || '');
    } catch (_) { return ''; }
  }
  async function getJson(url) {
    const r = await window.electronAPI.fetch(url);
    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
    return JSON.parse(r.body);
  }

  async function preview() {
    const d = await devId();
    if (!d) throw new Error('未登录');
    const list = await getJson(API + '/api/app/v1/list?developer_id=' + d + '&page=1&pagesize=100');
    const apps = ((list.data && list.data.list) || []).filter(a => a.review_status && a.review_status.value === 4);
    const out = [];
    for (const a of apps) {
      try {
        const j = await getJson(API + '/api/mini-app/v1/ad/withdraw-info?app_id=' + a.id + '&developer_id=' + d + '&settlement_scheme=AUTO_V1');
        const dd = j.data || {};
        const fen = Number(dd.withdrawable_cash_fen || 0);
        if (fen > 0) {
          out.push({
            appId: a.id, title: a.title, fen: fen,
            status: Number(dd.status), blocked: !!dd.withdrawal_blocked,
            eligible: fen >= MIN_FEN && Number(dd.status) === 1 && !dd.withdrawal_blocked
          });
        }
      } catch (_) {}
    }
    out.sort((x, y) => y.fen - x.fen);
    return { dev: d, items: out };
  }

  function renderPreview(res) {
    const list = $('withdraw-list');
    const summary = $('withdraw-summary');
    const btn = $('withdraw-confirm');
    items = res.items || [];
    const eligible = items.filter(i => i.eligible);
    const total = eligible.reduce((s, i) => s + i.fen, 0) / 100;
    if (!items.length) {
      summary.textContent = '当前厂商下没有可提现的激励计划现金（最低 100 元/笔）';
      list.innerHTML = '';
      btn.disabled = true;
      btn.textContent = '暂无可提现游戏';
      return;
    }
    summary.innerHTML = '可提现 <b>' + eligible.length + '</b> 个 · 合计 <b>¥' + fmt(total) + '</b>' +
      '<div style="margin-top:4px;font-size:12px;color:#8b98a8">激励计划 · 最低 100 元/笔</div>';
    list.innerHTML = items.map(i =>
      '<div class="withdraw-row' + (i.eligible ? '' : ' is-disabled') + '">' +
        '<span class="withdraw-row-title">' + String(i.title || i.appId).replace(/[<>&]/g, '') + '</span>' +
        '<span class="withdraw-row-balance">¥' + fmt(i.fen / 100) + '</span>' +
        '<span class="withdraw-row-state">' + (i.eligible ? '可提现' : '未满 100 元') + '</span>' +
      '</div>').join('');
    btn.disabled = eligible.length === 0;
    btn.textContent = eligible.length ? ('确认提现 ' + eligible.length + ' 个') : '暂无可提现游戏';
  }

  async function openModal() {
    const m = $('withdraw-modal');
    if (!m) return;
    m.hidden = false;
    $('withdraw-summary').textContent = '正在查询各游戏余额…';
    $('withdraw-list').innerHTML = '';
    $('withdraw-confirm').disabled = true;
    armed = false;
    try {
      renderPreview(await preview());
    } catch (e) {
      $('withdraw-summary').textContent = '查询失败：' + (e.message || e);
    }
  }

  async function execute() {
    const eligible = items.filter(i => i.eligible);
    if (!eligible.length || running) return;
    const total = eligible.reduce((s, i) => s + i.fen, 0) / 100;
    const btn = $('withdraw-confirm');
    const note = $('withdraw-note');
    if (!armed) {
      armed = true;
      btn.textContent = '再次点击确认 ¥' + fmt(total);
      note.textContent = '提交后不可撤销。10 秒内再次点击即发起提现。';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = false; btn.textContent = '确认提现 ' + eligible.length + ' 个'; note.textContent = '最低提现 100 元/笔；未满 100 元的游戏会自动跳过。'; }, 10000);
      return;
    }
    clearTimeout(armTimer); armed = false; running = true;
    btn.disabled = true; btn.textContent = '提现中…';
    note.textContent = '正在逐个提交，请勿退出…';
    const csrf = (window.electronAPI.csrfToken && window.electronAPI.csrfToken()) || '';
    const d = await devId();
    const results = [];
    for (const it of eligible) {
      try {
        // 签约检查
        const ck = await window.electronAPI.httpPost(API + '/api/mini-app/v1/ad/withdraw-contract/check?developer_id=' + d + '&app_id=' + it.appId, { 'X-DC-XSRF-TOKEN': csrf });
        let state = null;
        try { state = JSON.parse(ck.body).data.state; } catch (_) {}
        if (state && state !== 'SIGNED' && state !== 'NOT_REQUIRED') {
          results.push({ appId: it.appId, ok: false, msg: '未签约（' + state + '）', amount: it.fen / 100 });
          continue;
        }
        const url = API + '/api/mini-app/v1/ad/payout-report-confirm?app_id=' + it.appId +
          '&amount=' + it.fen + '&developer_id=' + d +
          '&idempotency_key=' + encodeURIComponent('ts' + Date.now() + Math.random().toString(36).slice(2, 8)) +
          '&settlement_scheme=AUTO_V1';
        const r = await window.electronAPI.httpPost(url, { 'X-DC-XSRF-TOKEN': csrf });
        let ok = false, msg = 'HTTP ' + (r && r.status);
        try { const j = JSON.parse(r.body); ok = !!j.success; if (!ok && j.data) msg = j.data.msg || msg; } catch (_) {}
        results.push({ appId: it.appId, ok: ok, msg: ok ? '已提交' : msg, amount: it.fen / 100 });
      } catch (e) {
        results.push({ appId: it.appId, ok: false, msg: e.message || '失败', amount: it.fen / 100 });
      }
      await new Promise(r => setTimeout(r, 600));
    }
    running = false;
    const okCount = results.filter(r => r.ok).length;
    $('withdraw-summary').innerHTML = '成功 <b>' + okCount + '</b> / ' + results.length + ' 笔';
    $('withdraw-list').innerHTML = results.map(r => {
      const it = items.find(i => String(i.appId) === String(r.appId)) || {};
      return '<div class="withdraw-row"><span class="withdraw-row-title">' + String(it.title || r.appId) + '</span>' +
        '<span class="withdraw-row-balance">¥' + fmt(r.amount) + '</span>' +
        '<span class="withdraw-row-state" style="color:' + (r.ok ? '#10b981' : '#ef4444') + '">' + r.msg + '</span></div>';
    }).join('');
    note.textContent = '提现结果以 TapTap 后台「激励计划」为准。';
    btn.disabled = false; btn.textContent = '完成';
  }

  function closeModal() {
    const m = $('withdraw-modal');
    if (m) m.hidden = true;
    armed = false;
  }

  function hook() {
    const b = $('withdraw-all-btn');
    if (b) { b.hidden = false; b.addEventListener('click', openModal); }
    const c = $('withdraw-close'), ca = $('withdraw-cancel'), ov = $('withdraw-overlay');
    if (c) c.addEventListener('click', closeModal);
    if (ca) ca.addEventListener('click', closeModal);
    if (ov) ov.addEventListener('click', closeModal);
    const cf = $('withdraw-confirm');
    if (cf) cf.addEventListener('click', execute);
    const rf = $('withdraw-refresh'), st = $('withdraw-status');
    if (rf) rf.addEventListener('click', openModal);
    if (st) st.addEventListener('click', openModal);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(hook, 600));
  else setTimeout(hook, 600);
})();

/* ==================== 备案提醒设置 ==================== */
(function () {
  function $(id) { return document.getElementById(id); }
  function init() {
    var box = $('filing-block');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    var email = $('filing-email'), code = $('filing-code'), send = $('filing-send-code');
    var enable = $('filing-enable'), test = $('filing-test'), disable = $('filing-disable');
    var statusEl = $('filing-status-text'), tip = $('filing-tip');
    function setTip(t) { if (tip) tip.textContent = t; }
    function state() { try { return window.electronAPI.filingState ? window.electronAPI.filingState() : {}; } catch (e) { return {}; } }
    function paint() {
      var st = state() || {};
      if (st.email && !email.value) email.value = st.email;
      if (st.enabled) {
        statusEl.textContent = '已开启 · ' + (st.email || '');
        statusEl.className = 'filing-status ok';
        test.hidden = false; disable.hidden = false; enable.textContent = '重新绑定';
      } else {
        statusEl.textContent = '未开启';
        statusEl.className = 'filing-status';
        test.hidden = true; disable.hidden = true; enable.textContent = '开启提醒';
      }
    }
    if (!window.electronAPI || !window.electronAPI.filingRegister) {
      statusEl.textContent = '当前版本不支持';
      return;
    }
    send.addEventListener('click', async function () {
      var e = (email.value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setTip('请先填写正确的收件邮箱'); return; }
      send.disabled = true; setTip('正在发送验证码…');
      try {
        var r = await window.electronAPI.filingSendCode(e);
        if (r && r.ok) { setTip('验证码已发送到 ' + e + '，请查收邮箱（10 分钟内有效）'); code.focus(); }
        else setTip('发送失败：' + ((r && r.error) || '请稍后再试'));
      } catch (err) { setTip('发送失败：' + err); }
      send.disabled = false;
    });
    enable.addEventListener('click', async function () {
      var e = (email.value || '').trim(), c = (code.value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setTip('请先填写正确的收件邮箱'); return; }
      if (!/^\d{6}$/.test(c)) { setTip('请填写 6 位验证码'); return; }
      enable.disabled = true; setTip('正在绑定当前账号…');
      try {
        var r = await window.electronAPI.filingRegister(e, c);
        if (r && r.ok) { setTip('已开启，正在监控 ' + (r.apps || 0) + ' 个游戏'); paint(); }
        else setTip('绑定失败：' + ((r && r.error) || '请检查验证码'));
      } catch (err) { setTip('绑定失败：' + err); }
      enable.disabled = false;
    });
    test.addEventListener('click', async function () {
      setTip('正在发送测试邮件…');
      try { var r = await window.electronAPI.filingTestMail(); setTip(r && r.ok ? '测试邮件已发送，请查收' : '发送失败'); } catch (e) { setTip('发送失败'); }
    });
    disable.addEventListener('click', async function () {
      try { await window.electronAPI.filingDisable(); setTip('已关闭备案提醒'); paint(); } catch (e) {}
    });
    paint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
  else setTimeout(init, 800);
})();


/* ==================== 首页卡片：备案状态徽标 ==================== */
(function () {
  var LABELS = {
    PENDING: { t: '备案审核中', c: 'credit' },
    PASSED: { t: '备案已通过', c: 'ok' },
    REJECTED: { t: '备案已驳回', c: 'warn' }
  };
  var timer = null, devCache = null;
  async function dev() {
    if (devCache) return devCache;
    try {
      devCache = await window.electronAPI.getActiveDeveloperId();
      if (!devCache) devCache = await window.electronAPI.getDeveloperId();
    } catch (e) {}
    return devCache;
  }
  async function one(card) {
    var appId = card.getAttribute('data-app-id');
    if (!appId) return;
    var sub = card.querySelector('.game-sub');
    if (!sub) return;
    var pill = sub.querySelector('.game-total-pill');
    if (!pill) return;
    var b = card.querySelector('.filing-inline');
    if (!b) {
      b = document.createElement('span');
      b.className = 'filing-inline op-badge muted';
      b.textContent = '备案…';
      pill.insertAdjacentElement('afterend', b);
    }
    var d = await dev();
    if (!d) { b.textContent = '备案 —'; b.className = 'filing-inline op-badge muted'; return; }
    try {
      var r = await window.electronAPI.fetch(
        'https://developer.taptap.cn/api/mini-app/v2/filing/info?app_id=' + encodeURIComponent(appId) +
        '&developer_id=' + encodeURIComponent(d));
      if (!r || !r.ok) throw new Error('HTTP');
      var j = JSON.parse(r.body);
      var raw = j && j.data ? (j.data.status != null ? j.data.status : j.data.filing_status) : null;
      var num = Number(raw);
      var st = num === 1 ? 'PENDING' : (num === 2 ? 'PASSED' : (num === 3 ? 'REJECTED' : ''));
      var m = LABELS[st] || { t: '未备案', c: 'muted' };
      b.textContent = m.t;
      b.className = 'filing-inline op-badge ' + m.c;
      b.title = '小游戏备案状态：' + (st || 'NOT_SUBMITTED');
    } catch (e) {
      b.textContent = '状态未知';
      b.className = 'filing-inline op-badge muted';
    }
  }
  var busy = false;
  async function scan() {
    if (busy) return;
    busy = true;
    try {
      var cards = [...document.querySelectorAll('.game-card[data-app-id]')];
      for (var i = 0; i < cards.length; i++) {
        try {
          await Promise.race([one(cards[i]), new Promise(function (r) { setTimeout(r, 8000); })]);
        } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 120); });
      }
    } finally { busy = false; }
  }
  function start() { scan(); if (timer) clearInterval(timer); timer = setInterval(scan, 20000); }
  var list = document.getElementById('game-list');
  if (list) new MutationObserver(function () { setTimeout(scan, 400); }).observe(list, { childList: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 1500));
  else setTimeout(start, 1500);
})();
