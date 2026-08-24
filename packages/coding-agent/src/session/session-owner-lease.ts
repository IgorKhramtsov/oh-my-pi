import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface SessionOwnerMetadata {
	version: 1;
	state: "active" | "parked" | "deleting";
	token: string;
	pid: number;
	launcherPid?: number;
	launcherStartedAt?: string;
	sessionFile: string;
	cwd: string;
	startedAt: string;
	processStartedAt?: string;
	parkedAt?: string;
	handoffDir?: string;
	tmuxPane?: string;
	tmuxTarget?: string;
	title?: string;
}

const OWNER_LOCK_TIMEOUT_MS = 5_000;

function canonicalSessionFile(sessionFile: string): string {
	const resolved = path.resolve(sessionFile);
	let ancestor = resolved;
	const suffix: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(ancestor), ...suffix);
		} catch {
			const parent = path.dirname(ancestor);
			if (parent === ancestor) return resolved;
			suffix.unshift(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

function acquireOwnerLock(lockPath: string): FileLock {
	const deadline = Date.now() + OWNER_LOCK_TIMEOUT_MS;
	for (;;) {
		const lock = FileLock.tryAcquire(lockPath);
		if (lock.acquired) return lock;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the session ownership lock");
		Bun.sleepSync(1);
	}
}

function processStartTime(pid: number): string | undefined {
	if (process.platform === "win32") return undefined;
	const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().trim() || undefined;
}

function ownerPaths(sessionFile: string, agentDir: string): { lockPath: string; metadataPath: string } {
	const root = path.join(agentDir, "session-owners");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
	const key = createHash("sha256").update(canonicalSessionFile(sessionFile)).digest("hex");
	return {
		lockPath: path.join(root, ".lock"),
		metadataPath: path.join(root, `${key}.json`),
	};
}

function readOwner(metadataPath: string): SessionOwnerMetadata | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const owner = value as Partial<SessionOwnerMetadata>;
		if (
			owner.version !== 1 ||
			(owner.state !== "active" && owner.state !== "parked" && owner.state !== "deleting") ||
			typeof owner.token !== "string" ||
			typeof owner.pid !== "number" ||
			typeof owner.sessionFile !== "string" ||
			typeof owner.cwd !== "string" ||
			typeof owner.startedAt !== "string"
		) {
			return undefined;
		}
		return owner as SessionOwnerMetadata;
	} catch {
		return undefined;
	}
}

function writeOwner(metadataPath: string, owner: SessionOwnerMetadata): void {
	const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
	fs.renameSync(temporaryPath, metadataPath);
}

