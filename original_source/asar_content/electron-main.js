/**
 * electron-main.js - Electron 主进程
 *
 * 职责：
 * 1. 创建主窗口（加载 index.html）
 * 2. 管理 session（partition: persist:taptap，cookie 持久化）
 * 3. 检测登录状态（调 app 列表 API）
 * 4. 未登录时弹登录窗口（加载 TapTap 开发者后台，自动跳登录页）
 * 5. IPC 暴露带 cookie 的 fetch 给渲染进程
 */

const { app, BrowserWindow, ipcMain, session, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  createDefaultConfig,
  reconcileSessionIdentity,
  getLoginStartUrl,
  buildAppListUrl,
  classifySessionIdentity,
  isTapTapDeveloperUrl
} = require('./account-state');

// 保持与 v1.0.0 相同的 Electron 用户数据目录，确保已有登录 Session 可继续使用。
app.setName('taptapgain');

console.log('[TapTap助手] 主进程已启动，electron 模块加载正常 (ipcMain=' + typeof ipcMain + ', BrowserWindow=' + typeof BrowserWindow + ')');

// ========== 账号配置管理（多账号支持） ========== 
// 运行时数据不能写到 __dirname：打包后该目录位于只读的 app.asar 中。
const ACCOUNTS_FILE = path.join(app.getPath('userData'), 'accounts.json');

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!data.accounts || data.accounts.length === 0) throw new Error('no accounts');
    return data;
  } catch (e) {
    // 首次运行或配置损坏：用默认账号初始化
    const defaultData = createDefaultConfig();
    saveAccounts(defaultData);
    return defaultData;
  }
}

function saveAccounts(data) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('保存账号配置失败:', e);
    throw e;
  }
}

function getCurrentAccount() {
  const data = loadAccounts();
  return data.accounts.find(a => a.id === data.current) || data.accounts[0];
}

function getPartition() {
  const acc = getCurrentAccount();
  return acc.partition || (acc.developerId ? `persist:taptap-${acc.developerId}` : 'persist:taptap');
}

// 把一个 partition 的 cookie 复制到另一个 partition（用于添加账号时迁移登录态）
async function copyCookies(fromPartition, toPartition) {
  const fromSes = session.fromPartition(fromPartition);
  const toSes = session.fromPartition(toPartition);
  const cookies = await fromSes.cookies.get({});
  for (const cookie of cookies) {
    const domain = cookie.domain || '';
    // 只迁移 TapTap 登录所需 Cookie，避免把其他站点会话复制到账号分区。
    if (!/(^|\.)taptap\.(cn|io)$/i.test(domain.replace(/^\./, ''))) continue;
    const url = `https://${domain.replace(/^\./, '')}${cookie.path || '/'}`;
    await toSes.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite || 'no_restriction',
      expirationDate: cookie.expirationDate
    });
  }
}

// 根据登录后的开发者 ID 自动添加或切换到对应账号
async function addOrSwitchAccount(developerId, fromPartition) {
  const data = loadAccounts();
  const previous = data.accounts.find(a => a.id === data.current) || data.accounts[0];
  const reconciliation = reconcileSessionIdentity(data, {
    developerId,
    partition: fromPartition
  });

  if (reconciliation.copyCookies) {
    await copyCookies(fromPartition, reconciliation.account.partition);
  }
  saveAccounts(reconciliation.config);

  const switched = reconciliation.action === 'created' || reconciliation.action === 'switched';
  const isNew = reconciliation.action === 'created';
  const alreadyCurrent = reconciliation.action === 'unchanged';
  const requiresWindowRebuild = Boolean(
    previous && (
      previous.id !== reconciliation.account.id ||
      previous.partition !== reconciliation.account.partition
    )
  );

  if (requiresWindowRebuild && mainWindow) {
    // 先关登录窗口，再销毁主窗口，避免父子窗口级联问题
    if (loginWindow) { try { loginWindow.close(); } catch (e) {} loginWindow = null; }
    if (explorerWindow) { explorerWindow.destroy(); explorerWindow = null; }
    mainWindow.destroy();
    mainWindow = null;
    createMainWindow();
    checkLogin().then((identity) => {
      if (identity.status === 'unauthenticated' && mainWindow) {
        createLoginWindow();
      }
    });
  }
  return { ok: true, switched, isNew, alreadyCurrent, developerId };
}

