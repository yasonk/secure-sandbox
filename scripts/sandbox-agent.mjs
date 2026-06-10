#!/usr/bin/env node

import { execFileSync as realExecFileSync, spawn as realSpawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_WORKER_URL = 'http://localhost:8787';
const START_TIMEOUT_MS = 120_000;

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

function usage(stdout = console.log) {
  stdout(`Usage:
  node scripts/sandbox-agent.mjs [options] [-- command ...]

Options:
  --session <name>       Sandbox session name. Default: current directory name.
  --repo <url>           GitHub repo URL to checkout into /workspace.
  --branch <name>        Branch to checkout.
  --worker-url <url>     Local Worker URL. Default: ${DEFAULT_WORKER_URL}
  --no-setup             Start sandbox but do not run sandbox/setup.
  --shell                Run bash instead of the default command.
  --no-tty               Use non-interactive docker exec (-i instead of -it).
  --tty                  Force interactive docker exec (-it).
  -h, --help             Show this help.

Examples:
  node scripts/sandbox-agent.mjs --repo https://github.com/org/repo -- claude
  node scripts/sandbox-agent.mjs --session demo --shell
  npm run sclaude -- --repo https://github.com/org/repo
`);
}

function parseArgs(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? console.log;
  const execFileSync = deps.execFileSync ?? realExecFileSync;
  const defaultCmd = defaultCommand(env);
  const opts = {
    workerUrl: env.WORKER_URL || DEFAULT_WORKER_URL,
    session: env.SANDBOX_SESSION || null,
    repo: env.REPO_URL || null,
    branch: env.REPO_BRANCH || null,
    setup: true,
    tty: true,
    command: [defaultCmd]
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (arg === '-h' || arg === '--help') {
      usage(stdout);
      return { ...opts, help: true };
    }
    if (arg === '--session') opts.session = requiredValue(argv, ++i, arg);
    else if (arg === '--repo') opts.repo = requiredValue(argv, ++i, arg);
    else if (arg === '--branch') opts.branch = requiredValue(argv, ++i, arg);
    else if (arg === '--worker-url') opts.workerUrl = requiredValue(argv, ++i, arg);
    else if (arg === '--no-setup') opts.setup = false;
    else if (arg === '--shell') opts.command = ['bash'];
    else if (arg === '--no-tty') opts.tty = false;
    else if (arg === '--tty') opts.tty = true;
    else fail(`Unknown argument: ${arg}`);
  }

  if (!opts.command.length) opts.command = [defaultCmd];
  opts.session ||= defaultSessionName(cwd);
  opts.repo ||= inferGithubRemote({ execFileSync });
  opts.repo = opts.repo ? normalizeGithubRemote(opts.repo) : null;
  return opts;
}

function defaultCommand(env = process.env) {
  if (env.npm_lifecycle_event === 'scodex') return 'codex';
  return 'claude';
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
  return value;
}

function fail(message) {
  throw new CliError(message);
}

function defaultSessionName(cwd = process.cwd()) {
  const dir = cwd.split('/').filter(Boolean).pop() || 'default';
  return safeSessionName(dir);
}

function safeSessionName(value) {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return safe || 'default';
}

function inferGithubRemote(deps = {}) {
  const execFileSync = deps.execFileSync ?? realExecFileSync;
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

function normalizeGithubRemote(remote) {
  const sshMatch = remote.match(/^git@github\.com:(.+)$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  return remote;
}

function workerWsUrl(workerUrl, session) {
  const url = new URL(workerUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/${safeSessionName(session)}`;
  url.search = '';
  return url.toString();
}

function request(ws, method, params, deps = {}) {
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const id = Math.floor(random() * Number.MAX_SAFE_INTEGER);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimer(
      () => reject(new Error(`Timed out waiting for ${method}`)),
      START_TIMEOUT_MS
    );

    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimer(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    };

    ws.addEventListener('message', onMessage);
  });
}

async function startSandbox(opts, deps = {}) {
  const WebSocketImpl = deps.WebSocket ?? globalThis.WebSocket;
  const requestFn = deps.request ?? request;
  const stderr = deps.stderr ?? console.error;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const wsUrl = workerWsUrl(opts.workerUrl, opts.session);
  stderr(`Starting sandbox session "${opts.session}" via ${wsUrl}`);

  const ws = new WebSocketImpl(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimer(
      () => reject(new Error(`Timed out connecting to ${wsUrl}`)),
      START_TIMEOUT_MS
    );
    ws.addEventListener('open', () => {
      clearTimer(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimer(timer);
      reject(new Error(`Failed to connect to ${wsUrl}`));
    });
  });

  if (opts.setup) {
    if (!opts.repo) {
      stderr('No GitHub remote found; skipping sandbox/setup.');
    } else {
      stderr(`Checking out ${opts.repo} into /workspace...`);
      await requestFn(ws, 'sandbox/setup', {
        repoUrl: opts.repo,
        branch: opts.branch || undefined
      });
    }
  }

  return ws;
}

function parseDockerPsRows(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('-proxy'));
}

function selectSandboxContainer(rows, session, deps = {}) {
  const stderr = deps.stderr ?? console.error;
  if (rows.length === 0) {
    fail('No local Wrangler Sandbox container found. Is `npm run dev` running?');
  }

  if (rows.length === 1) return rows[0].split('\t')[0];

  stderr('Multiple sandbox containers are running; using the newest one:');
  for (const row of rows) stderr(`  ${row}`);
  return rows[0].split('\t')[0];
}

function findSandboxContainer(session, deps = {}) {
  const execFileSync = deps.execFileSync ?? realExecFileSync;
  const workerName = 'codex-app-server';
  const output = execFileSync(
    'docker',
    [
      'ps',
      '--filter',
      `name=workerd-sandbox-${workerName}-Sandbox`,
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}'
    ],
    { encoding: 'utf8' }
  ).trim();

  return selectSandboxContainer(parseDockerPsRows(output), session, deps);
}

// Codex's TUI ignores OPENAI_API_KEY and gates on ~/.codex/auth.json. Seed that
// file from the dummy key (the egress proxy swaps in the real key) so the agent
// starts without an interactive login. App-server mode skips this gate entirely.
function buildContainerCommand(command, deps = {}) {
  if (command[0] === 'codex') {
    return [
      'bash', '-lc',
      'cd /workspace 2>/dev/null; printf \'%s\' "$OPENAI_API_KEY" | codex login --with-api-key && exec "$@"',
      'codex-launcher',
      ...command
    ];
  }
  if (command[0] === 'claude') {
    // Claude Code's CLAUDE_CODE_OAUTH_TOKEN env var is unreliable (anthropics/
    // claude-code#8938) and overrides the credentials file (#16238), so we seed
    // ~/.claude/.credentials.json directly and mark onboarding complete. The
    // dummy access token is swapped for the real one by the egress proxy; the
    // far-future expiry stops Claude from attempting a token refresh.
    const now = deps.now ?? Date.now;
    const expiresAt = now() + 365 * 24 * 60 * 60 * 1000;
    const creds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-proxy-injected',
        refreshToken: 'sk-ant-ort01-proxy-injected',
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max'
      }
    });
    const onboarding = JSON.stringify({ hasCompletedOnboarding: true });
    const prelude =
      'mkdir -p ~/.claude && ' +
      `printf '%s' '${creds}' > ~/.claude/.credentials.json && ` +
      'chmod 600 ~/.claude/.credentials.json && ' +
      `printf '%s' '${onboarding}' > ~/.claude.json && ` +
      'cd /workspace 2>/dev/null;';
    return ['bash', '-lc', `${prelude} exec "$@"`, 'claude-launcher', ...command];
  }
  return command;
}

function buildDockerExecArgs(containerId, command, opts = {}) {
  const tty = opts.tty ?? true;
  return [
    'exec',
    tty ? '-it' : '-i',
    '-e', 'OPENAI_API_KEY=proxy-injected',
    '-e', 'OPENAI_BASE_URL=http://api.openai.com/v1',
    '-e', 'ANTHROPIC_BASE_URL=http://api.anthropic.com',
    containerId,
    ...command
  ];
}

async function runCli(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const execFileSync = deps.execFileSync ?? realExecFileSync;
  const spawn = deps.spawn ?? realSpawn;
  const stderr = deps.stderr ?? console.error;
  const opts = parseArgs(argv, {
    env,
    cwd,
    execFileSync,
    stdout: deps.stdout,
    stderr
  });
  if (opts.help) return 0;

  const ws = await (deps.startSandbox ?? startSandbox)(opts, {
    WebSocket: deps.WebSocket,
    request: deps.request,
    stderr
  });
  const containerId = (deps.findSandboxContainer ?? findSandboxContainer)(opts.session, {
    execFileSync,
    stderr
  });

  const command = buildContainerCommand(opts.command);
  stderr(`Execing into ${containerId}: ${opts.command.join(' ')}`);
  const child = spawn('docker', buildDockerExecArgs(containerId, command, { tty: opts.tty }), {
    stdio: 'inherit'
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });

  ws.close();
  return exitCode;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const stderr = deps.stderr ?? console.error;
  const exit = deps.exit ?? process.exit;
  try {
    const exitCode = await runCli(argv, deps);
    exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(`sagent: ${message}`);
    exit(1);
  }
}

export {
  CliError,
  DEFAULT_WORKER_URL,
  START_TIMEOUT_MS,
  buildContainerCommand,
  buildDockerExecArgs,
  defaultCommand,
  defaultSessionName,
  findSandboxContainer,
  inferGithubRemote,
  main,
  normalizeGithubRemote,
  parseArgs,
  parseDockerPsRows,
  request,
  runCli,
  safeSessionName,
  selectSandboxContainer,
  startSandbox,
  usage,
  workerWsUrl
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
