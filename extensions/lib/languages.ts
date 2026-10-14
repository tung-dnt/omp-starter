// Display languages the translation layer supports. Each has a script or diacritics no English text
// uses, so a prompt is routed to translation by a regex instead of an extra model call.

export type LanguageCode = "vi" | "zh" | "ja" | "ko" | "th" | "ru";

export interface Language {
	/** Wizard label: native name, then English. */
	label: string;
	/** Name used in translation instructions. */
	english: string;
	/** Matches text written in this language. */
	detect: RegExp;
	/** Footer status while a translation runs. */
	busy: string;
	/** Title of the translated-plan viewer. */
	planTitle: string;
	/** Extra guidance for repairing speech-to-text input, when the language needs it. */
	dictationHint?: string;
}

export const LANGUAGES: Record<LanguageCode, Language> = {
	vi: {
		label: "Tiếng Việt (Vietnamese)",
		english: "Vietnamese",
		// ă đ ơ ư and the tone-marked block U+1EA0–U+1EF9 appear only in Vietnamese.
		detect: /[ăđơưĂĐƠƯ\u1EA0-\u1EF9]/,
		busy: "Đang dịch…",
		planTitle: "Kế hoạch (tiếng Việt)",
		dictationHint:
			'The text may come from speech-to-text, so repair misheard words from context (e.g. "Clock"/"Clot" -> Claude, "Jena"/"Gemi" -> Gemini, "tóc cần" -> token, "phomat" -> format, "from" -> prompt).',
	},
	zh: { label: "中文 (Simplified Chinese)", english: "Simplified Chinese", detect: /\p{Script=Han}/u, busy: "翻译中…", planTitle: "计划（中文）" },
	ja: {
		label: "日本語 (Japanese)",
		english: "Japanese",
		detect: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
		busy: "翻訳中…",
		planTitle: "計画（日本語）",
	},
	ko: { label: "한국어 (Korean)", english: "Korean", detect: /\p{Script=Hangul}/u, busy: "번역 중…", planTitle: "계획 (한국어)" },
	th: { label: "ไทย (Thai)", english: "Thai", detect: /\p{Script=Thai}/u, busy: "กำลังแปล…", planTitle: "แผน (ภาษาไทย)" },
	ru: { label: "Русский (Russian)", english: "Russian", detect: /\p{Script=Cyrillic}/u, busy: "Перевод…", planTitle: "План (русский)" },
};

export const LANGUAGE_CODES = Object.keys(LANGUAGES) as LanguageCode[];
