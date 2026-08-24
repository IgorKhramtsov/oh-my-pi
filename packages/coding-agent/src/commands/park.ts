import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { loadParkHandoff } from "../session/parking-handoff";
import { releaseParkedSession } from "../session/session-owner-lease";
import { setSessionPinned } from "../session/session-pins";
import { resumeCommand } from "../utils/resume-command";

export default class Park extends Command {
	static hidden = true;
	static args = {
		action: Args.string({ required: true, options: ["release", "favorite"] }),
		state: Args.string({ required: true }),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Park);
		if (!args.state) throw new Error("Parked session state path is required");
		const state = await loadParkHandoff(args.state);
		if (args.action === "favorite") await setSessionPinned(state.sessionId, true);
		if (!releaseParkedSession(state.sessionFile, state.token)) {
			throw new Error("Parked session reservation changed before it could be released");
		}
		if (args.action === "release") {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${resumeCommand(state.sessionId)}`)}\n`);
		}
	}
}
