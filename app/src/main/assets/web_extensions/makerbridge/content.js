// In GeckoView/Firefox WebExtensions, content scripts run in an ISOLATED world (Xray vision).
// To expose objects to the page's JS context, we must use wrappedJSObject / exportFunction.
// CSP blocks inline <script> injection, so we use the Gecko WebExtension API directly.

(function() {
  "use strict";
  if (window.__makerBridgeInjected) return;
  window.__makerBridgeInjected = true;

  // Access the page's real window object (bypass Xray wrapper)
  var pageWindow = window.wrappedJSObject;
  if (!pageWindow) {
    // Fallback: shouldn't happen in GeckoView but just in case
    pageWindow = window;
  }

  // Helper to expose a function into the page world
  function exportToPage(fnName, fn) {
    try {
      exportFunction(fn, pageWindow, { defineAs: fnName });
    } catch (e) {
      // Fallback: direct assignment on wrappedJSObject
      pageWindow[fnName] = fn;
    }
  }

  // Helper to clone objects into the page's compartment
  function cloneToPage(obj) {
    try {
      return cloneInto(obj, pageWindow, { cloneFunctions: true });
    } catch (e) {
      return obj;
    }
  }

  // Recording response factories
  function recStartResp() {
    return cloneToPage({
      ok: true,
      state: 'recording',
      streamId: 'native-' + Date.now(),
      duration: 0,
      filePath: null
    });
  }
  function recStopResp() {
    return cloneToPage({
      ok: true,
      state: 'stopped',
      filePath: null,
      duration: 0
    });
  }
  function recPauseResp() {
    return cloneToPage({ ok: true, state: 'paused' });
  }
  function recStatusResp() {
    return cloneToPage({ ok: true, state: 'inactive', duration: 0 });
  }

  // ==================== electronAPI bridge ====================
  var electronAPI = {
    isElectron: true,
    getAppVersion: function() { return '1.0.4'; },
    checkUpdate: function() {},
    syncPreferences: function() {},
    openLogin: function() {},
    openExplorer: function() {},
    openGameBackend: function() {},
    getDeveloperId: function() { return null; },
    getActiveDeveloperId: function() { return null; },
    getStudios: function() { return cloneToPage([]); },
    switchStudio: function() { return false; },
    getAccounts: function() { return cloneToPage([]); },
    switchAccount: function() { return false; },
    addAccount: function() {},
    removeAccount: function() { return cloneToPage({ ok: false }); },
    getCapturedApis: function() { return cloneToPage([]); },
    clearCapturedApis: function() {},
    fetch: function(url) {
      // Use page's native fetch (CORS/cookies handled by browser)
      var pFetch = pageWindow.fetch;
      return new pFetch.constructor(function(resolve) {
        pFetch(url).then(function(r) {
          r.text().then(function(t) {
            resolve(cloneToPage({ ok: r.ok, status: r.status, body: t, error: null }));
          });
        })["catch"](function(e) {
          resolve(cloneToPage({ ok: false, status: 0, body: null, error: String(e) }));
        });
      });
    },
    checkLogin: function() {
      return Promise.resolve(cloneToPage({
        status: 'unlogged', developerId: null, error: null, profile: null, studios: []
      }));
    },
    replayApi: function(_id, url) {
      var pFetch = pageWindow.fetch;
      return new pFetch.constructor(function(resolve) {
        pFetch(url).then(function(r) {
          r.text().then(function(t) {
            resolve(cloneToPage({ ok: r.ok, status: r.status, body: t, error: null }));
          });
        })["catch"](function(e) {
          resolve(cloneToPage({ ok: false, error: String(e) }));
        });
      });
    },
    replayKeyApis: function() {
      return Promise.resolve(cloneToPage({ count: 0, saved: false }));
    },
    onLoginSuccess: function() {},
    onLoginCheck: function() {},
    onAccountUpdated: function() {},
    onStudioSwitched: function() {},
    onApisUpdated: function() {},
    onTrayRefresh: function() {},
    onAppResume: function() {},
    onAppBackgroundTick: function() {},
    // All recording methods return success promises
    startRecording: function() { return Promise.resolve(recStartResp()); },
    stopRecording: function() { return Promise.resolve(recStopResp()); },
    pauseRecording: function() { return Promise.resolve(recPauseResp()); },
    resumeRecording: function() { return Promise.resolve(recStartResp()); },
    getRecordingState: function() { return Promise.resolve(recStatusResp()); },
    // Generic invoke (handles 'recording-request-start' etc. passed as method name)
    invoke: function(channel) {
      console.log('[MakerBridge] invoke:', channel);
      if (typeof channel === 'string') {
        if (channel.indexOf('start') >= 0 || channel.indexOf('request-start') >= 0)
          return Promise.resolve(recStartResp());
        if (channel.indexOf('stop') >= 0)
          return Promise.resolve(recStopResp());
        if (channel.indexOf('pause') >= 0)
          return Promise.resolve(recPauseResp());
        return Promise.resolve(cloneToPage({ ok: true }));
      }
      return Promise.resolve(cloneToPage({ ok: true }));
    },
    send: function(channel) {
      console.log('[MakerBridge] send:', channel);
    }
  };

  // Add hyphenated recording method names directly
  electronAPI['recording-request-start'] = electronAPI.startRecording;
  electronAPI['recording-request-stop'] = electronAPI.stopRecording;
  electronAPI['recording-request-pause'] = electronAPI.pauseRecording;
  electronAPI['recording-request-resume'] = electronAPI.resumeRecording;
  electronAPI['recording-request-status'] = electronAPI.getRecordingState;

  // ==================== ipcRenderer (Electron IPC shim) ====================
  var ipcRenderer = {
    invoke: function(channel) {
      console.log('[MakerBridge] ipcRenderer.invoke:', channel);
      if (typeof channel === 'string') {
        var ch = channel.toLowerCase();
        if (ch.indexOf('start') >= 0 || ch.indexOf('request-start') >= 0)
          return Promise.resolve(recStartResp());
        if (ch.indexOf('stop') >= 0)
          return Promise.resolve(recStopResp());
        if (ch.indexOf('pause') >= 0)
          return Promise.resolve(recPauseResp());
        if (ch.indexOf('resume') >= 0)
          return Promise.resolve(recStartResp());
        if (ch.indexOf('state') >= 0 || ch.indexOf('status') >= 0)
          return Promise.resolve(recStatusResp());
        if (ch.indexOf('recording') >= 0)
          return Promise.resolve(cloneToPage({ ok: true }));
      }
      return Promise.resolve(cloneToPage({ ok: true }));
    },
    send: function(channel) {
      console.log('[MakerBridge] ipcRenderer.send:', channel);
    },
    sendSync: function(channel) {
      console.log('[MakerBridge] ipcRenderer.sendSync:', channel);
      return cloneToPage({ ok: true });
    },
    on: function() { return this; },
    once: function() { return this; },
    addListener: function() { return this; },
    removeListener: function() { return this; },
    removeAllListeners: function() { return this; }
  };
  electronAPI.ipcRenderer = ipcRenderer;

  // ==================== Install into page window ====================
  // Use Xray-safe assignment: Components.utils.exportToFunction or direct wrappedJSObject
  try {
    // Method 1: cloneInto for the whole object
    var cloned = cloneInto(electronAPI, pageWindow, { cloneFunctions: true });
    pageWindow.electronAPI = cloned;
  } catch (e) {
    console.warn('[MakerBridge] cloneInto failed, trying wrappedJSObject direct set:', e);
    // Method 2: export each function individually
    pageWindow.electronAPI = Cu.createObjectIn(pageWindow);
  }

  // Also set as require('electron') shim
  var electronModule = { ipcRenderer: ipcRenderer };
  try {
    pageWindow.__electronShim = cloneToPage(electronModule);
  } catch (e) {}

  // ==================== Legacy AndroidBridge ====================
  var androidBridge = {
    isElectron: function() { return true; },
    fetch: function(id, url) {
      pageWindow.fetch(url).then(function(r) { return r.text(); }).then(function(t) {
        pageWindow.__pendingFetchResolve && pageWindow.__pendingFetchResolve(id,
          JSON.stringify(cloneToPage({ok:true,status:200,body:t,error:null})));
      })["catch"](function(e) {
        pageWindow.__pendingFetchResolve && pageWindow.__pendingFetchResolve(id,
          JSON.stringify(cloneToPage({ok:false,error:String(e)})));
      });
    },
    checkLogin: function() {
      pageWindow.__pendingLoginResolve && pageWindow.__pendingLoginResolve(
        JSON.stringify(cloneToPage({status:'unlogged',developerId:null,error:null,profile:null,studios:[]})));
    },
    getDeveloperId: function() { return null; },
    getStudios: function() { return '[]'; },
    getActiveDeveloperId: function() { return null; },
    switchStudio: function() { return false; },
    openLogin: function() {},
    getAccounts: function() { return '[]'; },
    switchAccount: function() { return false; },
    addAccount: function() {},
    removeAccount: function() { return false; },
    openExplorer: function() {},
    openGameBackend: function() {},
    getCapturedApis: function() { return '[]'; },
    clearCapturedApis: function() {},
    replayApi: function(id) {
      pageWindow.__pendingReplayResolve && pageWindow.__pendingReplayResolve(id,
        JSON.stringify(cloneToPage({ok:false,error:'not_available'})));
    },
    replayKeyApis: function() {
      pageWindow.__pendingReplayKeyResolve && pageWindow.__pendingReplayKeyResolve(
        JSON.stringify(cloneToPage({count:0,saved:false})));
    },
    getAppVersion: function() { return '1.0.4'; },
    checkUpdate: function() {}
  };

  try {
    pageWindow.AndroidBridge = cloneInto(androidBridge, pageWindow, { cloneFunctions: true });
  } catch (e) {
    pageWindow.AndroidBridge = androidBridge;
  }

  // Pending callbacks (stubs)
  if (!pageWindow.__pendingFetchResolve) pageWindow.__pendingFetchResolve = function(){};
  if (!pageWindow.__pendingLoginResolve) pageWindow.__pendingLoginResolve = function(){};
  if (!pageWindow.__pendingReplayResolve) pageWindow.__pendingReplayResolve = function(){};
  if (!pageWindow.__pendingReplayKeyResolve) pageWindow.__pendingReplayKeyResolve = function(){};

  // ==================== Stub getDisplayMedia (not supported on Android GeckoView) ====================
  // Some sites may try getDisplayMedia directly; we reject cleanly
  try {
    if (pageWindow.navigator && pageWindow.navigator.mediaDevices) {
      var md = pageWindow.navigator.mediaDevices;
      if (!md.getDisplayMedia || typeof md.getDisplayMedia !== 'function') {
        md.getDisplayMedia = exportFunction(function() {
          console.warn('[MakerBridge] getDisplayMedia() not supported on Android');
          return pageWindow.Promise.reject(
            new pageWindow.DOMException('Screen capture not supported on Android', 'NotSupportedError')
          );
        }, md, { defineAs: 'getDisplayMedia' });
      }
    }
  } catch (e) {
    console.warn('[MakerBridge] Could not stub getDisplayMedia:', e);
  }

  // ==================== Dispatch events ====================
  function fireEvent(name) {
    try {
      var evt = new pageWindow.CustomEvent(name);
      pageWindow.dispatchEvent(evt);
    } catch (e) {
      try {
        var evt2 = new pageWindow.Event(name);
        pageWindow.dispatchEvent(evt2);
      } catch (e2) {}
    }
  }

  // Fire events on next tick, retry after delays to ensure page scripts are ready
  function fireEvents() {
    fireEvent('electronAPIReady');
    fireEvent('electron-api-ready');
    fireEvent('bridge-ready');
    fireEvent('android-bridge-ready');
    console.log('[MakerBridge] Bridge injected (wrappedJSObject), v1.0.4 - electronAPI present:',
      !!pageWindow.electronAPI, typeof pageWindow.electronAPI);
  }

  fireEvents();
  // Also retry after delays for late-loaded page scripts
  pageWindow.setTimeout(fireEvents, 100);
  pageWindow.setTimeout(fireEvents, 500);
  pageWindow.setTimeout(fireEvents, 2000);

  console.log('[MakerBridge] Content script initialized.');
})();
