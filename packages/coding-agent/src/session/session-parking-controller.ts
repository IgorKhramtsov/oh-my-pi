export type SessionParkingState = "active" | "quiescing" | "disposing" | "parked";

export interface SessionParkingTimer {
	cancel(): void;
	unref?(): void;
}

export interface SessionParkingControllerOptions {
	idleMs: number;
	warningMs?: number;
	canPark: () => boolean;
	onWarning: (remainingMs: number) => void;
	onWarningCleared: () => void;
	park: (signal: AbortSignal) => Promise<boolean>;
	onError?: (error: unknown) => void;
	onStateChange?: (state: SessionParkingState) => void;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => SessionParkingTimer;
	clearTimer?: (timer: SessionParkingTimer) => void;
}

const DEFAULT_WARNING_MS = 10_000;
const ELIGIBILITY_RECHECK_MS = 30_000;

export class SessionParkingController {
	readonly #warningMs: number;
	readonly #now: () => number;
	readonly #setTimer: NonNullable<SessionParkingControllerOptions["setTimer"]>;
	readonly #clearTimer: NonNullable<SessionParkingControllerOptions["clearTimer"]>;
	#lastActivityAt: number;
	#timer: SessionParkingTimer | undefined;
	#state: SessionParkingState = "active";
	#disposalAbort: AbortController | undefined;
	#stopped = false;

	constructor(private readonly options: SessionParkingControllerOptions) {
		if (!Number.isFinite(options.idleMs) || options.idleMs <= 0)
			throw new Error("Parking idle duration must be positive");
		const warningMs = options.warningMs ?? DEFAULT_WARNING_MS;
		if (!Number.isFinite(warningMs) || warningMs <= 0) throw new Error("Parking warning duration must be positive");
		this.#warningMs = warningMs;
		this.#now = options.now ?? Date.now;
		this.#setTimer =
			options.setTimer ??
			((callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
			});
		this.#clearTimer = options.clearTimer ?? (timer => timer.cancel());
		this.#lastActivityAt = this.#now();
	}

	get state(): SessionParkingState {
		return this.#state;
	}

	start(): void {
		if (this.#stopped) return;
		this.#schedule(this.options.idleMs);
	}

	noteActivity(): void {
		if (this.#stopped || this.#state === "parked") return;
		this.#lastActivityAt = this.#now();
		if (this.#state === "disposing") {
			this.#disposalAbort?.abort();
			return;
		}
		if (this.#state === "quiescing") this.options.onWarningCleared();
		this.#setState("active");
		this.#schedule(this.options.idleMs);
	}

	stop(): void {
		this.#stopped = true;
		this.#disposalAbort?.abort();
		if (this.#timer) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		if (this.#state === "quiescing") this.options.onWarningCleared();
	}

	#setState(state: SessionParkingState): void {
		if (state === this.#state) return;
		this.#state = state;
		this.options.onStateChange?.(state);
	}

	#schedule(delayMs: number): void {
		if (this.#timer) this.#clearTimer(this.#timer);
		this.#timer = this.#setTimer(
			() => {
				this.#timer = undefined;
				void this.#check();
			},
			Math.max(0, delayMs),
		);
		this.#timer.unref?.();
	}

	async #check(): Promise<void> {
		if (this.#stopped || this.#state === "disposing" || this.#state === "parked") return;
		const elapsed = this.#now() - this.#lastActivityAt;
		const warningAt = this.options.idleMs;
		if (elapsed < warningAt) {
			this.#schedule(warningAt - elapsed);
			return;
		}
		if (!this.options.canPark()) {
			if (this.#state === "quiescing") {
				this.options.onWarningCleared();
				this.#setState("active");
			}
			this.#lastActivityAt = this.#now();
			this.#schedule(ELIGIBILITY_RECHECK_MS);
			return;
		}
		if (this.#state !== "quiescing") {
			this.#setState("quiescing");
			this.options.onWarning(this.#warningMs);
			this.#schedule(this.#warningMs);
			return;
		}
		this.#setState("disposing");
		const disposalAbort = new AbortController();
		this.#disposalAbort = disposalAbort;
		try {
			const committed = await this.options.park(disposalAbort.signal);
			if (!committed) throw new Error("Parking cancelled");
			this.#setState("parked");
		} catch (error) {
			this.options.onWarningCleared();
			if (this.#stopped) return;
			if (!disposalAbort.signal.aborted) this.options.onError?.(error);
			this.#lastActivityAt = this.#now();
			this.#setState("active");
			this.#schedule(this.options.idleMs);
		} finally {
			if (this.#disposalAbort === disposalAbort) this.#disposalAbort = undefined;
		}
	}
}
