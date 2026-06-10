import assert from 'node:assert/strict';

const DEFAULT_BASE_URL = 'ws://localhost:8787/ws';
const DEFAULT_TIMEOUT_MS = 120_000;

export function uniqueSession(prefix = 'web-app') {
  const cleanPrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
  const suffix = `${Date.now()}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return `${cleanPrefix}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

export function wsBaseUrlFromEnv(env = process.env) {
  return env.WS_BASE_URL || env.WS_URL || DEFAULT_BASE_URL;
}

export function sessionUrl(session, { baseUrl = wsBaseUrlFromEnv(), token } = {}) {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';

  const basePath = url.pathname.match(/^\/ws\/[a-zA-Z0-9_-]{1,64}$/)
    ? '/ws'
    : url.pathname.endsWith('/ws')
      ? url.pathname
      : url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/${session}`;

  if (token) url.searchParams.set('token', token);
  return url;
}

export async function connectWs(
  session = uniqueSession(),
  { baseUrl = wsBaseUrlFromEnv(), token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const ws = new WebSocket(sessionUrl(session, { baseUrl, token }));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out connecting to WebSocket session ${session}`)),
      timeoutMs
    );
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to WebSocket session ${session}`));
      },
      { once: true }
    );
  });

  return new JsonRpcWsClient(ws, session, timeoutMs);
}

export class JsonRpcWsClient {
  #nextId = 1;
  #messages = [];
  #waiters = new Set();

  constructor(ws, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.ws = ws;
    this.session = session;
    this.timeoutMs = timeoutMs;

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      this.#messages.push(message);
      for (const waiter of [...this.#waiters]) {
        waiter.check(message);
      }
    });
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.#nextId++;
    const message = { id, method, params };
    const response = this.waitFor(
      (msg) => msg.id === id && ('result' in msg || 'error' in msg),
      `${method} response`,
      { timeoutMs }
    );
    this.ws.send(JSON.stringify(message));
    return response;
  }

  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ method, params }));
  }

  waitFor(predicate, label, { timeoutMs = this.timeoutMs } = {}) {
    const existing = this.#messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        check: (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  async initializeAndStartThread() {
    const init = await this.request('initialize', {
      clientInfo: {
        name: 'web_app_integration_test',
        title: 'Web App Integration Test',
        version: '1.0.0'
      },
      capabilities: { experimentalApi: true }
    });
    assert.ifError(init.error);
    assert.ok(init.result, 'initialize returned a result');

    this.notify('initialized');

    const thread = await this.request('thread/start');
    assert.ifError(thread.error);
    assert.ok(thread.result?.thread?.id, 'thread/start returned a thread id');

    return { init: init.result, thread: thread.result.thread };
  }

  sandboxExec(command, options = {}) {
    return this.request('sandbox/exec', { command }, options);
  }

  sandboxSetup(repoUrl, branch, options = {}) {
    const params = branch ? { repoUrl, branch } : { repoUrl };
    return this.request('sandbox/setup', params, options);
  }

  close() {
    if (
      this.ws.readyState !== WebSocket.OPEN &&
      this.ws.readyState !== WebSocket.CONNECTING
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      this.ws.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      this.ws.close();
    });
  }
}
