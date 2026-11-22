// mend: one patch tool for every AI edit format.
//
// Applies an AI-written edit to a tree of text files, following the
// specification in SPEC.md (version 1). Four patch formats are read:
// unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls.
// Every edit is matched at the first of three tiers (exact, trailing
// whitespace ignored, surrounding whitespace ignored), and the whole
// patch is applied atomically: every change or none.
//
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// In a trial the grader sets MAKEFUN_ENV_URL and this file hands over
// to runner.ts (kept byte-identical from the kit); otherwise it runs
// the CLI on the arguments given.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the line to print and nothing else. */
class ParseFail extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: its code and the path it concerns. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and the
 *  empty piece after a final \n dropped. Patch line numbers count from 1. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A file's line break: CRLF when its first line feed follows a carriage
 *  return, LF otherwise. */
function breakOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's text as lines, its line break, and whether it ends with one.
 *  The last, empty piece after a final break is not a line; an empty file
 *  has no lines and no final break. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = breakOf(text);
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** The inverse of splitFile: the lines joined by the break, with a final
 *  one exactly when `final` says so; no lines means an empty file. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of two paths (UTF-8), for the exit-0 listing. */
function byteOrd(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The tree as the edits leave it: `cur` holds what changed (null means
 *  deleted); anything else is read from disk on demand and cached. */
class Tree {
  private disk = new Map<string, string | null>();
  readonly cur = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  read(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.read(p);
  }

  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }
}

/** One edit, applied to the tree; it throws EditFail when it cannot. */
type Edit = (tree: Tree, strict: boolean) => void;

/** One line normalised at a matching tier: 0 exact, 1 trailing spaces
 *  and tabs removed, 2 leading and trailing spaces and tabs removed. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where `old` matches `lines`
 *  at `tier`. Occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  const want = old.map((l) => normLine(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `old`
 *  occurs at least once at or after `from`, or -1 when it occurs nowhere. */
function findTier(lines: string[], old: string[], strict: boolean, from = 0): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (occurrences(lines, old, t, from).length > 0) return t;
  }
  return -1;
}

/** The first tier at which the single line `one` occurs at or after
 *  `from`, or -1. */
function findTierSingle(lines: string[], one: string, strict: boolean, from: number): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(one, t)) return t;
    }
  }
  return -1;
}

/** The first line at or after `from` equal to `one` at `tier`, or -1. */
function findFirstSingle(lines: string[], one: string, tier: number, from: number): number {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (normLine(lines[i]!, tier) === normLine(one, tier)) return i;
  }
  return -1;
}

interface NewLine {
  text: string;
  /** Index into O when this is a context line, -1 when it is a new line. */
  ctx: number;
}

/** The lines that replace the matched ones: a context line is written as
 *  the file's own matched line, never the patch's. At tier 2 every other
 *  line is re-indented from the patch's first old line to the file's first
 *  matched line; at tiers 0 and 1 the lines are written as they are. */
function buildNew(fileLines: string[], at: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  let leadOld = '';
  let leadFile = '';
  if (tier === 2) {
    leadOld = /^[ \t]*/.exec(oldLines[0] ?? '')?.[0] ?? '';
    leadFile = /^[ \t]*/.exec(fileLines[at] ?? '')?.[0] ?? '';
  }
  const out: string[] = [];
  for (const item of newLines) {
    if (item.ctx >= 0) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(leadOld)) out.push(leadFile + t.slice(leadOld.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** Which format a patch is in: the first rule of SPEC section 4 that
 *  holds, or null when none does. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

interface CliArgs {
  format: string | null;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/** The command line of SPEC section 1. A usage error is returned, not
 *  thrown, so the caller can print exactly `error: usage`. */
function parseArgs(argv: string[]): CliArgs | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return null;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return { format, check, strict, patch: pos.length === 0 ? null : pos[0]! };
}

// ---------------------------------------------------------------------------
// JSON (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object turned into an edit, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const crlf = breakOf(before) === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count++;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const { lines, br, final } = splitFile(before);
      if (lineNo < 0 || lineNo > lines.length) throw new EditFail('no-match', p);
      lines.splice(lineNo, 0, ...add);
      tree.set(p, joinFile(lines, br, final));
    };
  }
  return null;
}

