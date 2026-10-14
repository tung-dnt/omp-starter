// Display language for /trans. Any language works: the wizard offers presets and takes a typed
// name for the rest; agy detects the source language itself.
import type { LanguageState } from "./state";

export interface LanguagePreset {
	/** Short code used in translated file names (`notes.vi.md`). */
	code: string;
	/** Wizard label: native name, then English. */
	label: string;
	/** Name used in translation instructions and stored as `language.name`. */
	english: string;
	/** Extra guidance for repairing speech-to-text input, when the language needs it. */
	dictationHint?: string;
}

export const PRESETS: LanguagePreset[] = [
	{
		code: "vi",
		label: "Tiếng Việt (Vietnamese)",
		english: "Vietnamese",
		dictationHint:
			'The text may come from speech-to-text, so repair misheard words from context (e.g. "Clock"/"Clot" -> Claude, "Jena"/"Gemi" -> Gemini, "tóc cần" -> token, "phomat" -> format, "from" -> prompt).',
	},
	{ code: "zh", label: "中文 (Simplified Chinese)", english: "Simplified Chinese" },
	{ code: "ja", label: "日本語 (Japanese)", english: "Japanese" },
	{ code: "ko", label: "한국어 (Korean)", english: "Korean" },
	{ code: "th", label: "ไทย (Thai)", english: "Thai" },
	{ code: "ru", label: "Русский (Russian)", english: "Russian" },
];

export function presetFor(name: string): LanguagePreset | undefined {
	const key = name.trim().toLowerCase();
	return PRESETS.find(p => p.english.toLowerCase() === key || p.code === key);
}

/** Display language name; state written before 0.11 stored a preset code instead. */
export function languageName(state: LanguageState | undefined): string | undefined {
	if (state?.status !== "done") return undefined;
	return state.name ?? (state.code ? presetFor(state.code)?.english : undefined);
}

/** Suffix for a translated copy: the preset code, else the name as a slug (`brazilian-portuguese`). */
export function fileSuffix(name: string): string {
	return (
		presetFor(name)?.code ??
		name
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-|-$/g, "")
	);
}
