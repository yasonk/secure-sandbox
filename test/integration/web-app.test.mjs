import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { connectWs, uniqueSession } from '../helpers/ws-client.mjs';

const TEST_TIMEOUT_MS = 120_000;
const clients = new Set();

async function openClient(prefix) {
  const client = await connectWs(uniqueSession(prefix), {
    timeoutMs: TEST_TIMEOUT_MS
  });
  clients.add(client);
  return client;
}

async function closeClient(client) {
  clients.delete(client);
  await client.close();
}

function assertRpcError(response, code, message) {
  assert.equal(response.result, undefined);
  assert.equal(response.error?.code, code);
  assert.equal(response.error?.message, message);
}

function execOutput(response) {
  assert.ifError(response.error);
  assert.ok(response.result, 'sandbox/exec returned a result');
  return `${response.result.stdout ?? ''}${response.result.output ?? ''}`;
}

afterEach(async () => {
  for (const client of clients) {
    await client.close();
  }
  clients.clear();
});

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

test(
  'initialize and thread/start return expected protocol shape',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = await openClient('web-init');

    const { init, thread } = await client.initializeAndStartThread();

    assert.equal(typeof init, 'object');
    assert.equal(typeof thread.id, 'string');
    assert.ok(thread.id.length > 0);

    await closeClient(client);
  }
);

test(
  'sandbox/setup validates missing repoUrl',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = await openClient('web-setup-validation');

    const response = await client.request('sandbox/setup', {});

    assertRpcError(response, -32602, 'Missing param: repoUrl');
    await closeClient(client);
  }
);

test(
  'sandbox/exec validates missing command',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = await openClient('web-exec-validation');

    const response = await client.request('sandbox/exec', {});

    assertRpcError(response, -32602, 'Missing param: command');
    await closeClient(client);
  }
);

test(
  'sandbox/exec runs deterministic commands in the sandbox',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = await openClient('web-exec-success');

    const response = await client.sandboxExec('printf WEBAPP_EXEC_OK');

    assert.match(execOutput(response), /WEBAPP_EXEC_OK/);
    await closeClient(client);
  }
);

test(
  'different sessions have isolated workspaces',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const marker = `/workspace/session-marker-${Date.now()}-${process.pid}`;
    const sessionA = await openClient('web-session-a');
    const write = await sessionA.sandboxExec(`printf A > ${marker}`);
    execOutput(write);

    const sessionB = await openClient('web-session-b');
    const check = await sessionB.sandboxExec(
      `test ! -e ${marker} && printf SESSION_ISOLATED`
    );

    assert.match(execOutput(check), /SESSION_ISOLATED/);
    await closeClient(sessionA);
    await closeClient(sessionB);
  }
);

test(
  'reconnecting the same session resets the workspace',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const session = uniqueSession('web-reconnect');
    const marker = `/workspace/reconnect-marker-${Date.now()}-${process.pid}`;
    const first = await connectWs(session, { timeoutMs: TEST_TIMEOUT_MS });
    clients.add(first);

    const write = await first.sandboxExec(`printf RESET > ${marker}`);
    execOutput(write);
    await closeClient(first);

    const second = await connectWs(session, { timeoutMs: TEST_TIMEOUT_MS });
    clients.add(second);
    const check = await second.sandboxExec(
      `test ! -e ${marker} && printf RECONNECT_RESET`
    );

    assert.match(execOutput(check), /RECONNECT_RESET/);
    await closeClient(second);
  }
);