function getDeveloperId() {
  return getCurrentAccount().developerId;
}

function getAppListUrl() {
  return buildAppListUrl(getDeveloperId(), 1, 100);
}

function getDeveloperHome() {
  const developerId = getDeveloperId();
  return developerId
    ? `https://developer.taptap.cn/v3/${developerId}/all-app`
    : getLoginStartUrl();
}

let mainWindow = null;
let loginWindow = null;
let explorerWindow = null;
let tray = null;
let isQuiting = false;

// 捕获到的 API 请求列表
let capturedApis = [];
const MAX_CAPTURE = 500;

// 捕获结果自动保存到文件（方便外部读取分析）
const CAPTURED_FILE = path.join(app.getPath('userData'), 'captured-apis.json');
function saveCapturedToFile() {
  try {
    fs.writeFileSync(CAPTURED_FILE, JSON.stringify(capturedApis, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存捕获结果失败:', e);
  }
}

// ========== 窗口创建 ==========
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 760,
    minWidth: 480,
    minHeight: 600,
    title: 'TapTapGain',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: getPartition()
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ========== 托盘 ==========
function createTray() {
  // 使用应用图标作为托盘图标
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('TapTapGain');

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '刷新数据', click: () => { if (mainWindow) mainWindow.webContents.send('tray-refresh'); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

function createLoginWindow({ addAccount = false } = {}) {
  if (loginWindow) {
    loginWindow.focus();
    return loginWindow;
  }

  // 添加账号时使用临时 partition，登录成功后再把 cookie 迁移到以 developerId 命名的 partition
  const tempPartition = addAccount ? ('persist:taptap-add-' + Date.now()) : null;
  const loginPartition = tempPartition || getPartition();

  // 添加账号：先清空临时 partition 的登录态，保证是一个干净的“未登录”会话，
  // 避免设备/会话被记住导致窗口一打开就被判定为已登录而瞬间关闭
  if (addAccount && tempPartition) {
    try {
      const ses = session.fromPartition(tempPartition);
      ses.clearStorageData().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  loginWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: addAccount ? '添加账号 - 登录 TapTap 开发者后台' : '登录 TapTap 开发者后台',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      partition: loginPartition,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 登录必须从不带开发者 ID 的中立入口开始。旧版本打开了写死的开发者空间，
  // 其他用户登录后会直接收到“你无权执行此操作”。
  loginWindow.loadURL(getLoginStartUrl());

  // 监听导航：登录成功后会跳回 developer.taptap.cn 域名下
  let checkTimer = null;
  let loginSuccessNotified = false;
  const onNavigate = async (event, url) => {
    // 只信任精确的 TapTap 开发者后台 HTTPS 域名；登录完成前身份接口会返回空。
    if (isTapTapDeveloperUrl(url)) {
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        try {
          // 关键修复：不再从 URL 里抠 devId 当“已登录”，只认 whoami 接口的真实登录态。
          // 添加账号时登录窗口加载的是当前账号的 /v3/<devId>/all-app，URL 里的 devId
          // 会让旧逻辑误判“已登录”而瞬间关窗；这里必须等 whoami 确认。
          const developerId = await getSessionDeveloperId(loginPartition);
          if (!developerId) return; // 还没真正登录，保持窗口打开等用户操作

          // 无论首次登录还是“添加账号”，都必须把真实身份写入配置。
          // 旧版本只在添加账号时保存，普通登录会继续使用错误的默认开发者 ID。
          loginSuccessNotified = true;
          const result = await addOrSwitchAccount(developerId, tempPartition || loginPartition);
          if (addAccount && mainWindow) mainWindow.webContents.send('account-updated', result);
          if (loginWindow) loginWindow.close();
          if (mainWindow) mainWindow.webContents.send('login-success');
        } catch (e) {
          console.error('[login] onNavigate 处理失败:', e);
        }
      }, 800);
    }
  };

  loginWindow.webContents.on('did-navigate', onNavigate);
  loginWindow.webContents.on('did-navigate-in-page', onNavigate);

  loginWindow.on('closed', async () => {
    loginWindow = null;
    if (checkTimer) clearTimeout(checkTimer);
    // 兜底：窗口关闭时再检查一次登录态，如果已登录就发 login-success，否则发 login-check
    if (mainWindow && !loginSuccessNotified) {
      const identity = await checkLogin();
      if (identity.status === 'ready') {
        mainWindow.webContents.send('login-success');
      } else {
        mainWindow.webContents.send('login-check');
      }
    }
  });

  return loginWindow;
}

// ========== 后台 API 探测窗口 ==========
// webRequest 监听器（主进程网络层兜底拦截，比 preload monkey-patch 更可靠）
let explorerWebRequestListener = null;

function createExplorerWindow() {
  if (explorerWindow) {
    explorerWindow.focus();
    return explorerWindow;
  }

  const ses = session.fromPartition(getPartition());
  const apiFilter = { urls: ['https://developer.taptap.cn/api/*'] };

  // webRequest 兜底：主进程网络层拦截，页面怎么发请求都逃不掉
  // 能拿到 URL/method/status；response body 靠 preload 抓（或后续重放）
  explorerWebRequestListener = (details) => {
    const idx = capturedApis.findIndex(a => a.url === details.url && a.method === details.method);
    if (idx >= 0) {
      // preload 已抓到，补 status
      capturedApis[idx].status = details.statusCode;
      if (!capturedApis[idx].source) capturedApis[idx].source = 'preload';
    } else {
      // webRequest 独有（preload 没抓到，可能是 Worker/SW 发的）
      capturedApis.push({
        url: details.url,
        method: details.method,
        status: details.statusCode,
        body: '',
        source: 'webRequest',
        time: Date.now()
      });
      if (capturedApis.length > MAX_CAPTURE) capturedApis.shift();
    }
    saveCapturedToFile();
    if (mainWindow) mainWindow.webContents.send('apis-updated');
  };
  ses.webRequest.onCompleted(apiFilter, explorerWebRequestListener);

  explorerWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'TapTap 后台数据探测',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'explorer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: getPartition()
    }
  });

  // dom-ready 时把拦截脚本注入页面上下文（安全加固：preload 用 contextIsolation: true，
  // 拦截逻辑通过 executeJavaScript 注入，页面无法访问 Node API）
  const injectScript = fs.readFileSync(path.join(__dirname, 'explorer-inject.js'), 'utf-8');
  explorerWindow.webContents.on('dom-ready', () => {
    explorerWindow.webContents.executeJavaScript(injectScript).catch((e) => {
      console.error('[explorer] 拦截脚本注入失败:', e.message);
    });
  });

  explorerWindow.loadURL(getDeveloperHome());

  explorerWindow.on('closed', () => {
    explorerWindow = null;
    // 移除 webRequest 监听
    if (explorerWebRequestListener) {
      ses.webRequest.onCompleted(apiFilter, null);
      explorerWebRequestListener = null;
    }
    if (mainWindow) {
      mainWindow.webContents.send('apis-updated');
    }
  });

  return explorerWindow;
}

// ========== 会话身份识别（更可靠地判断“已登录”并拿到开发者 ID） ==========
async function fetchSessionJson(ses, url) {
  return new Promise((resolve) => {
    const request = net.request({ url, useSessionCookies: true, session: ses, redirect: 'follow' });
    let body = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    request.on('response', (res) => {
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        try {
          finish({ status: res.statusCode, json: JSON.parse(body), error: null });
        } catch (e) {
          finish({ status: res.statusCode, json: null, error: 'invalid_json' });
        }
      });
    });
    request.on('error', (error) => finish({ status: 0, json: null, error: error.message }));
    request.end();
    setTimeout(() => {
      try { request.abort(); } catch (e) { /* already completed */ }
      finish({ status: 0, json: null, error: 'timeout' });
    }, 15000);
  });
}

