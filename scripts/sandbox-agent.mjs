#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_WORKER_URL = 'http://localhost:8787';
const DEFAULT_COMMAND = defaultCommand();
const START_TIMEOUT_MS = 120_000;

function usage() {
  console.log(`Usage:
  node scripts/sandbox-agent.mjs [options] [-- command ...]

Options:
  --session <name>       Sandbox session name. Default: current directory name.
  --repo <url>           GitHub repo URL to checkout into /workspace.
  --branch <name>        Branch to checkout.
  --worker-url <url>     Local Worker URL. Default: ${DEFAULT_WORKER_URL}
  --no-setup             Start sandbox but do not run sandbox/setup.
  --shell                Run bash instead of the default command.
  -h, --help             Show this help.

Examples:
  node scripts/sandbox-agent.mjs --repo https://github.com/org/repo -- claude
  node scripts/sandbox-agent.mjs --session demo --shell
  npm run sclaude -- --repo https://github.com/org/repo
`);
}

function parseArgs(argv) {
  const opts = {
    workerUrl: process.env.WORKER_URL || DEFAULT_WORKER_URL,
    session: process.env.SANDBOX_SESSION || null,
    repo: process.env.REPO_URL || null,
    branch: process.env.REPO_BRANCH || null,
    setup: true,
    command: [DEFAULT_COMMAND]
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--session') opts.session = requiredValue(argv, ++i, arg);
    else if (arg === '--repo') opts.repo = requiredValue(argv, ++i, arg);
    else if (arg === '--branch') opts.branch = requiredValue(argv, ++i, arg);
    else if (arg === '--worker-url') opts.workerUrl = requiredValue(argv, ++i, arg);
    else if (arg === '--no-setup') opts.setup = false;
    else if (arg === '--shell') opts.command = ['bash'];
    else fail(`Unknown argument: ${arg}`);
  }

  if (!opts.command.length) opts.command = [DEFAULT_COMMAND];
  opts.session ||= defaultSessionName();
  opts.repo ||= inferGithubRemote();
  opts.repo = opts.repo ? normalizeGithubRemote(opts.repo) : null;
  return opts;
}

function defaultCommand() {
  if (process.env.npm_lifecycle_event === 'scodex') return 'codex';
  return 'claude';
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
  return value;
}

function fail(message) {
  console.error(`sagent: ${message}`);
  process.exit(1);
}

function defaultSessionName() {
  const dir = process.cwd().split('/').filter(Boolean).pop() || 'default';
  return safeSessionName(dir);
}

function safeSessionName(value) {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return safe || 'default';
}

function inferGithubRemote() {
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

function request(ws, method, params) {
  const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
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
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    };

    ws.addEventListener('message', onMessage);
  });
}

async function startSandbox(opts) {
  const wsUrl = workerWsUrl(opts.workerUrl, opts.session);
  console.error(`Starting sandbox session "${opts.session}" via ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out connecting to ${wsUrl}`)),
      START_TIMEOUT_MS
    );
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to ${wsUrl}`));
    });
  });

  if (opts.setup) {
    if (!opts.repo) {
      console.error('No GitHub remote found; skipping sandbox/setup.');
    } else {
      console.error(`Checking out ${opts.repo} into /workspace...`);
      await request(ws, 'sandbox/setup', {
        repoUrl: opts.repo,
        branch: opts.branch || undefined
      });
    }
  }

  return ws;
}

function findSandboxContainer(session) {
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

  const rows = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('-proxy'));

  if (rows.length === 0) {
    fail('No local Wrangler Sandbox container found. Is `npm run dev` running?');
  }

  if (rows.length === 1) return rows[0].split('\t')[0];

  console.error('Multiple sandbox containers are running; using the newest one:');
  for (const row of rows) console.error(`  ${row}`);
  return rows[0].split('\t')[0];
}

// Codex's TUI ignores OPENAI_API_KEY and gates on ~/.codex/auth.json. Seed that
// file from the dummy key (the egress proxy swaps in the real key) so the agent
// starts without an interactive login. App-server mode skips this gate entirely.
function buildContainerCommand(command) {
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
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ws = await startSandbox(opts);
  const containerId = findSandboxContainer(opts.session);

  const command = buildContainerCommand(opts.command);
  console.error(`Execing into ${containerId}: ${opts.command.join(' ')}`);
  const child = spawn('docker', [
    'exec', '-it',
    '-e', 'OPENAI_API_KEY=proxy-injected',
    '-e', 'OPENAI_BASE_URL=http://api.openai.com/v1',
    '-e', 'ANTHROPIC_BASE_URL=http://api.anthropic.com',
    containerId, ...command
  ], {
    stdio: 'inherit'
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });

  ws.close();
  process.exit(exitCode);
}

main().catch((err) => fail(err.message));
