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
  var CD_KEY = 'filing_code_cooldown_until';
  var timer = null;
  function init() {
    var box = $('filing-block');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    var email = $('filing-email'), code = $('filing-code'), send = $('filing-send-code');
    var bind = $('filing-bind'), test = $('filing-test'), toggle = $('filing-toggle');
    var statusEl = $('filing-status-text'), msg = $('filing-msg');
    var st = { enabled: false, email: '', hasToken: false };

    function say(t, kind) {
      if (!msg) return;
      msg.textContent = t || '';
      msg.className = 'filing-msg' + (kind ? ' ' + kind : '');
    }
    function readState() { try { st = (window.electronAPI.filingState && window.electronAPI.filingState()) || {}; } catch (e) { st = {}; } }
    function paint() {
      readState();
      if (st.email && !email.value) email.value = st.email;
      if (st.hasToken) {
        statusEl.textContent = '已绑定 · ' + (st.email || '');
        statusEl.className = 'filing-status ok';
        toggle.disabled = false;
        toggle.checked = !!st.enabled;
        test.hidden = false;
        bind.textContent = '重新绑定';
      } else {
        statusEl.textContent = '未绑定';
        statusEl.className = 'filing-status';
        toggle.disabled = true;
        toggle.checked = false;
        test.hidden = true;
        bind.textContent = '验证并绑定';
      }
    }
    function runCountdown(until) {
      clearInterval(timer);
      function tick() {
        var left = Math.ceil((until - Date.now()) / 1000);
        if (left > 0) {
          send.disabled = true;
          send.textContent = left + ' 秒后重发';
        } else {
          clearInterval(timer); timer = null;
          send.disabled = false;
          send.textContent = '发送验证码';
          try { localStorage.removeItem(CD_KEY); } catch (e) {}
        }
      }
      tick();
      timer = setInterval(tick, 1000);
    }
    function startCooldown(sec) {
      var until = Date.now() + sec * 1000;
      try { localStorage.setItem(CD_KEY, String(until)); } catch (e) {}
      runCountdown(until);
    }
    function resumeCooldown() {
      try {
        var until = Number(localStorage.getItem(CD_KEY) || 0);
        if (until > Date.now()) runCountdown(until);
      } catch (e) {}
    }

    if (!window.electronAPI || !window.electronAPI.filingRegister) { statusEl.textContent = '当前版本不支持'; return; }

    send.addEventListener('click', async function () {
      if (send.disabled) return;
      var e = (email.value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { say('请先填写正确的收件邮箱', 'err'); email.focus(); return; }
      send.disabled = true;
      send.textContent = '发送中…';
      say('正在发送验证码…');
      try {
        var r = await window.electronAPI.filingSendCode(e);
        if (r && r.ok) {
          say('验证码已发送到 ' + e + '，10 分钟内有效；没收到请检查垃圾邮件。', 'ok');
          code.focus();
          startCooldown(60);
        } else {
          var m = (r && r.error) || '请稍后再试';
          say('发送失败：' + m, 'err');
          if (/频繁|稍后|60/.test(m)) startCooldown(60);
          else { send.disabled = false; send.textContent = '发送验证码'; }
        }
      } catch (err) {
        say('发送失败：' + err, 'err');
        send.disabled = false;
        send.textContent = '发送验证码';
      }
    });

    bind.addEventListener('click', async function () {
      var e = (email.value || '').trim(), c = (code.value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { say('请先填写正确的收件邮箱', 'err'); return; }
      if (!/^\d{6}$/.test(c)) { say('请填写 6 位验证码', 'err'); return; }
      bind.disabled = true;
      bind.textContent = '验证中…';
      say('正在验证并绑定…');
      try {
        var r = await window.electronAPI.filingRegister(e, c);
        if (r && r.ok) {
          say('绑定成功，已开始监控 ' + (r.apps || 0) + ' 个游戏', 'ok');
          code.value = '';
        } else {
          say('绑定失败：' + ((r && r.error) || '请检查验证码'), 'err');
        }
      } catch (err) { say('绑定失败：' + err, 'err'); }
      bind.disabled = false;
      paint();
    });

    toggle.addEventListener('change', async function () {
      var on = toggle.checked;
      toggle.disabled = true;
      say(on ? '正在开启备案提醒…' : '正在关闭备案提醒…');
      try {
        if (on) await window.electronAPI.filingEnable(); else await window.electronAPI.filingDisable();
        say(on ? '备案提醒已开启' : '备案提醒已关闭（绑定保留）', 'ok');
      } catch (e) { toggle.checked = !on; say('操作失败，请重试', 'err'); }
      toggle.disabled = false;
      paint();
    });

    test.addEventListener('click', async function () {
      if (test.disabled) return;
      test.disabled = true;
      say('正在发送测试邮件…');
      try {
        var r = await window.electronAPI.filingTestMail();
        if (r && r.ok) say('测试邮件已发送，请查收', 'ok');
        else say('发送失败：' + ((r && r.error) || '请稍后再试'), 'err');
      } catch (e) { say('发送失败', 'err'); }
      test.disabled = false;
    });

    paint();
    resumeCooldown();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
  else setTimeout(init, 800);
})();

/* ---------- 首页游戏卡片：备案/广告状态（累计广告收益右侧） ---------- */
(function () {
  'use strict';
  if (!window.electronAPI || !window.electronAPI.fetch) return;
  var CACHE = new Map();
  var TTL = 10 * 60 * 1000;
  var queue = [], busy = false, scanTimer = null;
  var API = 'https://developer.taptap.cn';
  var LABELS = {
    AD: { label: '广告已开通', cls: 'ok' },
    PENDING: { label: '备案审核中', cls: 'credit' },
    PASSED: { label: '备案已通过', cls: 'ok' },
    REJECTED: { label: '备案已驳回', cls: 'warn' },
    NONE: { label: '未备案', cls: 'muted' }
  };

  function parse(r) {
    if (!r) return null;
    if (typeof r.body === 'string') { try { return JSON.parse(r.body); } catch (e) { return null; } }
    if (r.body && typeof r.body === 'object') return r.body;
    if (r.data || r.success !== undefined) return r;
    return null;
  }

  async function devId() {
    try {
      var d = window.electronAPI.getActiveDeveloperId
        ? await window.electronAPI.getActiveDeveloperId()
        : await window.electronAPI.getDeveloperId();
      return d ? String(d) : '';
    } catch (e) { return ''; }
  }

  async function lookup(appId, dev) {
    var key = dev + ':' + appId;
    var hit = CACHE.get(key);
    if (hit && Date.now() - hit.ts < TTL) return hit;
    var q = '?app_id=' + encodeURIComponent(appId) + '&developer_id=' + encodeURIComponent(dev);
    var ad = parse(await window.electronAPI.fetch(API + '/api/mini-app/v1/ad/info' + q).catch(function () { return null; }));
    var result = null;
    if (ad && ad.data && (ad.data.is_enabled === true || ad.data.is_enabled === 1 || ad.data.isEnabled === true)) {
      result = LABELS.AD;
    } else if (ad) {
      var fil = parse(await window.electronAPI.fetch(API + '/api/mini-app/v2/filing/info' + q).catch(function () { return null; }));
      var d = fil && fil.data ? fil.data : null;
      var st = d ? Number(d.status != null ? d.status : d.filing_status) : NaN;
      if (st === 2) result = LABELS.PASSED;
      else if (st === 1) result = LABELS.PENDING;
      else if (st === 3) result = LABELS.REJECTED;
      else if (d) result = LABELS.NONE;
    }
    if (!result) return null;
    var rec = { label: result.label, cls: result.cls, ts: Date.now() };
    CACHE.set(key, rec);
    return rec;
  }

  function paint(card, res) {
    var sub = card.querySelector('.game-sub');
    if (!sub) return;
    var el = sub.querySelector('.filing-inline');
    if (!el) {
      el = document.createElement('span');
      sub.appendChild(el);
    }
    el.className = 'op-badge filing-inline ' + res.cls;
    el.textContent = res.label;
  }

  function pump() {
    if (busy) return;
    var job = queue.shift();
    if (!job) return;
    busy = true;
    lookup(job.id, job.dev).then(function (res) {
      if (res && job.card.isConnected) paint(job.card, res);
    }).catch(function () {}).then(function () {
      busy = false;
      setTimeout(pump, 160);
    });
  }

  function scan() {
    var list = document.getElementById('game-list');
    if (!list) return;
    var cards = list.querySelectorAll('.game-card[data-app-id]');
    if (!cards.length) return;
    devId().then(function (dev) {
      if (!dev) return;
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var id = card.getAttribute('data-app-id');
        if (!id) continue;
        var tag = dev + ':' + id;
        if (card.__filingTag === tag) continue;
        card.__filingTag = tag;
        queue.push({ card: card, id: id, dev: dev });
      }
      pump();
    });
  }

  function schedule() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }

  function reset() {
    CACHE.clear();
    queue.length = 0;
    var cards = document.querySelectorAll('#game-list .game-card[data-app-id]');
    for (var i = 0; i < cards.length; i++) delete cards[i].__filingTag;
    schedule();
  }

  var list = document.getElementById('game-list');
  if (list) new MutationObserver(schedule).observe(list, { childList: true, subtree: true });
  try {
    window.electronAPI.onStudioSwitched && window.electronAPI.onStudioSwitched(reset);
    window.electronAPI.onAccountUpdated && window.electronAPI.onAccountUpdated(reset);
    window.electronAPI.onLoginSuccess && window.electronAPI.onLoginSuccess(reset);
    window.electronAPI.onAppResume && window.electronAPI.onAppResume(reset);
  } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (!document.hidden) reset(); });
  setInterval(function () { if (!document.hidden) { reset(); } }, 5 * 60 * 1000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})();
