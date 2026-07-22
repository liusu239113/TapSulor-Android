/**
 * preload.js - 渲染进程与主进程的桥接
 *
 * 通过 contextBridge 暴露 electronAPI 给渲染进程
 * 渲染进程调用 electronAPI.fetch(url) 时，主进程会带上 TapTap 的 cookie 请求
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 带 cookie 的 fetch（核心方法）
  // 返回 { ok, status, body } 或 { ok:false, error }
  fetch: (url) => ipcRenderer.invoke('taptap-fetch', url),

  // 检查登录状态
  checkLogin: () => ipcRenderer.invoke('check-login'),

  // 打开登录窗口；mode 为 'add' 时表示添加新账号并自动识别开发者 ID
  openLogin: (mode) => ipcRenderer.invoke('open-login', mode),

  // 获取开发者 ID
  getDeveloperId: () => ipcRenderer.invoke('get-developer-id'),

  // ========== 账号管理（多账号支持） ==========
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  switchAccount: (id) => ipcRenderer.invoke('accounts:switch', id),
  addAccount: ({ name, developerId }) => ipcRenderer.invoke('accounts:add', { name, developerId }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

  // 监听登录成功事件
  onLoginSuccess: (callback) => {
    ipcRenderer.on('login-success', () => callback());
  },

  // 监听登录窗口关闭事件
  onLoginCheck: (callback) => {
    ipcRenderer.on('login-check', () => callback());
  },

  // 监听账号变更（添加/切换）事件
  onAccountUpdated: (callback) => {
    ipcRenderer.on('account-updated', (event, result) => callback(result));
  },

  // 监听托盘"刷新数据"
  onTrayRefresh: (callback) => {
    ipcRenderer.on('tray-refresh', () => callback());
  },

  // ========== API 探测 ==========
  // 打开后台探测窗口
  openExplorer: () => ipcRenderer.invoke('open-explorer'),

  // 获取捕获到的 API 列表
  getCapturedApis: () => ipcRenderer.invoke('get-captured-apis'),

  // 清空捕获列表
  clearCapturedApis: () => ipcRenderer.invoke('clear-captured-apis'),

  // 重放 API（用带 cookie 的 fetch 重新调，拿 response body）
  replayApi: (url) => ipcRenderer.invoke('replay-api', url),

  // 批量重放关键 API 并存到文件（供外部分析）
  replayKeyApis: () => ipcRenderer.invoke('replay-key-apis'),

  // 监听 API 捕获更新
  onApisUpdated: (callback) => {
    ipcRenderer.on('apis-updated', () => callback());
  },

  // 是否在 Electron 环境
  isElectron: true
});