// 区分未登录、已登录但没有开发者主体、可用和网络错误。
async function getSessionIdentity(partition) {
  const ses = session.fromPartition(partition);
  const me = await fetchSessionJson(ses, 'https://developer.taptap.cn/api/user/v1/me');
  if (me.status === 401 || me.status === 403 || me.status === 0 || me.error) {
    return classifySessionIdentity(me, null, getCurrentAccount().developerId);
  }
  const developerList = await fetchSessionJson(ses, 'https://developer.taptap.cn/api/developer/v1/list');
  return classifySessionIdentity(me, developerList, getCurrentAccount().developerId);
}

async function getSessionDeveloperId(partition) {
  const identity = await getSessionIdentity(partition);
  return identity.status === 'ready' ? identity.developerId : null;
}

// ========== 登录检测 ==========
async function checkLogin(partition = getPartition()) {
  const identity = await getSessionIdentity(partition);
  if (identity.status === 'ready') {
    await addOrSwitchAccount(identity.developerId, partition);
  }
  return identity;
}

// ========== IPC ==========
// 带 cookie 的 fetch（渲染进程调用）
ipcMain.handle('taptap-fetch', async (event, url) => {
  return new Promise((resolve) => {
    const ses = session.fromPartition(getPartition());
    const request = net.request({
      url: url,
      useSessionCookies: true,
      session: ses,
      redirect: 'follow'
    });

    let body = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on('response', (response) => {
      const statusCode = response.statusCode;
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        finish({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: body });
      });
    });

    request.on('error', (err) => {
      finish({ ok: false, status: 0, body: '', error: err.message });
    });

    request.end();
    setTimeout(() => finish({ ok: false, status: 0, body: '', error: 'timeout' }), 20000);
  });
});

