// MakerBridge — GeckoView content script that exposes an Electron-like IPC shim
// to maker.taptap.cn so the web app's recording controls (which expect the desktop
// Electron client) don't fail with "is not supported by this user agent".
//
// ⚠️ ZERO-PRIVILEGE INJECTION (required for GeckoView)
// ----------------------------------------------------
// GeckoView content scripts run in an isolated sandbox where Components.utils /
// Cu / exportFunction / cloneInto / Cu.createObjectIn are NOT available (those
// are Firefox-DESKTOP-only chrome-privileged APIs). Using any of them throws
// ReferenceError at the top of the script and the whole IIFE dies silently —
// which is why every prior attempt failed to inject anything.
//
// The only cross-realm primitive that IS reliably available is
// `window.wrappedJSObject`, which gives us the page's unwrapped window, and
// `wrappedJSObject.eval(code)` which executes plain source directly in the
// PAGE realm/page principal. So we build the entire bridge as a self-
// contained plain-JS string and eval it once on the page window. The bridge
// code runs natively in the page world, sees page globals directly, and the
// page's own scripts see window.electronAPI etc. without any Xray wrapping.
//
// As belt-and-suspenders we ALSO inject a <script> tag with the same source,
// which runs in the page world too (CSP-permitting), so even if eval-on-
// wrappedJSObject ever behaves unexpectedly the script tag covers us.

