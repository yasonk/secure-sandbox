import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CliError,
  buildContainerCommand,
  buildDockerExecArgs,
  defaultCommand,
  normalizeGithubRemote,
  parseArgs,
  parseDockerPsRows,
  safeSessionName,
  selectSandboxContainer,
  startSandbox,
  workerWsUrl
} from '../../scripts/sandbox-agent.mjs';

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => entry !== listener));
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function throwingGit() {
  throw new Error('no remote');
}

function parse(argv, deps = {}) {
  return parseArgs(argv, {
    env: {},
    cwd: '/tmp/app-server',
    execFileSync: throwingGit,
    ...deps
  });
}

test('defaultCommand uses npm lifecycle event', () => {
  assert.equal(defaultCommand({ npm_lifecycle_event: 'scodex' }), 'codex');
  assert.equal(defaultCommand({ npm_lifecycle_event: 'sclaude' }), 'claude');
  assert.equal(defaultCommand({ npm_lifecycle_event: 'sagent' }), 'claude');
  assert.equal(defaultCommand({}), 'claude');
});

test('parseArgs returns defaults and infers sanitized session from cwd', () => {
  const opts = parse([]);

  assert.equal(opts.workerUrl, 'http://localhost:8787');
  assert.equal(opts.session, 'app-server');
  assert.equal(opts.repo, null);
  assert.equal(opts.branch, null);
  assert.equal(opts.setup, true);
  assert.equal(opts.tty, true);
  assert.deepEqual(opts.command, ['claude']);
});

test('parseArgs respects environment defaults', () => {
  const opts = parse([], {
    env: {
      WORKER_URL: 'http://127.0.0.1:9999',
      SANDBOX_SESSION: 'from-env',
      REPO_URL: 'git@github.com:org/repo.git',
      REPO_BRANCH: 'feature',
      npm_lifecycle_event: 'scodex'
    }
  });

  assert.equal(opts.workerUrl, 'http://127.0.0.1:9999');
  assert.equal(opts.session, 'from-env');
  assert.equal(opts.repo, 'https://github.com/org/repo.git');
  assert.equal(opts.branch, 'feature');
  assert.deepEqual(opts.command, ['codex']);
});

test('parseArgs parses flags and explicit command override', () => {
  const opts = parse([
    '--session', 'demo.session',
    '--repo', 'https://github.com/org/repo',
    '--branch', 'main',
    '--worker-url', 'https://worker.example/base?x=1',
    '--no-setup',
    '--no-tty',
    '--',
    'bash',
    '-lc',
    'pwd'
  ]);

  assert.equal(opts.session, 'demo.session');
  assert.equal(opts.repo, 'https://github.com/org/repo');
  assert.equal(opts.branch, 'main');
  assert.equal(opts.workerUrl, 'https://worker.example/base?x=1');
  assert.equal(opts.setup, false);
  assert.equal(opts.tty, false);
  assert.deepEqual(opts.command, ['bash', '-lc', 'pwd']);
});

test('parseArgs supports --shell, --tty, help, and empty explicit command fallback', () => {
  assert.deepEqual(parse(['--shell']).command, ['bash']);
  assert.equal(parse(['--no-tty', '--tty']).tty, true);

  const emptyCommand = parse(['--'], {
    env: { npm_lifecycle_event: 'scodex' }
  });
  assert.deepEqual(emptyCommand.command, ['codex']);

  const output = [];
  const help = parse(['--help'], { stdout: (message) => output.push(message) });
  assert.equal(help.help, true);
  assert.match(output.join('\n'), /Usage:/);
});

test('parseArgs throws CliError for unknown args and missing values', () => {
  assert.throws(() => parse(['--unknown']), CliError);
  assert.throws(() => parse(['--session']), /Missing value for --session/);
  assert.throws(() => parse(['--repo', '--branch']), /Missing value for --repo/);
  assert.throws(() => parse(['--branch']), /Missing value for --branch/);
  assert.throws(() => parse(['--worker-url']), /Missing value for --worker-url/);
});

