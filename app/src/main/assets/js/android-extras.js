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