function removeOwner(metadataPath: string, token: string): void {
	if (readOwner(metadataPath)?.token !== token) return;
	try {
		fs.unlinkSync(metadataPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processExists(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parkedOwnerIsLive(owner: SessionOwnerMetadata): boolean {
	const launcherPid = owner.launcherPid;
	if (
		owner.state !== "parked" ||
		launcherPid === undefined ||
		!processExists(launcherPid) ||
		typeof owner.handoffDir !== "string" ||
		!fs.existsSync(owner.handoffDir)
	) {
		return false;
	}
	return owner.launcherStartedAt === undefined || processStartTime(launcherPid) === owner.launcherStartedAt;
}

export function sessionOwnerIsLive(owner: SessionOwnerMetadata | undefined): boolean {
	if (!owner) return false;
	if (owner.state === "parked") return parkedOwnerIsLive(owner);
	if (!processExists(owner.pid)) return false;
	return owner.processStartedAt === undefined || processStartTime(owner.pid) === owner.processStartedAt;
}

export function listLiveParkedSessionPaths(options?: { agentDir?: string }): ReadonlySet<string> {
	const root = path.join(options?.agentDir ?? getAgentDir(), "session-owners");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
	const parked = new Set<string>();
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const owner = readOwner(path.join(root, entry.name));
		if (owner?.state === "parked" && parkedOwnerIsLive(owner)) parked.add(canonicalSessionFile(owner.sessionFile));
	}
	return parked;
}

function tmuxTarget(pane: string | undefined): string | undefined {
	if (!pane) return undefined;
	const result = Bun.spawnSync([
		"tmux",
		"display-message",
		"-p",
		"-t",
		pane,
		"#{session_name}:#{window_index}.#{pane_index}",
	]);
	if (result.exitCode !== 0) return undefined;
	const target = result.stdout.toString().trim();
	return target || undefined;
}

function activeOwner(sessionFile: string, token: string, pid: number): SessionOwnerMetadata {
	const launcherPid = Number(process.env.OMP_PARK_LAUNCHER_PID);
	const tmuxPane = process.env.TMUX_PANE || undefined;
	return {
		version: 1,
		state: "active",
		token,
		pid,
		launcherPid: Number.isSafeInteger(launcherPid) && launcherPid > 0 ? launcherPid : undefined,
		launcherStartedAt:
			Number.isSafeInteger(launcherPid) && launcherPid > 0 ? processStartTime(launcherPid) : undefined,
		sessionFile: canonicalSessionFile(sessionFile),
		cwd: process.cwd(),
		startedAt: new Date().toISOString(),
		processStartedAt: processStartTime(pid),
		tmuxPane,
		tmuxTarget: tmuxTarget(tmuxPane),
	};
}

export function readSessionOwner(
	sessionFile: string,
	options?: { agentDir?: string },
): SessionOwnerMetadata | undefined {
	return readOwner(ownerPaths(sessionFile, options?.agentDir ?? getAgentDir()).metadataPath);
}

export function claimParkedSession(
	sessionFile: string,
	token: string,
	pid: number,
	options?: { agentDir?: string },
): boolean {
	const { lockPath, metadataPath } = ownerPaths(sessionFile, options?.agentDir ?? getAgentDir());
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (owner?.state !== "parked" || owner.token !== token || !parkedOwnerIsLive(owner)) return false;
		writeOwner(metadataPath, { ...activeOwner(sessionFile, token, pid), startedAt: owner.startedAt });
		return true;
	} finally {
		lock.release();
	}
}

export function reclaimParkedSession(
	sessionFile: string,
	token: string,
	pid: number,
	options?: { agentDir?: string },
): boolean {
	const { lockPath, metadataPath } = ownerPaths(sessionFile, options?.agentDir ?? getAgentDir());
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (owner?.state !== "parked" || owner.token !== token) return false;
		writeOwner(metadataPath, { ...activeOwner(sessionFile, token, pid), startedAt: owner.startedAt });
		return true;
	} finally {
		lock.release();
	}
}

export function markParkedSession(
	sessionFile: string,
	token: string,
	handoffDir: string,
	title?: string,
	options?: { agentDir?: string },
): boolean {
	const { lockPath, metadataPath } = ownerPaths(sessionFile, options?.agentDir ?? getAgentDir());
	const lock = acquireOwnerLock(lockPath);
	try {
		const previous = readOwner(metadataPath);
		if (
			previous?.token !== token &&
			previous &&
			sessionOwnerIsLive(previous) &&
			!(previous.state === "active" && previous.pid === process.pid)
		) {
			return false;
		}
		const owner = previous?.token === token ? previous : activeOwner(sessionFile, token, process.pid);
		writeOwner(metadataPath, {
			...owner,
			state: "parked",
			pid: 0,
			parkedAt: new Date().toISOString(),
			handoffDir: path.resolve(handoffDir),
			title,
		});
		return true;
	} finally {
		lock.release();
	}
}

export function releaseParkedSession(sessionFile: string, token: string, options?: { agentDir?: string }): boolean {
	const { lockPath, metadataPath } = ownerPaths(sessionFile, options?.agentDir ?? getAgentDir());
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (!owner || owner.token !== token) return false;
		if (owner.state !== "parked" && sessionOwnerIsLive(owner)) return false;
		removeOwner(metadataPath, token);
		return true;
	} finally {
		lock.release();
	}
}

export async function withSessionDeletionLease<T>(
	sessionFile: string,
	operation: () => Promise<T>,
	options?: { agentDir?: string },
): Promise<T> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const resolvedSessionFile = canonicalSessionFile(sessionFile);
	const { lockPath, metadataPath } = ownerPaths(resolvedSessionFile, agentDir);
	const token = randomUUID();
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (owner && sessionOwnerIsLive(owner)) throw new SessionOwnedError(owner);
		writeOwner(metadataPath, {
			...activeOwner(resolvedSessionFile, token, process.pid),
			state: "deleting",
		});
	} finally {
		lock.release();
	}
	try {
		return await operation();
	} finally {
		const cleanupLock = acquireOwnerLock(lockPath);
		try {
			const owner = readOwner(metadataPath);
			if (owner?.state === "deleting" && owner.token === token) removeOwner(metadataPath, token);
		} finally {
			cleanupLock.release();
		}
	}
}

interface HeldSessionOwner {
	sessionFile: string;
	token: string;
}

type ActiveSessionReservation =
	| { acquired: true; held: HeldSessionOwner }
	| { acquired: false; owner: SessionOwnerMetadata };

