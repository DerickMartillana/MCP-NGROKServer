// End-to-end smoke test: boots the built server on a random port with a throwaway
// workspace, then talks to it as a real MCP client over Streamable HTTP and legacy SSE.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PORT = 3300 + Math.floor(Math.random() * 500);
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
for (const f of ['PROJECT_STATE', 'PLAN_LOG', 'CHECKPOINTS', 'DECISIONS']) fs.writeFileSync(path.join(workspace, f), 'x');
fs.mkdirSync(path.join(tmp, 'workspace-evil')); // sibling dir that shares the "workspace" prefix
fs.writeFileSync(path.join(tmp, 'workspace-evil', 'secret.txt'), 'TOP SECRET');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'OUTSIDE');
try { fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(workspace, 'link.txt')); } catch {}

const server = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MCP_AUTH_TOKEN: TOKEN, WORKSPACE_ROOT: workspace },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
    ok ? passed++ : failed++;
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`);
};

async function waitForServer() {
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch {}
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Server did not start:\n' + serverLog);
}

const call = async (client, name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content?.[0]?.text ?? '', isError: !!r.isError };
};

try {
    await waitForServer();
    const base = `http://127.0.0.1:${PORT}`;
    console.log('\nAuth');
    check('/mcp without token -> 401', (await fetch(`${base}/mcp`, { method: 'POST' })).status === 401);
    check('/sse without token -> 401', (await fetch(`${base}/sse`)).status === 401);
    check('/health is public', (await fetch(`${base}/health`)).ok);

    console.log('\nStreamable HTTP client');
    const client = new Client({ name: 'smoke', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
        })
    );
    const { tools } = await client.listTools();
    check('8 tools advertised', tools.length === 8, tools.map((t) => t.name).join(','));

    let r = await call(client, 'write_file', { filepath: 'notes/hello.txt', content: 'hello world' });
    check('write_file creates parent dirs', !r.isError, r.text);
    r = await call(client, 'read_file', { filepath: 'notes/hello.txt' });
    check('read_file returns content', r.text === 'hello world', r.text);
    r = await call(client, 'list_files', {});
    check('list_files marks directories', r.text.includes('notes/'), r.text);

    r = await call(client, 'str_replace', { filepath: 'notes/hello.txt', search: 'o', replace: '0' });
    check('str_replace rejects ambiguous match', r.isError && /2 matches/.test(r.text), r.text);
    r = await call(client, 'str_replace', { filepath: 'notes/hello.txt', search: 'o', replace: '0', replace_all: true });
    check('str_replace replace_all works', !r.isError, r.text);
    await call(client, 'write_file', { filepath: 'notes/re.txt', content: 'a(b)c' });
    r = await call(client, 'str_replace', { filepath: 'notes/re.txt', search: '(b)', replace: 'X' });
    check('str_replace is literal (regex chars safe)', !r.isError && (await call(client, 'read_file', { filepath: 'notes/re.txt' })).text === 'aXc', r.text);

    console.log('\nSandbox');
    r = await call(client, 'read_file', { filepath: '../outside.txt' });
    check('../ traversal blocked', r.isError && /Sandbox/.test(r.text), r.text);
    r = await call(client, 'read_file', { filepath: '../workspace-evil/secret.txt' });
    check('prefix-sibling escape blocked', r.isError && /Sandbox/.test(r.text), r.text);
    r = await call(client, 'read_file', { filepath: path.join(tmp, 'outside.txt') });
    check('absolute path outside blocked', r.isError && /Sandbox/.test(r.text), r.text);
    r = await call(client, 'read_file', { filepath: 'link.txt' });
    check('symlink escape blocked', r.isError && /Sandbox/.test(r.text), r.text);
    r = await call(client, 'write_file', { filepath: '.git/hooks/pre-commit', content: 'evil' });
    check('.git writes blocked', r.isError && /\.git/.test(r.text), r.text);
    r = await call(client, 'delete_file', { filepath: 'PROJECT_STATE' });
    check('handoff files cannot be deleted', r.isError && /protected/.test(r.text), r.text);

    console.log('\nGit (and injection attempts)');
    r = await call(client, 'git_status');
    check('git_status works (repo auto-initialised)', !r.isError, r.text);
    const marker = path.join(tmp, 'PWNED');
    r = await call(client, 'git_add', { filepath: `notes/hello.txt; touch ${marker}` });
    check('git_add shell injection does not execute', !fs.existsSync(marker), r.text);
    r = await call(client, 'git_add', { filepath: '.' });
    check('git_add . works', !r.isError, r.text);
    r = await call(client, 'git_commit', { message: `test "quoted" $(touch ${marker}) \`touch ${marker}\`` });
    check('git_commit works with hostile message', !r.isError, r.text);
    check('git_commit injection does not execute', !fs.existsSync(marker));
    r = await call(client, 'git_commit', { message: 'nothing to commit' });
    check('empty commit returns a clean error', r.isError, r.text);

    console.log('\nSessions');
    const client2 = new Client({ name: 'smoke2', version: '1.0.0' });
    await client2.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp?token=${TOKEN}`))
    );
    r = await call(client2, 'read_file', { filepath: 'notes/hello.txt' });
    check('second concurrent session works (?token= auth)', r.text === 'hell0 w0rld', r.text);
    r = await call(client, 'read_file', { filepath: 'notes/hello.txt' });
    check('first session still works', r.text === 'hell0 w0rld', r.text);
    await client2.close();

    console.log('\nLegacy SSE client');
    const sseClient = new Client({ name: 'smoke-sse', version: '1.0.0' });
    await sseClient.connect(
        new SSEClientTransport(new URL(`${base}/sse`), {
            requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
            eventSourceInit: {
                fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}` } })
            }
        })
    );
    r = await call(sseClient, 'read_file', { filepath: 'notes/hello.txt' });
    check('SSE transport works', r.text === 'hell0 w0rld', r.text);
    await sseClient.close();
    await client.close();
} catch (err) {
    failed++;
    console.error('\nTest run crashed:', err);
    console.error('--- server log ---\n' + serverLog);
} finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
