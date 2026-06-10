import { switchPort } from '@cloudflare/containers';
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox,
  proxyToSandbox
} from '@cloudflare/sandbox';
import {
  autoApprove,
  compose,
  enforceModel,
  enforcePolicy,
  type HandlerContext,
  isRequest,
  type JsonRpcMessage,
  log,
  type MessageHandler,
  tryParse
} from './rpc';

export { ContainerProxy };

export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
}

declare global {
  interface Env {
    OPENAI_API_KEY: string;
    ANTHROPIC_API_KEY?: string;
    CLAUDE_CODE_OAUTH_TOKEN?: string;
    AUTH_TOKEN?: string;
    GITHUB_TOKEN?: string;
    SANDBOX_SLEEP_AFTER?: string;
  }
}

const CODEX_WS_PORT = 4500;

// --- Egress control ---
// The container uses OPENAI_BASE_URL=http://api.openai.com/v1 so requests
// hit the outbound handler, which injects the real API key and upgrades to
// HTTPS. The key never enters the container. With interceptHttps = true,
// HTTPS requests are also intercepted via the Cloudflare CA cert.

Sandbox.outboundByHost = {
  'api.openai.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
    headers.delete('X-Api-Key');
    return fetch(`https://api.openai.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
  },
  'api.anthropic.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);

    // Claude picks the auth header based on which env var it sees in the
    // container; mirror that choice here when swapping in the real secret.
    if (headers.has('x-api-key') && env.ANTHROPIC_API_KEY) {
      headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      headers.set('Authorization', `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
      headers.delete('x-api-key');
    }

    const resp = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
    console.log(`[egress] api.anthropic.com ${request.method} ${url.pathname} -> ${resp.status}`);
    return resp;
  },
  'platform.claude.com': async (request: Request, env: Env) => {
    // Claude Code's OAuth flow validates the subscription token here
    // (e.g. /v1/oauth/hello) before hitting api.anthropic.com.
    // TODO: need to verify that this code block is even needed. Should double-check if this path gets
    //  executed actually or if this was part of some sort of debugging of a problem.
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      headers.set('Authorization', `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
      headers.delete('x-api-key');
    }
    const resp = await fetch(`https://platform.claude.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
    console.log(`[egress] platform.claude.com ${request.method} ${url.pathname} -> ${resp.status}`);
    return resp;
  },
  'github.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (env.GITHUB_TOKEN) {
      headers.set(
        'Authorization',
        `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`
      );
    }
    const target = `https://github.com${url.pathname}${url.search}`;
    console.log(`[egress] Allowed: ${request.method} ${target}`);
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body
    });
  }
};

Sandbox.outbound = async (request: Request) => {
  console.log(`[egress] Blocked: ${request.method} ${request.url}`);
  return new Response('Forbidden by egress policy', { status: 403 });
};

// --- Custom command: sandbox/setup ---
// Wipes /workspace and clones a fresh copy of the repo.

