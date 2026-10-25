/**
 * Built-in name hints for auto-tiering (decision 53): single words that
 * suggest a smaller or a larger model, used only as a tiebreak after catalog
 * price. This is the one source file allowed to name model families; the
 * source-scan test checks it holds single words, never model ids.
 */
export const SMALL_HINTS: readonly string[] = ["mini", "nano", "flash", "lite", "small", "tiny", "haiku", "fast", "instant"];

export const LARGE_HINTS: readonly string[] = ["opus", "pro", "max", "ultra", "large", "plus", "thinking"];
