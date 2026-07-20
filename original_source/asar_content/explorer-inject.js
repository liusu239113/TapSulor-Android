/**
 * explorer-inject.js - 注入到探测窗口页面上下文的 API 拦截器
 *
 * 由主进程在 dom-ready 时通过 webContents.executeJavaScript 注入
 * 运行在页面上下文，可直接 monkey-patch fetch / XMLHttpRequest
 * 通过 contextBridge 暴露的 window.taptapExplorer.sendApiCaptured 回传数据
 */
(function () {
  const API_FILTER = 'developer.taptap.cn/api/';

  // ========== 拦截 fetch ==========
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    let url = '';
    let method = 'GET';

    if (typeof args[0] === 'string') {
      url = args[0];
    } else if (args[0] && args[0].url) {
      url = args[0].url;
      method = args[0].method || 'GET';
    }

    if (args[1] && args[1].method) {
      method = args[1].method;
    }

    const response = await originalFetch.apply(this, args);

    if (url.includes(API_FILTER)) {
      try {
        const clone = response.clone();
        const body = await clone.text();
        window.taptapExplorer.sendApiCaptured({
          url: url,
          method: method.toUpperCase(),
          status: response.status,
          body: body.substring(0, 100000)
        });
      } catch (e) {
        // 忽略读取 body 失败
      }
    }

    return response;
  };

  // ========== 拦截 XMLHttpRequest ==========
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__captured_method = method;
    this.__captured_url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      if (this.__captured_url && this.__captured_url.includes(API_FILTER)) {
        try {
          window.taptapExplorer.sendApiCaptured({
            url: this.__captured_url,
            method: (this.__captured_method || 'GET').toUpperCase(),
            status: this.status,
            body: (this.responseText || '').substring(0, 100000)
          });
        } catch (e) {
          // 忽略
        }
      }
    });
    return originalSend.apply(this, [body]);
  };

  console.log('[explorer-inject] API 拦截器已注入页面上下文');
})();