test('parseArgs infers and normalizes git remote when no repo is provided', () => {
  const opts = parse([], {
    execFileSync(command, args) {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['config', '--get', 'remote.origin.url']);
      return 'git@github.com:owner/project.git\n';
    }
  });

  assert.equal(opts.repo, 'https://github.com/owner/project.git');
});

test('normalizeGithubRemote handles GitHub SSH remotes only', () => {
  assert.equal(
    normalizeGithubRemote('git@github.com:org/repo.git'),
    'https://github.com/org/repo.git'
  );
  assert.equal(
    normalizeGithubRemote('git@github.com:org/repo'),
    'https://github.com/org/repo'
  );
  assert.equal(
    normalizeGithubRemote('https://github.com/org/repo'),
    'https://github.com/org/repo'
  );
  assert.equal(
    normalizeGithubRemote('git@gitlab.com:org/repo.git'),
    'git@gitlab.com:org/repo.git'
  );
});

test('safeSessionName sanitizes and truncates session names', () => {
  assert.equal(safeSessionName('abcXYZ-09_name'), 'abcXYZ-09_name');
  assert.equal(safeSessionName('space and.dot/slash'), 'space-and-dot-slash');
  assert.equal(safeSessionName(''), 'default');
  assert.equal(safeSessionName('!'), '-');
  assert.equal(safeSessionName('a'.repeat(80)), 'a'.repeat(64));
});

test('workerWsUrl converts worker URL to sanitized WebSocket endpoint', () => {
  assert.equal(
    workerWsUrl('http://localhost:8787', 'demo'),
    'ws://localhost:8787/ws/demo'
  );
  assert.equal(
    workerWsUrl('https://example.com/base?token=secret', 'bad session'),
    'wss://example.com/ws/bad-session'
  );
  assert.equal(
    workerWsUrl('http://127.0.0.1:8787/nested/path?x=1', 'demo'),
    'ws://127.0.0.1:8787/ws/demo'
  );
});

test('buildContainerCommand wraps codex command with login bootstrap', () => {
  const command = buildContainerCommand(['codex', '--version']);

  assert.deepEqual(command.slice(0, 3), ['bash', '-lc', command[2]]);
  assert.match(command[2], /cd \/workspace/);
  assert.match(command[2], /codex login --with-api-key/);
  assert.match(command[2], /exec "\$@"/);
  assert.deepEqual(command.slice(3), ['codex-launcher', 'codex', '--version']);
});

test('buildContainerCommand wraps claude command with dummy credential bootstrap', () => {
  const command = buildContainerCommand(['claude', '-p', 'hello'], {
    now: () => 1_000
  });

  assert.deepEqual(command.slice(0, 3), ['bash', '-lc', command[2]]);
  assert.match(command[2], /mkdir -p ~\/\.claude/);
  assert.match(command[2], /~\/\.claude\/\.credentials\.json/);
  assert.match(command[2], /chmod 600 ~\/\.claude\/\.credentials\.json/);
  assert.match(command[2], /~\/\.claude\.json/);
  assert.match(command[2], /sk-ant-oat01-proxy-injected/);
  assert.match(command[2], /sk-ant-ort01-proxy-injected/);
  assert.match(command[2], /"hasCompletedOnboarding":true/);
  assert.match(command[2], /"expiresAt":31536001000/);
  assert.match(command[2], /cd \/workspace/);
  assert.match(command[2], /exec "\$@"/);
  assert.deepEqual(command.slice(3), ['claude-launcher', 'claude', '-p', 'hello']);
});

test('buildContainerCommand leaves arbitrary commands unchanged', () => {
  const command = ['bash', '-lc', 'echo ok'];

  assert.equal(buildContainerCommand(command), command);
});

