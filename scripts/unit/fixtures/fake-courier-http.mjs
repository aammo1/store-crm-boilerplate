/**
 * Lightweight, router-based HTTP fetch stub for courier unit tests.
 * Records calls, tracks in-flight concurrency, matches method + path regex,
 * returns standard Response objects or throws to simulate network errors/timeouts.
 */

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

export class FakeCourierHttp {
  constructor() {
    this.routes = [];
    this.calls = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.originalFetch = null;
  }

  /**
   * Register a route handler.
   * @param {string} method HTTP method ("GET", "POST", "*", etc.)
   * @param {RegExp|string} pathRegex Regex or string pattern to match against the full URL or pathname
   * @param {Function} handler (req) => Response | Promise<Response>
   */
  route(method, pathRegex, handler) {
    const regex = typeof pathRegex === "string" ? new RegExp(pathRegex) : pathRegex;
    this.routes.push({
      method: method.toUpperCase(),
      regex,
      handler,
    });
    return this;
  }

  /**
   * Clear recorded calls and concurrency stats.
   */
  reset() {
    this.calls = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  /**
   * Clear registered routes.
   */
  clearRoutes() {
    this.routes = [];
  }

  /**
   * Replace globalThis.fetch with this stub.
   */
  installGlobal() {
    if (!this.originalFetch) {
      this.originalFetch = globalThis.fetch;
    }
    globalThis.fetch = this.fetch;
    return this;
  }

  /**
   * Restore previous globalThis.fetch.
   */
  restoreGlobal() {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  /**
   * Fetch implementation to pass to adapters or assign to globalThis.fetch.
   */
  fetch = async (input, init = {}) => {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    const urlString = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();

    let pathname = urlString;
    let searchParams = new URLSearchParams();
    try {
      const parsed = new URL(urlString, "http://localhost");
      pathname = parsed.pathname;
      searchParams = parsed.searchParams;
    } catch {}

    let bodyText = null;
    let bodyJson = null;
    let bodyForm = null;

    if (init.body) {
      if (typeof init.body === "string") {
        bodyText = init.body;
        try {
          bodyJson = JSON.parse(init.body);
        } catch {}
      } else if (typeof FormData !== "undefined" && init.body instanceof FormData) {
        bodyForm = Object.fromEntries(init.body.entries());
      }
    }

    const recordedCall = {
      url: urlString,
      pathname,
      searchParams,
      method,
      headers: init.headers || {},
      getHeader: (name) => getHeader(init.headers, name),
      rawBody: init.body,
      body: init.body,
      bodyText,
      json: bodyJson,
      formData: bodyForm,
      signal: init.signal,
    };
    this.calls.push(recordedCall);

    try {
      for (const route of this.routes) {
        if (route.method !== "*" && route.method !== method) {
          continue;
        }
        const match = route.regex.exec(urlString) || route.regex.exec(pathname);
        if (match) {
          const res = await route.handler({
            ...recordedCall,
            match,
          });
          return res;
        }
      }
      throw new Error(`FakeCourierHttp: unhandled route [${method}] ${urlString}`);
    } finally {
      this.inFlight--;
    }
  };

  /** Helper to construct JSON Response */
  json(data, init = {}) {
    return Response.json(data, init);
  }

  /** Helper to construct Text Response */
  text(str, init = {}) {
    return new Response(str, init);
  }
}

export function createFakeCourierHttp() {
  return new FakeCourierHttp();
}
