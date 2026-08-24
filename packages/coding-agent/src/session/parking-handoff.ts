import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import type { SessionManager } from "./session-manager";

export const PARK_EXIT_CODE = 75;

const PARKED_ARG_KEYS = [
	"addDir",
	"allowHome",
	"config",
	"smol",
	"slow",
	"plan",
	"apiKey",
	"systemPrompt",
	"appendSystemPrompt",
	"hideThinking",
	"advisor",
	"externalThinking",
	"sessionDir",
	"models",
	"tools",
	"noTools",
	"noLsp",
	"noPty",
	"hooks",
	"extensions",
	"trustedExtensions",
	"noExtensions",
	"pluginDirs",
	"noSkills",
	"skills",
	"noRules",
	"noTitle",
	"autoApprove",
	"approvalMode",
] as const satisfies readonly (keyof Args)[];

type ParkedArgKey = (typeof PARKED_ARG_KEYS)[number];

type SerializedParkedArgs = Partial<Pick<Args, ParkedArgKey>> & {
	unknownFlags: Array<[string, boolean | string]>;
};

export interface ParkHandoffState {
	version: 1;
	token: string;
	sessionFile: string;
	sessionId: string;
	cwd: string;
	title: string;
	profile?: string;
	args: SerializedParkedArgs;
	createdAt: string;
}

const ParkedArgsSchema = type({
	"addDir?": "string[]",
	"allowHome?": "boolean",
	"config?": "string[]",
	"smol?": "string",
	"slow?": "string",
	"plan?": "string",
	"apiKey?": "string",
	"systemPrompt?": "string",
	"appendSystemPrompt?": "string",
	"hideThinking?": "boolean",
	"advisor?": "boolean",
	"externalThinking?": "boolean",
	"sessionDir?": "string",
	"models?": "string[]",
	"tools?": "string[]",
	"noTools?": "boolean",
	"noLsp?": "boolean",
	"noPty?": "boolean",
	"hooks?": "string[]",
	"extensions?": "string[]",
	"trustedExtensions?": "string[]",
	"noExtensions?": "boolean",
	"pluginDirs?": "string[]",
	"noSkills?": "boolean",
	"skills?": "string[]",
	"noRules?": "boolean",
	"noTitle?": "boolean",
	"autoApprove?": "boolean",
	"approvalMode?": "'always-ask' | 'write' | 'yolo'",
	unknownFlags: "unknown[]",
});

const ParkHandoffSchema = type({
	version: "1",
	token: "string > 0",
	sessionFile: "string > 0",
	sessionId: "string > 0",
	cwd: "string > 0",
	title: "string > 0",
	"profile?": "string",
	args: ParkedArgsSchema,
	createdAt: "string > 0",
});

function sanitizeLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function serializeArgs(args: Args): SerializedParkedArgs {
	const serialized: Partial<Pick<Args, ParkedArgKey>> = {};
	for (const key of PARKED_ARG_KEYS) {
		const value = args[key];
		if (value !== undefined) Object.assign(serialized, { [key]: value });
	}
	return {
		...serialized,
		unknownFlags: [...args.unknownFlags],
	};
}

function parseSerializedArgs(value: typeof ParkedArgsSchema.infer): SerializedParkedArgs {
	const unknownFlags: Array<[string, boolean | string]> = [];
	for (const entry of value.unknownFlags) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			(typeof entry[1] !== "string" && typeof entry[1] !== "boolean")
		) {
			throw new Error("Invalid parked extension flag state");
		}
		unknownFlags.push([entry[0], entry[1]]);
	}
	const parsed: Partial<Pick<Args, ParkedArgKey>> = {};
	for (const key of PARKED_ARG_KEYS) {
		const candidate = value[key];
		if (candidate !== undefined) Object.assign(parsed, { [key]: candidate });
	}
	return { ...parsed, unknownFlags } as SerializedParkedArgs;
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await fs.writeFile(temporaryPath, content, { mode: 0o600 });
	await fs.rename(temporaryPath, filePath);
}

export async function writeParkHandoff(
	handoffDir: string,
	args: Args,
	sessionManager: SessionManager,
	token: string,
): Promise<ParkHandoffState> {
	const sessionFile = sessionManager.getSessionFile();
	const sessionId = sessionManager.getSessionId();
	if (!sessionFile || !sessionId || !sessionManager.isSessionOnDisk()) {
		throw new Error("Session is not durably persisted");
	}

	const directory = path.resolve(handoffDir);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	await fs.rm(path.join(directory, "ready"), { force: true });
	const state: ParkHandoffState = {
		version: 1,
		token,
		sessionFile: path.resolve(sessionFile),
		sessionId,
		cwd: sessionManager.getCwd(),
		title: sanitizeLine(sessionManager.getSessionName() || path.basename(sessionManager.getCwd())) || "OMP session",
		profile: getActiveProfile() ?? args.profile,
		args: serializeArgs(args),
		createdAt: new Date().toISOString(),
	};

	await Promise.all([
		writeAtomic(path.join(directory, "state.json"), `${JSON.stringify(state)}\n`),
		writeAtomic(path.join(directory, "session-id"), `${sanitizeLine(state.sessionId)}\n`),
		writeAtomic(path.join(directory, "title"), `${state.title}\n`),
	]);
	await writeAtomic(path.join(directory, "ready"), `${state.token}\n`);
	return state;
}

export async function loadParkHandoff(statePath: string): Promise<ParkHandoffState> {
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(path.resolve(statePath)).text());
	} catch (error) {
		throw new Error(
			`Parked session handoff is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const checked = ParkHandoffSchema(value);
	if (checked instanceof type.errors) {
		throw new Error(`Invalid parked session handoff: ${checked.summary}`);
	}
	return {
		...checked,
		sessionFile: path.resolve(checked.sessionFile),
		cwd: path.resolve(checked.cwd),
		args: parseSerializedArgs(checked.args),
	};
}

export function argsFromParkHandoff(state: ParkHandoffState): Args {
	const { unknownFlags, ...saved } = state.args;
	return {
		...saved,
		cwd: state.cwd,
		profile: state.profile,
		resume: state.sessionFile,
		strictResume: true,
		parkToken: state.token,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(unknownFlags),
		unrecognizedFlags: [],
	};
}
