import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Configured workspace location (defaults to <project>/workspace, independent of the launch cwd). */
export const WORKSPACE_ROOT = path.resolve(
    process.env.WORKSPACE_ROOT || path.join(PROJECT_ROOT, 'workspace')
);

/** Handoff protocol files: may be edited, but never deleted. */
export const PROTECTED_FILES = ['PROJECT_STATE', 'PLAN_LOG', 'CHECKPOINTS', 'DECISIONS'];

export const MAX_FILE_BYTES = 1_000_000; // 1 MB cap for reads and writes

let realRoot: string | null = null;

/** Creates the workspace if needed and caches its symlink-free real path. Call once at startup. */
export async function initSandbox(): Promise<string> {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    realRoot = await fs.realpath(WORKSPACE_ROOT);
    return realRoot;
}

function getRoot(): string {
    if (!realRoot) throw new Error('Sandbox not initialised (call initSandbox first).');
    return realRoot;
}

function isInside(root: string, target: string): boolean {
    return target === root || target.startsWith(root + path.sep);
}

/**
 * Resolves a user-supplied path to an absolute path that is guaranteed to be:
 *  - inside the workspace (proper separator-aware check, not a bare prefix match)
 *  - free of symlink escapes (deepest existing ancestor is realpath'd and re-checked)
 *  - outside any .git directory (agents must not touch hooks/config)
 */
export async function resolveSafePath(requestedPath: string): Promise<string> {
    const root = getRoot();

    if (requestedPath.includes('\0')) {
        throw new Error('Sandbox Violation: invalid path.');
    }

    const resolved = path.resolve(root, requestedPath);
    const violation = new Error(
        `Sandbox Violation: access denied to "${requestedPath}". All paths must stay inside the workspace.`
    );

    if (!isInside(root, resolved)) throw violation;

    const segments = path.relative(root, resolved).split(path.sep);
    if (segments.some((s) => s.toLowerCase() === '.git')) {
        throw new Error('Sandbox Violation: the .git directory is off limits. Use the git_* tools instead.');
    }

    // Symlink check: walk up to the deepest path that exists, realpath it, re-verify.
    let probe = resolved;
    for (;;) {
        try {
            const real = await fs.realpath(probe);
            if (!isInside(root, real)) throw violation;
            break;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
            const parent = path.dirname(probe);
            if (parent === probe) throw violation;
            probe = parent;
        }
    }

    return resolved;
}

/** Path relative to the workspace root, using forward slashes (for display and git). */
export function toRelative(absPath: string): string {
    const rel = path.relative(getRoot(), absPath);
    return (rel === '' ? '.' : rel).split(path.sep).join('/');
}

export function isProtectedFile(absPath: string): boolean {
    return PROTECTED_FILES.includes(toRelative(absPath));
}
