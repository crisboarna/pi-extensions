// Spoken narration for a recorded page, inside the media image.
//
// A narrated manifest item names a narration file under the media folder's
// src/ (`"narration": "hero.narration.json"`): the voice, its speed, the
// pause after each line and the lines by id. Before recording, every line is
// synthesized with Kokoro-82M (cached in <media>/.voice by a hash of what
// shapes the audio), so the page knows how long each line lasts:
// `await stage.say("block")` marks the moment and waits for the line and the
// pause. After recording, the lines are placed at their marks, normalized to
// -16 LUFS, mixed over the music bed (ducked under the voice, looped with a
// crossfade, faded in and out), and muxed into the MP4 as AAC; a WebVTT file
// with one cue per line is written next to it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULES = process.env.MEDIA_MODULES ?? "/opt/media/node_modules";
/** The Kokoro model files baked into the image (tools/docker/media.Dockerfile), at a pinned revision. */
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const MODELS = process.env.MEDIA_MODELS ?? "/opt/media/models";
/** The music bed: a CC0 piece committed with its source (tools/media/audio/README.md). */
const MUSIC = process.env.MEDIA_MUSIC ?? "/repo/tools/media/audio/first-light-particles.mp3";
const VOICE_LUFS = -16;
const MUSIC_LUFS = -30;
const LOUDNESS_TOLERANCE = 1;

let tts;
async function kokoro() {
	if (tts) return tts;
	const require = createRequire(`${MODULES}/`);
	const { env } = require("@huggingface/transformers");
	// Renders never reach the network: the model is read from the image.
	env.allowRemoteModels = false;
	env.localModelPath = `${MODELS}/`;
	const { KokoroTTS } = require("kokoro-js");
	tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" });
	return tts;
}

const ffmpeg = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
const probeSeconds = (file) =>
	Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

/** The loudnorm filter's measurements of a file (its JSON report, which ffmpeg writes to stderr). */
function loudness(file) {
	const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"], { encoding: "utf8" });
	const report = run.stderr ?? "";
	if (run.status !== 0) throw new Error(`narration: could not measure ${file}: ${report.slice(-400)}`);
	return JSON.parse(report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1));
}

/** Two-pass loudnorm: measured first, then corrected linearly so speech keeps its dynamics. */
function normalize(input, output, target) {
	const m = loudness(input);
	ffmpeg([
		"-i",
		input,
		"-af",
		`loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
		"-ar",
		"48000",
		output,
	]);
	return Number(loudness(output).input_i);
}

/**
 * Reads the narration file of an item and synthesizes every line that is not cached yet.
 * Returns the lines by id with their audio file and length, and the pause after each.
 */
export async function prepareNarration(item, mediaDir) {
	const script = JSON.parse(readFileSync(join(mediaDir, "src", item.narration), "utf8"));
	const { voice, speed = 1, pause = 0.6, lines } = script;
	const cache = join(mediaDir, ".voice");
	mkdirSync(cache, { recursive: true });
	const prepared = {};
	for (const [id, text] of Object.entries(lines)) {
		const key = createHash("sha256")
			.update(JSON.stringify({ model: MODEL, revision: MODEL_REVISION, voice, speed, text }))
			.digest("hex")
			.slice(0, 16);
		const file = join(cache, `${key}.wav`);
		if (!existsSync(file)) {
			const audio = await (await kokoro()).generate(text, { voice, speed });
			await audio.save(file);
		}
		prepared[id] = { text, file, seconds: probeSeconds(file) };
	}
	return { lines: prepared, pause };
}

const stamp = (seconds) => {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
	const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
	const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
	return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
};

/** One cue per spoken line, from its mark to its end. */
export function narrationVtt(marks, narration) {
	const cues = marks.map(({ id, at }, index) => {
		const line = narration.lines[id];
		return `${index + 1}\n${stamp(at)} --> ${stamp(at + line.seconds)}\n${line.text}\n`;
	});
	return `WEBVTT\n\n${cues.join("\n")}`;
}

/**
 * Mixes the narration and the music bed into `<base>.mp4` (video copied) and writes `<base>.vtt`.
 * `marks` are the video times, in seconds, at which the page started each line.
 * Fails when the voice track misses its loudness target.
 */
export function mixNarration(base, marks, narration) {
	const work = mkdtempSync(join(tmpdir(), "narration-"));
	try {
		const video = `${base}.mp4`;
		const duration = probeSeconds(video);
		// The voice: every line at its mark, then normalized as one track.
		const placed = join(work, "voice-placed.wav");
		const inputs = marks.flatMap(({ id }) => ["-i", narration.lines[id].file]);
		const delays = marks.map(({ at }, index) => `[${index}]adelay=${Math.round(at * 1000)}:all=1[l${index}]`);
		const mix = `${marks.map((_, index) => `[l${index}]`).join("")}amix=inputs=${marks.length}:normalize=0:duration=longest,apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)}`;
		ffmpeg([...inputs, "-filter_complex", [...delays, mix].join(";"), "-ar", "48000", "-ac", "1", placed]);
		const voice = join(work, "voice.wav");
		const voiceLufs = normalize(placed, voice, VOICE_LUFS);
		if (Math.abs(voiceLufs - VOICE_LUFS) > LOUDNESS_TOLERANCE) {
			throw new Error(`narration: the voice measures ${voiceLufs} LUFS; it must be ${VOICE_LUFS} ±${LOUDNESS_TOLERANCE}`);
		}
		// The music: two copies crossfaded into one long loop, trimmed to the video, levelled, faded.
		const looped = join(work, "music-looped.wav");
		ffmpeg([
			"-i",
			MUSIC,
			"-i",
			MUSIC,
			"-filter_complex",
			`[0:a][1:a]acrossfade=d=4:c1=tri:c2=tri,atrim=0:${duration.toFixed(3)},afade=t=in:d=2,afade=t=out:st=${Math.max(0, duration - 3).toFixed(3)}:d=3`,
			"-ar",
			"48000",
			"-ac",
			"2",
			looped,
		]);
		const music = join(work, "music.wav");
		const musicLufs = normalize(looped, music, MUSIC_LUFS);
		// The music ducks about 12 dB while the voice speaks, and comes back in the pauses.
		const soundtrack = join(work, "soundtrack.wav");
		ffmpeg([
			"-i",
			voice,
			"-i",
			music,
			"-filter_complex",
			"[0:a]aformat=channel_layouts=stereo,asplit[v][sc];[1:a][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[d];[d][v]amix=inputs=2:normalize=0:duration=first",
			"-ar",
			"48000",
			soundtrack,
		]);
		const muxed = join(work, "muxed.mp4");
		ffmpeg([
			"-i",
			video,
			"-i",
			soundtrack,
			"-map",
			"0:v",
			"-map",
			"1:a",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-b:a",
			"160k",
			"-movflags",
			"+faststart",
			"-shortest",
			muxed,
		]);
		writeFileSync(video, readFileSync(muxed));
		writeFileSync(`${base}.vtt`, narrationVtt(marks, narration));
		return { voiceLufs, musicLufs };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