function reserveActiveSession(
	sessionFile: string,
	token: string | undefined,
	pid: number,
	agentDir: string,
): ActiveSessionReservation {
	const resolvedSessionFile = canonicalSessionFile(sessionFile);
	const { lockPath, metadataPath } = ownerPaths(resolvedSessionFile, agentDir);
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (sessionOwnerIsLive(owner)) {
			if (owner?.state === "active" && owner.pid === pid && token !== undefined && owner.token === token) {
				return { acquired: true, held: { sessionFile: resolvedSessionFile, token } };
			}
			return { acquired: false, owner: owner! };
		}
		const activeToken = token ?? randomUUID();
		writeOwner(metadataPath, activeOwner(resolvedSessionFile, activeToken, pid));
		return { acquired: true, held: { sessionFile: resolvedSessionFile, token: activeToken } };
	} finally {
		lock.release();
	}
}

function releaseActiveOwner(held: HeldSessionOwner, agentDir: string): void {
	const { lockPath, metadataPath } = ownerPaths(held.sessionFile, agentDir);
	const lock = acquireOwnerLock(lockPath);
	try {
		const owner = readOwner(metadataPath);
		if (owner?.state === "active" && owner.token === held.token) removeOwner(metadataPath, held.token);
	} finally {
		lock.release();
	}
}

export class SessionOwnedError extends Error {
	readonly owner: SessionOwnerMetadata;
	readonly focused: boolean;

	constructor(owner: SessionOwnerMetadata) {
		const focused = focusSessionOwner(owner);
		super(
			`${
				owner.state === "parked"
					? "Session is parked in another pane."
					: owner.state === "deleting"
						? "Session is being deleted by another process."
						: "Session is already open in another process."
			}${focused ? " Switched to the owning tmux pane." : ""}`,
		);
		this.name = "SessionOwnedError";
		this.owner = owner;
		this.focused = focused;
	}
}

export interface SessionOwnershipTransition {
	commit(): void;
	rollback(): void;
}

export class SessionOwnership {
	readonly #agentDir: string;
	#held: HeldSessionOwner | undefined;

	constructor(options?: { agentDir?: string }) {
		this.#agentDir = options?.agentDir ?? getAgentDir();
	}

	get claimed(): boolean {
		return this.#held !== undefined;
	}

	claimInitial(sessionFile: string, token?: string): void {
		if (this.#held) throw new Error("Initial session ownership is already claimed");
		const reservation = reserveActiveSession(sessionFile, token, process.pid, this.#agentDir);
		if (!reservation.acquired) throw new SessionOwnedError(reservation.owner);
		this.#held = reservation.held;
	}

	beginTransition(sessionFile: string): SessionOwnershipTransition {
		const resolvedSessionFile = canonicalSessionFile(sessionFile);
		if (this.#held?.sessionFile === resolvedSessionFile) {
			return { commit() {}, rollback() {} };
		}
		const reservation = reserveActiveSession(resolvedSessionFile, undefined, process.pid, this.#agentDir);
		if (!reservation.acquired) throw new SessionOwnedError(reservation.owner);
		const previous = this.#held;
		let settled = false;
		return {
			commit: () => {
				if (settled) return;
				settled = true;
				this.#held = reservation.held;
				if (previous) releaseActiveOwner(previous, this.#agentDir);
			},
			rollback: () => {
				if (settled) return;
				settled = true;
				releaseActiveOwner(reservation.held, this.#agentDir);
			},
		};
	}

	async switchTo(sessionFile: string, operation: () => Promise<boolean>): Promise<boolean> {
		const transition = this.beginTransition(sessionFile);
		try {
			const switched = await operation();
			if (!switched) {
				transition.rollback();
				return false;
			}
			transition.commit();
			return true;
		} catch (error) {
			transition.rollback();
			throw error;
		}
	}

	adoptSession(sessionFile: string): void {
		this.beginTransition(sessionFile).commit();
	}

	adoptCurrentToken(sessionFile: string, token: string): void {
		const resolvedSessionFile = canonicalSessionFile(sessionFile);
		if (this.#held?.sessionFile !== resolvedSessionFile) return;
		const owner = readSessionOwner(resolvedSessionFile, { agentDir: this.#agentDir });
		if (owner?.state === "active" && owner.pid === process.pid && owner.token === token) {
			this.#held = { sessionFile: resolvedSessionFile, token };
		}
	}

	release(): void {
		if (!this.#held) return;
		const held = this.#held;
		this.#held = undefined;
		releaseActiveOwner(held, this.#agentDir);
	}
}

export function focusSessionOwner(owner: SessionOwnerMetadata | undefined): boolean {
	if (!process.env.TMUX || !owner) return false;
	const target = tmuxTarget(owner.tmuxPane) ?? owner.tmuxTarget;
	if (!target) return false;
	if (Bun.spawnSync(["tmux", "select-window", "-t", target]).exitCode !== 0) return false;
	if (Bun.spawnSync(["tmux", "select-pane", "-t", target]).exitCode !== 0) return false;
	return Bun.spawnSync(["tmux", "switch-client", "-t", target]).exitCode === 0;
}
