(function() {
  if (window.__makerBridgeInjected) return;
  window.__makerBridgeInjected = true;

  const buildPromiseBridge = () => {
    const _fmap = {};
    let _seq = 0;
    const _queues = { fetch: [], login: [], replay: [], replayKey: [] };
    const _listeners = {};

    const api = {
      isElectron: true,
      fetch: function(url) {
        return new Promise(function(res) {
          var id = ++_seq;
          _fmap[id] = res;
          _queues.fetch.push({ id: id, url: url });
          flush();
        });
      },
      checkLogin: function() {
        return new Promise(function(res) { _queues.login.push(res); flush(); });
      },
      getDeveloperId: function() { try { return window.__br.devId || null; } catch(e) { return null; } },
      getStudios: function() { try { return JSON.parse(window.__br.studios || "[]"); } catch(e) { return []; } },
      getActiveDeveloperId: function() { try { return window.__br.activeDevId || window.__br.devId || null; } catch(e) { return null; } },
      switchStudio: function() { return false; },
      openLogin: function() {},
      getAccounts: function() { return []; },
      switchAccount: function() { return false; },
      addAccount: function() {},
      removeAccount: function() { return { ok: false }; },
      openExplorer: function() {},
      openGameBackend: function() {},
      getCapturedApis: function() { return []; },
      clearCapturedApis: function() {},
      replayApi: function() { return Promise.resolve({}); },
      replayKeyApis: function() { return new Promise(function(res) { res({ count: 0, saved: false }); }); },
      onLoginSuccess: function(cb) { _listeners.loginSuccess = cb; },
      onLoginCheck: function(cb) { _listeners.loginCheck = cb; },
      onAccountUpdated: function(cb) { _listeners.accountUpdated = cb; },
      onStudioSwitched: function(cb) { _listeners.studioSwitched = cb; },
      onApisUpdated: function() {},
      onTrayRefresh: function() {},
      getAppVersion: function() { return window.__br.version || "1.0.4"; },
      checkUpdate: function() {},
      onAppResume: function() {},
      onAppBackgroundTick: function() {},
      invokeNative: function(method, args) {
        var id = ++_seq;
        _fmap[id] = null;
        try {
          chrome.runtime.sendMessage({ nativeApp: "makerbridge", id: id, method: method, args: args || [] });
        } catch(e) {}
      },
      startRecording: function() {
        return new Promise(function(resolve, reject) {
          var id = ++_seq;
          _fmap[id] = function(res) {
            if (res && res.ok) resolve(res);
            else reject(new Error(res && res.error || "recording_failed"));
          };
          chrome.runtime.sendMessage({ nativeApp: "makerbridge", id: id, method: "recording-request-start", args: [] });
        });
      },
      stopRecording: function() {
        return new Promise(function(resolve) {
          var id = ++_seq;
          _fmap[id] = resolve;
          chrome.runtime.sendMessage({ nativeApp: "makerbridge", id: id, method: "recording-request-stop", args: [] });
        });
      }
    };

    function flush() {
      if (!window.__br) { window.__br = {}; }
      while (_queues.fetch.length) {
        var item = _queues.fetch.shift();
        fetch(item.url).then(function(r) { return r.text(); }).then(function(t) {
          var cb = _fmap[item.id]; delete _fmap[item.id];
          if (cb) cb({ ok: true, status: 200, body: t, error: null });
        }).catch(function(e) {
          var cb = _fmap[item.id]; delete _fmap[item.id];
          if (cb) cb({ ok: false, status: 0, body: null, error: String(e) });
        });
      }
      while (_queues.login.length) {
        var cb = _queues.login.shift();
        cb({ status: "unlogged", developerId: null, error: null, profile: null, studios: [] });
      }
    }

    window.__pendingFetchResolve = function(id, jsonStr) {
      var cb = _fmap[id]; delete _fmap[id];
      if (cb) { try { cb(JSON.parse(jsonStr)); } catch(e) { cb({ ok: false, error: "parse_error" }); } }
    };
    window.__pendingLoginResolve = function(jsonStr) {
      if (_listeners.loginSuccess) { try { _listeners.loginSuccess(); } catch(e){} }
    };
    window.__pendingReplayResolve = function() {};
    window.__pendingReplayKeyResolve = function(cb) { if (cb) cb({ count: 0, saved: false }); };

    window.__onLoginSuccess = function() { if (_listeners.loginSuccess) _listeners.loginSuccess(); };
    window.__onLoginCheck = function() { if (_listeners.loginCheck) _listeners.loginCheck(); };
    window.__onAccountUpdated = function() { if (_listeners.accountUpdated) _listeners.accountUpdated(); };
    window.__onStudioSwitched = function() { if (_listeners.studioSwitched) _listeners.studioSwitched(); };

    window.__nativeResponse = function(id, resultStr) {
      var cb = _fmap[id]; delete _fmap[id];
      if (cb) { try { cb(JSON.parse(resultStr)); } catch(e) { cb({ ok: false, error: "parse_error" }); } }
    };

    window.electronAPI = api;
    if (!window.AndroidBridge) window.AndroidBridge = {
      fetch: function(id, url) { fetch(url).then(function(r){return r.text();}).then(function(t){window.__pendingFetchResolve(id, JSON.stringify({ok:true,status:200,body:t,error:null}));}).catch(function(e){window.__pendingFetchResolve(id, JSON.stringify({ok:false,error:String(e)}));}); },
      checkLogin: function() { window.__pendingLoginResolve(JSON.stringify({status:"unlogged",developerId:null,error:null,profile:null,studios:[]})); },
      getDeveloperId: function() { return null; },
      getStudios: function() { return "[]"; },
      getActiveDeveloperId: function() { return null; },
      switchStudio: function() { return false; },
      openLogin: function() {},
      getAccounts: function() { return "[]"; },
      switchAccount: function() { return false; },
      addAccount: function() {},
      removeAccount: function() { return false; },
      openExplorer: function() {},
      openGameBackend: function() {},
      getCapturedApis: function() { return "[]"; },
      clearCapturedApis: function() {},
      replayApi: function(id) { window.__pendingReplayResolve(id, JSON.stringify({ok:false,error:"not_available"})); },
      replayKeyApis: function() { window.__pendingReplayKeyResolve(function(){})(JSON.stringify({count:0,saved:false})); },
      getAppVersion: function() { return "1.0.4"; },
      checkUpdate: function() {}
    };
    window.dispatchEvent(new CustomEvent("electronAPIReady"));
    flush();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPromiseBridge);
  } else {
    buildPromiseBridge();
  }
})();
