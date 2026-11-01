// The part of Node's Buffer that pi-context-refs' core uses (from, byteLength,
// indexOf, equals, subarray, toString), for the browser. Importing this module
// installs it as globalThis.Buffer when the page has none, so it must be the
// first import of an explainer that loads the core.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A Uint8Array with the Buffer methods the core calls. */
// @ts-expect-error: Buffer.from takes a string or bytes, which the Uint8Array.from signature does not allow; the core only passes those
export class ShimBuffer extends Uint8Array {
	static override from(source: string | Uint8Array): ShimBuffer {
		const bytes = typeof source === "string" ? encoder.encode(source) : source;
		const copy = new ShimBuffer(bytes.length);
		copy.set(bytes);
		return copy;
	}

	static byteLength(text: string, _encoding?: string): number {
		return encoder.encode(text).length;
	}

	override indexOf(needle: number | Uint8Array, from = 0): number {
		if (typeof needle === "number") return super.indexOf(needle, from);
		for (let at = from; at + needle.length <= this.length; at += 1) {
			if (needle.every((byte, offset) => this[at + offset] === byte)) return at;
		}
		return -1;
	}

	equals(other: Uint8Array): boolean {
		return this.length === other.length && this.every((byte, at) => byte === other[at]);
	}

	override toString(): string {
		return decoder.decode(this);
	}
}

if (!("Buffer" in globalThis)) Object.defineProperty(globalThis, "Buffer", { value: ShimBuffer, configurable: true, writable: true });
