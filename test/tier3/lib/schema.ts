// Schema check of requirements.yml (plan D.3). Pure: takes the parsed document and the scenario ids on disk.
export const SCOPES = ["in", "residual", "out"] as const;

export function validateRequirements(doc: any, scenarioFiles: string[]): string[] {
	const errors: string[] = [];
	if (doc?.version !== 1) errors.push("version must be 1");
	if (!Array.isArray(doc?.requirements)) return [...errors, "requirements[] missing"];
	if (!Array.isArray(doc?.scenarios)) errors.push("scenarios[] missing");
	const scenarios: any[] = Array.isArray(doc?.scenarios) ? doc.scenarios : [];

	const ids = doc.requirements.map((r: any) => r?.id);
	for (const id of new Set(ids.filter((x: string, i: number) => ids.indexOf(x) !== i))) errors.push(`duplicate requirement id ${id}`);
	const sids = scenarios.map(s => s?.id);
	for (const id of new Set(sids.filter((x: string, i: number) => sids.indexOf(x) !== i))) errors.push(`duplicate scenario id ${id}`);

	for (const s of scenarios) {
		if (s.runner !== "haiku" && s.runner !== "scripted") errors.push(`scenario ${s.id}: runner must be haiku or scripted`);
		if (s.runner === "haiku" && s.repeats !== 3) errors.push(`scenario ${s.id}: haiku repeats must be 3`);
		if (s.runner === "scripted" && s.repeats !== 1) errors.push(`scenario ${s.id}: scripted repeats must be 1`);
		if (!scenarioFiles.includes(s.id)) errors.push(`scenario ${s.id} has no scenarios/${s.id}.yml`);
	}
	for (const f of scenarioFiles) if (!scenarios.some(s => s.id === f)) errors.push(`scenarios/${f}.yml has no scenarios[] entry`);

	for (const r of doc.requirements) {
		const where = `${r?.id}`;
		if (!SCOPES.includes(r?.scope)) errors.push(`${where}: scope must be in, residual or out`);
		if (r?.scope === "in" && !Array.isArray(r?.evidence)) errors.push(`${where}: evidence[] missing`);
		const evidence: any[] = Array.isArray(r?.evidence) ? r.evidence : [];
		if (r?.scope === "in" && evidence.length === 0) errors.push(`${where}: scope in with no evidence`);
		if (r?.scope === "out" && !r.reason) errors.push(`${where}: out row needs a reason`);
		// Director-recorded deviation from D.3 (2026-11-05): a residual row is justified by a note, a reason, or a source that cites the LLD.
		if (r?.scope === "residual" && !(r.note || r.reason || /\bLLD\b/.test(String(r.source ?? "")))) errors.push(`${where}: residual row needs a note, a reason, or an LLD source`);
		for (const e of evidence) {
			if (e?.kind === "bun-test") {
				if (typeof e.file !== "string" || typeof e.name !== "string" || e.name.length === 0) errors.push(`${where}: bun-test evidence needs file and name`);
			} else if (e?.kind === "scenario") {
				const s = scenarios.find(x => x.id === e.id);
				if (!s) errors.push(`${where}: scenario ${e.id} is not in scenarios[]`);
				else if (s.runner !== e.runner) errors.push(`${where}: scenario ${e.id} runner ${e.runner} != ${s.runner}`);
				else if (s.repeats !== e.repeats) errors.push(`${where}: scenario ${e.id} repeats ${e.repeats} != ${s.repeats}`);
			} else errors.push(`${where}: evidence kind must be bun-test or scenario`);
		}
	}
	return errors;
}
