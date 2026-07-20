/**
 * explorer-preload.js - 注入到后台探测窗口（安全加固版）
 *
 * contextIsolation: true，preload 运行在隔离上下文
 * 只通过 contextBridge 暴露一个安全的发送函数，页面无法访问 Node API
 * fetch/XHR 拦截逻辑由主进程在 dom-ready 时通过 executeJavaScript 注入页面上下文
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taptapExplorer', {
  // 页面拦截到 API 请求后，调这个函数把数据传回主进程
  sendApiCaptured: (data) => ipcRenderer.send('api-captured', data)
});

console.log('[explorer-preload] 安全桥接已加载（contextIsolation: true）');
