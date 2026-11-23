// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, so run() can print `R old -> new` lines. */
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- shared helpers for the line formats (SPEC.md section 5) ----------

/** A file split into lines at its own break, with whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: Split): string {
  return s.lines.length === 0 ? '' : s.lines.join(s.br) + (s.final ? s.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const onlyWs = (s: string): boolean => s !== '' && /^[ \t]+$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return stripWs(a) === stripWs(b);
}

/** Occurrences of O in `file` at or after `from`, at the first tier with at least one. */
function occurrences(file: string[], O: string[], from: number, strict: boolean): { tier: number; pos: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineEq(file[i + k]!, O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return { tier: -1, pos: [] };
}

/** One line of N: `ctx` >= 0 is a context line (the file's own line O[ctx]); -1 is a new line. */
interface NLine {
  text: string;
  ctx: number;
}

/** Render N against the file's matched lines at `pos` (SPEC.md section 5). */
function renderN(file: string[], pos: number, tier: number, O: string[], N: NLine[]): string[] {
  const F = tier === 2 ? leadWs(file[pos] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  return N.map((n) => {
    if (n.ctx >= 0) return file[pos + n.ctx]!;
    const t = n.text;
    if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  noEol: boolean;
  hasPlus: boolean;
  lastPlusNoEol: boolean;
}

interface Section {
  pairOld: string | null | undefined; // undefined: no pair; null: /dev/null
  pairNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[at]!)!;
  const a = parseInt(m[1]!, 10);
  let i = at + 1;
  interface BL {
    kind: 'ctx' | 'old' | 'new' | 'bs';
    text: string;
    empty: boolean;
  }
  const body: BL[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', empty: true });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), empty: false });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), empty: false });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), empty: false });
      i++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1), empty: false });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: -1 });
  }
  let lastCtxNew = -1;
  let lastPlus = -1;
  body.forEach((b, k) => {
    if (b.kind === 'ctx' || b.kind === 'new') lastCtxNew = k;
    if (b.kind === 'new') lastPlus = k;
  });
  const noEol = lastCtxNew >= 0 && body[lastCtxNew + 1] !== undefined && body[lastCtxNew + 1]!.kind === 'bs';
  const lastPlusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.kind === 'bs';
  return { hunk: { a, O, N, noEol, hasPlus: lastPlus >= 0, lastPlusNoEol }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let sec: Section | null = null;
  let inHeader = false;
  const newSection = (gitOld: string | null, gitNew: string | null): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: null,
    renameNew: null,
    gitOld,
    gitNew,
    create: false,
    del: false,
    hunks: [],
  });
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (sec === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        sec = newSection(m[1]!, m[2]!);
        inHeader = true;
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = newSection(null, null);
        inHeader = true;
        continue; // let the header consume the pair
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec.pairOld !== undefined) {
            sections.push(sec);
            sec = null;
            continue; // a second pair starts a new section
          }
          sec.pairOld = diffPath(line.slice(4));
          sec.pairNew = diffPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        sec.renameOld = line.slice('rename from '.length);
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameNew = line.slice('rename to '.length);
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const r = parseHunk(lines, i);
        sec.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        sections.push(sec);
        sec = null;
        continue; // re-process as a new section
      }
      i++; // any other header line is ignored
      continue;
    }
    // after the first hunk
    if (line.startsWith('@@')) {
      if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      sections.push(sec);
      sec = null;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sections.push(sec);
      sec = null;
      continue;
    }
    i++; // prose outside bodies
  }
  if (sec !== null) sections.push(sec);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let s = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const { tier, pos } = occurrences(s.lines, h.O, 0, strict);
      if (pos.length === 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = pos[0]!;
      for (const p of pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.O.length === s.lines.length;
      const nw = renderN(s.lines, best, tier, h.O, h.N);
      s.lines = [...s.lines.slice(0, best), ...nw, ...s.lines.slice(best + h.O.length)];
      if (atEnd) s.final = !h.noEol;
    } else {
      const at = Math.max(0, Math.min(h.a + d, s.lines.length));
      const atEnd = at === s.lines.length;
      const ins = h.N.map((x) => x.text);
      s.lines = [...s.lines.slice(0, at), ...ins, ...s.lines.slice(at)];
      if (atEnd) s.final = !h.noEol;
    }
    d += h.N.length - h.O.length;
  }
  return joinFile(s);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : (sec.renameOld ?? sec.gitOld);
  const newP = sec.pairNew !== undefined ? sec.pairNew : (sec.renameNew ?? sec.gitNew);
  const isCreate = sec.create || oldP === null;
  const isDelete = sec.del || newP === null;
  return (tree) => {
    if (isCreate && newP === null) return; // both /dev/null: nothing to do
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const x of h.N) if (x.ctx < 0) plus.push(x.text);
      }
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.hasPlus) {
          noEol = h.lastPlusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(cur, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sLine = i;
    let path: string | null = null;
    for (let j = sLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sLine + 1}`);
    let eq = -1;
    for (let j = sLine + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sLine + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rp < 0) throw new Exit2(`error: parse ${sLine + 1}`);
    const old = lines.slice(sLine + 1, eq);
    const nw = lines.slice(eq + 1, rp);
    edits.push(srEdit(path, old, nw, strict));
    prevPath = path;
    prevEnd = rp;
    i = rp + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const s = splitFile(cur);
    const { tier, pos } = occurrences(s.lines, old, 0, strict);
    if (pos.length === 0) throw new Fail('no-match', path);
    if (pos.length > 1) throw new Fail('ambiguous', path);
    const at = pos[0]!;
    const rendered = renderN(s.lines, at, tier, old, nw.map((t) => ({ text: t, ctx: -1 })));
    s.lines = [...s.lines.slice(0, at), ...rendered, ...s.lines.slice(at + old.length)];
    tree.now.set(path, joinFile(s));
  };
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface Chunk {
  anchor: string;
  O: string[];
  N: NLine[];
  eof: boolean;
}

/** A section's lines (with 1-based numbers) up to the next section or `*** End Patch`; trailing blanks trimmed. */
function collectV4ASection(lines: string[], start: number, last: number): { body: { text: string; num: number }[]; next: number } {
  let end = last;
  for (let k = start; k < last; k++) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      end = k;
      break;
    }
  }
  const body: { text: string; num: number }[] = [];
  for (let k = start; k < end; k++) body.push({ text: lines[k]!, num: k + 1 });
  while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
  return { body, next: end };
}

function parseUpdateBody(body: { text: string; num: number }[], updateNum: number): { moveTo: string | null; chunks: Chunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let started = false;
  for (; idx < body.length; idx++) {
    const { text, num } = body[idx]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), O: [], N: [], eof: false };
      started = true;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: '', O: [], N: [], eof: false };
        started = true;
      }
      if (text === '') {
        cur.O.push('');
        cur.N.push({ text: '', ctx: cur.O.length - 1 });
      } else if (text[0] === ' ') {
        cur.O.push(text.slice(1));
        cur.N.push({ text: text.slice(1), ctx: cur.O.length - 1 });
      } else if (text[0] === '-') cur.O.push(text.slice(1));
      else cur.N.push({ text: text.slice(1), ctx: -1 });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
  return { moveTo, chunks };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, body: { text: string; num: number }[], updateNum: number, strict: boolean): Edit {
  const { moveTo, chunks } = parseUpdateBody(body, updateNum);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const s = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const found = occurrences(s.lines, [ch.anchor], cursor, strict);
        if (found.pos.length === 0) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? s.lines.length : cursor;
        const ins = ch.N.map((x) => x.text);
        s.lines = [...s.lines.slice(0, at), ...ins, ...s.lines.slice(at)];
        cursor = at + ins.length;
      } else {
        const { tier, pos } = occurrences(s.lines, ch.O, cursor, strict);
        const occ = ch.eof ? pos.filter((p) => p + ch.O.length === s.lines.length) : pos;
        if (occ.length === 0) throw new Fail('no-match', path);
        const at = occ[0]!;
        const rendered = renderN(s.lines, at, tier, ch.O, ch.N);
        s.lines = [...s.lines.slice(0, at), ...rendered, ...s.lines.slice(at + ch.O.length)];
        cursor = at + rendered.length;
      }
    }
    const out = joinFile(s);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { body, next } = collectV4ASection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { body, next } = collectV4ASection(lines, i + 1, last);
      for (const b of body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.num}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const { body, next } = collectV4ASection(lines, i + 1, last);
      edits.push(v4aUpdateEdit(path, body, i + 1, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}


/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Display rows: a successful move whose old path existed before and is gone after, and whose new path
  // did not exist before and does after, prints one `R old -> new` line (sorted by the new path) instead
  // of its `D` and `A` lines; every other changed path prints `A` / `D` / `M`.
  const display: { key: string; text: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.now.get(mv.old) === null && tree.original(mv.nw) === null && tree.now.get(mv.nw) !== null) {
      display.push({ key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
      rOld.add(mv.old);
      rNew.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    display.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  display.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = display.map((d) => d.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
