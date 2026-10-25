/** Wall clock, injectable so tests control time. */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Uniform random numbers in [0, 1), injectable so tests are repeatable. */
export interface Rng {
	next(): number;
}

export const systemRng: Rng = { next: () => Math.random() };

/** Mulberry32: small, fast and good enough for selection and tests. */
export function seededRng(seed: number): Rng {
	let state = seed >>> 0;
	return {
		next() {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		},
	};
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sortable id: 10 time characters then 8 random ones, prefixed (for example `d_`). */
export function newId(prefix: string, clock: Clock = systemClock, rng: Rng = systemRng): string {
	let time = clock.now();
	let head = "";
	for (let i = 0; i < 10; i++) {
		head = (ALPHABET[time % 32] ?? "0") + head;
		time = Math.floor(time / 32);
	}
	let tail = "";
	for (let i = 0; i < 8; i++) tail += ALPHABET[Math.floor(rng.next() * 32)] ?? "0";
	return `${prefix}${head}${tail}`;
}