test('buildDockerExecArgs builds interactive and non-interactive docker exec args', () => {
  assert.deepEqual(
    buildDockerExecArgs('abc123', ['bash'], { tty: true }),
    [
      'exec',
      '-it',
      '-e',
      'OPENAI_API_KEY=proxy-injected',
      '-e',
      'OPENAI_BASE_URL=http://api.openai.com/v1',
      '-e',
      'ANTHROPIC_BASE_URL=http://api.anthropic.com',
      'abc123',
      'bash'
    ]
  );

  assert.deepEqual(
    buildDockerExecArgs('abc123', ['echo', 'ok'], { tty: false }),
    [
      'exec',
      '-i',
      '-e',
      'OPENAI_API_KEY=proxy-injected',
      '-e',
      'OPENAI_BASE_URL=http://api.openai.com/v1',
      '-e',
      'ANTHROPIC_BASE_URL=http://api.anthropic.com',
      'abc123',
      'echo',
      'ok'
    ]
  );
});

test('parseDockerPsRows trims rows and removes proxy containers', () => {
  const rows = parseDockerPsRows(`
    abc123\tworkerd-sandbox-codex-app-server-Sandbox-1\t2026
    proxy1\tworkerd-sandbox-codex-app-server-Sandbox-1-proxy\t2026

    def456\tworkerd-sandbox-codex-app-server-Sandbox-2\t2026
  `);

  assert.deepEqual(rows, [
    'abc123\tworkerd-sandbox-codex-app-server-Sandbox-1\t2026',
    'def456\tworkerd-sandbox-codex-app-server-Sandbox-2\t2026'
  ]);
});

test('selectSandboxContainer returns one container or newest with warning', () => {
  assert.equal(
    selectSandboxContainer(['abc123\tname\tdate'], 'demo'),
    'abc123'
  );

  const warnings = [];
  assert.equal(
    selectSandboxContainer(
      ['newest\tname-new\tdate', 'older\tname-old\tdate'],
      'demo',
      { stderr: (message) => warnings.push(message) }
    ),
    'newest'
  );
  assert.match(warnings.join('\n'), /Multiple sandbox containers/);
});

test('selectSandboxContainer fails when no containers are present', () => {
  assert.throws(
    () => selectSandboxContainer([], 'demo', { stderr() {} }),
    /No local Wrangler Sandbox container found/
  );
});

test('startSandbox opens websocket and sends setup request with branch', async () => {
  FakeWebSocket.instances = [];
  const requests = [];

  const ws = await startSandbox(
    {
      workerUrl: 'http://localhost:8787',
      session: 'demo session',
      setup: true,
      repo: 'https://github.com/org/repo',
      branch: 'main'
    },
    {
      WebSocket: FakeWebSocket,
      stderr() {},
      request(socket, method, params) {
        requests.push({ socket, method, params });
        return Promise.resolve({ ok: true });
      }
    }
  );

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(ws.url, 'ws://localhost:8787/ws/demo-session');
  assert.deepEqual(requests, [
    {
      socket: ws,
      method: 'sandbox/setup',
      params: {
        repoUrl: 'https://github.com/org/repo',
        branch: 'main'
      }
    }
  ]);
});

test('startSandbox skips setup request when disabled or repo is unavailable', async () => {
  for (const opts of [
    { setup: false, repo: 'https://github.com/org/repo' },
    { setup: true, repo: null }
  ]) {
    const requests = [];
    await startSandbox(
      {
        workerUrl: 'http://localhost:8787',
        session: 'demo',
        branch: null,
        ...opts
      },
      {
        WebSocket: FakeWebSocket,
        stderr() {},
        request(socket, method, params) {
          requests.push({ socket, method, params });
          return Promise.resolve({ ok: true });
        }
      }
    );
    assert.deepEqual(requests, []);
  }
});

test('startSandbox rejects websocket errors and setup failures', async () => {
  class ErrorWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this.emit('error', {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  await assert.rejects(
    startSandbox(
      {
        workerUrl: 'http://localhost:8787',
        session: 'demo',
        setup: false,
        repo: null
      },
      {
        WebSocket: ErrorWebSocket,
        stderr() {}
      }
    ),
    /Failed to connect/
  );

  await assert.rejects(
    startSandbox(
      {
        workerUrl: 'http://localhost:8787',
        session: 'demo',
        setup: true,
        repo: 'https://github.com/org/repo',
        branch: null
      },
      {
        WebSocket: FakeWebSocket,
        stderr() {},
        request() {
          return Promise.reject(new Error('setup failed'));
        }
      }
    ),
    /setup failed/
  );
});