/** The JSON reader: one array of edit objects, or one edit object per
 *  line (JSON Lines). A wrong command or a missing or mistyped key is a
 *  parse fault, at the array's first line or at the faulty line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFail(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseFail(`error: parse ${first + 1}`);
      edits.push(e);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (isBlank(l)) continue;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new ParseFail(`error: parse ${i + 1}`);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diff (SPEC section 6)
// ---------------------------------------------------------------------------

interface HunkBody {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: HunkBody[];
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastMark: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusMark: boolean;
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_GIT = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

/** A path from a `--- ` or `+++ ` header line: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed;
 *  `/dev/null` means no file, and a leading `a/` or `b/` is removed. */
function pathFromHeader(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function freshSection(): Section {
  return {
    pairOld: null,
    pairNew: null,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    create: false,
    del: false,
    hunks: [],
  };
}

/** One hunk applied to a file's lines, with the running offset `d` and
 *  the final-break rule of SPEC section 6. Throws EditFail on no-match. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(text);
  const lines = parts.lines;
  const br = parts.br;
  let final = parts.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.oldLines;
    const N = h.newLines;
    if (O.length === 0) {
      const at = Math.min(Math.max(0, h.a + d), lines.length);
      const atEnd = at === lines.length;
      const ins = buildNew(lines, at, O, N, 0);
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !h.lastMark;
      d += N.length;
      continue;
    }
    const tier = findTier(lines, O, strict, 0);
    if (tier < 0) throw new EditFail('no-match', path);
    const occs = occurrences(lines, O, tier, 0);
    const target = h.a - 1 + d;
    let best = occs[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occs) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const rep = buildNew(lines, at, O, N, tier);
    const endsAtEnd = at + O.length === lines.length;
    lines.splice(at, O.length, ...rep);
    if (endsAtEnd) final = !h.lastMark;
    d += N.length - O.length;
  }
  return joinFile(lines, br, final);
}

/** One unified section turned into an edit. */
function sectionToEdit(sec: Section): Edit {
  const oldP = sec.pairOld ?? sec.diffOld ?? sec.renameFrom;
  const newP = sec.pairNew ?? sec.diffNew ?? sec.renameTo;
  return (tree, strict) => {
    if (oldP != null && !isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (newP != null && !isSafePath(newP)) throw new EditFail('unsafe', newP);
    const oldPath: string | null = oldP ?? null;
    const newPath: string | null = newP ?? null;
    if (oldPath === null && newPath === null) return;
    if (sec.del || newPath === null) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (sec.create || oldPath === null) {
      if (tree.get(newPath!) !== null) throw new EditFail('exists', newPath!);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      let lastPlusMark = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.body.some((b) => b.kind === '+')) {
          lastPlusMark = h.lastPlusMark;
          break;
        }
      }
      tree.set(newPath!, plus.length === 0 ? '' : plus.join('\n') + (lastPlusMark ? '' : '\n'));
      return;
    }
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new EditFail('missing', oldPath);
      if (tree.get(newPath!) !== null) throw new EditFail('exists', newPath!);
      tree.set(newPath!, applyHunks(before, sec.hunks, strict, newPath!));
      tree.set(oldPath, null);
      tree.moves.push([oldPath, newPath!]);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new EditFail('missing', oldPath);
    tree.set(oldPath, applyHunks(before, sec.hunks, strict, oldPath));
  };
}

/** The unified reader: sections starting at a `diff --git` line or at a
 *  `--- `/`+++ ` pair, hunks starting at `@@` lines. Lines outside a
 *  section header or a hunk body are ignored. */
