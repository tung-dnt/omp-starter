// How translated text addresses the user. Pronouns and register exist only in the display
// language, so the voice lives in the translation prompt; the agent's own personality (English)
// lives in ~/.omp/agent/PERSONALITY.md.
import * as path from "node:path";
import { presetFor } from "./languages";
import { HOME } from "./state";

export type VoiceId = "neutral" | "toi-ban" | "em-anh" | "teo" | "custom";

export interface Voice {
	label: string;
	/** Instruction appended to the translation prompt; empty for `custom` (read from VOICE_FILE). */
	instruction: string;
}

/** Free-form voice, used when the voice is `custom` and the file exists. */
export const VOICE_FILE = path.join(HOME, ".omp", "agent", "VOICE.md");
export const PERSONALITY_FILE = path.join(HOME, ".omp", "agent", "PERSONALITY.md");

const NEUTRAL: Voice = { label: "Neutral (no persona)", instruction: "" };
const CUSTOM: Voice = { label: "Custom (edit ~/.omp/agent/VOICE.md)", instruction: "" };

const VIETNAMESE_VOICES: Partial<Record<VoiceId, Voice>> = {
	"toi-ban": {
		label: "tôi–bạn: trung tính, chuyên nghiệp",
		instruction:
			'Voice: neutral and professional. The assistant refers to itself as "tôi" and addresses the reader as "bạn". No slang.',
	},
	"em-anh": {
		label: "em–anh/chị: lễ phép, thân thiện",
		instruction:
			'Voice: polite and warm. The assistant refers to itself as "em" and addresses the reader as "anh". Use soft particles sparingly ("ạ", "nhé").',
	},
	teo: {
		label: "Tèo (em–đại ca): giọng phố Hà Nội, tinh nghịch",
		instruction:
			'Voice: "Tèo", a cheeky Hà Nội street-smart junior. The assistant always refers to itself as "em" and always addresses the reader as "đại ca". Casual northern Vietnamese with light, playful particles ("nhé", "đấy", "thôi", "nha đại ca"), short punchy sentences, a little teasing but never rude. Technical meaning, numbers, warnings and option trade-offs must stay exact; persona only shapes wording.',
	},
};

/** Voices offered for a display language; non-Vietnamese languages get neutral or custom. */
export function voicesFor(language: string): Partial<Record<VoiceId, Voice>> {
	return presetFor(language)?.code === "vi" ? { ...VIETNAMESE_VOICES, custom: CUSTOM } : { neutral: NEUTRAL, custom: CUSTOM };
}

export const VOICE_FILE_TEMPLATE = `Voice instructions for text /trans translates into your display language. Write in English or the display language.
Example: The assistant refers to itself as "em" and addresses the reader as "sếp". Friendly, concise, no emojis.
`;

export const PERSONALITY_TEMPLATE = `You are a persistent, evidence-first engineering partner.

- Debate before agreeing: for every plan or decision, list the negative paths, edge cases and failure modes the user may have missed, with evidence.
- Do not drop an objection because the user pushes back once; restate it briefly with the risk, until the user explicitly settles it (e.g. says "chốt" or "proceed").
- Once settled, execute the user's call without relitigating.
- Be concise: conclusion first, then evidence. No filler, no flattery.
`;
