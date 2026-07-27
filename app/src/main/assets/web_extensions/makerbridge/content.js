// Content script: inject bridge code into PAGE world via <script> tag
(function() {
  function inject() {
    if (document.getElementById('__maker_bridge__')) return;
    var s = document.createElement('script');
    s.id = '__maker_bridge__';
    s.textContent = '(' + function() {
      if (window.__makerBridgeInjected) return;
      window.__makerBridgeInjected = true;

      // ==================== Recording Native Shim ====================
      // GeckoView/Android does NOT support navigator.mediaDevices.getDisplayMedia().
      // We stub it out so the site does not crash. The site uses Electron IPC
      // (electronAPI / ipcRenderer.invoke) for actual recording control.
      if (navigator.mediaDevices && !navigator.mediaDevices.getDisplayMedia) {
        navigator.mediaDevices.getDisplayMedia = function() {
          console.warn('[MakerBridge] getDisplayMedia() not supported on Android GeckoView, returning rejected promise');
          return Promise.reject(new DOMException('getDisplayMedia is not supported on Android', 'NotSupportedError'));
        };
      }

      // ==================== IPC Recording Stub ====================
      function recordingOK() {
        return Promise.resolve({ ok: true, state: 'recording', streamId: 'native-' + Date.now() });
      }
      function recordingStopped() {
        return Promise.resolve({ ok: true, state: 'stopped', filePath: null });
      }
      function recordingPaused() {
        return Promise.resolve({ ok: true, state: 'paused' });
      }

      // ==================== electronAPI (matches desktop Electron bridge) ====================
      var bridge = {
        isElectron: true,
        getAppVersion: function() { return '1.0.4'; },
        checkUpdate: function() {},
        syncPreferences: function() {},
        openLogin: function() {},
        openExplorer: function() {},
        openGameBackend: function() {},
        getDeveloperId: function() { return null; },
        getActiveDeveloperId: function() { return null; },
        getStudios: function() { return []; },
        switchStudio: function() { return false; },
        getAccounts: function() { return []; },
        switchAccount: function() { return false; },
        addAccount: function() {},
        removeAccount: function() { return { ok: false }; },
        getCapturedApis: function() { return []; },
        clearCapturedApis: function() {},
        fetch: function(url) {
          return fetch(url).then(function(r) {
            return r.text().then(function(t) {
              return { ok: r.ok, status: r.status, body: t, error: null };
            });
          }).catch(function(e) {
            return { ok: false, status: 0, body: null, error: String(e) };
          });
        },
        checkLogin: function() {
          return Promise.resolve({ status: 'unlogged', developerId: null, error: null, profile: null, studios: [] });
        },
        replayApi: function(_id, url) {
          return fetch(url).then(function(r) {
            return r.text().then(function(t) {
              return { ok: r.ok, status: r.status, body: t, error: null };
            });
          }).catch(function(e) {
            return { ok: false, error: String(e) };
          });
        },
        replayKeyApis: function() { return Promise.resolve({ count: 0, saved: false }); },
        onLoginSuccess: function() {},
        onLoginCheck: function() {},
        onAccountUpdated: function() {},
        onStudioSwitched: function() {},
        onApisUpdated: function() {},
        onTrayRefresh: function() {},
        onAppResume: function() {},
        onAppBackgroundTick: function() {},
        // Recording methods
        startRecording: recordingOK,
        stopRecording: recordingStopped,
        pauseRecording: recordingPaused,
        resumeRecording: recordingOK,
        getRecordingState: function() { return Promise.resolve({ state: 'inactive', duration: 0 }); }
      };

      // ==================== ipcRenderer-style invoke (Electron pattern) ====================
      // Many Electron apps use: ipcRenderer.invoke('recording-request-start')
      // or: electronAPI.invoke('recording-request-start')
      function ipcInvoke(channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        console.log('[MakerBridge] ipcInvoke:', channel, args);
        if (typeof channel === 'string') {
          if (channel.indexOf('recording-request-start') >= 0 || channel.indexOf('startRecord') >= 0 || channel.indexOf('start-recording') >= 0) return recordingOK();
          if (channel.indexOf('recording-request-stop') >= 0 || channel.indexOf('stopRecord') >= 0 || channel.indexOf('stop-recording') >= 0) return recordingStopped();
          if (channel.indexOf('recording-request-pause') >= 0) return recordingPaused();
          if (channel.indexOf('recording-request-resume') >= 0) return recordingOK();
          if (channel.indexOf('recording') >= 0) return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: true });
      }

      bridge.ipcRenderer = {
        invoke: ipcInvoke,
        send: function(channel) { console.log('[MakerBridge] ipcSend:', channel); },
        on: function() {},
        once: function() {},
        removeListener: function() {},
        removeAllListeners: function() {}
      };
      bridge.invoke = ipcInvoke;
      bridge.send = function(channel) { console.log('[MakerBridge] send:', channel); };

      // Support hyphenated property access: electronAPI['recording-request-start']()
      // Use Proxy if available (modern browsers including GeckoView)
      var electronAPI;
      if (typeof Proxy === 'function') {
        electronAPI = new Proxy(bridge, {
          get: function(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === 'string') {
              if (prop.indexOf('recording') >= 0) {
                console.log('[MakerBridge] Proxy trap for recording method:', prop);
                if (prop.indexOf('stop') >= 0) return recordingStopped;
                if (prop.indexOf('pause') >= 0) return recordingPaused;
                if (prop.indexOf('resume') >= 0) return recordingOK;
                if (prop.indexOf('state') >= 0 || prop.indexOf('status') >= 0) return function() { return Promise.resolve({ state: 'inactive' }); };
                return recordingOK;
              }
            }
            return undefined;
          }
        });
      } else {
        electronAPI = bridge;
        // Explicitly set hyphenated names
        electronAPI['recording-request-start'] = recordingOK;
        electronAPI['recording-request-stop'] = recordingStopped;
        electronAPI['recording-request-pause'] = recordingPaused;
        electronAPI['recording-request-resume'] = recordingOK;
        electronAPI['recording-request-status'] = function() { return Promise.resolve({ state: 'inactive' }); };
      }

      window.electronAPI = electronAPI;

      // ==================== Legacy AndroidBridge ====================
      window.AndroidBridge = window.AndroidBridge || {
        isElectron: function() { return true; },
        fetch: function(id, url) {
          fetch(url).then(function(r) { return r.text(); }).then(function(t) {
            if (window.__pendingFetchResolve) window.__pendingFetchResolve(id, JSON.stringify({ok:true,status:200,body:t,error:null}));
          }).catch(function(e) {
            if (window.__pendingFetchResolve) window.__pendingFetchResolve(id, JSON.stringify({ok:false,error:String(e)}));
          });
        },
        checkLogin: function() {
          if (window.__pendingLoginResolve) window.__pendingLoginResolve(JSON.stringify({status:'unlogged',developerId:null,error:null,profile:null,studios:[]}));
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
          if (window.__pendingReplayResolve) window.__pendingReplayResolve(id, JSON.stringify({ok:false,error:'not_available'}));
        },
        replayKeyApis: function() {
          if (window.__pendingReplayKeyResolve) window.__pendingReplayKeyResolve(JSON.stringify({count:0,saved:false}));
        },
        getAppVersion: function() { return '1.0.4'; },
        checkUpdate: function() {}
      };

      window.__pendingFetchResolve = window.__pendingFetchResolve || function() {};
      window.__pendingLoginResolve = window.__pendingLoginResolve || function() {};
      window.__pendingReplayResolve = window.__pendingReplayResolve || function() {};
      window.__pendingReplayKeyResolve = window.__pendingReplayKeyResolve || function() {};

      // Fire events
      try { window.dispatchEvent(new CustomEvent('electronAPIReady')); } catch(e) {}
      try { window.dispatchEvent(new Event('electron-api-ready')); } catch(e) {}
      try { window.dispatchEvent(new Event('bridge-ready')); } catch(e) {}

      console.log('[MakerBridge] Bridge injected successfully into page world, v1.0.4');
    } + ')();';

    var parent = document.head || document.documentElement;
    if (parent) {
      parent.appendChild(s);
      s.remove();
    } else {
      // document_start too early, wait for readystate change
      document.addEventListener('DOMContentLoaded', inject, { once: true });
    }
  }

  if (document.readyState === 'loading' && !document.head) {
    // At very early document_start, use a MutationObserver or retry
    var retry = function() {
      if (document.head || document.documentElement) {
        inject();
      } else {
        requestAnimationFrame(retry);
      }
    };
    requestAnimationFrame(retry);
  } else {
    inject();
  }
})();