(function () {
  "use strict";

  // Single-instance guard in the CONTENT world (cheap bail-out if WebExtension
  // runs the script twice in the same frame).
  if (window.__makerBridgeContentLoaded) return;
  window.__makerBridgeContentLoaded = true;

  // Access the page's real window object (bypass Xray wrapper). This is the
  // ONLY GeckoView-specific primitive we rely on, and it is documented to be
  // available in content scripts.
  var pageWindow = window.wrappedJSObject || window;

  // ---------------------------------------------------------------------------
  // Bridge source — runs entirely in the PAGE realm. Must NOT reference any
  // content-script-side variables; only page globals (window, Object, Promise,
  // setTimeout, fetch, navigator, document, CustomEvent, Error, DOMException...).
  //
  // We define it as a function and use .toString() so we can write normal JS
  // without hand-escaping a giant string literal.
  // ---------------------------------------------------------------------------
  function installBridge() {
    // Single-instance guard in the PAGE world (prevents double-init from both
    // eval() and the <script> fallback).
    if (window.__makerBridgeInjected) return;
    window.__makerBridgeInjected = true;

    var APP_VERSION = "1.0.4";

    // -----------------------------------------------------------------------
    // UA override (JS-side only, does NOT affect HTTP User-Agent header).
    //
    // maker.taptap.cn decides whether to use electronAPI IPC OR the browser
    // getDisplayMedia() path by checking navigator.userAgent for "Electron".
    // GeckoView sends an iPad Safari UA at the HTTP layer (good — keeps the
    // iPad layout + TapTap/QQ/WeChat login panel), and we keep that for
    // networking, but we rewrite the JS-visible UA string here so the page's
    // in-JS UA detection believes it's running inside an Electron client and
    // takes the IPC path that our shim serves. Without this, even with
    // window.electronAPI injected, the page sees an iPad Safari UA and skips
    // the electronAPI branch entirely, then falls into getDisplayMedia which
    // GeckoView/Gecko does not support on Android — producing the exact
    // "recording-request-start is not supported by this user agent" error.
    // -----------------------------------------------------------------------
    try {
      var origUA = navigator.userAgent;
      var electronUA = origUA + " Electron/" + APP_VERSION;
      // Override the userAgent getter on Navigator.prototype so any read of
      // navigator.userAgent (including from code that cached the prototype
      // reference early) returns the Electron-tagged string.
      var navProto = Object.getPrototypeOf(navigator);
      if (navProto && Object.getOwnPropertyDescriptor(navProto, "userAgent")) {
        Object.defineProperty(navProto, "userAgent", {
          get: function () { return electronUA; },
          configurable: true,
        });
      } else {
        Object.defineProperty(navigator, "userAgent", {
          get: function () { return electronUA; },
          configurable: true,
        });
      }
      // Also override navigator.userAgentData (Chrome's Client Hints API) in
      // case the page uses it to detect Electron/Chrome.
      try {
        var fakeUABrand = { brand: "Electron", version: APP_VERSION };
        var fakeUABrands = [
          fakeUABrand,
          { brand: "Chromium", version: "124" },
          { brand: "Google Chrome", version: "124" },
        ];
        var fakeUAData = {
          brands: fakeUABrands,
          mobile: false,
          platform: "Android",
          getHighEntropyValues: function () {
            return Promise.resolve({
              brands: fakeUABrands,
              mobile: false,
              platform: "Android",
              platformVersion: "14",
              architecture: "",
              bitness: "64",
              model: "",
              uaFullVersion: APP_VERSION,
              fullVersionList: fakeUABrands,
            });
          },
          toJSON: function () {
            return { brands: fakeUABrands, mobile: false, platform: "Android" };
          },
        };
        Object.defineProperty(navigator, "userAgentData", {
          get: function () { return fakeUAData; },
          configurable: true,
        });
      } catch (_) {}
      console.log("[MakerBridge] navigator.userAgent overridden to advertise Electron:", electronUA);
    } catch (e) {
      console.warn("[MakerBridge] Failed to override navigator.userAgent:", e);
    }

    function define(obj, name, value) {
      Object.defineProperty(obj, name, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    // -----------------------------------------------------------------------
    // Recording response factories (plain objects, resolved in native Promise)
    // -----------------------------------------------------------------------
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

    function routeChannel(channel) {
      var ch = typeof channel === "string" ? channel.toLowerCase() : "";
      console.log("[MakerBridge] routeChannel:", channel);
      if (ch.indexOf("start") >= 0) return Promise.resolve(recStartResp());
      if (ch.indexOf("stop") >= 0) return Promise.resolve(recStopResp());
      if (ch.indexOf("pause") >= 0) return Promise.resolve(recPauseResp());
      if (ch.indexOf("resume") >= 0) return Promise.resolve(recResumeResp());
      if (ch.indexOf("state") >= 0 || ch.indexOf("status") >= 0)
        return Promise.resolve(recStatusResp());
      if (ch.indexOf("recording") >= 0) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    }

    // -----------------------------------------------------------------------
    // ipcRenderer
    // -----------------------------------------------------------------------
    var ipcRenderer = {};
    define(ipcRenderer, "invoke", function (channel /*, ...args */) {
      return routeChannel(channel);
    });
    define(ipcRenderer, "send", function (channel /*, ...args */) {
      console.log("[MakerBridge] ipcRenderer.send:", channel);
    });
    define(ipcRenderer, "sendSync", function (channel /*, ...args */) {
      console.log("[MakerBridge] ipcRenderer.sendSync:", channel);
      return { ok: true };
    });
    define(ipcRenderer, "on", function () { return ipcRenderer; });
    define(ipcRenderer, "once", function () { return ipcRenderer; });
    define(ipcRenderer, "addListener", function () { return ipcRenderer; });
    define(ipcRenderer, "removeListener", function () { return ipcRenderer; });
    define(ipcRenderer, "removeAllListeners", function () { return ipcRenderer; });

    // -----------------------------------------------------------------------
    // electronAPI
    // -----------------------------------------------------------------------
    var electronAPI = {};
    electronAPI.isElectron = true;
    electronAPI.isAndroid = true;
    electronAPI.platform = "android";

    // Informational / account stubs
    define(electronAPI, "getAppVersion", function () { return APP_VERSION; });
    define(electronAPI, "checkUpdate", function () {
      return Promise.resolve({ ok: true, hasUpdate: false });
    });
    define(electronAPI, "syncPreferences", function () {});
    define(electronAPI, "openLogin", function () {});
    define(electronAPI, "openExplorer", function () {});
    define(electronAPI, "openGameBackend", function () {});
    define(electronAPI, "getDeveloperId", function () { return null; });
    define(electronAPI, "getActiveDeveloperId", function () { return null; });
    define(electronAPI, "getStudios", function () { return Promise.resolve([]); });
    define(electronAPI, "switchStudio", function () { return false; });
    define(electronAPI, "getAccounts", function () { return Promise.resolve([]); });
    define(electronAPI, "switchAccount", function () { return false; });
    define(electronAPI, "addAccount", function () {});
    define(electronAPI, "removeAccount", function () {
      return Promise.resolve({ ok: false });
    });
    define(electronAPI, "getCapturedApis", function () { return Promise.resolve([]); });
    define(electronAPI, "clearCapturedApis", function () {});

    // fetch passthrough (uses page fetch natively for correct cookies/CORS)
    define(electronAPI, "fetch", function (url) {
      return fetch(url)
        .then(function (r) {
          return r.text().then(function (t) {
            return { ok: r.ok, status: r.status, body: t, error: null };
          });
        })
        .catch(function (e) {
          return { ok: false, status: 0, body: null, error: String(e) };
        });
    });

    define(electronAPI, "checkLogin", function () {
      return Promise.resolve({
        status: "unlogged",
        developerId: null,
        error: null,
        profile: null,
        studios: [],
      });
    });

    define(electronAPI, "replayApi", function (_id, url) {
      return fetch(url)
        .then(function (r) {
          return r.text().then(function (t) {
            return { ok: r.ok, status: r.status, body: t, error: null };
          });
        })
        .catch(function (e) {
          return { ok: false, error: String(e) };
        });
    });
    define(electronAPI, "replayKeyApis", function () {
      return Promise.resolve({ count: 0, saved: false });
    });

    // Event subscription stubs
    [
      "onLoginSuccess", "onLoginCheck", "onAccountUpdated", "onStudioSwitched",
      "onApisUpdated", "onTrayRefresh", "onAppResume", "onAppBackgroundTick",
    ].forEach(function (name) {
      define(electronAPI, name, function () {});
    });

    // Recording methods (plain names)
    define(electronAPI, "startRecording", function () {
      return Promise.resolve(recStartResp());
    });
    define(electronAPI, "stopRecording", function () {
      return Promise.resolve(recStopResp());
    });
    define(electronAPI, "pauseRecording", function () {
      return Promise.resolve(recPauseResp());
    });
    define(electronAPI, "resumeRecording", function () {
      return Promise.resolve(recResumeResp());
    });
    define(electronAPI, "getRecordingState", function () {
      return Promise.resolve(recStatusResp());
    });

    // Generic invoke() router (handles hyphenated channel names)
    define(electronAPI, "invoke", function (channel /*, ...args */) {
      return routeChannel(channel);
    });
    define(electronAPI, "send", function (channel /*, ...args */) {
      console.log("[MakerBridge] electronAPI.send:", channel);
    });

    // Hyphenated channel names as direct callable methods
    define(electronAPI, "recording-request-start", function () {
      return Promise.resolve(recStartResp());
    });
    define(electronAPI, "recording-request-stop", function () {
      return Promise.resolve(recStopResp());
    });
    define(electronAPI, "recording-request-pause", function () {
      return Promise.resolve(recPauseResp());
    });
    define(electronAPI, "recording-request-resume", function () {
      return Promise.resolve(recResumeResp());
    });
    define(electronAPI, "recording-request-status", function () {
      return Promise.resolve(recStatusResp());
    });

    // Attach ipcRenderer as a property of electronAPI
    define(electronAPI, "ipcRenderer", ipcRenderer);

    // Install electronAPI on window
    define(window, "electronAPI", electronAPI);

    // -----------------------------------------------------------------------
    // require('electron') polyfill
    // -----------------------------------------------------------------------
    var electronModule = { ipcRenderer: ipcRenderer, electronAPI: electronAPI };
    function requireShim(name) {
      if (name === "electron") return electronModule;
      if (name === "path" || name === "fs" || name === "os" || name === "url") {
        return {};
      }
      throw new Error("Cannot find module '" + name + "'");
    }
    define(window, "require", requireShim);

    // -----------------------------------------------------------------------
    // process.versions.electron — some Electron-detection code checks this.
    // -----------------------------------------------------------------------
    try {
      var proc = {
        type: "renderer",
        platform: "android",
        env: {},
        cwd: function () { return "/"; },
        versions: {
          electron: APP_VERSION,
          chrome: "153.0.0.0",
          node: "18.0.0",
        },
      };
      define(window, "process", proc);
    } catch (e) {
      console.warn("[MakerBridge] Failed to install process shim:", e);
    }

    // -----------------------------------------------------------------------
    // Legacy AndroidBridge
    // -----------------------------------------------------------------------
    try {
      var androidBridge = {};
      define(androidBridge, "isElectron", function () { return true; });
      define(androidBridge, "getAppVersion", function () { return APP_VERSION; });
      define(androidBridge, "getDeveloperId", function () { return null; });
      define(androidBridge, "getActiveDeveloperId", function () { return null; });
      define(androidBridge, "getStudios", function () { return "[]"; });
      define(androidBridge, "switchStudio", function () { return false; });
      define(androidBridge, "getAccounts", function () { return "[]"; });
      define(androidBridge, "switchAccount", function () { return false; });
      define(androidBridge, "addAccount", function () {});
      define(androidBridge, "removeAccount", function () { return false; });
      define(androidBridge, "openLogin", function () {});
      define(androidBridge, "openExplorer", function () {});
      define(androidBridge, "openGameBackend", function () {});
      define(androidBridge, "getCapturedApis", function () { return "[]"; });
      define(androidBridge, "clearCapturedApis", function () {});
      define(androidBridge, "checkUpdate", function () {});
      define(androidBridge, "checkLogin", function () {
        try {
          if (window.__pendingLoginResolve) {
            window.__pendingLoginResolve(
              JSON.stringify({
                status: "unlogged",
                developerId: null,
                error: null,
                profile: null,
                studios: [],
              })
            );
          }
        } catch (_) {}
      });
      define(androidBridge, "fetch", function (id, url) {
        fetch(url)
          .then(function (r) { return r.text(); })
          .then(function (t) {
            if (window.__pendingFetchResolve) {
              window.__pendingFetchResolve(
                id,
                JSON.stringify({ ok: true, status: 200, body: t, error: null })
              );
            }
          })
          .catch(function (e) {
            if (window.__pendingFetchResolve) {
              window.__pendingFetchResolve(
                id,
                JSON.stringify({ ok: false, error: String(e) })
              );
            }
          });
      });
      define(androidBridge, "replayApi", function (id) {
        if (window.__pendingReplayResolve) {
          window.__pendingReplayResolve(
            id,
            JSON.stringify({ ok: false, error: "not_available" })
          );
        }
      });
      define(androidBridge, "replayKeyApis", function () {
        if (window.__pendingReplayKeyResolve) {
          window.__pendingReplayKeyResolve(
            JSON.stringify({ count: 0, saved: false })
          );
        }
      });
      define(window, "AndroidBridge", androidBridge);
    } catch (e) {
      console.warn("[MakerBridge] Failed to install AndroidBridge:", e);
    }

    // Pending callbacks (no-op defaults).
    [
      "__pendingFetchResolve", "__pendingLoginResolve",
      "__pendingReplayResolve", "__pendingReplayKeyResolve",
    ].forEach(function (k) {
      if (!window[k]) window[k] = function () {};
    });

    // -----------------------------------------------------------------------
    // Stub navigator.mediaDevices.getDisplayMedia / getUserMedia to return a
    // fake MediaStream so that if the page still takes the browser-recorder
    // path despite our Electron UA, the Promise resolves cleanly (the page
    // gets a MediaStream it can hand to MediaRecorder) instead of rejecting
    // with Gecko's "is not supported by this user agent" DOMException.
    //
    // We construct the fake stream from a hidden canvas via captureStream()
    // (standard) / mozCaptureStream() (Firefox-prefixed), which produces a
    // real video track MediaRecorder accepts.
    // -----------------------------------------------------------------------
    function makeFakeDisplayStream() {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        // Draw a single black frame; the page won't actually use pixel data.
        var ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        var stream;
        if (typeof canvas.captureStream === "function") {
          stream = canvas.captureStream(30);
        } else if (typeof canvas.mozCaptureStream === "function") {
          stream = canvas.mozCaptureStream(30);
        }
        if (stream && typeof stream.getTracks === "function") {
          console.log("[MakerBridge] getDisplayMedia() -> fake canvas MediaStream with",
                      stream.getVideoTracks().length, "video track(s)");
          return stream;
        }
      } catch (e) {
        console.warn("[MakerBridge] canvas fake stream failed:", e);
      }
      // Last resort: empty MediaStream (spec allows zero tracks).
      try {
        var empty = new MediaStream();
        console.log("[MakerBridge] getDisplayMedia() -> empty MediaStream fallback");
        return empty;
      } catch (e) {
        console.warn("[MakerBridge] empty MediaStream not constructible:", e);
        // Final fallback: reject with NotSupportedError — but by this point we
        // should never land here on GV153.
        throw new DOMException(
          "Screen capture is handled via Electron IPC on this client",
          "NotSupportedError"
        );
      }
    }
    try {
      if (navigator && navigator.mediaDevices) {
        var md = navigator.mediaDevices;
        md.getDisplayMedia = function () {
          console.log("[MakerBridge] getDisplayMedia() called -> returning fake MediaStream");
          try {
            return Promise.resolve(makeFakeDisplayStream());
          } catch (e) {
            return Promise.reject(e);
          }
        };
        // getUserMedia may also be called for audio track.
        md.getUserMedia = function () {
          console.log("[MakerBridge] getUserMedia() called -> returning empty MediaStream");
          try { return Promise.resolve(new MediaStream()); }
          catch (e) { return Promise.reject(e); }
        };
      }
    } catch (e) {
      console.warn("[MakerBridge] Could not stub mediaDevices:", e);
    }

    // -----------------------------------------------------------------------
    // Diagnostic flags
    // -----------------------------------------------------------------------
    window.__makerBridgeVersion = "1.2.1";
    window.__makerBridgeMethods = [
      "startRecording", "stopRecording", "pauseRecording", "resumeRecording", "getRecordingState",
      "recording-request-start", "recording-request-stop",
      "recording-request-pause", "recording-request-resume", "recording-request-status",
      "invoke", "send",
    ];

    // -----------------------------------------------------------------------
    // Dispatch readiness events (with retries for late-init page code).
    // -----------------------------------------------------------------------
    function fireEvent(name) {
      try {
        window.dispatchEvent(new CustomEvent(name));
      } catch (_) {
        try { window.dispatchEvent(new Event(name)); } catch (_) {}
      }
    }
    function announce() {
      fireEvent("electronAPIReady");
      fireEvent("electron-api-ready");
      fireEvent("bridge-ready");
      fireEvent("android-bridge-ready");
      console.log(
        "[MakerBridge] v" + window.__makerBridgeVersion +
        " injected. electronAPI=" + typeof window.electronAPI +
        " ipcRenderer=" + typeof (window.electronAPI && window.electronAPI.ipcRenderer) +
        " stop=" + typeof (window.electronAPI && window.electronAPI["recording-request-stop"])
      );
    }
    announce();
    setTimeout(announce, 0);
    setTimeout(announce, 50);
    setTimeout(announce, 200);
    setTimeout(announce, 1000);
    setTimeout(announce, 3000);
  }

  // ---------------------------------------------------------------------------
  // Inject path 1: eval the bridge source directly in the page realm via
  // wrappedJSObject.eval — this is the primary mechanism.
  // ---------------------------------------------------------------------------
  var bridgeSource = "(" + installBridge.toString() + ")();";
  try {
    pageWindow.eval(bridgeSource);
    console.log("[MakerBridge] Bridge source evaled into page realm (size=" + bridgeSource.length + ").");
  } catch (e) {
    console.error("[MakerBridge] wrappedJSObject.eval failed:", e);
  }

  // ---------------------------------------------------------------------------
  // Inject path 2: <script> tag belt-and-suspenders. CSP on maker.taptap.cn
  // currently allows inline script injection for extension-created nodes
  // (WebExtension-created <script> is treated as privileged). Even if CSP
  // blocks it, path 1 has already done the job.
  // ---------------------------------------------------------------------------
  try {
    var doc = window.document;
    if (doc && doc.documentElement) {
      var script = doc.createElement("script");
      script.textContent = bridgeSource;
      script.setAttribute("data-makerbridge", "1");
      // Insert at the earliest possible point.
      (doc.head || doc.documentElement).appendChild(script);
      // Remove the node after execution to keep DOM clean.
      try { script.parentNode && script.parentNode.removeChild(script); } catch (_) {}
    }
  } catch (e) {
    // Not fatal — path 1 is the primary.
    console.warn("[MakerBridge] <script> injection skipped:", e);
  }

  console.log("[MakerBridge] Content script initialized (document_start, zero-privilege).");
})();
