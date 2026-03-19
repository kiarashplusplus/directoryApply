// DirectoryApply — Injected into MAIN world at document_start
// Intercepts fetch/XHR to capture Algolia API credentials and search parameters
(function () {
  "use strict";

  const DA_MSG_TYPE = "DIRECTORY_APPLY_ALGOLIA_INTERCEPTED";

  function isAlgoliaUrl(url) {
    return (
      url &&
      (url.includes(".algolia.net") || url.includes(".algolianet.com"))
    );
  }

  function extractAlgoliaData(url, headers, body) {
    try {
      const urlObj = new URL(url);
      // App ID is the first segment of the hostname: {APP_ID}-dsn.algolia.net
      const appId =
        urlObj.hostname.split("-")[0] || urlObj.hostname.split(".")[0];

      let apiKey = "";
      if (headers) {
        // Handle both Headers object and plain object
        if (typeof headers.get === "function") {
          apiKey =
            headers.get("x-algolia-api-key") ||
            headers.get("X-Algolia-API-Key") ||
            "";
        } else {
          apiKey =
            headers["x-algolia-api-key"] ||
            headers["X-Algolia-API-Key"] ||
            "";
        }
      }

      let parsedBody = null;
      if (body) {
        try {
          parsedBody = typeof body === "string" ? JSON.parse(body) : body;
        } catch (_) {}
      }

      return { appId, apiKey, url, body: parsedBody };
    } catch (_) {
      return null;
    }
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const [resource, init] = args;
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof Request
          ? resource.url
          : String(resource);

    if (isAlgoliaUrl(url)) {
      const headers = init?.headers || {};
      const body = init?.body || null;
      const data = extractAlgoliaData(url, headers, body);
      if (data) {
        window.postMessage({ type: DA_MSG_TYPE, data }, window.location.origin);
      }
    }

    return originalFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._daUrl = typeof url === "string" ? url : String(url);
    this._daHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._daHeaders) {
      this._daHeaders[name] = value;
    }
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (isAlgoliaUrl(this._daUrl)) {
      const data = extractAlgoliaData(this._daUrl, this._daHeaders, body);
      if (data) {
        window.postMessage({ type: DA_MSG_TYPE, data }, window.location.origin);
      }
    }
    return originalSend.call(this, body);
  };

  console.log("[DirectoryApply] Algolia interceptor active");
})();
