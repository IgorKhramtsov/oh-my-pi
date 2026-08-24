import { createConnection } from "node:net";
import { type } from "@oh-my-pi/omptype";

const DescriptorSchema = type({
	version: "1",
	socketPath: "string > 0",
	token: "string > 0",
	handoffDir: "string > 0",
});
export interface ParkLauncherClient {
	readonly token: string;
	readonly handoffDir: string;
	publish(statePath: string, signal: AbortSignal): Promise<void>;
}

export async function loadParkLauncherClient(
	descriptorPath: string | undefined = process.env.OMP_PARK_DESCRIPTOR,
): Promise<ParkLauncherClient | undefined> {
	const launcherPid = Number(process.env.OMP_PARK_LAUNCHER_PID);
	if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0 || process.ppid !== launcherPid) return undefined;
	if (!descriptorPath) return undefined;
	const raw: unknown = await Bun.file(descriptorPath).json();
	const descriptor = DescriptorSchema(raw);
	if (descriptor instanceof type.errors) throw new Error(`Invalid parking launcher descriptor: ${descriptor.summary}`);
	return {
		token: descriptor.token,
		handoffDir: descriptor.handoffDir,
		publish: (statePath, signal) => publishReady(descriptor.socketPath, descriptor.token, statePath, signal),
	};
}

function publishReady(socketPath: string, token: string, statePath: string, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Parking cancelled"));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const socket = createConnection(socketPath);
	let response = "";
	let committed = false;
	let settled = false;
	const finish = (error?: Error): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", abort);
		if (error) reject(error);
		else resolve();
	};
	const abort = (): void => {
		if (committed || settled) return;
		socket.destroy();
		finish(signal.reason instanceof Error ? signal.reason : new Error("Parking cancelled"));
	};
	signal.addEventListener("abort", abort, { once: true });
	socket.setEncoding("utf8");
	socket.once("connect", () => {
		if (signal.aborted) {
			abort();
			return;
		}
		committed = true;
		socket.end(`${JSON.stringify({ version: 1, type: "parked", token, statePath })}\n`);
	});
	socket.on("data", chunk => {
		response += chunk;
	});
	socket.once("error", error => finish(error));
	socket.once("close", () => {
		if (response.trim() === "ok") finish();
		else finish(new Error("Parking launcher did not acknowledge the handoff"));
	});
	return promise;
}
