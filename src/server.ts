import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, ensureGitRepo, TOOL_NAMES } from './tools.js';
import { initSandbox } from './sandbox.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // loopback only: ngrok reaches it locally, the LAN does not
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const AUTH_DISABLED = process.env.MCP_AUTH_DISABLED === 'true';

if (!AUTH_TOKEN && !AUTH_DISABLED) {
    console.error(
        'FATAL: MCP_AUTH_TOKEN is not set.\n' +
            '  Run `npm run setup` to generate one, or set MCP_AUTH_DISABLED=true for local-only testing.'
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth: Bearer header, or ?token= for clients that only accept a URL.
// ---------------------------------------------------------------------------

const digest = (v: string) => createHash('sha256').update(v).digest();

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (AUTH_DISABLED) return next();

    const header = req.headers.authorization;
    const supplied =
        header?.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';

    if (supplied && timingSafeEqual(digest(supplied), digest(AUTH_TOKEN))) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(cors({ exposedHeaders: ['Mcp-Session-Id'] }));

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', tools: TOOL_NAMES.length });
});

// ----- Streamable HTTP (current MCP transport): /mcp -----------------------

const streamable = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: StreamableHTTPServerTransport | undefined = sessionId ? streamable.get(sessionId) : undefined;

        if (!transport) {
            if (sessionId || !isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: no valid session. Send an initialize request first.' },
                    id: null
                });
                return;
            }

            const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: randomUUID,
                onsessioninitialized: (id) => {
                    streamable.set(id, created);
                }
            });
            created.onclose = () => {
                if (created.sessionId) streamable.delete(created.sessionId);
            };
            await createMcpServer().connect(created);
            transport = created;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('POST /mcp error:', err);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    }
});

async function sessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? streamable.get(sessionId) : undefined;
    if (!transport) {
        res.status(400).send('Invalid or missing Mcp-Session-Id');
        return;
    }
    await transport.handleRequest(req, res);
}
app.get('/mcp', requireAuth, sessionRequest); // server-to-client notification stream
app.delete('/mcp', requireAuth, sessionRequest); // explicit session termination

// ----- Legacy SSE transport (kept for older clients): /sse + /message -------

const sse = new Map<string, SSEServerTransport>();

app.get('/sse', requireAuth, async (_req, res) => {
    const transport = new SSEServerTransport('/message', res);
    sse.set(transport.sessionId, transport);
    res.on('close', () => sse.delete(transport.sessionId));
    await createMcpServer().connect(transport);
});

// No body parser here: the SSE transport reads the raw request stream itself.
// Access is gated by the unguessable per-connection sessionId issued to an authenticated /sse client.
app.post('/message', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = sse.get(sessionId);
    if (!transport) {
        res.status(404).send('Unknown session');
        return;
    }
    await transport.handlePostMessage(req, res);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const root = await initSandbox();
await ensureGitRepo();

const httpServer = app.listen(PORT, HOST, () => {
    console.log(`MCP file server live on http://${HOST}:${PORT}`);
    console.log(`  Streamable HTTP : /mcp   (recommended)`);
    console.log(`  Legacy SSE      : /sse`);
    console.log(`  Health check    : /health`);
    console.log(`  Sandbox root    : ${root}`);
    console.log(`  Auth            : ${AUTH_DISABLED ? 'DISABLED (local testing only!)' : 'enabled'}`);
});

function shutdown(signal: string) {
    console.log(`${signal} received, shutting down...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
