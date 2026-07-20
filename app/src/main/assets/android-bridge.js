(function () {
  'use strict';
  if (!window.AndroidBridge || window.electronAPI) return;

  window.__bridgeInjected = true;
  window.__fetchResolveQueue = [];
  window.__loginResolveQueue = [];
  window.__replayResolveQueue = [];
  window.__replayKeyResolveQueue = [];
  window.__pendingFetchResolve = function (value) {
    var callback = window.__fetchResolveQueue.shift();
    if (callback) callback(JSON.parse(value));
  };
  window.__pendingLoginResolve = function (value) {
    var callback = window.__loginResolveQueue.shift();
    if (callback) callback(JSON.parse(value));
  };
  window.__pendingReplayResolve = function (value) {
    var callback = window.__replayResolveQueue.shift();
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
        window.__fetchResolveQueue.push(resolve);
        AndroidBridge.fetch(url);
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
        window.__replayResolveQueue.push(resolve);
        AndroidBridge.replayApi(url);
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
    onTrayRefresh: function () {}
  };
  window.dispatchEvent(new CustomEvent('electronAPIReady'));
}());
