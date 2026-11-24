// mend: one patch tool for every AI edit format (MIT). SPEC.md is the contract this file implements:
// unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, matched at three tiers, all-or-nothing writes.
// Node 22 and its standard library alone; run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to runner.ts
// (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Exit 2 with one line. */
class Stop {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One edit failed with a code and the path it concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- text helpers

const isBlank = (s: string): boolean => /^\s*$/.test(s);
const stripSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  for (let i = 0; i < out.length; i++) if (out[i]!.endsWith('\r')) out[i] = out[i]!.slice(0, -1);
  return out;
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

/** A file's text as lines, its break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ---------------------------------------------------------------- the tree

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  orig(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.orig(p);
  }
}

interface Ctx {
  tree: Tree;
  strict: boolean;
  moves: [string, string][];
}

type Edit = (ctx: Ctx) => void;

function needSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafe(p)) throw new EditFail('unsafe', p);
}

function needFile(ctx: Ctx, p: string): string {
  const t = ctx.tree.get(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

function needAbsent(ctx: Ctx, p: string): void {
  if (ctx.tree.get(p) !== null) throw new EditFail('exists', p);
}

// ---------------------------------------------------------------- matching (section 5)

const TIERS: ((s: string) => string)[] = [(s) => s, trimEndWs, trimWs];

/** Positions of `old` in `lines` at the first tier with any, considering only positions accepted by `ok`. */
function locate(lines: string[], old: string[], strict: boolean, ok: (pos: number) => boolean = () => true): { tier: number; at: number[] } | null {
  const tiers = strict ? 1 : 3;
  for (let t = 0; t < tiers; t++) {
    const norm = TIERS[t]!;
    const fileN = lines.map(norm);
    const oldN = old.map(norm);
    const at: number[] = [];
    for (let i = 0; i + oldN.length <= fileN.length; i++) {
      if (!ok(i)) continue;
      let hit = true;
      for (let j = 0; j < oldN.length; j++) {
        if (fileN[i + j] !== oldN[j]) {
          hit = false;
          break;
        }
      }
      if (hit) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** A line of N: its text, and for a context line the index of the O line it stands for. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines that replace the k matched lines at `pos`. */
function replacement(lines: string[], pos: number, old: string[], neu: NewLine[], tier: number): string[] {
  const F = old.length > 0 ? leadWs(lines[pos]!) : '';
  const P = old.length > 0 ? leadWs(old[0]!) : '';
  return neu.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier === 2 && !isBlank(n.text) && n.text.startsWith(P)) return F + n.text.slice(P.length);
    return n.text;
  });
}

// ---------------------------------------------------------------- format detection (section 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first === undefined) return null;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const c = first.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noEol: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  git: [string, string] | null;
  pair: boolean;
  oldPath: string | null;
  newPath: string | null;
  oldNull: boolean;
  newNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function diffPath(line: string): { path: string; none: boolean } {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = stripSpaces(rest);
  if (rest === '/dev/null') return { path: rest, none: true };
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return { path: rest, none: false };
}

function parseGitLine(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  // Prefer the split that makes both sides the same path; else the first " b/".
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half)) {
    const x = rest.slice(0, half);
    const y = rest.slice(half + 1);
    if (rest[half] === ' ' && y.startsWith('b/') && x.slice(2) === y.slice(2) && x.length > 2) return [x.slice(2), y.slice(2)];
  }
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const x = rest.slice(2, k);
  const y = rest.slice(k + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
  const fresh = (git: [string, string] | null): Section => ({
    git,
    pair: false,
    oldPath: null,
    newPath: null,
    oldNull: false,
    newNull: false,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = parseGitLine(l);
      if (g === null) throw new Stop(`error: parse ${i + 1}`);
      cur = fresh(g);
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (pairAt(i)) {
      if (!(cur !== null && inHeader && !cur.pair)) {
        cur = fresh(null);
        sections.push(cur);
        inHeader = true;
      }
      const o = diffPath(l);
      const n = diffPath(lines[i + 1]!);
      cur.pair = true;
      cur.oldPath = o.path;
      cur.oldNull = o.none;
      cur.newPath = n.path;
      cur.newNull = n.none;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null || cur === null) throw new Stop(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        if (b === '') body.push({ kind: ' ', text: '', noEol: false });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+') body.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noEol: false });
        else if (b[0] === '\\') {
          if (body.length > 0) body[body.length - 1]!.noEol = true;
          body.push({ kind: '\\' as ' ', text: '', noEol: false });
        } else break;
        j++;
      }
      // Trailing empty lines are not part of the body.
      let end = j;
      while (end > i + 1 && lines[end - 1] === '') end--;
      const kept = body.slice(0, end - (i + 1)).filter((b) => (b.kind as string) !== '\\');
      cur.hunks.push({ a: Number(m[1]), body: kept });
      i = end;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Stop(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameFrom = stripSpaces(l.slice('rename from '.length));
      else if (l.startsWith('rename to ')) cur.renameTo = stripSpaces(l.slice('rename to '.length));
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i++;
  }
  return sections.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  let oldP: string | null;
  let newP: string | null;
  let oldNull = false;
  let newNull = false;
  if (s.pair) {
    oldP = s.oldPath;
    newP = s.newPath;
    oldNull = s.oldNull;
    newNull = s.newNull;
  } else {
    oldP = s.renameFrom ?? s.git?.[0] ?? null;
    newP = s.renameTo ?? s.git?.[1] ?? null;
  }
  if (s.renameFrom !== null && s.pair === false) oldP = s.renameFrom;
  if (s.renameTo !== null && s.pair === false) newP = s.renameTo;
  if (oldP === null) oldP = newP;
  if (newP === null) newP = oldP;
  const creation = oldNull || s.isNew;
  const deletion = !creation && (newNull || s.isDeleted);
  const oldPath = oldP ?? '';
  const newPath = newP ?? '';
  return (ctx) => {
    const tree = ctx.tree;
    if (creation) {
      needSafe(newPath);
      needAbsent(ctx, newPath);
      const add: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            add.push(b.text);
            noEol = b.noEol;
          }
        }
      }
      tree.now.set(newPath, writeDoc({ lines: add, br: '\n', final: !noEol }));
      return;
    }
    if (deletion) {
      needSafe(oldPath);
      needFile(ctx, oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const moving = oldPath !== newPath;
    needSafe(oldPath);
    if (moving) needSafe(newPath);
    const text = needFile(ctx, oldPath);
    if (moving) needAbsent(ctx, newPath);
    const doc = readDoc(text);
    let d = 0;
    for (const h of s.hunks) applyHunk(ctx, doc, h, d, oldPath), (d += hunkDelta(h));
    const out = writeDoc(doc);
    if (moving) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      ctx.moves.push([oldPath, newPath]);
    } else tree.now.set(oldPath, out);
  };
}

