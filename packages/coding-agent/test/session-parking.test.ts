import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	argsFromParkHandoff,
	loadParkHandoff,
	writeParkHandoff,
} from "@oh-my-pi/pi-coding-agent/session/parking-handoff";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	claimParkedSession,
	listLiveParkedSessionPaths,
	markParkedSession,
	readSessionOwner,
	reclaimParkedSession,
	releaseParkedSession,
	SessionOwnedError,
	SessionOwnership,
	withSessionDeletionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-owner-lease";
import {
	SessionParkingController,
	type SessionParkingTimer,
} from "@oh-my-pi/pi-coding-agent/session/session-parking-controller";

interface ScheduledTimer extends SessionParkingTimer {
	callback: () => void;
	delayMs: number;
	cancelled: boolean;
}

function parkedArgs(): Args {
	return {
		profile: "work",
		provider: "openai",
		model: "gpt-5.6-sol",
		thinking: Effort.High,
		apiKey: "runtime-key",
		messages: [],
		fileArgs: [],
		unknownFlags: new Map([["plan", true]]),
		unrecognizedFlags: [],
	};
}

describe("session parking", () => {
	let tempDir: string;
	let previousLauncherPid: string | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parking-test-"));
		previousLauncherPid = process.env.OMP_PARK_LAUNCHER_PID;
		process.env.OMP_PARK_LAUNCHER_PID = String(process.pid);
	});

	afterEach(async () => {
		if (previousLauncherPid === undefined) delete process.env.OMP_PARK_LAUNCHER_PID;
		else process.env.OMP_PARK_LAUNCHER_PID = previousLauncherPid;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("warns, resets on activity, and parks only after the full idle window", async () => {
		let now = 0;
		let parked = 0;
		let warnings = 0;
		let clears = 0;
		const timers: ScheduledTimer[] = [];
		const parkCompletion = Promise.withResolvers<void>();
		const controller = new SessionParkingController({
			idleMs: 100,
			warningMs: 20,
			canPark: () => true,
			onWarning: () => warnings++,
			onWarningCleared: () => clears++,
			park: async () => {
				parked++;
				parkCompletion.resolve();
				return true;
			},
			now: () => now,
			setTimer: (callback, delayMs) => {
				const timer: ScheduledTimer = {
					callback,
					delayMs,
					cancelled: false,
					cancel() {
						this.cancelled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
			clearTimer: timer => timer.cancel(),
		});

		controller.start();
		now = 100;
		timers.find(timer => !timer.cancelled)?.callback();
		expect(controller.state).toBe("quiescing");
		expect(warnings).toBe(1);

		controller.noteActivity();
		expect(controller.state).toBe("active");
		expect(clears).toBe(1);

		now = 200;
		timers.findLast(timer => !timer.cancelled)?.callback();
		expect(controller.state).toBe("quiescing");

		now = 220;
		timers.findLast(timer => !timer.cancelled)?.callback();
		await parkCompletion.promise;
		expect(controller.state).toBe("parked");
		expect(parked).toBe(1);
	});

	it("cancels disposal when activity arrives before the handoff commits", async () => {
		let now = 0;
		let errors = 0;
		const timers: ScheduledTimer[] = [];
		const parkStarted = Promise.withResolvers<void>();
		const controller = new SessionParkingController({
			idleMs: 100,
			warningMs: 20,
			canPark: () => true,
			onWarning: () => {},
			onWarningCleared: () => {},
			onError: () => errors++,
			park: async signal => {
				parkStarted.resolve();
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				signal.throwIfAborted();
				return true;
			},
			now: () => now,
			setTimer: (callback, delayMs) => {
				const timer: ScheduledTimer = {
					callback,
					delayMs,
					cancelled: false,
					cancel() {
						this.cancelled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
			clearTimer: timer => timer.cancel(),
		});

		controller.start();
		now = 100;
		timers.findLast(timer => !timer.cancelled)?.callback();
		now = 120;
		timers.findLast(timer => !timer.cancelled)?.callback();
		await parkStarted.promise;
		expect(controller.state).toBe("disposing");

		controller.noteActivity();
		await Bun.sleep(0);
		expect(controller.state).toBe("active");
		expect(errors).toBe(0);
	});

	it("aborts an in-flight parking commit when stopped", async () => {
		let now = 0;
		let aborted = false;
		const timers: ScheduledTimer[] = [];
		const parkStarted = Promise.withResolvers<void>();
		const controller = new SessionParkingController({
			idleMs: 100,
			warningMs: 20,
			canPark: () => true,
			onWarning: () => {},
			onWarningCleared: () => {},
			park: async signal => {
				parkStarted.resolve();
				await new Promise<void>(resolve =>
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				signal.throwIfAborted();
				return true;
			},
			now: () => now,
			setTimer: (callback, delayMs) => {
				const timer: ScheduledTimer = {
					callback,
					delayMs,
					cancelled: false,
					cancel() {
						this.cancelled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
			clearTimer: timer => timer.cancel(),
		});

		controller.start();
		now = 100;
		timers.findLast(timer => !timer.cancelled)?.callback();
		now = 120;
		timers.findLast(timer => !timer.cancelled)?.callback();
		await parkStarted.promise;
		controller.stop();
		await Bun.sleep(0);

		expect(aborted).toBe(true);
		expect(timers).toHaveLength(2);
	});

	it("round-trips exact session and argument state", async () => {
		const cwd = path.join(tempDir, "workspace");
		const handoffDir = path.join(tempDir, "handoff");
		await fs.mkdir(cwd);
		const manager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		await manager.ensureOnDisk();
		await manager.saveDraft("unsent text");

		const saved = await writeParkHandoff(handoffDir, parkedArgs(), manager, "pane-token");
		const loaded = await loadParkHandoff(path.join(handoffDir, "state.json"));
		const restored = argsFromParkHandoff(loaded);

		expect(loaded).toEqual(saved);
		expect(restored.cwd).toBe(cwd);
		expect(restored.resume).toBe(saved.sessionFile);
		expect(loaded.profile).toBe("work");
		expect(restored.strictResume).toBe(true);
		expect(restored.parkToken).toBe("pane-token");
		expect(restored.provider).toBeUndefined();
		expect(restored.model).toBeUndefined();
		expect(restored.apiKey).toBe("runtime-key");
		expect(restored.thinking).toBeUndefined();
		expect(restored.unknownFlags.get("plan")).toBe(true);
		await manager.close();
	});

	it("rejects strict resume when the session file is absent", async () => {
		await expect(
			SessionManager.open(path.join(tempDir, "missing.jsonl"), undefined, undefined, { mustExist: true }),
		).rejects.toThrow("valid session header");
	});

	it("transfers exclusive ownership only after a successful session switch", async () => {
		const firstSession = path.join(tempDir, "first.jsonl");
		const secondSession = path.join(tempDir, "second.jsonl");
		const ownership = new SessionOwnership({ agentDir: tempDir });
		ownership.claimInitial(firstSession);

		const competing = new SessionOwnership({ agentDir: tempDir });
		expect(() => competing.claimInitial(firstSession)).toThrow(SessionOwnedError);

		expect(await ownership.switchTo(secondSession, async () => false)).toBe(false);
		expect(readSessionOwner(firstSession, { agentDir: tempDir })?.state).toBe("active");
		expect(readSessionOwner(secondSession, { agentDir: tempDir })).toBeUndefined();

		expect(await ownership.switchTo(secondSession, async () => true)).toBe(true);
		expect(readSessionOwner(firstSession, { agentDir: tempDir })).toBeUndefined();
		expect(readSessionOwner(secondSession, { agentDir: tempDir })?.state).toBe("active");

		ownership.release();
		expect(readSessionOwner(secondSession, { agentDir: tempDir })).toBeUndefined();
	});

	it("blocks resume throughout an exclusive deletion", async () => {
		const sessionFile = path.join(tempDir, "deleting.jsonl");
		const release = Promise.withResolvers<void>();
		const deleting = withSessionDeletionLease(
			sessionFile,
			async () => {
				await release.promise;
			},
			{ agentDir: tempDir },
		);

		expect(readSessionOwner(sessionFile, { agentDir: tempDir })?.state).toBe("deleting");
		const competing = new SessionOwnership({ agentDir: tempDir });
		expect(() => competing.claimInitial(sessionFile)).toThrow(SessionOwnedError);
		await expect(withSessionDeletionLease(sessionFile, async () => {}, { agentDir: tempDir })).rejects.toThrow(
			SessionOwnedError,
		);

		release.resolve();
		await deleting;
		expect(readSessionOwner(sessionFile, { agentDir: tempDir })).toBeUndefined();
		competing.claimInitial(sessionFile);
		competing.release();
	});

	it("restores the active lease when parking publication fails", async () => {
		const sessionFile = path.join(tempDir, "rollback.jsonl");
		const handoffDir = path.join(tempDir, "handoff");
		const token = "pane-token";
		const ownership = new SessionOwnership({ agentDir: tempDir });
		ownership.claimInitial(sessionFile);

		await fs.mkdir(handoffDir, { recursive: true });

		expect(markParkedSession(sessionFile, token, handoffDir, undefined, { agentDir: tempDir })).toBe(true);
		expect(reclaimParkedSession(sessionFile, token, process.pid, { agentDir: tempDir })).toBe(true);
		ownership.adoptCurrentToken(sessionFile, token);
		expect(readSessionOwner(sessionFile, { agentDir: tempDir })?.state).toBe("active");

		const competing = new SessionOwnership({ agentDir: tempDir });
		expect(() => competing.claimInitial(sessionFile)).toThrow(SessionOwnedError);
		expect(releaseParkedSession(sessionFile, token, { agentDir: tempDir })).toBe(false);
	});
	it("reserves a move destination before the transcript becomes visible", async () => {
		const sourceCwd = path.join(tempDir, "source");
		const targetCwd = path.join(tempDir, "target");
		const sourceDir = path.join(tempDir, "source-sessions");
		const targetDir = path.join(tempDir, "target-sessions");
		await Promise.all([fs.mkdir(sourceCwd), fs.mkdir(targetCwd)]);
		const manager = SessionManager.create(sourceCwd, sourceDir);
		await manager.ensureOnDisk();
		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("Expected persisted session");
		const ownership = new SessionOwnership({ agentDir: tempDir });
		ownership.claimInitial(sourceFile);
		let transition: ReturnType<SessionOwnership["beginTransition"]> | undefined;
		let targetFile: string | undefined;

		await manager.moveTo(targetCwd, targetDir, target => {
			targetFile = target;
			expect(existsSync(target)).toBe(false);
			transition = ownership.beginTransition(target);
			const competing = new SessionOwnership({ agentDir: tempDir });
			expect(() => competing.claimInitial(target)).toThrow(SessionOwnedError);
		});
		transition?.commit();

		if (!targetFile) throw new Error("Expected move target");
		expect(readSessionOwner(sourceFile, { agentDir: tempDir })).toBeUndefined();
		expect(readSessionOwner(targetFile, { agentDir: tempDir })?.state).toBe("active");
		ownership.release();
		await manager.close();
	});

	it("treats symlink aliases as the same owned session", async () => {
		const sessionFile = path.join(tempDir, "canonical.jsonl");
		const alias = path.join(tempDir, "alias.jsonl");
		await fs.writeFile(sessionFile, "");
		await fs.symlink(sessionFile, alias);
		const ownership = new SessionOwnership({ agentDir: tempDir });
		ownership.claimInitial(sessionFile);

		const competing = new SessionOwnership({ agentDir: tempDir });
		expect(() => competing.claimInitial(alias)).toThrow(SessionOwnedError);

		ownership.release();
		expect(readSessionOwner(alias, { agentDir: tempDir })).toBeUndefined();
	});

	it("survives 100 park and exact-claim cycles without duplicate ownership", async () => {
		const sessionFile = path.join(tempDir, "session.jsonl");
		const handoffDir = path.join(tempDir, "handoff");
		const token = "pane-token";
		const canonicalSessionFile = path.join(await fs.realpath(tempDir), path.basename(sessionFile));
		await fs.mkdir(handoffDir, { recursive: true });

		for (let cycle = 0; cycle < 100; cycle++) {
			expect(markParkedSession(sessionFile, token, handoffDir, `cycle ${cycle}`, { agentDir: tempDir })).toBe(true);
			if (cycle === 0) {
				expect(listLiveParkedSessionPaths({ agentDir: tempDir })).toContain(canonicalSessionFile);
			}
			expect(claimParkedSession(sessionFile, "wrong-token", process.pid, { agentDir: tempDir })).toBe(false);
			expect(claimParkedSession(sessionFile, token, process.pid, { agentDir: tempDir })).toBe(true);
			expect(readSessionOwner(sessionFile, { agentDir: tempDir })?.state).toBe("active");
			expect(listLiveParkedSessionPaths({ agentDir: tempDir })).not.toContain(canonicalSessionFile);
		}

		expect(markParkedSession(sessionFile, token, handoffDir, undefined, { agentDir: tempDir })).toBe(true);
		expect(releaseParkedSession(sessionFile, token, { agentDir: tempDir })).toBe(true);
		expect(readSessionOwner(sessionFile, { agentDir: tempDir })).toBeUndefined();
	});
});
