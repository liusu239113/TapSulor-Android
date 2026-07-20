/**
 * detail.js - 详情页逻辑（Electron 渲染进程）
 *
 * 信息架构：
 *   1. 游戏概览（固定）：昨日收入 / 昨日日活+转化率 / 本月收入
 *   2. 游戏整体（小条）：次留 / 3留 / 7留 / 启动率 / 人均时长（不随月份变，取最近有数据的一天）
 *   3. 累计总收入横条
 *   4. 月份选择器（从游戏最早有数据的月份开始可选）
 *   5. 该月汇总：总收入 / 总日活 / 平均转化率
 *   6. 每日明细网格（日历式，点击某天弹出当天详情 —— 经营数据 + 转化效果）
 *
 * 数据来源：
 *   - 收入: mini-app/v1/ad/payout-report-data (start_time / end_time)
 *   - 日活/新增: mini-app/v1/stats-by-day/device (start_date / end_date)
 *   - 留存: mini-app/v1/stats-by-day/ret
 *   - 启动率: mini-app/v1/stats-by-day/conversion
 *   - 人均时长: mini-app/v1/stats-by-day/duration
 *   - 转化效果(曝光/点击/转化): dashboard/v2/stats-by-day/position/cn (platform=android)
 */

(function () {
  'use strict';

  // 主题同步（设置在首页，存 localStorage）
  document.documentElement.setAttribute('data-theme', 'dark');

  const API_BASE = 'https://developer.taptap.cn/api';
  const REVENUE_URL = `${API_BASE}/mini-app/v1/ad/payout-report-data`;
  const DAU_URL = `${API_BASE}/mini-app/v1/stats-by-day/device`;
  const RET_URL = `${API_BASE}/mini-app/v1/stats-by-day/ret`;
  const CONV_URL = `${API_BASE}/mini-app/v1/stats-by-day/conversion`;
  const DUR_URL = `${API_BASE}/mini-app/v1/stats-by-day/duration`;
  const POSITION_URL = `${API_BASE}/dashboard/v2/stats-by-day/position/cn`;
  let DEVELOPER_ID = null;

  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  let currentGame = null;
  let currentMonthData = null;      // 当前月数据 { dailyList, monthTotal, monthDau }
  let grandTotal = null;            // 累计总收入
  let earliestMonth = null;         // 最早有数据的月份 YYYY-MM
  let currentSelectedMonth = null;  // 当前选中月份 YYYY-MM
  let pickerYear = null;            // 月份面板当前显示的年份

  // ========== 工具 ==========
  function fmt(n) {
    if (n == null || isNaN(n)) return '0.00';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('zh-CN');
  }
  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }
  function todayStr() {
    return formatDate(new Date());
  }
  // 前天（昨日环比基准）
  function dayBeforeStr() {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return formatDate(d);
  }
  function monthStartStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  function currentMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // 上月同期：上月1号 ~ 上月今日对应的同一天（本月环比基准）
  function lastMonthSameDayRange() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const day = now.getDate();
    const lastMonthEnd = new Date(y, m, 0);
    const lastMonthDay = Math.min(day, lastMonthEnd.getDate());
    return {
      start: formatDate(new Date(y, m - 1, 1)),
      end: formatDate(new Date(y, m - 1, lastMonthDay))
    };
  }
  // 环比百分比
  function momPct(cur, prev) {
    if (prev == null || prev === 0 || isNaN(prev)) return null;
    if (cur == null || isNaN(cur)) return null;
    return (cur - prev) / prev * 100;
  }
  // 生成环比标签 HTML（详情页概览在白色卡片上，用深色字版本）
  function momTagHTML(cur, prev) {
    const pct = momPct(cur, prev);
    if (pct == null) return '';
    const abs = Math.abs(pct);
    if (abs < 0.05) return '<span class="mom-tag flat">持平</span>';
    const sign = pct > 0 ? '↑' : '↓';
    const cls = pct > 0 ? 'up' : 'down';
    return `<span class="mom-tag ${cls}">${sign} ${abs.toFixed(1)}%</span>`;
  }
  function monthLabel(yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number);
    return `${y}年${m}月`;
  }

  async function apiFetch(url) {
    if (isElectron) {
      const res = await window.electronAPI.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.body);
    } else {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }
  }

  // ========== 数据获取 ==========
  async function fetchGameRevenue(appId, startDate, endDate) {
    const url = `${REVENUE_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_time=${startDate}&end_time=${endDate}`;
    const json = await apiFetch(url);
    if (!json.success || !json.data) {
      throw new Error(json.data && json.data.msg || '收入接口返回失败');
    }
    const list = json.data.list || [];
    const total = json.data.total != null
      ? parseFloat(json.data.total)
      : list.reduce((s, i) => s + (parseFloat(i.revenue) || 0), 0);
    return { ok: true, total, list };
  }

  // 获取某日期范围的每日日活，返回 { 'YYYY-MM-DD': { dau, newUsers } }
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

  // 获取某日期范围的每日「额外指标」：留存 / 启动率 / 人均时长
  // 返回 { 'YYYY-MM-DD': { retA1d, retA3d, retA7d, startRate, apkInstallRate, durationAvg } }
  async function fetchGameExtraRange(appId, startDate, endDate) {
    const q = `developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${startDate}&end_date=${endDate}`;
    const [ret, conv, dur] = await Promise.all([
      apiFetch(`${RET_URL}?${q}`).catch(() => null),
      apiFetch(`${CONV_URL}?${q}`).catch(() => null),
      apiFetch(`${DUR_URL}?${q}`).catch(() => null)
    ]);
    const map = {};
    const ensure = (d) => (map[d] || (map[d] = {}));
    if (ret && ret.success && ret.data && ret.data.list) {
      ret.data.list.forEach(i => {
        const e = ensure(i.date);
        e.retA1d = i.ret_new_active_device_rate_a1d;
        e.retA3d = i.ret_new_active_device_rate_a3d;
        e.retA7d = i.ret_new_active_device_rate_a7d;
      });
    }
    if (conv && conv.success && conv.data && conv.data.list) {
      conv.data.list.forEach(i => {
        const e = ensure(i.date);
        e.startRate = i.mini_app_start_rate;
        e.apkInstallRate = i.apk_install_rate;
      });
    }
    if (dur && dur.success && dur.data && dur.data.list) {
      dur.data.list.forEach(i => {
        const e = ensure(i.date);
        e.durationAvg = i.spend_duration_min_avg;
      });
    }
    return map;
  }

  // 获取某日期范围的每日「转化效果」（TapTap 商店转化漏斗）
  // 返回 { 'YYYY-MM-DD': { impression, click, clickRate, convDetail, convDetailRate, convTotal } }
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

  // 获取某日期范围的每日「人均时长」（分钟），返回 { 'YYYY-MM-DD': durationAvg }
  async function fetchGameDurationRange(appId, startDate, endDate) {
    const url = `${DUR_URL}?developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${startDate}&end_date=${endDate}`;
    const json = await apiFetch(url).catch(() => null);
    const map = {};
    if (json && json.success && json.data && json.data.list) {
      json.data.list.forEach(i => { map[i.date] = i.spend_duration_min_avg; });
    }
    return map;
  }

  // 获取某月的每日数据（收入 + 日活 + 转化效果 + 人均时长 合并）
  async function fetchMonthData(yearMonth) {
    const { start, end } = getMonthRange(yearMonth);
    // 收益是 T+1（截到昨天）；日活/新增、曝光漏斗当天可实时获取，故拉取到今天
    const liveEnd = (currentSelectedMonth === currentMonthStr()) ? todayStr() : end;
    const [revRes, dauMap, posMap, durMap] = await Promise.all([
      fetchGameRevenue(currentGame.appId, start, end).catch(e => {
        console.warn('收入获取失败:', e.message);
        return { ok: false, total: null, list: [], error: e.message };
      }),
      fetchGameDAURange(currentGame.appId, start, liveEnd).catch(e => {
        console.warn('DAU 获取失败:', e.message);
        return {};
      }),
      fetchGamePositionRange(currentGame.appId, start, liveEnd).catch(e => {
        console.warn('转化效果获取失败:', e.message);
        return {};
      }),
      fetchGameDurationRange(currentGame.appId, start, liveEnd).catch(e => {
        console.warn('人均时长获取失败:', e.message);
        return {};
      })
    ]);

    const dailyMap = {};
    (revRes.list || []).forEach(item => {
      dailyMap[item.date] = {
        date: item.date,
        revenue: Number.isFinite(parseFloat(item.revenue)) ? parseFloat(item.revenue) : null,
        dau: 0,
        newUsers: 0
      };
    });
    Object.entries(dauMap).forEach(([date, info]) => {
      if (!dailyMap[date]) {
        dailyMap[date] = { date, revenue: null, dau: 0, newUsers: 0 };
      }
      dailyMap[date].dau = info.dau;
      dailyMap[date].newUsers = info.newUsers;
    });
    Object.entries(posMap).forEach(([date, info]) => {
      if (!dailyMap[date]) {
        dailyMap[date] = { date, revenue: null, dau: 0, newUsers: 0 };
      }
      Object.assign(dailyMap[date], info);
    });
    Object.entries(durMap).forEach(([date, v]) => {
      if (!dailyMap[date]) {
        dailyMap[date] = { date, revenue: null, dau: 0, newUsers: 0 };
      }
      dailyMap[date].durationAvg = v;
    });

    const dailyList = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    const monthTotal = revRes.ok === false
      ? null
      : (revRes.total != null ? revRes.total : dailyList.reduce((s, d) => s + (d.revenue || 0), 0));
    const monthDau = dailyList.reduce((s, d) => s + (d.dau || 0), 0);

    console.log(`[${currentGame.name}] ${yearMonth} 查询范围 ${start}~${end}(实时至${liveEnd}), 收入${revRes.list.length}条, DAU${Object.keys(dauMap).length}条, 转化效果${Object.keys(posMap).length}条, 合并后${dailyList.length}天`);
    return { dailyList, monthTotal, monthDau, revenueOk: revRes.ok !== false };
  }

  // 计算月份的查询范围（当前月只查到昨天）
  function getMonthRange(yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    let end = new Date(y, m, 0); // 月末
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    if (end > yesterday) end = yesterday;
    return { start: formatDate(start), end: formatDate(end) };
  }

  // 探测累计总收入 + 最早有数据的月份（大范围一次性查询）
  async function probeGrandTotal() {
    try {
      const data = await fetchGameRevenue(currentGame.appId, '2020-01-01', yesterdayStr());
      grandTotal = data.total != null ? data.total : null;
      if (data.list && data.list.length > 0) {
        const sorted = [...data.list].sort((a, b) => a.date.localeCompare(b.date));
        earliestMonth = sorted[0].date.substring(0, 7);
      } else {
        earliestMonth = currentMonthStr();
      }
    } catch (e) {
      console.warn('探测失败:', e.message);
      earliestMonth = currentMonthStr();
      grandTotal = null;
    }
    updateMonthTitle();
    renderGrandTotal();
  }

  // 获取游戏概览（昨日收入/昨日日活/本月收入 + 环比基准）
  async function fetchOverview() {
    const yesterday = yesterdayStr();
    const dayBefore = dayBeforeStr();
    const today = todayStr();
    const monthStart = monthStartStr();
    const lmRange = lastMonthSameDayRange();

    // 并发：近2天收入 / 近2天 DAU / 本月收入 / 上月同期收入
    const [rev2d, dau2dMap, monthRev, lastMonthRev] = await Promise.all([
      fetchGameRevenue(currentGame.appId, dayBefore, yesterday).catch(e => {
        console.warn('近2天收入获取失败:', e.message);
        return { ok: false, total: null, list: [], error: e.message };
      }),
      fetchGameDAURange(currentGame.appId, dayBefore, yesterday).catch(e => {
        console.warn('近2天 DAU 获取失败:', e.message);
        return {};
      }),
      fetchGameRevenue(currentGame.appId, monthStart, today).catch(e => {
        console.warn('本月收入获取失败:', e.message);
        return { ok: false, total: null, list: [], error: e.message };
      }),
      fetchGameRevenue(currentGame.appId, lmRange.start, lmRange.end).catch(e => {
        console.warn('上月同期收入获取失败:', e.message);
        return { total: null };
      })
    ]);

    // 从近2天收入 list 取昨天和前天
    const revList = rev2d.list || [];
    const yRevItem = revList.find(i => i.date === yesterday);
    const dRevItem = revList.find(i => i.date === dayBefore);
    const yesterdayRevenue = rev2d.ok === false
      ? null
      : (yRevItem ? (parseFloat(yRevItem.revenue) || 0) : null);
    const prevDayRevenue = dRevItem ? (parseFloat(dRevItem.revenue) || 0) : null;

    // 从近2天 DAU map 取昨天和前天
    const yesterdayDAU = (dau2dMap[yesterday] && dau2dMap[yesterday].dau) || 0;
    const prevDayDAU = (dau2dMap[dayBefore] && dau2dMap[dayBefore].dau) || null;

    const monthRevenue = monthRev.ok === false ? null : monthRev.total;
    const lastMonthRevenue = lastMonthRev.total;

    renderOverview({
      yesterdayRevenue, yesterdayDAU, monthRevenue,
      prevDayRevenue, prevDayDAU, lastMonthRevenue
    });
  }

  // ========== 游戏整体（留存 / 启动率 / 时长）—— 小区域 ==========
  // 直接取各接口自带的近30天汇总值 data.total（即后台「游戏整体」口径）
  async function fetchGameOverallMetrics(appId) {
    const end = yesterdayStr();
    const startD = new Date();
    startD.setDate(startD.getDate() - 29); // 近 30 天（含 end）
    const start = formatDate(startD);
    const q = `developer_id=${DEVELOPER_ID}&app_id=${appId}&start_date=${start}&end_date=${end}`;
    const [ret, conv, dur] = await Promise.all([
      apiFetch(`${RET_URL}?${q}`).catch(() => null),
      apiFetch(`${CONV_URL}?${q}`).catch(() => null),
      apiFetch(`${DUR_URL}?${q}`).catch(() => null)
    ]);
    const rt = (ret && ret.data && ret.data.total) || {};
    const cv = (conv && conv.data && conv.data.total) || {};
    const dr = (dur && dur.data && dur.data.total) || {};
    return {
      retA1d: rt.ret_new_active_device_rate_a1d,
      retA3d: rt.ret_new_active_device_rate_a3d,
      retA7d: rt.ret_new_active_device_rate_a7d,
      startRate: cv.mini_app_start_rate,
      durationAvg: dr.spend_duration_min_avg
    };
  }

  async function loadGameOverall() {
    const m = await fetchGameOverallMetrics(currentGame.appId).catch(() => ({}));
    renderGameOverall(m);
  }

  function ensureGameOverallStrip() {
    let strip = document.getElementById('game-overall');
    if (strip) return strip;
    strip = document.createElement('div');
    strip.className = 'game-overall';
    strip.id = 'game-overall';
    strip.innerHTML =
      '<span class="go-title">游戏整体</span>' +
      '<span class="go-item"><i>次留</i><b id="go-ret1">—</b></span>' +
      '<span class="go-item"><i>3留</i><b id="go-ret3">—</b></span>' +
      '<span class="go-item"><i>7留</i><b id="go-ret7">—</b></span>' +
      '<span class="go-item"><i>启动率</i><b id="go-start">—</b></span>' +
      '<span class="go-item"><i>时长</i><b id="go-dur">—</b></span>';
    const anchor = document.querySelector('.overview-card');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(strip, anchor.nextSibling);
    } else {
      document.querySelector('.app').appendChild(strip);
    }
    return strip;
  }

  function renderGameOverall(d) {
    ensureGameOverallStrip();
    // 归一化：'-'、null、'' 视为无数据 → '—'
    const norm = (v) => (v == null || v === '' || v === '-') ? '—' : String(v);
    document.getElementById('go-ret1').textContent = norm(d && d.retA1d);
    document.getElementById('go-ret3').textContent = norm(d && d.retA3d);
    document.getElementById('go-ret7').textContent = norm(d && d.retA7d);
    document.getElementById('go-start').textContent = norm(d && d.startRate);
    const dur = d && d.durationAvg;
    document.getElementById('go-dur').textContent =
      (dur != null && dur !== '' && dur !== '-') ? (dur + '分') : '—';
  }

  // ========== 月份选择器 ==========
  function updateMonthTitle() {
    document.getElementById('month-title-text').textContent = monthLabel(currentSelectedMonth);
    updateNavButtons();
  }

  function updateNavButtons() {
    const prev = document.getElementById('prev-month');
    const next = document.getElementById('next-month');
    const cur = currentMonthStr();
    const start = earliestMonth || cur;
    prev.disabled = !earliestMonth || currentSelectedMonth <= start;
    next.disabled = currentSelectedMonth >= cur;
  }

  function shiftMonth(delta) {
    const [y, m] = currentSelectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const start = earliestMonth || currentMonthStr();
    if (newMonth < start) return;
    if (newMonth > currentMonthStr()) return;
    currentSelectedMonth = newMonth;
    updateMonthTitle();
    loadMonth();
  }

  // 月份面板
  function openMonthPicker() {
    pickerYear = parseInt(currentSelectedMonth.split('-')[0], 10);
    renderMonthPicker();
    document.getElementById('month-picker').hidden = false;
    document.getElementById('month-title').classList.add('active');
  }

  function closeMonthPicker() {
    document.getElementById('month-picker').hidden = true;
    document.getElementById('month-title').classList.remove('active');
  }

  function toggleMonthPicker() {
    const picker = document.getElementById('month-picker');
    if (picker.hidden) openMonthPicker();
    else closeMonthPicker();
  }

  function renderMonthPicker() {
    document.getElementById('mp-year-label').textContent = pickerYear;
    const earliestY = earliestMonth ? parseInt(earliestMonth.split('-')[0], 10) : pickerYear;
    const earliestM = earliestMonth ? parseInt(earliestMonth.split('-')[1], 10) : 1;
    const cur = currentMonthStr();
    const [curY, curM] = cur.split('-').map(Number);
    const [selY, selM] = currentSelectedMonth.split('-').map(Number);

    document.getElementById('mp-prev-year').disabled = pickerYear <= earliestY;
    document.getElementById('mp-next-year').disabled = pickerYear >= curY;

    const grid = document.getElementById('mp-month-grid');
    const btns = [];
    for (let m = 1; m <= 12; m++) {
      const val = `${pickerYear}-${String(m).padStart(2, '0')}`;
      const isDisabled = (pickerYear === earliestY && m < earliestM) || (pickerYear === curY && m > curM);
      const isSelected = (pickerYear === selY && m === selM);
      btns.push(`<button class="mp-month-btn ${isSelected ? 'is-selected' : ''}" data-month="${val}" ${isDisabled ? 'disabled' : ''}>${m}月</button>`);
    }
    grid.innerHTML = btns.join('');
  }

  function pickMonth(val) {
    currentSelectedMonth = val;
    closeMonthPicker();
    updateMonthTitle();
    loadMonth();
  }

  // ========== 渲染 ==========
  function renderGameInfo(game) {
    document.getElementById('detail-game-name').textContent = game.name;
    document.getElementById('detail-game-id').textContent = 'ID: ' + game.appId;
    const iconEl = document.getElementById('detail-game-icon');
    if (game.icon) {
      const img = document.createElement('img');
      img.src = game.icon;
      img.alt = game.name || '应用图标';
      img.addEventListener('error', () => {
        iconEl.textContent = game.name ? game.name.charAt(0) : '?';
      }, { once: true });
      iconEl.replaceChildren(img);
    } else {
      iconEl.textContent = game.name ? game.name.charAt(0) : '?';
    }
  }

  function renderOverview(data) {
    if (!data) return;
    document.getElementById('ov-yesterday-rev').textContent = data.yesterdayRevenue == null ? '暂无' : '¥' + fmt(data.yesterdayRevenue);
    document.getElementById('ov-yesterday-dau').textContent = fmtInt(data.yesterdayDAU);
    const conv = data.yesterdayRevenue != null && data.yesterdayDAU > 0 ? (data.yesterdayRevenue / data.yesterdayDAU * 100) : null;
    document.getElementById('ov-conversion').textContent = conv == null ? '转化率 —' : '转化率 ' + conv.toFixed(1) + '%';
    document.getElementById('ov-month-rev').textContent = data.monthRevenue == null ? '暂无' : '¥' + fmt(data.monthRevenue);

    // 环比标签
    const momRevEl = document.getElementById('mom-ov-rev');
    const momDauEl = document.getElementById('mom-ov-dau');
    const momMonthEl = document.getElementById('mom-ov-month');
    if (momRevEl) momRevEl.innerHTML = momTagHTML(data.yesterdayRevenue, data.prevDayRevenue);
    if (momDauEl) momDauEl.innerHTML = momTagHTML(data.yesterdayDAU, data.prevDayDAU);
    if (momMonthEl) momMonthEl.innerHTML = momTagHTML(data.monthRevenue, data.lastMonthRevenue);
  }

  function renderGrandTotal() {
    if (grandTotal == null) {
      document.getElementById('grand-total').textContent = '¥—';
    } else {
      document.getElementById('grand-total').textContent = '¥' + fmt(grandTotal);
    }
  }

  function renderMonthSummary(data) {
    if (!data || data.monthTotal == null) {
      document.getElementById('ms-total').textContent = '暂无';
      document.getElementById('ms-dau').textContent = data ? fmtInt(data.monthDau) : '—';
      document.getElementById('ms-conv').textContent = '—';
      return;
    }
    document.getElementById('ms-total').textContent = '¥' + fmt(data.monthTotal);
    document.getElementById('ms-dau').textContent = fmtInt(data.monthDau);
    const conv = data.monthDau > 0 ? (data.monthTotal / data.monthDau * 100) : 0;
    document.getElementById('ms-conv').textContent = conv.toFixed(1) + '%';
  }

  function renderDailyGrid(data) {
    const grid = document.getElementById('daily-grid');
    const dailyList = (data && data.dailyList) ? data.dailyList : [];
    const isCurrentMonth = currentSelectedMonth === currentMonthStr();
    const revenueUnavailable = data && data.revenueOk === false;

    // 过去的月份且完全无数据：直接提示（未来/当前月仍渲染整月网格）
    if (dailyList.length === 0 && !isCurrentMonth) {
      grid.innerHTML = '<div class="loading-tip">该月暂无数据</div>';
      return;
    }

    // 日期 -> 数据 映射，便于按天查表
    const map = {};
    dailyList.forEach(d => { map[d.date] = d; });

    // 当前选中月份的年/月/天数（整月渲染，即使本月尚未结束）
    const [year, month] = currentSelectedMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();

    // 月初是周几（周一=0），补前置空格对齐日历
    let firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0=周日 ... 6=周六
    firstDayOfWeek = (firstDayOfWeek + 6) % 7; // 转为 周一=0

    const todayS = todayStr();

    const cells = [];
    // 前置空格
    for (let i = 0; i < firstDayOfWeek; i++) {
      cells.push('<div class="daily-cell cal-blank"></div>');
    }

    // 整月每一天
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const rec = map[dateStr];
      const isToday = dateStr === todayS;
      const isFuture = dateStr > todayS;
      const hasRevenue = !!(rec && rec.revenue != null);
      const hasData = !!(rec && (hasRevenue || rec.dau > 0));

      const animStyle = `animation: cardIn 0.3s ease-out both; animation-delay: ${Math.min(day - 1, 24) * 12}ms;`;

      let cls = 'daily-cell';
      let inner;

      if (isFuture) {
        // 本月尚未到达的天：占位
        cls += ' is-future';
        inner = `<div class="dc-day">${day}</div>` +
                `<div class="dc-placeholder">·</div>`;
      } else if (isToday) {
        // 今日：美术强调；收入为 T+1，通常次日才更新
        cls += ' is-today';
        if (hasRevenue) {
          const conv = rec.dau > 0 ? (rec.revenue / rec.dau * 100).toFixed(0) + '%' : '—';
          inner = `<div class="dc-day">${day}</div>` +
                  `<div class="dc-revenue">¥${fmt(rec.revenue)}</div>` +
                  `<div class="dc-sub">${fmtInt(rec.dau)} · <span class="dc-conv">${conv}</span></div>`;
        } else {
          inner = `<div class="dc-day">${day}</div>` +
                  `<div class="dc-today-label">今日</div>` +
                  `<div class="dc-sub dc-pending">待更新</div>`;
        }
      } else {
        // 过去的一天：有数据则展示，缺失记为 0
      const revenue = rec ? rec.revenue : null;
      const dau = rec ? rec.dau : 0;
      const conv = revenue != null && dau > 0 ? (revenue / dau * 100).toFixed(0) + '%' : '—';
      if (!rec || (revenue == null && dau === 0)) cls += ' is-empty';
      inner = `<div class="dc-day">${day}</div>` +
              `<div class="dc-revenue">${revenue == null ? '未同步' : '¥' + fmt(revenue)}</div>` +
              `<div class="dc-sub">${fmtInt(dau)} · <span class="dc-conv">${conv}</span></div>`;
      }

      // 非未来日期可点击查看当天详情
      const dataAttr = isFuture ? '' : ` data-date="${dateStr}"`;
      if (!isFuture) cls += ' is-clickable';
      cells.push(`<div class="${cls}"${dataAttr} style="${animStyle}">${inner}</div>`);
    }

    // 后置补齐到 7 的倍数（保持网格整齐）
    while (cells.length % 7 !== 0) {
      cells.push('<div class="daily-cell cal-blank"></div>');
    }

    grid.innerHTML = cells.join('');
  }

  // ========== 当天详情弹窗 ==========
  // 百分比/字符串型指标的安全展示
  function metricStr(v) {
    if (v == null || v === '' || v === '0' || v === '-') return '—';
    return String(v);
  }

  // 单个指标小格
  function dmCell(label, value, opts) {
    opts = opts || {};
    return '<div class="dm-cell' + (opts.strong ? ' is-strong' : '') + '">' +
             '<span class="dm-cell-value">' + value + '</span>' +
             '<span class="dm-cell-label">' + label + '</span>' +
           '</div>';
  }

  function ensureDayModal() {
    let overlay = document.getElementById('day-modal');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'day-modal';
    overlay.className = 'day-modal-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="day-modal-card" role="dialog" aria-modal="true">' +
        '<div class="day-modal-header">' +
          '<div class="day-modal-title" id="day-modal-title">—</div>' +
          '<button class="day-modal-close" id="day-modal-close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="day-modal-body" id="day-modal-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDayModal(); });
    document.getElementById('day-modal-close').addEventListener('click', closeDayModal);
    return overlay;
  }

  function closeDayModal() {
    const overlay = document.getElementById('day-modal');
    if (overlay) overlay.hidden = true;
  }

  function openDayDetail(dateStr) {
    const overlay = ensureDayModal();
    const list = (currentMonthData && currentMonthData.dailyList) ? currentMonthData.dailyList : [];
    const rec = list.find(d => d.date === dateStr) || { date: dateStr, revenue: null, dau: 0, newUsers: 0 };
    const isToday = dateStr === todayStr();
    const noData = !(rec.revenue != null || rec.dau > 0);

    const [y, m, d] = dateStr.split('-').map(Number);
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const wd = new Date(y, m - 1, d).getDay();
    document.getElementById('day-modal-title').innerHTML =
      `${m}月${d}日 <span class="dm-weak">${weekNames[wd]}</span>` +
      (isToday ? ' <span class="dm-badge">今日</span>' : '');

    // —— 经营数据：收益(主) + 活跃 / 新增 / 转化率 / 日均时长 ——
    // 收益 T+1 未结算时，用本月均值转化率 × 当日活跃 做预估，样式作区分
    const isEst = false;
    const arpuPct = rec.revenue != null && rec.dau > 0 ? (rec.revenue / rec.dau * 100) : null;
    const heroValue = rec.revenue == null ? '暂无' : ('¥' + fmt(rec.revenue));
    const heroLabel = rec.revenue == null ? '真实收益未同步' : '已结算收益';
    const convDisplay = arpuPct == null ? '—' : arpuPct.toFixed(1) + '%';
    const durVal = rec.durationAvg;
    const durDisplay = (durVal != null && durVal !== '' && durVal !== '-' && parseFloat(durVal) > 0) ? (durVal + '分') : '—';
    const bizSection =
      '<div class="dm-section">' +
        '<div class="dm-hero' + (isEst ? ' is-est' : '') + '">' +
          '<span class="dm-hero-label">' + heroLabel + '</span>' +
          '<span class="dm-hero-value">' + heroValue + '</span>' +
        '</div>' +
        (rec.revenue == null ? '<div class="dm-pending-tip">该日真实收益尚未同步，未使用预估值。</div>' : '') +
        '<div class="dm-grid dm-grid-4">' +
          dmCell('活跃', fmtInt(rec.dau)) +
          dmCell('新增', fmtInt(rec.newUsers)) +
          dmCell(isEst ? '均值转化率' : '转化率', convDisplay) +
          dmCell('日均时长', durDisplay) +
        '</div>' +
      '</div>';

    // —— 转化效果：曝光 / 点击 / 点击率 / 详情页转化量 / 详情页转化率 / 转化总量 ——
    const hasFunnel = rec.impression != null && rec.impression > 0;
    const funnelSection =
      '<div class="dm-section">' +
        '<div class="dm-section-title">转化效果</div>' +
        (hasFunnel
          ? '<div class="dm-grid dm-grid-3">' +
              dmCell('曝光', fmtInt(rec.impression)) +
              dmCell('点击', fmtInt(rec.click)) +
              dmCell('点击率', metricStr(rec.clickRate)) +
              dmCell('详情页转化', fmtInt(rec.convDetail)) +
              dmCell('详情页转化率', metricStr(rec.convDetailRate)) +
              dmCell('转化总量', fmtInt(rec.convTotal)) +
            '</div>'
          : '<div class="dm-empty">该日暂无投放 / 转化数据</div>') +
      '</div>';

    const body = document.getElementById('day-modal-body');
    const tip = (isToday && rec.revenue == null)
      ? '<div class="dm-pending-tip">今日真实收益尚未结算，当前只展示已返回的活跃数据。</div>'
      : '';
    body.innerHTML = tip + bizSection + funnelSection;

    overlay.hidden = false;
  }

  // ========== 趋势折线图 + 视图切换 ==========
  const TREND_METRICS = [
    { key: 'revenue', label: '收入', color: '#f97316' },
    { key: 'impression', label: '曝光', color: '#3b82f6' },
    { key: 'dau', label: '日活', color: '#10b981' },
    { key: 'conv', label: '转化率', color: '#8b5cf6' }
  ];
  let currentTrendMetric = 'all';   // 'all' = 四项合体；或单项 key
  let currentView = 'calendar';     // 'calendar' | 'trend'
  let trendPts = [];
  let trendGeom = null;             // { xs:[], series:[{key,color,ys:[]}] } 供悬停高亮定位

  function trendValue(rec, key) {
    if (key === 'revenue') return rec.revenue == null ? null : rec.revenue;
    if (key === 'impression') return rec.impression || 0;
    if (key === 'dau') return rec.dau || 0;
    if (key === 'conv') {
      return rec.revenue != null && rec.dau > 0 ? (rec.revenue / rec.dau * 100) : null;
    }
    return 0;
  }
  function trendFmt(key, v) {
    if (key === 'revenue') return '¥' + fmt(v);
    if (key === 'conv') return v.toFixed(1) + '%';
    return fmtInt(v);
  }
  function trendYLabel(key, v) {
    if (key === 'conv') return v.toFixed(0) + '%';
    if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + 'w';
    if (key === 'revenue') return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v));
    return String(Math.round(v));
  }
  function trendDateLabel(dateStr) {
    const p = dateStr.split('-');
    return parseInt(p[1], 10) + '月' + parseInt(p[2], 10) + '日';
  }
  function niceCeil(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
    return step * mag;
  }

  // 日历 / 趋势 分段切换控件（带图标 + 滑动高亮）
  function ensureViewSwitch() {
    let sw = document.getElementById('view-switch');
    if (sw) return sw;
    const header = document.querySelector('.cal-header');
    if (!header) return null;
    sw = document.createElement('div');
    sw.className = 'view-switch';
    sw.id = 'view-switch';
    const calIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const trendIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>';
    sw.innerHTML =
      '<span class="vs-thumb"></span>' +
      '<button class="vs-btn is-active" data-view="calendar">' + calIcon + '<span>日历</span></button>' +
      '<button class="vs-btn" data-view="trend">' + trendIcon + '<span>趋势</span></button>';
    header.parentNode.insertBefore(sw, header);
    sw.addEventListener('click', (e) => {
      const btn = e.target.closest('.vs-btn');
      if (!btn) return;
      setView(btn.getAttribute('data-view'));
    });
    return sw;
  }

  function setView(view) {
    currentView = view;
    const isTrend = view === 'trend';
    const sw = document.getElementById('view-switch');
    const card = document.getElementById('trend-card');
    const calHeader = document.querySelector('.cal-header');
    const grid = document.getElementById('daily-grid');
    if (sw) {
      sw.classList.toggle('is-trend', isTrend);
      sw.querySelectorAll('.vs-btn').forEach(b => {
        b.classList.toggle('is-active', b.getAttribute('data-view') === view);
      });
    }
    if (card) card.hidden = !isTrend;
    if (calHeader) calHeader.style.display = isTrend ? 'none' : '';
    if (grid) grid.style.display = isTrend ? 'none' : '';
    if (isTrend && currentMonthData) renderTrendChart(currentMonthData);
  }

  function ensureTrendCard() {
    let card = document.getElementById('trend-card');
    if (card) return card;
    const header = document.querySelector('.cal-header');
    if (!header) return null;
    card = document.createElement('div');
    card.className = 'trend-card';
    card.id = 'trend-card';
    card.hidden = true;
    card.innerHTML = '<div class="trend-tabs" id="trend-tabs"></div>' +
                     '<div class="trend-chart" id="trend-chart"></div>' +
                     '<div class="trend-legend" id="trend-legend"></div>' +
                     '<div class="trend-tip" id="trend-tip" hidden></div>';
    header.parentNode.insertBefore(card, header);
    card.querySelector('#trend-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.trend-tab');
      if (!btn) return;
      currentTrendMetric = btn.getAttribute('data-key');
      if (currentMonthData) renderTrendChart(currentMonthData);
    });
    const chart = card.querySelector('#trend-chart');
    const tip = card.querySelector('#trend-tip');
    chart.addEventListener('mousemove', (e) => {
      const hit = e.target.closest('.trend-hit');
      if (!hit) { tip.hidden = true; clearTrendFocus(chart); return; }
      const idx = parseInt(hit.getAttribute('data-idx'), 10);
      const rec = trendPts[idx];
      if (!rec) { tip.hidden = true; clearTrendFocus(chart); return; }
      const k = hit.getAttribute('data-key');
      let html;
      if (k) {
        html = '<b>' + trendDateLabel(rec.date) + '</b>' + trendFmt(k, trendValue(rec, k));
      } else {
        html = '<b>' + trendDateLabel(rec.date) + '</b>' +
               TREND_METRICS.map(m => '<span class="tt-row"><i style="background:' + m.color + '"></i>' + m.label + ' ' + trendFmt(m.key, trendValue(rec, m.key)) + '</span>').join('');
      }
      tip.innerHTML = html;
      tip.hidden = false;
      showTrendFocus(chart, idx);
      const cr = card.getBoundingClientRect();
      tip.style.left = (e.clientX - cr.left) + 'px';
      tip.style.top = (e.clientY - cr.top) + 'px';
    });
    chart.addEventListener('mouseleave', () => { tip.hidden = true; clearTrendFocus(chart); });
    return card;
  }

  // 通用坐标
  function trendAxis(pts, W, H) {
    const padL = 44, padR = 14, padT = 16, padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = pts.length;
    const x = i => padL + (n === 1 ? innerW / 2 : innerW * i / (n - 1));
    return { padL, padR, padT, padB, innerW, innerH, n, x };
  }
  function trendXLabels(pts, ax, H) {
    let xlab = '';
    const step = Math.max(1, Math.round((ax.n - 1) / 4));
    for (let i = 0; i < ax.n; i += step) {
      const day = parseInt(pts[i].date.split('-')[2], 10);
      xlab += '<text x="' + ax.x(i) + '" y="' + (H - 7) + '" class="trend-xlabel">' + day + '</text>';
    }
    return xlab;
  }
  // 每日一整列的透明命中区（悬停整列即出提示）
  function trendBandHits(pts, ax, key) {
    let hits = '';
    const bw = ax.n > 1 ? (ax.innerW / (ax.n - 1)) : ax.innerW;
    const kAttr = key ? ' data-key="' + key + '"' : '';
    pts.forEach((d, i) => {
      hits += '<rect class="trend-hit" x="' + (ax.x(i) - bw / 2) + '" y="' + ax.padT + '" width="' + bw + '" height="' + ax.innerH + '" data-idx="' + i + '"' + kAttr + '/>';
    });
    return hits;
  }

  // 悬停高亮层：竖直引导线 + 每条序列一个高亮焦点圆点（默认隐藏，悬停时定位显示）
  function trendFocusLayer(ax, series) {
    let s = '<line class="trend-guide" x1="' + ax.padL + '" y1="' + ax.padT + '" x2="' + ax.padL + '" y2="' + (ax.padT + ax.innerH) + '"/>';
    series.forEach((se, j) => {
      s += '<circle class="trend-focus" data-si="' + j + '" cx="-9" cy="-9" r="4.2" fill="#fff" stroke="' + se.color + '" stroke-width="2.5"/>';
    });
    return s;
  }
  function showTrendFocus(chart, idx) {
    if (!trendGeom || trendGeom.xs[idx] == null) return;
    const gx = trendGeom.xs[idx];
    const guide = chart.querySelector('.trend-guide');
    if (guide) { guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.classList.add('on'); }
    chart.querySelectorAll('.trend-focus').forEach(c => {
      const se = trendGeom.series[+c.getAttribute('data-si')];
      if (!se || se.ys[idx] == null) return;
      c.setAttribute('cx', gx);
      c.setAttribute('cy', se.ys[idx]);
      c.classList.add('on');
    });
  }
  function clearTrendFocus(chart) {
    const guide = chart.querySelector('.trend-guide');
    if (guide) guide.classList.remove('on');
    chart.querySelectorAll('.trend-focus').forEach(c => c.classList.remove('on'));
  }

  // 单指标折线（带 Y 轴刻度）
  function buildSingleSvg(key, pts, w) {
    const metric = TREND_METRICS.find(m => m.key === key) || TREND_METRICS[0];
    const color = metric.color;
    const W = Math.max(320, w), H = 180;
    const ax = trendAxis(pts, W, H);
    const vals = pts.map(d => trendValue(d, key));
    const realVals = vals.filter(v => v != null);
    if (realVals.length === 0) return '<div class="trend-empty">暂无真实收入数据</div>';
    const niceMax = niceCeil(Math.max.apply(null, realVals));
    const y = v => ax.padT + ax.innerH * (1 - v / niceMax);
    const ys = vals.map(y);
    trendGeom = { xs: pts.map((d, i) => ax.x(i)), series: [{ key: key, color: color, ys: ys }] };

    let grid = '';
    for (let t = 0; t <= 4; t++) {
      const gv = niceMax * t / 4, gy = y(gv);
      grid += '<line x1="' + ax.padL + '" y1="' + gy + '" x2="' + (W - ax.padR) + '" y2="' + gy + '" class="trend-grid"/>';
      grid += '<text x="' + (ax.padL - 6) + '" y="' + (gy + 3) + '" class="trend-ylabel">' + trendYLabel(key, gv) + '</text>';
    }
    const linePts = pts.map((d, i) => ax.x(i) + ',' + ys[i]).join(' ');
    const area = 'M ' + ax.x(0) + ',' + y(0) + ' L ' + pts.map((d, i) => ax.x(i) + ',' + ys[i]).join(' L ') + ' L ' + ax.x(ax.n - 1) + ',' + y(0) + ' Z';
    const isEstMetric = (key === 'revenue' || key === 'conv');
    let dots = '';
    pts.forEach((d, i) => {
      dots += '<circle class="trend-pt" cx="' + ax.x(i) + '" cy="' + ys[i] + '" r="2.3"/>';
    });
    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="xMidYMid meet" style="--tc:' + color + '">' +
             grid + '<path class="trend-area" d="' + area + '"/>' +
             '<polyline class="trend-line" points="' + linePts + '"/>' +
             dots + trendBandHits(pts, ax, key) + trendFocusLayer(ax, trendGeom.series) + trendXLabels(pts, ax, H) +
           '</svg>';
  }

  // 四项合体：左轴显示收入数字（收入按真实刻度绘制），其余按自身峰值归一化只看走势
  function buildCombinedSvg(pts, w) {
    const W = Math.max(320, w), H = 180;
    const ax = trendAxis(pts, W, H);
    const revVals = pts.map(d => trendValue(d, 'revenue'));
    const revMax = niceCeil(Math.max.apply(null, revVals));
    let grid = '';
    for (let t = 0; t <= 4; t++) {
      const gv = revMax * t / 4, gy = ax.padT + ax.innerH * (1 - t / 4);
      grid += '<line x1="' + ax.padL + '" y1="' + gy + '" x2="' + (W - ax.padR) + '" y2="' + gy + '" class="trend-grid"/>';
      grid += '<text x="' + (ax.padL - 6) + '" y="' + (gy + 3) + '" class="trend-ylabel">' + trendYLabel('revenue', gv) + '</text>';
    }
    const series = TREND_METRICS.map(m => {
      const vals = pts.map(d => trendValue(d, m.key));
      const base = (m.key === 'revenue') ? revMax : (Math.max.apply(null, vals) || 1);
      const ys = vals.map(v => ax.padT + ax.innerH * (1 - v / base));
      return { key: m.key, color: m.color, ys: ys };
    });
    trendGeom = { xs: pts.map((d, i) => ax.x(i)), series: series };
    let draw = '';
    series.forEach(se => {
      const linePts = pts.map((d, i) => ax.x(i) + ',' + se.ys[i]).join(' ');
      draw += '<polyline class="trend-line" points="' + linePts + '" style="stroke:' + se.color + '"/>';
      pts.forEach((d, i) => {
        draw += '<circle class="trend-pt" style="stroke:' + se.color + '" cx="' + ax.x(i) + '" cy="' + se.ys[i] + '" r="2.3"/>';
      });
    });
    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" preserveAspectRatio="xMidYMid meet">' +
             grid +
             '<text x="' + ax.padL + '" y="10" class="trend-note">左轴为收入 · 其余按自身峰值归一化对比走势</text>' +
             draw + trendBandHits(pts, ax, null) + trendFocusLayer(ax, series) + trendXLabels(pts, ax, H) +
           '</svg>';
  }

  function renderTrendChart(data) {
    const card = ensureTrendCard();
    if (!card) return;
    const list = (data && data.dailyList) ? data.dailyList : [];
    const pts = list.filter(d => (d.revenue != null || d.dau > 0 || (d.impression || 0) > 0));
    trendPts = pts;
    const tabs = card.querySelector('#trend-tabs');
    const tabDefs = [{ key: 'all', label: '全部', color: '#334155' }].concat(TREND_METRICS);
    tabs.innerHTML = tabDefs.map(m =>
      '<button class="trend-tab' + (m.key === currentTrendMetric ? ' is-active' : '') +
      '" data-key="' + m.key + '" style="--tc:' + m.color + '">' + m.label + '</button>'
    ).join('');
    const chart = card.querySelector('#trend-chart');
    const legend = card.querySelector('#trend-legend');
    if (pts.length < 2) {
      chart.innerHTML = '<div class="trend-empty">本月数据不足，暂无法绘制趋势</div>';
      legend.innerHTML = '';
      return;
    }
    const w = chart.clientWidth || 560;
    if (currentTrendMetric === 'all') {
      chart.innerHTML = buildCombinedSvg(pts, w);
      legend.innerHTML = TREND_METRICS.map(m => '<span class="lg-item"><i style="background:' + m.color + '"></i>' + m.label + '</span>').join('');
    } else {
      chart.innerHTML = buildSingleSvg(currentTrendMetric, pts, w);
      legend.innerHTML = '';
    }
  }

  function renderAll(data) {
    renderMonthSummary(data);
    ensureViewSwitch();
    renderTrendChart(data);
    renderDailyGrid(data);
    setView(currentView);
  }

  // ========== 加载某月 ==========
  async function loadMonth() {
    const grid = document.getElementById('daily-grid');
    grid.innerHTML = '<div class="loading-tip">加载中...</div>';
    renderMonthSummary(null);
    try {
      currentMonthData = await fetchMonthData(currentSelectedMonth);
      renderAll(currentMonthData);
    } catch (e) {
      console.error('加载失败:', e);
      grid.innerHTML = `
        <div class="empty-state">
          <p style="color:#ef4444;">加载失败: ${e.message}</p>
          <p style="color:#9ca3af;font-size:12px;margin-top:8px;">可能是登录已过期，请返回首页重新登录</p>
        </div>
      `;
    }
  }

  // ========== 事件 ==========
  document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  document.getElementById('prev-month').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => shiftMonth(1));

  // 月份标题点击：展开/收起月份面板
  document.getElementById('month-title').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMonthPicker();
  });

  // 面板年份切换
  document.getElementById('mp-prev-year').addEventListener('click', (e) => {
    e.stopPropagation();
    pickerYear--;
    renderMonthPicker();
  });
  document.getElementById('mp-next-year').addEventListener('click', (e) => {
    e.stopPropagation();
    pickerYear++;
    renderMonthPicker();
  });

  // 面板月份选择（事件委托）
  document.getElementById('mp-month-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.mp-month-btn');
    if (!btn || btn.disabled) return;
    pickMonth(btn.dataset.month);
  });

  // 每日网格点击：弹出当天详情（事件委托）
  document.getElementById('daily-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.daily-cell.is-clickable');
    if (!cell || !cell.dataset.date) return;
    openDayDetail(cell.dataset.date);
  });

  // Esc 关闭当天详情弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDayModal();
  });

  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('month-picker');
    if (picker.hidden) return;
    if (!picker.contains(e.target) && !document.getElementById('month-title').contains(e.target)) {
      closeMonthPicker();
    }
  });

  // ========== 初始化 ==========
  const gameData = sessionStorage.getItem('currentGame');
  if (gameData) {
    currentGame = JSON.parse(gameData);
    renderGameInfo(currentGame);
    currentSelectedMonth = currentMonthStr();
    // 默认下拉先放当前月（探测完成后再补全）
    earliestMonth = currentMonthStr();
    updateMonthTitle();
    // 先获取 developer_id（支持多账号），再并发加载数据
    (async () => {
      DEVELOPER_ID = await window.electronAPI.getDeveloperId();
      loadMonth();
      fetchOverview();
      loadGameOverall();
      probeGrandTotal();
    })();
  } else {
    window.location.href = 'index.html';
  }
})();