function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;

  const finishHunk = () => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    let oIdx = 0;
    for (const b of hunk.body) {
      if (b.kind === ' ') {
        oldLines.push(b.text);
        newLines.push({ text: b.text, ctx: oIdx });
        oIdx++;
      } else if (b.kind === '-') {
        oldLines.push(b.text);
        oIdx++;
      } else if (b.kind === '+') {
        newLines.push({ text: b.text, ctx: -1 });
      }
    }
    let lastCtxPlus = -1;
    let lastPlus = -1;
    for (let k = 0; k < hunk.body.length; k++) {
      if (hunk.body[k]!.kind === ' ' || hunk.body[k]!.kind === '+') lastCtxPlus = k;
      if (hunk.body[k]!.kind === '+') lastPlus = k;
    }
    hunk.oldLines = oldLines;
    hunk.newLines = newLines;
    hunk.lastMark = lastCtxPlus >= 0 && hunk.body[lastCtxPlus + 1]?.kind === '\\';
    hunk.lastPlusMark = lastPlus >= 0 && hunk.body[lastPlus + 1]?.kind === '\\';
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
      } else if (
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\')
      ) {
        hunk.body.push({
          kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'),
          text: line === '' ? '' : line.slice(1),
          raw: line,
        });
        continue;
      } else {
        finishHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new ParseFail(`error: parse ${i + 1}`);
      cur = freshSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = freshSection();
        cur.pairOld = pathFromHeader(line);
        cur.pairNew = pathFromHeader(lines[i + 1]!);
        sections.push(cur);
        i++;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseFail(`error: parse ${i + 1}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new ParseFail(`error: parse ${i + 1}`);
      const nh: Hunk = { a: parseInt(m[1]!, 10), body: [], oldLines: [], newLines: [], lastMark: false, lastPlusMark: false };
      cur.hunks.push(nh);
      hunk = nh;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur.hunks.length === 0) {
        cur.pairOld = pathFromHeader(line);
        cur.pairNew = pathFromHeader(lines[i + 1]!);
        i++;
        continue;
      }
      cur = freshSection();
      cur.pairOld = pathFromHeader(line);
      cur.pairNew = pathFromHeader(lines[i + 1]!);
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur.hunks.length === 0) throw new ParseFail(`error: parse ${i + 2}`);
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      continue;
    }
  }
  finishHunk();
  if (sections.length === 0) throw new ParseFail('error: parse 1');
  return sections.map(sectionToEdit);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE (SPEC section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const { lines, br, final } = splitFile(before);
    const tier = findTier(lines, oldLines, strict, 0);
    if (tier < 0) throw new EditFail('no-match', path);
    const occs = occurrences(lines, oldLines, tier, 0);
    if (occs.length > 1) throw new EditFail('ambiguous', path);
    const at = occs[0]!;
    const rep = buildNew(
      lines,
      at,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      tier,
    );
    lines.splice(at, oldLines.length, ...rep);
    tree.set(path, joinFile(lines, br, final));
  };
}

/** The SEARCH/REPLACE reader: each block is a path line, a
 *  `<<<<<<< SEARCH` line, old lines, a `=======` line, new lines and a
 *  `>>>>>>> REPLACE` line. Lines outside blocks are ignored. */
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= after; j--) {
      const t = lines[j]!;
      if (isBlank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new ParseFail(`error: parse ${sIdx + 1}`);
    edits.push(srEdit(path, lines.slice(sIdx + 1, sep), lines.slice(sep + 1, end)));
    prevPath = path;
    after = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.set(path, null);
  };
}

/** A chunk's body as old and new lines: context lines are shared, `-`
 *  lines are old only, `+` lines are new only. */
function v4aChunkLines(body: string[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let oIdx = 0;
  for (const l of body) {
    if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
      oIdx++;
    } else if (l.startsWith('+')) {
      newLines.push({ text: l.slice(1), ctx: -1 });
    } else if (l.startsWith(' ')) {
      oldLines.push(l.slice(1));
      newLines.push({ text: l.slice(1), ctx: oIdx });
      oIdx++;
    } else {
      oldLines.push('');
      newLines.push({ text: '', ctx: oIdx });
      oIdx++;
    }
  }
  return { oldLines, newLines };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const parts = splitFile(before);
    const lines = parts.lines;
    const br = parts.br;
    const final = parts.final;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tier = findTierSingle(lines, ch.anchor, strict, cursor);
        if (tier < 0) throw new EditFail('no-match', path);
        const idx = findFirstSingle(lines, ch.anchor, tier, cursor);
        cursor = idx + 1;
      }
      const { oldLines: O, newLines: N } = v4aChunkLines(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = buildNew(lines, at, O, N, 0);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tier = findTier(lines, O, strict, cursor);
      if (tier < 0) throw new EditFail('no-match', path);
      const occs = occurrences(lines, O, tier, cursor);
      let at = occs[0]!;
      if (ch.eof) {
        const good = occs.filter((p) => p + O.length === lines.length);
        if (good.length === 0) throw new EditFail('no-match', path);
        at = good[0]!;
      }
      const rep = buildNew(lines, at, O, N, tier);
      lines.splice(at, O.length, ...rep);
      cursor = at + rep.length;
    }
    const text = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.set(moveTo, text);
      tree.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, text);
    }
  };
}

/** The V4A reader: `*** Begin Patch` first and `*** End Patch` last,
 *  then Add / Delete / Update sections. Any other line is a parse fault. */
function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFail(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFail(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string) =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isHeader(l)) break;
        if (l.startsWith('+')) {
          secLines.push(l.slice(1));
          i++;
          continue;
        }
        if (isBlank(l)) {
          secLines.push('');
          i++;
          continue;
        }
        throw new ParseFail(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1]!)) secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isHeader(l)) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseFail(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const flush = () => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isHeader(l)) break;
        if (l.startsWith('@@')) {
          flush();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFail(`error: parse ${i + 1}`);
          cur.eof = true;
          flush();
          i++;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseFail(`error: parse ${i + 1}`);
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || isBlank(l)) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(l);
          i++;
          continue;
        }
        throw new ParseFail(`error: parse ${i + 1}`);
      }
      flush();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && isBlank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFail(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
      continue;
    }
    throw new ParseFail(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new ParseFail('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Running the patch (SPEC sections 1, 3 and 10)
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  out: string[];
}

/** Run the CLI on the arguments given: read the patch, read it in its
 *  format, apply its edits to the tree in order, and report. A failed
 *  edit changes nothing, and the edits after it still run. */
function runCli(argv: string[]): RunResult {
  const args = parseArgs(argv);
  if (args === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  try {
    text = readFileSync(args.patch === null || args.patch === '-' ? 0 : args.patch, 'utf8');
  } catch {
    if (args.patch !== null && args.patch !== '-') return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = args.format === null || args.format === 'auto' ? detectFormat(lines) : args.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new ParseFail('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.cur);
    const snapMoves = tree.moves.length;
    try {
      edit(tree, args.strict);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.cur.clear();
      for (const [k, v] of snap) tree.cur.set(k, v);
      tree.moves.length = snapMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const p of tree.cur.keys()) {
    const was = tree.read(p);
    const now = tree.cur.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (deleted.has(oldP) && added.has(newP) && !usedOld.has(oldP) && !usedNew.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of tree.cur.keys()) {
    const was = tree.read(p);
    const now = tree.cur.get(p)!;
    if (was === now) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => byteOrd(a.key, b.key));
  const changed = rows.map((r) => r.line);
  if (!args.check) {
    for (const p of tree.cur.keys()) {
      const was = tree.read(p);
      const now = tree.cur.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...changed, `ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`] };
}

// Trial hand-over: when the grader runs this file with MAKEFUN_ENV_URL
// set, the trial is run by runner.ts; otherwise this is the mend CLI.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const r = runCli(process.argv.slice(2));
  const outBuf = Buffer.from(r.out.map((l) => l + '\n').join(''), 'utf8');
  let written = 0;
  while (written < outBuf.length) written += writeSync(1, outBuf, written);
  process.exitCode = r.code;
}