// 检查登录状态
ipcMain.handle('check-login', async () => {
  return await checkLogin();
});

// 打开登录窗口；mode === 'add' 表示添加新账号并自动识别开发者 ID
ipcMain.handle('open-login', async (event, mode) => {
  createLoginWindow({ addAccount: mode === 'add' });
  return true;
});

// 获取开发者 ID
ipcMain.handle('get-developer-id', async () => {
  return getDeveloperId();
});

// ========== API 探测相关 IPC ==========

// 接收 explorer-preload 捕获的 API 请求
ipcMain.on('api-captured', (event, data) => {
  // 标记来源是 preload（有 response body）
  data.source = 'preload';
  // 去重：同一 URL + method 只保留最新一条
  const idx = capturedApis.findIndex(
    a => a.url === data.url && a.method === data.method
  );
  if (idx >= 0) {
    capturedApis[idx] = { ...capturedApis[idx], ...data, time: Date.now() };
  } else {
    capturedApis.push({ ...data, time: Date.now() });
    if (capturedApis.length > MAX_CAPTURE) {
      capturedApis.shift();
    }
  }

  saveCapturedToFile();

  // 实时通知主窗口
  if (mainWindow) {
    mainWindow.webContents.send('apis-updated');
  }
});

// 打开探测窗口
ipcMain.handle('open-explorer', async () => {
  createExplorerWindow();
  return true;
});

// 获取捕获到的 API 列表
ipcMain.handle('get-captured-apis', async () => {
  return capturedApis;
});

// 清空捕获列表
ipcMain.handle('clear-captured-apis', async () => {
  capturedApis = [];
  saveCapturedToFile();
  return true;
});

