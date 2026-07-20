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
  const SETTINGS_KEYS = {
    theme: 'taptap_theme',
    explorer: 'taptap_explorer',
    autorefresh: 'taptap_autorefresh',
    monthGoal: 'taptap_month_goal'
  };
  function applyTheme() {
    const dark = localStorage.getItem(SETTINGS_KEYS.theme) === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  function applyExplorer() {
    const on = localStorage.getItem(SETTINGS_KEYS.explorer) === '1';
    document.documentElement.classList.toggle('explorer-on', on);
  }
  applyTheme();
  applyExplorer();

  const API_BASE = 'https://developer.taptap.cn/api';
  // developer_id 从主进程配置动态获取（支持多账号），init() 里赋值
  let DEVELOPER_ID = null;
  let APP_LIST_URL = null;
  const REVENUE_URL = `${API_BASE}/mini-app/v1/ad/payout-report-data`;
  const DAU_URL = `${API_BASE}/mini-app/v1/stats-by-day/device`;

  // 是否在 Electron 环境
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  let GAMES = [];          // 游戏列表（从 API 获取）
  let showUnpublished = false;
  let loadingRevenue = false;
  let firstRenderDone = false;  // 卡片错落淡入只在首次加载/手动刷新时触发

  // ========== 工具 ==========
  function fmt(n) {
    if (n == null || isNaN(n)) return '0.00';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ========== 数据缓存 ==========
  // 历史数据（上月同期收入、累计总收入）天然不变，用日期范围作 key，无需 TTL
  function cacheGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) { return null; }
  }
  function cacheSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
  }

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

  function getVisibleGames() {
    return showUnpublished ? GAMES : GAMES.filter(g => g.published);
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
          <div class="login-terminal">&gt; SECURE SESSION REQUIRED_</div>
          <div class="login-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
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
  async function fetchAppList() {
    const json = await apiFetch(APP_LIST_URL);
    if (!json.success || !json.data || !json.data.list) {
      throw new Error('App 列表获取失败');
    }

    GAMES = json.data.list.map(app => ({
      appId: String(app.id),
      name: app.title,
      icon: app.icon && app.icon.medium_url ? app.icon.medium_url : (app.icon && app.icon.url),
      published: app.review_status && app.review_status.value === 4,
      todayRevenue: null,
      monthRevenue: null,
      totalRevenue: null,
      todayDAU: null,
      todayNewUsers: null,
      // 环比基准
      prevDayRevenue: null,      // 前一日收入（昨日环比）
      prevDayDAU: null,          // 前一日 DAU（昨日 DAU 环比）
      lastMonthRevenue: null,    // 上月同期收入（本月环比）
      // 今日预估
      todayEstimate: null,       // 预估收益（元）
      todayEstimateArpu: null,   // 预估用的 ARPU（元/活跃）
      // loading 标志
      todayLoading: false,
      monthLoading: false,
      totalLoading: false,
      dauLoading: false,
      estimateLoading: false,
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

  // 今日预估收益：用本月已结算天（revenue>0 且 dau>0）的平均每活跃收益 × 今日活跃
  // 收益 T+1 结算，今日/8:45 前的昨日都没有真实收益，用 ARPU 估算
  // revenueList: fetchGameRevenue 返回的 list；dauMap: fetchGameDAURange 返回的 map
  function computeTodayEstimate(revenueList, dauMap) {
    const today = todayStr();
    const todayDAU = dauMap[today] ? dauMap[today].dau : 0;
    if (todayDAU <= 0) return { estimate: 0, todayDAU: 0, arpu: 0 };

    // 本月已结算天：revenue > 0 且 dau > 0（排除未结算的 0 收益天）
    let realRev = 0, realDau = 0;
    revenueList.forEach(item => {
      const date = item.date;
      const rev = parseFloat(item.revenue) || 0;
      const dau = (dauMap[date] && dauMap[date].dau) || 0;
      if (rev > 0 && dau > 0) {
        realRev += rev;
        realDau += dau;
      }
    });
    const arpu = realDau > 0 ? realRev / realDau : 0;
    const estimate = arpu * todayDAU;
    return { estimate, todayDAU, arpu };
  }

  // 拉取所有已上线游戏的昨日收入 + 昨日日活 + 本月收入 + 环比 + 今日预估
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
      g.dauLoading = true; g.estimateLoading = true; g.momLoading = true;
    });
    renderAll();

    // 每个游戏 6 个独立请求并发，预估等本月收入+DAU完成后算
    const promises = publishedGames.map(async (g) => {
      const appId = g.appId;
      let monthRevList = [];
      let monthDauMap = {};

      // 1) 近2天收入区间（拿昨天 + 前天）
      const p1 = fetchGameRevenue(appId, dayBefore, yesterday).then(rev2d => {
        const list = rev2d.list || [];
        const yItem = list.find(i => i.date === yesterday);
        const dItem = list.find(i => i.date === dayBefore);
        g.todayRevenue = yItem ? (parseFloat(yItem.revenue) || 0) : 0;
        g.prevDayRevenue = dItem ? (parseFloat(dItem.revenue) || 0) : null;
      }).catch(e => {
        console.warn(`[${g.name}] 近2天收入获取失败:`, e.message);
        g.todayRevenue = 0; g.prevDayRevenue = null;
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
        monthRevList = monthData.list || [];
      }).catch(e => {
        console.warn(`[${g.name}] 本月收入获取失败:`, e.message);
        g.monthRevenue = 0;
      }).finally(() => {
        g.monthLoading = false; renderAll();
      });

      // 4) 本月 DAU 区间（拿今日 DAU + list，供预估用）
      const p4 = fetchGameDAURange(appId, monthStart, today).then(map => {
        monthDauMap = map;
      }).catch(e => {
        console.warn(`[${g.name}] 本月 DAU 获取失败:`, e.message);
      });

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
      }).catch(e => {
        console.warn(`[${g.name}] 累计总收入获取失败:`, e.message);
        g.totalRevenue = 0;
      }).finally(() => {
        g.totalLoading = false; renderAll();
      });

      // 等全部完成
      await Promise.all([p1, p2, p3, p4, p5, p6]);

      // 7) 算今日预估（依赖 3 + 4）
      try {
        const est = computeTodayEstimate(monthRevList, monthDauMap);
        g.todayEstimate = est.estimate;
        g.todayEstimateArpu = est.arpu;
      } catch (e) {
        console.warn(`[${g.name}] 今日预估计算失败:`, e.message);
        g.todayEstimate = 0;
      } finally {
        g.estimateLoading = false;
        renderAll();
      }
    });

    await Promise.all(promises);
    loadingRevenue = false;
  }

  // ========== 渲染 ==========
  function renderSummary(games) {
    const publishedGames = games.filter(g => g.published);
    const todayGot = publishedGames.filter(g => g.todayRevenue != null);
    const monthGot = publishedGames.filter(g => g.monthRevenue != null);
    const totalGot = publishedGames.filter(g => g.totalRevenue != null);
    const estGot = publishedGames.filter(g => g.todayEstimate != null);

    const todayTotal = todayGot.reduce((s, g) => s + (g.todayRevenue || 0), 0);
    const monthTotal = monthGot.reduce((s, g) => s + (g.monthRevenue || 0), 0);
    const grandTotal = totalGot.reduce((s, g) => s + (g.totalRevenue || 0), 0);
    const estimateTotal = estGot.reduce((s, g) => s + (g.todayEstimate || 0), 0);

    // 昨日预估：当实际昨日收入为 0 时，用 ARPU × 昨日 DAU 估算；汇总后仍显示为 0 则启用预估
    const yesterdayEstimateTotal = todayGot.reduce((s, g) => {
      if (g.todayRevenue > 0) return s + g.todayRevenue;
      if (g.todayEstimateArpu > 0 && g.todayDAU > 0) return s + g.todayEstimateArpu * g.todayDAU;
      return s;
    }, 0);
    const useYesterdayEstimate = todayTotal === 0 && yesterdayEstimateTotal > 0;

    const publishedCount = publishedGames.length;

    // 金额滚动动画（从当前显示值接力到新值）
    animateValue(document.getElementById('summary-today'), useYesterdayEstimate ? yesterdayEstimateTotal : todayTotal, 600, fmtMoney);
    animateValue(document.getElementById('summary-month'), monthTotal, 600, fmtMoney);
    animateValue(document.getElementById('summary-total'), grandTotal, 800, fmtMoney);
    animateValue(document.getElementById('summary-estimate'), estimateTotal, 700, fmtMoney);

    // 昨日收入/预估标签切换
    document.getElementById('summary-today-label').textContent = useYesterdayEstimate ? '昨日预估' : '昨日收入';

    // 月度目标进度
    renderMonthGoal(monthTotal, monthGot.length, publishedCount);
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
      const iconHTML = g.icon
        ? `<img src="${g.icon}" alt="${g.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="icon-fallback" style="display:none;">${g.name.charAt(0)}</span>`
        : `<span>${g.name.charAt(0)}</span>`;

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
        todayHTML = `<div class="game-metric-value muted">—</div>
                     <div class="game-metric-label">昨日收入</div>`;
      } else {
        const useEst = g.todayRevenue === 0 && g.todayEstimateArpu > 0 && g.todayDAU > 0;
        const revValue = useEst ? (g.todayEstimateArpu * g.todayDAU) : g.todayRevenue;
        const momRev = momTagHTML(revValue, g.prevDayRevenue);
        const label = useEst ? '昨日预估' : '昨日收入';
        const estCls = useEst ? ' is-estimate' : '';
        todayHTML = `<div class="game-metric-value${estCls}">¥${fmt(revValue)}</div>
                     <div class="game-metric-label">${label} ${momRev}</div>`;
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
        const useEst = g.todayRevenue === 0 && g.todayEstimateArpu > 0 && g.todayDAU > 0;
        const arpu = g.todayDAU > 0 ? (useEst ? g.todayEstimateArpu : g.todayRevenue / g.todayDAU) : 0;
        const momDau = momTagHTML(g.todayDAU, g.prevDayDAU);
        const arpuLabel = useEst ? '预估转化' : '转化率';
        dauHTML = `<div class="game-metric-value">${(g.todayDAU||0).toLocaleString('zh-CN')}</div>
                   <div class="game-metric-label">昨日日活 ${momDau}</div>
                   <div class="game-metric-sub">${arpuLabel} ${(arpu * 100).toFixed(1)}%</div>`;
      }

      // 本月数据块
      let monthHTML;
      if (!g.published) {
        monthHTML = `<div class="game-metric-value muted">—</div>
                     <div class="game-metric-label">本月</div>`;
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

      // 名称下方：今日预估 pill（橙）+ 累计 pill（青）并排
      let subHTML;
      if (!g.published) {
        subHTML = `<span class="game-sub-hint">未发布 · 点击查看详情</span>`;
      } else {
        const pills = [];
        // 今日预估 pill（醒目橙色）
        if (g.estimateLoading) {
          pills.push(`<span class="game-est-pill is-loading">预估中…</span>`);
        } else if (g.todayEstimate != null && g.todayEstimate > 0) {
          pills.push(`<span class="game-est-pill">今日预估 ¥${fmt(g.todayEstimate)}</span>`);
        }
        // 累计 pill
        if (g.totalLoading) {
          pills.push(`<span class="game-sub-hint">累计统计中…</span>`);
        } else if (g.totalRevenue != null && g.totalRevenue > 0) {
          pills.push(`<span class="game-total-pill">累计 ¥${fmt(g.totalRevenue)}</span>`);
        }
        subHTML = pills.length > 0 ? pills.join('') : `<span class="game-sub-hint">点击查看详情</span>`;
      }

      return `
        <div class="game-card ${g.published ? '' : 'is-unpublished'}" data-app-id="${g.appId}"${animStyle}>
          <div class="game-card-top">
            <div class="game-icon">${iconHTML}</div>
            <div class="game-info">
              <div class="game-name">${g.name} ${statusBadge}</div>
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
        <div class="empty-state"><p>APP HOST REQUIRED</p><p>请从 Android 应用进入收益控制台</p></div>
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
    const activeName = document.getElementById('active-account-name');
    const activeId = document.getElementById('active-account-id');
    if (activeName) activeName.textContent = `TapTap ${DEVELOPER_ID}`;
    if (activeId) activeId.textContent = `DEVELOPER ID / ${DEVELOPER_ID}`;
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
    document.getElementById('api-open-btn').addEventListener('click', async () => {
      await window.electronAPI.openExplorer();
    });
    document.getElementById('api-clear-btn').addEventListener('click', async () => {
      await window.electronAPI.clearCapturedApis();
      capturedApis = [];
      expandedApi = null;
      renderApiList();
    });
    // 批量重放关键 API 并存到文件
    document.getElementById('api-replay-btn').addEventListener('click', async () => {
      const btn = document.getElementById('api-replay-btn');
      const oldText = btn.textContent;
      btn.textContent = '重放中...';
      btn.disabled = true;
      try {
        const res = await window.electronAPI.replayKeyApis();
        btn.textContent = `完成: ${res.count} 条已保存`;
        setTimeout(() => {
          btn.textContent = oldText;
          btn.disabled = false;
        }, 3000);
      } catch (e) {
        btn.textContent = '失败: ' + e.message;
        setTimeout(() => {
          btn.textContent = oldText;
          btn.disabled = false;
        }, 3000);
      }
    });
    window.electronAPI.onApisUpdated(() => {
      refreshApis();
    });
  }

  document.getElementById('refresh-btn').addEventListener('click', () => {
    const btn = document.getElementById('refresh-btn');
    const icon = btn.querySelector('svg');
    if (icon) {
      icon.style.transition = 'transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)';
      icon.style.transform = 'rotate(360deg)';
      setTimeout(() => {
        icon.style.transition = 'none';
        icon.style.transform = 'rotate(0deg)';
      }, 600);
    }

    // 重置错落淡入标志，让卡片重新动画（在 fetchAppList 成功后触发）
    if (isElectron) {
      // 重新拉取
      init();
    } else {
      firstRenderDone = false;
      renderAll();
    }
  });

  const toggleUnpublished = document.getElementById('toggle-unpublished');
  if (toggleUnpublished) {
    toggleUnpublished.addEventListener('change', () => {
      showUnpublished = toggleUnpublished.checked;
      renderAll();
    });
  }

  // ========== 设置面板 ==========
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');
  const settingDark = document.getElementById('setting-dark');
  const settingExplorer = document.getElementById('setting-explorer');
  const settingAutorefresh = document.getElementById('setting-autorefresh');
  const settingMonthGoal = document.getElementById('setting-month-goal');
  const settingMonthGoalSave = document.getElementById('setting-month-goal-save');

  // 自动刷新定时器（5 分钟）
  const AUTOREFRESH_INTERVAL = 5 * 60 * 1000;
  let autoRefreshTimer = null;

  // 轻量刷新：只重新拉取收入数据（不重新拉 App 列表）
  function lightRefresh() {
    if (!isElectron || GAMES.length === 0) return;
    // firstRenderDone 保持 true，避免卡片重新触发错落动画
    fetchAllRevenue();
  }

  function applyAutoRefresh() {
    const on = localStorage.getItem(SETTINGS_KEYS.autorefresh) === '1';
    if (on && !autoRefreshTimer) {
      autoRefreshTimer = setInterval(lightRefresh, AUTOREFRESH_INTERVAL);
    } else if (!on && autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  // ========== 账号管理 ==========
  async function renderAccountList() {
    const listEl = document.getElementById('account-list');
    if (!listEl || !isElectron) return;
    const data = await window.electronAPI.getAccounts();
    listEl.innerHTML = data.accounts.map(acc => `
      <div class="account-item ${acc.id === data.current ? 'is-current' : ''}" data-id="${acc.id}">
        <div class="account-item-info">
          <div class="account-item-name">${acc.name}</div>
          <div class="account-item-id">ID: ${acc.developerId}</div>
        </div>
        ${acc.id === data.current
          ? '<span class="account-item-tag">当前</span>'
          : `<button class="account-item-btn" data-action="switch">切换</button>`
        }
        <button class="account-item-btn danger" data-action="remove">×</button>
      </div>
    `).join('');
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
    settingDark.checked = localStorage.getItem(SETTINGS_KEYS.theme) === 'dark';
    settingExplorer.checked = localStorage.getItem(SETTINGS_KEYS.explorer) === '1';
    if (settingAutorefresh) {
      settingAutorefresh.checked = localStorage.getItem(SETTINGS_KEYS.autorefresh) === '1';
    }
    if (settingMonthGoal) {
      const goal = localStorage.getItem(SETTINGS_KEYS.monthGoal);
      settingMonthGoal.value = goal ? parseFloat(goal) : '';
    }
    settingsModal.hidden = false;
    renderAccountList();
  }
  function closeSettings() {
    if (!settingsModal) return;
    settingsModal.hidden = true;
  }
  if (settingsBtn) {
    const accountManageBtn = document.getElementById('account-manage-btn');
    if (accountManageBtn) accountManageBtn.addEventListener('click', openSettings);
    settingsBtn.addEventListener('click', openSettings);
    settingsOverlay.addEventListener('click', closeSettings);
    settingsClose.addEventListener('click', closeSettings);
    bindAccountEvents();
    settingDark.addEventListener('change', () => {
      localStorage.setItem(SETTINGS_KEYS.theme, settingDark.checked ? 'dark' : 'light');
      applyTheme();
    });
    settingExplorer.addEventListener('change', () => {
      localStorage.setItem(SETTINGS_KEYS.explorer, settingExplorer.checked ? '1' : '0');
      applyExplorer();
    });
    if (settingAutorefresh) {
      settingAutorefresh.addEventListener('change', () => {
        localStorage.setItem(SETTINGS_KEYS.autorefresh, settingAutorefresh.checked ? '1' : '0');
        applyAutoRefresh();
      });
    }
    if (settingMonthGoal && settingMonthGoalSave) {
      const saveGoal = () => {
        const val = parseFloat(settingMonthGoal.value);
        if (val > 0) {
          localStorage.setItem(SETTINGS_KEYS.monthGoal, String(val));
        } else {
          localStorage.removeItem(SETTINGS_KEYS.monthGoal);
        }
        // 按钮反馈
        const oldText = settingMonthGoalSave.textContent;
        settingMonthGoalSave.textContent = '已保存 ✓';
        settingMonthGoalSave.classList.add('is-saved');
        setTimeout(() => {
          settingMonthGoalSave.textContent = oldText;
          settingMonthGoalSave.classList.remove('is-saved');
        }, 1500);
        // 立即重渲染进度条
        renderAll();
      };
      settingMonthGoalSave.addEventListener('click', saveGoal);
      settingMonthGoal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveGoal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
    });
  }

  // 启动自动刷新（如果之前开过）
  applyAutoRefresh();

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
        if (settingsModal && !settingsModal.hidden) renderAccountList();
      });
    }
    // 托盘菜单"刷新数据"触发
    if (window.electronAPI.onTrayRefresh) {
      window.electronAPI.onTrayRefresh(() => {
        init();
      });
    }
  }

  // 启动
  init();
})();
