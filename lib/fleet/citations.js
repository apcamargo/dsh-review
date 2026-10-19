/**
 * The citation gate: every lane stance that claims reachability, provenance,
 * consistency or simplification safety is checked against the real files. The
 * cited file must exist and
 * the whitespace-normalized quote must appear in it, with the cited line within
 * LINE_WINDOW of the actual span of the nearest occurrence of the quote in the
 * file — so a hallucinated citation (right quote, invented place) never
 * verifies, while a correct citation whose quote repeats through the file
 * verifies against the occurrence it cites. A stance whose citations all
 * fail is demoted to `unclear` with a note. Non-line-specific evidence (no
 * `line`) resolves anywhere in the file, matching the evidence schema's
 * optional `line`. A cited path that is not a regular file (a directory, a
 * never-EOF device) or sits above {@link CITATION_SIZE_CAP} is refused without
 * reading: the contract is a boolean, the ≥512 MB reads already failed every
 * quote (the V8 string limit), so the cap bounds the wasted read first and the
 * isFile refusal closes the device corner. Evidence paths are LLM-authored
 * (the verifier lanes' normalized results) and reach `node:fs` directly, so a
 * path that resolves — lexically or by realpath — outside the reviewed
 * worktree is refused without reading: the gate verifies against the reviewed
 * worktree, never an arbitrary host file, and a worktree-internal symlink
 * whose realpath escapes is refused by the same containment (the contract is
 * containment, not spelling: an absolute path that resolves inside the
 * worktree is allowed). Executed reproduction output cannot
 * be re-verified and is taken at face value, labeled as the lane's claim.
 *
 * @module @apcamargo/dsh-review/fleet/citations
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Lines around the quote's actual span the cited line may sit in. */
const LINE_WINDOW = 10;

/** Occurrences of the quote the span check examines before demoting, bounded
 * so the reject path cannot walk every occurrence of a short quote repeated
 * through a large cited file (each span costs two lineOfOffset passes over
 * the whole file). */
const MAX_QUOTE_OCCURRENCES = 24;

/**
 * Content above this size is refused, never read. Distinct from changes.js's
 * HASH_SIZE_CAP (1 MB, snapshot hashing): cited files legitimately exceed the
 * snapshot-hashing cap, so this cap is high enough to confine the refusal to
 * the pathological ≥512 MB corner the uncapped read already failed at.
 */
export const CITATION_SIZE_CAP = 10_000_000;

/** Whitespace-collapsed text, so formatting never hides a match. */
export function normalizeText(text) {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Map a whitespace-normalized character offset back to a 0-based source line.
 * The fictional full text is the per-line normalized texts joined with single
 * spaces — exactly what {@link lineOfOffset} walks, so empty lines contribute
 * a doubled separator there too and the offset→line mapping is exact.
 */
function lineOfOffset(normalizedLines, offset) {
	let cursor = 0;
	for (let i = 0; i < normalizedLines.length; i++) {
		const next = cursor + normalizedLines[i].length + 1;
		if (offset < next) return i;
		cursor = next;
	}
	return normalizedLines.length - 1;
}

/** Whether one evidence item resolves in the working tree. */
export async function checkEvidence(cwd, item) {
	if (!item?.file || !item?.quote) return false;
	let content;
	try {
		const target = path.resolve(cwd, item.file);
		// Containment: LLM-authored evidence paths (normalizeFindings and
		// normalizeLaneResult cap length, never place) reach node:fs here, so an
		// absolute or ../-escaping path must resolve inside the reviewed
		// worktree before stat. An absolute path that resolves inside cwd is
		// allowed — the contract is containment, not spelling.
		const rel = path.relative(cwd, target);
		if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
		// Symlink hardening: the realpath is the file the gate would read, so a
		// worktree-internal symlink whose realpath escapes is refused too. A
		// dangling symlink or a loop fails realpath and answers like a missing
		// file. The base is the cwd's own realpath (the worktree root may
		// itself be reached through a symlink).
		const real = await fs.realpath(target).catch(() => null);
		const realRel = real ? path.relative(await fs.realpath(cwd), real) : null;
		if (!real || realRel === "" || realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return false;
		const stats = await fs.stat(target);
		if (!stats.isFile() || stats.size > CITATION_SIZE_CAP) return false;
		content = await fs.readFile(target, "utf8");
	} catch {
		return false;
	}
	const normalizedLines = content.split("\n").map(normalizeText);
	const joined = normalizedLines.join(" ");
	const quote = normalizeText(item.quote);
	if (!quote) return false;
	// The quote must appear in the file at all (whitespace-normalized), located
	// in the same join {@link lineOfOffset} maps, so the mapping is exact even
	// across runs of consecutive empty lines.
	if (!joined.includes(quote)) return false;
	// Non-line-specific evidence resolves anywhere in the file (the evidence
	// schema treats `line` as optional).
	if (typeof item.line !== "number") return true;
	// Line-specific evidence: the cited line must sit within LINE_WINDOW of the
	// actual span of SOME occurrence of the quote. The first occurrence's span
	// alone falsely demoted a correct citation whose quote repeats through the
	// file; the nearest matching occurrence grounds the stance, and a
	// right-quote-wrong-place citation still fails (no occurrence's window
	// contains the cited line). The old unconditional whole-file fallback
	// verified a right-quote-wrong-place citation (the defect this check
	// closes). Bounded: early-exit on accept, and the reject path checks at
	// most {@link MAX_QUOTE_OCCURRENCES} spans.
	const cited = item.line - 1;
	let cursor = joined.indexOf(quote);
	for (let checked = 0; cursor >= 0 && checked < MAX_QUOTE_OCCURRENCES; checked++) {
		const spanStart = lineOfOffset(normalizedLines, cursor);
		const spanEnd = lineOfOffset(normalizedLines, cursor + quote.length - 1);
		if (cited >= spanStart - LINE_WINDOW && cited <= spanEnd + LINE_WINDOW) return true;
		cursor = joined.indexOf(quote, cursor + 1);
	}
	return false;
}

/**
 * Verify one lane result's stance. Returns the demoted outcome and the note
 * when the citations fail; otherwise the outcome passes through.
 * @returns `{ outcome, note? }` or undefined when the result is absent.
 */
export async function gateStance(cwd, result, cited) {
	if (!result || result === "failed" || result === "unassessed") return;
	if (!cited) return;
	const needs = result.outcome !== "unclear";
	if (!needs) return;
	const total = result.evidence?.length ?? 0;
	let verified = 0;
	for (const item of result.evidence ?? []) {
		if (await checkEvidence(cwd, item)) verified++;
	}
	if (verified === 0) {
		return { outcome: "unclear", note: `citation not found${total ? ` (${total} cited)` : " (none cited)"}` };
	}
	return { outcome: result.outcome, note: `${verified}/${total} citations verified` };
}
