// MakerBridge — GeckoView content script that exposes an Electron-like IPC shim
// to maker.taptap.cn so the web app's recording controls (which expect the desktop
// Electron client) don't fail with "is not supported by this user agent".
//
// Injection strategy (robust against GeckoView Xray compartment isolation):
//   1. Build every object DIRECTLY in the page compartment via Cu.createObjectIn().
//   2. Export every function individually via exportFunction() — the recommended
//      Gecko way to expose callable functions cross-compartment.
//   3. Return page-realm Promises / plain objects (cloneInto) so .then() and
//      property access work without Xray wrapping.
//   4. Provide BOTH window.electronAPI AND window.require('electron') entry points.
//   5. Stub navigator.mediaDevices.getDisplayMedia unconditionally so any web
//      fallback path also resolves cleanly instead of throwing Gecko's
//      "getDisplayMedia is not supported by this user agent" DOMException.
//
// CSP: WebExtension content scripts with exportFunction/cloneInto are CSP-safe
// (they do not inject inline <script> tags).

(function () {
  "use strict";

  // Single-instance guard per window/frame.
  if (window.__makerBridgeInjected) return;
  window.__makerBridgeInjected = true;

  // Access the page's real window object (bypass Xray wrapper).
  /** @type {Window} */
  var pageWindow = window.wrappedJSObject || window;

  // Shortcut to Components.utils (available in GeckoView content scripts).
  var Cu = Components.utils;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Define a function property on `target` (a page-compartment object) so that
   * calling the function from page JS runs `fn` (which lives in the content-
   * script world) but returns values in the page compartment.
   */
  function defineFn(target, name, fn) {
    try {
      // exportFunction creates a cross-compartment wrapper; property is defined
      // directly on the target via defineAs.
      exportFunction(fn, target, { defineAs: name });
    } catch (e) {
      // Fallback (shouldn't happen on GV153): assign a Cu.exportFunction-ed wrapper.
      try {
        Object.defineProperty(target, name, {
          value: exportFunction(fn, target),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (e2) {
        console.warn("[MakerBridge] defineFn failed for", name, e2);
      }
    }
  }

  /** Clone a plain object/array into the page compartment. */
  function clone(v) {
    if (v === null || typeof v !== "object") return v;
    try {
      return cloneInto(v, pageWindow);
    } catch (e) {
      return v;
    }
  }

  /** Create a page-realm Promise that resolves to `value` (already page-cloned). */
  function resolvePromise(value) {
    var cloned = clone(value);
    try {
      return pageWindow.Promise.resolve(cloned);
    } catch (e) {
      // Should never happen — Promise is a page global.
      return Promise.resolve(cloned);
    }
  }

  // ---------------------------------------------------------------------------
  // Recording response factories (plain objects, cloned into page at call time)
  // ---------------------------------------------------------------------------
  function recStartResp() {
    return {
      ok: true,
      state: "recording",
      streamId: "native-" + Date.now(),
      duration: 0,
      filePath: null,
    };
  }
  function recStopResp() {
    return { ok: true, state: "stopped", filePath: null, duration: 0 };
  }
  function recPauseResp() {
    return { ok: true, state: "paused" };
  }
  function recResumeResp() {
    return {
      ok: true,
      state: "recording",
      streamId: "native-" + Date.now(),
      duration: 0,
    };
  }
  function recStatusResp() {
    return { ok: true, state: "inactive", duration: 0 };
  }

  /** Generic channel router used by both electronAPI.invoke and ipcRenderer.invoke. */
  function routeChannel(channel) {
    var ch = typeof channel === "string" ? channel.toLowerCase() : "";
    console.log("[MakerBridge] routeChannel:", channel);
    if (ch.indexOf("start") >= 0) return resolvePromise(recStartResp());
    if (ch.indexOf("stop") >= 0) return resolvePromise(recStopResp());
    if (ch.indexOf("pause") >= 0) return resolvePromise(recPauseResp());
    if (ch.indexOf("resume") >= 0) return resolvePromise(recResumeResp());
    if (ch.indexOf("state") >= 0 || ch.indexOf("status") >= 0)
      return resolvePromise(recStatusResp());
    if (ch.indexOf("recording") >= 0) return resolvePromise({ ok: true });
    return resolvePromise({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // Build ipcRenderer in the page compartment
  // ---------------------------------------------------------------------------
  var ipcRenderer = Cu.createObjectIn(pageWindow);
  defineFn(ipcRenderer, "invoke", function (channel /*, ...args */) {
    return routeChannel(channel);
  });
  defineFn(ipcRenderer, "send", function (channel /*, ...args */) {
    console.log("[MakerBridge] ipcRenderer.send:", channel);
  });
  defineFn(ipcRenderer, "sendSync", function (channel /*, ...args */) {
    console.log("[MakerBridge] ipcRenderer.sendSync:", channel);
    return clone({ ok: true });
  });
  defineFn(ipcRenderer, "on", function () {
    return ipcRenderer;
  });
  defineFn(ipcRenderer, "once", function () {
    return ipcRenderer;
  });
  defineFn(ipcRenderer, "addListener", function () {
    return ipcRenderer;
  });
  defineFn(ipcRenderer, "removeListener", function () {
    return ipcRenderer;
  });
  defineFn(ipcRenderer, "removeAllListeners", function () {
    return ipcRenderer;
  });

  // ---------------------------------------------------------------------------
  // Build electronAPI in the page compartment
  // ---------------------------------------------------------------------------
  var electronAPI = Cu.createObjectIn(pageWindow);

  // Scalar flags.
  electronAPI.isElectron = true;
  electronAPI.isAndroid = true;
  electronAPI.platform = "android";

  // ---- Informational / account stubs ---------------------------------------
  defineFn(electronAPI, "getAppVersion", function () {
    return "1.0.5";
  });
  defineFn(electronAPI, "checkUpdate", function () {
    return resolvePromise({ ok: true, hasUpdate: false });
  });
  defineFn(electronAPI, "syncPreferences", function () {});
  defineFn(electronAPI, "openLogin", function () {});
  defineFn(electronAPI, "openExplorer", function () {});
  defineFn(electronAPI, "openGameBackend", function () {});
  defineFn(electronAPI, "getDeveloperId", function () {
    return null;
  });
  defineFn(electronAPI, "getActiveDeveloperId", function () {
    return null;
  });
  defineFn(electronAPI, "getStudios", function () {
    return resolvePromise([]);
  });
  defineFn(electronAPI, "switchStudio", function () {
    return false;
  });
  defineFn(electronAPI, "getAccounts", function () {
    return resolvePromise([]);
  });
  defineFn(electronAPI, "switchAccount", function () {
    return false;
  });
  defineFn(electronAPI, "addAccount", function () {});
  defineFn(electronAPI, "removeAccount", function () {
    return resolvePromise({ ok: false });
  });
  defineFn(electronAPI, "getCapturedApis", function () {
    return resolvePromise([]);
  });
  defineFn(electronAPI, "clearCapturedApis", function () {});

  // ---- fetch passthrough (uses page fetch for correct cookies/CORS) --------
  defineFn(electronAPI, "fetch", function (url) {
    var pFetch = pageWindow.fetch;
    return new pFetch.constructor(function (resolve) {
      pFetch(url)
        .then(function (r) {
          return r.text().then(function (t) {
            resolve(clone({ ok: r.ok, status: r.status, body: t, error: null }));
          });
        })
        ["catch"](function (e) {
          resolve(clone({ ok: false, status: 0, body: null, error: String(e) }));
        });
    });
  });

  defineFn(electronAPI, "checkLogin", function () {
    return resolvePromise({
      status: "unlogged",
      developerId: null,
      error: null,
      profile: null,
      studios: [],
    });
  });

  defineFn(electronAPI, "replayApi", function (_id, url) {
    var pFetch = pageWindow.fetch;
    return new pFetch.constructor(function (resolve) {
      pFetch(url)
        .then(function (r) {
          return r.text().then(function (t) {
            resolve(clone({ ok: r.ok, status: r.status, body: t, error: null }));
          });
        })
        ["catch"](function (e) {
          resolve(clone({ ok: false, error: String(e) }));
        });
    });
  });
  defineFn(electronAPI, "replayKeyApis", function () {
    return resolvePromise({ count: 0, saved: false });
  });

  // ---- Event subscription stubs --------------------------------------------
  ["onLoginSuccess", "onLoginCheck", "onAccountUpdated", "onStudioSwitched",
   "onApisUpdated", "onTrayRefresh", "onAppResume", "onAppBackgroundTick"
  ].forEach(function (name) {
    defineFn(electronAPI, name, function () {});
  });

  // ---- Recording methods (plain names) -------------------------------------
  defineFn(electronAPI, "startRecording", function () {
    return resolvePromise(recStartResp());
  });
  defineFn(electronAPI, "stopRecording", function () {
    return resolvePromise(recStopResp());
  });
  defineFn(electronAPI, "pauseRecording", function () {
    return resolvePromise(recPauseResp());
  });
  defineFn(electronAPI, "resumeRecording", function () {
    return resolvePromise(recResumeResp());
  });
  defineFn(electronAPI, "getRecordingState", function () {
    return resolvePromise(recStatusResp());
  });

  // ---- Generic invoke() router (handles hyphenated channel names) ----------
  defineFn(electronAPI, "invoke", function (channel /*, ...args */) {
    return routeChannel(channel);
  });
  defineFn(electronAPI, "send", function (channel /*, ...args */) {
    console.log("[MakerBridge] electronAPI.send:", channel);
  });

  // ---- Hyphenated channel names as direct callable methods -----------------
  // The desktop app calls things like electronAPI['recording-request-stop']().
  defineFn(electronAPI, "recording-request-start", function () {
    return resolvePromise(recStartResp());
  });
  defineFn(electronAPI, "recording-request-stop", function () {
    return resolvePromise(recStopResp());
  });
  defineFn(electronAPI, "recording-request-pause", function () {
    return resolvePromise(recPauseResp());
  });
  defineFn(electronAPI, "recording-request-resume", function () {
    return resolvePromise(recResumeResp());
  });
  defineFn(electronAPI, "recording-request-status", function () {
    return resolvePromise(recStatusResp());
  });

  // ---- Attach ipcRenderer as a property of electronAPI --------------------
  // electronAPI.ipcRenderer.invoke('recording-request-stop') pattern.
  Object.defineProperty(electronAPI, "ipcRenderer", {
    value: ipcRenderer,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // ---------------------------------------------------------------------------
  // Install electronAPI on the page window
  // ---------------------------------------------------------------------------
  Object.defineProperty(pageWindow, "electronAPI", {
    value: electronAPI,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // ---------------------------------------------------------------------------
  // require('electron') polyfill (in case the page does const {ipcRenderer} = require('electron'))
  // ---------------------------------------------------------------------------
  var electronModule = Cu.createObjectIn(pageWindow);
  Object.defineProperty(electronModule, "ipcRenderer", {
    value: ipcRenderer,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(electronModule, "electronAPI", {
    value: electronAPI,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  function makeRequire() {
    function requireShim(name) {
      if (name === "electron") return electronModule;
      if (name === "path" || name === "fs" || name === "os" || name === "url") {
        // Return a minimal stub for common Node built-ins the page might import.
        return Cu.createObjectIn(pageWindow);
      }
      throw new pageWindow.Error("Cannot find module '" + name + "'");
    }
    return requireShim;
  }
  defineFn(pageWindow, "require", makeRequire());

  // ---------------------------------------------------------------------------
  // process.versions.electron — some Electron-detection code checks this.
  // ---------------------------------------------------------------------------
  try {
    var proc = Cu.createObjectIn(pageWindow);
    var versions = Cu.createObjectIn(pageWindow);
    versions.electron = "1.0.5";
    versions.chrome = "153.0.0.0";
    versions.node = "18.0.0";
    Object.defineProperty(proc, "versions", {
      value: versions,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    proc.type = "renderer";
    proc.platform = "android";
    proc.env = Cu.createObjectIn(pageWindow);
    proc.cwd = exportFunction(function () {
      return "/";
    }, proc);
    Object.defineProperty(pageWindow, "process", {
      value: proc,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    console.warn("[MakerBridge] Failed to install process shim:", e);
  }

  // ---------------------------------------------------------------------------
  // Legacy AndroidBridge (older page builds may still call window.AndroidBridge)
  // ---------------------------------------------------------------------------
  try {
    var androidBridge = Cu.createObjectIn(pageWindow);
    defineFn(androidBridge, "isElectron", function () {
      return true;
    });
    defineFn(androidBridge, "getAppVersion", function () {
      return "1.0.5";
    });
    defineFn(androidBridge, "getDeveloperId", function () {
      return null;
    });
    defineFn(androidBridge, "getActiveDeveloperId", function () {
      return null;
    });
    defineFn(androidBridge, "getStudios", function () {
      return "[]";
    });
    defineFn(androidBridge, "switchStudio", function () {
      return false;
    });
    defineFn(androidBridge, "getAccounts", function () {
      return "[]";
    });
    defineFn(androidBridge, "switchAccount", function () {
      return false;
    });
    defineFn(androidBridge, "addAccount", function () {});
    defineFn(androidBridge, "removeAccount", function () {
      return false;
    });
    defineFn(androidBridge, "openLogin", function () {});
    defineFn(androidBridge, "openExplorer", function () {});
    defineFn(androidBridge, "openGameBackend", function () {});
    defineFn(androidBridge, "getCapturedApis", function () {
      return "[]";
    });
    defineFn(androidBridge, "clearCapturedApis", function () {});
    defineFn(androidBridge, "checkUpdate", function () {});
    defineFn(androidBridge, "checkLogin", function () {
      try {
        pageWindow.__pendingLoginResolve &&
          pageWindow.__pendingLoginResolve(
            JSON.stringify(
              clone({
                status: "unlogged",
                developerId: null,
                error: null,
                profile: null,
                studios: [],
              })
            )
          );
      } catch (_) {}
    });
    defineFn(androidBridge, "fetch", function (id, url) {
      pageWindow
        .fetch(url)
        .then(function (r) {
          return r.text();
        })
        .then(function (t) {
          pageWindow.__pendingFetchResolve &&
            pageWindow.__pendingFetchResolve(
              id,
              JSON.stringify(
                clone({ ok: true, status: 200, body: t, error: null })
              )
            );
        })
        ["catch"](function (e) {
          pageWindow.__pendingFetchResolve &&
            pageWindow.__pendingFetchResolve(
              id,
              JSON.stringify(clone({ ok: false, error: String(e) }))
            );
        });
    });
    defineFn(androidBridge, "replayApi", function (id) {
      pageWindow.__pendingReplayResolve &&
        pageWindow.__pendingReplayResolve(
          id,
          JSON.stringify(clone({ ok: false, error: "not_available" }))
        );
    });
    defineFn(androidBridge, "replayKeyApis", function () {
      pageWindow.__pendingReplayKeyResolve &&
        pageWindow.__pendingReplayKeyResolve(
          JSON.stringify(clone({ count: 0, saved: false }))
        );
    });

    Object.defineProperty(pageWindow, "AndroidBridge", {
      value: androidBridge,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    console.warn("[MakerBridge] Failed to install AndroidBridge:", e);
  }

  // Pending callbacks (no-op defaults).
  ["__pendingFetchResolve", "__pendingLoginResolve",
   "__pendingReplayResolve", "__pendingReplayKeyResolve"
  ].forEach(function (k) {
    if (!pageWindow[k]) {
      try {
        pageWindow[k] = exportFunction(function () {}, pageWindow, { defineAs: k });
      } catch (_) {
        pageWindow[k] = function () {};
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Unconditionally stub navigator.mediaDevices.getDisplayMedia / getUserMedia
  // so any web-screen-recorder fallback path returns a clean rejection instead
  // of Gecko's "is not supported by this user agent" DOMException.
  // ---------------------------------------------------------------------------
  try {
    var nav = pageWindow.navigator;
    if (nav && nav.mediaDevices) {
      var md = nav.mediaDevices.wrappedJSObject || nav.mediaDevices;
      // Override getDisplayMedia to reject with a recognizable error so the
      // page's promise/catch logic (which shows the toast) sees our clean
      // "not supported on Android" instead of a cryptic UA message.
      defineFn(md, "getDisplayMedia", function () {
        console.warn("[MakerBridge] getDisplayMedia() stubbed -> reject NotSupportedError");
        return pageWindow.Promise.reject(
          new pageWindow.DOMException(
            "Screen capture is handled via Electron IPC on this client",
            "NotSupportedError"
          )
        );
      });
    }
  } catch (e) {
    console.warn("[MakerBridge] Could not stub mediaDevices:", e);
  }

  // ---------------------------------------------------------------------------
  // Diagnostic flag — visible to the page and to us via remote debugging.
  // ---------------------------------------------------------------------------
  pageWindow.__makerBridgeVersion = "1.1.1";
  pageWindow.__makerBridgeMethods = [
    "startRecording", "stopRecording", "pauseRecording", "resumeRecording", "getRecordingState",
    "recording-request-start", "recording-request-stop",
    "recording-request-pause", "recording-request-resume", "recording-request-status",
    "invoke", "send",
  ];

  // ---------------------------------------------------------------------------
  // Dispatch readiness events (with retries for late-init page code).
  // ---------------------------------------------------------------------------
  function fireEvent(name) {
    try {
      pageWindow.dispatchEvent(new pageWindow.CustomEvent(name));
    } catch (_) {
      try {
        pageWindow.dispatchEvent(new pageWindow.Event(name));
      } catch (_) {}
    }
  }

  function announce() {
    fireEvent("electronAPIReady");
    fireEvent("electron-api-ready");
    fireEvent("bridge-ready");
    fireEvent("android-bridge-ready");
    console.log(
      "[MakerBridge] v1.1.1 injected. electronAPI=",
      typeof pageWindow.electronAPI,
      " ipcRenderer=",
      typeof (pageWindow.electronAPI && pageWindow.electronAPI.ipcRenderer),
      " stop=",
      typeof (pageWindow.electronAPI && pageWindow.electronAPI["recording-request-stop"])
    );
  }

  announce();
  // Retry announcements for late-bootstrapped page scripts.
  try {
    pageWindow.setTimeout(announce, 0);
    pageWindow.setTimeout(announce, 50);
    pageWindow.setTimeout(announce, 200);
    pageWindow.setTimeout(announce, 1000);
    pageWindow.setTimeout(announce, 3000);
  } catch (_) {}

  console.log("[MakerBridge] Content script initialized (document_start).");
})();
