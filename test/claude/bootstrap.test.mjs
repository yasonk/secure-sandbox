import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContainerCommand } from '../../scripts/sandbox-agent.mjs';

function launcherScript(command) {
  assert.equal(command[0], 'bash');
  assert.equal(command[1], '-lc');
  return command[2];
}

function embeddedJson(script, destination) {
  const marker = `printf '%s' '`;
  const start = script.indexOf(marker);
  assert.notEqual(start, -1);

  const destinationMarker = `' > ${destination}`;
  const end = script.indexOf(destinationMarker, start + marker.length);
  assert.notEqual(end, -1);

  return JSON.parse(script.slice(start + marker.length, end));
}

test('claude launcher seeds dummy OAuth credentials and onboarding state', () => {
  const command = buildContainerCommand(['claude', '--version'], {
    now: () => 1_700_000_000_000
  });
  const script = launcherScript(command);
  const credentials = embeddedJson(script, '~/.claude/.credentials.json');
  const onboarding = embeddedJson(
    script.slice(script.indexOf('> ~/.claude/.credentials.json')),
    '~/.claude.json'
  );

  assert.deepEqual(command.slice(3), ['claude-launcher', 'claude', '--version']);
  assert.match(script, /mkdir -p ~\/\.claude/);
  assert.match(script, /chmod 600 ~\/\.claude\/\.credentials\.json/);
  assert.match(script, /cd \/workspace 2>\/dev\/null;/);
  assert.match(script, /exec "\$@"/);
  assert.deepEqual(credentials, {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-proxy-injected',
      refreshToken: 'sk-ant-ort01-proxy-injected',
      expiresAt: 1_731_536_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  });
  assert.deepEqual(onboarding, { hasCompletedOnboarding: true });
});

test('claude launcher preserves argv after the bootstrap sentinel', () => {
  const command = buildContainerCommand(['claude', '-p', 'Reply exactly: OK']);

  assert.deepEqual(command.slice(3), [
    'claude-launcher',
    'claude',
    '-p',
    'Reply exactly: OK'
  ]);
});

test('claude launcher embeds only proxy placeholders, not real local secrets', () => {
  const command = buildContainerCommand(['claude'], {
    now: () => 1_700_000_000_000
  });
  const serializedCommand = JSON.stringify(command);

  assert.match(serializedCommand, /sk-ant-oat01-proxy-injected/);
  assert.match(serializedCommand, /sk-ant-ort01-proxy-injected/);
  assert.doesNotMatch(serializedCommand, /real-claude-oauth-token/);
  assert.doesNotMatch(serializedCommand, /real-anthropic-api-key/);
  assert.doesNotMatch(serializedCommand, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(serializedCommand, /ANTHROPIC_API_KEY/);
});

test('non-claude commands are not wrapped by the Claude bootstrap', () => {
  const command = ['bash', '-lc', 'echo OK'];

  assert.equal(buildContainerCommand(command), command);
});
