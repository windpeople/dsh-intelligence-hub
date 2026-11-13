/** Shared HTTP fetch helper: timeout, UA, per-fetcher rate limit, retry w/ backoff. */

const DEFAULT_UA = 'dsh-intelligence-hub/0.1.0 (+https://github.com/local; research collector)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Create a rate-limited GET-text fetcher.
 * opts: { fetchImpl, timeoutMs, retries, minDelayMs, headers }
 * fetchImpl may return a WHATWG Response or an object with .text().
 */
export function createFetcher(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
    retries = 2,
    minDelayMs = 300,
    headers = {},
  } = opts;
  let lastAt = 0;

  async function getText(url, { headers: extraHeaders } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error(`invalid url: ${url}`);
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = minDelayMs - (Date.now() - lastAt);
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      try {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': DEFAULT_UA, accept: '*/*', ...headers, ...extraHeaders },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const status = res.status;
        if (status >= 200 && status < 300) {
          return await res.text();
        }
        if (isRetryableStatus(status) && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${status} for ${url}`);
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableStatus(Number(err.message?.match(/HTTP (\d+)/)?.[1] || 0)) ||
          err.name === 'TimeoutError' || err.name === 'AbortError' ||
          err.name === 'TypeError' /* network */;
        if (retryable && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error(`fetch failed: ${url}`);
  }

  /** Fetch JSON with the same retry/ratelimit path. */
  async function getJson(url, extra = {}) {
    const text = await getText(url, { headers: { accept: 'application/json' }, ...extra });
    return JSON.parse(text);
  }

  return { getText, getJson, fetchImpl, timeoutMs, retries };
}