// 重放 API：用带 cookie 的 fetch 重新调，拿 response body
// 用于 webRequest 抓到 URL 但没 body 的情况
ipcMain.handle('replay-api', async (event, url) => {
  return new Promise((resolve) => {
    const ses = session.fromPartition(getPartition());
    const request = net.request({
      url: url,
      useSessionCookies: true,
      session: ses,
      redirect: 'follow'
    });

    let body = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on('response', (response) => {
      const statusCode = response.statusCode;
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        finish({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: body });
      });
    });

    request.on('error', (err) => {
      finish({ ok: false, status: 0, body: '', error: err.message });
    });

    request.end();
    setTimeout(() => finish({ ok: false, status: 0, body: '', error: 'timeout' }), 20000);
  });
});

// 批量重放关键 API 并把响应存到文件（方便外部读取分析字段结构）
// 返回存到的文件路径
ipcMain.handle('replay-key-apis', async () => {
  const ses = session.fromPartition(getPartition());
  const DEV = getDeveloperId();
  const capturedAppId = capturedApis.map((item) => {
    try { return new URL(item.url).searchParams.get('app_id'); } catch (e) { return null; }
  }).find(Boolean);
  if (!capturedAppId) {
    return { count: 0, file: null, error: '请先在探测窗口打开一个具体游戏页面' };
  }
  const APP = encodeURIComponent(capturedAppId);
  // 动态算最近 30 天（和后台默认一致），避免日期随时间过时
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  const pad = (d) => String(d.getDate()).padStart(2, '0');
  const mon = (d) => String(d.getMonth() + 1).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${mon(d)}-${pad(d)}`;
  const START = fmt(start);
  const END = fmt(end);

  // 关键 API 清单（按类别分组）
  const keyApis = [
    // ===== 商店运营数据（dashboard/v2）=====
    { tag: 'store_pv', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/pv/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_download', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/download/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_download_android', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/download/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&platform=android` },
    { tag: 'store_reserve', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/reserve/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_rank_hot', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rank/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&sub_category=hot_top` },
    { tag: 'store_rank_reserve', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rank/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&sub_category=reserve_top` },
    { tag: 'store_rank_new', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rank/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&sub_category=new_top` },
    { tag: 'store_rank_pop', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rank/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&sub_category=pop_top` },
    { tag: 'store_position', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/position/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_launcher', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/launcher-button?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_review', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/review/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}&type=1` },
    { tag: 'store_ad', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/advertisement/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_ad_revenue', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rep/revenue/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_ad_effect', url: `https://developer.taptap.cn/api/dashboard/v2/stats-by-day/rep/effect/cn?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'store_total', url: `https://developer.taptap.cn/api/dashboard/v2/stats-total/cn?developer_id=${DEV}&app_id=${APP}` },

    // ===== 小游戏/小程序数据（mini-app/v1）—— 日活/留存/转化/时长 =====
    { tag: 'miniapp_total', url: `https://developer.taptap.cn/api/mini-app/v1/stats/total?developer_id=${DEV}&app_id=${APP}` },
    { tag: 'miniapp_device', url: `https://developer.taptap.cn/api/mini-app/v1/stats-by-day/device?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'miniapp_ret', url: `https://developer.taptap.cn/api/mini-app/v1/stats-by-day/ret?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'miniapp_conversion', url: `https://developer.taptap.cn/api/mini-app/v1/stats-by-day/conversion?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },
    { tag: 'miniapp_duration', url: `https://developer.taptap.cn/api/mini-app/v1/stats-by-day/duration?developer_id=${DEV}&app_id=${APP}&start_date=${START}&end_date=${END}` },

    // ===== 开发者所有游戏汇总 =====
    { tag: 'dev_list_app_stats', url: `https://developer.taptap.cn/api/developer/v1/list-app-stats?developer_id=${DEV}&page=1&pagesize=20&start_date_1=${START}&end_date_1=${END}` },

    // ===== 评论/评分 =====
    { tag: 'review_dashboard', url: `https://developer.taptap.cn/api/review/v1/dashboard?developer_id=${DEV}&app_id=${APP}&store=cn` },
    { tag: 'score_trend', url: `https://developer.taptap.cn/api/score/v1/review/latest-trend-data?developer_id=${DEV}&app_id=${APP}` },
  ];

  const results = [];
  for (const item of keyApis) {
    try {
      const resp = await new Promise((resolve) => {
        const request = net.request({
          url: item.url,
          useSessionCookies: true,
          session: ses,
          redirect: 'follow'
        });
        let body = '';
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        request.on('response', (response) => {
          response.on('data', (chunk) => { body += chunk.toString(); });
          response.on('end', () => {
            finish({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: body });
          });
        });
        request.on('error', (err) => finish({ ok: false, status: 0, body: '', error: err.message }));
        request.end();
        setTimeout(() => finish({ ok: false, status: 0, body: '', error: 'timeout' }), 20000);
      });
      results.push({ tag: item.tag, url: item.url, status: resp.status, ok: resp.ok, body: resp.body || '' });
      console.log(`[replay] ${item.tag} -> ${resp.status} (${(resp.body || '').length} bytes)`);
    } catch (e) {
      results.push({ tag: item.tag, url: item.url, status: 0, ok: false, body: '', error: String(e) });
    }
  }

  // 存到文件
  const outFile = path.join(app.getPath('userData'), 'replayed-responses.json');
  try {
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存重放结果失败:', e);
  }
  return { count: results.length, file: outFile };
});

// ========== 账号管理 IPC ==========
ipcMain.handle('accounts:get', () => loadAccounts());

ipcMain.handle('accounts:switch', (event, id) => {
  const data = loadAccounts();
  const acc = data.accounts.find(a => a.id === id);
  if (!acc) return { ok: false, error: '账号不存在' };
  if (data.current === id) return { ok: true, changed: false };
  data.current = id;
  saveAccounts(data);
  // 切换账号 = 换 partition + developer_id，需要销毁并重建主窗口
  if (mainWindow) {
    // 先关闭探测窗口（旧 partition 的 webRequest 监听要清理）
    if (explorerWindow) { explorerWindow.destroy(); }
    // 用 destroy 而非 close：close 会被托盘的 'close' 事件拦截（hide 到托盘）
    mainWindow.destroy();
    mainWindow = null;
    // 重建主窗口（用新 partition）
    createMainWindow();
    // 检查新账号登录状态
    checkLogin().then((identity) => {
      if (identity.status === 'unauthenticated' && mainWindow) {
        createLoginWindow();
      }
    });
  }
  return { ok: true, changed: true };
});

ipcMain.handle('accounts:add', (event, { name, developerId }) => {
  const data = loadAccounts();
  const id = 'acc-' + Date.now();
  const partition = 'persist:taptap-' + developerId;
  const account = { id, name: name || ('账号 ' + (data.accounts.length + 1)), developerId, partition };
  data.accounts.push(account);
  saveAccounts(data);
  return { ok: true, account };
});

ipcMain.handle('accounts:remove', (event, id) => {
  const data = loadAccounts();
  if (data.accounts.length <= 1) return { ok: false, error: '至少保留一个账号' };
  data.accounts = data.accounts.filter(a => a.id !== id);
  if (data.current === id) data.current = data.accounts[0].id;
  saveAccounts(data);
  return { ok: true };
});

// ========== 应用生命周期 ==========
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createMainWindow();
    createTray();

    // 启动时检查登录
    const identity = await checkLogin();
    if (identity.status === 'unauthenticated') {
      createLoginWindow();
    }
  });

  app.on('before-quit', () => { isQuiting = true; });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// 阻止创建新窗口时打开外部浏览器（点击外链时在内部打开）
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      // 在登录窗口内打开
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });
});
