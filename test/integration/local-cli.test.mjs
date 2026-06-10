import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDockerExecArgs,
  runCli
} from '../../scripts/sandbox-agent.mjs';

function createHarness({
  env = {},
  argv = [],
  childExit = { code: 0, signal: null }
} = {}) {
  const calls = {
    startSandbox: [],
    findSandboxContainer: [],
    spawn: [],
    closeCount: 0,
    stderr: []
  };
  const ws = {
    close() {
      calls.closeCount += 1;
    }
  };

  const deps = {
    env,
    cwd: '/tmp/app-server',
    execFileSync() {
      return '';
    },
    stderr(message) {
      calls.stderr.push(message);
    },
    async startSandbox(opts) {
      calls.startSandbox.push(structuredClone(opts));
      return ws;
    },
    findSandboxContainer(session) {
      calls.findSandboxContainer.push(session);
      return 'container-123';
    },
    spawn(command, args, options) {
      const child = new EventEmitter();
      calls.spawn.push({ command, args, options, child });
      queueMicrotask(() => {
        child.emit('exit', childExit.code, childExit.signal);
      });
      return child;
    }
  };

  return {
    argv,
    calls,
    run() {
      return runCli(argv, deps);
    }
  };
}

function dockerArgsFor(calls) {
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].command, 'docker');
  return calls.spawn[0].args;
}

function dockerCommandFor(calls) {
  const args = dockerArgsFor(calls);
  const containerIndex = args.indexOf('container-123');
  assert.notEqual(containerIndex, -1);
  return args.slice(containerIndex + 1);
}

test('sclaude default path starts sandbox and execs the Claude launcher', async () => {
  const harness = createHarness({
    env: { npm_lifecycle_event: 'sclaude' }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.findSandboxContainer, ['app-server']);
  assert.equal(harness.calls.startSandbox.length, 1);
  assert.equal(harness.calls.startSandbox[0].session, 'app-server');
  assert.equal(harness.calls.startSandbox[0].setup, true);
  assert.deepEqual(harness.calls.startSandbox[0].command, ['claude']);

  const command = dockerCommandFor(harness.calls);
  assert.deepEqual(command.slice(0, 3), ['bash', '-lc', command[2]]);
  assert.equal(command[3], 'claude-launcher');
  assert.equal(command[4], 'claude');
  assert.match(command[2], /~\/\.claude\/\.credentials\.json/);
});

test('scodex lifecycle defaults to the Codex launcher', async () => {
  const harness = createHarness({
    env: { npm_lifecycle_event: 'scodex' }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.startSandbox[0].command, ['codex']);

  const command = dockerCommandFor(harness.calls);
  assert.deepEqual(command.slice(0, 3), ['bash', '-lc', command[2]]);
  assert.equal(command[3], 'codex-launcher');
  assert.equal(command[4], 'codex');
  assert.match(command[2], /codex login --with-api-key/);
});

test('sagent --shell runs bash without an agent bootstrap wrapper', async () => {
  const harness = createHarness({
    argv: ['--shell'],
    env: { npm_lifecycle_event: 'sagent' }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.calls.startSandbox[0].command, ['bash']);
  assert.deepEqual(dockerCommandFor(harness.calls), ['bash']);
});

test('--no-setup explicit command skips setup and passes command through', async () => {
  const harness = createHarness({
    argv: ['--no-setup', '--', 'echo', 'CLI_OK'],
    env: { npm_lifecycle_event: 'sagent' }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 0);
  assert.equal(harness.calls.startSandbox[0].setup, false);
  assert.deepEqual(harness.calls.startSandbox[0].command, ['echo', 'CLI_OK']);
  assert.deepEqual(dockerCommandFor(harness.calls), ['echo', 'CLI_OK']);
});

test('--no-tty uses non-interactive docker exec args', async () => {
  const args = buildDockerExecArgs('abc123', ['echo', 'OK'], { tty: false });

  assert.deepEqual(args.slice(0, 2), ['exec', '-i']);
  assert.equal(args.includes('-it'), false);
  assert.deepEqual(args.slice(-2), ['echo', 'OK']);
});

test('interactive docker exec remains the default', async () => {
  const harness = createHarness({
    argv: ['--', 'echo', 'TTY_OK'],
    env: { npm_lifecycle_event: 'sagent' }
  });

  await harness.run();

  assert.deepEqual(dockerArgsFor(harness.calls).slice(0, 2), ['exec', '-it']);
});

test('runCli returns the child exit code and closes the WebSocket', async () => {
  const harness = createHarness({
    argv: ['--', 'sh', '-lc', 'exit 7'],
    childExit: { code: 7, signal: null }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 7);
  assert.equal(harness.calls.closeCount, 1);
});

test('runCli maps child signals to 128 and closes the WebSocket', async () => {
  const harness = createHarness({
    argv: ['--', 'sleep', '10'],
    childExit: { code: null, signal: 'SIGTERM' }
  });

  const exitCode = await harness.run();

  assert.equal(exitCode, 128);
  assert.equal(harness.calls.closeCount, 1);
});