function hunkDelta(h: Hunk): number {
  let n = 0;
  for (const b of h.body) if (b.kind === '+') n++;
  else if (b.kind === '-') n--;
  return n;
}

function applyHunk(ctx: Ctx, doc: Doc, h: Hunk, d: number, path: string): void {
  const old: string[] = [];
  const neu: NewLine[] = [];
  let lastNew: BodyLine | null = null;
  for (const b of h.body) {
    if (b.kind === ' ') {
      neu.push({ text: b.text, ctx: old.length });
      old.push(b.text);
      lastNew = b;
    } else if (b.kind === '-') old.push(b.text);
    else {
      neu.push({ text: b.text, ctx: -1 });
      lastNew = b;
    }
  }
  const lines = doc.lines;
  let pos: number;
  let tier = 0;
  if (old.length === 0) {
    pos = Math.max(0, Math.min(lines.length, h.a + d));
  } else {
    const found = locate(lines, old, ctx.strict);
    if (found === null) throw new EditFail('no-match', path);
    tier = found.tier;
    const target = h.a - 1 + d;
    pos = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const toEnd = pos + old.length === lines.length;
  const rep = replacement(lines, pos, old, neu, tier);
  lines.splice(pos, old.length, ...rep);
  if (toEnd) doc.final = !(lastNew !== null && lastNew.noEol);
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const search = i;
    let path: string | null = null;
    for (let k = search - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Stop(`error: parse ${search + 1}`);
    let sep = -1;
    for (let k = search + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (end < 0) throw new Stop(`error: parse ${search + 1}`);
    edits.push(srEdit(path, lines.slice(search + 1, sep), lines.slice(sep + 1, end)));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, old: string[], neu: string[]): Edit {
  return (ctx) => {
    needSafe(path);
    if (old.length === 0) {
      needAbsent(ctx, path);
      ctx.tree.now.set(path, writeDoc({ lines: neu.slice(), br: '\n', final: true }));
      return;
    }
    const doc = readDoc(needFile(ctx, path));
    const found = locate(doc.lines, old, ctx.strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.at[0]!;
    const rep = replacement(
      doc.lines,
      pos,
      old,
      neu.map((t) => ({ text: t, ctx: -1 })),
      found.tier,
    );
    doc.lines.splice(pos, old.length, ...rep);
    ctx.tree.now.set(path, writeDoc(doc));
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) if (!isBlank(lines[k]!)) {
    first = k;
    break;
  }
  if (first < 0) throw new Stop('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Stop(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!isBlank(lines[k]!)) {
    last = k;
    break;
  }
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Stop(`error: parse ${lines.length + 1}`);

  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOVE = '*** Move to: ';
  const isHead = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (!isHead(l)) throw new Stop(`error: parse ${i + 1}`);
    const head = i;
    let j = i + 1;
    while (j < last && !isHead(lines[j]!)) j++;
    let end = j;
    while (end > head + 1 && isBlank(lines[end - 1]!)) end--;
    if (l.startsWith(ADD)) {
      const path = stripSpaces(l.slice(ADD.length));
      const content: string[] = [];
      for (let k = head + 1; k < end; k++) {
        const b = lines[k]!;
        if (b === '') content.push('');
        else if (b[0] === '+') content.push(b.slice(1));
        else throw new Stop(`error: parse ${k + 1}`);
      }
      edits.push((ctx) => {
        needSafe(path);
        needAbsent(ctx, path);
        ctx.tree.now.set(path, writeDoc({ lines: content, br: '\n', final: true }));
      });
    } else if (l.startsWith(DEL)) {
      const path = stripSpaces(l.slice(DEL.length));
      if (end > head + 1) throw new Stop(`error: parse ${head + 2}`);
      edits.push((ctx) => {
        needSafe(path);
        needFile(ctx, path);
        ctx.tree.now.set(path, null);
      });
    } else {
      const path = stripSpaces(l.slice(UPD.length));
      let k = head + 1;
      let moveTo: string | null = null;
      if (k < end && lines[k]!.startsWith(MOVE)) {
        moveTo = stripSpaces(lines[k]!.slice(MOVE.length));
        k++;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; k < end; k++) {
        const b = lines[k]!;
        if (b.startsWith('@@')) {
          const a = stripSpaces(b.slice(2));
          open = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(open);
        } else if (b.trim() === '*** End of File') {
          if (open === null) {
            if (chunks.length > 0) throw new Stop(`error: parse ${k + 1}`);
            open = { anchor: null, eof: false, body: [] };
            chunks.push(open);
          }
          open.eof = true;
          open = null;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw new Stop(`error: parse ${k + 1}`);
            open = { anchor: null, eof: false, body: [] };
            chunks.push(open);
          }
          open.body.push(b === '' ? { kind: ' ', text: '', noEol: false } : { kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noEol: false });
        } else throw new Stop(`error: parse ${k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Stop(`error: parse ${head + 1}`);
      edits.push(v4aUpdate(path, moveTo, chunks));
    }
    i = j;
  }
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return (ctx) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const text = needFile(ctx, path);
    const moving = moveTo !== null && moveTo !== path;
    if (moveTo !== null && moveTo !== path) needAbsent(ctx, moveTo);
    if (moveTo !== null && moveTo === path) throw new EditFail('exists', moveTo);
    const doc = readDoc(text);
    const lines = doc.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const anchor = c.anchor;
        let hit = -1;
        const tiers = ctx.strict ? 1 : 3;
        for (let t = 0; t < tiers && hit < 0; t++) {
          const norm = TIERS[t]!;
          const want = norm(anchor);
          for (let x = cursor; x < lines.length; x++) {
            if (norm(lines[x]!) === want) {
              hit = x;
              break;
            }
          }
        }
        if (hit < 0) throw new EditFail('no-match', path);
        cursor = hit + 1;
      }
      const old: string[] = [];
      const neu: NewLine[] = [];
      for (const b of c.body) {
        if (b.kind === ' ') {
          neu.push({ text: b.text, ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else neu.push({ text: b.text, ctx: -1 });
      }
      if (old.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const rep = neu.map((n) => n.text);
        lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const from = cursor;
      const found = locate(lines, old, ctx.strict, (p) => p >= from && (!c.eof || p + old.length === lines.length));
      if (found === null) throw new EditFail('no-match', path);
      const pos = found.at[0]!;
      const rep = replacement(lines, pos, old, neu, found.tier);
      lines.splice(pos, old.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = writeDoc(doc);
    if (moving) {
      ctx.tree.now.set(path, null);
      ctx.tree.now.set(moveTo!, out);
      ctx.moves.push([path, moveTo!]);
    } else ctx.tree.now.set(path, out);
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  switch (o.command) {
    case 'create': {
      if (typeof o.file_text !== 'string') return null;
      const body = o.file_text;
      return (ctx) => {
        needSafe(path);
        needAbsent(ctx, path);
        ctx.tree.now.set(path, body);
      };
    }
    case 'str_replace': {
      if (typeof o.old_str !== 'string' || o.old_str === '') return null;
      if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
      const from = o.old_str;
      const to = (o.new_str as string | undefined) ?? '';
      return (ctx) => {
        needSafe(path);
        const text = needFile(ctx, path);
        const crlf = readDoc(text).br === '\r\n';
        const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = lf(text);
        const a = lf(from);
        const first = t.indexOf(a);
        if (first < 0) throw new EditFail('no-match', path);
        if (t.indexOf(a, first + 1) >= 0) throw new EditFail('ambiguous', path);
        const out = t.slice(0, first) + lf(to) + t.slice(first + a.length);
        ctx.tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
      };
    }
    case 'insert': {
      const at = o.insert_line;
      if (typeof at !== 'number' || !Number.isInteger(at) || typeof o.new_str !== 'string') return null;
      const add = splitPatch(o.new_str);
      return (ctx) => {
        needSafe(path);
        const doc = readDoc(needFile(ctx, path));
        if (at < 0 || at > doc.lines.length) throw new EditFail('no-match', path);
        doc.lines.splice(at, 0, ...add);
        ctx.tree.now.set(path, writeDoc(doc));
      };
    }
    default:
      return null;
  }
}

function parseJson(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) if (!isBlank(lines[k]!)) {
    first = k;
    break;
  }
  if (first < 0) throw new Stop('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    const fault = new Stop(`error: parse ${first + 1}`);
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw fault;
    }
    if (!Array.isArray(v)) throw fault;
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw fault;
      edits.push(e);
    }
    return edits;
  }
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k]!)) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(lines[k]!));
    } catch {
      e = null;
    }
    if (e === null) throw new Stop(`error: parse ${k + 1}`);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------- the command line (sections 1, 2, 10)

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function mend(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let optsDone = false;
  const positional: string[] = [];
  const usage = { code: 2, out: ['error: usage'] };
  for (const arg of argv) {
    if (!optsDone && arg === '--') {
      optsDone = true;
      continue;
    }
    if (!optsDone && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const name = arg.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(name)) return usage;
        format = name;
      } else if (arg === '--check') {
        if (check) return usage;
        check = true;
      } else if (arg === '--strict') {
        if (strict) return usage;
        strict = true;
      } else return usage;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return usage;
  const source = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  if (source === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(source, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else if (kind === 'v4a') edits = parseV4A(lines);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new Stop('error: parse 1');
  } catch (e) {
    if (e instanceof Stop) return { code: 2, out: [e.line] };
    throw e;
  }

  const ctx: Ctx = { tree: new Tree(), strict, moves: [] };
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(ctx.tree.now);
    const savedMoves = ctx.moves.length;
    try {
      edit(ctx);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      ctx.tree.now.clear();
      for (const [k, v] of savedNow) ctx.tree.now.set(k, v);
      ctx.moves.length = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  const tree = ctx.tree;
  const rows = new Map<string, string>();
  for (const [p, after] of tree.now) {
    const was = tree.orig(p);
    if (was === after) continue;
    rows.set(p, `${was === null ? 'A' : after === null ? 'D' : 'M'} ${p}`);
  }
  for (const [from, to] of ctx.moves) {
    if (tree.orig(from) !== null && tree.now.get(from) === null && tree.orig(to) === null && tree.get(to) !== null) {
      if (rows.get(from)?.startsWith('D ') && rows.get(to)?.startsWith('A ')) {
        rows.delete(from);
        rows.set(to, `R ${from} -> ${to}`);
      }
    }
  }
  const keys = [...rows.keys()].sort(byteOrder);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.orig(p);
      const after = tree.now.get(p)!;
      if (was === after) continue;
      if (after === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.orig(p);
      const after = tree.now.get(p)!;
      if (was === after || after === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, after);
    }
  }
  return { code: 0, out: [...keys.map((k) => rows.get(k)!), `ok: ${keys.length} ${keys.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = mend(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
