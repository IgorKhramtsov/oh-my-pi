import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MUX_CONNECT_METHOD, MUX_RELEASE_METHOD } from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";
import { LspMuxServer } from "@oh-my-pi/pi-coding-agent/lsp/mux/server";

function frame(message: unknown): Buffer {
	const body = JSON.stringify(message);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for LSP mux state");
}

describe("parked LSP mux release", () => {
	let server: LspMuxServer | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		await server?.shutdown();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("stops the shared server immediately when the parked link is last", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-mux-park-"));
		const childPath = path.join(tempDir, "server.mjs");
		await fs.writeFile(
			childPath,
			[
				"let input = '';",
				"const decoder = new TextDecoder();",
				"for await (const chunk of Bun.stdin.stream()) {",
				"  input += decoder.decode(chunk);",
				"  const boundary = input.indexOf('\\r\\n\\r\\n');",
				"  if (boundary < 0) continue;",
				"  const message = JSON.parse(input.slice(boundary + 4));",
				"  if (message.method !== 'shutdown') continue;",
				"  const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null });",
				"  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);",
				"}",
			].join("\n"),
		);

		server = new LspMuxServer();
		const endpoint = path.join(tempDir, "mux.sock");
		await server.listen(endpoint);
		const socket = net.createConnection(endpoint);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const connected = new Promise<void>((resolve, reject) => {
			socket.once("data", () => resolve());
			socket.once("error", reject);
		});
		socket.write(
			frame({
				jsonrpc: "2.0",
				id: 1,
				method: MUX_CONNECT_METHOD,
				params: { command: process.execPath, args: [childPath], cwd: tempDir },
			}),
		);
		await connected;
		expect(server.serverKeys).toHaveLength(1);

		socket.end(frame({ jsonrpc: "2.0", method: MUX_RELEASE_METHOD }));
		await waitUntil(() => server?.serverKeys.length === 0);
		expect(server.serverKeys).toHaveLength(0);
	}, 5000);
});
