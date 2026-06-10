import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContainerCommand,
  buildDockerExecArgs,
  parseArgs
} from '../../scripts/sandbox-agent.mjs';

test('scodex lifecycle defaults the launcher command to codex', () => {
  const opts = parseArgs([], {
    env: { npm_lifecycle_event: 'scodex' },
    cwd: '/tmp/app-server',
    execFileSync: () => {
      throw new Error('no remote');
    }
  });

  assert.deepEqual(opts.command, ['codex']);
  assert.equal(opts.session, 'app-server');
  assert.equal(opts.setup, true);
  assert.equal(opts.tty, true);
});

test('scodex explicit command and no-tty flags override defaults', () => {
  const opts = parseArgs(
    ['--session', 'codex test', '--no-tty', '--', 'codex', '--version'],
    {
      env: { npm_lifecycle_event: 'scodex' },
      cwd: '/tmp/app-server',
      execFileSync: () => {
        throw new Error('no remote');
      }
    }
  );

  assert.deepEqual(opts.command, ['codex', '--version']);
  assert.equal(opts.session, 'codex test');
  assert.equal(opts.tty, false);
});

test('codex launcher logs in with the proxy OpenAI key before execing argv', () => {
  const command = buildContainerCommand(['codex', '--version']);

  assert.equal(command[0], 'bash');
  assert.equal(command[1], '-lc');
  assert.match(command[2], /cd \/workspace 2>\/dev\/null;/);
  assert.match(
    command[2],
    /printf '%s' "\$OPENAI_API_KEY" \| codex login --with-api-key/
  );
  assert.match(command[2], /exec "\$@"/);
  assert.deepEqual(command.slice(3), ['codex-launcher', 'codex', '--version']);
});

test('non-codex commands are not wrapped by the Codex bootstrap', () => {
  const command = ['bash', '-lc', 'echo CODEX_OK'];

  assert.equal(buildContainerCommand(command), command);
});

test('docker exec args pass proxy egress env and can run without a TTY', () => {
  const command = buildContainerCommand(['codex', '--version']);
  const args = buildDockerExecArgs('container123', command, { tty: false });

  assert.deepEqual(args.slice(0, 2), ['exec', '-i']);
  assert.ok(!args.includes('-it'));
  assert.deepEqual(args.slice(2, 8), [
    '-e',
    'OPENAI_API_KEY=proxy-injected',
    '-e',
    'OPENAI_BASE_URL=http://api.openai.com/v1',
    '-e',
    'ANTHROPIC_BASE_URL=http://api.anthropic.com'
  ]);
  assert.equal(args[8], 'container123');
  assert.deepEqual(args.slice(9), command);
});

test('docker exec args default to interactive TTY mode', () => {
  const args = buildDockerExecArgs('container123', ['codex']);

  assert.deepEqual(args.slice(0, 2), ['exec', '-it']);
});
