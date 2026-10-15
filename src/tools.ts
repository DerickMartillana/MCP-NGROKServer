import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    WORKSPACE_ROOT,
    MAX_FILE_BYTES,
    resolveSafePath,
    toRelative,
    isProtectedFile,
    PROTECTED_FILES
} from './sandbox.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git helpers: execFile (no shell) so arguments can never be interpreted as commands.
// ---------------------------------------------------------------------------

const GIT_IDENTITY = [
    '-c', `user.name=${process.env.GIT_AUTHOR_NAME || 'MCP Agent'}`,
    '-c', `user.email=${process.env.GIT_AUTHOR_EMAIL || 'agent@mcp.local'}`
];

async function git(args: string[]): Promise<string> {
    try {
        const { stdout, stderr } = await execFileAsync('git', [...GIT_IDENTITY, ...args], {
            cwd: WORKSPACE_ROOT,
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true
        });
        return (stdout || stderr || '').trim();
    } catch (err: any) {
        const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
        throw new Error(`git ${args[0]} failed: ${detail}`);
    }
}

/** Initialises a git repo in the workspace if one does not exist (replaces the manual `git init` step). */
export async function ensureGitRepo(): Promise<void> {
    try {
        await fs.access(`${WORKSPACE_ROOT}/.git`);
    } catch {
        await git(['init']);
    }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const tools = {
    async list_files({ directory }: { directory: string }) {
        const dir = await resolveSafePath(directory);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const lines = entries
            .filter((e) => e.name !== '.git')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return lines.length ? lines.join('\n') : '(empty directory)';
    },

    async read_file({ filepath }: { filepath: string }) {
        const p = await resolveSafePath(filepath);
        const stat = await fs.stat(p);
        if (!stat.isFile()) throw new Error(`${filepath} is not a file.`);
        if (stat.size > MAX_FILE_BYTES) {
            throw new Error(`${filepath} is ${stat.size} bytes; the read limit is ${MAX_FILE_BYTES}.`);
        }
        return await fs.readFile(p, 'utf-8');
    },

    async write_file({ filepath, content }: { filepath: string; content: string }) {
        if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
            throw new Error(`Content exceeds the ${MAX_FILE_BYTES} byte write limit.`);
        }
        const p = await resolveSafePath(filepath);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, 'utf-8');
        return `Success: wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${toRelative(p)}`;
    },

    async str_replace({
        filepath,
        search,
        replace,
        replace_all
    }: {
        filepath: string;
        search: string;
        replace: string;
        replace_all: boolean;
    }) {
        if (search.length === 0) throw new Error('"search" must not be empty.');
        const p = await resolveSafePath(filepath);
        const original = await fs.readFile(p, 'utf-8');
        const count = original.split(search).length - 1;

        if (count === 0) throw new Error(`No match for the given text in ${toRelative(p)}.`);
        if (count > 1 && !replace_all) {
            throw new Error(
                `Found ${count} matches in ${toRelative(p)}. Add more context to make it unique, or set replace_all=true.`
            );
        }
        // Literal replacement (not a regex); split/join also avoids "$&"-style replacement patterns.
        const updated = original.split(search).join(replace);
        await fs.writeFile(p, updated, 'utf-8');
        return `Success: replaced ${count} occurrence${count === 1 ? '' : 's'} in ${toRelative(p)}`;
    },

    async delete_file({ filepath }: { filepath: string }) {
        const p = await resolveSafePath(filepath);
        if (isProtectedFile(p)) {
            throw new Error(
                `${toRelative(p)} is a protected handoff file and cannot be deleted. Overwrite it instead.`
            );
        }
        const stat = await fs.stat(p);
        if (!stat.isFile()) throw new Error(`${filepath} is not a file (directories cannot be deleted).`);
        await fs.unlink(p);
        return `Success: deleted ${toRelative(p)}`;
    },

    async git_status() {
        return (await git(['status', '--short', '--branch'])) || 'Clean working tree.';
    },

    async git_add({ filepath }: { filepath: string }) {
        const p = await resolveSafePath(filepath);
        const rel = toRelative(p);
        await git(['add', '--', rel]);
        return `Staged ${rel}`;
    },

    async git_commit({ message }: { message: string }) {
        // --no-verify: never run hooks. Message is passed as a single argv entry, not through a shell.
        const out = await git(['commit', '--no-verify', '-m', message]);
        return out || 'Committed.';
    }
};

// ---------------------------------------------------------------------------
// MCP registration: one schema per tool, shared by validation AND the advertised definition.
// ---------------------------------------------------------------------------

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<ToolResult> {
    try {
        return { content: [{ type: 'text', text: await fn() }] };
    } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
    }
}

/** Builds a fresh MCP server instance. One is created per client session. */
export function createMcpServer(): McpServer {
    const server = new McpServer({ name: 'mcp-file-server', version: '2.0.0' });

    server.registerTool(
        'list_files',
        {
            description: 'List files and folders in a workspace directory (folders end with "/").',
            inputSchema: { directory: z.string().default('.').describe('Directory relative to the workspace root') }
        },
        (args) => run(() => tools.list_files(args))
    );

    server.registerTool(
        'read_file',
        {
            description: `Read a UTF-8 text file from the workspace (max ${MAX_FILE_BYTES} bytes).`,
            inputSchema: { filepath: z.string().min(1).describe('File path relative to the workspace root') }
        },
        (args) => run(() => tools.read_file(args))
    );

    server.registerTool(
        'write_file',
        {
            description: 'Create or overwrite a text file. Parent folders are created automatically.',
            inputSchema: {
                filepath: z.string().min(1).describe('File path relative to the workspace root'),
                content: z.string().describe('Full file contents')
            }
        },
        (args) => run(() => tools.write_file(args))
    );

    server.registerTool(
        'str_replace',
        {
            description:
                'Replace literal text in a file. Fails if the text is not found, or matches more than once unless replace_all is true.',
            inputSchema: {
                filepath: z.string().min(1),
                search: z.string().min(1).describe('Exact text to find (not a regex)'),
                replace: z.string().describe('Replacement text'),
                replace_all: z.boolean().default(false)
            }
        },
        (args) => run(() => tools.str_replace(args))
    );

    server.registerTool(
        'delete_file',
        {
            description: `Delete a file. The handoff files (${PROTECTED_FILES.join(', ')}) are protected.`,
            inputSchema: { filepath: z.string().min(1) }
        },
        (args) => run(() => tools.delete_file(args))
    );

    server.registerTool(
        'git_status',
        { description: 'Show the workspace git status (short form).', inputSchema: {} },
        () => run(() => tools.git_status())
    );

    server.registerTool(
        'git_add',
        {
            description: 'Stage a file or folder ("." for everything) in the workspace git repo.',
            inputSchema: { filepath: z.string().min(1).describe('Path to stage, or "." for all') }
        },
        (args) => run(() => tools.git_add(args))
    );

    server.registerTool(
        'git_commit',
        {
            description: 'Commit staged changes in the workspace git repo.',
            inputSchema: { message: z.string().min(1).max(500) }
        },
        (args) => run(() => tools.git_commit(args))
    );

    return server;
}

export const TOOL_NAMES = Object.keys(tools);