function sandboxSetup(sandbox: ReturnType<typeof getSandbox>): MessageHandler {
  return (msg, ctx) => {
    if (
      ctx.direction !== 'client-to-server' ||
      !isRequest(msg) ||
      msg.method !== 'sandbox/setup'
    ) {
      return msg;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const repoUrl = params.repoUrl as string | undefined;
    if (!repoUrl) {
      ctx.sendToClient({
        id: msg.id,
        error: { code: -32602, message: 'Missing param: repoUrl' }
      });
      return null;
    }

    (async () => {
      try {
        await sandbox.exec(
          'find /workspace -mindepth 1 -delete 2>/dev/null; true'
        );
        const result = await sandbox.gitCheckout(repoUrl, {
          branch: params.branch as string | undefined,
          targetDir: '/workspace',
          depth: 1
        });
        ctx.sendToClient({ id: msg.id, result: { ok: true, ...result } });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.sendToClient({ id: msg.id, error: { code: -32000, message } });
      }
    })();

    return null;
  };
}

// --- Custom command: sandbox/exec ---

function sandboxExec(sandbox: ReturnType<typeof getSandbox>): MessageHandler {
  return (msg, ctx) => {
    if (
      ctx.direction !== 'client-to-server' ||
      !isRequest(msg) ||
      msg.method !== 'sandbox/exec'
    ) {
      return msg;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    const command = params.command as string | undefined;
    if (!command) {
      ctx.sendToClient({
        id: msg.id,
        error: { code: -32602, message: 'Missing param: command' }
      });
      return null;
    }

    sandbox
      .exec(command)
      .then((result) => ctx.sendToClient({ id: msg.id, result }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.sendToClient({ id: msg.id, error: { code: -32000, message } });
      });

    return null;
  };
}

// --- Sandbox lifecycle ---

async function ensureCodexRunning(
  sandbox: ReturnType<typeof getSandbox>
): Promise<string> {
  const procs = await sandbox.listProcesses();
  const existing = procs.find((p) => p.id === 'codex-app-server');
  if (
    existing &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    const { stdout } = await sandbox.exec('cat /tmp/codex-ws-token');
    return stdout.trim();
  }

  const token = crypto.randomUUID();

  await sandbox.setEnvVars({
    OPENAI_BASE_URL: 'http://api.openai.com/v1',
    OPENAI_API_KEY: 'proxy-injected',
    ANTHROPIC_BASE_URL: 'http://api.anthropic.com'
  });

  await sandbox.exec(
    `printf '%s' '${token}' > /tmp/codex-ws-token && chmod 600 /tmp/codex-ws-token`
  );

  const proc = await sandbox.startProcess(
    'bash -lc "codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codex-ws-token"',
    { processId: 'codex-app-server' }
  );
  await proc.waitForPort(CODEX_WS_PORT, { mode: 'tcp' });

  return token;
}

// --- Auth ---

function checkAuth(request: Request, url: URL, env: Env): Response | null {
  const token = env.AUTH_TOKEN;
  if (!token) return null;

  const header = request.headers.get('Authorization');
  if (header === `Bearer ${token}`) return null;

  if (url.searchParams.get('token') === token) return null;

  return new Response('Unauthorized', { status: 401 });
}

// --- Worker ---

const SANDBOX_ID_RE = /^\/ws\/([a-zA-Z0-9_-]{1,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const match = url.pathname.match(SANDBOX_ID_RE);
    if (match) return handleWebSocket(request, url, env, match[1]);

    if (url.pathname !== '/') return env.Assets.fetch(request);

    const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new HTMLRewriter()
      .on('html', {
        element(el) {
          el.setAttribute('data-ws-endpoint', `${wsProto}//${url.host}/ws`);
        }
      })
      .transform(await env.Assets.fetch(request));
  }
};

// --- WebSocket bridge ---

async function connectToContainer(
  sandbox: ReturnType<typeof getSandbox>,
  token: string
): Promise<WebSocket> {
  const wsRequest = switchPort(
    new Request('http://container/ws', {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Authorization: `Bearer ${token}`
      }
    }),
    CODEX_WS_PORT
  );
  const ws = (await sandbox.fetch(wsRequest)).webSocket;
  if (!ws) throw new Error('Failed to connect to Codex container');
  return ws;
}

async function handleWebSocket(
  request: Request,
  url: URL,
  env: Env,
  sandboxId: string
): Promise<Response> {
  const denied = checkAuth(request, url, env);
  if (denied) return denied;

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const sleepAfter = env.SANDBOX_SLEEP_AFTER || '1m';
  const sandbox = getSandbox(env.Sandbox, `codex-${sandboxId}`, { sleepAfter });
  await sandbox.destroy();
  const token = await ensureCodexRunning(sandbox);

  const containerWs = await connectToContainer(sandbox, token);

  const [clientWs, serverWs] = Object.values(new WebSocketPair());
  const sendJson = (ws: WebSocket) => (msg: JsonRpcMessage) =>
    ws.send(JSON.stringify(msg));
  const toClient = sendJson(serverWs);
  const toServer = sendJson(containerWs);

  const clientToServerCtx: HandlerContext = {
    direction: 'client-to-server',
    sendToClient: toClient,
    sendToServer: toServer
  };
  const serverToClientCtx: HandlerContext = {
    direction: 'server-to-client',
    sendToClient: toClient,
    sendToServer: toServer
  };

  const pipeline = compose(
    log(),
    enforceModel('gpt-5.4'),
    enforcePolicy({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' }
    }),
    sandboxSetup(sandbox),
    sandboxExec(sandbox),
    autoApprove()
  );

  serverWs.accept();
  containerWs.accept();

  const bridge = (from: WebSocket, to: WebSocket, ctx: HandlerContext) => {
    from.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      const msg = tryParse(raw);
      if (!msg) {
        to.send(raw);
        return;
      }
      const result = pipeline(msg, ctx);
      if (!result) return;
      to.send(result === msg ? raw : JSON.stringify(result));
    });
  };

  bridge(serverWs, containerWs, clientToServerCtx);
  bridge(containerWs, serverWs, serverToClientCtx);

  const safeClose = (ws: WebSocket, code: number, reason: string) => {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  serverWs.addEventListener('close', (e: CloseEvent) =>
    safeClose(containerWs, e.code, e.reason)
  );
  containerWs.addEventListener('close', (e: CloseEvent) =>
    safeClose(serverWs, e.code, e.reason)
  );
  serverWs.addEventListener('error', () =>
    safeClose(containerWs, 1011, 'Client error')
  );
  containerWs.addEventListener('error', () =>
    safeClose(serverWs, 1011, 'Container error')
  );

  return new Response(null, { status: 101, webSocket: clientWs });
}
