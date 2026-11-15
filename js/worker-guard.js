// Loaded first in every worker. The page's Content-Security-Policy is a <meta> tag, and workers
// don't inherit it, so they enforce the same promise themselves: nothing leaves this site.
// (MediaPipe, for one, tries to send usage logs to Google.) Plain script: works in classic and
// module workers alike.
(() => {
  const here = self.location.origin;
  const own = (u) => {
    try {
      const url = new URL(String(u), self.location.href);
      return url.origin === here || url.protocol === "blob:" || url.protocol === "data:";
    } catch {
      return false;
    }
  };
  const blocked = (u) => new TypeError(`Blocked: Unpin doesn't connect to other servers (${String(u).slice(0, 80)})`);

  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input;
    return own(url) ? realFetch(input, init) : Promise.reject(blocked(url));
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (!own(url)) throw blocked(url);
    return open.call(this, method, url, ...rest);
  };
  if (typeof self.importScripts === "function") {
    const importScripts = self.importScripts.bind(self);
    self.importScripts = (...urls) => {
      for (const u of urls) if (!own(u)) throw blocked(u);
      return importScripts(...urls);
    };
  }
  for (const name of ["WebSocket", "EventSource", "WebTransport"]) {
    if (name in self) Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  }
})();
