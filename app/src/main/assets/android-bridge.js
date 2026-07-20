(function () {
  'use strict';
  if (!window.AndroidBridge || window.electronAPI) return;

  window.__bridgeInjected = true;
  // 并发请求使用「请求 id -> resolve」映射，避免 FIFO 队列在响应乱序时把 A 的响应喂给 B。
  window.__fetchSeq = 0;
  window.__fetchMap = {};
  window.__replaySeq = 0;
  window.__replayMap = {};
  window.__loginResolveQueue = [];
  window.__replayKeyResolveQueue = [];
  window.__pendingFetchResolve = function (id, value) {
    var callback = window.__fetchMap[id];
    delete window.__fetchMap[id];
    if (callback) callback(JSON.parse(value));
  };
  window.__pendingLoginResolve = function (value) {
    var callback = window.__loginResolveQueue.shift();
    if (callback) callback(JSON.parse(value));
  };
  window.__pendingReplayResolve = function (id, value) {
    var callback = window.__replayMap[id];
    delete window.__replayMap[id];
    if (callback) callback(JSON.parse(value));
  };
  window.__pendingReplayKeyResolve = function (value) {
    var callback = window.__replayKeyResolveQueue.shift();
    if (callback) callback(JSON.parse(value));
  };

  window.electronAPI = {
    isElectron: true,
    fetch: function (url) {
      return new Promise(function (resolve) {
        var id = ++window.__fetchSeq;
        window.__fetchMap[id] = resolve;
        AndroidBridge.fetch(id, url);
      });
    },
    checkLogin: function () {
      return new Promise(function (resolve) {
        window.__loginResolveQueue.push(resolve);
        AndroidBridge.checkLogin();
      });
    },
    getDeveloperId: function () { return AndroidBridge.getDeveloperId(); },
    openLogin: function (mode) { AndroidBridge.openLogin(mode || null); },
    getAccounts: function () { return JSON.parse(AndroidBridge.getAccounts()); },
    switchAccount: function (id) { return AndroidBridge.switchAccount(id); },
    addAccount: function (data) {
      if (data) AndroidBridge.addAccount(data.name || '', data.developerId || '');
    },
    removeAccount: function (id) { return { ok: AndroidBridge.removeAccount(id) }; },
    openExplorer: function () { AndroidBridge.openExplorer(); },
    getCapturedApis: function () { return JSON.parse(AndroidBridge.getCapturedApis()); },
    clearCapturedApis: function () { AndroidBridge.clearCapturedApis(); },
    replayApi: function (url) {
      return new Promise(function (resolve) {
        var id = ++window.__replaySeq;
        window.__replayMap[id] = resolve;
        AndroidBridge.replayApi(id, url);
      });
    },
    replayKeyApis: function () {
      return new Promise(function (resolve) {
        window.__replayKeyResolveQueue.push(resolve);
        AndroidBridge.replayKeyApis();
      });
    },
    onLoginSuccess: function (callback) { window.__onLoginSuccess = callback; },
    onLoginCheck: function (callback) { window.__onLoginCheck = callback; },
    onAccountUpdated: function (callback) { window.__onAccountUpdated = callback; },
    onApisUpdated: function (callback) { window.__onApisUpdated = callback; },
    onTrayRefresh: function () {},
    /** 获取 APP 版本号（来自 BuildConfig.VERSION_NAME） */
    getAppVersion: function () {
      try { return AndroidBridge.getAppVersion ? AndroidBridge.getAppVersion() : ''; }
      catch (e) { return ''; }
    },
    /** APP 从后台回到前台 / 冷启动完成时触发（强刷，全量 init） */
    onAppResume: function (callback) { window.__onAppResume = callback; },
    /** APP 在后台每 5 分钟触发一次（轻量刷新：仅拉 app list + revenue） */
    onAppBackgroundTick: function (callback) { window.__onAppBackgroundTick = callback; }
  };
  window.dispatchEvent(new CustomEvent('electronAPIReady'));
}());
