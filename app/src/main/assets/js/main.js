/**
 * main.js - 主界面逻辑（Electron 渲染进程）
 *
 * 数据来源：
 *   1. App 列表: https://developer.taptap.cn/api/app/v2/list?developer_id=<当前账号>&page=1&pagesize=100
 *   2. 收入: https://developer.taptap.cn/api/mini-app/v1/ad/payout-report-data
 *          ?developer_id=${DEVELOPER_ID}&app_id=XXX&start_time=YYYY-MM-DD&end_time=YYYY-MM-DD
 *
 * 通过 preload 暴露的 window.electronAPI.fetch 调用（主进程带 cookie）
 */

(function () {
  'use strict';

  // ========== 主题与设置（最早执行，避免白闪） ==========
  const THEME_KEY = 'taptap_theme_mode';     // 'light' | 'dark'
  const ACCENT_KEY = 'taptap_theme_accent';  // 'cyan' | 'pink' | 'purple' | 'mint'
  const SOUND_KEY = 'taptap_sound_enabled';  // '1' | '0'
  const SETTINGS_KEYS = {
    monthGoal: 'taptap_month_goal',
    autorefresh: 'taptap_autorefresh_enabled'  // '1' | '0'，未设置视为默认开启
  };
  let soundEnabled = true; // init() 中读取 localStorage 覆盖

  // 应用主题（可在 DOM 就绪前执行：只改 <html> 上的 data-*）
  function applyTheme(mode, accent) {
    const root = document.documentElement;
    if (mode) root.setAttribute('data-theme', mode);
    if (accent) root.setAttribute('data-accent', accent);
    // 同步 Splash 背景（深色模式时加深渐变）
    const splash = document.getElementById('splash');
    if (splash) {
      if (mode === 'dark') splash.classList.add('splash-dark');
      else splash.classList.remove('splash-dark');
    }
    // 更新 theme-color meta
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const map = {
        cyan: '#25B6E9', pink: '#FF7FB3', purple: '#8B7CF6', mint: '#36C9A0'
      };
      meta.setAttribute('content', mode === 'dark' ? '#141820' : (map[accent] || '#25B6E9'));
    }
  }

  // 启动时立刻从 localStorage 读取并应用（避免白闪）
  const savedMode = localStorage.getItem(THEME_KEY) || 'light';
  const savedAccent = localStorage.getItem(ACCENT_KEY) || 'cyan';
  applyTheme(savedMode, savedAccent);
  // 音效开关：默认开启（本地存储值为 '0' 时才关闭）
  try { soundEnabled = localStorage.getItem(SOUND_KEY) !== '0'; } catch (_) { soundEnabled = true; }

  const API_BASE = 'https://developer.taptap.cn/api';
  // developer_id 从主进程配置动态获取（支持多账号），init() 里赋值
  let DEVELOPER_ID = null;
  let APP_LIST_URL = null;
  const REVENUE_URL = `${API_BASE}/mini-app/v1/ad/payout-report-data`;
  const DAU_URL = `${API_BASE}/mini-app/v1/stats-by-day/device`;
  const POSITION_URL = `${API_BASE}/dashboard/v2/stats-by-day/position/cn`;

  // 是否在 Electron 环境
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  let GAMES = [];          // 游戏列表（从 API 获取）
  let loadingRevenue = false;
  let firstRenderDone = false;  // 卡片错落淡入只在首次加载/手动刷新时触发

  const sounds = {
    click: new Audio('audio/tapsulor_pixel_click.mp3'),
    switch: new Audio('audio/tapsulor_pixel_switch.mp3'),
    refresh: new Audio('audio/tapsulor_pixel_refresh.mp3'),
    splash: new Audio('audio/tapsulor_splash.mp3')
  };
  Object.values(sounds).forEach(sound => { sound.preload = 'auto'; });

  function playSfx(name) {
    if (!soundEnabled) return;
    const sound = sounds[name];
    if (!sound) return;
    sound.currentTime = 0;
    sound.play().catch(() => {});
  }

  // ========== 工具 ==========
  function fmt(n) {
    if (n == null || isNaN(n)) return '0.00';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ========== 数据缓存 ==========
  // 原版 Electron 不做永久缓存，所有数据每次都从后端实时拉取，确保日活/留存/转化/时长/收入与后台完全一致
  function cacheGet(/*key*/) { return null; }
  function cacheSet(/*key, value*/) { /* no-op */ }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return formatDate(new Date());
  }

  function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  // 前天（用于昨日收入的环比基准）
  function dayBeforeStr() {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return formatDate(d);
  }

  function monthStartStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  function monthRangeStr() {
    return `${monthStartStr()} ~ ${todayStr()}`;
  }

  // 上月同期：上月1号 ~ 上月今日对应的同一天（用于本月收入的环比基准）
  // 若今日是当月最后一天且上月天数少，则截到上月月末
  function lastMonthSameDayRange() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();          // 0-based，本月是 m+1，上月是 m（JS Date 会自动处理跨年）
    const day = now.getDate();
    const lastMonthEnd = new Date(y, m, 0);              // 上月月末（day=0 表示上月最后一天）
    const lastMonthDay = Math.min(day, lastMonthEnd.getDate());
    const start = formatDate(new Date(y, m - 1, 1));     // 上月1号
    const end = formatDate(new Date(y, m - 1, lastMonthDay));
    return { start, end };
  }

  // 未发布游戏不展示
  function getVisibleGames() {
    return GAMES.filter(g => g.published);
  }

  // 环比百分比：(cur - prev) / prev × 100
  // prev 为 0 或 null 时不计算（返回 null），由 UI 决定怎么展示
  function momPct(cur, prev) {
    if (prev == null || prev === 0 || isNaN(prev)) return null;
    if (cur == null || isNaN(cur)) return null;
    return (cur - prev) / prev * 100;
  }

  // 生成环比标签 HTML
  // cur: 当前值；prev: 对比基准值；onColor: 是否在彩色背景上（汇总卡片）
  // 返回带 ↑/↓/持平 的小标签；无基准时返回空字符串
  function momTagHTML(cur, prev, onColor) {
    const pct = momPct(cur, prev);
    if (pct == null) return '';
    const colorCls = onColor ? ' on-color' : '';
    const abs = Math.abs(pct);
    const sign = pct > 0 ? '↑' : (pct < 0 ? '↓' : '');
    if (abs < 0.05) {
      return `<span class="mom-tag flat${colorCls}">持平</span>`;
    }
    const cls = pct > 0 ? 'up' : 'down';
    const arrowCls = pct > 0 ? 'mom-arrow up' : 'mom-arrow down';
    return `<span class="mom-tag ${cls}${colorCls}"><span class="${arrowCls}"></span><span class="mom-pct">${abs.toFixed(1)}%</span></span>`;
  }

  // ========== 微动效：数字滚动 ==========
  // 缓动函数：easeOutCubic
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // 金额/数字滚动动画
  // el: 目标元素；to: 目标数值；duration: 毫秒；formatter: 格式化函数
  // 记录上一次值，从上一次值滚动到新值；正在滚动时从当前显示值接力
  const animatingValues = new WeakMap(); // el -> { current, rafId }

  function animateValue(el, to, duration, formatter) {
    if (!el) return;
    const prev = animatingValues.get(el);
    const from = prev ? prev.current : 0;

    // 取消上一次动画
    if (prev && prev.rafId) cancelAnimationFrame(prev.rafId);

    const start = performance.now();
    const state = { current: from, rafId: null };
    animatingValues.set(el, state);

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const value = from + (to - from) * eased;
      state.current = value;
      el.textContent = formatter(value);

      if (progress < 1) {
        state.rafId = requestAnimationFrame(tick);
      } else {
        state.current = to;
        el.textContent = formatter(to);
        state.rafId = null;
      }
    }
    state.rafId = requestAnimationFrame(tick);
  }

  // 金额格式化（¥ + 千分位 + 2 位小数）
  function fmtMoney(v) {
    return '¥' + fmt(v);
  }

  // 整数格式化（千分位）
  function fmtInt(v) {
    return Math.round(v).toLocaleString('zh-CN');
  }

  // 统一 fetch（Electron 走主进程带 cookie，浏览器走原生 fetch）
  async function apiFetch(url) {
    if (isElectron) {
      const res = await window.electronAPI.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.body);
    } else {
      // 浏览器预览（无 cookie，会失败）
      const res = await fetch(url, { credentials: 'include' });
      return await res.json();
    }
  }

  // ========== 登录态 ==========
  let loginOverlayAction = 'login';

  function showLoginOverlay(message, options) {
    options = options || {};
    loginOverlayAction = options.action || 'login';
    let overlay = document.getElementById('login-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'login-overlay';
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
      `;
      overlay.innerHTML = `
        <div class="login-shell">
          <div class="login-terminal">&gt; 安全会话校验_</div>
          <img src="app-icon.png" class="login-icon" alt="TapSulor">
          <h2 id="login-title"></h2>
          <p id="login-msg"></p>
          <div class="login-points"><span><b>01</b> 安全会话</span><span><b>02</b> 收益读取</span></div>
          <button id="login-btn"></button>
        </div>
      `;
      document.body.appendChild(overlay);

      document.getElementById('login-btn').addEventListener('click', async () => {
        if (isElectron) {
          if (loginOverlayAction === 'retry') {
            document.getElementById('login-msg').textContent = '正在重新验证登录状态...';
            await init();
          } else {
            document.getElementById('login-msg').textContent = loginOverlayAction === 'developer'
              ? '正在打开 TapTap 开发者中心...'
              : '正在打开登录窗口...';
            await window.electronAPI.openLogin();
          }
        } else {
          document.getElementById('login-msg').textContent = '浏览器预览模式无法登录，请打包成 exe 后使用。';
        }
      });
    }

    document.getElementById('login-title').textContent = options.title || '登录 TapTap 开发者后台';
    document.getElementById('login-msg').textContent = message || '需要登录后才能获取收入数据';
    document.getElementById('login-btn').textContent = options.button || '立即登录';
    overlay.style.display = 'flex';
  }

  function hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ========== 数据获取 ==========
  // 从各种可能的 icon 字段里挑出一个可直接展示的 http(s) URL
  function normalizeAssetUrl(value) {
    if (!value) return null;
    // 递归找第一个字符串候选：兼容数组 / 嵌套对象
    const candidates = [];
    const collect = (v) => {
      if (v == null) return;
      if (typeof v === 'string') { candidates.push(v); return; }
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (typeof v === 'object') {
        // 按常见优先级顺序枚举
        const keys = ['url', 'original_url', 'originalUrl', 'large_url', 'largeUrl',
                      'medium_url', 'mediumUrl', 'small_url', 'smallUrl',
                      'thumb_url', 'thumbUrl', 'src', 'path', 'download_url'];
        keys.forEach(k => { if (v[k] != null) collect(v[k]); });
      }
    };
    collect(value);
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        // protocol-relative ("//cdn.xxx.com/a.png") 从 appassets 基址解析，强制用 https
        const url = new URL(candidate, 'https://developer.taptap.cn/');
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        return url.href;
      } catch (e) { /* ignore, try next */ }
    }
    return null;
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getAppIcon(app) {
    // TapTap 开发者后台 /api/app/v2/list 常用 icon 字段名兼容（原版 EXE 读取的也是这些之一）
    const icon = app.icon || app.icon_url || app.iconUrl || app.logo || app.logo_url
              || app.cover || app.cover_url || app.image || app.avatar || app.thumb || app.thumbnail;
    return normalizeAssetUrl(icon);
  }

  async function fetchAppList() {
    const json = await apiFetch(APP_LIST_URL);
    if (!json.success || !json.data || !json.data.list) {
      throw new Error('App 列表获取失败');
    }

    GAMES = json.data.list.map(app => ({
      appId: String(app.id),
      name: app.title,
      // 与原版 EXE 完全一致：优先 medium_url，其次 url；通过 normalizeAssetUrl 统一成绝对 https URL
      icon: normalizeAssetUrl(app.icon && app.icon.medium_url ? app.icon.medium_url : (app.icon && app.icon.url)) || getAppIcon(app),
      published: app.review_status && app.review_status.value === 4,
      todayRevenue: null,
      monthRevenue: null,
      totalRevenue: null,
      todayDAU: null,
      todayNewUsers: null,
      todayImpression: null,     // 昨日广告曝光（impression_cnt）
      monthRevenueList: null,    // 本月每日收入列表（供月末预估用）
      // 环比基准
      prevDayRevenue: null,      // 前一日收入（昨日环比）
      prevDayDAU: null,          // 前一日 DAU（昨日 DAU 环比）
      lastMonthRevenue: null,    // 上月同期收入（本月环比）
      // loading 标志
      todayLoading: false,
      monthLoading: false,
      totalLoading: false,
      dauLoading: false,
      impressionLoading: false,  // 曝光数据拉取中
      momLoading: false          // 环比拉取中
    }));

    // 已上线的排前面
    GAMES.sort((a, b) => {
      if (a.published !== b.published) return a.published ? -1 : 1;
      return 0;
    });
  }

  async function fetchGameRevenue(appId, startDate, endDate) {
    const url = `${REVENUE_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_time=${startDate}&end_time=${endDate}`;
    const json = await apiFetch(url);
    if (!json.success || !json.data) {
      throw new Error(json.data && json.data.msg || '收入接口返回失败');
    }

    const list = json.data.list || [];
    const total = json.data.total != null
      ? parseFloat(json.data.total)
      : list.reduce((sum, i) => sum + (parseFloat(i.revenue) || 0), 0);

    return { total, list };
  }

  // 获取某游戏某日活跃用户数（DAU）和新增用户数
  // API: mini-app/v1/stats-by-day/device
  async function fetchGameDAU(appId, startDate, endDate) {
    const url = `${DAU_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${startDate}&end_date=${endDate}`;
    const json = await apiFetch(url);
    if (!json.success || !json.data || !json.data.list) {
      throw new Error('DAU 接口返回失败');
    }
    // 从 list 里找目标日期
    const item = json.data.list.find(r => r.date === startDate);
    return {
      dau: item ? item.active_device_num : 0,
      newUsers: item ? item.new_active_device_num : 0
    };
  }

  // 获取某日期范围的每日 DAU，返回 { 'YYYY-MM-DD': { dau, newUsers } }
  // 一次请求拿多天数据，供环比/预估复用，避免逐日单拉
  async function fetchGameDAURange(appId, startDate, endDate) {
    const url = `${DAU_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${startDate}&end_date=${endDate}`;
    const json = await apiFetch(url);
    if (!json.success || !json.data || !json.data.list) {
      throw new Error('DAU 接口返回失败');
    }
    const map = {};
    (json.data.list || []).forEach(item => {
      map[item.date] = {
        dau: item.active_device_num || 0,
        newUsers: item.new_active_device_num || 0
      };
    });
    return map;
  }

  // 拉取曝光/点击/转化漏斗数据（position/cn 接口）
  async function fetchGamePositionRange(appId, startDate, endDate) {
    const url = `${POSITION_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${startDate}&end_date=${endDate}&platform=android`;
    const json = await apiFetch(url).catch(() => null);
    const map = {};
    if (json && json.success && json.data && json.data.list) {
      json.data.list.forEach(i => {
        map[i.date] = {
          impression: i.impression_cnt || 0,
          click: i.click_cnt || 0,
          clickRate: i.click_rate,
          convDetail: i.convert_detail_cnt || 0,
          convDetailRate: i.convert_detail_rate,
          convTotal: i.convert_cnt || 0
        };
      });
    }
    return map;
  }

  // 拉取所有已上线游戏的昨日收入、昨日日活、本月收入和环比
  async function fetchAllRevenue() {
    if (loadingRevenue) return;
    loadingRevenue = true;

    const today = todayStr();
    const yesterday = yesterdayStr();
    const dayBefore = dayBeforeStr();
    const monthStart = monthStartStr();
    const lastMonthRange = lastMonthSameDayRange();
    const publishedGames = GAMES.filter(g => g.published);

    // 标记加载中
    publishedGames.forEach(g => {
      g.todayLoading = true; g.monthLoading = true; g.totalLoading = true;
      g.dauLoading = true; g.impressionLoading = true; g.momLoading = true;
    });
    renderAll();

    // 每个游戏 7 个独立请求并发，预估等本月收入完成后算
    const promises = publishedGames.map(async (g) => {
      const appId = g.appId;

      // 1) 近2天收入区间（拿昨天 + 前天）
      const p1 = fetchGameRevenue(appId, dayBefore, yesterday).then(rev2d => {
        const list = rev2d.list || [];
        const yItem = list.find(i => i.date === yesterday);
        const dItem = list.find(i => i.date === dayBefore);
        g.todayRevenue = yItem ? (parseFloat(yItem.revenue) || 0) : null;
        g.prevDayRevenue = dItem ? (parseFloat(dItem.revenue) || 0) : null;
        g.todayRevenueError = null;
      }).catch(e => {
        console.warn(`[${g.name}] 近2天收入获取失败:`, e.message);
        g.todayRevenue = null; g.prevDayRevenue = null;
        g.todayRevenueError = e.message;
      }).finally(() => {
        g.todayLoading = false; g.momLoading = false; renderAll();
      });

      // 2) 近2天 DAU 区间（拿昨天 + 前天 DAU）
      const p2 = fetchGameDAURange(appId, dayBefore, yesterday).then(dau2dMap => {
        const yDau = dau2dMap[yesterday] || { dau: 0, newUsers: 0 };
        g.todayDAU = yDau.dau;
        g.todayNewUsers = yDau.newUsers;
        g.prevDayDAU = (dau2dMap[dayBefore] && dau2dMap[dayBefore].dau) || null;
      }).catch(e => {
        console.warn(`[${g.name}] 近2天 DAU 获取失败:`, e.message);
        g.todayDAU = 0; g.todayNewUsers = 0; g.prevDayDAU = null;
      }).finally(() => {
        g.dauLoading = false; renderAll();
      });

      // 3) 本月收入区间（拿 total + list，list 供预估用）
      const p3 = fetchGameRevenue(appId, monthStart, today).then(monthData => {
        g.monthRevenue = monthData.total;
        g.monthRevenueList = monthData.list || [];
        g.monthRevenueError = null;
      }).catch(e => {
        console.warn(`[${g.name}] 本月收入获取失败:`, e.message);
        g.monthRevenue = null;
        g.monthRevenueList = null;
        g.monthRevenueError = e.message;
      }).finally(() => {
        g.monthLoading = false; renderAll();
      });

      // 4) 本月 DAU 请求已移除：首页只展示昨日 DAU，不再计算预估收益。
      const p4 = Promise.resolve();

      // 5) 上月同期收入（本月环比基准）—— 历史数据不变，用日期范围作 key 缓存
      const p5CacheKey = `cache:${DEVELOPER_ID}:${appId}:lastMonthRev:${lastMonthRange.start}_${lastMonthRange.end}`;
      const p5Cached = cacheGet(p5CacheKey);
      const p5 = (p5Cached != null
        ? Promise.resolve(p5Cached)
        : fetchGameRevenue(appId, lastMonthRange.start, lastMonthRange.end).then(lmData => {
            cacheSet(p5CacheKey, lmData.total);
            return lmData.total;
          })
      ).then(total => {
        g.lastMonthRevenue = total;
      }).catch(e => {
        console.warn(`[${g.name}] 上月同期收入获取失败:`, e.message);
        g.lastMonthRevenue = null;
      }).finally(() => {
        renderAll();
      });

      // 6) 累计总收入（从很早到昨天）—— 截至昨日的累计，同日不变，用 yesterday 作 key 缓存
      const p6CacheKey = `cache:${DEVELOPER_ID}:${appId}:totalRev:${yesterday}`;
      const p6Cached = cacheGet(p6CacheKey);
      const p6 = (p6Cached != null
        ? Promise.resolve(p6Cached)
        : fetchGameRevenue(appId, '2020-01-01', yesterday).then(totalData => {
            cacheSet(p6CacheKey, totalData.total);
            return totalData.total;
          })
      ).then(total => {
        g.totalRevenue = total;
        g.totalRevenueError = null;
      }).catch(e => {
        console.warn(`[${g.name}] 累计总收入获取失败:`, e.message);
        g.totalRevenue = null;
        g.totalRevenueError = e.message;
      }).finally(() => {
        g.totalLoading = false; renderAll();
      });

      // 7) 昨日曝光（position/cn 接口）
      const p7 = fetchGamePositionRange(appId, dayBefore, yesterday).then(posMap => {
        const yPos = posMap[yesterday];
        g.todayImpression = yPos ? (yPos.impression || 0) : null;
      }).catch(e => {
        console.warn(`[${g.name}] 昨日曝光获取失败:`, e.message);
        g.todayImpression = null;
      }).finally(() => {
        g.impressionLoading = false; renderAll();
      });

      // 等全部完成
      await Promise.all([p1, p2, p3, p4, p5, p6, p7]);
    });

    await Promise.all(promises);
    loadingRevenue = false;
  }

  // ========== 渲染 ==========
  // 月末预估：基于已发生每日收入，去掉两端极值（各 10%）后取稳健均值推算剩余天数
  // dailyList: [{date:'YYYY-MM-DD', revenue:number}]（可来自单游戏或多游戏聚合）
  // monthTotal: 本月截至目前累计收入（可空，空则用 dailyList 求和）
  // 返回 {avg, projection, elapsedDays, remainingDays, daysInMonth, robustMean}
  function computeMonthProjection(dailyList, monthTotal) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayNum = now.getDate();
    const yesterdayNum = Math.max(1, todayNum - 1); // 今日数据可能不完整，不计入已过天数
    const elapsedDays = yesterdayNum;
    const remainingDays = daysInMonth - elapsedDays;

    // 仅统计当月且已过日期的收入
    const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
    const values = [];
    let listSum = 0;
    (dailyList || []).forEach(d => {
      if (!d || !d.date || !String(d.date).startsWith(monthPrefix)) return;
      const day = parseInt(String(d.date).slice(8, 10), 10);
      if (isNaN(day) || day < 1 || day > elapsedDays) return;
      const rev = Number(d.revenue) || 0;
      values.push(rev);
      listSum += rev;
    });

    const total = (monthTotal != null && !isNaN(monthTotal)) ? Number(monthTotal) : listSum;
    // 日均：累计 / 已过天数
    const avg = elapsedDays > 0 ? total / elapsedDays : 0;

    // 稳健日均值：排序后去掉最高/最低各 10%（至少各去 1 个，数据不足 3 天时退化为普通均值）
    let robustMean = avg;
    if (values.length >= 3) {
      const sorted = [...values].sort((a, b) => a - b);
      const trim = Math.max(1, Math.floor(sorted.length * 0.1));
      const slice = sorted.slice(trim, sorted.length - trim);
      if (slice.length > 0) {
        robustMean = slice.reduce((s, v) => s + v, 0) / slice.length;
      }
    }

    const projection = total + robustMean * remainingDays;
    return { avg, projection, elapsedDays, remainingDays, daysInMonth, robustMean };
  }

  // 只展示接口返回的真实结算金额；不使用 ARPU 估算替换昨日收入。
  function renderSummary(games) {
    const publishedGames = games.filter(g => g.published);
    const todayGot = publishedGames.filter(g => g.todayRevenue != null);
    const monthGot = publishedGames.filter(g => g.monthRevenue != null);
    const totalGot = publishedGames.filter(g => g.totalRevenue != null);

    function renderAmount(id, values, duration) {
      const el = document.getElementById(id);
      if (!el) return;
      if (values.length === 0) {
        el.textContent = '暂无';
        return;
      }
      const total = values.reduce((sum, value) => sum + (value || 0), 0);
      animateValue(el, total, duration, fmtMoney);
    }

    const monthTotal = monthGot.reduce((sum, game) => sum + (game.monthRevenue || 0), 0);
    renderAmount('summary-today', todayGot.map(g => g.todayRevenue), 600);
    renderAmount('summary-month', monthGot.map(g => g.monthRevenue), 600);
    renderAmount('summary-total', totalGot.map(g => g.totalRevenue), 800);

    // 汇总区"日均 / 月末预估"（按日期聚合所有已拉取到本月日流水的游戏）
    const avgEl = document.getElementById('summary-month-avg');
    const projEl = document.getElementById('summary-month-proj');
    const dailyByDate = {};
    monthGot.forEach(g => {
      if (Array.isArray(g.monthRevenueList)) {
        g.monthRevenueList.forEach(d => {
          if (!d || !d.date) return;
          dailyByDate[d.date] = (dailyByDate[d.date] || 0) + (Number(d.revenue) || 0);
        });
      }
    });
    const mergedDaily = Object.keys(dailyByDate).map(date => ({ date, revenue: dailyByDate[date] }));
    if (avgEl && projEl) {
      if (mergedDaily.length === 0) {
        avgEl.textContent = '日均 ¥—';
        projEl.textContent = '月末预估 ¥—';
      } else {
        const proj = computeMonthProjection(mergedDaily, monthTotal);
        avgEl.textContent = `日均 ¥${fmt(proj.avg)}`;
        projEl.textContent = `月末预估 ¥${fmt(proj.projection)}`;
      }
    }

    const label = document.getElementById('summary-today-label');
    if (label) label.textContent = '昨日广告收益';
    const meta = document.getElementById('summary-total-meta');
    if (meta) {
      const pending = publishedGames.length - totalGot.length;
      meta.textContent = pending > 0
        ? `${totalGot.length}/${publishedGames.length} 个项目已同步真实收益数据，${pending} 个项目未同步`
        : `${totalGot.length}/${publishedGames.length} 个项目已同步真实收益数据`;
    }
    renderMonthGoal(monthTotal, monthGot.length, publishedGames.length);
  }

  // 月度目标进度条
  // monthTotal: 本月已获取收入合计；got: 已获取游戏数；total: 已上线游戏总数
  function renderMonthGoal(monthTotal, got, total) {
    const section = document.getElementById('month-goal-section');
    if (!section) return;
    const goal = parseFloat(localStorage.getItem(SETTINGS_KEYS.monthGoal));
    if (!goal || goal <= 0 || isNaN(goal)) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const pct = Math.min(monthTotal / goal * 100, 100);
    const over = monthTotal >= goal;
    const fill = document.getElementById('month-goal-fill');
    fill.style.width = pct.toFixed(1) + '%';
    fill.classList.toggle('is-over', over);

    document.getElementById('month-goal-value').textContent = '¥' + fmt(goal);
    const remain = goal - monthTotal;
    const remainText = over
      ? `已达成 ✓ 超出 ¥${fmt(-remain)}`
      : `距目标还差 ¥${fmt(remain)}`;
    const suffix = got < total ? ` · ${got}/${total} 统计中` : '';
    document.getElementById('month-goal-text').textContent =
      `${pct.toFixed(1)}% · ${remainText}${suffix}`;
  }

  function renderGameList(games) {
    const list = document.getElementById('game-list');
    const count = document.getElementById('game-count');
    count.textContent = games.length + ' 个';

    if (games.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 9h6M9 13h6M9 17h3"/>
          </svg>
          <p>暂无游戏数据</p>
        </div>
      `;
      return;
    }

    // 按本月收入降序（未发布的排最后）
    const sorted = [...games].sort((a, b) => {
      if (a.published !== b.published) return a.published ? -1 : 1;
      const av = a.monthRevenue || 0;
      const bv = b.monthRevenue || 0;
      return bv - av;
    });

    list.innerHTML = sorted.map((g, i) => {
      const safeName = escapeHTML(g.name);
      const firstChar = escapeHTML((g.name || '?').charAt(0));
      let iconHTML;
      if (g.icon) {
        const safeIcon = escapeHTML(g.icon);
        // 与原版 EXE 完全一致：加载失败时隐藏 img、显示兜底字母；默认字母不显示
        iconHTML = `<img src="${safeIcon}" alt="${safeName}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="icon-fallback" style="display:none;">${firstChar}</span>`;
      } else {
        iconHTML = `<span class="icon-fallback">${firstChar}</span>`;
      }

      const statusBadge = g.published ? '' : '<span class="game-status unpublished">未发布</span>';

      // 错落淡入动画（仅首次加载/手动刷新时触发）
      const animStyle = !firstRenderDone
        ? ` style="animation: cardIn 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; animation-delay: ${i * 50}ms;"`
        : '';

      // 昨日收入块（实际为 0 时尝试用昨日预估：ARPU × 昨日 DAU）
      let todayHTML;
      if (!g.published) {
        todayHTML = `<div class="game-metric-value muted">—</div>
                     <div class="game-metric-label">昨日收入</div>`;
      } else if (g.todayLoading) {
        todayHTML = `<div class="game-metric-value muted">加载中</div>
                     <div class="game-metric-label">昨日收入</div>`;
      } else if (g.todayRevenue == null) {
        todayHTML = `<div class="game-metric-value muted">暂无</div>
                     <div class="game-metric-label">昨日收益未同步</div>`;
      } else {
        const momRev = momTagHTML(g.todayRevenue, g.prevDayRevenue);
        todayHTML = `<div class="game-metric-value">¥${fmt(g.todayRevenue)}</div>
                     <div class="game-metric-label">昨日广告收益 ${momRev}</div>`;
      }

      // 日活 + 转化率块
      let dauHTML;
      if (!g.published) {
        dauHTML = `<div class="game-metric-value muted">—</div>
                   <div class="game-metric-label">昨日日活</div>
                   <div class="game-metric-sub muted">转化率 —</div>`;
      } else if (g.dauLoading) {
        dauHTML = `<div class="game-metric-value muted">加载中</div>
                   <div class="game-metric-label">昨日日活</div>
                   <div class="game-metric-sub muted">转化率 —</div>`;
      } else if (g.todayDAU == null) {
        dauHTML = `<div class="game-metric-value muted">—</div>
                   <div class="game-metric-label">昨日日活</div>
                   <div class="game-metric-sub muted">转化率 —</div>`;
      } else {
        const arpu = g.todayDAU > 0 && g.todayRevenue != null ? (g.todayRevenue / g.todayDAU) : null;
        const momDau = momTagHTML(g.todayDAU, g.prevDayDAU);
        dauHTML = `<div class="game-metric-value">${(g.todayDAU||0).toLocaleString('zh-CN')}</div>
                   <div class="game-metric-label">昨日日活 ${momDau}</div>
                   <div class="game-metric-sub">${arpu == null ? '转化率 —' : `转化率 ${(arpu * 100).toFixed(1)}%`}</div>`;
      }

      // 本月数据块
      let monthHTML;
      if (!g.published) {
        monthHTML = `<div class="game-metric-value muted">暂无</div>
                     <div class="game-metric-label">本月收益未同步</div>`;
      } else if (g.monthLoading) {
        monthHTML = `<div class="game-metric-value muted">加载中</div>
                     <div class="game-metric-label">本月</div>`;
      } else if (g.monthRevenue == null) {
        monthHTML = `<div class="game-metric-value muted">—</div>
                     <div class="game-metric-label">本月</div>`;
      } else {
        const hasPrev = g.lastMonthRevenue != null && g.lastMonthRevenue > 0;
        const momMon = hasPrev
          ? momTagHTML(g.monthRevenue, g.lastMonthRevenue)
          : '<span class="mom-tag flat">暂无数据</span>';
        const lastMonthLine = hasPrev
          ? `<div class="game-metric-sub">上月 ¥${fmt(g.lastMonthRevenue)}</div>`
          : '';
        monthHTML = `<div class="game-metric-value">¥${fmt(g.monthRevenue)}</div>
                     <div class="game-metric-label">本月 ${momMon}</div>
                     ${lastMonthLine}`;
      }

      // 昨日曝光块
      let impressionHTML;
      if (!g.published) {
        impressionHTML = `<div class="game-metric-value muted">—</div>
                          <div class="game-metric-label">昨日曝光</div>`;
      } else if (g.impressionLoading) {
        impressionHTML = `<div class="game-metric-value muted">加载中</div>
                          <div class="game-metric-label">昨日曝光</div>`;
      } else if (g.todayImpression == null) {
        impressionHTML = `<div class="game-metric-value muted">—</div>
                          <div class="game-metric-label">昨日曝光未同步</div>`;
      } else {
        impressionHTML = `<div class="game-metric-value">${fmtInt(g.todayImpression)}</div>
                          <div class="game-metric-label">昨日曝光</div>`;
      }

      // 名称下方展示累计广告收益金额
      let subHTML;
      if (!g.published) {
        subHTML = `<span class="game-sub-hint">未发布 · 点击查看详情</span>`;
      } else {
        subHTML = g.totalLoading
          ? `<span class="game-sub-hint">累计收益同步中…</span>`
          : g.totalRevenue == null
            ? `<span class="game-sub-hint">累计收益未同步</span>`
            : `<span class="game-total-pill">累计广告收益 ¥${fmt(g.totalRevenue)}</span>`;
      }

      return `
        <div class="game-card ${g.published ? '' : 'is-unpublished'}" data-app-id="${g.appId}"${animStyle}>
          <div class="game-card-top">
            <div class="game-icon">${iconHTML}</div>
            <div class="game-info">
              <div class="game-name">${safeName} ${statusBadge}</div>
              <div class="game-sub">${subHTML}</div>
            </div>
            <svg class="game-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>
          <div class="game-metrics">
            <div class="game-metric is-today">
              ${todayHTML}
            </div>
            <div class="game-metric is-dau">
              ${dauHTML}
            </div>
            <div class="game-metric is-month">
              ${monthHTML}
            </div>
            <div class="game-metric is-impression">
              ${impressionHTML}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 绑定点击事件
    document.querySelectorAll('.game-card').forEach(card => {
      card.addEventListener('click', () => {
        const appId = card.dataset.appId;
        const game = GAMES.find(g => g.appId === appId);
        if (game) openDetail(game);
      });
    });

    // 首次渲染完成，后续数据更新不再触发错落淡入
    firstRenderDone = true;
  }

  function openDetail(game) {
    sessionStorage.setItem('currentGame', JSON.stringify(game));
    window.location.href = 'detail.html?app_id=' + game.appId;
  }

  function renderAll() {
    const games = getVisibleGames();
    renderSummary(games);
    renderGameList(games);
  }

  // ========== 初始化 ==========
  async function init() {
    renderAll();

    if (!isElectron) {
      const boot = document.getElementById('auth-boot');
      if (boot) boot.remove();
      document.getElementById('game-list').innerHTML = `
        <div class="empty-state"><p>需要宿主应用</p><p>请从 Android 应用进入收益控制台</p></div>
      `;
      return;
    }

    // 先由主进程根据当前 Session 识别并持久化真实开发者身份，再构造数据 URL。
    // 旧版本顺序相反，会先拿到写死的默认 ID，导致其他用户访问无权查看的开发者空间。
    const identity = await window.electronAPI.checkLogin();
    const boot = document.getElementById('auth-boot');
    if (boot) boot.remove();
    if (!identity || identity.status === 'unauthenticated') {
      showLoginOverlay('首次进入必须连接一个拥有开发者权限的 TapTap 账号。登录成功后才会打开收益控制台。', {
        action: 'login',
        title: '连接开发者账号',
        button: '开始安全登录'
      });
      return;
    }
    if (identity.status === 'no-developer') {
      showLoginOverlay('当前 TapTap 账号尚未加入任何开发者主体，请先在开发者中心创建或加入开发者，然后返回重试。', {
        action: 'developer',
        title: '未找到开发者权限',
        button: '打开开发者中心'
      });
      return;
    }
    if (identity.status === 'identity-unresolved') {
      showLoginOverlay('TapTap 登录有效，但暂时无法自动读取开发者主体。请在登录窗口进入任意一个开发者控制台后，应用会从控制台地址识别开发者 ID。', {
        action: 'login',
        title: '请选择开发者主体',
        button: '打开开发者控制台'
      });
      return;
    }
    if (identity.status === 'error') {
      showLoginOverlay('暂时无法验证 TapTap 登录状态，请检查网络后重试。', {
        action: 'retry',
        title: '连接 TapTap 失败',
        button: '重试'
      });
      return;
    }
    if (identity.status !== 'ready') {
      showLoginOverlay('无法识别当前账号状态，请重新登录。', {
        action: 'login',
        title: '账号状态异常',
        button: '重新登录'
      });
      return;
    }

    DEVELOPER_ID = await window.electronAPI.getDeveloperId();
    if (!DEVELOPER_ID) {
      showLoginOverlay('请先连接一个拥有开发者权限的 TapTap 账号，完成后才能进入收益控制台。', {
        action: 'login', title: '连接首个开发者账号', button: '前往安全登录'
      });
      return;
    }
    // 顶栏显示真实工作室昵称 + 头像（异步渲染，不阻塞后续加载）
    renderActiveAccountHeader();
    APP_LIST_URL = `${API_BASE}/app/v2/list?developer_id=${encodeURIComponent(DEVELOPER_ID)}&page=1&pagesize=100`;

    hideLoginOverlay();

    try {
      document.getElementById('game-list').innerHTML = '<div class="loading-tip">正在获取游戏列表...</div>';
      await fetchAppList();
      firstRenderDone = false;  // 新列表加载完成，触发错落淡入
      renderAll();
      // 后台拉取收入
      fetchAllRevenue();
    } catch (e) {
      console.error('初始化失败:', e);
      document.getElementById('game-list').innerHTML = `
        <div class="empty-state">
          <p style="color:#ef4444;">加载失败: ${e.message}</p>
          <p style="color:#9ca3af;font-size:12px;margin-top:8px;">可能是登录已过期，请重新登录</p>
        </div>
      `;
      showLoginOverlay('登录可能已过期，请重新登录');
    }
  }

  // ========== 事件 ==========

  // ========== API 探测 ==========
  // 调试面板已从用户界面移除，保留数据接口兼容代码不再绑定 UI。
  let capturedApis = [];
  let expandedApi = null;

  async function refreshApis() {
    if (!isElectron) return;
    capturedApis = await window.electronAPI.getCapturedApis();
    renderApiList();
  }

  function renderApiList() {
    const list = document.getElementById('api-list');
    const count = document.getElementById('api-count');
    count.textContent = capturedApis.length;

    if (capturedApis.length === 0) {
      list.innerHTML = '<div class="api-empty">点击"打开探测窗口"，在弹出的后台页面中浏览数据，API 会自动捕获</div>';
      return;
    }

    list.innerHTML = capturedApis.slice().reverse().map((api, i) => {
      const realIdx = capturedApis.length - 1 - i;
      const isExpanded = expandedApi === realIdx;

      // 从 URL 提取简短路径
      let shortPath = api.url;
      try {
        const u = new URL(api.url);
        shortPath = u.pathname + (u.search ? '?' + u.search.substring(0, 60) : '');
      } catch (e) {}

      const statusClass = api.status >= 200 && api.status < 300 ? 'ok' : 'err';
      const sourceTag = api.source === 'webRequest'
        ? '<span class="api-source webrequest">网络层</span>'
        : (api.source === 'replay' ? '<span class="api-source replay">已重放</span>' : '<span class="api-source preload">注入层</span>');

      let bodyPreview = '';
      if (isExpanded && api.body) {
        let formatted = api.body;
        try {
          formatted = JSON.stringify(JSON.parse(api.body), null, 2);
        } catch (e) {}
        bodyPreview = `<pre class="api-body">${formatted.substring(0, 8000)}</pre>`;
      }

      const replayBtn = (!api.body && api.source === 'webRequest')
        ? `<button class="api-replay-btn" data-idx="${realIdx}">重放获取数据</button>`
        : '';

      return `
        <div class="api-item ${isExpanded ? 'expanded' : ''}" data-idx="${realIdx}">
          <div class="api-item-header">
            <span class="api-method ${api.method.toLowerCase()}">${api.method}</span>
            <span class="api-status ${statusClass}">${api.status}</span>
            ${sourceTag}
            <span class="api-path" title="${api.url}">${shortPath}</span>
          </div>
          ${bodyPreview}
          ${replayBtn}
        </div>
      `;
    }).join('');

    list.querySelectorAll('.api-item-header').forEach(h => {
      h.addEventListener('click', () => {
        const idx = parseInt(h.parentElement.dataset.idx);
        expandedApi = expandedApi === idx ? null : idx;
        renderApiList();
      });
    });

    list.querySelectorAll('.api-replay-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const api = capturedApis[idx];
        if (!api) return;
        btn.textContent = '重放中...';
        btn.disabled = true;
        try {
          const res = await window.electronAPI.replayApi(api.url);
          if (res.ok) {
            api.body = res.body;
            api.source = 'replay';
            expandedApi = idx;
            renderApiList();
          } else {
            btn.textContent = '重放失败: ' + (res.error || res.status);
            btn.disabled = false;
          }
        } catch (err) {
          btn.textContent = '重放失败';
          btn.disabled = false;
        }
      });
    });
  }

  if (isElectron) {
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      playSfx('refresh');
      const icon = refreshBtn.querySelector('svg');
      if (icon) {
        icon.style.transition = 'transform 0.6s steps(6)';
        icon.style.transform = 'rotate(360deg)';
        setTimeout(() => { icon.style.transition = 'none'; icon.style.transform = 'rotate(0deg)'; }, 600);
      }
      init();
    });
  }

  // ========== 设置面板 ==========
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');
  const settingDark = null;
  const settingExplorer = null;
  const settingAutorefresh = null;
  const settingMonthGoal = null;
  const settingMonthGoalSave = null;

  // 自动刷新定时器（5 分钟）
  const AUTOREFRESH_INTERVAL = 5 * 60 * 1000;
  let autoRefreshTimer = null;

  // 轻量刷新：重新拉取游戏列表与收入数据（不重置登录态、不闪烁登录遮罩）
  function lightRefresh() {
    if (!isElectron || GAMES.length === 0) return;
    // firstRenderDone 保持 true，避免卡片重新触发错落动画
    fetchAppList().then(() => {
      renderAll();
      fetchAllRevenue();
    }).catch((e) => { console.warn('lightRefresh app list failed:', e); fetchAllRevenue(); });
  }

  function applyAutoRefresh() {
    // 未设置时默认开启自动刷新；用户可在 localStorage 里设 '0' 关闭
    const stored = localStorage.getItem(SETTINGS_KEYS.autorefresh);
    const on = stored === null ? true : stored === '1';
    if (on && !autoRefreshTimer) {
      autoRefreshTimer = setInterval(lightRefresh, AUTOREFRESH_INTERVAL);
    } else if (!on && autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  // 把 APP 版本号（来自 Android BuildConfig）写入页脚 + 设置面板
  function fillAppVersion() {
    try {
      let ver = '';
      if (isElectron && window.electronAPI && window.electronAPI.getAppVersion) {
        ver = window.electronAPI.getAppVersion() || '';
      }
      const label = ver ? `TapSulor / v${ver}` : 'TapSulor';
      const f = document.getElementById('app-version-footer');
      const s = document.getElementById('app-version-settings');
      if (f) f.textContent = label;
      if (s) s.textContent = label;
    } catch (e) { /* ignore */ }
  }

  // 选择账号主显示名：优先开发者主体(工作室)名 > 用户昵称 > 原始 name
  function pickAccountDisplayName(acc) {
    if (acc) {
      if (acc.developerName && acc.developerName.trim()) return acc.developerName.trim();
      if (acc.nickname && acc.nickname.trim()) return acc.nickname.trim();
      if (acc.name && !/^TapTap\s*\d+$/.test(acc.name)) return acc.name;
    }
    return acc && acc.developerId ? `TapTap ${acc.developerId}` : 'TapTap 账号';
  }
  // 选择账号头像：优先开发者主体 Logo > 用户头像
  function pickAccountAvatar(acc) {
    if (!acc) return '';
    return (acc.developerAvatar && acc.developerAvatar.trim())
      || (acc.avatar && acc.avatar.trim()) || '';
  }

  // 渲染顶栏"当前操作员"的头像 + 昵称 + ID
  async function renderActiveAccountHeader() {
    const activeName = document.getElementById('active-account-name');
    const activeId = document.getElementById('active-account-id');
    const activeAvatar = document.getElementById('active-account-avatar');
    if (!DEVELOPER_ID) {
      if (activeName) activeName.textContent = '未识别账号';
      if (activeId) activeId.textContent = '请先完成 TapTap 开发者登录';
      if (activeAvatar) { activeAvatar.hidden = true; }
      return;
    }
    let acc = null;
    try {
      if (isElectron && window.electronAPI && window.electronAPI.getAccounts) {
        const data = await window.electronAPI.getAccounts();
        acc = (data && data.accounts && data.accounts.find(a => a.id === data.current)) || null;
      }
    } catch (e) { /* ignore */ }
    const displayName = pickAccountDisplayName(acc);
    if (activeName) activeName.textContent = displayName;
    if (activeId) activeId.textContent = `开发者 ID / ${DEVELOPER_ID}`;
    if (activeAvatar) {
      const url = pickAccountAvatar(acc);
      if (url) {
        activeAvatar.src = url;
        activeAvatar.hidden = false;
        activeAvatar.alt = displayName;
      } else {
        activeAvatar.hidden = true;
      }
    }
  }

  // ========== 账号管理 ==========
  async function renderAccountList() {
    const listEl = document.getElementById('account-list');
    if (!listEl || !isElectron) return;
    const data = await window.electronAPI.getAccounts();
    // 简单 HTML 转义，防止昵称中特殊字符破坏 DOM
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    listEl.innerHTML = data.accounts.map(acc => {
      const name = esc(pickAccountDisplayName(acc));
      const avatar = pickAccountAvatar(acc);
      const avatarHtml = avatar
        ? `<img class="account-item-avatar" src="${esc(avatar)}" alt="">`
        : `<div class="account-item-avatar" aria-hidden="true"></div>`;
      return `
      <div class="account-item ${acc.id === data.current ? 'is-current' : ''}" data-id="${acc.id}">
        ${avatarHtml}
        <div class="account-item-info">
          <div class="account-item-name">${name}</div>
          <div class="account-item-id">ID: ${esc(acc.developerId)}</div>
        </div>
        ${acc.id === data.current
          ? '<span class="account-item-tag">当前</span>'
          : `<button class="account-item-btn" data-action="switch">切换</button>`
        }
        <button class="account-item-btn danger" data-action="remove">×</button>
      </div>`;
    }).join('');
  }

  function bindAccountEvents() {
    const listEl = document.getElementById('account-list');
    const addBtn = document.getElementById('account-add-btn');
    const addHint = document.getElementById('account-add-hint');
    if (!listEl) return;

    // 事件委托：切换 / 删除
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const item = btn.closest('.account-item');
      if (!item) return;
      const id = item.dataset.id;
      const action = btn.dataset.action;

      if (action === 'switch') {
        playSfx('switch');
        await window.electronAPI.switchAccount(id);
        // 切换后主进程会重建窗口，当前页面自动重载
      } else if (action === 'remove') {
        if (item.classList.contains('is-current')) {
          alert('不能删除当前正在使用的账号');
          return;
        }
        if (!confirm('确定删除这个账号？')) return;
        const res = await window.electronAPI.removeAccount(id);
        if (res.ok) {
          renderAccountList();
        } else {
          alert(res.error || '删除失败');
        }
      }
    });

    // 添加账号：打开登录窗口，登录成功后主进程自动识别并保存开发者 ID
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        addBtn.textContent = '登录窗口已打开...';
        addBtn.disabled = true;
        if (addHint) addHint.classList.add('is-visible');
        try {
          await window.electronAPI.openLogin('add');
        } finally {
          addBtn.textContent = '+ 添加账号';
          addBtn.disabled = false;
          if (addHint) addHint.classList.remove('is-visible');
        }
      });
    }
  }

  function openSettings() {
    if (!settingsModal) return;
    settingsModal.hidden = false;
    renderAccountList();
  }
  function closeSettings() {
    if (!settingsModal) return;
    settingsModal.hidden = true;
  }
  if (settingsBtn || document.getElementById('account-manage-btn')) {
    const accountManageBtn = document.getElementById('account-manage-btn');
    if (accountManageBtn) accountManageBtn.addEventListener('click', openSettings);
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
    settingsOverlay.addEventListener('click', closeSettings);
    settingsClose.addEventListener('click', closeSettings);
    bindAccountEvents();

    // 主题切换 UI（浅色/深色）
    const modeSwitch = document.getElementById('mode-switch');
    if (modeSwitch) {
      // 初始化按钮激活态
      modeSwitch.querySelectorAll('button').forEach(b => {
        b.classList.toggle('is-active', b.dataset.mode === savedMode);
      });
      modeSwitch.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        const mode = btn.dataset.mode;
        localStorage.setItem(THEME_KEY, mode);
        applyTheme(mode, null);
        modeSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b === btn));
        playSfx('click');
      });
    }
    // 强调色选择
    const themeDots = document.getElementById('theme-dots');
    if (themeDots) {
      themeDots.querySelectorAll('.theme-dot').forEach(d => {
        d.classList.toggle('is-active', d.dataset.accent === savedAccent);
      });
      themeDots.addEventListener('click', (e) => {
        const dot = e.target.closest('.theme-dot');
        if (!dot) return;
        const accent = dot.dataset.accent;
        localStorage.setItem(ACCENT_KEY, accent);
        applyTheme(null, accent);
        themeDots.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('is-active', d === dot));
        playSfx('click');
      });
    }

    // 音效开关
    const soundToggle = document.getElementById('sound-toggle');
    if (soundToggle) {
      soundToggle.checked = soundEnabled;
      soundToggle.addEventListener('change', () => {
        const enabled = soundToggle.checked;
        soundEnabled = enabled;
        try { localStorage.setItem(SOUND_KEY, enabled ? '1' : '0'); } catch (_) {}
        if (enabled) playSfx('click'); // 开启时播放确认音
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
    });
  }

  // 不再启用自动同步；所有刷新由用户明确点击同步按钮触发。

  // 轻提示
  function showToast(msg) {
    let t = document.getElementById('tb-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'tb-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(17,24,39,.92);color:#fff;padding:10px 18px;border-radius:22px;font-size:14px;z-index:9999;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:80%;text-align:center;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(-4px)';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%)'; }, 2400);
  }

  // 监听登录成功
  if (isElectron) {
    window.electronAPI.onLoginSuccess(() => {
      hideLoginOverlay();
      // 稍作延迟，让 cookie/session 完全稳定后再请求数据
      setTimeout(() => init(), 300);
      // 如果设置面板正打开，刷新账号列表
      renderAccountList();
    });
    window.electronAPI.onLoginCheck(() => {
      // 登录窗口关闭后统一重新初始化，由 init 区分未登录、无开发者权限和网络错误。
      setTimeout(() => {
        init();
      }, 300);
    });
    // 添加/切换账号后的轻提示
    if (window.electronAPI.onAccountUpdated) {
      window.electronAPI.onAccountUpdated((result) => {
        if (result && result.isNew) {
          showToast(`已添加账号 TapTap ${result.developerId}`);
        } else if (result && result.alreadyCurrent) {
          showToast(`该账号（TapTap ${result.developerId}）已经是当前账号`);
        } else if (result && result.switched) {
          showToast(`已切换到账号 TapTap ${result.developerId}`);
        }
        // 切换账号后顶栏昵称/头像需要刷新
        renderActiveAccountHeader();
        if (settingsModal && !settingsModal.hidden) renderAccountList();
      });
    }
    // 托盘菜单"刷新数据"触发
    if (window.electronAPI.onTrayRefresh) {
      window.electronAPI.onTrayRefresh(() => {
        init();
      });
    }
    // 安卓端：应用从后台切回前台 / 定时 5 分钟自动刷新触发
    if (window.electronAPI.onAppResume) {
      window.electronAPI.onAppResume(() => {
        console.log('[app] onAppResume → init()');
        init();
      });
    }
    // 安卓端：应用在后台每 5 分钟触发一次轻量刷新（避免长时间停留导致数据陈旧）
    if (window.electronAPI.onAppBackgroundTick) {
      window.electronAPI.onAppBackgroundTick(() => {
        console.log('[app] background tick → lightRefresh()');
        lightRefresh();
      });
    }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, input[type="checkbox"]');
    if (target && target.id !== 'refresh-btn' && !target.matches('[data-action="switch"]')) playSfx('click');
  });

  // 启动
  // ========== 启动 Splash 动画 + 音效（仅首次进入，详情页返回不重复播放） ==========
  (function playSplash() {
    // 提前同步界面常量：版本号、自动刷新开关
    fillAppVersion();
    applyAutoRefresh();
    const splash = document.getElementById('splash');
    if (!splash) { init(); return; }
    if (sessionStorage.getItem('splash_played') === '1') {
      splash.remove();
      init();
      return;
    }
    sessionStorage.setItem('splash_played', '1');
    // 播放进入音效（尊重音效开关）
    if (soundEnabled) {
      try { sounds.splash.currentTime = 0; sounds.splash.play().catch(() => {}); } catch (_) {}
    }
    // 展示约 1.4s 后淡出
    setTimeout(() => {
      splash.classList.add('is-done');
      setTimeout(() => {
        splash.remove();
      }, 750);
    }, 1400);
    init();
  })();
})();
