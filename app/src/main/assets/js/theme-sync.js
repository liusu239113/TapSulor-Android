/**
 * theme-sync.js — 全局主题同步
 *
 * 设置里改的「显示模式（浅色/深色）/ 强调色 / 字体」必须作用于 App 内所有页面。
 * 做法：每个页面都引入本脚本，读取 localStorage 里的主题键并写入 <html> 的
 * data-theme / data-accent / data-font；同时监听 storage、pageshow、页面可见性，
 * 并用 1.5s 轮询兜底（Android 不同 WebView 之间 storage 事件可能不触发）。
 */
(function () {
  'use strict';

  var KEY_MODE = 'taptap_theme_mode';
  var KEY_ACCENT = 'taptap_theme_accent';
  var KEY_FONT = 'taptap_font_family';

  function read() {
    try {
      return {
        mode: localStorage.getItem(KEY_MODE) || 'light',
        accent: localStorage.getItem(KEY_ACCENT) || 'cyan',
        font: localStorage.getItem(KEY_FONT) || 'default'
      };
    } catch (e) {
      return { mode: 'light', accent: 'cyan', font: 'default' };
    }
  }

  function apply() {
    var t = read();
    var d = document.documentElement;
    if (d.getAttribute('data-theme') !== t.mode) d.setAttribute('data-theme', t.mode);
    if (d.getAttribute('data-accent') !== t.accent) d.setAttribute('data-accent', t.accent);
    if (t.font && t.font !== 'default') {
      if (d.getAttribute('data-font') !== t.font) d.setAttribute('data-font', t.font);
    } else if (d.hasAttribute('data-font')) {
      d.removeAttribute('data-font');
    }
    // 状态栏/主题色
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var map = { cyan: '#25B6E9', pink: '#FF7FB3', purple: '#8B7CF6', mint: '#36C9A0' };
      meta.setAttribute('content', t.mode === 'dark' ? '#141820' : (map[t.accent] || '#25B6E9'));
    }
    // 供页面内部响应（如重绘图表）
    try {
      document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
    } catch (e) {}
  }

  window.__applyTheme = apply;
  apply();

  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf('taptap_') === 0) apply();
  });
  window.addEventListener('pageshow', apply);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) apply();
  });
  // 兜底：不同 WebView 实例之间 storage 事件可能不传播，轮询保证最终一致
  setInterval(apply, 1500);
})();
