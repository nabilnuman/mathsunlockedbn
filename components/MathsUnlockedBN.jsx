"use client";
import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, X as XIcon, Trophy, RotateCcw, Pencil, Settings, ClipboardCheck, Instagram, Users } from "lucide-react";
import { storage } from "../lib/storage";
import {
  signInOrRegister, signOut, currentUser, getLeaderboard, getParentView,
  addRecoveryEmail, sendPinReset, completePinReset, onPasswordRecovery,
  teacherResetPin, changePin,
  sendFriendRequest, acceptFriend, removeFriend, loadFriendGraph,
  createBlitzChallenge, submitBlitzChallengeScore, loadBlitzChallenges, deleteBlitzChallenge,
} from "../lib/auth";
import { recognizeHandwriting, hasInk } from "../lib/handwriting";

// Email-based PIN recovery is off by default: Supabase's built-in mailer
// only delivers to your org's team members, so it can't reach students
// without a paid custom-SMTP domain. Set NEXT_PUBLIC_ENABLE_EMAIL_RECOVERY=1
// once real SMTP is configured. Teacher-run PIN reset (admin view) works
// regardless.
const EMAIL_RECOVERY = process.env.NEXT_PUBLIC_ENABLE_EMAIL_RECOVERY === "1";

/* ---------------------------------------------------------
   Tiny expression engine — lets a student type an answer in
   any equivalent form (2x+3, x/2, 0.5x, 7/12, 0.583...) and
   checks mathematical equivalence by evaluating both sides
   at several x values, rather than comparing text.
--------------------------------------------------------- */
function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (i < str.length && /[0-9.]/.test(str[i])) { num += str[i]; i++; }
      tokens.push({ type: "num", value: parseFloat(num) });
      continue;
    }
    if (c === "√") { tokens.push({ type: "op", value: "√" }); i++; continue; }
    if (c === "π") { tokens.push({ type: "num", value: Math.PI }); i++; continue; }
    if (str.slice(i, i + 4).toLowerCase() === "sqrt") { tokens.push({ type: "op", value: "√" }); i += 4; continue; }
    if (str.slice(i, i + 2).toLowerCase() === "pi") { tokens.push({ type: "num", value: Math.PI }); i += 2; continue; }
    if (c === "x" || c === "X" || c === "n" || c === "N") { tokens.push({ type: "var" }); i++; continue; } // one variable, spelled x or n
    if ("+-*/^()".includes(c)) { tokens.push({ type: "op", value: c }); i++; continue; }
    i++;
  }
  return tokens;
}
function insertImplicitMult(tokens) {
  const out = [];
  for (const t of tokens) {
    if (out.length) {
      const prev = out[out.length - 1];
      const prevEnd = prev.type === "num" || prev.type === "var" || (prev.type === "op" && prev.value === ")");
      const nextStart = t.type === "num" || t.type === "var" || (t.type === "op" && (t.value === "(" || t.value === "√"));
      if (prevEnd && nextStart) out.push({ type: "op", value: "*" });
    }
    out.push(t);
  }
  return out;
}
function parseExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function expr() {
    let left = term();
    while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = next().value;
      left = { op, left, right: term() };
    }
    return left;
  }
  function term() {
    let left = factor();
    while (peek() && peek().type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = next().value;
      left = { op, left, right: factor() };
    }
    return left;
  }
  function factor() {
    if (peek() && peek().type === "op" && peek().value === "-") { next(); return { op: "neg", left: factor() }; }
    return pow();
  }
  function pow() {
    let left = atom();
    if (peek() && peek().type === "op" && peek().value === "^") { next(); left = { op: "^", left, right: factor() }; }
    return left;
  }
  function atom() {
    const t = next();
    if (!t) throw new Error("unexpected end");
    if (t.type === "num") return { op: "num", value: t.value };
    if (t.type === "var") return { op: "var" };
    if (t.type === "op" && t.value === "(") { const e = expr(); next(); return e; }
    if (t.type === "op" && t.value === "√") { return { op: "sqrt", left: atom() }; }
    throw new Error("unexpected token");
  }
  return expr();
}
function evalNode(node, xVal) {
  switch (node.op) {
    case "num": return node.value;
    case "var": return xVal;
    case "neg": return -evalNode(node.left, xVal);
    case "+": return evalNode(node.left, xVal) + evalNode(node.right, xVal);
    case "-": return evalNode(node.left, xVal) - evalNode(node.right, xVal);
    case "*": return evalNode(node.left, xVal) * evalNode(node.right, xVal);
    case "/": return evalNode(node.left, xVal) / evalNode(node.right, xVal);
    case "^": return Math.pow(evalNode(node.left, xVal), evalNode(node.right, xVal));
    case "sqrt": return Math.sqrt(evalNode(node.left, xVal));
    default: return NaN;
  }
}
function evalString(str, xVal) {
  str = String(str)
    // display markup → plain math
    .replace(new RegExp(`${RAISE.a}${FR.a}([^${FR.b}]*)${FR.b}([^${FR.c}]*)${FR.c}${RAISE.b}`, "g"), "^(($1)/($2))")
    .replace(new RegExp(`${RAISE.a}([^${RAISE.b}]*)${RAISE.b}`, "g"), "^($1)")
    .replace(new RegExp(`${FR.a}([^${FR.b}]*)${FR.b}([^${FR.c}]*)${FR.c}`, "g"), "(($1)/($2))")
    .replace(/[×∙·]/g, "*").replace(/[÷⁄]/g, "/")
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => "₀₁₂₃₄₅₆₇₈₉".indexOf(c))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻ˣ]+/g, (m) => "^(" + m.replace(/./g, (c) => "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c) >= 0 ? "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c) : c === "⁻" ? "-" : c === "ˣ" ? "x" : c) + ")");
  const ast = parseExpr(insertImplicitMult(tokenize(str)));
  return evalNode(ast, xVal);
}
function checkEquivalent(studentStr, correctStr) {
  if (!studentStr || !studentStr.trim()) return false;
  try {
    const testVals = [1, 2, 3, -1, 0.5, 4.25];
    for (const xv of testVals) {
      const a = evalString(studentStr, xv);
      const b = evalString(correctStr, xv);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (Math.abs(a - b) > 1e-3 * Math.max(1, Math.abs(b))) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------
   All 30 topics, matching D MATHS 4024 checklist order.
   Each topic lists the prerequisite topic id(s) it "builds
   from" — a topic is locked until every prerequisite has
   been raised to at least rank C (see UNLOCK_RANK below).
--------------------------------------------------------- */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const spaced = (n) => (n >= 0 ? `+ ${n}` : `- ${Math.abs(n)}`);
const tight = (n) => (n >= 0 ? `+${n}` : `-${Math.abs(n)}`);
// Unicode super/subscripts for simple index notation (no "^" or "÷" shown).
const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", x: "ˣ" };
const sup = (v) => String(v).replace(/[-0-9x]/g, (c) => SUP[c] || c);
const pw = (p) => (p === 1 ? "" : sup(p)); // x¹ → x, else a superscript index
// A raised exponent that itself needs a stacked fraction — <MathText> lifts
// it and draws the fraction small (so 16^(1/2) doesn't read like "16 and a half").
const RAISE = { a: "", b: "" };
const raise = (s) => `${RAISE.a}${s}${RAISE.b}`;
const supFrac = (m, n) => (n == null ? sup(m) : raise(frac(m, n)));
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }
function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }
function roundToSF(num, sf) {
  if (num === 0) return 0;
  const mag = Math.pow(10, sf - Math.ceil(Math.log10(Math.abs(num))));
  return Math.round(num * mag) / mag;
}
// Parse a clock time in many forms → minutes since midnight, or null.
// "1435", "14:35", "2:35pm", "2.35 pm", "9", "9am" all accepted.
function parseClock(s) {
  s = String(s).trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, ":");
  const pm = /pm$/.test(s), am = /am$/.test(s);
  s = s.replace(/[ap]m$/, "");
  let h, mn;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { h = +m[1]; mn = +m[2]; }
  else if (/^\d{3,4}$/.test(s)) { const p = s.padStart(4, "0"); h = +p.slice(0, 2); mn = +p.slice(2); }
  else if (/^\d{1,2}$/.test(s)) { h = +s; mn = 0; }
  else return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}
// Parse a duration → total minutes, or null. Accepts "135", "2:15",
// "2h 15m", "2 hours 15 minutes", "2h", "15 min", "2 15".
function parseDuration(s) {
  s = String(s).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return +s;
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+)\s*h(?:r|rs|our|ours)?\s*(\d+)\s*(?:m|min|mins|minute|minutes)?$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?$/);
  if (m && (m[1] || m[2])) return (+(m[1] || 0)) * 60 + (+(m[2] || 0));
  m = s.match(/^(\d+)\s+(\d+)$/);
  if (m) return +m[1] * 60 + +m[2];
  return null;
}
// Parse a solved linear inequality → { op, val } with x isolated on the
// left. Accepts "x>2", "2<x", "-x >= -4", "2x<6", ">= <= ≥ ≤" etc.
function parseIneq(s) {
  s = String(s).trim().toLowerCase().replace(/\s+/g, "")
    .replace(/>=|=>|≥/g, "≥").replace(/<=|=<|≤/g, "≤");
  const m = s.match(/^(.+?)(≥|≤|>|<)(.+)$/);
  if (!m) return null;
  const flipOp = { ">": "<", "<": ">", "≥": "≤", "≤": "≥" };
  const evalN = (t) => { try { return evalString(t, 0); } catch (e) { return NaN; } };
  const coefOfX = (t) => {
    const mm = t.match(/^(-?\d*(?:\.\d+)?)x$/);
    return mm ? (mm[1] === "" ? 1 : mm[1] === "-" ? -1 : parseFloat(mm[1])) : null;
  };
  let o = m[2], k = coefOfX(m[1]), other = m[3], xLeft = true;
  if (k == null) { k = coefOfX(m[3]); other = m[1]; xLeft = false; }
  if (k == null || k === 0) return null;
  let val = evalN(other);
  if (!Number.isFinite(val)) return null;
  val /= k;
  if (k < 0) o = flipOp[o];
  if (!xLeft) o = flipOp[o];
  return { op: o, val };
}
// c√rad → { c, d } with d square-free (pull perfect squares out).
function surdParts(c, rad) {
  let d = rad;
  for (let f = 2; f * f <= d; f++) {
    while (d % (f * f) === 0) { d = d / (f * f); c *= f; }
  }
  return { c, d };
}
function surdStr(c, d) {
  if (d === 1) return `${c}`;
  if (c === 1) return `√${d}`;
  return `${c}√${d}`;
}
// A surd answer must be numerically right AND fully simplified: if it's
// written as k√m, m must be square-free (no perfect-square factor). Plain
// numbers / decimals just have to match on value.
function checkSimplifiedSurd(input, answer) {
  const s = String(input).replace(/\s|\*|·/g, "").replace(/sqrt/gi, "√").replace(/√\((\d+)\)/g, "√$1");
  const m = s.match(/^-?\d*√(\d+)$/);
  if (m) {
    const rad = parseInt(m[1], 10);
    for (let f = 2; f * f <= rad; f++) if (rad % (f * f) === 0) return false;
  }
  return checkEquivalent(input, answer);
}
// Answer left in index form: must be "<base>^<exp>" (or the superscript
// form) — not the evaluated number and not a rewritten base.
function checkIndexForm(input, base, exp) {
  let s = String(input).replace(/\s|\*|·/g, "");
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (mm) => "^" + mm.replace(/./g, (c) => (c === "⁻" ? "-" : "⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(c))));
  const m = s.match(/^(-?\d+)\^\(?(-?\d+)\)?$/);
  return !!m && Number(m[1]) === base && Number(m[2]) === exp;
}
// Standard form helpers. Accepts a*10^b, a×10^b, a x 10^b, aEb.
function parseSF(s) {
  const t = String(s).replace(/\s|,/g, "").replace(/×/g, "*").replace(/x10/gi, "*10");
  const m = t.match(/^(-?\d+(?:\.\d+)?)(?:\*10\^?|[eE])(-?\d+)$/);
  return m ? { mant: parseFloat(m[1]), exp: parseInt(m[2], 10) } : null;
}
function isStdForm(s, value) {
  const p = parseSF(s);
  if (!p) return false;
  const am = Math.abs(p.mant);
  return am >= 1 && am < 10 && Math.abs(p.mant * Math.pow(10, p.exp) - value) <= 1e-6 * Math.max(1, Math.abs(value));
}
function isOrdinary(s, value) {
  const t = String(s).replace(/\s|,/g, "");
  if (!t || /[\^]|×|x\s*10|\d[eE]-?\d/i.test(t)) return false;
  const n = parseFloat(t);
  return Number.isFinite(n) && Math.abs(n - value) <= 1e-6 * Math.max(1, Math.abs(value));
}
const sfString = (mant, exp) => `${Math.round(mant * 1e6) / 1e6}*10^${exp}`;
const sfPretty = (mant, exp) => `${Math.round(mant * 1e6) / 1e6} × 10${sup(exp)}`;
const pow10 = (exp) => `10${sup(exp)}`; // a bare power of 10, e.g. inside "3 × 10⁵ + 2 × 10³"

// "Instruction: expression" → drop the expression onto its own line so it
// doesn't wrap awkwardly mid-sum. No colon → the whole prompt is the lead.
function splitPrompt(prompt) {
  const p = prompt || "";
  // Split on a colon that follows a word character and precedes a space
  // (the "Instruction: expr" form). Leaves clock times like "6:23" and
  // spaced ratios like "AM : MB = 1 : 2" alone.
  const m = p.match(/\S: /);
  const i = m ? m.index + 1 : -1;
  if (i === -1 || i > p.length - 3) return { lead: p, expr: "" };
  return { lead: p.slice(0, i + 1).trim(), expr: p.slice(i + 1).trim() };
}

// Stacked-fraction markup. Generators emit frac("x + 3", "2") and <MathText>
// renders it as a numerator over a denominator with a bar, instead of "x/2".
// Delimiters are private-use code points so they never collide with real text.
const FR = { a: "", b: "", c: "" };
const frac = (num, den) => `${FR.a}${num}${FR.b}${den}${FR.c}`;
const FRAC_CHARS = [FR.a, FR.b, FR.c].join("");

// Vector over-arrow markup. Generators emit vov("AB") and <MathText> draws
// the letters with a left-to-right arrow above them (the AB with an arrow
// hat that exam papers use). Private-use delimiters, like frac.
const VEC = { a: "", b: "" };
const vov = (s) => `${VEC.a}${s}${VEC.b}`;

// "AB" (or any short label) with a small left-to-right arrow drawn above
// it — the arrow is absolutely positioned so it never changes line height.
function VecOver({ children }) {
  const n = Math.max(2, String(children).length);
  const w = (n * 0.64).toFixed(2);
  return (
    <span style={{ position: "relative", display: "inline-block", whiteSpace: "pre", verticalAlign: "baseline" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: "1.14em", display: "flex", justifyContent: "center", pointerEvents: "none" }}>
        <svg viewBox="0 0 24 6" width={`${w}em`} height={`${(w / 4).toFixed(2)}em`} style={{ display: "block", overflow: "visible" }}>
          <line x1="0.6" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M23.4 3 L18.7 0.7 L18.7 5.3 Z" fill="currentColor" />
        </svg>
      </span>
      {children}
    </span>
  );
}

function MathText({ text, style }) {
  const s = String(text ?? "");
  if (s.includes(VEC.a)) {
    const re = new RegExp(`${VEC.a}([^${VEC.a}${VEC.b}]*)${VEC.b}`, "g");
    const nodes = [];
    let last = 0, m, i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) nodes.push(s.slice(last, m.index));
      nodes.push(<VecOver key={i++}>{m[1]}</VecOver>);
      last = m.index + m[0].length;
    }
    if (last < s.length) nodes.push(s.slice(last));
    return <span style={{ whiteSpace: "pre-line", ...style }}>{nodes}</span>;
  }
  if (!s.includes(FR.a) && !s.includes(RAISE.a)) return <span style={{ whiteSpace: "pre-line", ...style }}>{s}</span>;

  // render a run that may contain stacked-fraction markup → array of nodes
  const fracNodes = (str, kb, small) => {
    if (!str.includes(FR.a)) return str ? [<span key={kb} style={{ whiteSpace: "pre-wrap" }}>{str}</span>] : [];
    const re = new RegExp(`${FR.a}([^${FR.a}${FR.b}${FR.c}]*)${FR.b}([^${FR.a}${FR.b}${FR.c}]*)${FR.c}`, "g");
    const out = [];
    let last = 0, m, k = 0;
    while ((m = re.exec(str))) {
      if (m.index > last) out.push(<span key={`${kb}-${k++}`} style={{ whiteSpace: "pre-wrap" }}>{str.slice(last, m.index)}</span>);
      out.push(
        <span key={`${kb}-${k++}`} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", verticalAlign: "middle", margin: small ? "0 2px" : "0 4px", textAlign: "center" }}>
          <span style={{ padding: small ? "0 3px" : "0 6px 1px" }}>{m[1]}</span>
          <span style={{ alignSelf: "stretch", padding: small ? "0 3px" : "1px 6px 0", borderTop: `${small ? 1 : 1.5}px solid currentColor` }}>{m[2]}</span>
        </span>
      );
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push(<span key={`${kb}-${k++}`} style={{ whiteSpace: "pre-wrap" }}>{str.slice(last)}</span>);
    return out;
  };

  // split on raised-exponent markup at the top level
  const raiseRe = new RegExp(`${RAISE.a}([^${RAISE.a}${RAISE.b}]*)${RAISE.b}`, "g");
  const nodes = [];
  let last = 0, m, i = 0;
  while ((m = raiseRe.exec(s))) {
    if (m.index > last) nodes.push(...fracNodes(s.slice(last, m.index), `p${i++}`, false));
    nodes.push(
      <sup key={`r${i++}`} style={{ display: "inline-flex", alignItems: "center", alignSelf: "flex-start", marginTop: "-0.35em", fontSize: "0.62em", lineHeight: 1, verticalAlign: "super" }}>
        {fracNodes(m[1], `s${i}`, true)}
      </sup>
    );
    last = m.index + m[0].length;
  }
  if (last < s.length) nodes.push(...fracNodes(s.slice(last), `p${i++}`, false));

  return <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", ...style }}>{nodes}</span>;
}

// Turn the plain `^(...)` / `(a)/(b)` syntax the answer parser (and the
// handwriting recogniser) both understand into the same private-use
// markup <MathText> renders — so a write-pad preview of "5^(5)" shows a
// real raised 5, and "(2)/(7)" shows as a stacked fraction, instead of
// the raw syntax. Recognises balanced parens, so a power inside a
// fraction (or vice versa) still nests correctly.
function prettyMathPreview(str) {
  const s = String(str ?? "");
  const n = s.length;
  const readParen = (start) => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") { depth--; if (depth === 0) return { inner: s.slice(start + 1, j), end: j + 1 }; }
    }
    return null; // unbalanced — leave as-is
  };
  let out = "", i = 0;
  while (i < n) {
    if (s[i] === "(") {
      const num = readParen(i);
      if (num && s[num.end] === "/" && s[num.end + 1] === "(") {
        const den = readParen(num.end + 1);
        if (den) { out += frac(prettyMathPreview(num.inner), prettyMathPreview(den.inner)); i = den.end; continue; }
      }
    }
    if (s[i] === "^" && s[i + 1] === "(") {
      const exp = readParen(i + 1);
      if (exp) { out += raise(prettyMathPreview(exp.inner)); i = exp.end; continue; }
    }
    out += s[i]; i++;
  }
  return out;
}

// A small coordinate grid with one straight line and two marked lattice
// points — used by the "read the equation off the graph" question.
function LineGraph({ data }) {
  const { m, c, marks = [] } = data;
  const R = 6, U = 20, O = 130;            // range ±6, 20px per unit, origin at 130
  const X = (x) => O + x * U;
  const Y = (y) => O - y * U;
  const grid = [];
  for (let i = -R; i <= R; i++) {
    if (i === 0) continue;
    grid.push(<line key={`v${i}`} x1={X(i)} y1={Y(-R)} x2={X(i)} y2={Y(R)} stroke="var(--grid)" strokeWidth="0.5" />);
    grid.push(<line key={`h${i}`} x1={X(-R)} y1={Y(i)} x2={X(R)} y2={Y(i)} stroke="var(--grid)" strokeWidth="0.5" />);
  }
  return (
    <svg viewBox="0 0 260 260" width="240" height="240" role="img" aria-label="line on a coordinate grid"
      style={{ maxWidth: "100%", display: "block", margin: "0 auto 14px" }}>
      <rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} fill="var(--card)" stroke="var(--grid)" />
      {grid}
      <line x1={X(-R)} y1={Y(0)} x2={X(R)} y2={Y(0)} stroke="var(--ink)" strokeWidth="1.2" />
      <line x1={X(0)} y1={Y(-R)} x2={X(0)} y2={Y(R)} stroke="var(--ink)" strokeWidth="1.2" />
      {[-4, -2, 2, 4].map((t) => (
        <g key={t}>
          <text x={X(t)} y={Y(0) + 11} fontSize="8" textAnchor="middle" fill="var(--muted)">{t}</text>
          <text x={X(0) - 5} y={Y(t) + 3} fontSize="8" textAnchor="end" fill="var(--muted)">{t}</text>
        </g>
      ))}
      <clipPath id="lg-clip"><rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} /></clipPath>
      <line x1={X(-R)} y1={Y(m * -R + c)} x2={X(R)} y2={Y(m * R + c)} stroke="var(--blue)" strokeWidth="2.4" clipPath="url(#lg-clip)" />
      {marks.map(([mx, my], i) => (
        <g key={i}>
          <circle cx={X(mx)} cy={Y(my)} r="3.4" fill="var(--red)" />
          <text x={X(mx) + (mx > 2 ? -6 : 6)} y={Y(my) + (my > 3 ? 12 : -6)} fontSize="9" fontWeight="700"
            textAnchor={mx > 2 ? "end" : "start"} fill="var(--ink)">({mx}, {my})</text>
        </g>
      ))}
    </svg>
  );
}

// The pre-drawn curve for "by drawing a suitable line, solve …" questions.
// kind: "parab" y = x² + a · "nparab" y = a − x² · "cubic" y = x³ + b·x
// · "recip" y = k/x (undefined at x = 0).
function curveFn(c) {
  if (!c) return null;
  if (c.kind === "nparab") return (x) => c.a - x * x;
  if (c.kind === "cubic") return (x) => x * x * x + (c.b || 0) * x;
  if (c.kind === "recip") return (x) => (Math.abs(x) < 1e-6 ? null : c.k / x);
  return (x) => x * x + (c.a || 0); // parab (default)
}

// Interactive grid for "draw the graph of y = …". The student taps
// lattice points; the last two define a line. `solution` (when set)
// overlays the correct line in green after the answer is checked.
// `curve` pre-draws a curve (see curveFn); `solvePoints` marks the
// intersection points in green once the answer is checked.
function DrawGraph({ points, solution, curve, solvePoints, onToggle }) {
  const R = 6, U = 19, O = 128;
  const X = (x) => O + x * U;
  const Y = (y) => O - y * U;
  const grid = [];
  for (let i = -R; i <= R; i++) {
    if (i === 0) continue;
    grid.push(<line key={`v${i}`} x1={X(i)} y1={Y(-R)} x2={X(i)} y2={Y(R)} stroke="var(--grid)" strokeWidth="0.5" />);
    grid.push(<line key={`h${i}`} x1={X(-R)} y1={Y(i)} x2={X(R)} y2={Y(i)} stroke="var(--grid)" strokeWidth="0.5" />);
  }
  const lineFor = (p, stroke, w) => {
    if (!p || p.length < 2) return null;
    const [[x1, y1], [x2, y2]] = p;
    if (x1 === x2) return <line x1={X(x1)} y1={Y(-R)} x2={X(x1)} y2={Y(R)} stroke={stroke} strokeWidth={w} clipPath="url(#dg-clip)" />;
    const m = (y2 - y1) / (x2 - x1), b = y1 - m * x1;
    return <line x1={X(-R)} y1={Y(m * -R + b)} x2={X(R)} y2={Y(m * R + b)} stroke={stroke} strokeWidth={w} clipPath="url(#dg-clip)" />;
  };
  const dots = [];
  for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) {
    const chosen = points.some(([px, py]) => px === x && py === y);
    dots.push(
      <circle key={`${x},${y}`} cx={X(x)} cy={Y(y)} r={chosen ? 4.5 : 8}
        fill={chosen ? "var(--blue)" : "transparent"} stroke={chosen ? "var(--card)" : "transparent"} strokeWidth={chosen ? 1.5 : 0}
        style={{ cursor: onToggle ? "pointer" : "default", pointerEvents: "all", WebkitTapHighlightColor: "transparent", outline: "none" }}
        onClick={() => onToggle && onToggle([x, y])} />
    );
  }
  return (
    <svg viewBox="0 0 256 256" width="248" height="248" role="img" aria-label="tap points to draw a line"
      style={{ maxWidth: "100%", display: "block", margin: "0 auto 8px", touchAction: "manipulation" }}>
      <rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} fill="var(--card)" stroke="var(--grid)" />
      {grid}
      <line x1={X(-R)} y1={Y(0)} x2={X(R)} y2={Y(0)} stroke="var(--ink)" strokeWidth="1.2" />
      <line x1={X(0)} y1={Y(-R)} x2={X(0)} y2={Y(R)} stroke="var(--ink)" strokeWidth="1.2" />
      {[-4, -2, 2, 4].map((t) => (
        <g key={t}>
          <text x={X(t)} y={Y(0) + 11} fontSize="8" textAnchor="middle" fill="var(--muted)">{t}</text>
          <text x={X(0) - 5} y={Y(t) + 3} fontSize="8" textAnchor="end" fill="var(--muted)">{t}</text>
        </g>
      ))}
      <clipPath id="dg-clip"><rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} /></clipPath>
      {curve && (() => {
        const f = curveFn(curve);
        const segs = [];
        let cur = [];
        for (let px = -R; px <= R + 1e-9; px += 0.1) {
          const y = f(px);
          if (y == null || !isFinite(y) || Math.abs(y) > R + 1.5) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
          cur.push(`${X(px)},${Y(y)}`);
        }
        if (cur.length > 1) segs.push(cur);
        return segs.map((s, i) => <polyline key={`cv${i}`} points={s.join(" ")} fill="none" stroke="var(--ink)" strokeWidth="2" clipPath="url(#dg-clip)" />);
      })()}
      {solution && lineFor(solution, "var(--green)", 3)}
      {lineFor(points, "var(--blue)", 2.4)}
      {dots}
      {points.map(([px, py], i) => (
        <circle key={`m${i}`} cx={X(px)} cy={Y(py)} r="4.5" fill="var(--blue)" stroke="var(--card)" strokeWidth="1.5" style={{ pointerEvents: "none" }} />
      ))}
      {(solvePoints || []).map(([px, py], i) => (
        <circle key={`s${i}`} cx={X(px)} cy={Y(py)} r="5" fill="var(--green)" stroke="var(--card)" strokeWidth="1.5" style={{ pointerEvents: "none" }} />
      ))}
    </svg>
  );
}

// Is (px,py) on the "greater / above / right" side of the boundary?
function regionAbove(reg, px, py) {
  if (reg.kind === "vert") return px > reg.k;
  if (reg.kind === "horiz") return py > reg.k;
  return py > reg.m * px + reg.c;
}
function regionSideCorrect(reg, px, py) {
  const ge = reg.op === ">" || reg.op === "≥";
  return regionAbove(reg, px, py) === ge;
}
function regionDist(reg, px, py) {
  if (reg.kind === "vert") return Math.abs(px - reg.k);
  if (reg.kind === "horiz") return Math.abs(py - reg.k);
  return Math.abs(py - (reg.m * px + reg.c)) / Math.sqrt(1 + reg.m * reg.m);
}

// A coordinate grid with one boundary line; the student taps a half-plane.
function RegionGraph({ line, picked, showAnswer, onPick }) {
  const R = 6, U = 19, O = 128, BIG = 400;
  const X = (x) => O + x * U;
  const Y = (y) => O - y * U;
  const grid = [];
  for (let i = -R; i <= R; i++) {
    if (i === 0) continue;
    grid.push(<line key={`v${i}`} x1={X(i)} y1={Y(-R)} x2={X(i)} y2={Y(R)} stroke="var(--grid)" strokeWidth="0.5" />);
    grid.push(<line key={`h${i}`} x1={X(-R)} y1={Y(i)} x2={X(R)} y2={Y(i)} stroke="var(--grid)" strokeWidth="0.5" />);
  }
  const polyFor = (above) => {
    let pts;
    const far = above ? BIG : -BIG;
    if (line.kind === "vert") pts = [[line.k, -BIG], [line.k, BIG], [far, BIG], [far, -BIG]];
    else if (line.kind === "horiz") pts = [[-BIG, line.k], [BIG, line.k], [BIG, far], [-BIG, far]];
    else pts = [[-BIG, line.m * -BIG + line.c], [BIG, line.m * BIG + line.c], [BIG, far], [-BIG, far]];
    return pts.map(([gx, gy]) => `${X(gx)},${Y(gy)}`).join(" ");
  };
  const pickedAbove = picked ? regionAbove(line, picked[0], picked[1]) : null;
  const correctAbove = line.op === ">" || line.op === "≥";
  const bs = { stroke: "var(--blue)", strokeWidth: 2.4, strokeLinecap: "round", clipPath: "url(#rg-clip)", strokeDasharray: line.solid ? undefined : "5 4" };
  return (
    <svg viewBox="0 0 256 256" width="248" height="248" role="img" aria-label="tap a region"
      style={{ maxWidth: "100%", display: "block", margin: "0 auto 8px", touchAction: "manipulation" }}>
      <rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} fill="var(--card)" stroke="var(--grid)" />
      <clipPath id="rg-clip"><rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} /></clipPath>
      {grid}
      {showAnswer && <polygon points={polyFor(correctAbove)} fill="var(--green)" fillOpacity="0.25" clipPath="url(#rg-clip)" />}
      {pickedAbove != null && <polygon points={polyFor(pickedAbove)} fill="var(--blue)" fillOpacity="0.18" clipPath="url(#rg-clip)" />}
      <line x1={X(-R)} y1={Y(0)} x2={X(R)} y2={Y(0)} stroke="var(--ink)" strokeWidth="1.2" />
      <line x1={X(0)} y1={Y(-R)} x2={X(0)} y2={Y(R)} stroke="var(--ink)" strokeWidth="1.2" />
      {[-4, -2, 2, 4].map((t) => (
        <g key={t}>
          <text x={X(t)} y={Y(0) + 11} fontSize="8" textAnchor="middle" fill="var(--muted)">{t}</text>
          <text x={X(0) - 5} y={Y(t) + 3} fontSize="8" textAnchor="end" fill="var(--muted)">{t}</text>
        </g>
      ))}
      {line.kind === "vert" && <line x1={X(line.k)} y1={Y(-R)} x2={X(line.k)} y2={Y(R)} {...bs} />}
      {line.kind === "horiz" && <line x1={X(-R)} y1={Y(line.k)} x2={X(R)} y2={Y(line.k)} {...bs} />}
      {line.kind === "diag" && <line x1={X(-R)} y1={Y(line.m * -R + line.c)} x2={X(R)} y2={Y(line.m * R + line.c)} {...bs} />}
      <rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} fill="transparent"
        style={{ cursor: onPick ? "crosshair" : "default", pointerEvents: "all", WebkitTapHighlightColor: "transparent", outline: "none", userSelect: "none" }}
        onClick={onPick ? (e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const vx = (e.clientX - b.left) / b.width * 256;
          const vy = (e.clientY - b.top) / b.height * 256;
          onPick((vx - O) / U, (O - vy) / U);
        } : undefined} />
    </svg>
  );
}

// Parse a vector / coordinate typed as "(3, -2)", "3,-2", "3 -2", "[3;-2]" …
function parseVec(s) {
  if (!s) return null;
  const m = String(s).replace(/[()[\]{}]/g, " ").match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

// A coordinate grid for Transformations: shape A (blue) and its image B
// (green), with optional mirror line / centre marker, or an interactive
// mode where the student taps three lattice points to place the image.
function TransformFigure({ a, b, mirror, centre, rays, tapPts, onTap, lineMode, showImage = true }) {
  const R = 8, U = 14, O = 128;
  const X = (x) => O + x * U;
  const Y = (y) => O - y * U;
  const grid = [];
  for (let i = -R; i <= R; i++) {
    if (i === 0) continue;
    grid.push(<line key={`v${i}`} x1={X(i)} y1={Y(-R)} x2={X(i)} y2={Y(R)} stroke="var(--grid)" strokeWidth="0.5" />);
    grid.push(<line key={`h${i}`} x1={X(-R)} y1={Y(i)} x2={X(R)} y2={Y(i)} stroke="var(--grid)" strokeWidth="0.5" />);
  }
  const halo = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3.2, strokeLinejoin: "round" };
  const poly = (pts) => pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ");
  const cen = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const mLine = mirror && (() => {
    if (mirror.kind === "x") return [[mirror.k, -R], [mirror.k, R]];
    if (mirror.kind === "y") return [[-R, mirror.k], [R, mirror.k]];
    if (mirror.kind === "yx") return [[-R, -R], [R, R]];
    return [[-R, R], [R, -R]]; // y = -x
  })();
  const dots = [];
  if (onTap) for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) {
    const chosen = (tapPts || []).some(([px, py]) => px === x && py === y);
    dots.push(<circle key={`d${x},${y}`} cx={X(x)} cy={Y(y)} r={chosen ? 4 : 6}
      fill={chosen ? "var(--blue)" : "transparent"} stroke={chosen ? "var(--card)" : "transparent"} strokeWidth={chosen ? 1.4 : 0}
      style={{ cursor: "pointer", pointerEvents: "all", WebkitTapHighlightColor: "transparent", outline: "none" }}
      onClick={() => onTap([x, y])} />);
  }
  const tapPoly = !lineMode && (tapPts || []).length === 3 ? tapPts : null;
  const tp = tapPts || [];
  const stLine = lineMode && tp.length === 2 && (tp[0][0] !== tp[1][0] || tp[0][1] !== tp[1][1]) && (() => {
    const [p, q] = tp;
    if (p[0] === q[0]) return [[p[0], -R], [p[0], R]];
    const m = (q[1] - p[1]) / (q[0] - p[0]), c = p[1] - m * p[0];
    return [[-R, m * -R + c], [R, m * R + c]];
  })();
  return (
    <svg viewBox="0 0 256 256" width="248" height="248" role="img" aria-label="transformation on a coordinate grid"
      style={{ maxWidth: "100%", display: "block", margin: "0 auto 8px", touchAction: "manipulation" }}>
      <rect x={X(-R)} y={Y(R)} width={2 * R * U} height={2 * R * U} fill="var(--card)" stroke="var(--grid)" />
      {grid}
      <line x1={X(-R)} y1={Y(0)} x2={X(R)} y2={Y(0)} stroke="var(--ink)" strokeWidth="1.2" />
      <line x1={X(0)} y1={Y(-R)} x2={X(0)} y2={Y(R)} stroke="var(--ink)" strokeWidth="1.2" />
      {[-6, -4, -2, 2, 4, 6].map((t) => (
        <g key={t}>
          <text x={X(t)} y={Y(0) + 10} fontSize="7.5" textAnchor="middle" fill="var(--muted)">{t}</text>
          <text x={X(0) - 4} y={Y(t) + 3} fontSize="7.5" textAnchor="end" fill="var(--muted)">{t}</text>
        </g>
      ))}
      {(rays || []).map(([p, q], i) => (
        <line key={`ray${i}`} x1={X(p[0])} y1={Y(p[1])} x2={X(q[0] + (q[0] - p[0]) * 0.12)} y2={Y(q[1] + (q[1] - p[1]) * 0.12)}
          stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
      ))}
      {mLine && <line x1={X(mLine[0][0])} y1={Y(mLine[0][1])} x2={X(mLine[1][0])} y2={Y(mLine[1][1])} stroke="var(--red)" strokeWidth="1.6" strokeDasharray="5 4" />}
      {stLine && <line x1={X(stLine[0][0])} y1={Y(stLine[0][1])} x2={X(stLine[1][0])} y2={Y(stLine[1][1])} stroke="var(--blue)" strokeWidth="2.4" strokeLinecap="round" />}
      <polygon points={poly(a)} fill="var(--blue)" fillOpacity="0.16" stroke="var(--blue)" strokeWidth="2" strokeLinejoin="round" />
      {(() => { const c = cen(a); return <text x={X(c[0])} y={Y(c[1])} fontSize="11" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--blue)" style={halo}>A</text>; })()}
      {b && showImage && (
        <>
          <polygon points={poly(b)} fill="var(--green)" fillOpacity="0.16" stroke="var(--green)" strokeWidth="2" strokeLinejoin="round" />
          {(() => { const c = cen(b); return <text x={X(c[0])} y={Y(c[1])} fontSize="11" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--green)" style={halo}>B</text>; })()}
        </>
      )}
      {centre && (
        <g>
          <line x1={X(centre[0]) - 5} y1={Y(centre[1]) - 5} x2={X(centre[0]) + 5} y2={Y(centre[1]) + 5} stroke="var(--ink)" strokeWidth="1.8" />
          <line x1={X(centre[0]) - 5} y1={Y(centre[1]) + 5} x2={X(centre[0]) + 5} y2={Y(centre[1]) - 5} stroke="var(--ink)" strokeWidth="1.8" />
        </g>
      )}
      {tapPoly && <polygon points={poly(tapPoly)} fill="var(--blue)" fillOpacity="0.14" stroke="var(--blue)" strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" />}
      {dots}
      {(tapPts || []).map(([px, py], i) => (
        <circle key={`m${i}`} cx={X(px)} cy={Y(py)} r="4" fill="var(--blue)" stroke="var(--card)" strokeWidth="1.4" style={{ pointerEvents: "none" }} />
      ))}
    </svg>
  );
}

// A piecewise motion graph (distance–time or speed–time). The generator
// produces round values that sit exactly on gridlines so the student can
// read every corner straight off the grid. One segment can be highlighted
// and an area beneath it shaded.
function MotionGraph({ pts, yLabel, xUnit, yUnit, highlight, shadeFrom, shadeTo, gridY, gridX }) {
  const W = 300, Hh = 232, ml = 44, mr = 14, mt = 12, mb = 34;
  const pw = W - ml - mr, ph = Hh - mt - mb;
  const yVals = pts.map((p) => p[1]), xVals = pts.map((p) => p[0]);
  const yStep = gridY || 1;
  const xStep = gridX || 1;
  const yMax = Math.ceil((Math.max(...yVals) + yStep * 0.5) / yStep) * yStep;
  const xMax = Math.max(...xVals);
  const X = (x) => ml + (x / xMax) * pw;
  const Y = (y) => mt + ph - (y / yMax) * ph;
  const mk = (max, step) => { const out = []; for (let v = step; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100); return out; };
  const xGrid = mk(xMax, xStep), yGrid = mk(yMax, yStep);
  const yLabelEvery = yGrid.length > 26 ? 5 : yGrid.length > 12 ? 2 : 1;
  const xLabelEvery = xGrid.length > 14 ? 2 : 1;
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" role="img" aria-label={`${yLabel} against time graph`}
      style={{ maxWidth: 340, display: "block", margin: "0 auto 10px" }}>
      <rect x={ml} y={mt} width={pw} height={ph} fill="var(--card)" stroke="var(--grid)" />
      {xGrid.map((t, i) => (
        <g key={`x${t}`}>
          <line x1={X(t)} y1={mt} x2={X(t)} y2={mt + ph} stroke="var(--grid)" strokeWidth="0.5" />
          {(i + 1) % xLabelEvery === 0 && <text x={X(t)} y={mt + ph + 12} fontSize="8" textAnchor="middle" fill="var(--muted)">{t}</text>}
        </g>
      ))}
      {yGrid.map((t, i) => (
        <g key={`y${t}`}>
          <line x1={ml} y1={Y(t)} x2={ml + pw} y2={Y(t)} stroke="var(--grid)" strokeWidth="0.5" />
          {(i + 1) % yLabelEvery === 0 && <text x={ml - 5} y={Y(t) + 3} fontSize="8" textAnchor="end" fill="var(--muted)">{t}</text>}
        </g>
      ))}
      {shadeFrom != null && (() => {
        const seg = pts.filter((p) => p[0] >= shadeFrom - 1e-9 && p[0] <= shadeTo + 1e-9);
        const poly = [`${X(shadeFrom)},${Y(0)}`, ...seg.map((p) => `${X(p[0])},${Y(p[1])}`), `${X(shadeTo)},${Y(0)}`].join(" ");
        return <polygon points={poly} fill="var(--blue)" fillOpacity="0.16" />;
      })()}
      <polyline points={pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} fill="none" stroke="var(--blue)" strokeWidth="2.4" strokeLinejoin="round" />
      {highlight && (
        <polyline points={[pts[highlight[0]], pts[highlight[1]]].map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}
          fill="none" stroke="var(--amber)" strokeWidth="3.4" strokeLinecap="round" />
      )}
      <text x={ml + pw / 2} y={Hh - 4} fontSize="8.5" textAnchor="middle" fill="var(--muted)">time ({xUnit})</text>
      <text x={11} y={mt + ph / 2} fontSize="8.5" textAnchor="middle" fill="var(--muted)" transform={`rotate(-90 11 ${mt + ph / 2})`}>{yLabel} ({yUnit})</text>
    </svg>
  );
}

// Monotone cubic (Fritsch–Carlson) interpolation through the class-boundary
// points, sampled densely so the ogive draws as a smooth curve that never
// dips (a cumulative total can only rise). Returns a fine [x, y] array.
function densifyOgive(pts, sub = 18) {
  const nP = pts.length;
  if (nP < 3) return pts.map((p) => [p[0], p[1]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const dx = [], slope = [];
  for (let i = 0; i < nP - 1; i++) { dx[i] = xs[i + 1] - xs[i]; slope[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  const m = [slope[0]];
  for (let i = 1; i < nP - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) { m[i] = 0; continue; }
    const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
    m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
  }
  m[nP - 1] = slope[nP - 2];
  for (let i = 0; i < nP - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * slope[i]; m[i + 1] = tau * b * slope[i]; }
  }
  const out = [];
  for (let i = 0; i < nP - 1; i++) {
    for (let s = 0; s < sub; s++) {
      const t = s / sub, h = dx[i];
      const h00 = (1 + 2 * t) * (1 - t) * (1 - t), h10 = t * (1 - t) * (1 - t);
      const h01 = t * t * (3 - 2 * t), h11 = t * t * (t - 1);
      out.push([xs[i] + t * h, h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]]);
    }
  }
  out.push([xs[nP - 1], ys[nP - 1]]);
  return out;
}

// A cumulative-frequency curve (ogive). The student can tap the x- or
// y-axis strip to drop a dashed guide line that runs to the curve and
// then across to the other axis — an aid for reading off medians and
// quartiles. The guide never prints the value it lands on. `picks` holds
// up to two guides ({ axis, v }). Fine minor gridlines let the student
// count along to whichever value a guide line lands on.
function CumFreqGraph({ points, xLabel, n, picks = [], onPick }) {
  const W = 320, Hh = 260, ml = 44, mr = 14, mt = 12, mb = 38;
  const pw = W - ml - mr, ph = Hh - mt - mb;
  const xMin = points[0][0], xMax = points[points.length - 1][0];
  const X = (x) => ml + ((x - xMin) / (xMax - xMin)) * pw;
  const Y = (y) => mt + ph - (y / n) * ph;
  const dense = densifyOgive(points);
  const f = (x) => {
    for (let i = 0; i < dense.length - 1; i++) {
      const [x0, y0] = dense[i], [x1, y1] = dense[i + 1];
      if (x >= x0 && x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1);
    }
    return x < xMin ? 0 : n;
  };
  const invF = (y) => {
    for (let i = 0; i < dense.length - 1; i++) {
      const [x0, y0] = dense[i], [x1, y1] = dense[i + 1];
      if (y >= y0 && y <= y1 && y1 > y0) return x0 + (x1 - x0) * (y - y0) / (y1 - y0);
    }
    return y <= 0 ? xMin : xMax;
  };
  const xStep = points[1][0] - points[0][0];
  const yTick = n % 10 === 0 ? n / 10 : n / 8;
  const xMinor = xStep >= 20 ? 5 : xStep >= 10 ? 2 : 1;
  const yMinor = yTick / 2;
  const snapX = Math.min(xMinor, xStep / 2);
  const range = (lo, hi, st) => Array.from({ length: Math.round((hi - lo) / st) + 1 }, (_, i) => +(lo + i * st).toFixed(4));
  const guides = picks.map((p) => {
    if (p.axis === "x") { const yv = f(p.v); return [[[p.v, 0], [p.v, yv]], [[p.v, yv], [xMin, yv]]]; }
    const xv = invF(p.v); return [[[xMin, p.v], [xv, p.v]], [[xv, p.v], [xv, 0]]];
  });
  const gl = (a, b) => <line x1={X(a[0])} y1={Y(a[1])} x2={X(b[0])} y2={Y(b[1])} stroke="var(--red)" strokeWidth="1.4" strokeDasharray="4 3" />;
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" role="img" aria-label="cumulative frequency graph"
      style={{ maxWidth: 360, display: "block", margin: "0 auto 8px", touchAction: "manipulation" }}>
      <rect x={ml} y={mt} width={pw} height={ph} fill="var(--card)" stroke="var(--grid)" />
      {range(xMin, xMax, xMinor).map((x) => <line key={`xm${x}`} x1={X(x)} y1={mt} x2={X(x)} y2={mt + ph} stroke="var(--grid)" strokeWidth="0.5" strokeOpacity="0.7" />)}
      {range(0, n, yMinor).map((y) => <line key={`ym${y}`} x1={ml} y1={Y(y)} x2={ml + pw} y2={Y(y)} stroke="var(--grid)" strokeWidth="0.5" strokeOpacity="0.7" />)}
      {range(xMin, xMax, xStep).map((x) => (
        <g key={`x${x}`}>
          <line x1={X(x)} y1={mt} x2={X(x)} y2={mt + ph} stroke="var(--grid)" strokeWidth="0.8" />
          <text x={X(x)} y={mt + ph + 12} fontSize="8" textAnchor="middle" fill="var(--muted)">{x}</text>
        </g>
      ))}
      {range(0, n, yTick).map((y) => (
        <g key={`y${y}`}>
          <line x1={ml} y1={Y(y)} x2={ml + pw} y2={Y(y)} stroke="var(--grid)" strokeWidth="0.8" />
          <text x={ml - 5} y={Y(y) + 3} fontSize="8" textAnchor="end" fill="var(--muted)">{y}</text>
        </g>
      ))}
      {guides.map((g, i) => <g key={`g${i}`}>{gl(...g[0])}{gl(...g[1])}</g>)}
      <polyline points={dense.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")} fill="none" stroke="var(--blue)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      <text x={ml + pw / 2} y={Hh - 4} fontSize="8.5" textAnchor="middle" fill="var(--muted)">{xLabel}</text>
      <text x={11} y={mt + ph / 2} fontSize="8.5" textAnchor="middle" fill="var(--muted)" transform={`rotate(-90 11 ${mt + ph / 2})`}>cumulative frequency</text>
      {onPick && (
        <>
          <rect x={ml} y={mt + ph} width={pw} height={mb} fill="transparent" style={{ cursor: "pointer" }}
            onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); const vx = (e.clientX - b.left) / b.width * pw; const raw = xMin + (vx / pw) * (xMax - xMin); onPick({ axis: "x", v: Math.max(xMin, Math.min(xMax, Math.round(raw / snapX) * snapX)) }); }} />
          <rect x={0} y={mt} width={ml} height={ph} fill="transparent" style={{ cursor: "pointer" }}
            onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); const vy = (e.clientY - b.top) / b.height * ph; const raw = (1 - vy / ph) * n; onPick({ axis: "y", v: Math.max(0, Math.min(n, Math.round(raw / yMinor) * yMinor)) }); }} />
        </>
      )}
    </svg>
  );
}

// Shapes and letters with their symmetry properties, for the Symmetry topic.
function regPoly(n, startDeg = -90, r = 1) {
  return Array.from({ length: n }, (_, i) => {
    const a = (startDeg + (i * 360) / n) * Math.PI / 180;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
}
function starPoly(n, startDeg = -90, ro = 1, ri = 0.42) {
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (startDeg + (i * 180) / n) * Math.PI / 180;
    const r = i % 2 === 0 ? ro : ri;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
// axis angles (deg) for a regular n-gon / n-point star drawn with `startDeg`
const regSym = (n, startDeg) => Array.from({ length: n }, (_, i) => startDeg + (i * 180) / n);
const SHAPES = {
  isotri: { label: "an isosceles triangle", lines: 1, rot: 1, sym: [90], p: [[0, -1], [0.85, 0.75], [-0.85, 0.75]] },
  eqtri: { label: "an equilateral triangle", lines: 3, rot: 3, sym: regSym(3, -90), p: regPoly(3, -90) },
  rect: { label: "a rectangle", lines: 2, rot: 2, sym: [0, 90], p: [[-1, -0.62], [1, -0.62], [1, 0.62], [-1, 0.62]] },
  square: { label: "a square", lines: 4, rot: 4, sym: [0, 45, 90, 135], p: [[-0.82, -0.82], [0.82, -0.82], [0.82, 0.82], [-0.82, 0.82]] },
  rhombus: { label: "a rhombus", lines: 2, rot: 2, sym: [0, 90], p: [[0, -1], [0.68, 0], [0, 1], [-0.68, 0]] },
  parallelogram: { label: "a parallelogram", lines: 0, rot: 2, sym: [], p: [[-0.95, -0.55], [0.5, -0.55], [0.95, 0.55], [-0.5, 0.55]] },
  kite: { label: "a kite", lines: 1, rot: 1, sym: [90], p: [[0, -1], [0.62, -0.15], [0, 1], [-0.62, -0.15]] },
  pentagon: { label: "a regular pentagon", lines: 5, rot: 5, sym: regSym(5, -90), p: regPoly(5, -90) },
  hexagon: { label: "a regular hexagon", lines: 6, rot: 6, sym: regSym(6, -90), p: regPoly(6, -90) },
  octagon: { label: "a regular octagon", lines: 8, rot: 8, sym: regSym(8, -112.5), p: regPoly(8, -112.5) },
  plus: { label: "a plus shape", lines: 4, rot: 4, sym: [0, 45, 90, 135], p: [[-0.3, -0.9], [0.3, -0.9], [0.3, -0.3], [0.9, -0.3], [0.9, 0.3], [0.3, 0.3], [0.3, 0.9], [-0.3, 0.9], [-0.3, 0.3], [-0.9, 0.3], [-0.9, -0.3], [-0.3, -0.3]] },
  arrow: { label: "an arrow", lines: 1, rot: 1, sym: [0], p: [[-0.9, -0.32], [0.15, -0.32], [0.15, -0.7], [0.9, 0], [0.15, 0.7], [0.15, 0.32], [-0.9, 0.32]] },
  lshape: { label: "an L-shape", lines: 0, rot: 1, sym: [], p: [[-0.6, -0.9], [-0.1, -0.9], [-0.1, 0.4], [0.7, 0.4], [0.7, 0.9], [-0.6, 0.9]] },
  tshape: { label: "a T-shape", lines: 1, rot: 1, sym: [90], p: [[-0.9, -0.9], [0.9, -0.9], [0.9, -0.35], [0.28, -0.35], [0.28, 0.9], [-0.28, 0.9], [-0.28, -0.35], [-0.9, -0.35]] },
  hletter: { label: "the letter H", lines: 2, rot: 2, sym: [0, 90], p: [[-0.7, -0.9], [-0.35, -0.9], [-0.35, -0.2], [0.35, -0.2], [0.35, -0.9], [0.7, -0.9], [0.7, 0.9], [0.35, 0.9], [0.35, 0.2], [-0.35, 0.2], [-0.35, 0.9], [-0.7, 0.9]] },
  iletter: { label: "the letter I", lines: 2, rot: 2, sym: [0, 90], p: [[-0.7, -0.9], [0.7, -0.9], [0.7, -0.55], [0.2, -0.55], [0.2, 0.55], [0.7, 0.55], [0.7, 0.9], [-0.7, 0.9], [-0.7, 0.55], [-0.2, 0.55], [-0.2, -0.55], [-0.7, -0.55]] },
  nletter: { label: "the letter N", lines: 0, rot: 2, sym: [], p: [[-0.7, -0.9], [-0.35, -0.9], [0.35, 0.35], [0.35, -0.9], [0.7, -0.9], [0.7, 0.9], [0.35, 0.9], [-0.35, -0.35], [-0.35, 0.9], [-0.7, 0.9]] },
  zletter: { label: "the letter Z", lines: 0, rot: 2, sym: [], p: [[-0.75, -0.9], [0.75, -0.9], [0.75, -0.5], [-0.2, 0.5], [0.75, 0.5], [0.75, 0.9], [-0.75, 0.9], [-0.75, 0.5], [0.2, -0.5], [-0.75, -0.5]] },
  star5: { label: "a five-pointed star", lines: 5, rot: 5, sym: regSym(5, -90), p: starPoly(5, -90, 1, 0.4) },
  star6: { label: "a six-pointed star", lines: 6, rot: 6, sym: regSym(6, -90), p: starPoly(6, -90, 1, 0.55) },
};
function ShapeFigure({ shape, showSym }) {
  const s = SHAPES[shape];
  const S = 56, O = 72;
  const pts = s.p.map(([x, y]) => `${(O + x * S).toFixed(1)},${(O + y * S).toFixed(1)}`).join(" ");
  const axes = showSym ? (s.sym || []) : [];
  const R = 66;
  return (
    <svg viewBox="0 0 144 144" width="150" height="150" role="img" aria-label={s.label}
      style={{ display: "block", margin: "0 auto 10px" }}>
      <polygon points={pts} fill="var(--blue)" fillOpacity="0.16" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      {axes.map((deg, i) => {
        const t = deg * Math.PI / 180, dx = Math.cos(t) * R, dy = Math.sin(t) * R;
        return <line key={i} x1={(O - dx).toFixed(1)} y1={(O - dy).toFixed(1)} x2={(O + dx).toFixed(1)} y2={(O + dy).toFixed(1)}
          stroke="var(--red)" strokeWidth="1.6" strokeDasharray="5 4" strokeLinecap="round" />;
      })}
    </svg>
  );
}

// A labelled figure for Mensuration — 2-D shapes and 3-D solids drawn
// schematically with their dimensions marked.
function MensurationFigure({ shape, dims = {} }) {
  const d = dims, W = 210, H = 152;
  const halo = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" };
  const L = (props) => <text fontSize="10" fontWeight="700" fill="var(--ink)" textAnchor="middle" dominantBaseline="middle" style={halo} {...props} />;
  const fill = { fill: "var(--blue)", fillOpacity: 0.14, stroke: "var(--ink)", strokeWidth: 1.8, strokeLinejoin: "round" };
  const face = { fill: "var(--blue)", fillOpacity: 0.07, stroke: "var(--ink)", strokeWidth: 1.8, strokeLinejoin: "round" };
  const dash = { stroke: "var(--muted)", strokeWidth: 1.2, strokeDasharray: "4 3", fill: "none" };
  const P = (x, y) => `${x},${y}`;
  let body = null;
  if (shape === "rect" || shape === "square") {
    const rw = 132, rh = shape === "square" ? 118 : 82, x0 = (W - rw) / 2, y0 = (H - rh) / 2 - 4;
    body = <>
      <rect x={x0} y={y0} width={rw} height={rh} {...fill} />
      <L x={x0 + rw / 2} y={y0 + rh + 15}>{shape === "square" ? `${d.s} cm` : `${d.l} cm`}</L>
      <L x={x0 - 18} y={y0 + rh / 2}>{shape === "square" ? `${d.s} cm` : `${d.w} cm`}</L>
    </>;
  } else if (shape === "triangle") {
    const bw = 150, th = 96, x0 = (W - bw) / 2, yb = H - 26, ax = x0 + bw * 0.36, ay = yb - th;
    body = <>
      <polygon points={`${x0},${yb} ${x0 + bw},${yb} ${ax},${ay}`} {...fill} />
      <line x1={ax} y1={ay} x2={ax} y2={yb} {...dash} />
      <rect x={ax} y={yb - 8} width="8" height="8" fill="none" stroke="var(--muted)" strokeWidth="1" />
      <L x={x0 + bw / 2} y={yb + 15}>{`${d.b} cm`}</L>
      <L x={ax + 16} y={(ay + yb) / 2}>{`${d.h} cm`}</L>
    </>;
  } else if (shape === "parallelogram") {
    const bw = 122, ph = 80, sk = 34, x0 = 26, yb = H - 22;
    body = <>
      <polygon points={`${x0},${yb} ${x0 + bw},${yb} ${x0 + bw + sk},${yb - ph} ${x0 + sk},${yb - ph}`} {...fill} />
      <line x1={x0 + sk} y1={yb - ph} x2={x0 + sk} y2={yb} {...dash} />
      <L x={x0 + bw / 2 + 8} y={yb + 15}>{`${d.b} cm`}</L>
      <L x={x0 + sk - 17} y={yb - ph / 2}>{`${d.h} cm`}</L>
    </>;
  } else if (shape === "trapezium") {
    const bw = 150, tw = 82, tp = 78, x0 = (W - bw) / 2, yb = H - 22, tx = x0 + (bw - tw) / 2;
    body = <>
      <polygon points={`${x0},${yb} ${x0 + bw},${yb} ${tx + tw},${yb - tp} ${tx},${yb - tp}`} {...fill} />
      <line x1={tx} y1={yb - tp} x2={tx} y2={yb} {...dash} />
      <L x={x0 + bw / 2} y={yb + 15}>{`${d.b} cm`}</L>
      <L x={tx + tw / 2} y={yb - tp - 12}>{`${d.a} cm`}</L>
      <L x={tx - 18} y={yb - tp / 2}>{`${d.h} cm`}</L>
    </>;
  } else if (shape === "cuboid") {
    const w = 100, h = 64, dp = 34, x0 = 30, y0 = 52;
    body = <>
      <polygon points={[P(x0, y0), P(x0 + dp, y0 - dp), P(x0 + w + dp, y0 - dp), P(x0 + w, y0)].join(" ")} {...face} />
      <polygon points={[P(x0 + w, y0), P(x0 + w + dp, y0 - dp), P(x0 + w + dp, y0 + h - dp), P(x0 + w, y0 + h)].join(" ")} {...face} />
      <rect x={x0} y={y0} width={w} height={h} {...fill} />
      <L x={x0 + w / 2} y={y0 + h + 15}>{`${d.l} cm`}</L>
      <L x={x0 - 17} y={y0 + h / 2}>{`${d.h} cm`}</L>
      <L x={x0 + w + dp / 2 + 12} y={y0 - dp / 2 - 4}>{`${d.w} cm`}</L>
    </>;
  } else if (shape === "cylinder") {
    const cx = W / 2, rx = 46, ry = 15, top = 28, bot = 122;
    body = <>
      <path d={`M ${cx - rx} ${top} L ${cx - rx} ${bot} A ${rx} ${ry} 0 0 0 ${cx + rx} ${bot} L ${cx + rx} ${top}`} {...fill} />
      <path d={`M ${cx - rx} ${bot} A ${rx} ${ry} 0 0 1 ${cx + rx} ${bot}`} {...dash} />
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} fill="var(--blue)" fillOpacity="0.2" stroke="var(--ink)" strokeWidth="1.8" />
      <line x1={cx} y1={top} x2={cx + rx} y2={top} {...dash} />
      <L x={cx + rx / 2} y={top - 10}>{d.r != null ? `r = ${d.r}` : `d = ${d.dm}`}</L>
      <line x1={cx + rx + 12} y1={top} x2={cx + rx + 12} y2={bot} {...dash} />
      <L x={cx + rx + 26} y={(top + bot) / 2}>{`${d.h} cm`}</L>
    </>;
  } else if (shape === "cone") {
    const cx = W / 2, rx = 48, ry = 15, ay = 24, by = 120;
    body = <>
      <path d={`M ${cx - rx} ${by} A ${rx} ${ry} 0 0 0 ${cx + rx} ${by} L ${cx} ${ay} Z`} {...fill} />
      <path d={`M ${cx - rx} ${by} A ${rx} ${ry} 0 0 1 ${cx + rx} ${by}`} {...dash} />
      <line x1={cx} y1={ay} x2={cx} y2={by} {...dash} />
      <line x1={cx} y1={by} x2={cx + rx} y2={by} {...dash} />
      <L x={cx + rx / 2} y={by + 13}>{`r = ${d.r}`}</L>
      <L x={cx - 16} y={(ay + by) / 2}>{d.slant != null ? `l = ${d.slant}` : `${d.h} cm`}</L>
    </>;
  } else if (shape === "sphere") {
    const cx = W / 2, cy = H / 2 - 2, R = 54;
    body = <>
      <circle cx={cx} cy={cy} r={R} {...fill} />
      <ellipse cx={cx} cy={cy} rx={R} ry={17} {...dash} />
      <line x1={cx} y1={cy} x2={cx + R} y2={cy} stroke="var(--ink)" strokeWidth="1.4" />
      <circle cx={cx} cy={cy} r="2" fill="var(--ink)" />
      <L x={cx + R / 2} y={cy - 9}>{`r = ${d.r}`}</L>
    </>;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${shape} diagram`}
      style={{ maxWidth: 272, display: "block", margin: "0 auto 10px" }}>
      {body}
    </svg>
  );
}

// A labelled vector diagram for the Vectors topic — a 3/4-sided figure
// with named vertices, marked points and directed vectors labelled a / b.
// Every segment is drawn solid black and shares its endpoints with the
// named vertices (the figure is closed, lines touch); a vector's direction
// is shown by a small arrowhead at the midpoint of the segment, the usual
// exam convention. All coords are raw [x,y] (y-up), scaled to the viewBox.
function VectorFigure({ labels = [], marks = [], edges = [], dashed = [], arrows = [] }) {
  const W = 250, H = 200, m = 26;
  const all = [
    ...labels.map((l) => l.p), ...marks.map((l) => l.p),
    ...edges.flat(), ...dashed.flat(),
    ...arrows.flatMap((a) => [a.a, a.b]),
  ];
  if (!all.length) return null;
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - 2 * m) / ((maxX - minX) || 1), (H - 2 * m) / ((maxY - minY) || 1));
  const cx = (W - s * (maxX - minX)) / 2, cy = (H - s * (maxY - minY)) / 2;
  const T = ([x, y]) => [cx + (x - minX) * s, cy + (maxY - y) * s];
  const F = (n) => n.toFixed(1);
  const cen = T([(minX + maxX) / 2, (minY + maxY) / 2]);
  const nrm = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  const halo = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3.4, strokeLinejoin: "round" };
  const line = (a, b, key) => {
    const p = T(a), q = T(b);
    return <line key={key} x1={F(p[0])} y1={F(p[1])} x2={F(q[0])} y2={F(q[1])} stroke="var(--ink)" strokeWidth="1.9" strokeLinecap="round" />;
  };
  const lbl = (p, t) => {
    const sp = T(p), d = nrm([sp[0] - cen[0], sp[1] - cen[1]]);
    return <text x={F(sp[0] + d[0] * 13)} y={F(sp[1] + d[1] * 13)} fontSize="11.5" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--ink)" style={halo}>{t}</text>;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="vector diagram"
      style={{ maxWidth: 300, display: "block", margin: "0 auto 10px" }}>
      {edges.map((e, i) => line(e[0], e[1], `e${i}`))}
      {dashed.map((e, i) => line(e[0], e[1], `d${i}`))}
      {arrows.map((ar, i) => {
        const p = T(ar.a), q = T(ar.b);
        const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        const hl = 5.6, hw = 4.2;                       // arrowhead centred on the midpoint
        const tip = [mx + ux * hl, my + uy * hl];
        const b1 = [mx - ux * hl + nx * hw, my - uy * hl + ny * hw];
        const b2 = [mx - ux * hl - nx * hw, my - uy * hl - ny * hw];
        let sgn = 1;
        if ((mx + nx - cen[0]) ** 2 + (my + ny - cen[1]) ** 2 < (mx - nx - cen[0]) ** 2 + (my - ny - cen[1]) ** 2) sgn = -1;
        const lp = [mx + nx * 13 * sgn, my + ny * 13 * sgn];
        return (
          <g key={`a${i}`}>
            {line(ar.a, ar.b)}
            <polygon points={`${F(tip[0])},${F(tip[1])} ${F(b1[0])},${F(b1[1])} ${F(b2[0])},${F(b2[1])}`} fill="var(--ink)" />
            <text x={F(lp[0])} y={F(lp[1])} fontSize="12.5" fontWeight="800" fontStyle="italic" textAnchor="middle" dominantBaseline="middle" fill="var(--ink)" style={halo}>{ar.t}</text>
          </g>
        );
      })}
      {marks.map((mk, i) => { const p = T(mk.p); return <circle key={`mc${i}`} cx={F(p[0])} cy={F(p[1])} r="2.8" fill="var(--ink)" />; })}
      {labels.map((l, i) => { const p = T(l.p); return <circle key={`lc${i}`} cx={F(p[0])} cy={F(p[1])} r="2.4" fill="var(--ink)" />; })}
      {labels.map((l, i) => <g key={`ll${i}`}>{lbl(l.p, l.t)}</g>)}
      {marks.map((mk, i) => <g key={`ml${i}`}>{lbl(mk.p, mk.t)}</g>)}
    </svg>
  );
}

// A schematic triangle with labelled sides / angles, for Trigonometry.
// verts: 3 [x,y] points (screen orientation). sideLabels[i] labels the
// edge opposite vertex i; angleLabels[i] labels the angle at vertex i;
// rightAngle is the vertex index carrying a right-angle square.
function TriangleFigure({ verts, sideLabels = [], angleLabels = [], vertLabels = [], rightAngle }) {
  const W = 244, H = 190, m = 42;
  const xs = verts.map((v) => v[0]), ys = verts.map((v) => v[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((W - 2 * m) / (maxX - minX || 1), (H - 2 * m) / (maxY - minY || 1));
  const ox = (W - s * (maxX - minX)) / 2, oy = (H - s * (maxY - minY)) / 2;
  const P = verts.map(([x, y]) => [ox + (x - minX) * s, oy + (y - minY) * s]);
  const cen = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
  const nrm = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };
  const F = (n) => n.toFixed(1);

  // a light halo behind text so labels stay readable if they cross a line
  const halo = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3.6, strokeLinejoin: "round" };
  // side label: true midpoint of edge i, pushed out along the perpendicular
  const sidePos = (i) => {
    const a = P[(i + 1) % 3], b = P[(i + 2) % 3], opp = P[i];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let nv = nrm([-(b[1] - a[1]), b[0] - a[0]]);
    if ((mid[0] + nv[0] - opp[0]) ** 2 + (mid[1] + nv[1] - opp[1]) ** 2 < (mid[0] - nv[0] - opp[0]) ** 2 + (mid[1] - nv[1] - opp[1]) ** 2) nv = [-nv[0], -nv[1]];
    return [mid[0] + nv[0] * 18, mid[1] + nv[1] * 18];
  };
  // angle arc + label along the bisector at vertex i — the radius grows
  // for narrow angles so the arc is visible, capped by the vertex height
  const angleAt = (i) => {
    const v = P[i], a = P[(i + 1) % 3], b = P[(i + 2) % 3];
    const d1 = nrm([a[0] - v[0], a[1] - v[1]]), d2 = nrm([b[0] - v[0], b[1] - v[1]]);
    const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const hgt = Math.abs((b[0] - a[0]) * (a[1] - v[1]) - (a[0] - v[0]) * (b[1] - a[1])) / edgeLen;
    let ang = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]);
    while (ang <= -Math.PI) ang += 2 * Math.PI;
    while (ang > Math.PI) ang -= 2 * Math.PI;
    const deg = Math.abs(ang) * 180 / Math.PI;
    let R = 13 + Math.max(0, 55 - deg) * 0.32;   // bigger for narrow angles
    R = Math.max(9, Math.min(R, hgt * 0.5, 26));
    const labD = Math.min(R + 15, hgt * 0.6);
    const a1 = [v[0] + d1[0] * R, v[1] + d1[1] * R], a2 = [v[0] + d2[0] * R, v[1] + d2[1] * R];
    const bis = nrm([d1[0] + d2[0], d1[1] + d2[1]]);
    return {
      path: `M ${F(a1[0])} ${F(a1[1])} A ${F(R)} ${F(R)} 0 0 ${ang > 0 ? 1 : 0} ${F(a2[0])} ${F(a2[1])}`,
      lab: [v[0] + bis[0] * labD, v[1] + bis[1] * labD],
    };
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="triangle diagram"
      style={{ maxWidth: 292, display: "block", margin: "0 auto 10px" }}>
      <polygon points={P.map((p) => `${F(p[0])},${F(p[1])}`).join(" ")} fill="var(--blue)" fillOpacity="0.12" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" />
      {typeof rightAngle === "number" && (() => {
        const v = P[rightAngle], a = P[(rightAngle + 1) % 3], b = P[(rightAngle + 2) % 3];
        const u1 = nrm([a[0] - v[0], a[1] - v[1]]), u2 = nrm([b[0] - v[0], b[1] - v[1]]), k = 11;
        const p1 = [v[0] + u1[0] * k, v[1] + u1[1] * k];
        const p2 = [p1[0] + u2[0] * k, p1[1] + u2[1] * k];
        const p3 = [v[0] + u2[0] * k, v[1] + u2[1] * k];
        return <polyline points={[p1, p2, p3].map((p) => `${F(p[0])},${F(p[1])}`).join(" ")} fill="none" stroke="var(--ink)" strokeWidth="1.3" />;
      })()}
      {angleLabels.map((lab, i) => {
        if (!lab || i === rightAngle) return null;
        const { path, lab: pos } = angleAt(i);
        return (
          <g key={`a${i}`}>
            <path d={path} fill="none" stroke="var(--red)" strokeWidth="1.6" />
            <text x={F(pos[0])} y={F(pos[1])} fontSize="9.5" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--red)" style={halo}>{lab}</text>
          </g>
        );
      })}
      {sideLabels.map((lab, i) => {
        if (!lab) return null;
        const p = sidePos(i);
        return <text key={`s${i}`} x={F(p[0])} y={F(p[1])} fontSize="10.5" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--ink)" style={halo}>{lab}</text>;
      })}
      {vertLabels.map((lab, i) => {
        if (!lab) return null;
        const d = nrm([P[i][0] - cen[0], P[i][1] - cen[1]]);
        return <text key={`v${i}`} x={F(P[i][0] + d[0] * 12)} y={F(P[i][1] + d[1] * 12)} fontSize="9" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--muted)" style={halo}>{lab}</text>;
      })}
    </svg>
  );
}

// A circle diagram — plain radius/diameter, a sector/arc, or one of the
// circle-theorem configurations. Geometry is built in world coords (O at
// the origin, R world units, y-up) then uniformly scaled to fit the
// viewBox, so the circle always stays round and everything stays on-canvas.
function CircleFigure({ type = "line", ...S }) {
  const W = 272, H = 232, m = 24, R = 60;
  const rd = (d) => (d * Math.PI) / 180;
  const P = (deg, rr = R) => [rr * Math.cos(rd(deg)), rr * Math.sin(rd(deg))];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const addv = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const nrm = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };

  const lines = [];       // [[world, world], ...]  solid segments
  const dashed = [];
  let sector = null;      // { a0, a1 }  shaded wedge (world degrees)
  let bold = null;        // { a0, a1 }  emphasised arc on the circle
  const ptLabels = [];    // { p: world, t }
  const freeLabels = [];  // { p: world, t, muted }
  const angs = [];        // { v, a, b: world, t }  angle mark at v between a & b
  const rights = [];      // { v, a, b: world }
  let showDot = false;

  const bb = [[-R, -R], [R, R]];
  const seen = (p) => bb.push(p);

  if (type === "line") {
    showDot = true;
    if (S.mode === "diameter") {
      const a = P(157), b = P(337);
      lines.push([a, b]); seen(a); seen(b);
      const perp = nrm([-(b[1] - a[1]), b[0] - a[0]]);
      freeLabels.push({ p: addv(mid(a, b), mul(perp, 15)), t: S.label });
    } else {
      const a = [0, 0], b = P(33);
      lines.push([a, b]); seen(b);
      const perp = nrm([-(b[1] - a[1]), b[0] - a[0]]);
      freeLabels.push({ p: addv(mid(a, b), mul(perp, 15)), t: S.label });
    }
  } else if (type === "sector") {
    showDot = true;
    const th = S.theta, a0 = 90 - th / 2, a1 = 90 + th / 2;
    sector = { a0, a1 };
    const A = P(a0), B = P(a1);
    lines.push([[0, 0], A], [[0, 0], B]); seen(A); seen(B);
    if (S.arcText) bold = { a0, a1 };
    angs.push({ v: [0, 0], a: A, b: B, t: S.angText });
    const rperp = [Math.sin(rd(a0)), -Math.cos(rd(a0))];
    if (S.rText) freeLabels.push({ p: addv(mid([0, 0], A), mul(rperp, 16)), t: S.rText });
    if (S.arcText) { freeLabels.push({ p: P(90, R + 20), t: S.arcText }); seen(P(90, R + 26)); }
    if (S.areaText) freeLabels.push({ p: P(90, R * 0.72), t: S.areaText });
  } else if (type === "centre") {
    showDot = true;
    const x = S.x, A = P(90), Bp = P(270 - x), Cp = P(270 + x);
    lines.push([A, Bp], [A, Cp], [[0, 0], Bp], [[0, 0], Cp]);
    angs.push({ v: [0, 0], a: Bp, b: Cp, t: S.centreText });
    angs.push({ v: A, a: Bp, b: Cp, t: S.circText });
    ptLabels.push({ p: P(90, R + 15), t: "A" }, { p: P(270 - x, R + 15), t: "B" }, { p: P(270 + x, R + 15), t: "C" });
    freeLabels.push({ p: [-15, -7], t: "O", muted: true });
  } else if (type === "semicircle") {
    showDot = true;
    const aA = S.angA, th = 2 * aA;
    const A = P(180), Bp = P(0), Cp = P(th);
    lines.push([A, Cp], [Bp, Cp], [A, Bp]);
    // no right-angle mark at C — the student must recall that the angle
    // in a semicircle is 90° (that's the theorem being tested)
    if (S.textA) angs.push({ v: A, a: Cp, b: Bp, t: S.textA });
    if (S.textB) angs.push({ v: Bp, a: Cp, b: A, t: S.textB });
    ptLabels.push({ p: P(180, R + 15), t: "A" }, { p: P(0, R + 15), t: "B" }, { p: P(th, R + 15), t: "C" });
  } else if (type === "sameseg") {
    const x = S.x;
    const Bp = P(270 - x), Cp = P(270 + x), A = P(116), D = P(64);
    lines.push([A, Bp], [A, Cp], [D, Bp], [D, Cp], [Bp, Cp]);
    if (S.textA) angs.push({ v: A, a: Bp, b: Cp, t: S.textA });
    if (S.textD) angs.push({ v: D, a: Bp, b: Cp, t: S.textD });
    ptLabels.push({ p: P(116, R + 15), t: "A" }, { p: P(64, R + 15), t: "D" }, { p: P(270 - x, R + 16), t: "B" }, { p: P(270 + x, R + 16), t: "C" });
  } else if (type === "cyclic") {
    const g = S.gaps, t0 = 90;
    const a4 = [t0, t0 + g[0], t0 + g[0] + g[1], t0 + g[0] + g[1] + g[2]];
    const V = a4.map((d) => P(d));
    for (let i = 0; i < 4; i++) lines.push([V[i], V[(i + 1) % 4]]);
    const L = ["A", "B", "C", "D"];
    V.forEach((p, i) => ptLabels.push({ p: P(a4[i], R + 15), t: L[i] }));
    (S.marks || []).forEach(({ i, t }) => angs.push({ v: V[i], a: V[(i + 3) % 4], b: V[(i + 1) % 4], t }));
  } else if (type === "tangents") {
    showDot = true;
    const p = S.p, aop = 90 - p / 2;
    const A = P(aop), Bp = P(-aop);
    const Pe = [R / Math.sin(rd(p / 2)), 0];
    lines.push([A, Pe], [Bp, Pe]);
    if (S.baseText) {
      lines.push([A, Bp]);
      angs.push({ v: A, a: Pe, b: Bp, t: S.baseText });
    } else {
      lines.push([[0, 0], A], [[0, 0], Bp]);
      dashed.push([[0, 0], Pe]);
      rights.push({ v: A, a: [0, 0], b: Pe }, { v: Bp, a: [0, 0], b: Pe });
    }
    if (S.textP) angs.push({ v: Pe, a: A, b: Bp, t: S.textP });
    if (S.textO) angs.push({ v: [0, 0], a: A, b: Bp, t: S.textO });
    ptLabels.push({ p: P(aop, R + 15), t: "A" }, { p: P(-aop, R + 15), t: "B" });
    freeLabels.push({ p: addv(Pe, [17, 0]), t: "P", muted: true }, { p: [-15, -7], t: "O", muted: true });
    seen(Pe); seen(addv(Pe, [26, 0]));
  } else if (type === "altseg") {
    const x = S.x;
    const A = P(270), Bp = P(270 - 2 * x), Cp = P(46);
    const tL = addv(A, [-R * 1.18, 0]), tR = addv(A, [R * 1.18, 0]);
    lines.push([tL, tR], [A, Bp], [Cp, A], [Cp, Bp]);
    seen(tL); seen(tR);
    if (S.textA) angs.push({ v: A, a: tL, b: Bp, t: S.textA });
    if (S.textC) angs.push({ v: Cp, a: A, b: Bp, t: S.textC });
    ptLabels.push({ p: addv(A, [0, -16]), t: "A" }, { p: P(270 - 2 * x, R + 15), t: "B" }, { p: P(46, R + 15), t: "C" });
  }

  ptLabels.forEach((l) => seen(l.p));
  freeLabels.forEach((l) => seen(l.p));

  const xs = bb.map((p) => p[0]), ys = bb.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((W - 2 * m) / ((maxX - minX) || 1), (H - 2 * m) / ((maxY - minY) || 1));
  const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
  const T = ([x, y]) => [W / 2 + (x - bcx) * k, H / 2 - (y - bcy) * k];
  const F = (n) => n.toFixed(1);
  const halo = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3.4, strokeLinejoin: "round" };
  const O = T([0, 0]), rS = R * k;

  const arcPts = (a0, a1, rr) => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 3)), out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([O[0] + rr * Math.cos(rd(a)), O[1] - rr * Math.sin(rd(a))]); }
    return out;
  };
  const angMark = (V, A, B) => {
    const v = T(V), a = T(A), b = T(B);
    const d1 = nrm(sub(a, v)), d2 = nrm(sub(b, v));
    let ang = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]);
    while (ang <= -Math.PI) ang += 2 * Math.PI;
    while (ang > Math.PI) ang -= 2 * Math.PI;
    const deg = Math.abs(ang) * 180 / Math.PI;
    let rr = 15 + Math.max(0, 42 - deg) * 0.3;   // wider arc for narrow angles
    rr = Math.min(rr, 25);
    const a1 = [v[0] + d1[0] * rr, v[1] + d1[1] * rr], a2 = [v[0] + d2[0] * rr, v[1] + d2[1] * rr];
    const bis = nrm([d1[0] + d2[0], d1[1] + d2[1]]);
    // wide angles have plenty of room near the vertex — sit the label close
    // in (and clear of both arms); narrow angles need it pushed out
    const labGap = deg >= 110 ? 5 : deg >= 80 ? 8 : deg >= 50 ? 11 : 14;
    return {
      path: `M ${F(a1[0])} ${F(a1[1])} A ${F(rr)} ${F(rr)} 0 0 ${ang > 0 ? 1 : 0} ${F(a2[0])} ${F(a2[1])}`,
      lab: [v[0] + bis[0] * (rr + labGap), v[1] + bis[1] * (rr + labGap)],
    };
  };
  const rtMark = (V, A, B) => {
    const v = T(V), a = T(A), b = T(B);
    const d1 = nrm(sub(a, v)), d2 = nrm(sub(b, v)), kk = 9;
    const p1 = [v[0] + d1[0] * kk, v[1] + d1[1] * kk];
    return [p1, [p1[0] + d2[0] * kk, p1[1] + d2[1] * kk], [v[0] + d2[0] * kk, v[1] + d2[1] * kk]]
      .map((p) => `${F(p[0])},${F(p[1])}`).join(" ");
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="circle diagram"
      style={{ maxWidth: 302, display: "block", margin: "0 auto 10px" }}>
      {sector && (
        <path d={`M ${F(O[0])} ${F(O[1])} L ${arcPts(sector.a0, sector.a1, rS).map((p) => `${F(p[0])} ${F(p[1])}`).join(" L ")} Z`}
          fill="var(--blue)" fillOpacity="0.16" stroke="none" />
      )}
      <circle cx={F(O[0])} cy={F(O[1])} r={F(rS)} fill="var(--blue)" fillOpacity="0.05" stroke="var(--ink)" strokeWidth="1.8" />
      {dashed.map(([a, b], i) => { const p = T(a), q = T(b); return <line key={`d${i}`} x1={F(p[0])} y1={F(p[1])} x2={F(q[0])} y2={F(q[1])} stroke="var(--muted)" strokeWidth="1.3" strokeDasharray="4 3" />; })}
      {lines.map(([a, b], i) => { const p = T(a), q = T(b); return <line key={`l${i}`} x1={F(p[0])} y1={F(p[1])} x2={F(q[0])} y2={F(q[1])} stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />; })}
      {bold && <polyline points={arcPts(bold.a0, bold.a1, rS).map((p) => `${F(p[0])},${F(p[1])}`).join(" ")} fill="none" stroke="var(--red)" strokeWidth="3" strokeLinecap="round" />}
      {rights.map((r, i) => <polyline key={`r${i}`} points={rtMark(r.v, r.a, r.b)} fill="none" stroke="var(--ink)" strokeWidth="1.3" />)}
      {angs.map((A, i) => {
        if (A.t == null) return null;
        const { path, lab } = angMark(A.v, A.a, A.b);
        return (
          <g key={`ang${i}`}>
            <path d={path} fill="none" stroke="var(--red)" strokeWidth="1.6" />
            <text x={F(lab[0])} y={F(lab[1])} fontSize="10" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--red)" style={halo}>{A.t}</text>
          </g>
        );
      })}
      {showDot && <circle cx={F(O[0])} cy={F(O[1])} r="2.4" fill="var(--ink)" />}
      {ptLabels.map((l, i) => { const p = T(l.p); return <text key={`p${i}`} x={F(p[0])} y={F(p[1])} fontSize="9.5" fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill="var(--muted)" style={halo}>{l.t}</text>; })}
      {freeLabels.map((l, i) => { const p = T(l.p); return <text key={`f${i}`} x={F(p[0])} y={F(p[1])} fontSize={l.muted ? "9.5" : "10.5"} fontWeight="700" textAnchor="middle" dominantBaseline="middle" fill={l.muted ? "var(--muted)" : "var(--ink)"} style={halo}>{l.t}</text>; })}
    </svg>
  );
}

// A Venn diagram whose regions the student taps to shade a target set.
function VennShade({ venn, pressed, onToggle, showAnswer }) {
  const two = venn.sets === 2;
  const U = { x: 8, y: 8, w: 224, h: 184 };
  const cir = two
    ? { A: [92, 102, 60], B: [148, 102, 60] }
    : { A: [92, 86, 52], B: [148, 86, 52], C: [120, 134, 52] };
  const inC = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 < c[2] ** 2;
  const regionAt = (px, py) => {
    const p = [px, py];
    const iA = inC(p, cir.A), iB = inC(p, cir.B), iC = two ? false : inC(p, cir.C);
    if (two) return iA && iB ? "ab" : iA ? "a" : iB ? "b" : "out";
    if (iA && iB && iC) return "abc";
    if (iA && iB) return "ab";
    if (iA && iC) return "ac";
    if (iB && iC) return "bc";
    if (iA) return "a"; if (iB) return "b"; if (iC) return "c";
    return "out";
  };
  const C = (c, extra) => <circle cx={c[0]} cy={c[1]} r={c[2]} {...extra} />;
  const mr = () => <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="#fff" />;
  const mf = { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 240, height: 200 };
  const bigrect = (f) => <rect x={U.x} y={U.y} width={U.w} height={U.h} {...f} />;

  const shape = (key, fill, op) => {
    const f = { fill, fillOpacity: op };
    if (two) {
      if (key === "a") return C(cir.A, { ...f, mask: "url(#vs-nB)" });
      if (key === "b") return C(cir.B, { ...f, mask: "url(#vs-nA)" });
      if (key === "ab") return <g clipPath="url(#vs-cA)">{C(cir.B, f)}</g>;
      return bigrect({ ...f, mask: "url(#vs-out)" });
    }
    if (key === "a") return C(cir.A, { ...f, mask: "url(#vs-nBC)" });
    if (key === "b") return C(cir.B, { ...f, mask: "url(#vs-nAC)" });
    if (key === "c") return C(cir.C, { ...f, mask: "url(#vs-nAB)" });
    if (key === "ab") return <g clipPath="url(#vs-cA)">{C(cir.B, { ...f, mask: "url(#vs-nC)" })}</g>;
    if (key === "ac") return <g clipPath="url(#vs-cA)">{C(cir.C, { ...f, mask: "url(#vs-nB)" })}</g>;
    if (key === "bc") return <g clipPath="url(#vs-cB)">{C(cir.C, { ...f, mask: "url(#vs-nA)" })}</g>;
    if (key === "abc") return <g clipPath="url(#vs-cA)"><g clipPath="url(#vs-cB)">{C(cir.C, f)}</g></g>;
    return bigrect({ ...f, mask: "url(#vs-out)" });
  };

  return (
    <svg viewBox="0 0 240 200" width="100%" role="img" aria-label="Venn diagram — tap regions to shade"
      style={{ maxWidth: 330, display: "block", margin: "0 auto 8px", touchAction: "manipulation" }}>
      <defs>
        <clipPath id="vs-cA">{C(cir.A)}</clipPath>
        <clipPath id="vs-cB">{C(cir.B)}</clipPath>
        <mask id="vs-nA" {...mf}>{mr()}{C(cir.A, { fill: "#000" })}</mask>
        <mask id="vs-nB" {...mf}>{mr()}{C(cir.B, { fill: "#000" })}</mask>
        {!two && <mask id="vs-nC" {...mf}>{mr()}{C(cir.C, { fill: "#000" })}</mask>}
        {!two && <mask id="vs-nBC" {...mf}>{mr()}{C(cir.B, { fill: "#000" })}{C(cir.C, { fill: "#000" })}</mask>}
        {!two && <mask id="vs-nAC" {...mf}>{mr()}{C(cir.A, { fill: "#000" })}{C(cir.C, { fill: "#000" })}</mask>}
        {!two && <mask id="vs-nAB" {...mf}>{mr()}{C(cir.A, { fill: "#000" })}{C(cir.B, { fill: "#000" })}</mask>}
        <mask id="vs-out" {...mf}>{mr()}{C(cir.A, { fill: "#000" })}{C(cir.B, { fill: "#000" })}{!two ? C(cir.C, { fill: "#000" }) : null}</mask>
      </defs>
      <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="var(--card)" stroke="var(--grid)" />
      {showAnswer && venn.target.map((k) => <g key={`t${k}`}>{shape(k, "var(--green)", 0.3)}</g>)}
      {pressed.map((k) => <g key={`p${k}`}>{shape(k, "var(--blue)", 0.34)}</g>)}
      {C(cir.A, { fill: "none", stroke: "var(--ink)", strokeWidth: 1.6 })}
      {C(cir.B, { fill: "none", stroke: "var(--ink)", strokeWidth: 1.6 })}
      {!two && C(cir.C, { fill: "none", stroke: "var(--ink)", strokeWidth: 1.6 })}
      <text x={cir.A[0] - cir.A[2] + 5} y={cir.A[1] - cir.A[2] + 14} fontSize="12" fontWeight="700" fill="var(--ink)">A</text>
      <text x={cir.B[0] + cir.B[2] - 13} y={cir.B[1] - cir.B[2] + 14} fontSize="12" fontWeight="700" fill="var(--ink)">B</text>
      {!two && <text x={cir.C[0] - 4} y={cir.C[1] + cir.C[2] - 5} fontSize="12" fontWeight="700" fill="var(--ink)">C</text>}
      <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="transparent"
        style={{ cursor: onToggle ? "pointer" : "default", pointerEvents: "all", WebkitTapHighlightColor: "transparent", outline: "none", userSelect: "none" }}
        onClick={onToggle ? (e) => {
          const b = e.currentTarget.getBoundingClientRect();
          onToggle(regionAt((e.clientX - b.left) / b.width * 240, (e.clientY - b.top) / b.height * 200));
        } : undefined} />
    </svg>
  );
}

// Circle layout + region hit-test shared with VennShade — factored out
// so the drag-to-place board below can use the exact same geometry.
function vennCircles(sets) {
  return sets === 2
    ? { A: [92, 102, 60], B: [148, 102, 60] }
    : { A: [92, 86, 52], B: [148, 86, 52], C: [120, 134, 52] };
}
function vennRegionAt(sets, cir, px, py) {
  const inC = (c) => (px - c[0]) ** 2 + (py - c[1]) ** 2 < c[2] ** 2;
  const iA = inC(cir.A), iB = inC(cir.B), iC = sets === 2 ? false : inC(cir.C);
  if (sets === 2) return iA && iB ? "ab" : iA ? "a" : iB ? "b" : "out";
  if (iA && iB && iC) return "abc";
  if (iA && iB) return "ab"; if (iA && iC) return "ac"; if (iB && iC) return "bc";
  if (iA) return "a"; if (iB) return "b"; if (iC) return "c";
  return "out";
}
// Where a region's cluster of placed chips is centred, in the same
// 240×200 space as the circles above. Only used as a fallback for the
// (currently unreachable) 3-set case — the 2-set layout below computes
// safe positions directly from the actual circle geometry instead.
const VENN_ANCHORS = {
  3: { a: [70, 70], b: [170, 70], c: [120, 172], ab: [120, 64], ac: [82, 112], bc: [158, 112], abc: [120, 98], out: [120, 16] },
};
const VENN_CLUSTER_OFFSETS = [[0, 0], [-18, 0], [18, 0], [0, -18], [0, 18], [-18, -18], [18, -18], [-18, 18], [18, 18]];

// Evenly-spaced offsets for `count` items along one axis, centred on 0,
// capped to `maxSpan` total width so a long run of items compresses
// instead of spilling past a safe boundary.
function stackOffsets(count, maxSpan, maxStep) {
  if (count <= 1) return [0];
  const step = Math.min(maxStep, maxSpan / (count - 1));
  const span = step * (count - 1);
  return Array.from({ length: count }, (_, i) => -span / 2 + i * step);
}

// "Drag the numbers in" — every element of a small universal set gets
// dragged into whichever Venn region matches the rules that define A
// (and B, and C). `placement` is a controlled { [element]: regionKey }
// map; dropping outside the diagram (region === null) sends it back to
// the tray below. `venn` = { sets, universe, correct }.
function VennPlaceBoard({ venn, placement, onPlace, showAnswer }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(280);
  const [dragEl, setDragEl] = useState(null);
  const [dragPos, setDragPos] = useState(null); // {x,y} in viewport (client) coords

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cir = vennCircles(venn.sets);
  const svgH = w * (200 / 240);
  const scaleX = w / 240, scaleY = svgH / 200;
  const CHIP = 30;
  // Tray height has to fit however many rows the numbers actually wrap
  // into (not just one) — otherwise a wide universe on a narrow screen
  // overflows the board and collides with whatever sits below it.
  const trayPerRow = Math.max(1, Math.floor((w - 16) / 40));
  const trayRows = Math.max(1, Math.ceil(venn.universe.length / trayPerRow));
  const trayH = trayRows * 32 + 24;

  const unplaced = venn.universe.filter((el) => placement[el] == null);
  function restPos(el) {
    const region = placement[el];
    if (region == null) {
      const idx = unplaced.indexOf(el);
      return { x: 24 + (idx % trayPerRow) * 40, y: svgH + 20 + Math.floor(idx / trayPerRow) * 32 };
    }
    const same = venn.universe.filter((u) => placement[u] === region);
    const idx = same.indexOf(el);
    if (venn.sets === 2) {
      // Circles are [92,102,60] and [148,102,60] — x=70/170 sit deep inside
      // A-only/B-only (safely clear of the other circle at any height in the
      // ±39-unit vertical band used below), and x=120 sits in the middle of
      // the lens both circles share. "out" has the whole strip above the
      // circles to itself, so it spreads sideways instead of stacking.
      if (region === "out") {
        const off = stackOffsets(same.length, 190, 32);
        return { x: (120 + off[idx]) * scaleX, y: 24 * scaleY };
      }
      const cx = region === "a" ? 70 : region === "b" ? 170 : 120; // "ab"
      const off = stackOffsets(same.length, 78, 20);
      return { x: cx * scaleX, y: (102 + off[idx]) * scaleY };
    }
    const anchor = VENN_ANCHORS[3][region] || VENN_ANCHORS[3].out;
    const off = VENN_CLUSTER_OFFSETS[idx % VENN_CLUSTER_OFFSETS.length] || [0, 0];
    return { x: (anchor[0] + off[0]) * scaleX, y: (anchor[1] + off[1]) * scaleY };
  }

  function regionAtClient(clientX, clientY) {
    const b = wrapRef.current.getBoundingClientRect();
    const x = clientX - b.left, y = clientY - b.top;
    if (x < 0 || x >= w || y < 0 || y >= svgH) return null; // tray, or off the board entirely
    return vennRegionAt(venn.sets, cir, x / scaleX, y / scaleY);
  }

  const startDrag = (el) => (e) => {
    if (showAnswer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragEl(el);
    setDragPos({ x: e.clientX, y: e.clientY });
  };
  const moveDrag = (e) => { if (dragEl != null) setDragPos({ x: e.clientX, y: e.clientY }); };
  const endDrag = (e) => {
    if (dragEl == null) return;
    onPlace(dragEl, regionAtClient(e.clientX, e.clientY));
    setDragEl(null);
    setDragPos(null);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", maxWidth: 330, margin: "0 auto", height: svgH + trayH, touchAction: "none" }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <svg viewBox="0 0 240 200" width="100%" height={svgH} style={{ display: "block" }}>
        <rect x={8} y={8} width={224} height={184} fill="var(--card)" stroke="var(--grid)" />
        <circle cx={cir.A[0]} cy={cir.A[1]} r={cir.A[2]} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
        <circle cx={cir.B[0]} cy={cir.B[1]} r={cir.B[2]} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
        {venn.sets === 3 && <circle cx={cir.C[0]} cy={cir.C[1]} r={cir.C[2]} fill="none" stroke="var(--ink)" strokeWidth="1.6" />}
        <text x={cir.A[0] - cir.A[2] + 5} y={cir.A[1] - cir.A[2] + 14} fontSize="12" fontWeight="700" fill="var(--ink)">A</text>
        <text x={cir.B[0] + cir.B[2] - 13} y={cir.B[1] - cir.B[2] + 14} fontSize="12" fontWeight="700" fill="var(--ink)">B</text>
        {venn.sets === 3 && <text x={cir.C[0] - 4} y={cir.C[1] + cir.C[2] - 5} fontSize="12" fontWeight="700" fill="var(--ink)">C</text>}
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, top: svgH, height: trayH, borderTop: "1px dashed var(--grid)" }} />
      {venn.universe.map((el) => {
        const dragging = dragEl === el;
        const b = wrapRef.current ? wrapRef.current.getBoundingClientRect() : { left: 0, top: 0 };
        const pos = dragging ? { x: dragPos.x - b.left, y: dragPos.y - b.top } : restPos(el);
        const right = showAnswer ? placement[el] === venn.correct[el] : null;
        return (
          <div key={el} onPointerDown={startDrag(el)} style={{
            position: "absolute", left: pos.x - CHIP / 2, top: pos.y - CHIP / 2, width: CHIP, height: CHIP, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800,
            cursor: showAnswer ? "default" : "grab", background: "var(--card)",
            border: `2px solid ${right === null ? "var(--blue)" : right ? "var(--green)" : "var(--red)"}`,
            color: "var(--ink)", touchAction: "none", userSelect: "none", WebkitTapHighlightColor: "transparent",
            zIndex: dragging ? 5 : 1, boxShadow: dragging ? "0 4px 10px var(--shadow)" : "none",
            transition: dragging ? "none" : "left 0.15s, top 0.15s",
          }}>{el}</div>
        );
      })}
    </div>
  );
}

// A fixed-height scratch pad in the quiz-card flow for rough working.
// Strokes are normalised (0–1) so they survive resizes; the parent
// clears them when the question changes.
function SketchOverlay({ active, strokes, setStrokes }) {
  const canvasRef = useRef(null);
  const cur = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !cv.parentElement) return;
    const p = cv.parentElement;
    const measure = () => setSize((s) => (s.w === p.clientWidth && s.h === p.clientHeight ? s : { w: p.clientWidth, h: p.clientHeight }));
    measure();
    // the pad only has a real size once it's open — re-measure on the next frame too
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [active]);

  const redraw = () => {
    const cv = canvasRef.current;
    if (!cv || !size.w) return;
    if (cv.width !== size.w) cv.width = size.w;
    if (cv.height !== size.h) cv.height = size.h;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.strokeStyle = "#1b2733";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const st of strokes) {
      if (!Array.isArray(st) || st.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(st[0][0] * size.w, st[0][1] * size.h);
      for (let i = 1; i < st.length; i++) ctx.lineTo(st[i][0] * size.w, st[i][1] * size.h);
      if (st.length === 1) ctx.lineTo(st[0][0] * size.w + 0.5, st[0][1] * size.h + 0.5);
      ctx.stroke();
    }
  };
  useEffect(redraw, [strokes, size]);

  const at = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const start = (e) => {
    canvasRef.current.setPointerCapture(e.pointerId);
    cur.current = [at(e)];
    redraw();
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.arc(cur.current[0][0] * size.w, cur.current[0][1] * size.h, 1.2, 0, 7);
    ctx.fillStyle = "#1b2733";
    ctx.fill();
  };
  const move = (e) => {
    if (!cur.current) return;
    const p = at(e);
    const prev = cur.current[cur.current.length - 1];
    cur.current.push(p);
    const ctx = canvasRef.current.getContext("2d");
    ctx.strokeStyle = "#1b2733";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(prev[0] * size.w, prev[1] * size.h);
    ctx.lineTo(p[0] * size.w, p[1] * size.h);
    ctx.stroke();
  };
  const end = () => {
    const done = cur.current; // capture before clearing — React runs the updater later
    cur.current = null;
    if (Array.isArray(done) && done.length) setStrokes((s) => [...s, done]);
  };

  // A translucent scratch sheet over the whole quiz card, so the question
  // stays visible through it while you work. The card carries a minHeight
  // when this is open so a short question still gets a usable pad.
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 5,
      overflow: "hidden", borderRadius: 8, border: "1.5px dashed #c9d2da",
      background: "rgba(255,255,255,0.76)",
      opacity: active ? 1 : 0, pointerEvents: active ? "auto" : "none", transition: "opacity 0.12s",
    }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "crosshair" }}
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      {strokes.length > 0 && (
        <button onClick={() => setStrokes([])} style={{
          position: "absolute", top: 4, right: 8, fontSize: 11, fontWeight: 700, padding: "4px 10px",
          background: "#fff", border: "1px solid #c9d2da", borderRadius: 8, cursor: "pointer", color: "#1b2733",
        }}>Clear all</button>
      )}
    </div>
  );
}

/* Handwriting input for the answer box. The student scribbles, an on-device
   model reads it, and the guess is dropped into the box for them to check
   or fix before submitting. */
function WritePad({ onInsert, onConfirm, onClose, mode }) {
  const canvasRef = useRef(null);
  const cur = useRef(null);
  const strokesRef = useRef([]);
  const recTimer = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [guess, setGuess] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(true); // becomes false → true around the first (model-loading) recognise
  const everRan = useRef(false);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const measure = () => setSize({ w: cv.clientWidth, h: cv.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(cv);
    return () => { clearTimeout(recTimer.current); ro.disconnect(); };
  }, []);

  const redraw = () => {
    const cv = canvasRef.current;
    if (!cv || !size.w) return;
    if (cv.width !== size.w) cv.width = size.w;
    if (cv.height !== size.h) cv.height = size.h;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.strokeStyle = "#1b2733";
    ctx.lineWidth = Math.max(3.5, size.w / 80);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const st of [...strokesRef.current, cur.current].filter(Boolean)) {
      if (!st.length) continue;
      ctx.beginPath();
      ctx.moveTo(st[0][0] * size.w, st[0][1] * size.h);
      for (let i = 1; i < st.length; i++) ctx.lineTo(st[i][0] * size.w, st[i][1] * size.h);
      if (st.length === 1) ctx.lineTo(st[0][0] * size.w + 0.1, st[0][1] * size.h + 0.1);
      ctx.stroke();
    }
  };
  useEffect(redraw, [size]);

  const at = (e) => { const r = canvasRef.current.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const start = (e) => { try { canvasRef.current.setPointerCapture(e.pointerId); } catch (err) { /* synthetic / no pointer */ } cur.current = [at(e)]; redraw(); };
  const move = (e) => { if (!cur.current) return; cur.current.push(at(e)); redraw(); };
  const end = () => {
    if (cur.current && cur.current.length) strokesRef.current.push(cur.current);
    cur.current = null;
    clearTimeout(recTimer.current);
    recTimer.current = setTimeout(runRec, 500);
  };

  async function runRec() {
    if (!hasInk(strokesRef.current)) { setGuess(""); return; }
    const cv = canvasRef.current;
    setBusy(true); setReady(false);
    const txt = await recognizeHandwriting({ strokes: strokesRef.current, width: cv.clientWidth, height: cv.clientHeight, mode });
    everRan.current = true;
    setBusy(false); setReady(true); setGuess(txt);
  }
  const clearAll = () => { strokesRef.current = []; cur.current = null; setGuess(""); redraw(); };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 80 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "100%", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 16, color: "var(--ink)", fontFamily: "Inter, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="mub-display" style={{ fontWeight: 700, fontSize: 15 }}>Write your answer</div>
          <button onClick={onClose} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}>Cancel</button>
        </div>
        <canvas ref={canvasRef} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          style={{ width: "100%", height: 240, display: "block", background: "#fff", border: "1.5px dashed #c9d2da", borderRadius: 10, touchAction: "none", cursor: "crosshair" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0", minHeight: 28 }}>
          <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, flexShrink: 0 }}>Reads as</span>
          <span className="mub-mono" style={{ fontSize: 19, fontWeight: 700, color: "var(--ink)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {busy
              ? (everRan.current ? "…" : <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>loading the recogniser…</span>)
              : guess ? <MathText text={prettyMathPreview(guess)} /> : "—"}
          </span>
          <button onClick={clearAll} style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}>Clear</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <button onClick={() => { if (guess && ready) { onInsert(guess); onClose(); } }} disabled={!guess || !ready}
            style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "9px 14px", cursor: guess && ready ? "pointer" : "default", opacity: guess && ready ? 1 : 0.5 }}>
            Insert to text box
          </button>
          <button onClick={() => { if (guess && ready) { onConfirm(guess); onClose(); } }} disabled={!guess || !ready}
            style={{ flex: 1, fontSize: 15, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "11px 14px", cursor: guess && ready ? "pointer" : "default", opacity: guess && ready ? 1 : 0.5 }}>
            Submit
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.4 }}>
          Write left to right with a small gap between characters. For a power, write it small and raised, like 2<sup style={{ fontSize: "0.7em" }}>3</sup>. For a fraction, write the top number, a line under it, then the bottom number. It won&rsquo;t always be perfect — check the reading first. <b>Submit</b> uses it straight away; <b>Insert to text box</b> lets you edit it before checking.
        </div>
      </div>
    </div>
  );
}

const TOPICS = [
  { id: "arithmetic", name: "Arithmetic", icon: "➕", prereqs: [],
    generate() {
      // A mix of BODMAS shapes — brackets, orders (powers & roots),
      // division, multiplication, add/subtract. Answers are whole
      // numbers; roughly 1 in 4 questions involves negatives (results
      // going below zero, or negative operands including −×−).
      const forms = [
        () => { // multiply, then add/subtract
          const a = randInt(4, 20), b = randInt(2, 9), c = randInt(2, 9);
          const d = randInt(1, Math.min(15, a + b * c - 1));
          return { prompt: `${a} + ${b} × ${c} − ${d}`, answer: a + b * c - d,
            steps: [`Multiply first: ${b} × ${c} = ${b * c}`, `Then left to right: ${a} + ${b * c} − ${d} = ${a + b * c - d}`] };
        },
        () => { // brackets, then multiply and subtract
          const a = randInt(2, 12), b = randInt(2, 12), c = randInt(2, 6);
          const d = randInt(1, Math.min(20, (a + b) * c - 1));
          return { prompt: `(${a} + ${b}) × ${c} − ${d}`, answer: (a + b) * c - d,
            steps: [`Brackets first: (${a} + ${b}) = ${a + b}`, `Multiply: ${a + b} × ${c} = ${(a + b) * c}`, `Subtract: ${(a + b) * c} − ${d} = ${(a + b) * c - d}`] };
        },
        () => { // multiply a bracket, then add
          const a = randInt(3, 12), b = randInt(9, 20), c = randInt(2, 8), d = randInt(1, 20);
          return { prompt: `${a} × (${b} − ${c}) + ${d}`, answer: a * (b - c) + d,
            steps: [`Brackets first: (${b} − ${c}) = ${b - c}`, `Multiply: ${a} × ${b - c} = ${a * (b - c)}`, `Add: ${a * (b - c)} + ${d} = ${a * (b - c) + d}`] };
        },
        () => { // a square, then multiply and add
          const a = randInt(3, 9), b = randInt(2, 9), c = randInt(2, 9);
          return { prompt: `${a}² + ${b} × ${c}`, answer: a * a + b * c,
            steps: [`Powers first: ${a}² = ${a * a}`, `Multiply: ${b} × ${c} = ${b * c}`, `Add: ${a * a} + ${b * c} = ${a * a + b * c}`] };
        },
        () => { // a cube, then subtract
          const a = randInt(2, 5), cube = a * a * a, b = randInt(1, cube - 1);
          return { prompt: `${a}³ − ${b}`, answer: cube - b,
            steps: [`Powers first: ${a}³ = ${cube}`, `Subtract: ${cube} − ${b} = ${cube - b}`] };
        },
        () => { // a square root, then add or subtract
          const r = randInt(3, 12), sq = r * r, add = Math.random() < 0.5;
          const b = add ? randInt(1, 20) : randInt(1, r);
          return { prompt: `√${sq} ${add ? "+" : "−"} ${b}`, answer: add ? r + b : r - b,
            steps: [`Roots first: √${sq} = ${r}`, `${add ? "Add" : "Subtract"}: ${r} ${add ? "+" : "−"} ${b} = ${add ? r + b : r - b}`] };
        },
        () => { // divide and multiply, then add
          const b = randInt(2, 9), k = randInt(2, 9), a = b * k, c = randInt(2, 9), d = randInt(2, 9);
          return { prompt: `${a} ÷ ${b} + ${c} × ${d}`, answer: k + c * d,
            steps: [`Divide and multiply first: ${a} ÷ ${b} = ${k},  ${c} × ${d} = ${c * d}`, `Add: ${k} + ${c * d} = ${k + c * d}`] };
        },
        () => { // brackets, then divide
          const c = randInt(2, 8), q = randInt(2, 9), total = c * q, a = randInt(1, total - 1);
          return { prompt: `(${a} + ${total - a}) ÷ ${c}`, answer: q,
            steps: [`Brackets first: (${a} + ${total - a}) = ${total}`, `Divide: ${total} ÷ ${c} = ${q}`] };
        },
        () => { // multiply then divide, left to right
          const a = randInt(2, 9), b = randInt(2, 9), prod = a * b;
          const divisors = [2, 3, 4, 5, 6].filter((x) => prod % x === 0);
          const cc = divisors.length ? divisors[randInt(0, divisors.length - 1)] : 1;
          return { prompt: `${a} × ${b} ÷ ${cc}`, answer: prod / cc,
            steps: [`Left to right: ${a} × ${b} = ${prod}`, `Divide: ${prod} ÷ ${cc} = ${prod / cc}`] };
        },
      ];
      const negForms = [
        () => { // subtraction crossing zero
          const a = randInt(2, 15), b = randInt(a + 2, a + 16);
          return { prompt: `${a} − ${b}`, answer: a - b, steps: [`${a} − ${b} = ${a - b}`] };
        },
        () => { // multiply, then subtract from a smaller number
          const b = randInt(3, 9), c = randInt(3, 9), a = randInt(1, b * c - 2);
          return { prompt: `${a} − ${b} × ${c}`, answer: a - b * c,
            steps: [`Multiply first: ${b} × ${c} = ${b * c}`, `Subtract: ${a} − ${b * c} = ${a - b * c}`] };
        },
        () => { // negative × negative, then add or subtract
          const a = randInt(2, 9), b = randInt(2, 9), c = randInt(1, 30), plus = Math.random() < 0.5, prod = a * b;
          return { prompt: `(−${a}) × (−${b}) ${plus ? "+" : "−"} ${c}`, answer: plus ? prod + c : prod - c,
            steps: [`A negative times a negative is positive: (−${a}) × (−${b}) = ${prod}`, `${plus ? "Add" : "Subtract"}: ${prod} ${plus ? "+" : "−"} ${c} = ${plus ? prod + c : prod - c}`] };
        },
        () => { // negative × positive, then add or subtract
          const a = randInt(2, 9), b = randInt(2, 9), c = randInt(1, 20), plus = Math.random() < 0.5, prod = -a * b;
          return { prompt: `(−${a}) × ${b} ${plus ? "+" : "−"} ${c}`, answer: plus ? prod + c : prod - c,
            steps: [`A negative times a positive is negative: (−${a}) × ${b} = ${prod}`, `${plus ? "Add" : "Subtract"}: ${prod} ${plus ? "+" : "−"} ${c} = ${plus ? prod + c : prod - c}`] };
        },
      ];
      const q = (Math.random() < 0.24 ? negForms[randInt(0, negForms.length - 1)] : forms[randInt(0, forms.length - 1)])();
      return { prompt: `Work out (follow the order of operations):   ${q.prompt}`, answer: `${q.answer}`, hint: "Enter a number — it can be negative.", steps: q.steps };
    } },
  { id: "hcflcm", name: "HCF & LCM", icon: "➗", prereqs: ["arithmetic"],
    generate() {
      // a and b share a factor > 1 (HCF is never 1, LCM is never a × b),
      // and neither divides the other (so the answer is never one of the
      // two numbers).
      const base = [2, 3, 4, 5, 6][randInt(0, 4)];
      let m = randInt(2, 8), n = randInt(2, 8), tries = 0;
      while ((m === n || m % n === 0 || n % m === 0) && tries++ < 50) { m = randInt(2, 8); n = randInt(2, 8); }
      if (m === n || m % n === 0 || n % m === 0) { m = 4; n = 6; }
      const a = base * m, b = base * n, g = gcd(a, b), l = lcm(a, b);
      const mode = Math.random() < 0.5 ? "HCF" : "LCM";
      return { prompt: `Find the ${mode} of ${a} and ${b}`, answer: `${mode === "HCF" ? g : l}`, hint: "Enter a number.",
        steps: mode === "HCF"
          ? [`List the common factors of ${a} and ${b}, or use the Euclidean algorithm`, `HCF(${a}, ${b}) = ${g}`]
          : [`LCM = (${a} × ${b}) ÷ HCF(${a}, ${b})`, `HCF(${a}, ${b}) = ${g}`, `LCM = ${a * b} ÷ ${g} = ${l}`] };
    } },
  { id: "indices", name: "Indices", icon: "⚡", prereqs: [],
    generate() {
      // Covers the laws of indices: multiply, divide, power of a power,
      // zero index, negative index, fractional index / roots, combining
      // bases, quotients, and solving a^x = k.
      const alg = "e.g. 12x^5";
      const num = "Enter a number.";
      const fracHint = "Fraction or decimal.";
      const forms = [
        () => { // a^m × a^n = a^(m+n)
          const a = randInt(2, 6), b = randInt(2, 6), m = randInt(1, 4), n = randInt(1, 4);
          return { prompt: `Simplify:   ${a}x${pw(m)} × ${b}x${pw(n)}`, answer: `${a * b}x${pw(m + n)}`, hint: alg,
            steps: [`Multiply the coefficients: ${a} × ${b} = ${a * b}`, `Add the powers: x${pw(m)} × x${pw(n)} = x${pw(m + n)}`, `Answer: ${a * b}x${pw(m + n)}`] };
        },
        () => { // a^m ÷ a^n = a^(m−n)
          const a = randInt(2, 6), b = randInt(2, 5), m = randInt(1, 4), n = randInt(1, 3);
          return { prompt: `Simplify:   ${frac(`${a * b}x${pw(m + n)}`, `${b}x${pw(n)}`)}`, answer: `${a}x${pw(m)}`, hint: alg,
            steps: [`Divide the coefficients: ${frac(a * b, b)} = ${a}`, `Subtract the powers: ${frac(`x${pw(m + n)}`, `x${pw(n)}`)} = x${pw(m)}`, `Answer: ${a}x${pw(m)}`] };
        },
        () => { // (a^m)^n = a^(mn)
          const a = randInt(2, 4), m = randInt(1, 4), n = randInt(2, 3);
          return { prompt: `Simplify:   (${a}x${pw(m)})${sup(n)}`, answer: `${a ** n}x${pw(m * n)}`, hint: alg,
            steps: [`Raise the coefficient: ${a}${sup(n)} = ${a ** n}`, `Multiply the powers: (x${pw(m)})${sup(n)} = x${pw(m * n)}`, `Answer: ${a ** n}x${pw(m * n)}`] };
        },
        () => { // a^0 = 1
          const a = randInt(2, 9), m = randInt(2, 4);
          const asNum = Math.random() < 0.5;
          return asNum
            ? { prompt: `Evaluate:   ${a}${sup(0)}`, answer: `1`, hint: num, steps: [`Anything (except 0) to the power 0 is 1`, `${a}${sup(0)} = 1`] }
            : { prompt: `Simplify:   (${a}x${pw(m)})${sup(0)}`, answer: `1`, hint: num, steps: [`Anything to the power 0 is 1`, `(${a}x${pw(m)})${sup(0)} = 1`] };
        },
        () => { // a^(−m) = 1/a^m
          const a = randInt(2, 5), m = randInt(2, 3);
          return { prompt: `Evaluate:   ${a}${sup(`-${m}`)}`, answer: `1/${a ** m}`, answerDisplay: frac(1, a ** m), hint: fracHint,
            steps: [`A negative index means "one over": ${a}${sup(`-${m}`)} = ${frac(1, `${a}${sup(m)}`)}`, `${a}${sup(m)} = ${a ** m}`, `Answer: ${frac(1, a ** m)}`] };
        },
        () => { // a^(1/n) = ⁿ√a
          const base = randInt(2, 6), n = randInt(2, 3);
          return { prompt: `Evaluate:   ${base ** n}${supFrac(1, n)}`, answer: `${base}`, hint: num,
            steps: [`A power of ${frac(1, n)} means the ${n === 2 ? "square" : "cube"} root`, `${n === 2 ? "√" : "∛"}${base ** n} = ${base}`] };
        },
        () => { // a^(m/n) = (ⁿ√a)^m
          const base = randInt(2, 3);
          const [n, m] = [[2, 3], [3, 2]][randInt(0, 1)];
          return { prompt: `Evaluate:   ${base ** n}${supFrac(m, n)}`, answer: `${base ** m}`, hint: num,
            steps: [`${base ** n}${supFrac(m, n)} = (${n === 2 ? "√" : "∛"}${base ** n})${sup(m)} = ${base}${sup(m)}`, `Answer: ${base ** m}`] };
        },
        () => { // a^m × b^m = (ab)^m
          const a = randInt(2, 5), b = [2, 3, 4, 5].filter((x) => x !== a)[randInt(0, 2)], m = randInt(2, 3);
          return { prompt: `Evaluate:   ${a}${sup(m)} × ${b}${sup(m)}`, answer: `${(a * b) ** m}`, hint: num,
            steps: [`Same power, so combine the bases: ${a}${sup(m)} × ${b}${sup(m)} = (${a} × ${b})${sup(m)} = ${a * b}${sup(m)}`, `Answer: ${(a * b) ** m}`] };
        },
        () => { // (a/b)^n = a^n / b^n
          const a = randInt(2, 3), b = randInt(a + 1, 5), n = randInt(2, 3);
          return { prompt: `Evaluate:   (${frac(a, b)})${sup(n)}`, answer: `${a ** n}/${b ** n}`, answerDisplay: frac(a ** n, b ** n), hint: fracHint,
            steps: [`Raise the top and bottom separately: (${frac(a, b)})${sup(n)} = ${frac(`${a}${sup(n)}`, `${b}${sup(n)}`)}`, `Answer: ${frac(a ** n, b ** n)}`] };
        },
        () => { // if a^x = a^k then x = k
          const base = randInt(2, 4), k = randInt(2, 5);
          return { prompt: `Solve for x:   ${base}${sup("x")} = ${base ** k}`, answer: `${k}`, hint: num,
            steps: [`Write the right side as a power of ${base}: ${base ** k} = ${base}${sup(k)}`, `Equal bases means equal powers: x = ${k}`] };
        },
        () => { // b^m × b^n → b^(m+n), leave in index form
          const b = [2, 3, 5, 7][randInt(0, 3)], m = randInt(2, 6), n = randInt(2, 4);
          return { prompt: `Write as a single power:   ${b}${sup(m)} × ${b}${sup(n)}`,
            answer: `${b}^${m + n}`, answerDisplay: `${b}${sup(m + n)}`, hint: `Leave it as a power, e.g. ${b}^${m + n + 1}`,
            check: (inp) => checkIndexForm(inp, b, m + n),
            steps: [`Same base — add the powers: ${m} + ${n} = ${m + n}`, `Answer: ${b}${sup(m + n)}`] };
        },
        () => { // b^m ÷ b^n → b^(m−n), leave in index form
          const b = [2, 3, 5, 7][randInt(0, 3)], n = randInt(1, 4), m = n + randInt(2, 6);
          return { prompt: `Write as a single power:   ${frac(`${b}${sup(m)}`, `${b}${sup(n)}`)}`,
            answer: `${b}^${m - n}`, answerDisplay: `${b}${sup(m - n)}`, hint: `Leave it as a power, e.g. ${b}^${m - n + 1}`,
            check: (inp) => checkIndexForm(inp, b, m - n),
            steps: [`Same base — subtract the powers: ${m} − ${n} = ${m - n}`, `Answer: ${b}${sup(m - n)}`] };
        },
        () => { // (b^m)^n → b^(mn), leave in index form
          const b = [2, 3, 5][randInt(0, 2)], m = randInt(2, 4), n = randInt(2, 3);
          return { prompt: `Write as a single power:   (${b}${sup(m)})${sup(n)}`,
            answer: `${b}^${m * n}`, answerDisplay: `${b}${sup(m * n)}`, hint: `Leave it as a power, e.g. ${b}^${m * n + 1}`,
            check: (inp) => checkIndexForm(inp, b, m * n),
            steps: [`Power of a power — multiply the powers: ${m} × ${n} = ${m * n}`, `Answer: ${b}${sup(m * n)}`] };
        },
      ];
      return forms[randInt(0, forms.length - 1)]();
    } },
  { id: "surds", name: "Surds", icon: "√", prereqs: ["indices"],
    generate() {
      const surdHint = "e.g. 3√5, sqrt(45) or a decimal";
      const forms = [
        () => { // simplify √N
          const k = randInt(2, 6), b = [2, 3, 5, 6, 7, 10, 11][randInt(0, 6)];
          return { prompt: `Simplify:   √${k * k * b}`, answer: surdStr(k, b), hint: surdHint,
            check: (inp) => checkSimplifiedSurd(inp, surdStr(k, b)),
            steps: [`Find the biggest square factor: ${k * k * b} = ${k * k} × ${b}`, `√${k * k * b} = √${k * k} × √${b} = ${k}√${b}`] };
        },
        () => { // √a × √b, product a perfect square → whole number
          const r = randInt(3, 9), sq = r * r;
          const opts = [];
          for (let a = 2; a * a <= sq; a++) if (sq % a === 0) opts.push([a, sq / a]);
          const [a, b] = opts[randInt(0, opts.length - 1)];
          return { prompt: `Simplify:   √${a} × √${b}`, answer: `${r}`, hint: "Enter a number.",
            steps: [`Multiply under one root: √${a} × √${b} = √(${a} × ${b}) = √${sq}`, `√${sq} = ${r}`] };
        },
        () => { // p√a × q√b → simplified surd
          const p = randInt(1, 3), q = randInt(1, 3);
          const pool = [2, 3, 5, 6, 7]; // non-square radicands
          const a = pool[randInt(0, 4)], b = pool[randInt(0, 4)];
          const { c, d } = surdParts(p * q, a * b);
          return { prompt: `Simplify:   ${surdStr(p, a)} × ${surdStr(q, b)}`, answer: surdStr(c, d), hint: surdHint,
            check: (inp) => checkSimplifiedSurd(inp, surdStr(c, d)),
            steps: [`Multiply the numbers and the roots separately: ${p} × ${q} = ${p * q},  √${a} × √${b} = √${a * b}`, `${p * q}√${a * b}${d === a * b ? "" : ` = ${surdStr(c, d)}`}`] };
        },
        () => { // rationalise a / √b
          const b = [2, 3, 5, 6, 7, 10, 11, 13][randInt(0, 7)];
          const a = randInt(1, 6), g = gcd(a, b), nc = a / g, den = b / g;
          const ans = den === 1 ? surdStr(nc, b) : `${nc === 1 ? "" : nc}√${b}/${den}`;
          const ansDisp = den === 1 ? surdStr(nc, b) : frac(`${nc === 1 ? "" : nc}√${b}`, `${den}`);
          return {
            prompt: `Rationalise the denominator:   ${frac(`${a}`, `√${b}`)}`,
            answer: ans, answerDisplay: ansDisp, hint: "e.g. 3√5/5",
            check: (inp) => {
              const s = String(inp).replace(/\s/g, "");
              return checkEquivalent(inp, ans) && /√|sqrt/i.test(s) && !/\/[^/]*(√|sqrt)/i.test(s);
            },
            steps: [
              `Multiply top and bottom by √${b}:  ${frac(`${a}`, `√${b}`)} × ${frac(`√${b}`, `√${b}`)}`,
              `= ${frac(`${a}√${b}`, `${b}`)}`,
              g === 1 ? `= ${ansDisp}` : `Cancel the common factor ${g}:  = ${ansDisp}`,
            ],
          };
        },
      ];
      return forms[randInt(0, forms.length - 1)]();
    } },
  { id: "standardform", name: "Standard Form", icon: "🔟", prereqs: ["indices"],
    generate() {
      const sfHint = "e.g. 4.5*10^4 or 4.5e-4";
      const norm = (value) => { // positive value → { mant (1–10), exp }
        let exp = 0, mant = value;
        while (mant >= 10) { mant /= 10; exp += 1; }
        while (mant > 0 && mant < 1) { mant *= 10; exp -= 1; }
        return { mant: Math.round(mant * 1e6) / 1e6, exp };
      };
      const forms = [
        () => { // ordinary number → standard form (positive OR negative power)
          const mant = randInt(11, 99) / 10;
          const exp = [-5, -4, -3, -2, 3, 4, 5, 6, 7][randInt(0, 8)];
          const value = mant * Math.pow(10, exp);
          const shown = exp < 0 ? value.toFixed(-exp + 1) : String(Math.round(value));
          return { prompt: `Write ${shown} in standard form`, answer: sfString(mant, exp), answerDisplay: sfPretty(mant, exp), hint: sfHint,
            check: (inp) => isStdForm(inp, value),
            steps: [`Put the decimal point after the first non-zero digit: ${mant}`,
              `Count the places moved: ${Math.abs(exp)}${exp < 0 ? " — the number is below 1, so the power is negative" : ""}`,
              `Answer: ${sfPretty(mant, exp)}`] };
        },
        () => { // standard form → ordinary number
          const mant = randInt(11, 99) / 10;
          const exp = [-4, -3, -2, 2, 3, 4, 5][randInt(0, 6)];
          const value = mant * Math.pow(10, exp);
          const shown = exp < 0 ? Number(value.toPrecision(12)).toString() : String(Math.round(value));
          return { prompt: `Write ${sfPretty(mant, exp)} as an ordinary number`, answer: shown, hint: "Enter a number.",
            check: (inp) => isOrdinary(inp, value),
            steps: [`Move the decimal point ${Math.abs(exp)} place${Math.abs(exp) === 1 ? "" : "s"} ${exp < 0 ? "left" : "right"}`,
              `${sfPretty(mant, exp)} = ${shown}`] };
        },
        () => { // multiply two standard-form numbers
          const m1 = randInt(2, 6), m2 = randInt(2, 5);
          const e1 = [-3, -2, 2, 3, 4][randInt(0, 4)], e2 = [-2, 2, 3, 4, 5][randInt(0, 4)];
          const value = m1 * m2 * Math.pow(10, e1 + e2);
          const { mant, exp } = norm(value);
          return { prompt: `Work out, in standard form:   (${m1} × ${pow10(e1)}) × (${m2} × ${pow10(e2)})`, answer: sfString(mant, exp), answerDisplay: sfPretty(mant, exp), hint: sfHint,
            check: (inp) => isStdForm(inp, value),
            steps: [`Multiply the numbers: ${m1} × ${m2} = ${m1 * m2}`, `Add the powers: ${pow10(e1)} × ${pow10(e2)} = ${pow10(e1 + e2)}`,
              m1 * m2 >= 10 ? `Adjust so the first part is 1–10: ${m1 * m2} × ${pow10(e1 + e2)} = ${sfPretty(mant, exp)}` : `Answer: ${sfPretty(mant, exp)}`] };
        },
        () => { // add or subtract two standard-form numbers
          const exp = [-3, -2, 2, 3, 4, 5][randInt(0, 5)];
          const plus = Math.random() < 0.5;
          const same = Math.random() < 0.35;
          let prompt, value, matchStep;
          if (same) {
            const a = randInt(2, 9), b = plus ? randInt(2, 9) : randInt(1, a - 1);
            prompt = `Work out, in standard form:   ${a} × ${pow10(exp)} ${plus ? "+" : "−"} ${b} × ${pow10(exp)}`;
            value = (plus ? a + b : a - b) * Math.pow(10, exp);
            matchStep = `Same power of 10 — just ${plus ? "add" : "subtract"} the front numbers: ${a} ${plus ? "+" : "−"} ${b} = ${plus ? a + b : a - b}`;
          } else {
            const diff = randInt(1, 2), e2 = exp - diff; // second number has the smaller power
            const a = randInt(2, 9), b = randInt(1, 9);
            prompt = `Work out, in standard form:   ${a} × ${pow10(exp)} ${plus ? "+" : "−"} ${b} × ${pow10(e2)}`;
            value = a * Math.pow(10, exp) + (plus ? 1 : -1) * b * Math.pow(10, e2);
            matchStep = `Give both the same power of 10:  ${b} × ${pow10(e2)} = ${b / Math.pow(10, diff)} × ${pow10(exp)},  then ${plus ? "add" : "subtract"}`;
          }
          const { mant, exp: ex } = norm(value);
          return { prompt, answer: sfString(mant, ex), answerDisplay: sfPretty(mant, ex), hint: sfHint,
            check: (inp) => isStdForm(inp, value),
            steps: [matchStep, `= ${value}`, `In standard form: ${sfPretty(mant, ex)}`] };
        },
      ];
      return forms[randInt(0, forms.length - 1)]();
    } },
  { id: "sigfig", name: "Rounding", icon: "🎯", prereqs: [],
    generate() {
      // Every number is built as a digit string (no float noise) with more
      // detail than the question asks for, so real rounding always happens.
      const clean = (x) => Number(x.toPrecision(12));
      const digStr = (len) => {
        let s = String(randInt(1, 9));
        for (let i = 1; i < len; i++) s += i === len - 1 ? randInt(1, 9) : randInt(0, 9);
        return s; // `len` significant digits, first and last non-zero
      };
      const build = () => {
        const mode = randInt(0, 2);
        if (mode === 0) { // significant figures
          const d = randInt(3, 6), sf = randInt(1, d - 1), digs = digStr(d);
          const st = [0, 1, 2, 3, 4][randInt(0, 4)];
          const rawStr = st === 0 ? digs
            : st === 1 ? `${digs[0]}.${digs.slice(1)}`
            : st === 2 ? `${digs.slice(0, 2)}.${digs.slice(2)}`
            : st === 3 ? `0.${digs}`
            : `0.00${digs}`;
          const raw = parseFloat(rawStr);
          return { raw, rawStr, ans: `${clean(roundToSF(raw, sf))}`, label: `${sf} significant figure${sf > 1 ? "s" : ""}`,
            how: `Count from the first non-zero digit and keep ${sf}` };
        }
        if (mode === 1) { // decimal places
          const dp = randInt(1, 4), rawStr = `${randInt(1, 400)}.${digStr(dp + randInt(1, 2))}`;
          const raw = parseFloat(rawStr);
          return { raw, rawStr, ans: (Math.round(raw * 10 ** dp) / 10 ** dp).toFixed(dp), label: `${dp} decimal place${dp > 1 ? "s" : ""}`,
            how: `Keep ${dp} digit${dp > 1 ? "s" : ""} after the decimal point` };
        }
        // nearest place value
        const places = [["ten", 10], ["hundred", 100], ["thousand", 1000], ["whole number", 1], ["tenth", 0.1], ["hundredth", 0.01]];
        const [name, unit] = places[randInt(0, places.length - 1)];
        let rawStr;
        if (unit >= 10) rawStr = digStr(String(unit).length + randInt(1, 2));
        else if (unit === 1) rawStr = `${randInt(1, 900)}.${digStr(randInt(1, 3))}`;
        else rawStr = `${randInt(1, 99)}.${digStr(String(1 / unit).length + randInt(1, 2))}`;
        const raw = parseFloat(rawStr);
        const rounded = Math.round(raw / unit) * unit;
        const decs = unit < 1 ? String(unit).split(".")[1].length : 0;
        return { raw, rawStr, ans: decs ? rounded.toFixed(decs) : `${clean(rounded)}`, label: `the nearest ${name}`,
          how: `Round to the nearest ${name}` };
      };
      let q;
      for (let i = 0; i < 15; i++) { q = build(); if (Math.abs(parseFloat(q.ans) - q.raw) > 1e-9) break; }
      return { prompt: `Round ${q.rawStr} to ${q.label}`, answer: q.ans, hint: "Enter a number.",
        steps: [q.how, `Use the next digit to decide whether to round up`, `Answer: ${q.ans}`] };
    } },
  { id: "limits", name: "Limits of Accuracy", icon: "📏", prereqs: ["sigfig"],
    generate() {
      const clean = (x) => Number(x.toPrecision(12));
      const units = [
        { u: "cm", noun: "length", precs: [1, 2, 5, 10, 0.5] },
        { u: "mm", noun: "length", precs: [1, 5, 10] },
        { u: "m", noun: "distance", precs: [1, 5, 10, 100, 0.1, 0.5] },
        { u: "km", noun: "distance", precs: [1, 5, 10, 0.1] },
        { u: "g", noun: "mass", precs: [1, 5, 10, 100] },
        { u: "kg", noun: "mass", precs: [1, 5, 10, 0.1, 0.5] },
        { u: "ml", noun: "volume", precs: [1, 5, 10] },
        { u: "litres", noun: "volume", precs: [1, 0.1, 0.5] },
        { u: "seconds", noun: "time", precs: [1, 5, 10, 0.1] },
      ];
      const singularOf = (u) => ({ litres: "litre", seconds: "second" }[u] || u);
      const precLabelOf = (u, prec) => (prec === 1 ? `nearest ${singularOf(u)}` : `nearest ${clean(prec)} ${u}`);
      const genMeasure = (spec) => {
        const prec = spec.precs[randInt(0, spec.precs.length - 1)];
        const v = clean(randInt(3, 40) * prec);
        return { v, prec, half: clean(prec / 2), label: precLabelOf(spec.u, prec) };
      };

      // combined measure: a result worked out FROM two measured values
      // (speed = distance ÷ time, area = length × width, ...) — the
      // upper/lower bound of the result depends on the operation:
      // multiplying, both inputs push the same way; dividing, the
      // denominator pushes the opposite way (÷ a smaller number → a
      // bigger result, so the upper bound takes the numerator's upper
      // bound but the denominator's LOWER bound).
      if (Math.random() < 0.4) {
        const U = Object.fromEntries(units.map((u) => [u.u, u]));
        const scenarios = [
          { result: "speed", op: "÷", aKey: "m", aNoun: "distance", bKey: "seconds", bNoun: "time", resultUnit: "m/s", formula: "speed = distance ÷ time" },
          { result: "density", op: "÷", aKey: "g", aNoun: "mass", bKey: "ml", bNoun: "volume", resultUnit: "g/ml", formula: "density = mass ÷ volume" },
          { result: "average speed", op: "÷", aKey: "km", aNoun: "distance", bKey: "seconds", bNoun: "time", resultUnit: "km/s", formula: "speed = distance ÷ time" },
          { result: "area", op: "×", aKey: "cm", aNoun: "length", bKey: "cm", bNoun: "width", resultUnit: "cm²", formula: "area = length × width" },
          { result: "area", op: "×", aKey: "m", aNoun: "length", bKey: "m", bNoun: "width", resultUnit: "m²", formula: "area = length × width" },
        ];
        const sc = scenarios[randInt(0, scenarios.length - 1)];
        const A = genMeasure(U[sc.aKey]), B = genMeasure(U[sc.bKey]);
        const bound = Math.random() < 0.5 ? "upper" : "lower";
        // which bound of A, and of B, gives the asked-for bound of the result
        const aBoundUp = bound === "upper";
        const bBoundUp = sc.op === "×" ? bound === "upper" : bound === "lower";
        const aVal = clean(aBoundUp ? A.v + A.half : A.v - A.half);
        const bVal = clean(bBoundUp ? B.v + B.half : B.v - B.half);
        const raw = sc.op === "×" ? aVal * bVal : aVal / bVal;
        const result = sc.op === "×" ? clean(raw) : Number(raw.toPrecision(4)); // ÷ results are often recurring decimals
        return {
          prompt: `${sc.formula}.\nThe ${sc.aNoun} is measured as ${A.v} ${U[sc.aKey].u} (to the ${A.label}) and the ${sc.bNoun} as ${B.v} ${U[sc.bKey].u} (to the ${B.label}).\nFind the ${bound} bound of the ${sc.result}, in ${sc.resultUnit}`,
          answer: `${result}`, hint: `Enter a number, in ${sc.resultUnit}.`,
          steps: sc.op === "×"
            ? [
                `To get the ${bound} bound of a product, use the ${bound} bound of both measurements`,
                `${sc.aNoun}: ${bound} bound = ${A.v} ${aBoundUp ? "+" : "−"} ${A.half} = ${aVal} ${U[sc.aKey].u}`,
                `${sc.bNoun}: ${bound} bound = ${B.v} ${bBoundUp ? "+" : "−"} ${B.half} = ${bVal} ${U[sc.bKey].u}`,
                `${sc.result} ${bound} bound = ${aVal} × ${bVal} = ${result} ${sc.resultUnit}`,
              ]
            : [
                `Dividing by a smaller number gives a bigger answer, so the ${bound} bound of ${sc.result} takes the ${bound} bound of ${sc.aNoun} and the ${bound === "upper" ? "lower" : "upper"} bound of ${sc.bNoun}`,
                `${sc.aNoun}: ${bound} bound = ${A.v} ${aBoundUp ? "+" : "−"} ${A.half} = ${aVal} ${U[sc.aKey].u}`,
                `${sc.bNoun}: ${bBoundUp ? "upper" : "lower"} bound = ${B.v} ${bBoundUp ? "+" : "−"} ${B.half} = ${bVal} ${U[sc.bKey].u}`,
                `${sc.result} ${bound} bound = ${aVal} ÷ ${bVal} = ${result} ${sc.resultUnit}`,
              ],
        };
      }

      const pick = units[randInt(0, units.length - 1)];
      const { v, half, label: precLabel } = genMeasure(pick);
      const bound = Math.random() < 0.5 ? "upper" : "lower";
      const ans = clean(bound === "upper" ? v + half : v - half);
      return {
        prompt: `A ${pick.noun} is measured as ${v} ${pick.u}, correct to the ${precLabel}. Find the ${bound} bound`,
        answer: `${ans}`, hint: "Enter a number.",
        steps: [
          `"${precLabel}" means the true value is within ${half} ${pick.u} of ${v}`,
          `${bound === "upper" ? "Upper" : "Lower"} bound = ${v} ${bound === "upper" ? "+" : "−"} ${half} = ${ans}`,
        ],
      };
    } },
  { id: "time", name: "Time", icon: "⏰", prereqs: [],
    generate() {
      const fmt = (mins) => { mins = ((mins % 1440) + 1440) % 1440; return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`; };
      const durText = (mins) => {
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h && m) return `${h} hour${h > 1 ? "s" : ""} ${m} minute${m > 1 ? "s" : ""}`;
        if (h) return `${h} hour${h > 1 ? "s" : ""}`;
        return `${m} minutes`;
      };
      const who = ["Hafiz", "Aisha", "Mei Ling", "Daniel", "Siti", "the bus", "the train", "the ferry"][randInt(0, 7)];
      const mode = randInt(0, 3);

      if (mode === 0) {
        const h = randInt(1, 4), m = randInt(1, 59);
        return { prompt: `A journey takes ${h} hour${h > 1 ? "s" : ""} and ${m} minutes. How many minutes is that in total?`, answer: `${h * 60 + m}`, hint: "Enter a number.",
          steps: [`Convert hours to minutes: ${h} × 60 = ${h * 60}`, `Add the extra minutes: ${h * 60} + ${m} = ${h * 60 + m}`] };
      }

      const start = randInt(5, 14) * 60 + randInt(0, 59);
      const dur = randInt(1, 5) * 60 + randInt(5, 55);
      const end = start + dur;

      if (mode === 1) {
        return { prompt: `${who} left at ${fmt(start)} and the journey took ${durText(dur)}. What time did ${/the /.test(who) ? "it" : "they"} arrive?`,
          answer: fmt(end), hint: "e.g. 14:35", check: (inp) => parseClock(inp) != null && parseClock(inp) % 720 === (end % 1440) % 720,
          steps: [`Start ${fmt(start)}, add ${Math.floor(dur / 60)} h → ${fmt(start + Math.floor(dur / 60) * 60)}`, `Then add ${dur % 60} min → ${fmt(end)}`, `Arrived at ${fmt(end)}`] };
      }
      if (mode === 2) {
        return { prompt: `${who} arrived at ${fmt(end)} after a journey of ${durText(dur)}. What time did ${/the /.test(who) ? "it" : "they"} leave?`,
          answer: fmt(start), hint: "e.g. 09:20", check: (inp) => parseClock(inp) != null && parseClock(inp) % 720 === (start % 1440) % 720,
          steps: [`Arrival ${fmt(end)}, subtract ${Math.floor(dur / 60)} h → ${fmt(end - Math.floor(dur / 60) * 60)}`, `Then subtract ${dur % 60} min → ${fmt(start)}`, `Left at ${fmt(start)}`] };
      }
      const dh = Math.floor(dur / 60), dm = dur % 60;
      const askHM = Math.random() < 0.75;
      return { prompt: `${who} left at ${fmt(start)} and arrived at ${fmt(end)}. How ${askHM ? "many hours and minutes" : "many minutes"} did the journey take?`,
        answer: askHM ? `${dh} h ${dm} min` : `${dur}`,
        hint: askHM ? "e.g. 2 h 15 min" : "Enter a number.",
        check: (inp) => parseDuration(inp) === dur,
        steps: [`From ${fmt(start)} to ${fmt(start + dh * 60)} is ${dh} h = ${dh * 60} min`, `Then ${dm} more min to ${fmt(end)}`, `Total = ${dh} h ${dm} min (${dur} minutes)`] };
    } },
  { id: "algebra", name: "Algebra", icon: "🧮", prereqs: [],
    generate() {
      const nz = (lo, hi) => { let n = 0; while (n === 0) n = randInt(lo, hi); return n; };
      const sign = () => (Math.random() < 0.5 ? 1 : -1);
      const xt = (n) => (n === 1 ? "x" : n === -1 ? "-x" : `${n}x`);
      const moveText = (k) => (k > 0 ? `Subtract ${k} from both sides` : `Add ${-k} to both sides`);
      const divText = (k, x) => (k === 1 ? `x = ${x}` : k === -1 ? `Multiply both sides by −1:  x = ${x}` : `Divide both sides by ${k}:  x = ${x}`);
      const build = () => {
        const r = Math.random();
        if (r < 0.37) {
          // a x + b = c
          const a = nz(-9, 9), x = nz(-9, 9), b = nz(-9, 9), c = a * x + b;
          if (c === 0) return null;
          return { prompt: `Solve for x:   ${xt(a)} ${spaced(b)} = ${c}`, answer: `${x}`,
            steps: [`${moveText(b)}:  ${xt(a)} = ${c - b}`, ...(a === 1 ? [] : [divText(a, x)])] };
        }
        if (r < 0.55) {
          // a x + b = c x + d
          const a = nz(-9, 9), c = nz(-9, 9);
          if (a === c) return null;
          const x = nz(-9, 9), b = nz(-9, 9), d = (a - c) * x + b;
          if (d === 0) return null;
          return { prompt: `Solve for x:   ${xt(a)} ${spaced(b)} = ${xt(c)} ${spaced(d)}`, answer: `${x}`,
            steps: [`Bring the x-terms to one side:  ${xt(a - c)} ${spaced(b)} = ${d}`, `${moveText(b)}:  ${xt(a - c)} = ${d - b}`, ...(a - c === 1 ? [] : [divText(a - c, x)])] };
        }

        // 15% — expand a bracket first
        if (r < 0.70) {
          if (Math.random() < 0.35) {
            // p(x + q) = m(x + n)
            const p = randInt(2, 5), m = randInt(2, 5), x = nz(-8, 8), q = nz(-8, 8);
            if (p === m) return null;
            const numer = (p - m) * x + p * q;
            if (numer % m !== 0) return null;
            const n = numer / m;
            if (n === 0) return null;
            return { prompt: `Solve for x:   ${p}(x ${spaced(q)}) = ${m}(x ${spaced(n)})`, answer: `${x}`,
              steps: [
                `Expand both sides:  ${p}x ${spaced(p * q)} = ${m}x ${spaced(m * n)}`,
                `Bring the x-terms together:  ${xt(p - m)} ${spaced(p * q)} = ${m * n}`,
                `${moveText(p * q)}:  ${xt(p - m)} = ${m * n - p * q}`,
                ...(p - m === 1 ? [] : [divText(p - m, x)]),
              ] };
          }
          // p(cx + q) [+ s] = r
          const p = randInt(2, 5), c = randInt(1, 3), x = nz(-9, 9), q = nz(-9, 9);
          const s = Math.random() < 0.5 ? 0 : nz(-9, 9);
          const con = p * q + s;
          if (con === 0) return null;
          const rhs = p * c * x + con;
          if (rhs === 0) return null;
          const cx = c === 1 ? "x" : `${c}x`;
          const lhs = s === 0 ? `${p}(${cx} ${spaced(q)})` : `${p}(${cx} ${spaced(q)}) ${spaced(s)}`;
          return { prompt: `Solve for x:   ${lhs} = ${rhs}`, answer: `${x}`,
            steps: [
              `Expand the bracket:  ${xt(p * c)} ${spaced(con)} = ${rhs}`,
              `${moveText(con)}:  ${xt(p * c)} = ${rhs - con}`,
              divText(p * c, x),
            ] };
        }

        // 12% — square both sides / take the square root
        if (r < 0.82) {
          const k = randInt(2, 12);
          const A = Math.random() < 0.4 ? randInt(2, 4) : 1;
          const b = Math.random() < 0.5 ? 0 : nz(-20, 20);
          const cc = A * k * k + b;
          if (cc === 0) return null;
          const lead = A === 1 ? "x²" : `${A}x²`;
          const lhs = b === 0 ? lead : `${lead} ${spaced(b)}`;
          return {
            prompt: `Solve for x:   ${lhs} = ${cc}`,
            answer: `${k}`, answerDisplay: `±${k}`, hint: "x can be positive or negative — either is fine",
            check: (inp) => {
              let s = String(inp).trim().replace(/±/g, "").replace(/\+\/-/g, "").replace(/\+-/g, "").trim();
              try { const v = evalString(s, 1); return Number.isFinite(v) && Math.abs(Math.abs(v) - k) < 1e-6; }
              catch (e) { return false; }
            },
            steps: [
              ...(b !== 0 ? [`${moveText(b)}:  ${lead} = ${A * k * k}`] : []),
              ...(A !== 1 ? [`Divide both sides by ${A}:  x² = ${k * k}`] : []),
              `Square-root both sides:  x = ${k}  or  x = -${k}`,
            ],
          };
        }

        // Fractions — five shapes: x/n, (ax)/n, (ax+b)/n, m/x, m/(ax)
        const form = randInt(0, 4);

        if (form === 0) {
          // x / den + b = c
          const den = randInt(2, 9), k = nz(-6, 6), x = den * k, b = nz(-9, 9), c = k + b;
          if (c === 0) return null;
          return { prompt: `Solve for x:   ${frac("x", `${den}`)} ${spaced(b)} = ${c}`, answer: `${x}`,
            steps: [`${moveText(b)}:  ${frac("x", `${den}`)} = ${k}`, `Multiply both sides by ${den}:  x = ${x}`] };
        }
        if (form === 1) {
          // (a x) / den + b = c
          const a = sign() * randInt(2, 6), x = nz(-9, 9), ax = a * x;
          const dens = [2, 3, 4, 5, 6, 7, 8, 9].filter((d) => ax % d === 0);
          if (!dens.length) return null;
          const den = dens[randInt(0, dens.length - 1)], k = ax / den;
          const b = nz(-9, 9), c = k + b;
          if (c === 0) return null;
          return { prompt: `Solve for x:   ${frac(xt(a), `${den}`)} ${spaced(b)} = ${c}`, answer: `${x}`,
            steps: [`${moveText(b)}:  ${frac(xt(a), `${den}`)} = ${k}`, `Multiply both sides by ${den}:  ${xt(a)} = ${den * k}`, `Divide both sides by ${a}:  x = ${x}`] };
        }
        if (form === 2) {
          // (a x + b) / den = c
          const den = randInt(2, 9), a = nz(-6, 6), x = nz(-9, 9), c = nz(-6, 6), b = c * den - a * x;
          if (b === 0) return null;
          return { prompt: `Solve for x:   ${frac(`${xt(a)} ${spaced(b)}`, `${den}`)} = ${c}`, answer: `${x}`,
            steps: [`Multiply both sides by ${den}:  ${xt(a)} ${spaced(b)} = ${c * den}`, `${moveText(b)}:  ${xt(a)} = ${c * den - b}`, ...(a === 1 ? [] : [divText(a, x)])] };
        }
        if (form === 3) {
          // m / x + b = c
          const x = nz(-9, 9), k = nz(-9, 9), num = k * x;
          const b = Math.random() < 0.4 ? 0 : nz(-9, 9), c = k + b;
          if (c === 0) return null;
          const tail = b === 0 ? "" : ` ${spaced(b)}`;
          return { prompt: `Solve for x:   ${frac(`${num}`, "x")}${tail} = ${c}`, answer: `${x}`,
            steps: [
              ...(b !== 0 ? [`${moveText(b)}:  ${frac(`${num}`, "x")} = ${k}`] : []),
              `Multiply both sides by x:  ${num} = ${xt(k)}`,
              divText(k, x),
            ] };
        }
        // form 4 — m / (a x) + b = c  (denominator coefficient kept positive)
        const a = randInt(2, 5), x = nz(-7, 7), k = nz(-5, 5), num = a * k * x;
        const b = Math.random() < 0.4 ? 0 : nz(-9, 9), c = k + b;
        if (c === 0) return null;
        const tail = b === 0 ? "" : ` ${spaced(b)}`;
        return { prompt: `Solve for x:   ${frac(`${num}`, xt(a))}${tail} = ${c}`, answer: `${x}`,
          steps: [
            ...(b !== 0 ? [`${moveText(b)}:  ${frac(`${num}`, xt(a))} = ${k}`] : []),
            `Multiply both sides by ${xt(a)}:  ${num} = ${a * k}x`,
            `Divide both sides by ${a * k}:  x = ${x}`,
          ] };
      };
      let q;
      for (let i = 0; i < 40; i++) { q = build(); if (q) break; }
      return { hint: "Enter a whole number.", ...q };
    } },
  { id: "factorization", name: "Factorisation", icon: "🧩", prereqs: ["algebra"],
    generate() {
      const nz = (lo, hi) => { let n = 0; while (n === 0) n = randInt(lo, hi); return n; };
      const pick = (arr) => arr[randInt(0, arr.length - 1)];
      const sgn = (n) => (n >= 0 ? "+" : "-");
      const co = (n) => (Math.abs(n) === 1 ? "" : `${Math.abs(n)}`); // coefficient text, hides a bare 1
      const xterm = (n) => (n === 0 ? "" : ` ${sgn(n)} ${co(n)}x`);
      // a nonzero value in [lo,hi] that is coprime to m
      const coprime = (m, lo, hi) => {
        const opts = [];
        for (let v = lo; v <= hi; v++) if (v !== 0 && gcd(Math.abs(v), m) === 1) opts.push(v);
        return opts[randInt(0, opts.length - 1)];
      };
      const r = Math.random();

      // 10% — take out a common factor
      if (r < 0.10) {
        const g = randInt(2, 6);
        if (Math.random() < 0.6) {
          const m = randInt(1, 6), n = coprime(m, -6, 6), A = g * m, B = g * n;
          return { prompt: `Factorise:   ${A}x² ${sgn(B)} ${Math.abs(B)}x`,
            answer: `${g}x(${co(m)}x${tight(n)})`, hint: "Take out the biggest common factor first",
            steps: [`Both terms share ${g}x`, `${A}x² ${sgn(B)} ${Math.abs(B)}x = ${g}x(${co(m)}x ${sgn(n)} ${Math.abs(n)})`] };
        }
        const m = randInt(1, 6), n = coprime(m, 2, 9), A = g * m, B = g * n;
        return { prompt: `Factorise:   ${A}x + ${B}`,
          answer: `${g}(${co(m)}x+${n})`, hint: "Take out the biggest common factor first",
          steps: [`Both terms share ${g}`, `${A}x + ${B} = ${g}(${co(m)}x + ${n})`] };
      }

      // 10% — difference of two squares
      if (r < 0.20) {
        const k = randInt(2, 12);
        return { prompt: `Factorise:   x² - ${k * k}`,
          answer: `(x+${k})(x-${k})`, hint: "a² - b² = (a + b)(a - b)",
          steps: [`${k * k} = ${k}²`, `x² - ${k}² = (x + ${k})(x - ${k})`] };
      }

      // 10% — leading coefficient of 2 or 3  (b coprime to lead ⇒ middle term never 0)
      if (r < 0.30) {
        const lead = Math.random() < 0.5 ? 2 : 3;
        const b = coprime(lead, -6, 6), d = nz(-6, 6);
        const B = lead * d + b, C = b * d;
        return { prompt: `Factorise:   ${lead}x² ${sgn(B)} ${co(B)}x ${sgn(C)} ${Math.abs(C)}`,
          answer: `(${lead}x${tight(b)})(x${tight(d)})`, hint: "e.g. (2x+1)(x-3)",
          steps: [`Multiply the ends: ${lead} × ${C} = ${lead * C}`,
            `Two numbers with product ${lead * C} and sum ${B}: ${lead * d} and ${b}`,
            `= (${lead}x ${sgn(b)} ${Math.abs(b)})(x ${sgn(d)} ${Math.abs(d)})`] };
      }

      // 10% — perfect square
      if (r < 0.40) {
        const n = nz(-9, 9), B = 2 * n, C = n * n;
        return { prompt: `Factorise:   x² ${sgn(B)} ${Math.abs(B)}x + ${C}`,
          answer: `(x${tight(n)})^2`, hint: "It's a perfect square: (x + a)²",
          steps: [`Half the x-term: ${B} ÷ 2 = ${n}`, `${n}² = ${C} ✓`, `= (x ${sgn(n)} ${Math.abs(n)})²`] };
      }

      // 14% — by factorising, solve x² + bx + c = 0
      if (r < 0.54) {
        // factors (x + a)(x + b)  ⇒  roots are −a and −b
        const a = nz(-8, 8), b = nz(-8, 8);
        const B = a + b, C = a * b;
        const tail = `${xterm(B)} ${spaced(C)}`.replace(/\s+/g, " ").trim();
        const roots = a === b ? [-a] : [Math.min(-a, -b), Math.max(-a, -b)];
        return {
          prompt: `By factorising, solve:   x² ${tail} = 0`,
          answer: roots.map((v) => `x = ${v}`).join(",  "),
          hint: a === b ? "one repeated solution" : "give both values of x, separated by a comma",
          check: (inp) => {
            const ns = String(inp).match(/-?\d+(?:\.\d+)?/g);
            if (!ns || ns.length !== roots.length) return false;
            const g = ns.map(Number).sort((u, v) => u - v);
            return roots.every((rt, i) => Math.abs(g[i] - rt) < 1e-9);
          },
          steps: [
            `Factorise:  x² ${tail} = (x${tight(a)})(x${tight(b)})`,
            `(x${tight(a)})(x${tight(b)}) = 0`,
            a === b
              ? `x ${sgn(a)} ${Math.abs(a)} = 0,  so x = ${-a}`
              : `x ${sgn(a)} ${Math.abs(a)} = 0   or   x ${sgn(b)} ${Math.abs(b)} = 0`,
            a === b ? "" : `x = ${roots[0]}   or   x = ${roots[1]}`,
          ].filter(Boolean),
        };
      }

      // 12% — quadratic formula, answer to 2 decimal places (never factorises)
      if (r < 0.66) {
        const near5 = (n) => Math.abs(Math.abs((n * 100) % 1) - 0.5) < 0.08;
        let a, b, c, D;
        for (let i = 0; i < 200; i++) {
          a = pick([1, 1, 2]);
          b = nz(-9, 9);
          c = nz(-8, 8);
          D = b * b - 4 * a * c;
          const rt = Math.sqrt(D);
          if (D > 0 && !Number.isInteger(rt)) {
            const r1 = (-b - rt) / (2 * a), r2 = (-b + rt) / (2 * a);
            if (Math.abs(r1) <= 20 && Math.abs(r2) <= 20 && !near5(r1) && !near5(r2)) break;
          }
          D = -1;
        }
        if (D > 0) {
          const rt = Math.sqrt(D);
          const r1 = (-b - rt) / (2 * a), r2 = (-b + rt) / (2 * a);
          const f = (n) => (Math.round(n * 100) / 100).toFixed(2);
          const aT = a === 1 ? "" : `${a}`;
          const bT = `${b > 0 ? "+ " : "− "}${Math.abs(b) === 1 ? "" : Math.abs(b)}x`;
          const cT = `${c > 0 ? "+ " : "− "}${Math.abs(c)}`;
          return {
            prompt: `Solve, giving each answer to 2 decimal places:   ${aT}x² ${bT} ${cT} = 0`,
            answer: `x = ${f(r1)},  x = ${f(r2)}`,
            hint: "use the quadratic formula",
            fields: [{ key: "x1", label: "x =", placeholder: "?" }, { key: "x2", label: "x =", placeholder: "?" }],
            check: (m) => {
              const g = [m.x1, m.x2].map((s) => parseFloat(String(s).replace(/[−–—]/g, "-").replace(/[^0-9.\-]/g, "")));
              if (g.some((v) => !Number.isFinite(v))) return false;
              g.sort((u, v) => u - v);
              return Math.abs(g[0] - r1) < 0.02 && Math.abs(g[1] - r2) < 0.02;
            },
            steps: [
              `a = ${a},  b = ${b},  c = ${c}`,
              `b² − 4ac = ${b * b} − 4(${a})(${c}) = ${D}`,
              `x = (${-b} ± √${D}) ÷ ${2 * a} = (${-b} ± ${f(rt)}) ÷ ${2 * a}`,
              `x = ${f(r1)}   or   x = ${f(r2)}`,
            ],
          };
        }
      }

      // rest — standard x² + (p+q)x + pq
      const p = nz(-9, 9), q = nz(-9, 9);
      const tail = `${xterm(p + q)} ${spaced(p * q)}`.replace(/\s+/g, " ").trim();
      return { prompt: `Factorise:   x² ${tail}`, answer: `(x${tight(p)})(x${tight(q)})`, hint: "e.g. (x+2)(x-3)",
        steps: [`Two numbers with product ${p * q} and sum ${p + q}: ${p} and ${q}`, `= (x${tight(p)})(x${tight(q)})`] };
    } },
  { id: "simultaneous", name: "Simultaneous Equations", icon: "🔗", prereqs: ["algebra"],
    generate() {
      const xSol = randInt(-6, 6), ySol = randInt(-6, 6);
      let a = randInt(1, 5), b = randInt(1, 5), c = randInt(1, 5), d = randInt(1, 5);
      while (a * d - b * c === 0) { c = randInt(1, 5); d = randInt(1, 5); }
      const e = a * xSol + b * ySol, f = c * xSol + d * ySol;
      const co = (n) => (n === 1 ? "" : `${n}`);
      const eq1 = `${co(a)}x + ${co(b)}y = ${e}`, eq2 = `${co(c)}x + ${co(d)}y = ${f}`;
      return {
        prompt: `Solve this pair:   ${eq1}\n${eq2}`,
        fields: [{ key: "x", label: "x =" }, { key: "y", label: "y =" }],
        answers: { x: `${xSol}`, y: `${ySol}` },
        answer: `x = ${xSol},  y = ${ySol}`,
        hint: "whole numbers",
        steps: [
          `Scale the equations so one variable's coefficients match, then subtract to eliminate it`,
          `Solve for the other variable, then substitute back`,
          `x = ${xSol},  y = ${ySol}`,
        ],
      };
    } },
  { id: "functions", name: "Functions", icon: "🔀", prereqs: ["algebra"],
    generate() {
      const nz = (lo, hi) => { let n = 0; while (n === 0) n = randInt(lo, hi); return n; };
      const build = () => {
        const r = Math.random();

        // 20% — write the inverse function
        if (r < 0.20) {
          const a = randInt(2, 6), b = nz(-9, 9);
          return {
            prompt: `f(x) = ${a}x ${spaced(b)}\nWrite f⁻¹(x)`,
            answer: `(x${tight(-b)})/${a}`,
            answerDisplay: frac(`x ${spaced(-b)}`, `${a}`),
            hint: "leave your answer in terms of x",
            steps: [
              `Let y = ${a}x ${spaced(b)}, then swap x and y:  x = ${a}y ${spaced(b)}`,
              `${a}y = x ${spaced(-b)}`,
              `f⁻¹(x) = (x ${spaced(-b)}) ÷ ${a}`,
            ],
          };
        }

        // 15% — composite function, evaluated at a number
        if (r < 0.35) {
          const a = randInt(2, 6), b = nz(-9, 9), c = randInt(2, 6), d = nz(-9, 9), k = nz(-6, 6);
          const outer = Math.random() < 0.5 ? "f" : "g"; // which function is applied last
          const innerName = outer === "f" ? "g" : "f";
          const [ic, id] = innerName === "f" ? [a, b] : [c, d];
          const [oc, od] = outer === "f" ? [a, b] : [c, d];
          const inner = ic * k + id;
          if (inner === 0) return null;
          const ans = oc * inner + od;
          if (ans === 0) return null;
          return {
            prompt: `f(x) = ${a}x ${spaced(b)}\ng(x) = ${c}x ${spaced(d)}\nFind ${outer}${innerName}(${k})`,
            answer: `${ans}`,
            hint: "apply the right-hand function first",
            steps: [
              `${outer}${innerName}(${k}) means: work out ${innerName}(${k}) first, then apply ${outer}.`,
              `${innerName}(${k}) = ${ic}×${k} ${spaced(id)} = ${inner}`,
              `${outer}(${inner}) = ${oc}×${inner} ${spaced(od)} = ${ans}`,
            ],
          };
        }

        // 65% — substitute a value
        const a = randInt(2, 9), b = nz(-10, 10), k = nz(-8, 8);
        const ans = a * k + b;
        if (ans === 0) return null;
        return {
          prompt: `f(x) = ${a}x ${spaced(b)}\nFind f(${k})`,
          answer: `${ans}`,
          hint: "Enter a number.",
          steps: [`Substitute x = ${k}:  f(${k}) = ${a}×${k} ${spaced(b)}`, `= ${a * k} ${spaced(b)} = ${ans}`],
        };
      };
      let q;
      for (let i = 0; i < 40; i++) { q = build(); if (q) break; }
      return q;
    } },
  { id: "sequences", name: "Number Sequences", icon: "🔢", prereqs: ["algebra"],
    generate() {
      const nz = (lo, hi) => { let v = 0; while (v === 0) v = randInt(lo, hi); return v; };
      const pick = (arr) => arr[randInt(0, arr.length - 1)];
      const linRule = (m, c) => {
        const mt = m === 1 ? "n" : m === -1 ? "-n" : `${m}n`;
        return c === 0 ? mt : `${mt} ${c > 0 ? "+" : "-"} ${Math.abs(c)}`;
      };
      const quadRule = (a, b, c) => {
        const at = a === 1 ? "n²" : a === -1 ? "-n²" : `${a}n²`;
        const bt = b === 0 ? "" : ` ${b > 0 ? "+" : "-"} ${Math.abs(b) === 1 ? "" : Math.abs(b)}n`;
        const ct = c === 0 ? "" : ` ${c > 0 ? "+" : "-"} ${Math.abs(c)}`;
        return `${at}${bt}${ct}`;
      };

      const makeSeq = () => {
        const kind = pick(["arith", "arith", "arith", "geo", "geo", "quad", "quad", "sqShift", "sqShift"]);
        if (kind === "arith") {
          const a1 = nz(-10, 10), d = nz(-9, 9);
          return { kind, term: (n) => a1 + (n - 1) * d, rule: linRule(d, a1 - d),
            how: `Constant difference of ${d}, so nth term = ${linRule(d, a1 - d)}` };
        }
        if (kind === "geo") {
          const a = pick([1, 1, 2, -1, 2, 3]), r = pick([2, 2, 3, -2]);
          const aPart = a === 1 ? "" : a === -1 ? "-" : `${a}×`;
          const rTxt = r < 0 ? `(${r})` : `${r}`;
          return { kind, term: (n) => a * Math.pow(r, n - 1), rule: `${aPart}${rTxt}^(n-1)`,
            how: `Each term is ${r}× the previous one, so nth term = ${aPart}${rTxt}^(n-1)` };
        }
        if (kind === "quad") {
          const a = pick([1, 1, 2, 2, 3, -1]), b = nz(-6, 6), c = nz(-8, 8);
          return { kind, term: (n) => a * n * n + b * n + c, rule: quadRule(a, b, c),
            how: `Second difference is ${2 * a} (constant → quadratic), so nth term = ${quadRule(a, b, c)}` };
        }
        // shifted square: (n + s)²
        const s = pick([-3, -2, -1, 1, 2, 3, 4, 5]);
        const shift = `n ${s > 0 ? "+" : "-"} ${Math.abs(s)}`;
        return { kind: "sqShift", term: (n) => (n + s) * (n + s), rule: `(${shift})²`,
          how: `Every term is a perfect square; the number being squared is ${shift}, so nth term = (${shift})²` };
      };

      const seq = makeSeq();
      const shown = [1, 2, 3, 4, 5].map(seq.term);
      const seqStr = `${shown.join(", ")}, ...`;
      const mode = Math.random() < 0.4 ? "next" : Math.random() < 0.5 ? "rule" : "kth";

      if (mode === "next") {
        return { prompt: `Find the next term:   ${seqStr}`, answer: `${seq.term(6)}`, hint: "Enter a number.",
          steps: [seq.how, `Next term = ${seq.term(6)}`] };
      }
      if (mode === "rule") {
        return { prompt: `Write the nth-term rule, in terms of n:   ${seqStr}`, answer: seq.rule, hint: "use n — e.g. 3n - 2  or  2n^2 + 1",
          steps: [seq.how, `nth term = ${seq.rule}`] };
      }
      const k = seq.kind === "geo" ? pick([7, 8, 9, 10]) : pick([12, 15, 20, 25, 30, 40, 50, 60, 100]);
      return { prompt: `Find the ${k}th term:   ${seqStr}`, answer: `${seq.term(k)}`, hint: "work out the rule first",
        steps: [seq.how, `Substitute n = ${k}:  ${seq.term(k)}`] };
    } },
  { id: "proportionality", name: "Proportionality", icon: "⚖️", prereqs: ["algebra"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const shuffle = (arr) => { const c = [...arr]; for (let i = c.length - 1; i > 0; i--) { const j = randInt(0, i); [c[i], c[j]] = [c[j], c[i]]; } return c; };

      // share a total between two people in a given ratio
      if (Math.random() < 0.4) {
        const [m, n] = pick([[1, 2], [1, 3], [1, 4], [2, 3], [3, 4], [2, 5], [3, 5], [4, 5], [1, 5], [2, 7], [3, 7], [3, 8], [5, 6]]);
        const [nameA, nameB] = shuffle(["Sam", "Joe", "Ali", "Mia", "Tom", "Zara", "Liam", "Noor"]).slice(0, 2);
        const noun = pick(["apples", "sweets", "marbles", "stickers", "pencils", "chocolates", "stamps", "dollars"]);
        const u = randInt(2, 12);
        const shareA = m * u, shareB = n * u, total = (m + n) * u;

        const mode = pick(["totalToA", "totalToB", "aToTotal", "aToB", "bToTotal", "bToA"]);
        const setup = `${nameA} and ${nameB} share ${noun} in the ratio ${m}:${n}.`;
        let prompt, answer, steps;
        if (mode === "totalToA") {
          prompt = `${nameA} and ${nameB} share ${total} ${noun} in the ratio ${m}:${n}. How many ${noun} does ${nameA} get?`;
          answer = `${shareA}`;
          steps = [`Total parts = ${m} + ${n} = ${m + n}`, `1 part = ${total} ÷ ${m + n} = ${u}`, `${nameA}'s share = ${m} × ${u} = ${shareA}`];
        } else if (mode === "totalToB") {
          prompt = `${nameA} and ${nameB} share ${total} ${noun} in the ratio ${m}:${n}. How many ${noun} does ${nameB} get?`;
          answer = `${shareB}`;
          steps = [`Total parts = ${m} + ${n} = ${m + n}`, `1 part = ${total} ÷ ${m + n} = ${u}`, `${nameB}'s share = ${n} × ${u} = ${shareB}`];
        } else if (mode === "aToTotal") {
          prompt = `${setup} ${nameA} gets ${shareA} ${noun}. How many ${noun} do they share in total?`;
          answer = `${total}`;
          steps = [`${nameA}'s ${m} part(s) = ${shareA}, so 1 part = ${shareA} ÷ ${m} = ${u}`, `Total = ${u} × (${m} + ${n}) = ${total}`];
        } else if (mode === "aToB") {
          prompt = `${setup} ${nameA} gets ${shareA} ${noun}. How many ${noun} does ${nameB} get?`;
          answer = `${shareB}`;
          steps = [`${nameA}'s ${m} part(s) = ${shareA}, so 1 part = ${shareA} ÷ ${m} = ${u}`, `${nameB}'s share = ${n} × ${u} = ${shareB}`];
        } else if (mode === "bToTotal") {
          prompt = `${setup} ${nameB} gets ${shareB} ${noun}. How many ${noun} do they share in total?`;
          answer = `${total}`;
          steps = [`${nameB}'s ${n} part(s) = ${shareB}, so 1 part = ${shareB} ÷ ${n} = ${u}`, `Total = ${u} × (${m} + ${n}) = ${total}`];
        } else {
          prompt = `${setup} ${nameB} gets ${shareB} ${noun}. How many ${noun} does ${nameA} get?`;
          answer = `${shareA}`;
          steps = [`${nameB}'s ${n} part(s) = ${shareB}, so 1 part = ${shareB} ÷ ${n} = ${u}`, `${nameA}'s share = ${m} × ${u} = ${shareA}`];
        }
        return { prompt, answer, hint: "Enter a number.", steps };
      }

      const rels = [
        { txt: "x",  disp: (x) => `${x}`,   f: (x) => x,             other: (b, t) => b * t,     R: (t) => t },
        { txt: "x",  disp: (x) => `${x}`,   f: (x) => x,             other: (b, t) => b * t,     R: (t) => t },
        { txt: "x²", disp: (x) => `${x}²`,  f: (x) => x * x,         other: (b, t) => b * t,     R: (t) => t * t },
        { txt: "x²", disp: (x) => `${x}²`,  f: (x) => x * x,         other: (b, t) => b * t,     R: (t) => t * t },
        { txt: "√x", disp: (x) => `√${x}`,  f: (x) => Math.sqrt(x),  other: (b, t) => b * t * t, R: (t) => t, bases: [4, 9, 16] },
        { txt: "√x", disp: (x) => `√${x}`,  f: (x) => Math.sqrt(x),  other: (b, t) => b * t * t, R: (t) => t, bases: [4, 9, 16] },
        { txt: "x³", disp: (x) => `${x}³`,  f: (x) => x ** 3,        other: (b, t) => b * t,     R: (t) => t ** 3, small: true },
      ];
      const rel = pick(rels);
      const inverse = Math.random() < 0.45;
      const baseX = rel.bases ? pick(rel.bases) : rel.small ? randInt(2, 3) : randInt(2, rel.txt === "x" ? 8 : 5);
      const t = rel.small ? 2 : pick([2, 3]);
      const otherX = rel.other(baseX, t), R = rel.R(t);
      const fBase = rel.f(baseX), fOther = rel.f(otherX);

      let yBase, yOther, k;
      if (inverse) {
        yOther = randInt(2, 9);
        k = yOther * fOther;
        yBase = yOther * R; // = k / fBase
      } else {
        k = rel.small ? randInt(2, 4) : randInt(2, 8);
        yBase = k * fBase;
        yOther = k * fOther;
      }

      const giveBase = Math.random() < 0.5;
      const [gx, gy, ax, ay] = giveBase ? [baseX, yBase, otherX, yOther] : [otherX, yOther, baseX, yBase];
      const rl = inverse ? `inversely proportional to ${rel.txt}` : `directly proportional to ${rel.txt}`;
      const op = inverse ? "×" : "÷";
      const fg = rel.f(gx), fa = rel.f(ax);
      const kLine = rel.disp(gx) === `${fg}`
        ? `k = ${gy} ${op} ${gx} = ${k}`
        : `k = ${gy} ${op} ${rel.disp(gx)} = ${gy} ${op} ${fg} = ${k}`;
      const useLine = inverse
        ? `When x = ${ax}:  y = ${k} ÷ ${rel.disp(ax) === `${fa}` ? ax : `${rel.disp(ax)} = ${fa}`}  →  y = ${ay}`
        : `When x = ${ax}:  y = ${k} × ${rel.disp(ax) === `${fa}` ? ax : `${rel.disp(ax)} = ${fa}`}  →  y = ${ay}`;

      return {
        prompt: `y is ${rl}. When x = ${gx}, y = ${gy}. Find y when x = ${ax}`,
        answer: `${ay}`, hint: "Enter a number.",
        steps: [
          inverse ? `Inverse: y = k ÷ ${rel.txt}, so k = y × ${rel.txt}` : `Direct: y = k${rel.txt === "x" ? "x" : " · " + rel.txt}, so k = y ÷ ${rel.txt}`,
          kLine,
          useLine,
        ],
      };
    } },
  { id: "coordgeo", name: "Co-ordinate Geometry", icon: "📍", prereqs: [],
    generate() {
      const nz = (lo, hi) => { let v = 0; while (v === 0) v = randInt(lo, hi); return v; };
      const g2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; };
      const fr = (num, den) => { if (den < 0) { num = -num; den = -den; } const g = g2(num, den); num /= g; den /= g; return den === 1 ? `${num}` : `${num}/${den}`; };
      const mxTerm = (ms) => {
        if (ms === "1") return "x";
        if (ms === "-1") return "-x";
        if (ms.includes("/")) { const [n, d] = ms.split("/"); return `${n === "1" ? "" : n === "-1" ? "-" : n}x/${d}`; }
        return `${ms}x`;
      };
      const plusC = (c) => (c === 0 ? "" : c > 0 ? ` + ${c}` : ` - ${-c}`);
      const twoPts = () => {
        const m = nz(-5, 5), c = randInt(-6, 6);
        let x1 = randInt(-6, 6), x2 = randInt(-6, 6);
        while (x2 === x1) x2 = randInt(-6, 6);
        return { m, c, x1, x2, y1: m * x1 + c, y2: m * x2 + c };
      };
      const r = Math.random();

      if (r < 0.14) {
        const { m, x1, x2, y1, y2 } = twoPts();
        return { prompt: `Find the gradient of the line joining (${x1}, ${y1}) and (${x2}, ${y2})`, answer: `${m}`, hint: "Enter a number.",
          steps: [`gradient = (y₂ − y₁) ÷ (x₂ − x₁)`, `= (${y2} − ${y1}) ÷ (${x2} − ${x1}) = ${y2 - y1} ÷ ${x2 - x1} = ${m}`] };
      }

      if (r < 0.30) {
        const { m, c, x1, x2, y1, y2 } = twoPts();
        const eq = `y = ${mxTerm(`${m}`)}${plusC(c)}`;
        return { prompt: `Find the equation of the line through (${x1}, ${y1}) and (${x2}, ${y2}).\nGive it as y = mx + c`, answer: eq, hint: "e.g. y = 2x - 1",
          steps: [`gradient m = (${y2} − ${y1}) ÷ (${x2} − ${x1}) = ${m}`, `Substitute (${x1}, ${y1}):  ${y1} = ${m}(${x1}) + c  →  c = ${c}`, eq] };
      }

      if (r < 0.44) {
        const P = () => { const a = randInt(-6, 6); let b = randInt(-6, 6); while ((a - b) % 2 !== 0) b = randInt(-6, 6); return [a, b]; };
        const [x1, x2] = P(), [y1, y2] = P();
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return { prompt: `Find the midpoint of the segment joining (${x1}, ${y1}) and (${x2}, ${y2})`,
          fields: [{ key: "x", label: "x =" }, { key: "y", label: "y =" }], answers: { x: `${mx}`, y: `${my}` },
          answer: `(${mx}, ${my})`, hint: "midpoint coordinates",
          steps: [`Midpoint = ( (x₁+x₂)/2 , (y₁+y₂)/2 )`, `= ( (${x1}${x2 < 0 ? "" : "+"}${x2})/2 , (${y1}${y2 < 0 ? "" : "+"}${y2})/2 ) = (${mx}, ${my})`] };
      }

      if (r < 0.58) {
        const triples = [[3, 4], [6, 8], [5, 12], [8, 15], [9, 12], [7, 24], [20, 21]];
        let x1 = randInt(-5, 5), y1 = randInt(-5, 5), dx, dy;
        if (Math.random() < 0.6) { const [p, q] = triples[randInt(0, triples.length - 1)]; dx = (Math.random() < 0.5 ? 1 : -1) * p; dy = (Math.random() < 0.5 ? 1 : -1) * q; }
        else { dx = nz(-7, 7); dy = nz(-7, 7); }
        const x2 = x1 + dx, y2 = y1 + dy, sq = dx * dx + dy * dy, root = Math.sqrt(sq), exact = Number.isInteger(root);
        return { prompt: `Find the length of the segment joining (${x1}, ${y1}) and (${x2}, ${y2})`,
          answer: exact ? `${root}` : `sqrt(${sq})`, hint: exact ? "Enter a number." : "e.g. sqrt(20) or a decimal",
          steps: [`length = √( (x₂−x₁)² + (y₂−y₁)² )`, `= √( (${dx})² + (${dy})² ) = √(${dx * dx} + ${dy * dy}) = √${sq}`, exact ? `= ${root}` : `= √${sq} ≈ ${root.toFixed(2)}`] };
      }

      if (r < 0.70) {
        const m = nz(-4, 4);
        const perp = Math.abs(m) === 1 ? `${-m}` : fr(-1, m);
        return { prompt: `A line has gradient ${m}. Find the gradient of any line perpendicular to it`, answer: perp, hint: "fraction or decimal",
          steps: [`Perpendicular gradient = −1 ÷ (gradient)`, `= −1 ÷ ${m} = ${perp}`] };
      }

      if (r < 0.80) {
        const m = nz(-4, 4), rc = randInt(-5, 5);
        const t = nz(-3, 3), px = m * t, py = randInt(-6, 6), c = py + t;
        const mpS = Math.abs(m) === 1 ? `${-m}` : fr(-1, m);
        const eq = `y = ${mxTerm(mpS)}${plusC(c)}`;
        return { prompt: `Find the equation of the line perpendicular to y = ${mxTerm(`${m}`)}${plusC(rc)} that passes through (${px}, ${py}).\nGive it as y = mx + c`,
          answer: eq, hint: "e.g. y = -1/2x + 3",
          steps: [`Perpendicular gradient = −1 ÷ ${m} = ${mpS}`, `Through (${px}, ${py}):  ${py} = ${mpS}(${px}) + c  →  c = ${c}`, eq] };
      }

      if (r < 0.90) {
        // read the equation of a line straight off a graph
        const slopes = [[-3, 1], [-2, 1], [-1, 1], [1, 1], [2, 1], [3, 1], [1, 2], [-1, 2], [3, 2], [-3, 2]];
        const [sn, sd] = slopes[randInt(0, slopes.length - 1)];
        const m = sn / sd, c = randInt(-2, 2);
        const p1 = [0, c];
        let p2 = [sd, sn + c];
        for (const kk of [3, -3, 2, -2, 1, -1]) { const x = sd * kk, y = sn * kk + c; if (Math.abs(x) <= 5 && Math.abs(y) <= 5) { p2 = [x, y]; break; } }
        const mS = fr(sn, sd);
        const eq = `y = ${mxTerm(mS)}${plusC(c)}`;
        return {
          prompt: `The straight line is drawn on the grid. Write its equation as y = mx + c`,
          graph: { m, c, marks: [p1, p2] }, answer: eq, hint: "read two points off the line",
          steps: [
            `Two points on the line: (${p1[0]}, ${p1[1]}) and (${p2[0]}, ${p2[1]})`,
            `gradient = (${p2[1]} − ${p1[1]}) ÷ (${p2[0]} − ${p1[0]}) = ${mS}`,
            `crosses the y-axis at ${c}, so c = ${c}`,
            eq,
          ],
        };
      }

      // read the gradient / y-intercept off a rearranged equation
      const A = randInt(2, 4), B = nz(-6, 6), k = nz(-3, 3), Cc = k * A;
      const mm = B / A, cc = k;
      const eqForm = Math.random() < 0.5
        ? `${A}y = ${mxTerm(`${B}`)}${plusC(Cc)}`
        : `${A}y ${Cc > 0 ? "- " + Cc : "+ " + -Cc} = ${mxTerm(`${B}`)}`;
      const askG = Math.random() < 0.5;
      return { prompt: `The line ${eqForm}.\nFind the ${askG ? "gradient" : "y-intercept"}`,
        answer: askG ? fr(B, A) : `${cc}`, hint: "fraction or decimal",
        steps: [`Rearrange to y = mx + c — divide through by ${A}`, `y = ${fr(B, A)}x${plusC(cc)}`, askG ? `gradient = ${fr(B, A)}` : `y-intercept = ${cc}`] };
    } },
  { id: "graphicalsolutions", name: "Graphical Solutions", icon: "📉", prereqs: ["algebra", "coordgeo"],
    generate() {
      const roll = Math.random();
      if (roll < 0.30) {
        // Draw the graph of a given straight line by tapping two points.
        const slopes = [[-3, 1], [-2, 1], [-1, 1], [1, 1], [2, 1], [3, 1], [1, 2], [-1, 2]];
        const [sn, sd] = slopes[randInt(0, slopes.length - 1)];
        const m = sn / sd, c = randInt(-3, 3);
        const mS = sd === 1 ? `${sn}` : `${sn}/${sd}`;
        const mTerm = mS === "1" ? "x" : mS === "-1" ? "-x"
          : mS.includes("/") ? `${sn === 1 ? "" : sn === -1 ? "-" : sn}x/${sd}` : `${mS}x`;
        const cs = c === 0 ? "" : c > 0 ? ` + ${c}` : ` - ${-c}`;
        const eq = `y = ${mTerm}${cs}`;
        return {
          prompt: `Draw the graph of:   ${eq}`,
          drawGraph: { m, c }, answer: eq, hint: "tap two points the line passes through",
          steps: [
            `Gradient ${mS}, crosses the y-axis at ${c}`,
            `Two points on the line: (0, ${c}) and (${sd}, ${sn + c})`,
            `Plot them and join up: ${eq}`,
          ],
        };
      }

      if (roll < 0.65) {
        // "By drawing a suitable line, solve …" — a curve is already on the
        // grid (parabola, negative parabola, cubic or reciprocal); the
        // student draws the straight line and reads off where they meet.
        const pick = (arr) => arr[randInt(0, arr.length - 1)];
        const nz = (lo, hi) => { let v = 0; while (v === 0) v = randInt(lo, hi); return v; };
        const mt = (m) => (m === 1 ? "x" : m === -1 ? "-x" : `${m}x`);
        const lineText = (m, c) => (m === 0 ? `${c}` : `${mt(m)}${c > 0 ? ` + ${c}` : c < 0 ? ` - ${-c}` : ""}`);

        // parab / nparab / recip all reduce to  x² - Sx + P = 0  with roots p, q
        const finish = ({ label, curve, curveExpr, M, C, S, P, cy, p, q, rearrange }) => {
          if (Math.abs(C) > 6) return null;
          let latt = 0;
          for (let x = -6; x <= 6; x++) if (Math.abs(M * x + C) <= 6) latt++;
          if (latt < 2) return null;
          const midT = S === 0 ? "" : ` ${S < 0 ? "+" : "-"} ${Math.abs(S) === 1 ? "" : Math.abs(S)}x`;
          const conT = P === 0 ? "" : ` ${P > 0 ? "+" : "-"} ${Math.abs(P)}`;
          const eqShown = `x²${midT}${conT} = 0`;
          const lRHS = lineText(M, C);
          const tangent = p === q;
          const lo = Math.min(p, q), hi = Math.max(p, q);
          const num = (s) => { try { return evalString(String(s), 0); } catch (e) { return NaN; } };
          return {
            prompt: `${label} is drawn. By drawing a suitable line, solve:   ${eqShown}`,
            curve, solveLine: { m: M, c: C },
            solvePoints: tangent ? [[p, cy(p)]] : [[p, cy(p)], [q, cy(q)]],
            fields: tangent
              ? [{ key: "x", label: "x =" }, { key: "y", label: "y =" }]
              : [{ key: "s1", label: "x =" }, { key: "s2", label: "x =" }],
            answer: tangent ? `x = ${p},  y = ${cy(p)}` : `x = ${lo},  x = ${hi}`,
            hint: tangent ? "draw the line, then type where it touches" : "draw the line, then the two x-values",
            drawSolve: (pts, inp) => {
              const [[X1, Y1], [X2, Y2]] = pts;
              if (X1 === X2) return false;
              const gm = (Y2 - Y1) / (X2 - X1), gc = Y1 - gm * X1;
              if (Math.abs(gm - M) > 1e-9 || Math.abs(gc - C) > 1e-9) return false;
              if (tangent) return Math.abs(num(inp.x) - p) < 1e-6 && Math.abs(num(inp.y) - cy(p)) < 1e-6;
              const g = [num(inp.s1), num(inp.s2)].sort((u, v) => u - v);
              return Math.abs(g[0] - lo) < 1e-6 && Math.abs(g[1] - hi) < 1e-6;
            },
            steps: [
              `The curve drawn is ${label}.`,
              rearrange || `Rewrite ${eqShown} so one side matches the curve:  ${curveExpr} = ${lRHS}`,
              `Draw the line y = ${lRHS}, then read the x-values where it meets the curve.`,
              tangent ? `The line just touches the curve — one solution, x = ${p}` : `x = ${lo}  and  x = ${hi}`,
            ],
          };
        };

        const buildCubic = () => {
          const cfg = pick([
            { b: -4, M: -3, C: 0, roots: [-1, 0, 1], solve: "x³ - x = 0", rr: "x³ - x = 0  →  x³ - 4x = -3x", line: "-3x" },
            { b: -1, M: 3, C: 0, roots: [-2, 0, 2], solve: "x³ - 4x = 0", rr: "x³ - 4x = 0  →  x³ - x = 3x", line: "3x" },
            { b: -4, M: 0, C: 0, roots: [-2, 0, 2], solve: "x³ - 4x = 0", rr: "the solutions are where y = x³ - 4x meets the x-axis", line: "0 (the x-axis)" },
            { b: -1, M: 0, C: 0, roots: [-1, 0, 1], solve: "x³ - x = 0", rr: "the solutions are where y = x³ - x meets the x-axis", line: "0 (the x-axis)" },
          ]);
          const f = (x) => x * x * x + cfg.b * x;
          const label = `y = x³ ${cfg.b < 0 ? "-" : "+"} ${Math.abs(cfg.b) === 1 ? "" : `${Math.abs(cfg.b)}`}x`.replace("  ", " ");
          const num = (s) => { try { return evalString(String(s), 0); } catch (e) { return NaN; } };
          return {
            prompt: `${label} is drawn. By drawing a suitable line, solve:   ${cfg.solve}`,
            curve: { kind: "cubic", b: cfg.b }, solveLine: { m: cfg.M, c: cfg.C },
            solvePoints: cfg.roots.map((r) => [r, f(r)]),
            fields: cfg.roots.map((_, i) => ({ key: `r${i}`, label: "x =" })),
            answer: cfg.roots.map((r) => `x = ${r}`).join(",  "),
            hint: "draw the line, then the three solutions for x",
            drawSolve: (pts, inp) => {
              const [[X1, Y1], [X2, Y2]] = pts;
              if (X1 === X2) return false;
              const gm = (Y2 - Y1) / (X2 - X1), gc = Y1 - gm * X1;
              if (Math.abs(gm - cfg.M) > 1e-9 || Math.abs(gc - cfg.C) > 1e-9) return false;
              const g = cfg.roots.map((_, i) => num(inp[`r${i}`])).sort((u, v) => u - v);
              return cfg.roots.every((r, i) => Math.abs(g[i] - r) < 1e-6);
            },
            steps: [
              `The curve drawn is ${label}.`,
              `Rearrange: ${cfg.rr}`,
              cfg.M === 0 ? `Read off where the curve crosses the x-axis.` : `Draw the line y = ${cfg.line} and read the three intersection x-values.`,
              `x = ${cfg.roots.join(",  x = ")}`,
            ],
          };
        };

        const build = () => {
          const fam = pick(["parab", "parab", "nparab", "nparab", "recip", "recip", "cubic"]);
          if (fam === "cubic") return buildCubic();

          let p, q;
          const t = Math.random();
          if (t < 0.16 && fam !== "recip") { p = q = nz(-2, 2); }
          else if (t < 0.55) { p = randInt(1, 3); q = -randInt(1, 3); }
          else { p = randInt(-3, 3); q = randInt(-3, 3); }
          if (p === q && fam === "recip") return null;
          if (p === q && t >= 0.16) return null;
          const S = p + q, P = p * q;

          if (fam === "parab") {
            const a = randInt(-3, 1);
            const cy = (x) => x * x + a;
            if (cy(p) > 6 || cy(q) > 6) return null;
            const plusA = a === 0 ? "" : a > 0 ? ` + ${a}` : ` - ${-a}`;
            return finish({ label: `y = x²${plusA}`, curve: { kind: "parab", a }, curveExpr: `x²${plusA}`,
              M: S, C: a - P, S, P, cy, p, q });
          }
          if (fam === "nparab") {
            const a = randInt(0, 3);
            const cy = (x) => a - x * x;
            if (cy(p) < -6 || cy(q) < -6) return null;
            const ex = a === 0 ? "-x²" : `${a} - x²`;
            return finish({ label: `y = ${ex}`, curve: { kind: "nparab", a }, curveExpr: ex,
              M: -S, C: a + P, S, P, cy, p, q });
          }
          // recip: y = k/x — slope kept at ±1 so it's a clean "multiply by x"
          // rearrangement (k = ∓ product of the roots)
          const slope = pick([-1, 1]);
          const k = -slope * P;
          if (k === 0) return null;   // 0 can't be a root of k/x
          const cy = (x) => k / x;
          const lr = lineText(slope, -slope * S);
          return finish({ label: `y = ${k}/x`, curve: { kind: "recip", k }, curveExpr: `${k}/x`,
            M: slope, C: -slope * S, S, P, cy, p, q,
            rearrange: `Divide x²${S === 0 ? "" : ` ${S < 0 ? "+" : "-"} ${Math.abs(S) === 1 ? "" : Math.abs(S)}x`}${P > 0 ? ` + ${P}` : ` - ${-P}`} = 0 by x, then rearrange:  ${k}/x = ${lr}` });
        };

        let qq;
        for (let i = 0; i < 80; i++) { qq = build(); if (qq) break; }
        if (qq) return qq;
      }

      const xI = randInt(-6, 6);
      let m1 = randInt(-5, 5), m2 = randInt(-5, 5);
      while (m1 === m2) m2 = randInt(-5, 5);
      let c1 = randInt(-8, 8);
      while (m1 === 0 && c1 === 0) c1 = randInt(-8, 8);
      const c2 = m1 * xI + c1 - m2 * xI;
      const xc = (n) => (n === 1 ? "x" : n === -1 ? "-x" : `${n}x`);
      const rhs = (m, c) => {
        if (m === 0) return `${c}`;
        let s = xc(m);
        if (c > 0) s += ` + ${c}`; else if (c < 0) s += ` - ${-c}`;
        return s;
      };
      return {
        prompt: `Find the x-coordinate where these lines cross:   y = ${rhs(m1, c1)}\ny = ${rhs(m2, c2)}`,
        answer: `${xI}`, hint: "Enter a number.",
        steps: [
          `Where they cross the y-values match:  ${rhs(m1, c1)} = ${rhs(m2, c2)}`,
          `Collect the x-terms:  ${xc(m1 - m2)} = ${c2 - c1}`,
          `x = ${c2 - c1} ÷ ${m1 - m2} = ${xI}`,
        ],
      };
    } },
  { id: "inequalities", name: "Linear Inequalities & Shading", icon: "🚧", prereqs: ["algebra", "coordgeo"],
    generate() {
      const nz = (lo, hi) => { let v = 0; while (v === 0) v = randInt(lo, hi); return v; };
      const OPS = [">", "<", "≥", "≤"];
      const flip = (o) => ({ ">": "<", "<": ">", "≥": "≤", "≤": "≥" }[o]);
      const xc = (n) => (n === 1 ? "x" : n === -1 ? "-x" : `${n}x`);
      const tm = (n) => (n > 0 ? ` + ${n}` : n < 0 ? ` - ${-n}` : "");
      const xtm = (n) => (n > 0 ? ` + ${n === 1 ? "" : n}x` : ` - ${n === -1 ? "" : -n}x`);
      const divLine = (k, ans, x0) => `Divide by ${k}${k < 0 ? " — the inequality flips" : ""}:  x ${ans} ${x0}`;

      if (Math.random() < 0.25) {
        // shade the region that satisfies an inequality
        const kind = ["diag", "diag", "vert", "horiz"][randInt(0, 3)];
        const op = OPS[randInt(0, 3)];
        const solid = op === "≤" || op === "≥";
        const ge = op === ">" || op === "≥";
        if (kind === "diag") {
          const m = [-2, -1, 1, 2][randInt(0, 3)], c = nz(-3, 3);
          const mE = `${xc(m)}${tm(c)}`;
          const test0 = ({ ">": 0 > c, "<": 0 < c, "≥": 0 >= c, "≤": 0 <= c })[op];
          return {
            prompt: `The line y = ${mE} is drawn.\nTap the region where:   y ${op} ${mE}`,
            region: { kind: "diag", m, c, op, solid },
            answer: `y ${op} ${mE}`, hint: "tap anywhere in the correct half",
            steps: [
              `Boundary: y = ${mE}  (${solid ? "solid — the line is included" : "dashed — the line is not included"}).`,
              `Test the origin (0, 0):  is  0 ${op} ${c}?  ${test0 ? "yes" : "no"}.`,
              `So the region ${test0 ? "containing" : "not containing"} the origin satisfies  y ${op} ${mE}.`,
            ],
          };
        }
        const k = nz(-4, 4);
        const axis = kind === "vert" ? "x" : "y";
        return {
          prompt: `The line ${axis} = ${k} is drawn.\nTap the region where:   ${axis} ${op} ${k}`,
          region: { kind, k, op, solid },
          answer: `${axis} ${op} ${k}`, hint: "tap anywhere in the correct half",
          steps: [
            `${axis} = ${k} is a ${kind === "vert" ? "vertical" : "horizontal"} line (${solid ? "solid — included" : "dashed — not included"}).`,
            `${kind === "vert" ? (ge ? "Right" : "Left") : (ge ? "Above" : "Below")} the line is where  ${axis} ${op} ${k}.`,
          ],
        };
      }

      const build = () => {
        const op = OPS[randInt(0, 3)];
        const x0 = nz(-6, 6);
        const r = Math.random();

        if (r < 0.28) {
          // single x-term, one number  (negative or positive coefficient)
          const a = Math.random() < 0.65 ? nz(-5, -1) : randInt(2, 6);
          const b = nz(-9, 9), c = a * x0 + b, ans = a < 0 ? flip(op) : op;
          const disp = (Math.random() < 0.4 && a < 0 && b > 0)
            ? `${b} ${a === -1 ? "- x" : `- ${-a}x`} ${op} ${c}` // "7 - 3x"
            : `${xc(a)}${tm(b)} ${op} ${c}`;
          return { disp, ans, x0, op, steps: [`Get the x-term by itself:  ${xc(a)} ${op} ${c - b}`, divLine(a, ans, x0)] };
        }

        if (r < 0.48) {
          // expand a bracket first;  p(cx + q) op rhs
          const p = [-4, -3, -2, 2, 3, 4][randInt(0, 5)], cx = randInt(1, 3);
          const q = nz(-6, 6), rhs = p * cx * x0 + p * q, k = p * cx, ans = k < 0 ? flip(op) : op;
          return { disp: `${p}(${xc(cx)}${tm(q)}) ${op} ${rhs}`, ans, x0, op,
            steps: [`Expand:  ${xc(k)}${tm(p * q)} ${op} ${rhs}`, `Get the x-term by itself:  ${xc(k)} ${op} ${rhs - p * q}`, divLine(k, ans, x0)] };
        }

        if (r < 0.66) {
          // several x-terms to collect;  k1·x ± k2·x ± b op rhs
          const k1 = nz(-5, 5), k2 = nz(-5, 5), sum = k1 + k2;
          if (sum === 0) return null;
          const b = nz(-9, 9), rhs = sum * x0 + b, ans = sum < 0 ? flip(op) : op;
          return { disp: `${xc(k1)}${xtm(k2)}${tm(b)} ${op} ${rhs}`, ans, x0, op,
            steps: [`Collect the x-terms:  ${xc(sum)}${tm(b)} ${op} ${rhs}`, `Get the x-term by itself:  ${xc(sum)} ${op} ${rhs - b}`, divLine(sum, ans, x0)] };
        }

        if (r < 0.80) {
          // fraction;  (a x + b) / n  op  rhs
          const n = randInt(2, 5), a = nz(-4, 4), b = nz(-9, 9);
          if ((a * x0 + b) % n !== 0) return null;
          const rhs = (a * x0 + b) / n, ans = a < 0 ? flip(op) : op;
          return { disp: `${frac(`${xc(a)}${tm(b)}`, `${n}`)} ${op} ${rhs}`, ans, x0, op,
            steps: [`Multiply both sides by ${n}:  ${xc(a)}${tm(b)} ${op} ${n * rhs}`, `Get the x-term by itself:  ${xc(a)} ${op} ${n * rhs - b}`, divLine(a, ans, x0)] };
        }

        // x on both sides
        let a = nz(-5, 5), c2 = nz(-5, 5);
        while (a === c2) c2 = nz(-5, 5);
        const b = nz(-9, 9), diff = a - c2, d = diff * x0 + b, ans = diff < 0 ? flip(op) : op;
        return { disp: `${xc(a)}${tm(b)} ${op} ${xc(c2)}${tm(d)}`, ans, x0, op,
          steps: [`Collect x on the left, numbers on the right:  ${xc(diff)} ${op} ${d - b}`, divLine(diff, ans, x0)] };
      };

      let q;
      for (let i = 0; i < 40; i++) { q = build(); if (q) break; }
      const answer = `x ${q.ans} ${q.x0}`;
      const symbols = /[≥≤]/.test(q.ans) ? ["x", "≥", "≤"] : ["x", ">", "<"];
      return {
        prompt: `Solve the inequality:   ${q.disp}`,
        answer, hint: `give the answer as an inequality, e.g. x ${q.op} 3`, symbols,
        check: (inp) => { const p = parseIneq(inp); return !!p && p.op === q.ans && Math.abs(p.val - q.x0) < 1e-6; },
        steps: q.steps,
      };
    } },
  { id: "transformations", name: "Transformations", icon: "🔄", prereqs: ["coordgeo"],
    generate() {
      const pick = (arr) => arr[randInt(0, arr.length - 1)];
      const inGrid = (p) => Math.abs(p[0]) <= 7 && Math.abs(p[1]) <= 7; // 1-unit margin inside the ±8 grid
      const key = (p) => `${p[0]},${p[1]}`;
      const area2 = (t) => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]));
      const scalene = (t) => {
        const d = (i, j) => (t[i][0] - t[j][0]) ** 2 + (t[i][1] - t[j][1]) ** 2;
        const s = [d(0, 1), d(1, 2), d(0, 2)];
        return s[0] !== s[1] && s[1] !== s[2] && s[0] !== s[2] && s.every((v) => v >= 2);
      };
      const chunky = (t) => {
        const bw = Math.max(...t.map((p) => p[0])) - Math.min(...t.map((p) => p[0]));
        const bh = Math.max(...t.map((p) => p[1])) - Math.min(...t.map((p) => p[1]));
        const longest = Math.max(
          (t[0][0] - t[1][0]) ** 2 + (t[0][1] - t[1][1]) ** 2,
          (t[1][0] - t[2][0]) ** 2 + (t[1][1] - t[2][1]) ** 2,
          (t[0][0] - t[2][0]) ** 2 + (t[0][1] - t[2][1]) ** 2,
        );
        // area² ≥ 10 and the shortest altitude (2·area / longest side) ≥ ~1.4
        return bw >= 3 && bh >= 3 && area2(t) >= 10 && area2(t) ** 2 >= 2 * longest;
      };
      const randTri = (lo, hi) => {
        for (let i = 0; i < 300; i++) {
          const t = [0, 1, 2].map(() => [randInt(lo, hi), randInt(lo, hi)]);
          if (area2(t) <= 30 && scalene(t) && chunky(t)) return t;
        }
        return [[0, 0], [3, 0], [1, 4]];
      };
      const isSlide = (a, b) => {
        const o = [b[0][0] - a[0][0], b[0][1] - a[0][1]];
        return a.every((p, i) => b[i][0] - p[0] === o[0] && b[i][1] - p[1] === o[1]);
      };
      const T = {
        translate: (t, [a, b]) => t.map(([x, y]) => [x + a, y + b]),
        reflect: (t, m) => t.map(([x, y]) => {
          if (m.kind === "x") return [2 * m.k - x, y];
          if (m.kind === "y") return [x, 2 * m.k - y];
          if (m.kind === "yx") return [y, x];
          return [-y, -x]; // y = -x
        }),
        rotate: (t, c, deg) => t.map(([x, y]) => {
          const dx = x - c[0], dy = y - c[1];
          if (deg === 90) return [c[0] + dy, c[1] - dx];    // clockwise
          if (deg === -90) return [c[0] - dy, c[1] + dx];   // anticlockwise
          return [c[0] - dx, c[1] - dy];                    // 180°
        }),
        enlarge: (t, c, k) => t.map(([x, y]) => [c[0] + k * (x - c[0]), c[1] + k * (y - c[1])]),
      };
      const distinct = (b) => new Set(b.map(key)).size === 3;
      // true when triangles P and Q are apart by at least `gap` units (SAT)
      const separated = (P, Q, gap) => {
        const axes = [];
        for (const poly of [P, Q]) for (let i = 0; i < 3; i++) {
          const u = poly[i], v = poly[(i + 1) % 3];
          const n = [-(v[1] - u[1]), v[0] - u[0]], L = Math.hypot(n[0], n[1]) || 1;
          axes.push([n[0] / L, n[1] / L]);
        }
        for (const ax of axes) {
          let mnP = Infinity, mxP = -Infinity, mnQ = Infinity, mxQ = -Infinity;
          for (const p of P) { const d = p[0] * ax[0] + p[1] * ax[1]; mnP = Math.min(mnP, d); mxP = Math.max(mxP, d); }
          for (const q of Q) { const d = q[0] * ax[0] + q[1] * ax[1]; mnQ = Math.min(mnQ, d); mxQ = Math.max(mxQ, d); }
          if (mxP <= mnQ - gap || mxQ <= mnP - gap) return true;
        }
        return false;
      };
      const cend = (t) => [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
      const apart = (a, b) => {
        const ca = cend(a), cb = cend(b);
        return separated(a, b, 0.8) && Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) >= 3;
      };
      const sideOf = (m, p) => m.kind === "x" ? p[0] - m.k : m.kind === "y" ? p[1] - m.k : m.kind === "yx" ? p[1] - p[0] : p[1] + p[0];
      const clearMirror = (m, a) => {
        const g = (m.kind === "x" || m.kind === "y") ? 1 : 2;
        const s = a.map((p) => sideOf(m, p));
        return s.every((v) => v >= g) || s.every((v) => v <= -g);
      };
      const pointInTri = (p, t) => {
        const cr = (o, u, w) => (u[0] - o[0]) * (w[1] - o[1]) - (w[0] - o[0]) * (u[1] - o[1]);
        const d1 = cr(t[0], t[1], p), d2 = cr(t[1], t[2], p), d3 = cr(t[2], t[0], p);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
      };
      const mEqn = (m) => m.kind === "x" ? `x = ${m.k}` : m.kind === "y" ? `y = ${m.k}` : m.kind === "yx" ? "y = x" : "y = -x";
      const roll = Math.random();

      // ---------- 1. identify the transformation type ----------
      if (roll < 0.24) {
        for (let tries = 0; tries < 400; tries++) {
          const kind = pick(["translation", "rotation", "reflection", "enlargement"]);
          const a = randTri(-5, 3);
          let b, why;
          if (kind === "translation") {
            b = T.translate(a, [pick([-6, -5, -4, -3, 3, 4, 5, 6]), pick([-5, -4, -3, 3, 4, 5])]);
            why = "is the same size and the same way round — it has just slid across";
          } else if (kind === "rotation") {
            b = T.rotate(a, [randInt(-3, 3), randInt(-3, 3)], pick([90, -90, 180]));
            why = "is the same size and the same way round, but turned";
          } else if (kind === "reflection") {
            const m = pick([{ kind: "x", k: randInt(-3, 3) }, { kind: "y", k: randInt(-3, 3) }, { kind: "yx" }, { kind: "y-x" }]);
            if (!clearMirror(m, a)) continue;
            b = T.reflect(a, m);
            why = "is the same size but flipped — a mirror image";
          } else {
            b = T.enlarge(a, [randInt(-3, 3), randInt(-3, 3)], pick([-2, -2, -3]));
            why = "has changed size";
          }
          if (!b.every(inGrid) || !distinct(b) || !apart(a, b)) continue;
          if (kind !== "translation" && isSlide(a, b)) continue;
          const answer = kind[0].toUpperCase() + kind.slice(1);
          return {
            prompt: `Triangle A is mapped onto triangle B. Which single transformation is this?`,
            transform: { a, b },
            choices: ["Translation", "Rotation", "Enlargement", "Reflection"], answer,
            hint: "pick one",
            steps: [
              `Check: is B the same size as A? Is it flipped, turned, or just moved?`,
              `Triangle B ${why}.`,
              `So it is a ${answer.toLowerCase()}.`,
            ],
          };
        }
      }

      // ---------- 2. translation → find the vector ----------
      if (roll < 0.40) {
        for (let tries = 0; tries < 240; tries++) {
          const a = randTri(-5, 4);
          const v = [pick([-6, -5, -4, -3, -2, 2, 3, 4, 5, 6]), pick([-5, -4, -3, -2, 2, 3, 4, 5])];
          const b = T.translate(a, v);
          if (!b.every(inGrid) || !apart(a, b)) continue;
          return {
            prompt: `Triangle A is translated to triangle B. Write down the translation vector`,
            transform: { a, b },
            vector: true,
            fields: [{ key: "vx" }, { key: "vy" }],
            answers: { vx: `${v[0]}`, vy: `${v[1]}` },
            answer: `( ${v[0]} , ${v[1]} )`,
            hint: "top: across (+ right),  bottom: up/down (+ up)",
            steps: [
              `Pick a vertex of A and the matching vertex of B.`,
              `Across: ${v[0] >= 0 ? `${v[0]} right` : `${-v[0]} left`}  →  top number ${v[0]}.`,
              `Up/down: ${v[1] >= 0 ? `${v[1]} up` : `${-v[1]} down`}  →  bottom number ${v[1]}.`,
            ],
          };
        }
      }

      // ---------- 3. reflection → identify / draw the mirror line ----------
      if (roll < 0.56) {
        for (let tries = 0; tries < 300; tries++) {
          const a = randTri(-5, 5);
          const m = pick([
            { kind: "x", k: pick([-4, -3, -2, -1, 0, 1, 2, 3, 4]) },
            { kind: "y", k: pick([-4, -3, -2, -1, 0, 1, 2, 3, 4]) },
            { kind: "yx" }, { kind: "y-x" },
          ]);
          if (!clearMirror(m, a)) continue;
          const b = T.reflect(a, m);
          if (!b.every(inGrid) || !distinct(b) || !apart(a, b)) continue;
          const eqn = mEqn(m);
          if (Math.random() < 0.5) {
            return {
              prompt: `Triangle A is reflected onto triangle B. Draw the mirror line by tapping two points on it`,
              transform: { a, b },
              drawMirror: m,
              answer: eqn, hint: "tap two lattice points that lie on the mirror line",
              steps: [
                `Join each vertex of A to its image on B; the mirror line cuts every join in half at right angles.`,
                `Every matching pair of points is the same distance from it, on opposite sides.`,
                `The mirror line is ${eqn}.`,
              ],
            };
          }
          const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");
          const accept = new Set([norm(eqn)]);
          if (m.kind === "yx") { accept.add("y=x"); accept.add("x=y"); }
          if (m.kind === "y-x") { accept.add("y=-x"); accept.add("x=-y"); }
          return {
            prompt: `Triangle A is reflected onto triangle B. Write down the equation of the mirror line`,
            transform: { a, b, answerMirror: m },
            check: (inp) => accept.has(norm(inp)),
            answer: eqn, hint: "e.g. x = 2   or   y = -x",
            steps: [
              `Join each vertex of A to its image on B. The mirror line cuts every join in half, at right angles.`,
              `Matching points are equal distances from the mirror, on opposite sides.`,
              `Mirror line:  ${eqn}.`,
            ],
          };
        }
      }

      // ---------- 4. enlargement → scale factor (centre given) or centre (SF given) ----------
      if (roll < 0.72) {
        for (let tries = 0; tries < 400; tries++) {
          const c = [randInt(-3, 3), randInt(-3, 3)];
          const kind = pick(["p", "p", "p", "half", "neg", "neg"]);   // mostly positive
          let a, b, k, kTxt;
          if (kind === "half") {
            const inner = randTri(-2, 2);            // this becomes B
            a = inner.map(([x, y]) => [c[0] + 2 * (x - c[0]), c[1] + 2 * (y - c[1])]);
            b = inner; k = 0.5; kTxt = "1/2";
          } else if (kind === "neg") {
            a = randTri(-2, 2); k = -2; kTxt = "-2";
            b = T.enlarge(a, c, k);
          } else {
            a = randTri(-2, 2); k = pick([2, 2, 3]); kTxt = `${k}`;
            b = T.enlarge(a, c, k);
          }
          if (!a.every(inGrid) || !b.every(inGrid) || !distinct(b) || !distinct(a)) continue;
          if (area2(b) === area2(a)) continue;
          if (pointInTri(c, a) || pointInTri(c, b)) continue;
          if (k < 0 && !apart(a, b)) continue;   // negative SF: object and image must be clearly apart
          const rays = a.map((p, i) => [c, b[i]]);
          if (Math.random() < 0.55) return {
            prompt: `Triangle A is enlarged onto triangle B, centre (${c[0]}, ${c[1]}). Find the scale factor`,
            transform: { a, b, centre: c, rays },
            check: (inp) => { try { return Math.abs(evalString(String(inp), 0) - k) < 1e-6; } catch (e) { return false; } },
            answer: kTxt, hint: k === 0.5 ? "a fraction — B is smaller than A" : "a number — negative if B is on the far side of the centre",
            steps: [
              `Scale factor = image length ÷ object length for a pair of matching sides.`,
              `A side of B is ${k === 0.5 ? "half" : Math.abs(k) + " times"} the matching side of A${k < 0 ? ", and on the opposite side of the centre" : ""}.`,
              `Scale factor = ${kTxt}.`,
            ],
          };
          return {
            prompt: `Triangle A is enlarged onto triangle B with scale factor ${kTxt}. Find the centre of enlargement as (x, y)`,
            transform: { a, b, answerCentre: c, answerRays: rays },
            check: (inp) => { const p = parseVec(inp); return !!p && p[0] === c[0] && p[1] === c[1]; },
            answer: `(${c[0]}, ${c[1]})`, hint: "e.g. (1, -2)",
            steps: [
              `Draw a straight line through each vertex of A and its matching vertex of B.`,
              `All three lines meet at one point — the centre of enlargement.`,
              `Centre = (${c[0]}, ${c[1]}).`,
            ],
          };
        }
      }

      // ---------- 5. rotation → centre, or describe the rotation ----------
      if (roll < 0.86) {
        for (let tries = 0; tries < 400; tries++) {
          const a = randTri(-5, 3);
          const c = [randInt(-3, 3), randInt(-3, 3)];
          const spec = pick([{ deg: 90, t: "90° clockwise" }, { deg: -90, t: "90° anticlockwise" }, { deg: 180, t: "180°" }]);
          const b = T.rotate(a, c, spec.deg);
          if (!b.every(inGrid) || !distinct(b) || isSlide(a, b) || !apart(a, b)) continue;
          if (Math.random() < 0.22) return {   // "find the centre" is hard — keep it rare
            prompt: `Triangle A is rotated ${spec.t} onto triangle B. Find the centre of rotation as (x, y)`,
            transform: { a, b, answerCentre: c },
            check: (inp) => { const p = parseVec(inp); return !!p && p[0] === c[0] && p[1] === c[1]; },
            answer: `(${c[0]}, ${c[1]})`, hint: "e.g. (0, 1)",
            steps: [
              `The centre is the same distance from a vertex of A as from its image on B.`,
              spec.deg === 180 ? `For a 180° turn it is the midpoint of the join from a vertex to its image.` : `Draw the perpendicular bisector of two "vertex → image" joins; they cross at the centre.`,
              `Centre of rotation = (${c[0]}, ${c[1]}).`,
            ],
          };
          return {
            prompt: `Triangle A is rotated about (${c[0]}, ${c[1]}) onto triangle B. Describe the rotation`,
            transform: { a, b, centre: c },
            choices: ["90° clockwise", "90° anticlockwise", "180°"], answer: spec.t,
            hint: "pick one",
            steps: [
              `Follow one vertex of A round to its image on B, turning about the marked centre.`,
              `A quarter turn is 90°, a half turn is 180°. Check the direction.`,
              `This is a rotation of ${spec.t}.`,
            ],
          };
        }
      }

      // ---------- 6. draw the image (tap 3 vertices) ----------
      for (let tries = 0; tries < 500; tries++) {
        const a = randTri(-4, 4);
        const kind = pick(["translation", "reflection", "rotation", "enlargement"]);
        let b, desc;
        if (kind === "translation") {
          const v = [pick([-5, -4, -3, -2, 2, 3, 4, 5]), pick([-4, -3, -2, 2, 3, 4])];
          b = T.translate(a, v); desc = `Translate triangle A by the vector (${v[0]}, ${v[1]}).`;
        } else if (kind === "reflection") {
          const m = pick([{ kind: "x", k: pick([-3, -2, -1, 0, 1, 2, 3]) }, { kind: "y", k: pick([-3, -2, -1, 0, 1, 2, 3]) }, { kind: "yx" }, { kind: "y-x" }]);
          if (!clearMirror(m, a)) continue;
          b = T.reflect(a, m);
          desc = `Reflect triangle A in the line ${m.kind === "x" ? `x = ${m.k}` : m.kind === "y" ? `y = ${m.k}` : m.kind === "yx" ? "y = x" : "y = -x"}.`;
        } else if (kind === "rotation") {
          const c = [randInt(-3, 3), randInt(-3, 3)], s = pick([{ d: 90, t: "90° clockwise" }, { d: -90, t: "90° anticlockwise" }, { d: 180, t: "180°" }]);
          b = T.rotate(a, c, s.d); desc = `Rotate triangle A ${s.t} about (${c[0]}, ${c[1]}).`;
        } else {
          const c = [randInt(-3, 3), randInt(-3, 3)], k = pick([-2, -2, -3]);
          b = T.enlarge(a, c, k); desc = `Enlarge triangle A by scale factor ${k}, centre (${c[0]}, ${c[1]}).`;
        }
        if (!a.every(inGrid) || !b.every(inGrid) || !distinct(b) || !apart(a, b)) continue;
        return {
          prompt: `${desc}\nTap the three vertices of the image triangle.`,
          transform: { a, draw: true, image: b },
          drawTransform: { image: b },
          answer: b.map((p) => `(${p[0]}, ${p[1]})`).join(", "),
          hint: "tap three points — a fourth tap replaces the oldest",
          steps: [
            `Work one vertex of A at a time.`,
            desc,
            `Image vertices: ${b.map((p) => `(${p[0]}, ${p[1]})`).join(", ")}.`,
          ],
        };
      }
      const fa = [[0, 0], [3, 0], [0, 4]], fb = T.translate(fa, [2, 1]);
      return {
        prompt: `Translate triangle A by the vector (2, 1).\nTap the three vertices of the image triangle.`,
        transform: { a: fa, draw: true, image: fb }, drawTransform: { image: fb },
        answer: `(2, 1), (5, 1), (2, 5)`, hint: "tap three points",
        steps: [`Add (2, 1) to each vertex.`, `Image vertices: (2, 1), (5, 1), (2, 5).`],
      };
    } },
  { id: "kinematics", name: "Kinematics", icon: "🚗", prereqs: ["algebra", "coordgeo", "time"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const nz = (lo, hi) => { let v = 0; while (v === 0) v = randInt(lo, hi); return v; };
      const r = Math.random();

      // A — speed = distance ÷ time  (find speed / distance / time; time sometimes in minutes)
      if (r < 0.30) {
        const find = pick(["speed", "distance", "time"]);
        const minutes = Math.random() < 0.3;
        if (minutes) {
          const tMin = pick([30, 40, 45, 90, 120]);
          const g = gcd(tMin, 60), unit = 60 / g, tH = tMin / 60;
          const speed = unit * randInt(Math.ceil(16 / unit), Math.floor(80 / unit));
          const dist = Math.round(speed * tH);
          if (find === "speed") return { prompt: `A cyclist rides ${dist} km in ${tMin} minutes. Find the average speed in km/h`, answer: `${speed}`, hint: "convert the time to hours first",
            steps: [`${tMin} min = ${tMin} ÷ 60 = ${tH} h`, `Speed = ${dist} ÷ ${tH} = ${speed} km/h`] };
          if (find === "distance") return { prompt: `A cyclist rides at ${speed} km/h for ${tMin} minutes. Find the distance in km`, answer: `${dist}`, hint: "convert the time to hours first",
            steps: [`${tMin} min = ${tH} h`, `Distance = ${speed} × ${tH} = ${dist} km`] };
          return { prompt: `A cyclist rides ${dist} km at ${speed} km/h. Find the time taken in minutes`, answer: `${tMin}`, hint: "answer in minutes",
            steps: [`Time = ${dist} ÷ ${speed} = ${tH} h`, `${tH} h = ${tH} × 60 = ${tMin} min`] };
        }
        const ms = Math.random() < 0.45;
        const spU = ms ? "m/s" : "km/h", dU = ms ? "m" : "km", tU = ms ? "s" : "h";
        const t = randInt(2, 8), speed = ms ? randInt(2, 20) : randInt(20, 95), dist = speed * t;
        if (find === "speed") return { prompt: `An object travels ${dist} ${dU} in ${t} ${ms ? "seconds" : "hours"}. Find the average speed in ${spU}`, answer: `${speed}`, hint: "Enter a number.",
          steps: [`Speed = distance ÷ time`, `= ${dist} ÷ ${t} = ${speed} ${spU}`] };
        if (find === "distance") return { prompt: `An object travels at ${speed} ${spU} for ${t} ${ms ? "seconds" : "hours"}. Find the distance in ${dU}`, answer: `${dist}`, hint: "Enter a number.",
          steps: [`Distance = speed × time`, `= ${speed} × ${t} = ${dist} ${dU}`] };
        return { prompt: `An object travels ${dist} ${dU} at ${speed} ${spU}. Find the time taken in ${ms ? "seconds" : "hours"}`, answer: `${t}`, hint: "Enter a number.",
          steps: [`Time = distance ÷ speed`, `= ${dist} ÷ ${speed} = ${t} ${tU}`] };
      }

      // B — a = (v − u) ÷ t   (find a / v / u / t)
      if (r < 0.55) {
        const find = pick(["a", "v", "u", "t"]);
        const a = nz(-4, 4), t = randInt(2, 8);
        let u, v;
        if (a > 0) { u = randInt(0, 12); v = u + a * t; }
        else { v = randInt(0, 10); u = v - a * t; } // u = v + |a|·t  ≥ 0
        const speeding = a > 0;
        const aTxt = `${a} m/s²`;
        if (find === "a") return { prompt: `A vehicle ${speeding ? "speeds up" : "slows"} from ${u} m/s to ${v} m/s in ${t} s. Find the acceleration in m/s²`, answer: `${a}`, hint: "a = (v − u) ÷ t; negative when slowing",
          steps: [`a = (v − u) ÷ t`, `= (${v} − ${u}) ÷ ${t} = ${v - u} ÷ ${t} = ${a} m/s²`] };
        if (find === "v") return { prompt: `A vehicle starts at ${u} m/s and accelerates at ${aTxt} for ${t} s. Find the final speed in m/s`, answer: `${v}`, hint: "v = u + a·t",
          steps: [`v = u + a t`, `= ${u} + (${a})(${t}) = ${u} ${a * t >= 0 ? "+ " + a * t : "− " + -a * t} = ${v} m/s`] };
        if (find === "u") return { prompt: `A vehicle reaches ${v} m/s after accelerating at ${aTxt} for ${t} s. Find the initial speed in m/s`, answer: `${u}`, hint: "u = v − a·t",
          steps: [`u = v − a t`, `= ${v} − (${a})(${t}) = ${v} ${(-a * t) >= 0 ? "+ " + (-a * t) : "− " + (a * t)} = ${u} m/s`] };
        return { prompt: `A vehicle changes from ${u} m/s to ${v} m/s with acceleration ${aTxt}. Find the time taken in s`, answer: `${t}`, hint: "t = (v − u) ÷ a",
          steps: [`t = (v − u) ÷ a`, `= (${v} − ${u}) ÷ ${a} = ${v - u} ÷ ${a} = ${t} s`] };
      }

      // C — distance–time graph → gradient → speed of one stage
      if (r < 0.78) {
        // speeds are multiples of 10 so every point sits on a gridline
        const t1 = randInt(1, 2), s1 = 10 * randInt(2, 4), d1 = s1 * t1;
        const stopLen = randInt(1, 2), t2 = t1 + stopLen;
        const dt3 = randInt(2, 3), s3 = 10 * randInt(2, 4), d3 = d1 + s3 * dt3, t3 = t2 + dt3;
        const pts = [[0, 0], [t1, d1], [t2, d1], [t3, d3]];
        const stage = pick([1, 3]);
        const ans = stage === 1 ? s1 : s3;
        const hi = stage === 1 ? [0, 1] : [2, 3];
        return {
          prompt: `From the distance–time graph, find the speed during ${stage === 1 ? "the first stage" : "the final stage"} in km/h`,
          motion: { pts, yLabel: "distance", xUnit: "h", yUnit: "km", highlight: hi, gridY: 10, gridX: 1 },
          answer: `${ans}`, hint: "speed = gradient of the line",
          steps: [
            `Speed = gradient = change in distance ÷ change in time`,
            stage === 1 ? `= (${d1} − 0) ÷ (${t1} − 0) = ${d1} ÷ ${t1} = ${ans} km/h`
              : `= (${d3} − ${d1}) ÷ (${t3} − ${t2}) = ${d3 - d1} ÷ ${t3 - t2} = ${ans} km/h`,
          ],
        };
      }

      // D — speed–time graph → area (distance) or gradient (acceleration)
      const kind = pick(["accel", "decel", "distTri", "distRect", "distTotal"]);
      const cruise = randInt(2, 5);
      // keep the peak speed even so it lands on the step-2 grid
      let t1, decel, v1;
      if (kind === "accel") { t1 = pick([2, 4]); decel = randInt(2, 4); v1 = t1 * pick([2, 3, 4, 5]); }
      else if (kind === "decel") { decel = pick([2, 4]); t1 = randInt(2, 5); v1 = decel * pick([2, 3, 4, 5]); }
      else { t1 = randInt(2, 5); decel = randInt(2, 4); v1 = 2 * randInt(3, 10); }
      const t2 = t1 + cruise, t3 = t2 + decel;
      const pts = [[0, 0], [t1, v1], [t2, v1], [t3, 0]];
      const stg = { yLabel: "speed", xUnit: "s", yUnit: "m/s", gridY: 2, gridX: 1 };
      if (kind === "accel") return {
        prompt: `From the speed–time graph, find the acceleration during the first ${t1} s in m/s²`,
        motion: { pts, ...stg, highlight: [0, 1] },
        answer: `${v1 / t1}`, hint: "acceleration = gradient",
        steps: [`Acceleration = gradient = ${v1} ÷ ${t1} = ${v1 / t1} m/s²`],
      };
      if (kind === "decel") return {
        prompt: `From the speed–time graph, find the deceleration during the last ${decel} s in m/s²`,
        motion: { pts, ...stg, highlight: [2, 3] },
        answer: `${v1 / decel}`, hint: "deceleration = size of the gradient",
        steps: [`Deceleration = gradient size = ${v1} ÷ ${decel} = ${v1 / decel} m/s²`],
      };
      if (kind === "distTri") return {
        prompt: `From the speed–time graph, find the distance travelled in the first ${t1} s in m`,
        motion: { pts, ...stg, highlight: [0, 1], shadeFrom: 0, shadeTo: t1 },
        answer: `${(t1 * v1) / 2}`, hint: "distance = area under the graph",
        steps: [`Area of the triangle = ½ × base × height`, `= ½ × ${t1} × ${v1} = ${(t1 * v1) / 2} m`],
      };
      if (kind === "distRect") return {
        prompt: `From the speed–time graph, find the distance travelled while the speed is constant, in m`,
        motion: { pts, ...stg, highlight: [1, 2], shadeFrom: t1, shadeTo: t2 },
        answer: `${cruise * v1}`, hint: "distance = area under the graph",
        steps: [`Area of the rectangle = ${cruise} × ${v1} = ${cruise * v1} m`],
      };
      const total = (t1 * v1) / 2 + cruise * v1 + (decel * v1) / 2;
      return {
        prompt: `From the speed–time graph, find the total distance travelled in m`,
        motion: { pts, ...stg, shadeFrom: 0, shadeTo: t3 },
        answer: `${total}`, hint: "distance = total area under the graph",
        steps: [
          `Split into triangle + rectangle + triangle`,
          `= ½·${t1}·${v1}  +  ${cruise}·${v1}  +  ½·${decel}·${v1}`,
          `= ${(t1 * v1) / 2} + ${cruise * v1} + ${(decel * v1) / 2} = ${total} m`,
        ],
      };
    } },
  { id: "dailymaths", name: "Daily Maths", icon: "🛒", prereqs: ["algebra"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const money = (n) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));
      const r = Math.random();

      // A — percentage change: find new amount / original amount / percentage
      if (r < 0.50) {
        const up = Math.random() < 0.5;
        const noun = pick(["jacket", "laptop", "bicycle", "sofa", "watch", "monthly bill"]);
        const find = pick(["new", "original", "percent"]);
        const pct = pick([5, 10, 12, 15, 20, 25, 30, 40]);
        const g = gcd(pct, 100), step = 100 / g;
        const orig = step * randInt(Math.ceil(40 / step), Math.floor(400 / step));
        const change = (orig * pct) / 100;
        const nw = up ? orig + change : orig - change;
        const verb = up ? "goes up" : "goes down";
        if (find === "new") return {
          prompt: `A ${noun} costs $${orig}. The price ${verb} by ${pct}%. Find the new price`,
          answer: `${nw}`, hint: "Enter a number ($).",
          steps: [`Change = ${pct}% of $${orig} = $${change}`, `New price = $${orig} ${up ? "+" : "−"} $${change} = $${nw}`],
        };
        if (find === "original") return {
          prompt: `After ${up ? "a rise" : "a fall"} of ${pct}%, a ${noun} costs $${nw}. Find the original price`,
          answer: `${orig}`, hint: "Enter a number ($).",
          steps: [`$${nw} is ${100 + (up ? pct : -pct)}% of the original price`, `Original = $${nw} ÷ ${(100 + (up ? pct : -pct)) / 100} = $${orig}`],
        };
        return {
          prompt: `A ${noun}'s price changes from $${orig} to $${nw}. Find the percentage ${up ? "increase" : "decrease"}`,
          answer: `${pct}`, hint: "Enter a number (%).",
          steps: [`Change = $${Math.abs(nw - orig)}`, `Percentage = ${Math.abs(nw - orig)} ÷ ${orig} × 100 = ${pct}%`],
        };
      }

      // B — simple interest
      if (r < 0.72) {
        const P = randInt(2, 20) * 100, R = pick([2, 3, 4, 5, 6, 8, 10]), T = randInt(2, 6);
        const I = (P * R * T) / 100, total = P + I;
        const findTotal = Math.random() < 0.5;
        return {
          prompt: `$${P} is invested at ${R}% simple interest per year for ${T} years. Find the ${findTotal ? "total amount" : "interest earned"}`,
          answer: `${findTotal ? total : I}`, hint: "Enter a number ($).",
          steps: [
            `Simple interest = P × R × T ÷ 100`,
            `= ${P} × ${R} × ${T} ÷ 100 = ${I}`,
            findTotal ? `Total = ${P} + ${I} = ${total}` : `Interest earned = ${I}`,
          ],
        };
      }

      // C — compound interest / exponential growth & decay
      const grow = Math.random() < 0.6;
      const P = randInt(2, 20) * 100, R = pick([5, 10, 20, 25]), T = randInt(2, 4);
      const factor = grow ? 1 + R / 100 : 1 - R / 100;
      const amount = Math.round(P * Math.pow(factor, T) * 100) / 100;
      const scenario = grow
        ? pick([
          { text: `$${P} is invested at ${R}% compound interest per year`, unit: "years", ask: "total value" },
          { text: `A $${P} painting rises in value by ${R}% each year`, unit: "years", ask: "value" },
          { text: `A colony of ${P} bacteria grows by ${R}% every hour`, unit: "hours", ask: "number of bacteria" },
        ])
        : pick([
          { text: `A car bought for $${P} loses ${R}% of its value each year`, unit: "years", ask: "value" },
          { text: `A ${P} g radioactive sample decays by ${R}% each year`, unit: "years", ask: "mass in grams" },
          { text: `A town of ${P} people shrinks by ${R}% each year`, unit: "years", ask: "population" },
        ]);
      return {
        prompt: `${scenario.text}. Find the ${scenario.ask} after ${T} ${scenario.unit}`,
        answer: `${amount}`, hint: "a decimal is fine",
        steps: [
          `${grow ? "Grows" : "Shrinks"} to ${money(factor * 100)}% each ${scenario.unit.slice(0, -1)} → multiply by ${money(factor)}`,
          `Amount = ${P} × ${money(factor)}^${T}`,
          `= ${amount}`,
        ],
      };
    } },
  { id: "mensuration", name: "Mensuration", icon: "▦", prereqs: [],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const even = (lo, hi) => 2 * randInt(Math.ceil(lo / 2), Math.floor(hi / 2));
      const r = Math.random();

      // ---------- rectangle ----------
      if (r < 0.13) {
        const l = randInt(4, 18), w = randInt(3, 12);
        if (Math.random() < 0.5) return {
          prompt: `Find the area of this rectangle`, solid: { shape: "rect", dims: { l, w } },
          answer: `${l * w}`, hint: "Enter a number (cm²).",
          steps: [`Area = length × width`, `= ${l} × ${w} = ${l * w} cm²`] };
        return {
          prompt: `Find the perimeter of this rectangle`, solid: { shape: "rect", dims: { l, w } },
          answer: `${2 * (l + w)}`, hint: "Enter a number (cm).",
          steps: [`Perimeter = 2 × (length + width)`, `= 2 × (${l} + ${w}) = ${2 * (l + w)} cm`] };
      }

      // ---------- square ----------
      if (r < 0.23) {
        const s = randInt(4, 16), area = s * s;
        if (Math.random() < 0.5) return {
          prompt: `Find the area of this square`, solid: { shape: "square", dims: { s } },
          answer: `${area}`, hint: "Enter a number (cm²).",
          steps: [`Area = side²`, `= ${s}² = ${area} cm²`] };
        return {
          prompt: `This square has area ${area} cm². Find the length of one side`,
          solid: { shape: "square", dims: { s: "?" } },
          answer: `${s}`, hint: "Enter a number (cm).",
          steps: [`side = √area`, `= √${area} = ${s} cm`] };
      }

      // ---------- triangle: area = ½ × base × height ----------
      if (r < 0.36) {
        const b = randInt(5, 18), h = even(4, 14);
        return {
          prompt: `Find the area of this triangle`, solid: { shape: "triangle", dims: { b, h } },
          answer: `${(b * h) / 2}`, hint: "Enter a number (cm²).",
          steps: [`Area = ½ × base × height`, `= ½ × ${b} × ${h} = ${(b * h) / 2} cm²`] };
      }

      // ---------- parallelogram: area = base × height ----------
      if (r < 0.46) {
        const b = randInt(5, 16), h = randInt(3, 12);
        return {
          prompt: `Find the area of this parallelogram`, solid: { shape: "parallelogram", dims: { b, h } },
          answer: `${b * h}`, hint: "Enter a number (cm²).",
          steps: [`Area = base × perpendicular height`, `= ${b} × ${h} = ${b * h} cm²`] };
      }

      // ---------- trapezium: area = ½ (a + b) h ----------
      if (r < 0.58) {
        let a = randInt(4, 12), b = randInt(a + 2, a + 12), h = randInt(3, 12);
        if ((a + b) % 2 && h % 2) h += 1;
        return {
          prompt: `Find the area of this trapezium`, solid: { shape: "trapezium", dims: { a, b, h } },
          answer: `${((a + b) * h) / 2}`, hint: "Enter a number (cm²).",
          steps: [`Area = ½ × (sum of the parallel sides) × height`, `= ½ × (${a} + ${b}) × ${h} = ½ × ${a + b} × ${h} = ${((a + b) * h) / 2} cm²`] };
      }

      // ---------- cuboid: volume or surface area ----------
      if (r < 0.70) {
        const l = randInt(3, 9), w = randInt(2, 7), h = randInt(2, 7);
        if (Math.random() < 0.55) return {
          prompt: `Find the volume of this cuboid`, solid: { shape: "cuboid", dims: { l, w, h } },
          answer: `${l * w * h}`, hint: "Enter a number (cm³).",
          steps: [`Volume = length × width × height`, `= ${l} × ${w} × ${h} = ${l * w * h} cm³`] };
        const sa = 2 * (l * w + l * h + w * h);
        return {
          prompt: `Find the total surface area of this cuboid`, solid: { shape: "cuboid", dims: { l, w, h } },
          answer: `${sa}`, hint: "Enter a number (cm²).",
          steps: [`Surface area = 2(lw + lh + wh)`, `= 2(${l * w} + ${l * h} + ${w * h}) = 2 × ${l * w + l * h + w * h} = ${sa} cm²`] };
      }

      // ---------- cylinder: volume or curved surface area (in terms of π) ----------
      if (r < 0.82) {
        const rad = randInt(2, 7), h = randInt(3, 12);
        if (Math.random() < 0.55) return {
          prompt: `Find the volume of this cylinder. Leave your answer in terms of π`,
          solid: { shape: "cylinder", dims: { r: rad, h } },
          answer: `${rad * rad * h}π`, hint: "give your answer as a multiple of π",
          steps: [`Volume = πr²h`, `= π × ${rad}² × ${h} = ${rad * rad * h}π cm³`] };
        return {
          prompt: `Find the curved surface area of this cylinder. Leave your answer in terms of π`,
          solid: { shape: "cylinder", dims: { r: rad, h } },
          answer: `${2 * rad * h}π`, hint: "give your answer as a multiple of π",
          steps: [`Curved surface area = 2πrh`, `= 2 × π × ${rad} × ${h} = ${2 * rad * h}π cm²`] };
      }

      // ---------- cone: volume or curved surface area (in terms of π) ----------
      if (r < 0.91) {
        if (Math.random() < 0.5) {
          const rad = pick([3, 6]), h = randInt(3, 10);
          return {
            prompt: `Find the volume of this cone. Leave your answer in terms of π`,
            solid: { shape: "cone", dims: { r: rad, h } },
            answer: `${(rad * rad * h) / 3}π`, hint: "give your answer as a multiple of π",
            steps: [`Volume = ⅓ × πr²h`, `= ⅓ × π × ${rad}² × ${h} = ${(rad * rad * h) / 3}π cm³`] };
        }
        const [rad, , slant] = pick([[3, 4, 5], [6, 8, 10], [5, 12, 13], [9, 12, 15], [8, 15, 17]]);
        return {
          prompt: `This cone has base radius ${rad} cm and slant height ${slant} cm. Find the curved surface area in terms of π`,
          solid: { shape: "cone", dims: { r: rad, slant } },
          answer: `${rad * slant}π`, hint: "give your answer as a multiple of π",
          steps: [`Curved surface area = πrl`, `= π × ${rad} × ${slant} = ${rad * slant}π cm²`] };
      }

      // ---------- sphere: volume or surface area (in terms of π) ----------
      if (Math.random() < 0.5) {
        const rad = pick([3, 6]);
        return {
          prompt: `Find the volume of this sphere. Leave your answer in terms of π`,
          solid: { shape: "sphere", dims: { r: rad } },
          answer: `${(4 * rad * rad * rad) / 3}π`, hint: "give your answer as a multiple of π",
          steps: [`Volume = 4⁄3 × πr³`, `= 4⁄3 × π × ${rad}³ = ${(4 * rad * rad * rad) / 3}π cm³`] };
      }
      const rad = randInt(2, 8);
      return {
        prompt: `Find the surface area of this sphere. Leave your answer in terms of π`,
        solid: { shape: "sphere", dims: { r: rad } },
        answer: `${4 * rad * rad}π`, hint: "give your answer as a multiple of π",
        steps: [`Surface area = 4πr²`, `= 4 × π × ${rad}² = ${4 * rad * rad}π cm²`] };
    } },
  { id: "similarity", name: "Similarity", icon: "🔺", prereqs: ["mensuration"],
    generate() {
      const a = randInt(2, 6), k = randInt(2, 4), area = randInt(4, 20);
      return { prompt: `Two similar triangles have corresponding sides ${a} cm and ${a * k} cm. The smaller triangle has area ${area} cm². Find the area of the larger triangle`, answer: `${area * k * k}`, hint: "Enter a number (cm²).",
        steps: [`Scale factor (length) = ${a * k} ÷ ${a} = ${k}`, `Scale factor (area) = ${k}² = ${k * k}`, `Larger area = ${area} × ${k * k} = ${area * k * k} cm²`] };
    } },
  { id: "symmetry", name: "Symmetry", icon: "🦋", prereqs: [],
    generate() {
      const keys = Object.keys(SHAPES);
      const k = keys[randInt(0, keys.length - 1)];
      const s = SHAPES[k];
      const cap = (t) => t[0].toUpperCase() + t.slice(1);
      const askLines = Math.random() < 0.5;
      return {
        prompt: askLines
          ? `The shape shown is ${s.label}.\nHow many lines of symmetry does it have?`
          : `The shape shown is ${s.label}.\nWhat is its order of rotational symmetry?`,
        figure: { shape: k, showSymAfter: askLines },
        answer: `${askLines ? s.lines : s.rot}`, hint: "Enter a number.",
        steps: askLines
          ? [`${cap(s.label)} has ${s.lines} line${s.lines === 1 ? "" : "s"} of symmetry.`]
          : [`Turned through a full circle, ${s.label} looks the same ${s.rot} time${s.rot === 1 ? "" : "s"}.`, `Order of rotational symmetry = ${s.rot}.`],
      };
    } },
  { id: "polygons", name: "Polygons", icon: "⬡", prereqs: [],
    generate() {
      const NAME = { 3: "triangle", 4: "quadrilateral", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", 9: "nonagon", 10: "decagon", 11: "hendecagon", 12: "dodecagon" };
      const named = (n) => NAME[n] || `${n}-sided polygon`;
      const A = (n) => `${/^(octagon|8|11|18)/.test(named(n)) ? "an" : "a"} ${named(n)}`;
      const pick = (a) => a[randInt(0, a.length - 1)];
      const div360 = [3, 4, 5, 6, 8, 9, 10, 12]; // regular polygons with whole-number angles
      const r = Math.random();

      if (r < 0.22) {
        const n = pick([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), sum = (n - 2) * 180;
        return { prompt: `Find the sum of the interior angles of ${A(n)}, in degrees`, answer: `${sum}`, hint: "Enter a number.",
          steps: [`Sum of interior angles = (n − 2) × 180°`, `= (${n} − 2) × 180 = ${sum}°`] };
      }
      if (r < 0.44) {
        const n = pick(div360), each = ((n - 2) * 180) / n;
        return { prompt: `Find the size of each interior angle of a regular ${named(n)}, in degrees`, answer: `${each}`, hint: "Enter a number.",
          steps: [`Sum of interior angles = (${n} − 2) × 180 = ${(n - 2) * 180}°`, `Each = ${(n - 2) * 180} ÷ ${n} = ${each}°`] };
      }
      if (r < 0.56) {
        const n = pick(div360), each = 360 / n;
        return { prompt: `Find the size of each exterior angle of a regular ${named(n)}, in degrees`, answer: `${each}`, hint: "Enter a number.",
          steps: [`The exterior angles of any polygon add up to 360°`, `Each = 360 ÷ ${n} = ${each}°`] };
      }
      if (r < 0.78) {
        const n = randInt(3, 14), sum = (n - 2) * 180;
        return { prompt: `The interior angles of a polygon add up to ${sum}°. How many sides does it have?`, answer: `${n}`, hint: "Enter a number.",
          steps: [`(n − 2) × 180 = ${sum}`, `n − 2 = ${sum} ÷ 180 = ${sum / 180}`, `n = ${n}`] };
      }
      if (r < 0.88) {
        const n = pick([3, 4, 5, 6, 8, 9, 10, 12, 15, 18, 20, 24]), ext = 360 / n;
        return { prompt: `Each exterior angle of a regular polygon is ${ext}°. How many sides does it have?`, answer: `${n}`, hint: "Enter a number.",
          steps: [`Number of sides = 360 ÷ (each exterior angle)`, `= 360 ÷ ${ext} = ${n}`] };
      }
      const n = pick([3, 4, 5, 6, 8, 9, 10, 12, 15, 18, 20]), interior = ((n - 2) * 180) / n, ext = 180 - interior;
      return { prompt: `Each interior angle of a regular polygon is ${interior}°. How many sides does it have?`, answer: `${n}`, hint: "Enter a number.",
        steps: [`Each exterior angle = 180 − ${interior} = ${ext}°`, `Number of sides = 360 ÷ ${ext} = ${n}`] };
    } },
  { id: "trigonometry", name: "Trigonometry", icon: "📐", prereqs: ["polygons"],
    generate() {
      const D = Math.PI / 180;
      const pick = (a) => a[randInt(0, a.length - 1)];
      const r1 = (x) => Math.round(x * 10) / 10;
      const approx = (val) => (inp) => { try { const x = evalString(String(inp), 0); return Number.isFinite(x) && Math.abs(x - val) <= Math.max(0.15, Math.abs(val) * 0.02); } catch (e) { return false; } };
      // A at origin, B on +x (AB = side c), C from angle A and AC = side b
      const layout = (AB, AC, angA) => [[0, 0], [AB, 0], [AC * Math.cos(angA * D), -AC * Math.sin(angA * D)]];
      // right angle at C: C origin, A on +x (leg adj), B up (leg opp)
      const rlayout = (adj, opp) => [[adj, 0], [0, -opp], [0, 0]];

      const r = Math.random();

      if (r < 0.16) {
        // Pythagoras — ~40% ask for a leg (using a triple so it's a whole number)
        if (Math.random() < 0.4) {
          const [x, y, h] = pick([[3, 4, 5], [6, 8, 10], [5, 12, 13], [8, 15, 17], [9, 12, 15], [7, 24, 25], [20, 21, 29], [12, 16, 20], [10, 24, 26], [9, 40, 41]]);
          const giveX = Math.random() < 0.5;
          const known = giveX ? x : y, unknown = giveX ? y : x;
          const sl = ["", "", ""];
          sl[2] = `${h} cm`;                       // rlayout(x,y): edge 2 = hypotenuse
          sl[giveX ? 1 : 0] = `${known} cm`;       // edge 1 = leg x (adj), edge 0 = leg y (opp)
          sl[giveX ? 0 : 1] = "?";
          return {
            prompt: `Find the length marked ?, in cm`,
            tri: { verts: rlayout(x, y), sideLabels: sl, rightAngle: 2 },
            answer: `${unknown}`, hint: "rearrange Pythagoras", check: approx(unknown),
            steps: [`Pythagoras:  (missing side)² = ${h}² − ${known}²`, `= ${h * h} − ${known * known} = ${h * h - known * known}`, `missing side = √${h * h - known * known} = ${unknown} cm`],
          };
        }
        const p = randInt(4, 13), q = randInt(4, 13), hyp = Math.sqrt(p * p + q * q);
        return {
          prompt: `Find the length of the hypotenuse (marked ?), in cm`,
          tri: { verts: rlayout(p, q), sideLabels: [`${q} cm`, `${p} cm`, "?"], rightAngle: 2 },
          answer: `sqrt(${p * p + q * q})`, hint: "leave it as √n or a decimal", check: approx(hyp),
          steps: [`Pythagoras:  hyp² = ${p}² + ${q}²`, `= ${p * p} + ${q * q} = ${p * p + q * q}`, `hyp = √${p * p + q * q} = ${r1(hyp)} cm`],
        };
      }

      if (r < 0.33) {
        // SOH CAH TOA — find a side
        const th = pick([32, 36, 40, 44, 48, 52, 56, 60]);
        const hyp = randInt(8, 16), adj = hyp * Math.cos(th * D), opp = hyp * Math.sin(th * D);
        const sides = { hyp, adj, opp };
        const [given, ask] = pick([["hyp", "opp"], ["hyp", "adj"], ["adj", "opp"], ["adj", "hyp"], ["opp", "adj"], ["opp", "hyp"]]);
        const val = sides[ask];
        const lbl = { opp: 0, adj: 1, hyp: 2 }; // edge index in rlayout(adj,opp) verts [A,B,C]
        const sl = ["", "", ""];
        sl[lbl[given]] = `${r1(sides[given])} cm`;
        sl[lbl[ask]] = "?";
        const ratio = (a, b) => (a === "opp" && b === "hyp") || (a === "hyp" && b === "opp") ? "sin" : (a === "adj" && b === "hyp") || (a === "hyp" && b === "adj") ? "cos" : "tan";
        const rt = ratio(given, ask);
        return {
          prompt: `Find the length marked ?, in cm  (1 d.p.)`,
          tri: { verts: rlayout(adj, opp), sideLabels: sl, angleLabels: ["", "", ""].map((_, i) => (i === 0 ? `${th}°` : "")), rightAngle: 2 },
          answer: `${r1(val)}`, hint: "SOH CAH TOA", check: approx(val),
          steps: [
            `Relative to ${th}°:  opp, adj, hyp — use ${rt === "sin" ? "SOH" : rt === "cos" ? "CAH" : "TOA"}.`,
            `${rt}(${th}°) = ${rt === "sin" ? "opp ÷ hyp" : rt === "cos" ? "adj ÷ hyp" : "opp ÷ adj"}`,
            `${ask} = ${r1(val)} cm`,
          ],
        };
      }

      if (r < 0.45) {
        // SOH CAH TOA — find an angle
        const th = pick([33, 37, 42, 46, 50, 54, 58]);
        const hyp = randInt(9, 16), adj = hyp * Math.cos(th * D), opp = hyp * Math.sin(th * D);
        const sides = { hyp, adj, opp };
        const shown = pick([["opp", "hyp"], ["adj", "hyp"], ["opp", "adj"]]);
        const lbl = { opp: 0, adj: 1, hyp: 2 };
        const sl = ["", "", ""];
        shown.forEach((k) => { sl[lbl[k]] = `${r1(sides[k])} cm`; });
        const rt = shown.includes("hyp") ? (shown.includes("opp") ? "sin" : "cos") : "tan";
        return {
          prompt: `Find the angle marked ?, in degrees  (1 d.p.)`,
          tri: { verts: rlayout(adj, opp), sideLabels: sl, angleLabels: ["?", "", ""], rightAngle: 2 },
          answer: `${r1(th)}`, hint: "use sin⁻¹, cos⁻¹ or tan⁻¹", check: approx(th),
          steps: [
            `${rt}(x) = ${rt === "sin" ? "opp ÷ hyp" : rt === "cos" ? "adj ÷ hyp" : "opp ÷ adj"} = ${r1(sides[shown[0]] / sides[shown[1]] * 1000) / 1000}`,
            `x = ${rt}⁻¹(…) = ${r1(th)}°`,
          ],
        };
      }

      if (r < 0.57) {
        // sine rule — find a side
        let A = pick([35, 40, 45, 50, 55, 60, 70, 80]), B = pick([35, 40, 45, 50, 55, 60, 70]);
        while (A + B > 150 || B === A) B = pick([35, 40, 45, 50, 55]);
        const C = 180 - A - B, a = randInt(6, 14);
        const b = a * Math.sin(B * D) / Math.sin(A * D), c = a * Math.sin(C * D) / Math.sin(A * D);
        return {
          prompt: `Find the length marked ?, in cm  (1 d.p.)`,
          tri: { verts: layout(c, b, A), sideLabels: [`${a} cm`, "?", ""], angleLabels: [`${A}°`, `${B}°`, ""], vertLabels: ["A", "B", "C"] },
          answer: `${r1(b)}`, hint: "sine rule:  a / sin A = b / sin B", check: approx(b),
          steps: [`b / sin ${B}° = ${a} / sin ${A}°`, `b = ${a} × sin ${B}° ÷ sin ${A}° = ${r1(b)} cm`],
        };
      }

      if (r < 0.65) {
        // sine rule — find an angle  (A + B ≤ 130 by construction)
        const A = pick([30, 40, 50, 60, 70]);
        let B = pick([35, 40, 45, 50, 55, 60]);
        while (B === A) B = pick([35, 45, 55]);
        const a = randInt(8, 14), b = a * Math.sin(B * D) / Math.sin(A * D);
        return {
          prompt: `The angle marked ? is acute. Find it, in degrees  (1 d.p.)`,
          tri: { verts: layout(a * Math.sin((180 - A - B) * D) / Math.sin(A * D), b, A), sideLabels: [`${a} cm`, `${r1(b)} cm`, ""], angleLabels: [`${A}°`, "?", ""], vertLabels: ["A", "B", "C"] },
          answer: `${r1(B)}`, hint: "sine rule:  sin B / b = sin A / a", check: approx(B),
          steps: [`sin B / ${r1(b)} = sin ${A}° / ${a}`, `sin B = ${r1(b)} × sin ${A}° ÷ ${a}`, `B = ${r1(B)}°`],
        };
      }

      if (r < 0.78) {
        // cosine rule — find a side
        const A = pick([35, 45, 55, 65, 75, 100, 110]);
        let b = randInt(5, 12), c = randInt(5, 12);
        while (Math.abs(b - c) > 5) c = randInt(5, 12); // keep the triangle from being a sliver
        const a = Math.sqrt(b * b + c * c - 2 * b * c * Math.cos(A * D));
        return {
          prompt: `Find the length marked ?, in cm  (1 d.p.)`,
          tri: { verts: layout(c, b, A), sideLabels: ["?", `${b} cm`, `${c} cm`], angleLabels: [`${A}°`, "", ""], vertLabels: ["A", "B", "C"] },
          answer: `${r1(a)}`, hint: "cosine rule:  a² = b² + c² − 2bc·cos A", check: approx(a),
          steps: [`a² = ${b}² + ${c}² − 2(${b})(${c})cos ${A}°`, `= ${b * b} + ${c * c} − ${b * c * 2}·cos ${A}° = ${r1(a * a)}`, `a = ${r1(a)} cm`],
        };
      }

      if (r < 0.86) {
        // cosine rule — find an angle  (every angle ≥ ~25° so it's not a sliver)
        let b, c, a, A, B, C;
        for (let i = 0; i < 40; i++) {
          b = randInt(6, 12); c = randInt(6, 12);
          a = randInt(Math.max(3, Math.abs(b - c) + 3), b + c - 3);
          A = Math.acos((b * b + c * c - a * a) / (2 * b * c)) / D;
          B = Math.acos((a * a + c * c - b * b) / (2 * a * c)) / D;
          C = 180 - A - B;
          if (Math.min(A, B, C) >= 25) break;
        }
        return {
          prompt: `Find the angle marked ?, in degrees  (1 d.p.)`,
          tri: { verts: layout(c, b, A), sideLabels: [`${a} cm`, `${b} cm`, `${c} cm`], angleLabels: ["?", "", ""], vertLabels: ["A", "B", "C"] },
          answer: `${r1(A)}`, hint: "cos A = (b² + c² − a²) ÷ 2bc", check: approx(A),
          steps: [`cos A = (${b}² + ${c}² − ${a}²) ÷ (2 × ${b} × ${c})`, `= ${r1((b * b + c * c - a * a) / (2 * b * c) * 1000) / 1000}`, `A = ${r1(A)}°`],
        };
      }

      if (r < 0.93) {
        // area of a right-angled triangle
        const base = randInt(4, 16), h = randInt(3, 15), area = (base * h) / 2;
        return {
          prompt: `Find the area of the triangle, in cm²`,
          tri: { verts: rlayout(base, h), sideLabels: [`${h} cm`, `${base} cm`, ""], rightAngle: 2 },
          answer: `${area}`, hint: "area = ½ × base × height", check: approx(area),
          steps: [`Area = ½ × base × height`, `= ½ × ${base} × ${h} = ${area} cm²`],
        };
      }

      // area of a non-right triangle
      const A = pick([40, 50, 60, 70, 110, 120, 130]);
      let b = randInt(6, 13), c = randInt(6, 13);
      while (Math.abs(b - c) > 5) c = randInt(6, 13);
      const area = 0.5 * b * c * Math.sin(A * D);
      return {
        prompt: `Find the area of the triangle, in cm²  (1 d.p.)`,
        tri: { verts: layout(c, b, A), sideLabels: ["", `${b} cm`, `${c} cm`], angleLabels: [`${A}°`, "", ""], vertLabels: ["A", "B", "C"] },
        answer: `${r1(area)}`, hint: "area = ½ · b · c · sin A", check: approx(area),
        steps: [`Area = ½ × ${b} × ${c} × sin ${A}°`, `= ${r1(area)} cm²`],
      };
    } },
  { id: "circles", name: "Circles", icon: "⭕", prereqs: ["trigonometry"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const roll = Math.random();

      // ---------- circumference:  C = 2πr = πd ----------
      if (roll < 0.11) {
        const rad = randInt(3, 14), d = 2 * rad;
        const v = pick(["r2C", "d2C", "C2r", "C2d"]);
        if (v === "r2C") return {
          prompt: `Find the circumference of this circle. Leave your answer in terms of π`,
          circle: { type: "line", mode: "radius", label: `r = ${rad} cm` },
          answer: `${2 * rad}π`, hint: "give your answer as a multiple of π",
          steps: [`Circumference = 2πr`, `= 2 × π × ${rad} = ${2 * rad}π cm`] };
        if (v === "d2C") return {
          prompt: `Find the circumference of this circle. Leave your answer in terms of π`,
          circle: { type: "line", mode: "diameter", label: `d = ${d} cm` },
          answer: `${d}π`, hint: "give your answer as a multiple of π",
          steps: [`Circumference = πd`, `= π × ${d} = ${d}π cm`] };
        if (v === "C2r") return {
          prompt: `The circumference of this circle is ${2 * rad}π cm. Find the radius`,
          circle: { type: "line", mode: "radius", label: `r = ?` },
          answer: `${rad}`, hint: "Enter a number.",
          steps: [`C = 2πr`, `${2 * rad}π = 2πr`, `r = ${2 * rad} ÷ 2 = ${rad} cm`] };
        return {
          prompt: `The circumference of this circle is ${d}π cm. Find the diameter`,
          circle: { type: "line", mode: "diameter", label: `d = ?` },
          answer: `${d}`, hint: "Enter a number.",
          steps: [`C = πd`, `${d}π = πd`, `d = ${d} cm`] };
      }

      // ---------- area:  A = πr² = πd²/4 ----------
      if (roll < 0.22) {
        const rad = randInt(2, 12), d = 2 * rad, k = rad * rad;
        const v = pick(["r2A", "d2A", "A2r", "A2d"]);
        if (v === "r2A") return {
          prompt: `Find the area of this circle. Leave your answer in terms of π`,
          circle: { type: "line", mode: "radius", label: `r = ${rad} cm` },
          answer: `${k}π`, hint: "give your answer as a multiple of π",
          steps: [`Area = πr²`, `= π × ${rad}² = ${k}π cm²`] };
        if (v === "d2A") return {
          prompt: `Find the area of this circle. Leave your answer in terms of π`,
          circle: { type: "line", mode: "diameter", label: `d = ${d} cm` },
          answer: `${k}π`, hint: "give your answer as a multiple of π",
          steps: [`Area = πd² ÷ 4`, `= π × ${d}² ÷ 4 = ${k}π cm²`] };
        if (v === "A2r") return {
          prompt: `The area of this circle is ${k}π cm². Find the radius`,
          circle: { type: "line", mode: "radius", label: `r = ?` },
          answer: `${rad}`, hint: "Enter a number.",
          steps: [`Area = πr²`, `${k}π = πr²`, `r² = ${k}`, `r = √${k} = ${rad} cm`] };
        return {
          prompt: `The area of this circle is ${k}π cm². Find the diameter`,
          circle: { type: "line", mode: "diameter", label: `d = ?` },
          answer: `${d}`, hint: "Enter a number.",
          steps: [`Area = πr²`, `${k}π = πr²`, `r = √${k} = ${rad}`, `d = 2 × ${rad} = ${d} cm`] };
      }

      // ---------- arc length:  s = (θ/360) × 2πr ----------
      if (roll < 0.335) {
        let th, rad, coeff;
        do { th = pick([30, 36, 40, 45, 60, 72, 80, 90, 120, 135, 150]); rad = randInt(3, 15); coeff = (th * rad) / 180; }
        while (!Number.isInteger(coeff) || coeff < 1 || coeff > 9);
        const v = pick(["find", "find", "angle", "radius"]);
        if (v === "find") return {
          prompt: `This sector has radius ${rad} cm and angle ${th}°. Find the arc length. Leave your answer in terms of π`,
          circle: { type: "sector", theta: th, angText: `${th}°`, rText: `${rad} cm`, arcText: `?` },
          answer: `${coeff}π`, hint: "give your answer as a multiple of π",
          steps: [`Arc length = (θ/360) × 2πr`, `= (${th}/360) × 2 × π × ${rad}`, `= ${coeff}π cm`] };
        if (v === "angle") return {
          prompt: `This sector has radius ${rad} cm and arc length ${coeff}π cm. Find the angle θ`,
          circle: { type: "sector", theta: th, angText: `θ = ?`, rText: `${rad} cm`, arcText: `${coeff}π cm` },
          answer: `${th}`, hint: "Angle in degrees.",
          steps: [`Arc length = (θ/360) × 2πr`, `${coeff}π = (θ/360) × 2π × ${rad}`, `θ = ${coeff} × 360 ÷ (2 × ${rad}) = ${th}°`] };
        return {
          prompt: `This sector has angle ${th}° and arc length ${coeff}π cm. Find the radius`,
          circle: { type: "sector", theta: th, angText: `${th}°`, rText: `r = ?`, arcText: `${coeff}π cm` },
          answer: `${rad}`, hint: "Enter a number.",
          steps: [`Arc length = (θ/360) × 2πr`, `${coeff}π = (${th}/360) × 2πr`, `r = ${coeff} × 360 ÷ (2 × ${th}) = ${rad} cm`] };
      }

      // ---------- sector area:  A = (θ/360) × πr² ----------
      if (roll < 0.45) {
        let th, rad, coeff;
        do { th = pick([30, 36, 40, 45, 60, 72, 90, 120, 135, 150]); rad = randInt(3, 14); coeff = (th * rad * rad) / 360; }
        while (!Number.isInteger(coeff) || coeff < 1 || coeff > 30);
        const v = pick(["find", "find", "angle", "radius"]);
        if (v === "find") return {
          prompt: `This sector has radius ${rad} cm and angle ${th}°. Find the area of the sector. Leave your answer in terms of π`,
          circle: { type: "sector", theta: th, angText: `${th}°`, rText: `${rad} cm`, areaText: `?` },
          answer: `${coeff}π`, hint: "give your answer as a multiple of π",
          steps: [`Sector area = (θ/360) × πr²`, `= (${th}/360) × π × ${rad}²`, `= ${coeff}π cm²`] };
        if (v === "angle") return {
          prompt: `This sector has radius ${rad} cm and area ${coeff}π cm². Find the angle θ`,
          circle: { type: "sector", theta: th, angText: `θ = ?`, rText: `${rad} cm`, areaText: `${coeff}π cm²` },
          answer: `${th}`, hint: "Angle in degrees.",
          steps: [`Sector area = (θ/360) × πr²`, `${coeff}π = (θ/360) × π × ${rad}²`, `θ = ${coeff} × 360 ÷ ${rad * rad} = ${th}°`] };
        return {
          prompt: `This sector has angle ${th}° and area ${coeff}π cm². Find the radius`,
          circle: { type: "sector", theta: th, angText: `${th}°`, rText: `r = ?`, areaText: `${coeff}π cm²` },
          answer: `${rad}`, hint: "Enter a number.",
          steps: [`Sector area = (θ/360) × πr²`, `${coeff}π = (${th}/360) × πr²`, `r² = ${coeff} × 360 ÷ ${th} = ${rad * rad}`, `r = ${rad} cm`] };
      }

      // ---------- circle theorems: find the angle ----------
      const thm = pick(["centre", "centre", "semicircle", "semicircle", "sameseg", "cyclic", "cyclic", "tangents", "tangents", "altseg"]);

      if (thm === "centre") {
        const c = randInt(20, 62);
        if (Math.random() < 0.5) return {
          prompt: `O is the centre of the circle. Find the angle marked ? at the centre`,
          circle: { type: "centre", x: c, centreText: `?`, circText: `${c}°` },
          answer: `${2 * c}`, hint: "Angle in degrees.",
          steps: [`The angle at the centre is twice the angle at the circumference.`, `? = 2 × ${c}° = ${2 * c}°`] };
        return {
          prompt: `O is the centre of the circle. Find the angle marked ? at the circumference`,
          circle: { type: "centre", x: c, centreText: `${2 * c}°`, circText: `?` },
          answer: `${c}`, hint: "Angle in degrees.",
          steps: [`The angle at the centre is twice the angle at the circumference.`, `? = ${2 * c}° ÷ 2 = ${c}°`] };
      }

      if (thm === "semicircle") {
        const aA = randInt(22, 66), askB = Math.random() < 0.5;
        return {
          prompt: `AB is a diameter of the circle. Find the angle marked ?`,
          circle: { type: "semicircle", angA: aA, textA: askB ? `${aA}°` : `?`, textB: askB ? `?` : `${90 - aA}°` },
          answer: `${askB ? 90 - aA : aA}`, hint: "Angle in degrees.",
          steps: [`The angle in a semicircle is 90°.`, `Angles in a triangle add up to 180°.`, `? = 180° − 90° − ${askB ? aA : 90 - aA}° = ${askB ? 90 - aA : aA}°`] };
      }

      if (thm === "sameseg") {
        const x = randInt(24, 58);
        return {
          prompt: `A and D are points on the major arc. Find the angle marked ?`,
          circle: { type: "sameseg", x, textA: `${x}°`, textD: `?` },
          answer: `${x}`, hint: "Angle in degrees.",
          steps: [`Angles in the same segment are equal.`, `Both angles stand on the same chord BC, so ? = ${x}°`] };
      }

      if (thm === "cyclic") {
        let g;
        do {
          const opts = [58, 64, 70, 76, 82, 88, 94, 100, 106];
          const g1 = pick(opts), g2 = pick(opts), g3 = pick(opts);
          g = [g1, g2, g3, 360 - g1 - g2 - g3];
        } while (g[3] < 52 || g[3] > 118);
        const angA = (g[1] + g[2]) / 2, angB = (g[2] + g[3]) / 2;
        if (Math.random() < 0.5) return {
          prompt: `ABCD is a cyclic quadrilateral. Find the angle marked ?`,
          circle: { type: "cyclic", gaps: g, marks: [{ i: 0, t: `${angA}°` }, { i: 2, t: `?` }] },
          answer: `${180 - angA}`, hint: "Angle in degrees.",
          steps: [`Opposite angles in a cyclic quadrilateral add up to 180°.`, `? = 180° − ${angA}° = ${180 - angA}°`] };
        return {
          prompt: `ABCD is a cyclic quadrilateral. Find the angle marked ?`,
          circle: { type: "cyclic", gaps: g, marks: [{ i: 1, t: `${angB}°` }, { i: 3, t: `?` }] },
          answer: `${180 - angB}`, hint: "Angle in degrees.",
          steps: [`Opposite angles in a cyclic quadrilateral add up to 180°.`, `? = 180° − ${angB}° = ${180 - angB}°`] };
      }

      if (thm === "tangents") {
        const p = pick([36, 40, 44, 48, 52, 56, 60, 64, 68, 72]);
        const v = pick(["O", "P", "base"]);
        if (v === "O") return {
          prompt: `PA and PB are tangents to the circle, centre O. Find the angle AOB marked ?`,
          circle: { type: "tangents", p, textP: `${p}°`, textO: `?` },
          answer: `${180 - p}`, hint: "Angle in degrees.",
          steps: [`A tangent meets a radius at 90°, so angle OAP = angle OBP = 90°.`, `Angles in quadrilateral OAPB add up to 360°.`, `? = 360° − 90° − 90° − ${p}° = ${180 - p}°`] };
        if (v === "P") return {
          prompt: `PA and PB are tangents to the circle, centre O. Find the angle APB marked ?`,
          circle: { type: "tangents", p, textP: `?`, textO: `${180 - p}°` },
          answer: `${p}`, hint: "Angle in degrees.",
          steps: [`A tangent meets a radius at 90°, so angle OAP = angle OBP = 90°.`, `Angles in quadrilateral OAPB add up to 360°.`, `? = 360° − 90° − 90° − ${180 - p}° = ${p}°`] };
        return {
          prompt: `PA and PB are tangents from the point P. Find the angle PAB marked ?`,
          circle: { type: "tangents", p, textP: `${p}°`, baseText: `?` },
          answer: `${(180 - p) / 2}`, hint: "Angle in degrees.",
          steps: [`Tangents from a point are equal in length, so triangle PAB is isosceles.`, `Base angles = (180° − ${p}°) ÷ 2 = ${(180 - p) / 2}°`] };
      }

      // altseg — alternate segment theorem
      const x = randInt(30, 60);
      if (Math.random() < 0.5) return {
        prompt: `The line through A is a tangent to the circle. Find the angle marked ? in the alternate segment`,
        circle: { type: "altseg", x, textA: `${x}°`, textC: `?` },
        answer: `${x}`, hint: "Angle in degrees.",
        steps: [`Alternate segment theorem: the angle between a tangent and a chord equals the angle in the alternate segment.`, `? = ${x}°`] };
      return {
        prompt: `The line through A is a tangent to the circle. Find the angle between the tangent and the chord, marked ?`,
        circle: { type: "altseg", x, textA: `?`, textC: `${x}°` },
        answer: `${x}`, hint: "Angle in degrees.",
        steps: [`Alternate segment theorem: the angle between a tangent and a chord equals the angle in the alternate segment.`, `? = ${x}°`] };
    } },
  { id: "probability", name: "Probability", icon: "🎲", prereqs: [],
    generate() {
      const pick = (arr) => arr[randInt(0, arr.length - 1)];
      const shuffle = (arr) => { const c = [...arr]; for (let i = c.length - 1; i > 0; i--) { const j = randInt(0, i); [c[i], c[j]] = [c[j], c[i]]; } return c; };
      const simp = (n, d) => { const g = gcd(n, d) || 1; return [n / g, d / g]; };
      const COLORS = ["red", "blue", "green", "yellow", "white", "black"];
      const joinAnd = (arr) => arr.length <= 1 ? (arr[0] || "") : `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
      const r = Math.random();

      // 1. Single pick from a two-colour bag — P(one colour)
      if (r < 0.11) {
        const a = randInt(2, 9), b = randInt(2, 9);
        return { prompt: `A bag has ${a} red balls and ${b} blue balls. Find the probability of picking a red ball`, answer: `${a}/(${a + b})`, hint: "Fraction or decimal.",
          steps: [`P(red) = number of red ÷ total balls`, `= ${a} ÷ (${a} + ${b}) = ${a}/${a + b}`] };
      }

      // 2. Single pick from a 2-3 colour bag — P(a colour) or P(not a colour)
      if (r < 0.22) {
        const names = shuffle(COLORS).slice(0, pick([2, 3]));
        const counts = names.map(() => randInt(2, 9));
        const total = counts.reduce((s, n) => s + n, 0);
        const idx = randInt(0, names.length - 1);
        const c = names[idx], n = counts[idx];
        const bagDesc = joinAnd(names.map((nm, i) => `${counts[i]} ${nm}`));
        if (Math.random() < 0.5) {
          const [sn, sd] = simp(n, total);
          return { prompt: `A bag contains ${bagDesc} counters. A counter is taken at random. Find the probability that it is ${c}.`,
            answer: `${n}/${total}`, hint: "favourable ÷ total, then simplify.",
            steps: [`P(${c}) = ${n} ÷ ${total} = ${sn}/${sd}`] };
        }
        const [sn, sd] = simp(total - n, total);
        return { prompt: `A bag contains ${bagDesc} counters. A counter is taken at random. Find the probability that it is NOT ${c}.`,
          answer: `${total - n}/${total}`, hint: "P(not X) = 1 − P(X).",
          steps: [`P(${c}) = ${n}/${total}`, `P(not ${c}) = 1 − ${n}/${total} = ${sn}/${sd}`] };
      }

      // 3. Two fair spinners — sum-based possibility diagram
      if (r < 0.35) {
        const sides = pick([4, 5, 6, 8]);
        const total = sides * sides;
        const kind = pick(["equals", "odd", "atleast", "atmost"]);
        let fav = 0, desc, k;
        if (kind === "equals") {
          k = randInt(3, sides * 2 - 1);
          for (let i = 1; i <= sides; i++) for (let j = 1; j <= sides; j++) if (i + j === k) fav++;
          desc = `the sum of the two numbers is ${k}`;
        } else if (kind === "odd") {
          for (let i = 1; i <= sides; i++) for (let j = 1; j <= sides; j++) if ((i + j) % 2 === 1) fav++;
          desc = "the sum of the two numbers is odd";
        } else if (kind === "atleast") {
          k = randInt(sides, sides * 2 - 1);
          for (let i = 1; i <= sides; i++) for (let j = 1; j <= sides; j++) if (i + j >= k) fav++;
          desc = `the sum of the two numbers is at least ${k}`;
        } else {
          k = randInt(3, sides + 1);
          for (let i = 1; i <= sides; i++) for (let j = 1; j <= sides; j++) if (i + j <= k) fav++;
          desc = `the sum of the two numbers is at most ${k}`;
        }
        const [sn, sd] = simp(fav, total);
        return { prompt: `Two fair ${sides}-sided spinners, each numbered 1 to ${sides}, are spun together. Find the probability that ${desc}.`,
          answer: `${fav}/${total}`, hint: "A possibility diagram (grid of all outcomes) helps — count how many fit.",
          steps: [`There are ${sides} × ${sides} = ${total} equally likely outcomes.`, `${fav} of them fit.`, `P = ${fav}/${total} = ${sn}/${sd}`] };
      }

      // 4. Without replacement, 2 picks from a two-colour bag
      if (r < 0.47) {
        const rr = randInt(3, 9), b = randInt(3, 9), tt = rr + b;
        const kind = pick(["bothA", "bothB", "different", "atLeastOneA"]);
        let num, desc, workLines;
        const den = tt * (tt - 1);
        if (kind === "bothA") { num = rr * (rr - 1); desc = "both counters are red";
          workLines = [`P(both red) = (${rr}/${tt}) × (${rr - 1}/${tt - 1})`]; }
        else if (kind === "bothB") { num = b * (b - 1); desc = "both counters are blue";
          workLines = [`P(both blue) = (${b}/${tt}) × (${b - 1}/${tt - 1})`]; }
        else if (kind === "different") { num = 2 * rr * b; desc = "the two counters are different colours";
          workLines = [`P(different) = 2 × (${rr}/${tt}) × (${b}/${tt - 1})`]; }
        else { num = den - b * (b - 1); desc = "at least one counter is red";
          workLines = [`P(no red) = (${b}/${tt}) × (${b - 1}/${tt - 1})`, `P(at least one red) = 1 − P(no red)`]; }
        const [sn, sd] = simp(num, den);
        return { prompt: `A bag contains ${rr} red counters and ${b} blue counters. Two counters are taken at random, without replacement. Find the probability that ${desc}.`,
          answer: `${num}/${den}`, hint: "Draw a tree diagram — multiply along the branches, add if there's more than one way.",
          steps: [...workLines, `= ${num}/${den} = ${sn}/${sd}`] };
      }

      // 5. Without replacement, 3 picks, all the same colour
      if (r < 0.56) {
        const rr = randInt(3, 8), b = randInt(2, 7), tt = rr + b;
        const useRed = b < 3 || Math.random() < 0.5;
        const cnt = useRed ? rr : b, name = useRed ? "red" : "blue";
        const num = cnt * (cnt - 1) * (cnt - 2), den = tt * (tt - 1) * (tt - 2);
        const [sn, sd] = simp(num, den);
        return { prompt: `A bag contains ${rr} red counters and ${b} blue counters. Three counters are taken at random, without replacement. Find the probability that all three are ${name}.`,
          answer: `${num}/${den}`, hint: "Multiply three fractions, one fewer each time.",
          steps: [`P(all ${name}) = (${cnt}/${tt}) × (${cnt - 1}/${tt - 1}) × (${cnt - 2}/${tt - 2})`, `= ${num}/${den} = ${sn}/${sd}`] };
      }

      // 6. With replacement — independent repeats on numbered balls
      if (r < 0.66) {
        const n = randInt(6, 14);
        const oddCount = Math.ceil(n / 2), evenCount = n - oddCount;
        const both = Math.random() < 0.5;
        const num = both ? oddCount * oddCount : 2 * oddCount * evenCount;
        const den = n * n;
        const [sn, sd] = simp(num, den);
        const desc = both ? "both numbers are odd" : "one number is odd and the other is even";
        return { prompt: `A bag contains ${n} balls numbered 1 to ${n}. A ball is taken at random, its number noted, and replaced. A second ball is then taken at random. Find the probability that ${desc}.`,
          answer: `${num}/${den}`, hint: `${oddCount} of the ${n} numbers are odd.`,
          steps: both
            ? [`P(odd) = ${oddCount}/${n}`, `P(both odd) = (${oddCount}/${n})² = ${num}/${den} = ${sn}/${sd}`]
            : [`P(odd) = ${oddCount}/${n}, P(even) = ${evenCount}/${n}`, `P(one odd, one even) = 2 × (${oddCount}/${n}) × (${evenCount}/${n})`, `= ${num}/${den} = ${sn}/${sd}`] };
      }

      // 7. Two independent events with different probabilities
      if (r < 0.78) {
        const pA = pick([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        const pB = pick([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        const subjA = pick(["Maths", "English", "Science", "Art"]);
        const subjB = pick(["Physics", "History", "Music", "Geography"]);
        const kind = pick(["both", "AnotB", "neither"]);
        const rnd = (x) => Math.round(x * 1000) / 1000;
        let ans, desc;
        if (kind === "both") { ans = rnd(pA * pB); desc = `passes both ${subjA} and ${subjB}`; }
        else if (kind === "AnotB") { ans = rnd(pA * (1 - pB)); desc = `passes ${subjA} but does not pass ${subjB}`; }
        else { ans = rnd((1 - pA) * (1 - pB)); desc = "does not pass either subject"; }
        return { prompt: `Sam takes exams in ${subjA} and ${subjB}. The probability that Sam passes ${subjA} is ${pA} and the probability that Sam passes ${subjB} is ${pB}. The results are independent. Find the probability that Sam ${desc}.`,
          answer: `${ans}`, hint: "Multiply the two probabilities (use 1 − p for 'does not pass').",
          steps: [`P(pass ${subjA}) = ${pA}`, `P(pass ${subjB}) = ${pB}`, `P(${desc}) = ${ans}`] };
      }

      // 8. Two-digit number formed from number cards, without replacement
      if (r < 0.9) {
        const pool = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, pick([4, 5]));
        const nums = [];
        for (const x of pool) for (const y of pool) if (x !== y) nums.push(x * 10 + y);
        const isPrime = (x) => { if (x < 2) return false; for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; };
        const kind = pick(["lessThan", "even", "multiple", "prime"]);
        let fav, desc;
        if (kind === "lessThan") { const k = pick([30, 40, 50]); fav = nums.filter((v) => v < k).length; desc = `less than ${k}`; }
        else if (kind === "even") { fav = nums.filter((v) => v % 2 === 0).length; desc = "an even number"; }
        else if (kind === "multiple") { const mm = pick([3, 4, 5]); fav = nums.filter((v) => v % mm === 0).length; desc = `a multiple of ${mm}`; }
        else { fav = nums.filter(isPrime).length; desc = "a prime number"; }
        const [sn, sd] = simp(fav, nums.length);
        return { prompt: `The cards ${pool.join(", ")} are shuffled. Two of them are chosen at random and placed next to each other to make a two-digit number. Find the probability that the two-digit number is ${desc}.`,
          answer: `${fav}/${nums.length}`, hint: "List all the possible two-digit numbers, then count.",
          steps: [`There are ${nums.length} possible two-digit numbers.`, `${fav} of them are ${desc}.`, `P = ${fav}/${nums.length} = ${sn}/${sd}`] };
      }

      // 9. Reverse: given a probability and a count, find the total
      const mRaw = pick([4, 5, 8, 10, 20]);
      const [k, m] = simp(randInt(1, mRaw - 1), mRaw);
      const t = randInt(2, 6);
      const count = k * t, tot = m * t;
      const colourKnown = pick(["green", "red", "blue", "yellow"]);
      return { prompt: `A bag contains ${colourKnown} pegs and other coloured pegs only. The probability that a peg taken at random from the bag is ${colourKnown} is ${k}/${m}. There are ${count} ${colourKnown} pegs in the bag. Find the total number of pegs in the bag.`,
        answer: `${tot}`, hint: "total = count ÷ probability.",
        steps: [`${colourKnown}/total = ${k}/${m}`, `${count}/total = ${k}/${m}`, `total = ${count} × ${m}/${k} = ${tot}`] };
    } },
  { id: "statistics", name: "Statistics", icon: "📊", prereqs: ["probability"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];
      const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = randInt(0, i); [r[i], r[j]] = [r[j], r[i]]; } return r; };
      const num = (val, tol) => (inp) => { try { const x = evalString(String(inp), 0); return Number.isFinite(x) && Math.abs(x - val) <= tol; } catch (e) { return false; } };
      const r = Math.random();

      // ---------- list of numbers: mean / median / mode / range ----------
      if (r < 0.60) {
        const kind = pick(["mean", "mean", "median", "median", "mode", "range", "range"]);

        if (kind === "mean") {
          const mean = randInt(6, 14), n = pick([4, 5, 6]);
          let nums;
          for (let i = 0; i < 60; i++) {
            nums = Array.from({ length: n - 1 }, () => randInt(1, 22));
            const last = mean * n - nums.reduce((s, v) => s + v, 0);
            if (last >= 1 && last <= 22) { nums.push(last); break; }
            nums = null;
          }
          if (!nums) nums = Array(n).fill(mean);
          nums = shuffle(nums);
          return {
            prompt: `Find the mean of:   ${nums.join(", ")}`,
            answer: `${mean}`, hint: "Enter a number.",
            steps: [`Mean = sum of the values ÷ how many there are`, `= (${nums.join(" + ")}) ÷ ${n} = ${mean * n} ÷ ${n} = ${mean}`],
          };
        }

        if (kind === "mode") {
          const modeVal = randInt(1, 12), times = randInt(2, 3), n = pick([6, 7, 8]);
          const nums = Array(times).fill(modeVal);
          const counts = {};
          while (nums.length < n) {
            const v = randInt(1, 15);
            if (v === modeVal) continue;
            counts[v] = (counts[v] || 0) + 1;
            if (counts[v] < times) nums.push(v);
          }
          return {
            prompt: `Find the mode of:   ${shuffle(nums).join(", ")}`,
            answer: `${modeVal}`, hint: "Enter a number.",
            steps: [`The mode is the value that occurs most often.`, `${modeVal} occurs ${times} times — more than any other value.`],
          };
        }

        const n = kind === "median" ? pick([5, 7, 9]) : pick([5, 6, 7, 8]);
        const nums = Array.from({ length: n }, () => randInt(2, 28));
        const sorted = [...nums].sort((a, b) => a - b);
        if (kind === "range") {
          return {
            prompt: `Find the range of:   ${nums.join(", ")}`,
            answer: `${sorted[n - 1] - sorted[0]}`, hint: "Enter a number.",
            steps: [`Range = largest value − smallest value`, `= ${sorted[n - 1]} − ${sorted[0]} = ${sorted[n - 1] - sorted[0]}`],
          };
        }
        const med = sorted[(n - 1) / 2];
        return {
          prompt: `Find the median of:   ${nums.join(", ")}`,
          answer: `${med}`, hint: "Enter a number.",
          steps: [`Put the values in order:  ${sorted.join(", ")}`, `The middle value is ${med}.`],
        };
      }

      // ---------- cumulative frequency graph ----------
      const n = pick([40, 50, 60, 80]);
      const bounds = pick([[0, 10, 20, 30, 40, 50, 60], [0, 10, 20, 30, 40, 50], [10, 20, 30, 40, 50, 60, 70], [0, 20, 40, 60, 80, 100]]);
      const k = bounds.length;
      const mids = [];
      while (mids.length < k - 2) { const v = randInt(3, n - 3); if (!mids.includes(v)) mids.push(v); }
      mids.sort((a, b) => a - b);
      const cf = [0, ...mids, n];
      const pts = bounds.map((b, i) => [b, cf[i]]);
      // read the estimates off the SAME smooth curve the student sees
      const dense = densifyOgive(pts);
      const f = (x) => { for (let i = 0; i < dense.length - 1; i++) { const [x0, y0] = dense[i], [x1, y1] = dense[i + 1]; if (x >= x0 && x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1); } return x < bounds[0] ? 0 : n; };
      const invF = (y) => { for (let i = 0; i < dense.length - 1; i++) { const [x0, y0] = dense[i], [x1, y1] = dense[i + 1]; if (y >= y0 && y <= y1 && y1 > y0) return x0 + (x1 - x0) * (y - y0) / (y1 - y0); } return bounds[0]; };
      const xStep = bounds[1] - bounds[0];
      const cfg = { points: pts, xLabel: pick(["mark", "score", "time (s)", "mass (kg)"]), n };
      const r2 = Math.random();

      if (r2 < 0.34) {
        const medX = invF(n / 2);
        return {
          prompt: `The cumulative frequency graph shows the results of ${n} people. Use it to estimate the median.`,
          cumfreq: cfg, answer: `${Math.round(medX)}`, hint: "read it off the graph (within a small margin is fine)",
          check: num(medX, Math.max(3, xStep / 3)),
          steps: [`Half of ${n} is ${n / 2}.`, `Read across from ${n / 2} on the cumulative frequency axis to the curve, then down to the ${cfg.xLabel} axis.`, `Median ≈ ${Math.round(medX)}.`],
        };
      }
      if (r2 < 0.6) {
        const q1 = invF(n / 4), q3 = invF(3 * n / 4), iqr = q3 - q1;
        return {
          prompt: `The cumulative frequency graph shows the results of ${n} people. Estimate the interquartile range.`,
          cumfreq: cfg, answer: `${Math.round(iqr)}`, hint: "IQR = upper quartile − lower quartile",
          check: num(iqr, Math.max(4, xStep / 2)),
          steps: [
            `Lower quartile: read across from ${n / 4}  →  Q₁ ≈ ${Math.round(q1)}.`,
            `Upper quartile: read across from ${3 * n / 4}  →  Q₃ ≈ ${Math.round(q3)}.`,
            `IQR = Q₃ − Q₁ ≈ ${Math.round(q3)} − ${Math.round(q1)} = ${Math.round(iqr)}.`,
          ],
        };
      }
      // less than / more than a boundary value
      const xv = pick(bounds.slice(1, -1));
      const below = Math.round(f(xv));
      const less = Math.random() < 0.55;
      return {
        prompt: `The cumulative frequency graph shows the results of ${n} people. How many scored ${less ? "less" : "more"} than ${xv}?`,
        cumfreq: cfg, answer: `${less ? below : n - below}`, hint: "read the curve at that value",
        check: num(less ? below : n - below, 1.5),
        steps: [
          `Go up from ${xv} on the ${cfg.xLabel} axis to the curve, then across:  ${below} people scored less than ${xv}.`,
          less ? `Answer: ${below}.` : `More than ${xv}:  ${n} − ${below} = ${n - below}.`,
        ],
      };
    } },
  { id: "sets", name: "Sets", icon: "∩", prereqs: ["probability"],
    generate() {
      const pick = (arr) => arr[randInt(0, arr.length - 1)];

      // shade-the-region on a Venn diagram
      if (Math.random() < 0.6) {
        const three = Math.random() < 0.25;
        const nm2 = { a: "A ∩ B'", b: "A' ∩ B", ab: "A ∩ B", out: "(A ∪ B)'" };
        const nm3 = { a: "A ∩ B' ∩ C'", b: "A' ∩ B ∩ C'", c: "A' ∩ B' ∩ C", ab: "A ∩ B ∩ C'", ac: "A ∩ B' ∩ C", bc: "A' ∩ B ∩ C", abc: "A ∩ B ∩ C", out: "(A ∪ B ∪ C)'" };
        const list2 = [
          { e: "A", t: ["a", "ab"] },
          { e: "B", t: ["b", "ab"] },
          { e: "A ∪ B", t: ["a", "b", "ab"] },
          { e: "A ∩ B", t: ["ab"] },
          { e: "A'", t: ["b", "out"] },
          { e: "B'", t: ["a", "out"] },
          { e: "A ∩ B'", t: ["a"] },
          { e: "A' ∩ B", t: ["b"] },
          { e: "(A ∪ B)'", t: ["out"] },
          { e: "(A ∩ B)'", t: ["a", "b", "out"] },
        ];
        const list3 = [
          { e: "A ∩ B ∩ C", t: ["abc"] },
          { e: "A ∪ B ∪ C", t: ["a", "b", "c", "ab", "ac", "bc", "abc"] },
          { e: "A ∩ B", t: ["ab", "abc"] },
          { e: "A ∩ B ∩ C'", t: ["ab"] },
          { e: "A ∩ (B ∪ C)", t: ["ab", "ac", "abc"] },
          { e: "(A ∪ B ∪ C)'", t: ["out"] },
        ];
        const q = three ? pick(list3) : pick(list2);
        const nm = three ? nm3 : nm2;
        return {
          prompt: `Shade the region:   ${q.e}`,
          venn: { sets: three ? 3 : 2, target: q.t },
          answer: q.e, hint: "tap every part of the region — tap again to unshade",
          steps: [`${q.e} is made up of: ${q.t.map((k) => nm[k]).join(", ")}.`, `Tap each of those regions.`],
        };
      }

      // drag every element of a small universal set into the region it belongs in
      // (two sets only — three circles gets too cramped to drag into reliably)
      if (Math.random() < 0.55) {
        const RULES = [
          { name: "even numbers", test: (x) => x % 2 === 0 },
          { name: "odd numbers", test: (x) => x % 2 === 1 },
          { name: "multiples of 3", test: (x) => x % 3 === 0 },
          { name: "multiples of 4", test: (x) => x % 4 === 0 },
          { name: "multiples of 5", test: (x) => x % 5 === 0 },
          { name: "factors of 12", test: (x) => 12 % x === 0 },
          { name: "prime numbers", test: (x) => x > 1 && Array.from({ length: Math.max(0, x - 2) }, (_, i) => i + 2).every((d) => x % d !== 0) },
          { name: "square numbers", test: (x) => Number.isInteger(Math.sqrt(x)) },
          { name: "numbers greater than 6", test: (x) => x > 6 },
          { name: "numbers less than 5", test: (x) => x < 5 },
        ];
        const shuffle = (arr) => { const c = [...arr]; for (let i = c.length - 1; i > 0; i--) { const j = randInt(0, i); [c[i], c[j]] = [c[j], c[i]]; } return c; };
        const n = randInt(8, 12);
        const universe = Array.from({ length: n }, (_, i) => i + 1);

        let rules = null;
        for (let tries = 0; tries < 40 && !rules; tries++) {
          const cand = shuffle(RULES).slice(0, 2);
          // both rules must actually split the universe (not match everything or nothing)
          if (cand.every((rule) => { const c = universe.filter(rule.test).length; return c > 0 && c < universe.length; })) rules = cand;
        }
        if (!rules) rules = RULES.slice(0, 2);

        const keyFor = (el) => {
          const [inA, inB] = rules.map((rule) => rule.test(el));
          return inA && inB ? "ab" : inA ? "a" : inB ? "b" : "out";
        };
        const correct = {};
        universe.forEach((el) => { correct[el] = keyFor(el); });

        const REGION_NAME = { a: "A only", b: "B only", ab: "A and B", out: "neither" };
        const order = ["a", "b", "ab", "out"];
        const groups = {};
        universe.forEach((el) => { (groups[correct[el]] = groups[correct[el]] || []).push(el); });
        const filled = order.filter((k) => groups[k] && groups[k].length);

        return {
          prompt: `ζ = {1 ≤ x ≤ ${n}}\n${rules.map((r, i) => `${"AB"[i]} = ${r.name}`).join("\n")}\nDrag each number into the correct region of the Venn diagram.`,
          placeVenn: { sets: 2, universe, correct },
          answer: filled.map((k) => `${REGION_NAME[k]}: ${groups[k].join(", ")}`).join(" · "),
          hint: "Check every rule for one number at a time.",
          steps: [
            ...rules.map((r, i) => `${"AB"[i]} = ${r.name}`),
            ...filled.map((k) => `${groups[k].join(", ")} → ${REGION_NAME[k]}`),
          ],
        };
      }

      const a = randInt(8, 20), b = randInt(8, 20), both = randInt(1, Math.min(a, b) - 1);
      const aOnly = a - both, bOnly = b - both, union = a + b - both;
      const ask = pick([
        { q: "A ∪ B", ans: union, s: [`n(A ∪ B) = n(A) + n(B) − n(A ∩ B)`, `= ${a} + ${b} − ${both} = ${union}`] },
        { q: "A ∩ B", ans: both, s: [`${both} elements are stated to be in both sets`, `n(A ∩ B) = ${both}`] },
        { q: "A ∩ B'  (in A but not B)", ans: aOnly, s: [`n(A ∩ B') = n(A) − n(A ∩ B)`, `= ${a} − ${both} = ${aOnly}`] },
        { q: "A' ∩ B  (in B but not A)", ans: bOnly, s: [`n(A' ∩ B) = n(B) − n(A ∩ B)`, `= ${b} − ${both} = ${bOnly}`] },
      ]);
      return { prompt: `Set A has ${a} elements, Set B has ${b} elements, and ${both} elements are in both. Find the number of elements in ${ask.q}`,
        answer: `${ask.ans}`, hint: "Enter a number.", steps: ask.s };
    } },
  { id: "vectors", name: "Vectors", icon: "➡️", prereqs: ["algebra"],
    generate() {
      const pick = (a) => a[randInt(0, a.length - 1)];

      // ---- a checker + display for expressions linear in a and b ----
      const evalVec = (str, A, B) => {
        let s = String(str).trim().toLowerCase().replace(/[−–—]/g, "-")
          .replace(/[×·∙•]/g, "*").replace(/x/g, "*")   // accept ×, ·, or a typed "x" as multiply
          .replace(/\s+/g, "")
          .replace(/½/g, "(1/2)").replace(/⅓/g, "(1/3)").replace(/⅔/g, "(2/3)").replace(/¼/g, "(1/4)").replace(/¾/g, "(3/4)");
        if (!s) return NaN;
        s = s.replace(/\*+/g, "*").replace(/([0-9ab)])(?=[ab(])/g, "$1*").replace(/([ab)])(?=[0-9])/g, "$1*");
        s = s.replace(/a/g, `(${A})`).replace(/b/g, `(${B})`);
        if (!/^[-+*/().0-9]+$/.test(s)) return NaN;
        try { const r = Function(`"use strict";return (${s})`)(); return typeof r === "number" && Number.isFinite(r) ? r : NaN; }
        catch (e) { return NaN; }
      };
      const checkVec = (ca, cb) => (inp) => {
        for (const [A, B] of [[1, 0], [0, 1], [3, 2], [-1, 4], [2.5, -1.5]]) {
          const u = evalVec(inp, A, B);
          if (!Number.isFinite(u) || Math.abs(u - (ca * A + cb * B)) > 1e-6) return false;
        }
        return true;
      };
      const FR = [[1, 2, "½"], [1, 3, "⅓"], [2, 3, "⅔"], [1, 4, "¼"], [3, 4, "¾"]];
      const coef = (c) => {
        const m = Math.abs(c), sign = c < 0 ? "−" : "";
        if (Math.abs(m - 1) < 1e-9) return sign;
        for (const [n, d, ch] of FR) if (Math.abs(m - n / d) < 1e-9) return sign + ch;
        return sign + `${Math.round(m * 100) / 100}`;
      };
      const term = (ca, cb) => {
        const nz = (v) => Math.abs(v) > 1e-9;
        if (!nz(ca) && !nz(cb)) return "0";
        if (nz(ca) && nz(cb) && Math.abs(Math.abs(ca) - Math.abs(cb)) < 1e-9 && Math.abs(ca) - 1 < -1e-9) {
          const k = coef(Math.abs(ca)); // magnitude, no sign
          if (ca > 0 && cb > 0) return `${k}(a + b)`;
          if (ca < 0 && cb < 0) return `−${k}(a + b)`;
          if (ca > 0 && cb < 0) return `${k}(a − b)`;
          return `${k}(b − a)`;
        }
        const parts = [];
        if (nz(ca)) parts.push({ c: ca, v: "a" });
        if (nz(cb)) parts.push({ c: cb, v: "b" });
        parts.sort((p, q) => (q.c > 0 ? 1 : 0) - (p.c > 0 ? 1 : 0));
        return parts.map((p, i) => {
          const body = coef(Math.abs(p.c)) + p.v;
          if (i === 0) return (p.c < 0 ? "−" : "") + body;
          return (p.c < 0 ? " − " : " + ") + body;
        }).join("");
      };
      const mkVec = (ca, cb, extra) => ({
        check: checkVec(ca, cb), answer: term(ca, cb), answerDisplay: term(ca, cb),
        hint: "answer in terms of a and b", symbols: ["a", "b"],
        ...extra,
      });

      const roll = Math.random();

      // ===== 1. parallelogram — express a vector =====
      if (roll < 0.28) {
        const A = [0, 0], B = [4.2, 0], D = [1.3, 3], C = [5.5, 3];
        const opt = pick([
          { q: "DC", ca: 1, cb: 0, why: "DC = AB (opposite sides of a parallelogram are equal)" },
          { q: "BC", ca: 0, cb: 1, why: "BC = AD (opposite sides are equal)" },
          { q: "CB", ca: 0, cb: -1, why: "CB = −BC = −AD" },
          { q: "AC", ca: 1, cb: 1, why: "AC = AB + BC = a + b", diag: [A, C] },
          { q: "CA", ca: -1, cb: -1, why: "CA = −AC = −(a + b)", diag: [A, C] },
          { q: "BD", ca: -1, cb: 1, why: "BD = BA + AD = −a + b", diag: [B, D] },
          { q: "DB", ca: 1, cb: -1, why: "DB = DA + AB = −b + a", diag: [B, D] },
        ]);
        return mkVec(opt.ca, opt.cb, {
          prompt: `ABCD is a parallelogram.  ${vov("AB")} = a  and  ${vov("AD")} = b.\nWrite ${vov(opt.q)} in terms of a and b`,
          vec: {
            labels: [{ p: A, t: "A" }, { p: B, t: "B" }, { p: C, t: "C" }, { p: D, t: "D" }],
            edges: [[A, B], [B, C], [C, D], [D, A]],
            dashed: opt.diag ? [opt.diag] : [],
            arrows: [{ a: A, b: B, t: "a" }, { a: A, b: D, t: "b" }],
          },
          steps: [`${opt.why}.`, `${opt.q} = ${term(opt.ca, opt.cb)}`],
        });
      }

      // ===== 2. add two vectors round a figure  (X→Y + Y→Z = X→Z) =====
      if (roll < 0.48) {
        const O = [0, 0], A = [4, 0], Bp = [1.4, 3];
        const v = pick([
          { first: "OA", second: "OB", ask: "AB", ca: -1, cb: 1, work: "AB = AO + OB = −a + b" },
          { first: "AB", second: "BC", ask: "AC", ca: 1, cb: 1, work: "AC = AB + BC = a + b" },
          { first: "AB", second: "BC", ask: "CA", ca: -1, cb: -1, work: "CA = CB + BA = −b − a" },
        ]);
        const isO = v.first === "OA";
        const N = isO ? { X: "O", Y: "A", Z: "B" } : { X: "A", Y: "B", Z: "C" };
        return mkVec(v.ca, v.cb, {
          prompt: `In the diagram, ${vov(v.first)} = a  and  ${vov(v.second)} = b.\nWrite ${vov(v.ask)} in terms of a and b`,
          vec: {
            labels: [{ p: O, t: N.X }, { p: A, t: N.Y }, { p: Bp, t: N.Z }],
            edges: [],
            dashed: [[isO ? A : Bp, isO ? Bp : O]],
            arrows: isO
              ? [{ a: O, b: A, t: "a" }, { a: O, b: Bp, t: "b" }]
              : [{ a: O, b: A, t: "a" }, { a: A, b: Bp, t: "b" }],
          },
          steps: [`Travel along the arrows:  ${v.work}.`, `${v.ask} = ${term(v.ca, v.cb)}`],
        });
      }

      // ===== 3. reversing a vector  (OA = −AO) in context =====
      if (roll < 0.62) {
        const A = [0, 0], B = [4, 0.4], C = [1.2, 3];
        const v = pick([
          { g1: "AB", g2: "AC", ask: "CB", ca: 1, cb: -1, work: "CB = CA + AB = −b + a" },
          { g1: "AB", g2: "AC", ask: "BC", ca: -1, cb: 1, work: "BC = BA + AC = −a + b" },
          { g1: "OA", g2: "OB", ask: "BA", ca: 1, cb: -1, work: "BA = BO + OA = −b + a" },
        ]);
        const isO = v.g1 === "OA";
        const N = isO ? ["O", "A", "B"] : ["A", "B", "C"];
        return mkVec(v.ca, v.cb, {
          prompt: `${vov(v.g1)} = a  and  ${vov(v.g2)} = b.\nWrite ${vov(v.ask)} in terms of a and b   (remember ${vov("XY")} = −${vov("YX")})`,
          vec: {
            labels: [{ p: A, t: N[0] }, { p: B, t: N[1] }, { p: C, t: N[2] }],
            edges: [],
            dashed: [[B, C]],
            arrows: [{ a: A, b: B, t: "a" }, { a: A, b: C, t: "b" }],
          },
          steps: [`Reverse where needed, then add:  ${v.work}.`, `${v.ask} = ${term(v.ca, v.cb)}`],
        });
      }

      // ===== 4. midpoint =====
      if (roll < 0.82) {
        const O = [0, 0], A = [4, 0], Bp = [1.2, 3.2];
        const M = [(A[0] + Bp[0]) / 2, (A[1] + Bp[1]) / 2];
        const v = pick([
          { ask: "OM", ca: 0.5, cb: 0.5, work: "OM = OA + AM = a + ½(b − a) = ½a + ½b" },
          { ask: "AM", ca: -0.5, cb: 0.5, work: "AM = ½ AB = ½(b − a)" },
          { ask: "MB", ca: -0.5, cb: 0.5, work: "MB = ½ AB = ½(b − a)" },
        ]);
        return mkVec(v.ca, v.cb, {
          prompt: `M is the midpoint of ${vov("AB")}.  ${vov("OA")} = a  and  ${vov("OB")} = b.\nWrite ${vov(v.ask)} in terms of a and b`,
          vec: {
            labels: [{ p: O, t: "O" }, { p: A, t: "A" }, { p: Bp, t: "B" }],
            marks: [{ p: M, t: "M" }],
            edges: [[A, Bp]],
            dashed: [[O, M]],
            arrows: [{ a: O, b: A, t: "a" }, { a: O, b: Bp, t: "b" }],
          },
          steps: [`${v.work}.`, `${v.ask} = ${term(v.ca, v.cb)}`],
        });
      }

      // ===== 5. ratio point on a line =====
      {
        const O = [0, 0], A = [4, 0], Bp = [1.2, 3.2];
        const r = pick([[1, 1], [1, 2], [2, 1], [1, 3], [3, 1]]);
        const t = r[0] / (r[0] + r[1]);
        const M = [A[0] + t * (Bp[0] - A[0]), A[1] + t * (Bp[1] - A[1])];
        const askOM = Math.random() < 0.5;
        const ca = askOM ? (1 - t) : -t, cb = askOM ? t : t;
        const work = askOM
          ? `OM = OA + AM = a + ${coef(t)}(b − a) = ${term(1 - t, t)}`
          : `AM = ${coef(t)} AB = ${coef(t)}(b − a)`;
        return mkVec(ca, cb, {
          prompt: `M lies on ${vov("AB")} with ${vov("AM")} : ${vov("MB")} = ${r[0]} : ${r[1]}.  ${vov("OA")} = a  and  ${vov("OB")} = b.\nWrite ${vov(askOM ? "OM" : "AM")} in terms of a and b`,
          vec: {
            labels: [{ p: O, t: "O" }, { p: A, t: "A" }, { p: Bp, t: "B" }],
            marks: [{ p: M, t: "M" }],
            edges: [[A, Bp]],
            dashed: [[O, M]],
            arrows: [{ a: O, b: A, t: "a" }, { a: O, b: Bp, t: "b" }],
          },
          steps: [
            `AM : MB = ${r[0]} : ${r[1]}, so AM = ${coef(t)} of AB.`,
            `${work}.`,
            `${askOM ? "OM" : "AM"} = ${term(ca, cb)}`,
          ],
        });
      }
    } },
];
const TOPIC_BY_ID = Object.fromEntries(TOPICS.map((t) => [t.id, t]));

// Mixed Review — a level-3 reward: random questions drawn from every topic
// the student has unlocked. Answers still score their source topic.
const MIXED_TOPIC = { id: "__mixed__", name: "Mixed Review", icon: "🎲" };
const MIXED_UNLOCK_LEVEL = 3;

// Blitz — a level-7 speed round: BLITZ_SECONDS to answer as many
// tap-only questions as possible. Correct answers earn the usual +2 XP;
// there's no topic scoring, just a personal best.
const BLITZ_UNLOCK_LEVEL = 7;
const BLITZ_SECONDS = 30;
function blitzQuestion() {
  const pick = (a) => a[randInt(0, a.length - 1)];
  const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = randInt(0, i); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const onGrid = (b) => b.every((p) => Math.abs(p[0]) <= 7 && Math.abs(p[1]) <= 7);
  const distinct = (b) => new Set(b.map((p) => p.join(","))).size === 3;
  const randTri = () => {
    for (let i = 0; i < 200; i++) {
      const t = [0, 1, 2].map(() => [randInt(-4, 4), randInt(-4, 4)]);
      const ar = Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]));
      const bw = Math.max(...t.map((p) => p[0])) - Math.min(...t.map((p) => p[0]));
      const bh = Math.max(...t.map((p) => p[1])) - Math.min(...t.map((p) => p[1]));
      const sides = [
        (t[0][0] - t[1][0]) ** 2 + (t[0][1] - t[1][1]) ** 2,
        (t[1][0] - t[2][0]) ** 2 + (t[1][1] - t[2][1]) ** 2,
        (t[0][0] - t[2][0]) ** 2 + (t[0][1] - t[2][1]) ** 2,
      ];
      const longest = Math.max(...sides), shortest = Math.min(...sides);
      // area ≥ 12, box ≥ 3×3, no side under √3, shortest altitude (2·area/longest) ≥ ~1.6
      if (ar >= 12 && bw >= 3 && bh >= 3 && shortest >= 3 && ar * ar >= 2.6 * longest) return t;
    }
    return [[-2, -1], [3, 0], [0, 3]];
  };
  // true when triangles P and Q are apart by at least `gap` (SAT)
  const separated = (P, Q, gap) => {
    const axes = [];
    for (const poly of [P, Q]) for (let i = 0; i < 3; i++) {
      const u = poly[i], v = poly[(i + 1) % 3];
      const n = [-(v[1] - u[1]), v[0] - u[0]], L = Math.hypot(n[0], n[1]) || 1;
      axes.push([n[0] / L, n[1] / L]);
    }
    for (const ax of axes) {
      let mnP = Infinity, mxP = -Infinity, mnQ = Infinity, mxQ = -Infinity;
      for (const p of P) { const d = p[0] * ax[0] + p[1] * ax[1]; mnP = Math.min(mnP, d); mxP = Math.max(mxP, d); }
      for (const q of Q) { const d = q[0] * ax[0] + q[1] * ax[1]; mnQ = Math.min(mnQ, d); mxQ = Math.max(mxQ, d); }
      if (mxP <= mnQ - gap || mxQ <= mnP - gap) return true;
    }
    return false;
  };
  const cend = (t) => t.reduce((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]);
  const apart = (a, b) => {
    const ca = cend(a), cb = cend(b);
    return separated(a, b, 0.5) && Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) >= 2.5;
  };
  const opts4 = (ans, deltas) => {
    const s = new Set([ans]);
    let i = 0;
    while (s.size < 4 && i < 60) { const v = ans + pick(deltas); if (v > 0 && !s.has(v)) s.add(v); i++; }
    let g = 1;
    while (s.size < 4) { if (!s.has(ans + g)) s.add(ans + g); g++; }
    return shuffle([...s]).map(String);
  };

  const build = () => {
    const kind = pick(["trans", "trans", "trans", "rot", "rot", "sym", "sym", "venn", "venn", "num", "num", "num"]);

    if (kind === "trans") {
      const A = randTri();
      const ap = (f) => A.map(f);
      const ansKind = pick(["Translation", "Rotation", "Reflection", "Enlargement"]);
      let B;
      if (ansKind === "Translation") { const v = [pick([-5, -4, 4, 5]), pick([-4, -3, 3, 4])]; B = ap(([x, y]) => [x + v[0], y + v[1]]); }
      else if (ansKind === "Rotation") { const c = [randInt(-3, 3), randInt(-3, 3)], d = pick([90, -90, 180]); B = ap(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return d === 90 ? [c[0] + dy, c[1] - dx] : d === -90 ? [c[0] - dy, c[1] + dx] : [c[0] - dx, c[1] - dy]; }); }
      else if (ansKind === "Reflection") {
        const m = pick([{ k: "x", o: randInt(-2, 2) }, { k: "y", o: randInt(-2, 2) }, { k: "yx" }, { k: "ymx" }]);
        const side = (p) => m.k === "x" ? p[0] - m.o : m.k === "y" ? p[1] - m.o : m.k === "yx" ? p[1] - p[0] : p[0] + p[1];
        const g = m.o === undefined ? 2 : 1;
        const sd = A.map(side);
        if (!(sd.every((v) => v >= g) || sd.every((v) => v <= -g))) return null;
        B = ap(([x, y]) => m.k === "x" ? [2 * m.o - x, y] : m.k === "y" ? [x, 2 * m.o - y] : m.k === "yx" ? [y, x] : [-y, -x]);
      }
      else { const c = [randInt(-3, 3), randInt(-3, 3)]; B = ap(([x, y]) => [c[0] - 2 * (x - c[0]), c[1] - 2 * (y - c[1])]); }
      if (!onGrid(B) || !distinct(B) || !apart(A, B)) return null;
      return { prompt: "Which transformation maps A onto B?", transform: { a: A, b: B }, choices: ["Translation", "Rotation", "Enlargement", "Reflection"], answer: ansKind };
    }

    if (kind === "rot") {
      const A = randTri(), c = [randInt(-3, 3), randInt(-3, 3)];
      const spec = pick([{ d: 90, t: "90° clockwise" }, { d: -90, t: "90° anticlockwise" }, { d: 180, t: "180°" }]);
      const B = A.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return spec.d === 90 ? [c[0] + dy, c[1] - dx] : spec.d === -90 ? [c[0] - dy, c[1] + dx] : [c[0] - dx, c[1] - dy]; });
      if (!onGrid(B) || !distinct(B) || !apart(A, B)) return null;
      return { prompt: "Describe the rotation that maps A onto B", transform: { a: A, b: B, centre: c }, choices: ["90° clockwise", "90° anticlockwise", "180°"], answer: spec.t };
    }

    if (kind === "sym") {
      const keys = Object.keys(SHAPES), k = pick(keys), s = SHAPES[k];
      const askLines = Math.random() < 0.5;
      const correct = askLines ? s.lines : s.rot;
      const floor = askLines ? 0 : 1;   // rotational-symmetry order is always ≥ 1
      const set = new Set([correct]);
      while (set.size < 4) { const v = correct + pick([-2, -1, 1, 2, 3]); if (v >= floor) set.add(v); }
      return {
        prompt: askLines ? "How many lines of symmetry does this shape have?" : "What is the order of rotational symmetry?",
        figure: { shape: k }, choices: shuffle([...set]).map(String), answer: String(correct),
      };
    }

    if (kind === "venn") {
      const two = Math.random() < 0.7;
      const q = two
        ? pick([{ e: "A ∩ B", t: "ab" }, { e: "A ∩ B'", t: "a" }, { e: "A' ∩ B", t: "b" }, { e: "(A ∪ B)'", t: "out" }])
        : pick([{ e: "A ∩ B ∩ C", t: "abc" }, { e: "(A ∪ B ∪ C)'", t: "out" }]);
      return { prompt: `Tap the region:  ${q.e}`, venn: { sets: two ? 2 : 3, target: [q.t] }, answer: q.e };
    }

    // num
    const t = pick(["mult", "prime", "sqrt", "round"]);
    if (t === "mult") { const a = randInt(3, 12), b = randInt(3, 12); return { prompt: `${a} × ${b}`, choices: opts4(a * b, [-12, -10, -8, -6, 6, 8, 10, 12]), answer: `${a * b}` }; }
    if (t === "sqrt") { const n = randInt(3, 13); return { prompt: `√${n * n}`, choices: opts4(n, [-3, -2, -1, 1, 2, 3]), answer: `${n}` }; }
    if (t === "round") { const x = randInt(11, 289); const r = Math.round(x / 10) * 10; return { prompt: `Round ${x} to the nearest 10`, choices: opts4(r, [-20, -10, 10, 20]), answer: `${r}` }; }
    // prime
    const p = pick([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]);
    const comps = shuffle([4, 6, 8, 9, 10, 12, 14, 15, 16, 18, 21, 25, 27, 33, 35, 39].filter((v) => Math.abs(v - p) < 14 || Math.random() < 0.5)).slice(0, 3);
    while (comps.length < 3) comps.push(pick([9, 15, 21, 25]));
    return { prompt: "Which of these is a prime number?", choices: shuffle([p, ...comps]).map(String), answer: `${p}` };
  };

  for (let i = 0; i < 40; i++) { const q = build(); if (q) return q; }
  return { prompt: "7 × 8", choices: ["54", "56", "63", "48"], answer: "56" };
}

/* Achievements are grouped into four tiers. Each achievement's check(p)
   runs against the whole profile after every answer; ids are permanent
   (renaming/retiering an achievement keeps anyone who already earned it).
   Rank checks read the ratcheted highestRank, so they never un-earn. */
const TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const TIER_COLOR = { Bronze: "#B07437", Silver: "#8A929E", Gold: "#C99A1E", Platinum: "#3E9CB8", Diamond: "#7EC8E3" };

const ACHIEVEMENTS = [
  /* ---------------- Bronze ---------------- */
  { id: "sobegins", tier: "Bronze", name: "So It Begins", icon: "🌱", desc: "Get one question right",
    check: (p) => (p.totalCorrect || 0) >= 1 },
  { id: "onfire", tier: "Bronze", name: "On Fire", icon: "🔥", desc: "5 correct answers in a row",
    check: (p) => (p.bestStreak || 0) >= 5 },
  { id: "sigma", tier: "Bronze", name: "Sigma Grindset", icon: "🗿", desc: "20 correct answers in total",
    check: (p) => (p.totalCorrect || 0) >= 20 },
  { id: "speedy", tier: "Bronze", name: "Speed Demon", icon: "⚡", desc: "Answer correctly in under 8 seconds, 5 times",
    check: (p) => (p.fastCorrect || 0) >= 5 },
  { id: "speedrunner", tier: "Bronze", name: "Speedrunner", icon: "🏃", desc: "Answer correctly in under 1 minute, 10 times",
    check: (p) => (p.minuteCorrect || 0) >= 10 },
  { id: "lethimcook", tier: "Bronze", name: "Let Him Cook", icon: "👨‍🍳", desc: "Reach rank A in any topic",
    check: (p) => TOPICS.some((t) => topicRankAtLeast(p, t.id, "A")) },
  { id: "nightowl", tier: "Bronze", name: "Night Owl", icon: "🦉", desc: "Answer a question between 12am and 4am",
    check: (p) => !!p.nightOwl },
  { id: "comeback", tier: "Bronze", name: "Comeback Kid", icon: "🧒", desc: "Get a question right after 3 wrong in a row",
    check: (p) => !!p.comeback },
  { id: "rootproblem", tier: "Bronze", name: "Root of the Problem", icon: "🫚", desc: "Answer a Surds question correctly",
    check: (p) => !!p.solvedSurd },
  { id: "sixtyseven", tier: "Bronze", name: "67", icon: "☯️", desc: "Correctly answer a question whose answer is 67",
    check: (p) => !!p.got67 },
  { id: "completionist", tier: "Bronze", name: "Completionist", icon: "📚", desc: "Get at least one question right in every topic",
    check: (p) => TOPICS.every((t) => topicHasCorrect(p, t.id)) },
  { id: "jackofall", tier: "Bronze", name: "Jack of All Trades", icon: "🎭", desc: "10 correct in a row in Mixed Review",
    check: (p) => (p.bestMixedStreak || 0) >= 10 },
  { id: "thunderclap", tier: "Bronze", name: "Thunderclap", icon: "💥", desc: "Answer 15 correctly in one Blitz",
    check: (p) => (p.blitzBest || 0) >= 15 },
  { id: "hintcoin", tier: "Bronze", name: "Every Puzzle Has an Answer", icon: "🎩", desc: "Use a Hint coin for the first time",
    check: (p) => !!p.usedHint },
  { id: "circlecorrect", tier: "Bronze", name: "What Goes Around Comes Around", icon: "💫", desc: "Get a Circles question correct",
    check: (p) => !!p.gotCircle },
  { id: "nicetry", tier: "Bronze", name: "Nice Try", icon: "🤡",
    desc: "Back out of the same topic 3 times to dodge a question, then answer one anyway",
    secret: true, check: (p) => !!p.dodgeCaught },
  { id: "guidingkey", tier: "Bronze", name: "Your Guiding Key", icon: "🔑", desc: "Use a Skeleton Key",
    check: (p) => (p.keyedTopics || []).length > 0 },
  { id: "practicemakesperfect", tier: "Bronze", name: "Practice Makes Perfect", icon: "🎰", desc: "Play 7 days in a row",
    check: (p) => (p.playStreak || 0) >= 7 },
  { id: "isthisfriends", tier: "Bronze", name: "Is This Friends?", icon: "👬", desc: "Add a friend",
    check: (p) => !!p.gotFriend },

  /* ---------------- Silver ---------------- */
  { id: "marathon", tier: "Silver", name: "Marathon Mind", icon: "🏅", desc: "100 correct answers in total",
    check: (p) => (p.totalCorrect || 0) >= 100 },
  { id: "perfectionist", tier: "Silver", name: "Perfectionist", icon: "💯", desc: "Reach S rank in any topic",
    check: (p) => TOPICS.some((t) => topicRankAtLeast(p, t.id, "S")) },
  { id: "aristocrat", tier: "Silver", name: "Arithmetic Aristocrat", icon: "🥸", desc: "Reach rank A in the first 8 topics",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(0, 8), "A") },
  { id: "aficionado", tier: "Silver", name: "Algebra Aficionado", icon: "🧮", desc: "Reach rank A in topics 9–14",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(8, 14), "A") },
  { id: "grandmaster", tier: "Silver", name: "Graphical Grandmaster", icon: "📉", desc: "Reach rank A in topics 15–20",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(14, 20), "A") },
  { id: "shapeshifter", tier: "Silver", name: "Shapeshifter", icon: "🔷", desc: "Reach rank A in topics 21–26",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(20, 26), "A") },
  { id: "statslayer", tier: "Silver", name: "Statistics Slayer", icon: "🗡️", desc: "Reach rank A in topics 27–29",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(26, 29), "A") },
  { id: "ohyeah", tier: "Silver", name: "OH YEAH!!!", icon: "🧡", desc: "Reach rank A in topic 30 (Vectors)",
    check: (p) => allTopicsRankAtLeast(p, TOPICS.slice(29, 30), "A") },

  /* ---------------- Gold ---------------- */
  { id: "unstoppable", tier: "Gold", name: "Unstoppable", icon: "🚀", desc: "Reach S+ rank in any topic",
    check: (p) => TOPICS.some((t) => topicRankAtLeast(p, t.id, "S+")) },
  { id: "mathemagician", tier: "Gold", name: "Mathemagician", icon: "🧙", desc: "Reach S rank in every topic",
    check: (p) => allTopicsRankAtLeast(p, TOPICS, "S") },
  { id: "neversleep", tier: "Gold", name: "Numbers Never Sleep", icon: "🌙", desc: "500 correct answers in total",
    check: (p) => (p.totalCorrect || 0) >= 500 },
  { id: "groundhog", tier: "Gold", name: "Groundhog Day", icon: "🐗", desc: "Prestige once",
    check: (p) => (p.prestige || 0) >= 1 },

  /* ---------------- Platinum ---------------- */
  { id: "unlocked", tier: "Platinum", name: "Touch Grass", icon: "🏕", desc: "Reach S+ rank in every topic",
    secret: true, check: (p) => allTopicsRankAtLeast(p, TOPICS, "S+") },

  /* ---------------- Diamond ---------------- */
  // Self-reference is safe: `check` only runs after the module has fully
  // loaded, by which point ACHIEVEMENTS (and LEVEL_CAP/PRESTIGE_CAP below)
  // are fully initialised.
  { id: "mathsunlocked", tier: "Diamond", name: "Maths Unlocked", icon: "🏆",
    desc: "Max prestige, max level, and every other achievement",
    secret: true,
    check: (p) =>
      (p.prestige || 0) >= PRESTIGE_CAP &&
      levelFromExp(totalExp(p)) >= LEVEL_CAP &&
      ACHIEVEMENTS.filter((a) => a.id !== "mathsunlocked").every((a) => (p.achievements || []).includes(a.id)) },
];

/* Runs every achievement's check() against a profile draft (mutated
   in place — `next.achievements`/`next.achievedAt` grow with anything
   newly earned) and returns the freshly-unlocked achievement objects.
   Call this anywhere a profile mutation might cross an achievement's
   threshold, not just from the quiz flow. */
function awardAchievements(next) {
  const unlocked = [];
  next.achievements = next.achievements || [];
  next.achievedAt = next.achievedAt || {};
  ACHIEVEMENTS.forEach((a) => {
    if (!next.achievements.includes(a.id) && a.check(next)) {
      next.achievements.push(a.id);
      next.achievedAt[a.id] = Date.now();
      unlocked.push(a);
    }
  });
  return unlocked;
}

/* Ranks are based on the TOTAL of the last 10 answers (10 correct = 100),
   and a topic's rank only ever ratchets UP. A wrong answer never drops
   the stored rank — it only stops it climbing further until the rolling
   total recovers past the next threshold. S+ is the one exception: it's
   earned by a 20-answer correct streak within that topic, not the total. */
const RANK_ORDER = ["F", "E", "D", "C", "B", "A", "A*", "S", "S+"];
const RANK_THRESHOLD = { F: 10, E: 20, D: 30, C: 50, B: 60, A: 80, "A*": 90, S: 100 };
const RANK_COLOR = {
  F: "#7A2E22", E: "#B14A36", D: "#C97F1E", C: "var(--amber)",
  B: "var(--blue)", A: "var(--green)", "A*": "#1F7A5C", S: "#8A4FBF", "S+": "#B98900",
};
const STREAK_FOR_S_PLUS = 20;
function avgFromHistory(history) {
  // "Total of the last 10" is out of a FIXED pool of 10 slots — unanswered
  // slots simply aren't filled yet, they don't inflate the score. 3 correct
  // out of only 3 attempted is a total of 30 (D), not 100 (S).
  if (!history || history.length === 0) return 0;
  const last = history.slice(-10);
  return last.reduce((s, v) => s + v, 0) * 10;
}
function rankIndexForAvg(avg) {
  let idx = -1;
  Object.keys(RANK_THRESHOLD).forEach((label) => {
    if (avg >= RANK_THRESHOLD[label]) idx = Math.max(idx, RANK_ORDER.indexOf(label));
  });
  return idx;
}
function rankDisplay(highestRankIdx) {
  if (highestRankIdx === undefined || highestRankIdx < 0) return { label: "—", color: "var(--muted)" };
  const label = RANK_ORDER[highestRankIdx];
  return { label, color: RANK_COLOR[label] };
}

/* ---------------------------------------------------------
   Levelling (Mastery Challenge). XP comes from three sources:
   grade ratchet-ups (ungraded→F … S→S+), +2 for every correct
   answer, and claimed daily tasks / milestones (pooled in
   profile.bonusExp). Level 20 costs 8,500 XP: 15 topics at A
   + 15 at S is 7,350 from ranks, and the ~550–750 correct
   answers it takes to get there add roughly the rest, landing
   on the cap. Full S+ mastery (11,700 from ranks) sits past
   the cap as the "Mathematics Unlocked" achievement + prestige
   fuel. XP keeps accruing past Level 20 — invisibly on the bar,
   but it still feeds the weekly school leaderboard.
--------------------------------------------------------- */
const LEVEL_CAP = 20;
const CORRECT_XP = 2;                 // XP for every correct answer
// XP for entering each rank: F, E, D, C, B, A, A*, S, S+
const RANK_STEP_EXP = [10, 20, 25, 35, 40, 50, 60, 70, 80];
// RANK_CUM_EXP[k] = XP a topic is worth at rank index k
//   → [10, 30, 55, 90, 130, 180, 240, 310, 390]
const RANK_CUM_EXP = RANK_STEP_EXP.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], []);
// LEVEL_CUM_EXP[i] = total XP required to be level (i + 1). Per-level cost
// climbs 10, 60, 110, 160, 200, 250 … 880 — all multiples of 10, summing to 8,500.
const LEVEL_CUM_EXP = [
  0, 10, 70, 180, 340, 540, 790, 1090, 1440, 1840,
  2290, 2790, 3330, 3920, 4560, 5250, 5990, 6780, 7620, 8500,
];

function totalExp(profile) {
  const topics = (profile && profile.topics) || {};
  const fromRanks = TOPICS.reduce((sum, t) => {
    const k = (topics[t.id] || {}).highestRank ?? -1;
    return sum + (k >= 0 ? RANK_CUM_EXP[Math.min(k, RANK_CUM_EXP.length - 1)] : 0);
  }, 0);
  return fromRanks + ((profile && profile.bonusExp) || 0);
}
function levelFromExp(exp) {
  let level = 1;
  for (let i = 1; i < LEVEL_CUM_EXP.length; i++) {
    if (exp >= LEVEL_CUM_EXP[i]) level = i + 1; else break;
  }
  return Math.min(level, LEVEL_CAP);
}
function levelProgress(exp) {
  const level = levelFromExp(exp);
  if (level >= LEVEL_CAP) return { level, into: 0, need: 0, pct: 100, capped: true };
  const base = LEVEL_CUM_EXP[level - 1];
  const need = LEVEL_CUM_EXP[level] - base;
  const into = exp - base;
  return { level, into, need, pct: Math.max(0, Math.min(100, Math.round((into / need) * 100))), capped: false };
}
function LevelBar({ profile, onPrestige, onOpenUnlocks }) {
  const { level, into, need, pct, capped } = levelProgress(totalExp(profile));
  const prestige = profile.prestige || 0;
  const belowC = TOPICS.filter((t) => !topicRankAtLeast(profile, t.id, "C"));
  const prestigeSlot = capped && prestige < PRESTIGE_CAP && typeof onPrestige === "function";
  const LevelChip = (
    <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, color: "var(--blue)", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
      <PrestigeBadge prestige={prestige} size={18} />
      <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 0.5 }}>LV</span>{level}
    </div>
  );
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {onOpenUnlocks ? (
        <button onClick={onOpenUnlocks} title="See what unlocks at each level" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center" }}>
          {LevelChip}
        </button>
      ) : LevelChip}
      <div style={{ flex: 1, minWidth: 40 }}>
        <div style={{ height: 8, background: "var(--locked)", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: capped ? "var(--amber)" : "var(--blue)", transition: "width 0.4s ease" }} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0, fontWeight: 600 }}>
        {capped ? (prestige >= PRESTIGE_CAP ? "MAX PRESTIGE" : "MAX · Level 20") : `${into} / ${need} XP`}
      </div>
      {prestigeSlot && (belowC.length === 0 ? (
        <button onClick={onPrestige} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--amber)", border: "none", borderRadius: 8, padding: "5px 12px", cursor: "pointer", flexShrink: 0 }}>
          Prestige →
        </button>
      ) : (
        <span title={`Below C: ${belowC.map((t) => t.name).join(", ")}`} style={{ fontSize: 10.5, fontWeight: 700, color: "var(--amber)", flexShrink: 0 }}>
          🔒 Reach C in every topic to prestige · {belowC.length} to go
        </span>
      ))}
    </div>
  );
}

/* Titles shown under the student's name. Level titles unlock as you climb;
   prestige titles on top. The student picks which unlocked one to show
   (profile.title); it falls back to the highest one earned by level. */
const TITLES = [
  { level: 1, name: "Novice" }, { level: 3, name: "Learner" }, { level: 5, name: "Student" },
  { level: 7, name: "Apprentice" }, { level: 9, name: "Practitioner" }, { level: 11, name: "Analyst" },
  { level: 13, name: "Scholar" }, { level: 15, name: "Specialist" }, { level: 17, name: "Expert" },
  { level: 19, name: "Virtuoso" }, { level: 20, name: "Maths Master" },
];
const PRESTIGE_TITLES = [
  { prestige: 1, name: "Veteran" }, { prestige: 3, name: "Champion" },
  { prestige: 5, name: "Elite" }, { prestige: 8, name: "Prodigy" }, { prestige: 10, name: "Legend" },
];
function titleForLevel(level) {
  let name = TITLES[0].name;
  for (const t of TITLES) if (level >= t.level) name = t.name;
  return name;
}
function unlockedTitles(profile) {
  const lv = levelFromExp(totalExp(profile));
  const pr = profile.prestige || 0;
  return [
    ...TITLES.filter((t) => lv >= t.level).map((t) => t.name),
    ...PRESTIGE_TITLES.filter((t) => pr >= t.prestige).map((t) => t.name),
  ];
}
function titleFor(profile) {
  const chosen = profile && profile.title;
  if (chosen && unlockedTitles(profile).includes(chosen)) return chosen;
  return titleForLevel(levelFromExp(totalExp(profile)));
}

/* Prestige — up to 10 resets. Each one wipes topic progress and level
   but keeps achievements, lifetime stats and prestige rank. Leaderboard
   score is prestige×20 + level, so every prestige rank counts as a full
   extra 20 levels of standing. */
const PRESTIGE_CAP = 10;
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const PRESTIGE_COLORS = [
  null, "#B07437", "#8A929E", "#C99A1E", "#2E7D6B", "#3B6FA0",
  "#7A4FBF", "#B14A36", "#33383F", "#C9A227", "#3E9CB8",
];
function PrestigeBadge({ prestige, size = 20 }) {
  const p = prestige || 0;
  if (p < 1) return null;
  const c = PRESTIGE_COLORS[Math.min(p, PRESTIGE_CAP)] || "var(--blue)";
  return (
    <span title={`Prestige ${p}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: Math.round(size * 0.28), transform: "rotate(45deg)", background: c, flexShrink: 0, boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }}>
      <span className="mub-display" style={{ transform: "rotate(-45deg)", color: "#fff", fontSize: Math.round(size * 0.5), fontWeight: 700, lineHeight: 1 }}>{ROMAN[Math.min(p, PRESTIGE_CAP)]}</span>
    </span>
  );
}
function leaderboardScore(profile) {
  return (profile.prestige || 0) * 20 + levelFromExp(totalExp(profile));
}

/* Brunei secondary schools for the registration picker, grouped by
   district. English names; a bracketed abbreviation is included where one
   is commonly used, so the typeahead matches it. The exact string is
   stored on the profile and grouped in the leaderboard — keep entries
   stable once students exist. "Solo" opts out of the school leaderboard.
   Sixth-form colleges are out of scope for this list. */
const SOLO_SCHOOL = "Solo / Independent";
const SCHOOLS = [
  { group: "Brunei-Muara", items: [
    "Awang Semaun Secondary School (SMAS)",
    "Berakas Secondary School (SMB)",
    "Chung Hwa Middle School, Bandar Seri Begawan (CHMS BSB)",
    "Hassanal Bolkiah Boys' Arabic Secondary School",
    "Institut Tahfiz Al-Qur'an Sultan Haji Hassanal Bolkiah (ITQSHHB)",
    "International School Brunei (ISB)",
    "Jerudong International School (JIS)",
    "Katok Secondary School",
    "Lambak Kiri Secondary School",
    "Masin Secondary School",
    "Menglait Secondary School (SMMG)",
    "Paduka Seri Begawan Sultan Science College (MSPSBS)",
    "Pehin Datu Seri Maharaja Secondary School (SMPDSM)",
    "Pengiran Anak Puteri Hajah Masna Secondary School (SMPAPHM)",
    "Pengiran Isteri Hajjah Mariam Secondary School (SMPIHM)",
    "Raja Isteri Girls' High School (STPRI)",
    "Raja Isteri Pengiran Anak Damit Girls' Arabic Religious Secondary School (SUAMPRIPAD)",
    "Raja Isteri Pengiran Anak Damit Secondary School",
    "Raja Isteri Pengiran Anak Hajah Saleha Girls' Secondary Arabic Religious School (SUAMPRIPAHS)",
    "Rimba II Secondary School (SMRII)",
    "Rimba Secondary School (SMR)",
    "Sayyidina Abu Bakar Secondary School (SMSAB)",
    "Sayyidina Hasan Secondary School",
    "Sayyidina Husain Secondary School",
    "Sayyidina Umar Al-Khattab Secondary School (SMSUA)",
    "Sengkurong Secondary School",
    "Seri Mulia Sarjana School (SMSS)",
    "St. Andrew's School",
    "St. George's School",
    "Sultan Muhammad Jamalul Alam Secondary School (SM SMJA)",
    "Sultan Omar Ali Saifuddien College (SOASC)",
    "Sultan Sharif Ali Secondary School (SMSSA)",
    "Yayasan Sultan Haji Hassanal Bolkiah Secondary School",
  ] },
  { group: "Belait", items: [
    "Anthony Abell College (AAC)",
    "Belait Arabic School",
    "Bukit Sawat Secondary School",
    "Chung Ching Middle School (CCMS)",
    "Chung Hua Middle School, Kuala Belait (CHMS KB)",
    "Kuala Belait Secondary School (SMKB)",
    "Pengiran Anak Puteri Hajah Rashidah Sa'adatul Bolkiah Secondary School (SMPAPHRSB)",
    "Pengiran Jaya Negara Pengiran Haji Abu Bakar Secondary School (SMPJNPHAB)",
    "Perdana Wazir Secondary School",
    "Sayyidina Ali Secondary School (SMSA)",
    "St. Angela's School",
    "St. James' School",
    "St. John's School",
    "St. Margaret's School (SMS)",
    "St. Michael's School",
  ] },
  { group: "Tutong", items: [
    "Ma'had Islam Brunei",
    "Muda Hashim Secondary School (SMMHT)",
    "Raja Isteri Pengiran Anak Saleha Secondary School (SM RIPAS)",
    "Sayyidina 'Othman Secondary School (SMSO)",
    "Sufri Bolkiah Secondary School (SMSB)",
    "Tanjong Maya Secondary School (SMTM)",
  ] },
  { group: "Temburong", items: [
    "Sultan Hassan Secondary School",
    "Temburong Arabic Preparatory School",
  ] },
];
const ALL_SCHOOLS = SCHOOLS.flatMap((g) => g.items);

/* Five mastery areas for the radar chart on the profile card. Each is a
   bundle of topics; the axis reaches the edge when every topic in it is
   S+. Ungraded counts as zero. */
const STAT_GROUPS = [
  { name: "Arithmetic", ids: TOPICS.slice(0, 8).map((t) => t.id) },
  { name: "Algebra", ids: [...TOPICS.slice(8, 14), TOPICS[29]].map((t) => t.id) },
  { name: "Graphs", ids: TOPICS.slice(14, 20).map((t) => t.id) },
  { name: "Shapes", ids: TOPICS.slice(20, 26).map((t) => t.id) },
  { name: "Statistics", ids: TOPICS.slice(26, 29).map((t) => t.id) },
];
function statGroupValue(profile, ids) {
  const topics = (profile && profile.topics) || {};
  const maxIdx = RANK_ORDER.length - 1; // S+
  const sum = ids.reduce((s, id) => s + Math.max(0, Math.min((topics[id] || {}).highestRank ?? -1, maxIdx)), 0);
  return ids.length ? sum / (ids.length * maxIdx) : 0; // 0..1
}
function RadarChart({ profile, dark }) {
  const cx = 120, cy = 104, R = 62, labelR = 82;
  const groups = STAT_GROUPS.map((g) => ({ name: g.name, v: statGroupValue(profile, g.ids) }));
  const at = (i, frac) => {
    const a = (-90 + i * 72) * Math.PI / 180;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };
  const ring = (frac) => groups.map((_, i) => at(i, frac).join(",")).join(" ");
  const data = groups.map((g, i) => at(i, Math.max(0.02, g.v)).join(",")).join(" ");
  // Contrast against whatever card background is behind us.
  const web = dark ? "#FFFFFF" : "var(--muted)";
  const webOp = dark ? 0.32 : 0.5;
  const acc = dark ? "#7FE0BB" : "var(--green)";
  const lab = dark ? "#EAF2EE" : "var(--ink)";
  return (
    <svg viewBox="-28 -6 296 232" width="100%" style={{ display: "block", maxWidth: 300, margin: "0 auto" }}>
      {[0.34, 0.67, 1].map((f, k) => <polygon key={k} points={ring(f)} fill="none" stroke={web} strokeOpacity={webOp} strokeWidth="1" />)}
      {groups.map((_, i) => { const [x, y] = at(i, 1); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={web} strokeOpacity={webOp} strokeWidth="1" />; })}
      <polygon points={data} fill={acc} fillOpacity={dark ? 0.24 : 0.32} stroke={acc} strokeWidth="2" strokeLinejoin="round" />
      {groups.map((g, i) => { const [x, y] = at(i, Math.max(0.02, g.v)); return <circle key={i} cx={x} cy={y} r="2.6" fill={acc} />; })}
      {groups.map((g, i) => {
        const a = (-90 + i * 72) * Math.PI / 180;
        const x = cx + Math.cos(a) * labelR, y = cy + Math.sin(a) * labelR;
        const anchor = Math.abs(x - cx) < 3 ? "middle" : x < cx ? "end" : "start";
        return (
          <text key={i} x={x} y={y} textAnchor={anchor} fill={lab}>
            <tspan fontSize="9" fontWeight="700">{g.name}</tspan>
            <tspan x={x} dy="10" fontSize="8" fontWeight="700" fill={acc}>{Math.round(g.v * 100)}%</tspan>
          </text>
        );
      })}
    </svg>
  );
}

/* Preset profile icons and icon borders for the profile card. Emoji keeps
   it theme-safe and screenshot-clean; ids are stored on the profile. */
const AVATARS = {
  grad: "🎓", owl: "🦉", fox: "🦊", cat: "🐱", panda: "🐼", tiger: "🐯",
  dragon: "🐉", robot: "🤖", wizard: "🧙", alien: "👽", ninja: "🥷", rocket: "🚀",
  star: "⭐", brain: "🧠", crown: "👑", bolt: "⚡", flower: "🌸", ghost: "👻",
};
const AVATAR_IDS = Object.keys(AVATARS);
const FRAMES = {
  plain: { border: "2px solid var(--grid)" },
  blue: { border: "3px solid var(--blue)" },
  green: { border: "3px solid var(--green)" },
  gold: { border: "3px solid #C99A1E" },
  violet: { border: "3px solid #7C5CFF" },
  rose: { border: "3px solid #E0567A" },
  dashed: { border: "3px dashed var(--blue)" },
  double: { border: "4px double var(--ink)" },
  glow: { border: "3px solid #E8A82D", boxShadow: "0 0 0 4px rgba(232,168,45,0.25)" },
};
const FRAME_IDS = Object.keys(FRAMES);

/* ---- per-level unlock schedule -------------------------------------
   One source of truth for what each level 1..20 grants. Cosmetic and
   tool gates check levelFromExp(totalExp(profile)) >= the level here.
   Skeleton Keys / XP Boosts are granted in creditLevelUps(); they're
   listed in unlocksAtLevel() only for the reveal + Unlocks screen. */
const AVATAR_LV = {
  grad: 1, star: 1, brain: 2, owl: 3, bolt: 4, fox: 5, ghost: 6, cat: 7,
  rocket: 8, flower: 9, panda: 10, tiger: 11, crown: 13, wizard: 14,
  alien: 16, ninja: 17, dragon: 18, robot: 20,
};
const FRAME_LV = {
  plain: 1, blue: 3, green: 6, dashed: 9, rose: 11, violet: 14,
  gold: 15, double: 17, glow: 19,
};
const SOUND_PACKS = {
  default: { name: "Classic", lv: 1 },
  arcade: { name: "Arcade", lv: 5 },
  chime: { name: "Chime", lv: 10 },
  retro: { name: "Retro", lv: 15 },
  bell: { name: "Bell", lv: 19 },
};
// Equippable perks (2 slots). Applied in submitAnswer; Momentum also in Blitz.
const PERKS = {
  compound: { name: "Compound Interest", icon: "📈", lv: 7,  desc: "Longer streaks pay more XP (+1 per 4 in a row, up to +6)" },
  momentum: { name: "Momentum",          icon: "🔗", lv: 11, desc: "Every 5th correct in a row scores double base XP" },
  quick:    { name: "Quick Study",        icon: "⚡", lv: 14, desc: "Answer correctly in under 8 seconds for +2 XP" },
  forgive:  { name: "Error Correction",   icon: "🛟", lv: 18, desc: "Your first slip in each topic each day doesn't break your streak" },
};
const PERK_IDS = Object.keys(PERKS);
const SKETCH_LV = 2;
const WRITE_LV = 3;
const SHIELD_LEVELS = [6, 13]; // levels that grant a Streak Shield

const avatarLevel = (id) => AVATAR_LV[id] || 1;
const frameLevel = (id) => FRAME_LV[id] || 1;
const bannerSlots = (lv) => (lv < 2 ? 0 : lv < 8 ? 1 : lv < 12 ? 2 : lv < 16 ? 3 : lv < 20 ? 4 : 5);
const BANNER_MAX = 5; // hard ceiling; the live cap is bannerSlots(level)

// Human-readable unlocks landing exactly at level L.
function unlocksAtLevel(L) {
  const out = [];
  Object.entries(AVATAR_LV).forEach(([id, lv]) => { if (lv === L) out.push(`${AVATARS[id]} profile icon`); });
  const frames = Object.entries(FRAME_LV).filter(([id, lv]) => lv === L && id !== "plain").length;
  if (frames) out.push(`${frames > 1 ? `${frames} icon frames` : "a new icon frame"}`);
  Object.values(SOUND_PACKS).forEach((p) => { if (p.lv === L && p.name !== "Classic") out.push(`${p.name} sound pack`); });
  const bs = bannerSlots(L);
  if (bs > bannerSlots(L - 1)) out.push(`Banner slot ${bs}`);
  if (L === SKETCH_LV) out.push("Rough-working pad");
  if (L === WRITE_LV) out.push("Handwriting input");
  Object.values(PERKS).forEach((p) => { if (p.lv === L) out.push(`Perk · ${p.name}`); });
  if (SHIELD_LEVELS.includes(L)) out.push("🛟 Streak Shield");
  if (L % 5 === 0) out.push("🗝 Skeleton Key");
  if (L % 4 === 0) out.push("⚡ ×2 XP Boost");
  out.push("🪙 +1 Hint coin");
  return out;
}
// Achievements you've earned are also selectable as profile icons —
// stored as "ach:<achievementId>".
const achAvatarId = (achId) => `ach:${achId}`;
// Every profile-icon id the student can currently pick — base icons up to
// their level, then one per earned achievement. Used for the "new" dots.
function unlockedAvatarIds(profile) {
  const lv = levelFromExp(totalExp(profile));
  const base = Object.keys(AVATARS).filter((id) => lv >= (AVATAR_LV[id] || 1));
  const ach = (profile.achievements || [])
    .filter((id) => ACHIEVEMENTS.some((a) => a.id === id))
    .map((id) => achAvatarId(id));
  return [...base, ...ach];
}
const avatarChar = (p) => {
  const id = (p && p.avatar) || "grad";
  if (id.startsWith("ach:")) {
    const a = ACHIEVEMENTS.find((x) => x.id === id.slice(4));
    return a ? a.icon : AVATARS.grad;
  }
  return AVATARS[id] || AVATARS.grad;
};
const frameStyle = (p) => FRAMES[(p && p.avatarFrame)] || FRAMES.plain;

/* ---- Phase 4 cosmetics --------------------------------------------- */

// Icon-border colours, reused for the banner accent. Same ids + unlock
// levels as FRAMES / FRAME_LV.
const FRAME_COLOR = {
  plain: "var(--grid)", blue: "var(--blue)", green: "var(--green)", gold: "#C99A1E",
  violet: "#7C5CFF", rose: "#E0567A", dashed: "var(--blue)", double: "var(--ink)", glow: "#E8A82D",
};
const bannerColorOf = (p) => FRAME_COLOR[(p && p.bannerColor)] || FRAME_COLOR.plain;

// Sound packs — {correct, wrong} note sets + waveform. Unlocked via SOUND_PACKS.lv.
const SOUND_PACK_DATA = {
  default: { wave: "triangle", correct: [659.25, 783.99, 1046.5, 1318.5], wrong: [391.995, 329.63, 261.63] },
  arcade:  { wave: "square",   correct: [523.25, 659.25, 880.0, 1174.66], wrong: [220.0, 174.61, 138.59] },
  chime:   { wave: "sine",     correct: [587.33, 880.0, 1174.66, 1567.98], wrong: [440.0, 349.23, 277.18] },
  retro:   { wave: "square",   correct: [880.0, 1174.66, 1760.0, 2349.32], wrong: [329.63, 246.94, 174.61] },
  bell:    { wave: "sine",     correct: [1046.5, 1318.5, 1567.98, 2093.0], wrong: [523.25, 415.3, 311.13] },
};
const soundPackOf = (p) => SOUND_PACK_DATA[(p && p.soundPack)] || SOUND_PACK_DATA.default;

// Name text styles. Unlocked one per prestige (index = prestige needed).
const NAME_STYLES = {
  plain:    { name: "Plain",    prestige: 0, style: {} },
  gold:     { name: "Gold",     prestige: 1, style: { color: "#C99A1E" } },
  glow:     { name: "Glow",     prestige: 2, style: { textShadow: "0 0 10px currentColor" } },
  ocean:    { name: "Ocean",    prestige: 3, style: { background: "linear-gradient(90deg,var(--blue),#4FC3C7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } },
  violetite:{ name: "Amethyst", prestige: 5, style: { background: "linear-gradient(90deg,#7C5CFF,#E0567A)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } },
  ember:    { name: "Ember",    prestige: 8, style: { background: "linear-gradient(90deg,#E0567A,#C99A1E)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } },
};
const NAME_STYLE_IDS = Object.keys(NAME_STYLES);
const nameStyleOf = (p) => (NAME_STYLES[(p && p.nameStyle)] || NAME_STYLES.plain).style;

// Profile-card backgrounds. One unlocked per prestige (order = prestige needed).
const CARD_BGS = {
  graph:     { name: "Graph paper", grid: true,  bg: "var(--paper)" },
  plain:     { name: "Clean",       bg: "var(--card)" },
  mint:      { name: "Mint",        bg: "linear-gradient(135deg,#CDEEDC,#A9E0C6)" },
  sky:       { name: "Sky",         bg: "linear-gradient(135deg,#CFE2F6,#AFCDEF)" },
  dots:      { name: "Dotted",      bg: "#EFF3F7", img: "radial-gradient(#9DB0C2 1.4px, transparent 1.6px)", size: "11px 11px" },
  blueprint: { name: "Blueprint",   bg: "#12335A", img: "linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px)", size: "18px 18px", dark: true },
  sunset:    { name: "Sunset",      bg: "linear-gradient(135deg,#FAD9BE,#F4B9C6)" },
  slate:     { name: "Slate",       bg: "#2A3644", dark: true },
  stripes:   { name: "Stripes",     bg: "#EFF3F7", img: "repeating-linear-gradient(45deg,#B9C6D4 0 1.5px,transparent 1.5px 12px)" },
  aurora:    { name: "Aurora",      bg: "linear-gradient(135deg,#D6D9F6,#BFE9E1)" },
  gold:      { name: "Gold leaf",   bg: "linear-gradient(135deg,#F6E7BF,#EAD29A)" },
};
const CARD_BG_IDS = Object.keys(CARD_BGS);
const cardBgOf = (p) => CARD_BGS[(p && p.cardBg)] || CARD_BGS.graph;
// Build a clean style object — never emit `backgroundImage: undefined`,
// which React turns into `= ''` and wipes a `background:` gradient.
function cardBgStyle(b, swatch) {
  if (b.grid) {
    return swatch
      ? { backgroundColor: "var(--paper)", backgroundImage: "linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px)", backgroundSize: "9px 9px" }
      : {};
  }
  const s = { background: b.bg };
  if (b.img) { s.backgroundImage = b.img; s.backgroundSize = b.size; }
  return s;
}
// small avatar for leaderboard rows
function MiniAvatar({ profile, size = 32 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%", background: "var(--card)", flexShrink: 0,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.round(size * 0.56), lineHeight: 1, ...frameStyle(profile),
    }}>{avatarChar(profile)}</span>
  );
}
// the pinned badges that are actually earned and still exist
function bannerBadges(profile) {
  const earned = profile.achievements || [];
  const slots = bannerSlots(levelFromExp(totalExp(profile)));
  return (profile.banner || [])
    .filter((id) => earned.includes(id))
    .map((id) => ACHIEVEMENTS.find((a) => a.id === id))
    .filter(Boolean)
    .slice(0, slots);
}

// one badge chip with a tier-coloured border (bronze/silver/gold/platinum)
function BadgeChip({ a, size = 40, on = true }) {
  const col = TIER_COLOR[a.tier];
  return (
    <span title={a.name} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, borderRadius: 9, fontSize: Math.round(size * 0.55), lineHeight: 1,
      border: `2px solid ${col}`, background: on ? "var(--paper)" : "transparent",
    }}>{a.icon}</span>
  );
}

/* Shareable summary of a student's progress. Pure display unless
   onEditIcon / onEditBanner are supplied (own card) — then the icon and
   the banner are tappable to open their pickers. */
function ProfileCard({ profile, onEditIcon, onEditBanner, newIcons }) {
  const level = levelFromExp(totalExp(profile));
  const title = titleFor(profile);
  const prestige = profile.prestige || 0;
  const cardBg = cardBgOf(profile);
  const nameSty = nameStyleOf(profile);
  const bannerCol = bannerColorOf(profile);
  const sub = cardBg.dark ? "rgba(255,255,255,0.62)" : "var(--muted)";
  const accent = cardBg.dark ? "#9FD0F5" : "var(--blue)";
  const achCount = (profile.achievements || []).filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length;
  const badges = bannerBadges(profile);
  const showBanner = badges.length > 0 || !!onEditBanner; // header slot: banner if there's one to show, else name
  const stat = (label, value) => (
    <div style={{ textAlign: "center" }}>
      <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
  const nameBlock = (
    <div style={{ minWidth: 0 }}>
      <div className="mub-display" style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.15, wordBreak: "break-word", ...nameSty }}>{profile.name || "Student"}</div>
      <div style={{ fontSize: 12, color: accent, fontWeight: 600, marginTop: 2 }}>
        {title} · Level {level}{prestige > 0 ? ` · Prestige ${prestige}` : ""}
      </div>
      {profile.school && profile.school !== SOLO_SCHOOL && (
        <div style={{ fontSize: 10.5, color: sub, marginTop: 2, wordBreak: "break-word" }}>{profile.school}</div>
      )}
    </div>
  );
  const bannerBox = (
    <div
      onClick={onEditBanner}
      style={{
        flex: 1, minWidth: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 8,
        background: badges.length ? `color-mix(in srgb, ${bannerCol} 14%, var(--card))` : "var(--card)",
        border: `${badges.length ? "2px solid" : "1px dashed"} ${badges.length ? bannerCol : "var(--grid)"}`, borderRadius: 12,
        padding: "8px 10px", cursor: onEditBanner ? "pointer" : "default",
        WebkitTapHighlightColor: "transparent", outline: "none",
      }}
    >
      {badges.length > 0
        ? badges.map((a) => <BadgeChip key={a.id} a={a} />)
        : <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>＋ Choose badges</span>}
    </div>
  );
  return (
    <div className={cardBg.grid ? "mub-grid" : undefined} style={{
      width: 360, maxWidth: "100%", border: "1px solid var(--grid)", borderRadius: 18, padding: 22,
      color: cardBg.dark ? "#F2F5F8" : "var(--ink)",
      ...cardBgStyle(cardBg),
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="mub-display" style={{ fontSize: 16, fontWeight: 700 }}>MathsUnlocked</span>
        <span style={{ fontSize: 10, color: cardBg.dark ? "rgba(255,255,255,.6)" : "var(--muted)", fontWeight: 600 }}>BN · Mastery Challenge</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "20px 0 14px" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <div
            onClick={onEditIcon}
            style={{ width: 60, height: 60, borderRadius: "50%", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, lineHeight: 1, cursor: onEditIcon ? "pointer" : "default", WebkitTapHighlightColor: "transparent", outline: "none", ...frameStyle(profile) }}
          >
            {avatarChar(profile)}
          </div>
          {newIcons && onEditIcon && (
            <div style={{ position: "absolute", top: -1, right: -1, width: 13, height: 13, borderRadius: "50%", background: "var(--red)", border: "2px solid var(--card)", boxSizing: "border-box" }} />
          )}
          {prestige > 0 && (
            <div style={{ position: "absolute", right: -6, bottom: -4 }}>
              <PrestigeBadge prestige={prestige} size={22} />
            </div>
          )}
        </div>
        {showBanner ? bannerBox : nameBlock}
      </div>

      {showBanner && <div style={{ marginBottom: 14 }}>{nameBlock}</div>}

      <div style={{ display: "flex", justifyContent: "space-around", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: "12px 8px", marginBottom: 14 }}>
        {stat("Best streak", profile.bestStreak || 0)}
        {stat("Correct", profile.totalCorrect || 0)}
        {stat("Badges", `${achCount}/${ACHIEVEMENTS.length}`)}
      </div>

      <div style={{ fontSize: 10, color: sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
        Mastery
      </div>
      <RadarChart profile={profile} dark={cardBg.dark} />
    </div>
  );
}

/* Full-screen sheet for the two profile-card pickers. */
function EditSheet({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", zIndex: 70, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: "100%", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 18, color: "var(--ink)", fontFamily: "Inter, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div className="mub-display" style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ fontSize: 12, fontWeight: 600, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "6px 14px", cursor: "pointer" }}>Done</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function IconPickerModal({ profile, onChange, onClose }) {
  const level = levelFromExp(totalExp(profile));
  const Head = ({ children }) => (
    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 8px" }}>{children}</div>
  );
  const lockPill = (lv) => (
    <span style={{ position: "absolute", bottom: -7, left: "50%", transform: "translateX(-50%)", fontSize: 8, fontWeight: 800, color: "var(--muted)", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 999, padding: "0 4px", whiteSpace: "nowrap" }}>Lv {lv}</span>
  );
  const seen = profile.seenIcons || [];
  const iconItems = [
    ...Object.keys(AVATARS)
      .sort((a, b) => avatarLevel(a) - avatarLevel(b))
      .map((id) => ({ id, char: AVATARS[id], lv: avatarLevel(id), border: "var(--grid)" })),
    ...ACHIEVEMENTS.filter((a) => (profile.achievements || []).includes(a.id))
      .map((a) => ({ id: achAvatarId(a.id), char: a.icon, lv: 0, border: TIER_COLOR[a.tier], title: `${a.name} · ${a.tier}` })),
  ];
  return (
    <EditSheet title="Profile icon" onClose={onClose}>
      <Head>Icon</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 22 }}>
        {iconItems.map((it) => {
          const on = (profile.avatar || "grad") === it.id;
          const locked = it.lv > 0 && level < it.lv;
          const isNew = !locked && !seen.includes(it.id);
          return (
            <div key={it.id} style={{ position: "relative" }}>
              <button type="button" title={it.title} disabled={locked}
                onClick={() => { if (locked) return; onChange((p) => ({ avatar: it.id, seenIcons: [...new Set([...(p.seenIcons || []), it.id])] })); }}
                style={{
                  width: 44, height: 44, borderRadius: 10, fontSize: 22, lineHeight: 1, cursor: locked ? "default" : "pointer",
                  background: on ? "var(--blue)" : "var(--paper)", border: `1.5px solid ${on ? "var(--blue)" : it.border}`,
                  filter: locked ? "grayscale(1)" : "none", opacity: locked ? 0.4 : 1,
                }}>{it.char}</button>
              {locked && lockPill(it.lv)}
              {isNew && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--red)", border: "1.5px solid var(--card)", boxSizing: "border-box" }} />}
            </div>
          );
        })}
      </div>
      <Head>Border</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, paddingBottom: 4 }}>
        {FRAME_IDS.map((id) => {
          const on = (profile.avatarFrame || "plain") === id;
          const lv = frameLevel(id);
          const locked = level < lv;
          return (
            <div key={id} style={{ position: "relative" }}>
              <button type="button" disabled={locked} onClick={() => !locked && onChange(() => ({ avatarFrame: id }))} style={{
                width: 46, height: 46, borderRadius: "50%", background: "var(--card)", cursor: locked ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, lineHeight: 1,
                ...FRAMES[id], outline: on ? "2px solid var(--blue)" : "none", outlineOffset: 3,
                filter: locked ? "grayscale(1)" : "none", opacity: locked ? 0.4 : 1,
              }}>{avatarChar(profile)}</button>
              {locked && lockPill(lv)}
            </div>
          );
        })}
      </div>
    </EditSheet>
  );
}

function BannerPickerModal({ profile, onChange, onClose }) {
  const level = levelFromExp(totalExp(profile));
  const slots = bannerSlots(level);
  const earned = ACHIEVEMENTS.filter((a) => (profile.achievements || []).includes(a.id));
  const banner = (profile.banner || []).filter((id) => earned.some((a) => a.id === id));
  const toggle = (id) => onChange((p) => {
    const b = (p.banner || []).filter((x) => earned.some((a) => a.id === x));
    if (b.includes(id)) return { banner: b.filter((x) => x !== id) };
    return b.length < slots ? { banner: [...b, id] } : {};
  });
  const Head = ({ children }) => (
    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 8px" }}>{children}</div>
  );
  return (
    <EditSheet title={`Banner · ${banner.length}/${slots}`} onClose={onClose}>
      {slots === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Banner slots unlock at Level 2. Keep going!</div>
      ) : (<>
        <Head>Badges</Head>
        {earned.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 18 }}>Earn badges and they&rsquo;ll show up here to choose from.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 18 }}>
            {earned.map((a) => {
              const on = banner.includes(a.id);
              const col = TIER_COLOR[a.tier];
              return (
                <button key={a.id} type="button" title={a.name} onClick={() => toggle(a.id)} style={{
                  width: 46, height: 46, borderRadius: 11, fontSize: 22, lineHeight: 1, cursor: "pointer",
                  border: `2px solid ${col}`, background: on ? col : "var(--paper)", opacity: on ? 1 : 0.9,
                }}>{a.icon}</button>
              );
            })}
          </div>
        )}
        <Head>Banner colour</Head>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {FRAME_IDS.map((id) => {
            const lv = frameLevel(id);
            const locked = level < lv;
            const on = (profile.bannerColor || "plain") === id;
            return (
              <div key={id} style={{ position: "relative" }}>
                <button type="button" disabled={locked} onClick={() => !locked && onChange(() => ({ bannerColor: id }))} style={{
                  width: 40, height: 40, borderRadius: 10, cursor: locked ? "default" : "pointer",
                  background: `color-mix(in srgb, ${FRAME_COLOR[id]} 16%, var(--card))`, border: `3px solid ${FRAME_COLOR[id]}`,
                  outline: on ? "2px solid var(--blue)" : "none", outlineOffset: 3,
                  filter: locked ? "grayscale(1)" : "none", opacity: locked ? 0.4 : 1,
                }} />
                {locked && (
                  <span style={{ position: "absolute", bottom: -7, left: "50%", transform: "translateX(-50%)", fontSize: 8, fontWeight: 800, color: "var(--muted)", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 999, padding: "0 4px", whiteSpace: "nowrap" }}>Lv {lv}</span>
                )}
              </div>
            );
          })}
        </div>
      </>)}
    </EditSheet>
  );
}

/* Sound pack / title / name style / card background picker. */
function StyleModal({ profile, onChange, onClose, previewPack }) {
  const level = levelFromExp(totalExp(profile));
  const prestige = profile.prestige || 0;
  const Head = ({ children }) => (
    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "18px 0 8px" }}>{children}</div>
  );
  const pill = (on, locked) => ({
    fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 999, cursor: locked ? "default" : "pointer",
    border: `1.5px solid ${on ? "var(--blue)" : "var(--grid)"}`, background: on ? "var(--blue)" : "var(--paper)",
    color: on ? "var(--on-accent)" : locked ? "var(--muted)" : "var(--ink)", opacity: locked ? 0.55 : 1,
  });
  return (
    <EditSheet title="Style" onClose={onClose}>
      <div style={{ marginTop: -8 }} />
      <Head>Sound pack</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {Object.entries(SOUND_PACKS).map(([id, p]) => {
          const locked = level < p.lv;
          const on = (profile.soundPack || "default") === id;
          return (
            <button key={id} type="button" disabled={locked} style={pill(on, locked)}
              onClick={() => { if (locked) return; onChange(() => ({ soundPack: id })); previewPack && previewPack(id); }}>
              {p.name}{locked ? ` · Lv ${p.lv}` : ""}
            </button>
          );
        })}
      </div>

      <Head>Title</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" style={pill(!profile.title, false)} onClick={() => onChange(() => ({ title: "" }))}>Auto (by level)</button>
        {unlockedTitles(profile).map((name) => (
          <button key={name} type="button" style={pill(profile.title === name, false)} onClick={() => onChange(() => ({ title: name }))}>{name}</button>
        ))}
      </div>

      <Head>Name style {prestige === 0 ? "· unlock with Prestige" : ""}</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {NAME_STYLE_IDS.map((id) => {
          const s = NAME_STYLES[id];
          const locked = prestige < s.prestige;
          const on = (profile.nameStyle || "plain") === id;
          return (
            <button key={id} type="button" disabled={locked} style={{ ...pill(on, locked), ...(locked ? {} : s.style) }}
              onClick={() => !locked && onChange(() => ({ nameStyle: id }))}>
              {s.name}{locked ? ` · P${s.prestige}` : ""}
            </button>
          );
        })}
      </div>

      <Head>Card background {prestige === 0 ? "· unlock with Prestige" : ""}</Head>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {CARD_BG_IDS.map((id, i) => {
          const b = CARD_BGS[id];
          const locked = prestige < i;
          const on = (profile.cardBg || "graph") === id;
          return (
            <div key={id} style={{ width: 66 }}>
              <button type="button" disabled={locked} onClick={() => !locked && onChange(() => ({ cardBg: id }))} style={{
                width: 66, height: 44, borderRadius: 8, cursor: locked ? "default" : "pointer", padding: 0,
                border: `2px solid ${on ? "var(--blue)" : "var(--grid)"}`,
                ...cardBgStyle(b, true),
                filter: locked ? "grayscale(1)" : "none", opacity: locked ? 0.45 : 1,
              }} />
              <div style={{ fontSize: 9.5, color: "var(--muted)", textAlign: "center", marginTop: 3 }}>{locked ? `P${i}` : b.name}</div>
            </div>
          );
        })}
      </div>
    </EditSheet>
  );
}

/* Read-only view of one student — their card plus a grade for every
   topic. Used by the Parent Link page and the friend search. */
function StudentProfileView({ profile }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
        <ProfileCard profile={profile} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Grade in every topic</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
        {TOPICS.map((t) => {
          const r = rankDisplay(((profile.topics || {})[t.id] || {}).highestRank);
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 10, background: "var(--card)" }}>
              <span style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.icon} {t.name}</span>
              <span style={{ fontWeight: 700, fontSize: 12, color: r.color, flexShrink: 0 }}>{r.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Achievement check helpers. A topic "counts" once its ratcheted
   highestRank reaches the given label; topicHasCorrect looks for any
   correct answer still in the rolling last-10 history. */
function topicRankAtLeast(profile, topicId, label) {
  return (((profile.topics || {})[topicId] || {}).highestRank ?? -1) >= RANK_ORDER.indexOf(label);
}
function allTopicsRankAtLeast(profile, topics, label) {
  return topics.every((t) => topicRankAtLeast(profile, t.id, label));
}
function topicHasCorrect(profile, topicId) {
  return ((((profile.topics || {})[topicId] || {}).history) || []).some((v) => v === 1);
}

/* A topic unlocks once every prerequisite topic has reached at least
   rank C (50%) — a "basic competency" bar, not full mastery. */
const UNLOCK_RANK = RANK_ORDER.indexOf("C");
function isUnlocked(topic, profile) {
  if ((profile.keyedTopics || []).includes(topic.id)) return true; // opened early with a Skeleton Key
  return topic.prereqs.every((pid) => ((profile.topics[pid] || {}).highestRank ?? -1) >= UNLOCK_RANK);
}
function lockedReason(topic) {
  const names = topic.prereqs.map((pid) => TOPIC_BY_ID[pid].name);
  return `Unlocks after reaching C in ${names.join(" & ")}`;
}

/* ---------------------------------------------------------
   Daily tasks. Three a day: "show up" is always one, the
   other two rotate from a pool, chosen deterministically
   from the date so everyone gets the same set. Each claimed
   task adds to profile.bonusExp. A separate one-time list
   ("first-time bonuses") nudges feature discovery.
--------------------------------------------------------- */
const DAILY_XP = { showup: 5, task: 40 };  // show-up is deliberately tiny — can't reach Level 2 alone
const MILESTONE_XP = 50;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// The Monday that starts this week, as a YYYY-MM-DD string — the weekly
// school leaderboard bucket. Local time (≈ Brunei time for our students).
function weekKey(d = new Date()) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); // back up to Monday
  return todayKey(m);
}
// Roll the weekly XP bucket over on a new week (stashing last week's total
// for the "champions" banner), then add this session's gain.
function bumpWeek(profile, gain) {
  const wk = weekKey();
  if (!profile.week || profile.week.of !== wk) {
    if (profile.week && profile.week.xp > 0) profile.lastWeek = { of: profile.week.of, xp: profile.week.xp };
    profile.week = { of: wk, xp: 0 };
  }
  if (gain > 0) profile.week.xp += gain;
}
function weakestTopicId(profile) {
  const topics = profile.topics || {};
  const pool = TOPICS.filter((t) => isUnlocked(t, profile));
  let worst = pool[0] || TOPICS[0];
  let worstRank = (topics[worst.id] || {}).highestRank ?? -1;
  for (const t of pool) {
    const r = (topics[t.id] || {}).highestRank ?? -1;
    if (r < worstRank) { worst = t; worstRank = r; }
  }
  return worst.id;
}

const SHOWUP_TASK = { id: "showup", label: "Open the app today", goal: 1, progress: () => 1 };
const DAILY_POOL = [
  { id: "correct5", label: "Get 5 correct answers", goal: 5, progress: (d) => d.correct },
  { id: "streak3", label: "Get 3 correct in a row", goal: 3, progress: (d) => d.bestStreakToday },
  { id: "topics3", label: "Practise 3 different topics", goal: 3, progress: (d) => (d.topics || []).length },
  { id: "weak3", goal: 3, progress: (d) => d.weakCorrect,
    label: (d) => `Get 3 right in ${(TOPIC_BY_ID[d.weakTopicId] || {}).name || "one topic"}` },
  { id: "mixed", label: "Play a round of Mixed Review", goal: 1, progress: (d) => d.mixedRounds, needsMixed: true },
];
const TASK_BY_ID = Object.fromEntries([SHOWUP_TASK, ...DAILY_POOL].map((t) => [t.id, t]));

const MILESTONES = [
  { id: "friendview", label: "View a friend's profile" },
  { id: "leaderboard", label: "Check the leaderboard" },
  { id: "parentlink", label: "Open your Parent Link" },
  { id: "usekey", label: "Use a Skeleton Key" },
];

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function pickDailyTasks(date, profile) {
  const pool = DAILY_POOL.filter((t) => !t.needsMixed || levelFromExp(totalExp(profile)) >= MIXED_UNLOCK_LEVEL);
  const h = hashStr(date);
  const a = h % pool.length;
  let b = (Math.floor(h / pool.length) + 1) % pool.length;
  if (b === a) b = (b + 1) % pool.length;
  return ["showup", pool[a].id, pool[b].id];
}
function freshDay(profile) {
  const date = todayKey();
  return {
    date, tasks: pickDailyTasks(date, profile), claimed: {},
    correct: 0, topics: [], streakToday: 0, bestStreakToday: 0,
    weakCorrect: 0, weakTopicId: weakestTopicId(profile), mixedRounds: 0,
  };
}
function ensureDay(profile) {
  if (!profile.daily || profile.daily.date !== todayKey()) profile.daily = freshDay(profile);
  return profile.daily;
}
function taskDone(task, day) {
  return (task.id === "showup" ? 1 : task.progress(day)) >= task.goal;
}

// Record level-ups (timestamps + Skeleton Keys + XP Boosts) after any XP
// change. Keys land on 5/10/15/20; ×2 XP Boosts on 4/8/12/16/20.
function creditLevelUps(next, expBefore) {
  const before = levelFromExp(expBefore);
  const after = levelFromExp(totalExp(next));
  if (after > before) {
    next.levelReachedAt = next.levelReachedAt || {};
    for (let L = before + 1; L <= after; L++) {
      if (!next.levelReachedAt[L]) next.levelReachedAt[L] = Date.now();
      if (L % 5 === 0) next.keys = (next.keys || 0) + 1;
      if (L % 4 === 0) next.boosts = (next.boosts || 0) + 1;
      if (SHIELD_LEVELS.includes(L)) next.shields = (next.shields || 0) + 1;
      next.hints = (next.hints || 0) + 1; // one Hint coin per level
    }
  }
  return after > before ? after : null;
}

const emptyProfile = () => ({
  name: "", school: SOLO_SCHOOL, topics: {}, achievements: [], achievedAt: {},
  streak: 0, bestStreak: 0, fastCorrect: 0, minuteCorrect: 0, totalCorrect: 0,
  consecWrong: 0, nightOwl: false, comeback: false, solvedSurd: false, got67: false,
  prestige: 0, prestigeAt: [], keys: 0, keyedTopics: [], levelReachedAt: {},
  bonusExp: 0, daily: null, milestones: {}, week: null, lastWeek: null,
  blitzBest: 0, mixedStreak: 0, bestMixedStreak: 0,
  boosts: 0, boostUntil: 0, hints: 0, shields: 0, perks: [], soundPack: "default",
  avatar: "grad", avatarFrame: "plain", banner: [], bannerColor: "plain",
  cardBg: "graph", nameStyle: "plain", title: "", seenIcons: [], seenFriends: [],
  seenChallenges: [],
  usedHint: false, gotCircle: false, gotFriend: false, playStreak: 0,
  dodgeTopic: null, dodgeCount: 0, dodgeCaught: false, dodgeLocked: false, dodgeStuck: {},
});
const slug = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "student";
const genToken = () => {
  try { return crypto.randomUUID().replace(/-/g, "").slice(0, 18); } catch (e) { /* fall through */ }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
};

// A student's leaderboard standing "settled" at the latest moment they
// improved — used to break school ties ("reached it first" wins).
function lastImprovementAt(profile) {
  const times = [
    ...Object.values(profile.levelReachedAt || {}),
    ...(profile.prestigeAt || []),
    ...Object.values(profile.achievedAt || {}),
    profile.createdAt || 0,
  ].filter((n) => typeof n === "number");
  return times.length ? Math.max(...times) : 0;
}

// Shape a raw profile (as returned by getLeaderboard, or `profile` itself)
// into a leaderboard row. Shared by the Top Players and Friends tabs.
function toBoardEntry(m) {
  return {
    name: m.name,
    school: m.school && m.school !== SOLO_SCHOOL ? m.school : null,
    score: leaderboardScore(m),
    prestige: m.prestige || 0,
    level: levelFromExp(totalExp(m)),
    title: titleFor(m),
    correct: m.totalCorrect || 0,
    achievements: (m.achievements || []).length,
    bestRank: Math.max(-1, ...Object.values(m.topics || {}).map((t) => t.highestRank ?? -1)),
    at: lastImprovementAt(m),
    full: m,
  };
}

/* Two palettes keyed to the same CSS-variable names. The root <div> gets
   whichever set the current theme selects, so every `var(--x)` downstream
   flips automatically. Rank/tier badge colours are left as fixed hues —
   they read acceptably on both grounds. */
const THEMES = {
  light: {
    "--ink": "#1F2937", "--paper": "#F7F9FB", "--grid": "#DCE8F1",
    "--card": "#FFFFFF", "--locked": "#EEF1F4", "--amber-wash": "#FBF3E6",
    "--green": "#2F6B4F", "--blue": "#3B6FA0", "--amber": "#C97F1E",
    "--red": "#B14A36", "--muted": "#8A97A6", "--on-accent": "#FFFFFF",
    "--shadow": "rgba(31,41,55,0.10)", "--shadow-soft": "rgba(31,41,55,0.06)",
    "--page-bg": "#F7F9FB",
  },
  dark: {
    "--ink": "#E6EBF1", "--paper": "#141A22", "--grid": "#2A3644",
    "--card": "#1C242F", "--locked": "#181E27", "--amber-wash": "#2E2617",
    "--green": "#5EBE94", "--blue": "#7FB0DD", "--amber": "#E0A94E",
    "--red": "#E38066", "--muted": "#8B98A7", "--on-accent": "#0E1319",
    "--shadow": "rgba(0,0,0,0.5)", "--shadow-soft": "rgba(0,0,0,0.35)",
    "--page-bg": "#0E1319",
  },
};

export default function MathsUnlockedBN() {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState(emptyProfile());
  const [screen, setScreen] = useState("login");
  const [nameInput, setNameInput] = useState("");
  const [schoolInput, setSchoolInput] = useState(SOLO_SCHOOL);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [authUid, setAuthUid] = useState(null); // the signed-in user's real auth.uid()
  const [forgotOpen, setForgotOpen] = useState(false); // "forgot your PIN?" panel on the login screen
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState(null); // { ok, text }
  const [recoveryOpen, setRecoveryOpen] = useState(false); // "add a recovery email" modal
  const [recEmail, setRecEmail] = useState("");
  const [recBusy, setRecBusy] = useState(false);
  const [recMsg, setRecMsg] = useState(null); // { ok, text }
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [changePinBusy, setChangePinBusy] = useState(false);
  const [changePinMsg, setChangePinMsg] = useState(null); // { ok, text }
  const [settingsOpen, setSettingsOpen] = useState(false); // gear-icon settings panel
  const [missionsOpen, setMissionsOpen] = useState(false); // Missions overlay
  const [achOpen, setAchOpen] = useState(false); // Achievements overlay
  const [achHideDone, setAchHideDone] = useState(false); // hide earned achievements
  const [inventoryOpen, setInventoryOpen] = useState(false); // Inventory overlay
  const [unlocksOpen, setUnlocksOpen] = useState(false);   // per-level Unlocks screen
  const [hintShown, setHintShown] = useState(false);       // Hint coin spent on this question
  const [perksOpen, setPerksOpen] = useState(false);       // perk loadout modal
  const [stylePickerOpen, setStylePickerOpen] = useState(false); // sound/title/name/card-bg picker
  const [shieldOffer, setShieldOffer] = useState(false);   // wrong answer, offering a Streak Shield
  const [shieldDeclined, setShieldDeclined] = useState(false); // said no to the shield this question
  const [resetPin, setResetPin] = useState(""); // new PIN on the reset screen
  const [resetBusy, setResetBusy] = useState(false);
  const [showSchool, setShowSchool] = useState(false);
  const [schoolEditQuery, setSchoolEditQuery] = useState("");
  const [devTopic, setDevTopic] = useState(TOPICS[0].id);
  const [devJingle, setDevJingle] = useState("achievement"); // dev-tools jingle picker
  const [devOpen, setDevOpen] = useState(false); // dev-tools panel collapsed by default
  const [toast, setToast] = useState(null);
  const [activeTopic, setActiveTopic] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answerInput, setAnswerInput] = useState("");
  const [writePad, setWritePad] = useState(false);   // handwriting pad for the answer box
  const [multiInput, setMultiInput] = useState({}); // for questions with several answer fields (e.g. x & y)
  const [drawPts, setDrawPts] = useState([]);       // up to 2 lattice points tapped on a "draw the graph" question
  const [regionPick, setRegionPick] = useState(null); // [x,y] a point tapped inside a half-plane for "shade the region"
  const [cfPick, setCfPick] = useState([]);           // up to 2 guide lines on a cumulative-frequency graph
  const [vennPressed, setVennPressed] = useState([]); // region keys shaded on a Venn diagram question
  const [vennPlace, setVennPlace] = useState({});     // { [element]: regionKey } on a "drag the numbers in" Venn question
  const [mcPick, setMcPick] = useState(null);        // chosen option on a multiple-choice question
  const [drawTri, setDrawTri] = useState([]);        // up to 3 vertices tapped to place an image triangle
  const [sketchOn, setSketchOn] = useState(false);   // scratch overlay toggle on the quiz card
  const [sketchStrokes, setSketchStrokes] = useState([]); // rough-working strokes, cleared per question
  const [feedback, setFeedback] = useState(null);
  const [clockTick, setClockTick] = useState(0); // ticks every 20s so the XP-Boost countdown stays live
  const [blitzPhase, setBlitzPhase] = useState("idle"); // idle | intro | playing | over
  const [blitzScore, setBlitzScore] = useState(0);
  const [blitzLeft, setBlitzLeft] = useState(BLITZ_SECONDS);
  const [blitzQ, setBlitzQ] = useState(null);
  const [blitzPick, setBlitzPick] = useState(null);     // { value, correct } while the pick flashes
  const [blitzResult, setBlitzResult] = useState(null); // { score, best, newBest, unlocked }
  const blitzDeadline = useRef(0);
  const blitzCorrect = useRef(0);
  const blitzAdvance = useRef(null);
  const blitzDone = useRef(false);
  // Async PvP: while a challenge run is live this holds
  // { mode:"create"|"play", id, opponentUid, opponentName, opponentScore, questions, idx };
  // null for a normal solo Blitz.
  const challengeRef = useRef(null);
  const [challengeResult, setChallengeResult] = useState(null); // { mode, opponentName, myScore, opponentScore }
  const [blitzChallenges, setBlitzChallenges] = useState([]);   // every challenge involving me
  const [challengeBusy, setChallengeBusy] = useState(false);
  const [students, setStudents] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [pinResetFor, setPinResetFor] = useState(null); // student uid whose PIN reset panel is open
  const [pinResetVal, setPinResetVal] = useState("");
  const [pinResetBusy, setPinResetBusy] = useState(false);
  const [pinResetMsg, setPinResetMsg] = useState(null); // { uid, ok, text }
  const [customQuestions, setCustomQuestions] = useState({});
  const [qbTopicId, setQbTopicId] = useState(TOPICS[0].id);
  const [qbForm, setQbForm] = useState({ prompt: "", answer: "", hint: "", steps: "" });
  const [qbEditingId, setQbEditingId] = useState(null);
  const [qbPreview, setQbPreview] = useState(null);
  const [showCard, setShowCard] = useState(false);
  const [pickIcon, setPickIcon] = useState(false);   // profile-card icon/border picker
  const [pickBanner, setPickBanner] = useState(false); // profile-card badge banner picker
  const [showParentLink, setShowParentLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [parentView, setParentView] = useState(null); // read-only progress for a ?p= link
  const [board, setBoard] = useState(null);           // { loading, schools, weekly, ... }
  const [boardTab, setBoardTab] = useState("school"); // "school" | "players" | "friends"
  const [schoolSubTab, setSchoolSubTab] = useState("alltime"); // within the School tab: "alltime" | "week"
  const [openSchool, setOpenSchool] = useState(null); // name of the one expanded school on the leaderboard
  const [rosterProfile, setRosterProfile] = useState(null); // a leaderboard student whose full profile is shown in a modal
  const [friendQuery, setFriendQuery] = useState("");
  const [friendResults, setFriendResults] = useState(null); // null = not searched yet
  const [friendLoading, setFriendLoading] = useState(false);
  const [friendView, setFriendView] = useState(null);       // a selected student's profile
  const [friendGraph, setFriendGraph] = useState({ friends: [], incoming: [], outgoing: [] });
  const [friendPeople, setFriendPeople] = useState({});      // uid -> public profile
  const [friendBusy, setFriendBusy] = useState(null);        // uid mid-action
  const [friendFind, setFriendFind] = useState(false);       // friends screen: search sub-view
  const [confirmPrestige, setConfirmPrestige] = useState(false);
  const [keyTarget, setKeyTarget] = useState(null);
  const [theme, setTheme] = useState("light");
  const [soundOn, setSoundOn] = useState(true);
  const [teacherMode, setTeacherMode] = useState(false);
  const startTimeRef = useRef(null);
  const audioCtxRef = useRef(null);
  const answerRef = useRef(null);
  const nextRef = useRef(null);
  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; });

  // Only auto-focus inputs on devices with a real pointer (desktop). On
  // touch, focusing pops the on-screen keyboard over the question — let
  // the student read it and tap the box themselves.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    try { setIsDesktop(!!(window.matchMedia && window.matchMedia("(pointer: fine)").matches)); } catch (e) { /* noop */ }
  }, []);

  // Desktop keyboard flow in a quiz: keep focus in the answer box while
  // answering, then on the "Next question" button after feedback so Enter
  // advances without a mouse.
  useEffect(() => {
    if (screen !== "quiz" || !isDesktop) return;
    const t = setTimeout(() => {
      try {
        if (feedback) { nextRef.current && nextRef.current.focus(); }
        else if (!shieldOffer && answerRef.current) { answerRef.current.focus(); }
      } catch (e) { /* noop */ }
    }, 30);
    return () => clearTimeout(t);
  }, [screen, question, feedback, shieldOffer, isDesktop]);

  // Insert a symbol at the caret in the answer box (for keys not on a
  // phone keyboard).
  function insertSym(sym) {
    const el = answerRef.current;
    if (!el) { setAnswerInput((a) => a + sym); return; }
    const start = el.selectionStart ?? answerInput.length;
    const end = el.selectionEnd ?? answerInput.length;
    setAnswerInput(answerInput.slice(0, start) + sym + answerInput.slice(end));
    requestAnimationFrame(() => {
      try { el.focus(); el.setSelectionRange(start + sym.length, start + sym.length); } catch (e) { /* noop */ }
    });
  }

  useEffect(() => {
    (async () => {
      try {
        const saved = window.localStorage.getItem("mub_theme");
        if (saved === "light" || saved === "dark") setTheme(saved);
        else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
        if (window.localStorage.getItem("mub_sound") === "0") setSoundOn(false);
        const params = new URLSearchParams(window.location.search);
        if (params.get("teacher") === "1") window.localStorage.setItem("mub_teacher", "1");
        if (params.get("teacher") === "0") window.localStorage.removeItem("mub_teacher");
        if (window.localStorage.getItem("mub_teacher") === "1") setTeacherMode(true);
      } catch (e) { /* defaults are fine */ }

      // Parent Link: ?p=<token> shows a read-only view of one student,
      // resolved through a SECURITY DEFINER function (the parent isn't
      // signed in, and RLS hides the row from anonymous queries).
      try {
        const pTok = new URLSearchParams(window.location.search).get("p");
        if (pTok) {
          const pv = await getParentView(pTok);
          setParentView(pv || { __missing: true });
          setScreen("parent");
          setReady(true);
          return;
        }
      } catch (e) { setParentView({ __missing: true }); setScreen("parent"); setReady(true); return; }

      // Restore a persisted Supabase session, if any.
      try {
        const user = await currentUser();
        if (user) {
          setAuthUid(user.id);
          const res = await storage.get("profile");
          if (res && res.value) {
            setProfile(JSON.parse(res.value));
            setScreen("dashboard");
          }
          await loadCustomQuestions(); // shared reads need a session
          refreshFriends();
        }
      } catch (e) { /* not signed in, or no saved profile yet */ }
      setReady(true);
    })();
  }, []);

  // A student who followed a "forgot password" link lands here with a
  // recovery session — send them to the set-a-new-password screen.
  useEffect(() => {
    const off = onPasswordRecovery(() => {
      setScreen("reset");
      setResetPin("");
      setReady(true);
    });
    return off;
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const bg = THEMES[theme]["--page-bg"];
    document.documentElement.style.background = bg;
    document.body.style.background = bg;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);


  // Teacher-only screens are unreachable without the ?teacher=1 unlock.
  useEffect(() => {
    if (!teacherMode && (screen === "admin" || screen === "questions")) {
      setScreen(profile.name ? "dashboard" : "login");
    }
  }, [teacherMode, screen, profile.name]);

  // Roll over the daily tasks at (local) midnight / on a new day, and the
  // weekly-XP bucket on a new week.
  useEffect(() => {
    if (!ready || !profile.name) return;
    const newDay = !profile.daily || profile.daily.date !== todayKey();
    const newWeek = !profile.week || profile.week.of !== weekKey();
    if (newDay || newWeek) {
      const n = JSON.parse(JSON.stringify(profile));
      if (newDay) {
        // "Practice Makes Perfect" — consecutive calendar days opened.
        const yesterday = todayKey(new Date(Date.now() - 86400000));
        n.playStreak = (profile.daily && profile.daily.date === yesterday) ? (n.playStreak || 0) + 1 : 1;
        n.daily = freshDay(n);
      }
      if (newWeek) bumpWeek(n, 0);
      saveProfile(n);
    }
  }, [ready, profile.name, profile.daily && profile.daily.date, profile.week && profile.week.of]);

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  // No repeats within a run of 20: re-roll a question whose prompt+answer
  // matches one of the last 20. Falls back to whatever comes up after a
  // bounded number of tries (small topics may not have 21 distinct Qs).
  const recentQRef = useRef([]);
  function freshQuestion(pick) {
    let q, sig = "";
    for (let i = 0; i < 45; i++) {
      q = pick();
      sig = `${q.prompt}␟${q.answer ?? JSON.stringify(q.answers || q.choices || "")}`;
      if (!recentQRef.current.includes(sig)) break;
    }
    recentQRef.current = [...recentQRef.current, sig].slice(-20);
    return q;
  }

  function claimDailyTask(taskId) {
    const n = JSON.parse(JSON.stringify(profile));
    const d = ensureDay(n);
    if (d.claimed[taskId] || !(d.tasks || []).includes(taskId)) return;
    const task = TASK_BY_ID[taskId];
    if (!task || !taskDone(task, d)) return;
    const before = totalExp(n);
    d.claimed[taskId] = true;
    n.bonusExp = (n.bonusExp || 0) + (taskId === "showup" ? DAILY_XP.showup : DAILY_XP.task);
    const gain = totalExp(n) - before;
    bumpWeek(n, gain);
    const lv = creditLevelUps(n, before);
    saveProfile(n);
    playCoins();
    if (lv) setTimeout(() => playJingle(true), 280);
    flash(`+${gain} XP${lv ? ` · Level ${lv}!` : ""}`);
  }

  function markMilestone(id) {
    if (!profile.name || (profile.milestones || {})[id]) return;
    saveProfile({ ...profile, milestones: { ...(profile.milestones || {}), [id]: "ready" } });
  }
  function claimMilestone(id) {
    if ((profile.milestones || {})[id] !== "ready") return;
    const n = JSON.parse(JSON.stringify(profile));
    const before = totalExp(n);
    n.milestones[id] = "claimed";
    n.bonusExp = (n.bonusExp || 0) + MILESTONE_XP;
    bumpWeek(n, totalExp(n) - before);
    const lv = creditLevelUps(n, before);
    saveProfile(n);
    playCoins();
    if (lv) setTimeout(() => playJingle(true), 280);
    flash(`+${MILESTONE_XP} XP${lv ? ` · Level ${lv}!` : ""}`);
  }

  function toggleTheme() {
    setTheme((prev) => {
      const nextT = prev === "dark" ? "light" : "dark";
      try { window.localStorage.setItem("mub_theme", nextT); } catch (e) { /* ignore */ }
      return nextT;
    });
  }

  function toggleSound() {
    setSoundOn((prev) => {
      const nextS = !prev;
      try { window.localStorage.setItem("mub_sound", nextS ? "1" : "0"); } catch (e) { /* ignore */ }
      return nextS;
    });
  }

  // ---- synthesised sound effects ---------------------------------------
  // All built lazily off the click/keydown that triggered them so the
  // AudioContext is allowed to start. `notes` are [freqHz, ...]; `opts`
  // tunes the feel. gain/volume kept low.
  function playSeq(notes, opts = {}) {
    if (!soundOn) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      let ctx = audioCtxRef.current;
      if (!ctx) { ctx = new AC(); audioCtxRef.current = ctx; }
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const { vol = 0.13, wave = "triangle", step = 0.1, dur = 0.36, attack = 0.02, detune = 0 } = opts;
      const master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
      notes.forEach((freq, i) => {
        const t = now + i * step;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, t);
        if (detune) osc.detune.setValueAtTime(i === notes.length - 1 ? detune : 0, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + attack);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(g); g.connect(master);
        osc.start(t); osc.stop(t + dur + 0.06);
      });
    } catch (e) { /* audio unavailable — no problem */ }
  }

  // Achievement (short) / level-up (long) arpeggios — waveform follows the pack.
  function playJingle(big) {
    playSeq(big ? [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5] : [523.25, 659.25, 783.99, 1046.5], { step: 0.1, dur: 0.36, wave: soundPackOf(profile).wave });
  }

  // Per-answer feedback — rising for correct, mirrored/softer for wrong.
  // Notes + waveform come from the student's chosen sound pack.
  function playCorrect() {
    const p = soundPackOf(profile);
    playSeq(p.correct, { step: 0.075, dur: 0.22, attack: 0.008, vol: 0.12, wave: p.wave });
  }
  function playWrong() {
    const p = soundPackOf(profile);
    playSeq(p.wrong, { step: 0.1, dur: 0.34, attack: 0.015, vol: 0.1, detune: -18, wave: p.wave });
  }

  // Action sounds. Skeleton Key = a low "turn" then a bright reveal;
  // XP Boost = a fast rising sawtooth whoosh; claiming = quick coin blips.
  function playUnlock() {
    playSeq([146.83, 130.81], { wave: "square", step: 0.085, dur: 0.13, attack: 0.004, vol: 0.09 });
    setTimeout(() => playSeq([392, 523.25, 659.25, 880.0], { wave: "triangle", step: 0.07, dur: 0.3, attack: 0.006, vol: 0.11 }), 185);
  }
  function playBoost() {
    playSeq([440, 587.33, 783.99, 1046.5, 1396.91], { wave: "sawtooth", step: 0.045, dur: 0.16, attack: 0.004, vol: 0.085, detune: 14 });
  }
  function previewPack(id) {
    const p = SOUND_PACK_DATA[id] || SOUND_PACK_DATA.default;
    playSeq(p.correct, { step: 0.075, dur: 0.22, attack: 0.008, vol: 0.12, wave: p.wave });
  }
  function playCoins() {
    playSeq([1046.5, 1396.91, 1046.5, 1567.98, 2093.0], { wave: "square", step: 0.055, dur: 0.11, attack: 0.003, vol: 0.08 });
  }

  async function loadCustomQuestions() {
    try {
      const listRes = await storage.list("questions_", true);
      const keys = (listRes && listRes.keys) || [];
      const map = {};
      for (const k of keys) {
        try {
          const r = await storage.get(k, true);
          if (r && r.value) map[k.replace("questions_", "")] = JSON.parse(r.value);
        } catch (e) { /* skip unreadable entry */ }
      }
      setCustomQuestions(map);
    } catch (e) { /* keep whatever was already loaded */ }
  }

  async function saveCustomQuestions(topicId, arr) {
    const next = { ...customQuestions, [topicId]: arr };
    setCustomQuestions(next);
    try { await storage.set(`questions_${topicId}`, JSON.stringify(arr), true); } catch (e) { /* ignore */ }
  }

  // Mixes in custom (admin-written) questions alongside the procedural
  // generator — roughly half the time, if any exist for this topic.
  function pickQuestion(topic) {
    const bank = customQuestions[topic.id] || [];
    let q;
    if (bank.length && Math.random() < 0.5) {
      const c = bank[randInt(0, bank.length - 1)];
      q = { prompt: c.prompt, answer: c.answer, hint: c.hint || "Enter your answer.", steps: c.steps && c.steps.length ? c.steps : ["Check your working carefully."] };
    } else {
      q = topic.generate();
    }
    return { ...q, topicId: topic.id, topicName: topic.name, topicIcon: topic.icon };
  }

  // Mixed Review: a random question from any topic the student has unlocked.
  function pickMixed() {
    const pool = TOPICS.filter((t) => isUnlocked(t, profile));
    const topic = pool[randInt(0, Math.max(0, pool.length - 1))] || TOPICS[0];
    return pickQuestion(topic);
  }

  function startMixed() {
    if (levelFromExp(totalExp(profile)) < MIXED_UNLOCK_LEVEL) return;
    recentQRef.current = [];
    setActiveTopic(MIXED_TOPIC);
    setQuestion(freshQuestion(pickMixed));
    setAnswerInput(""); setWritePad(false);
    setMultiInput({});
    setDrawPts([]);
    setRegionPick(null);
    setCfPick([]);
    setVennPressed([]);
    setVennPlace({});
    setMcPick(null);
    setDrawTri([]);
    setSketchStrokes([]);
    setSketchOn(false);
    setHintShown(false);
    setShieldOffer(false);
    setShieldDeclined(false);
    setFeedback(null);
    startTimeRef.current = Date.now();
    setScreen("quiz");
  }

  // ---- Blitz ----
  function startBlitz() {
    if (levelFromExp(totalExp(profile)) < BLITZ_UNLOCK_LEVEL) return;
    challengeRef.current = null;
    setChallengeResult(null);
    setBlitzPhase("intro");
    setBlitzResult(null);
    setScreen("blitz");
  }
  // Challenge a friend: I play first, my questions + score seed the row.
  function startChallenge(friend) {
    if (!friend || !friend.uid) return;
    if (levelFromExp(totalExp(profile)) < BLITZ_UNLOCK_LEVEL) return;
    const questions = Array.from({ length: 40 }, () => blitzQuestion());
    challengeRef.current = {
      mode: "create", id: null, opponentUid: friend.uid,
      opponentName: friend.name || "Friend", opponentScore: null, questions, idx: 0,
    };
    setChallengeResult(null);
    setBlitzResult(null);
    setBlitzPhase("intro");
    setScreen("blitz");
  }
  // Answer a challenge someone sent me: replay their exact question set.
  function playChallenge(row) {
    if (!row || !Array.isArray(row.questions)) return;
    const opp = friendPeople[row.a] || {};
    challengeRef.current = {
      mode: "play", id: row.id, opponentUid: row.a,
      opponentName: opp.name || "Friend", opponentScore: row.score_a ?? 0,
      questions: row.questions, idx: 0,
    };
    setChallengeResult(null);
    setBlitzResult(null);
    setBlitzPhase("intro");
    setScreen("blitz");
  }
  function beginBlitzRun() {
    blitzCorrect.current = 0;
    blitzDone.current = false;
    blitzDeadline.current = Date.now() + BLITZ_SECONDS * 1000;
    setBlitzScore(0);
    setBlitzLeft(BLITZ_SECONDS);
    setBlitzPick(null);
    setChallengeResult(null);
    const ch = challengeRef.current;
    if (ch) { ch.idx = 0; setBlitzQ(ch.questions[0]); }
    else setBlitzQ(blitzQuestion());
    setBlitzPhase("playing");
  }
  function nextBlitzQ() {
    clearTimeout(blitzAdvance.current);
    setBlitzPick(null);
    const ch = challengeRef.current;
    if (ch) {
      ch.idx += 1;
      if (ch.idx >= ch.questions.length) { finishBlitz(); return; }
      setBlitzQ(ch.questions[ch.idx]);
    } else {
      setBlitzQ(blitzQuestion());
    }
  }
  function scoreBlitz(isCorrect) {
    if (isCorrect) { blitzCorrect.current += 1; setBlitzScore((s) => s + 1); playCorrect(); }
    else playWrong();
    blitzAdvance.current = setTimeout(() => { if (Date.now() < blitzDeadline.current) nextBlitzQ(); }, 340);
  }
  function answerBlitz(value) {
    if (blitzPick || blitzPhase !== "playing" || !blitzQ) return;
    const ok = value === blitzQ.answer;
    setBlitzPick({ value, correct: ok });
    scoreBlitz(ok);
  }
  function answerBlitzVenn(key) {
    if (blitzPick || blitzPhase !== "playing" || !blitzQ || !blitzQ.venn) return;
    const ok = key === blitzQ.venn.target[0];
    setBlitzPick({ value: key, correct: ok });
    scoreBlitz(ok);
  }
  function finishBlitz() {
    clearTimeout(blitzAdvance.current);
    if (blitzDone.current) return;
    blitzDone.current = true;
    setBlitzPhase("over");
    const n = JSON.parse(JSON.stringify(profileRef.current));
    const sc = blitzCorrect.current;
    const newBest = sc > (n.blitzBest || 0);
    if (newBest) n.blitzBest = sc;
    const before = totalExp(n);
    if (sc > 0) {
      const perks = (n.perks || []).filter((p) => PERKS[p]);
      let units = sc;
      if (perks.includes("momentum")) units += Math.floor(sc / 5); // every 5th doubled
      const gain = units * CORRECT_XP * ((n.boostUntil || 0) > Date.now() ? 2 : 1);
      n.bonusExp = (n.bonusExp || 0) + gain;
      bumpWeek(n, gain);
    }
    creditLevelUps(n, before);
    const unlocked = awardAchievements(n);
    setBlitzResult({ score: sc, best: n.blitzBest || 0, newBest, unlocked });
    if (unlocked.length) playJingle(true);
    saveProfile(n);
    if (challengeRef.current) {
      const ch = challengeRef.current;
      setChallengeBusy(true);
      setChallengeResult({ mode: ch.mode, opponentName: ch.opponentName, myScore: sc, opponentScore: ch.opponentScore ?? null });
      finalizeChallenge(sc);
    }
  }
  // Push my challenge score to Supabase after the run ends.
  async function finalizeChallenge(sc) {
    const ch = challengeRef.current;
    if (!ch) return;
    setChallengeBusy(true);
    try {
      if (ch.mode === "create") {
        const res = await createBlitzChallenge(ch.opponentUid, ch.questions, sc);
        if (res && res.challenge) ch.id = res.challenge.id;
        setChallengeResult({ mode: "create", opponentName: ch.opponentName, myScore: sc, opponentScore: null });
      } else {
        await submitBlitzChallengeScore(ch.id, sc);
        setChallengeResult({ mode: "play", opponentName: ch.opponentName, myScore: sc, opponentScore: ch.opponentScore ?? 0 });
      }
      refreshBlitzChallenges();
    } catch (e) {
      setChallengeResult({ mode: ch.mode, opponentName: ch.opponentName, myScore: sc, opponentScore: ch.opponentScore ?? null, failed: true });
    }
    setChallengeBusy(false);
  }
  async function refreshBlitzChallenges() {
    try { setBlitzChallenges(await loadBlitzChallenges()); } catch (e) { /* offline */ }
  }
  function leaveBlitz() {
    if (!blitzDone.current && blitzPhase === "playing") finishBlitz();
    clearTimeout(blitzAdvance.current);
    const wasChallenge = !!challengeRef.current;
    challengeRef.current = null;
    setChallengeResult(null);
    setBlitzPhase("idle");
    if (wasChallenge) openFriends();
    else setScreen("dashboard");
  }

  // Keep the XP-Boost countdown fresh while one is running.
  useEffect(() => {
    if ((profile.boostUntil || 0) <= Date.now()) return;
    const iv = setInterval(() => setClockTick((t) => t + 1), 20000);
    return () => clearInterval(iv);
  }, [profile.boostUntil]);

  // Blitz countdown — one interval while a run is live.
  useEffect(() => {
    if (blitzPhase !== "playing") return;
    const iv = setInterval(() => {
      const rem = blitzDeadline.current - Date.now();
      if (rem <= 0) { clearInterval(iv); finishBlitz(); }
      else setBlitzLeft(Math.ceil(rem / 1000));
    }, 200);
    return () => clearInterval(iv);
  }, [blitzPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  async function persistProfile(next) {
    // One row now: scope = the student's auth uid, key = "profile".
    // The leaderboard and parent-link reads go through RPCs that read
    // every profile server-side, so there's nothing to fan out here.
    try { await storage.set("profile", JSON.stringify(next)); } catch (e) { /* ignore */ }
  }
  async function saveProfile(next) {
    if (next.name && !next.parentToken) next.parentToken = genToken();
    setProfile(next);
    await persistProfile(next);
  }

  // Merge a small patch into the profile against its freshest value — safe
  // when several taps land before a re-render (profile-card customiser).
  function patchProfile(fn) {
    setProfile((prev) => {
      const next = { ...prev, ...fn(prev) };
      if (next.name && !next.parentToken) next.parentToken = genToken();
      profileRef.current = next;
      persistProfile(next);
      return next;
    });
  }

  // Login by name + 6-digit PIN, backed by a real Supabase Auth account
  // (email "<slug>.<pin>@students.mathsunlockedbn.app", password derived
  // from name + PIN). An existing name+PIN signs in and resumes that
  // student's saved progress; a new one creates the account and a fresh
  // profile with the chosen school.
  async function startSession() {
    if (starting) return;
    const nm = nameInput.trim();
    const pin = pinInput.trim();
    if (!nm) { setStartError("Enter your name."); return; }
    if (!/^\d{6}$/.test(pin)) { setStartError("Your PIN must be exactly 6 digits."); return; }
    setStartError("");
    setStarting(true);
    try {
      const { user, created } = await signInOrRegister(nm, pin);
      setAuthUid(user.id);

      let prof = null;
      if (!created) {
        try {
          const r = await storage.get("profile");
          if (r && r.value) prof = JSON.parse(r.value);
        } catch (e) { /* account exists but no saved profile yet */ }
      }
      if (prof) {
        prof.name = prof.name || nm;
        prof.pin = pin;
        if (!prof.school) prof.school = schoolInput;
        if (!prof.achievedAt) prof.achievedAt = {};
      } else {
        prof = emptyProfile();
        prof.name = nm;
        prof.pin = pin;
        prof.school = schoolInput;
        prof.createdAt = Date.now();
      }
      // Seed "seen" icons so the new-unlock dots only flag genuinely new ones.
      if (!Array.isArray(prof.seenIcons)) prof.seenIcons = unlockedAvatarIds(prof);
      await saveProfile(prof);
      loadCustomQuestions(); // shared reads need a session
      refreshFriends();
      setScreen("dashboard");
    } catch (e) {
      setStartError(e && e.message ? e.message : "Could not sign in. Try again.");
    }
    setStarting(false);
  }

  // "Forgot your PIN?" — email a reset link to the student's recovery
  // address. They don't have to be right about which account; Supabase
  // only sends if the address is on file.
  async function submitForgotPin() {
    const em = forgotEmail.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setForgotMsg({ ok: false, text: "Enter the email you added for recovery." }); return; }
    setForgotMsg({ ok: null, text: "Sending…" });
    try {
      await sendPinReset(em);
      setForgotMsg({ ok: true, text: `If ${em} is on a MathsUnlocked account, a reset link is on its way. Open it on this device.` });
    } catch (e) {
      setForgotMsg({ ok: false, text: e && e.message ? e.message : "Couldn't send the email." });
    }
  }

  // Reset screen: the student arrived via the link (they have a recovery
  // session) and picks a new 6-digit PIN.
  async function submitNewPin() {
    if (resetBusy) return;
    if (!/^\d{6}$/.test(resetPin)) { flash("Enter a new 6-digit PIN."); return; }
    setResetBusy(true);
    try {
      const user = await currentUser();
      const nm = (user && user.user_metadata && user.user_metadata.display_name) || profile.name || nameInput.trim();
      if (!nm) throw new Error("Couldn't tell which account this is — sign in with your name + old PIN once, then try recovery again.");
      await completePinReset(nm, resetPin);
      if (user) {
        setAuthUid(user.id);
        try {
          const r = await storage.get("profile");
          if (r && r.value) { const p = JSON.parse(r.value); p.pin = resetPin; setProfile(p); }
        } catch (e) { /* ignore */ }
        await loadCustomQuestions();
      }
      flash("New PIN set — you're signed in.");
      setScreen("dashboard");
    } catch (e) {
      flash(e && e.message ? e.message : "Couldn't set the new PIN.");
    }
    setResetBusy(false);
  }

  // A signed-in student changes their own PIN.
  async function submitChangePin() {
    if (changePinBusy) return;
    if (!/^\d{6}$/.test(pin1)) { setChangePinMsg({ ok: false, text: "Enter a 6-digit PIN." }); return; }
    if (pin1 !== pin2) { setChangePinMsg({ ok: false, text: "The two PINs don't match." }); return; }
    if (pin1 === profile.pin) { setChangePinMsg({ ok: false, text: "That's already your PIN." }); return; }
    setChangePinBusy(true);
    setChangePinMsg(null);
    try {
      await changePin(profile.name, pin1);
      const next = { ...profile, pin: pin1 };
      setProfile(next);
      await persistProfile(next);
      setChangePinMsg({ ok: true, text: "Done. Use your new PIN next time you log in." });
      setPin1(""); setPin2("");
    } catch (e) {
      setChangePinMsg({ ok: false, text: e && e.message ? e.message : "Couldn't change the PIN." });
    }
    setChangePinBusy(false);
  }

  // "Add PIN recovery" — attach an email (only). Password is untouched, so
  // name + PIN keeps working. Supabase emails a confirmation link.
  async function submitRecoveryEmail() {
    if (recBusy) return;
    const em = recEmail.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setRecMsg({ ok: false, text: "That doesn't look like an email address." }); return; }
    setRecBusy(true);
    setRecMsg(null);
    try {
      await addRecoveryEmail(profile.name, profile.pin, em);
      setRecMsg({ ok: true, text: `Check ${em} and click the link to confirm it. Your name + PIN keeps working — this is only used if you forget your PIN.` });
      saveProfile({ ...profile, recoveryEmail: em });
      setRecEmail("");
    } catch (e) {
      setRecMsg({ ok: false, text: e && e.message ? e.message : "Couldn't save that." });
    }
    setRecBusy(false);
  }

  // Non-destructive: signs out of Supabase so the login screen shows.
  // The student's progress stays saved in their own row and resumes when
  // they sign back in with the same name + PIN.
  async function switchStudent() {
    await signOut();
    setAuthUid(null);
    setProfile(emptyProfile());
    setActiveTopic(null);
    setScreen("login");
    setNameInput("");
    setPinInput("");
    setStartError("");
    setForgotOpen(false);
    setForgotEmail("");
    setForgotMsg(null);
    setSchoolInput(SOLO_SCHOOL);
    setSchoolQuery("");
  }

  function setSchoolAndClose(s) {
    saveProfile({ ...profile, school: s });
    setShowSchool(false);
    setSchoolEditQuery("");
  }

  /* Teacher/dev shortcuts (only reachable with ?teacher=1) for testing
     level, prestige and Skeleton Key behaviour without grinding. */
  const S_PLUS_IDX = RANK_ORDER.length - 1;
  const C_IDX = RANK_ORDER.indexOf("C");
  function devApplyRank(next, topicIds, rankIdx) {
    const hist = rankIdx >= S_PLUS_IDX ? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] : [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    topicIds.forEach((id) => {
      const prevRank = (next.topics[id] || {}).highestRank ?? -1;
      next.topics[id] = { history: hist, highestRank: Math.max(prevRank, rankIdx), streak: rankIdx >= S_PLUS_IDX ? STREAK_FOR_S_PLUS : 0 };
    });
    awardAchievements(next);
    next.levelReachedAt = next.levelReachedAt || {};
    const lvl = levelFromExp(totalExp(next));
    for (let L = 2; L <= lvl; L++) if (!next.levelReachedAt[L]) next.levelReachedAt[L] = Date.now();
  }
  function devMaxTopic() {
    const next = JSON.parse(JSON.stringify(profile));
    devApplyRank(next, [devTopic], S_PLUS_IDX);
    saveProfile(next);
  }
  function devMaxAll() {
    const next = JSON.parse(JSON.stringify(profile));
    devApplyRank(next, TOPICS.map((t) => t.id), S_PLUS_IDX);
    next.keys = Math.max(next.keys || 0, 4); // as if the 5/10/15/20 milestones were hit
    saveProfile(next);
  }
  function devCAll() {
    const next = JSON.parse(JSON.stringify(profile));
    devApplyRank(next, TOPICS.map((t) => t.id), C_IDX);
    saveProfile(next);
  }
  function devAddKeys(n) {
    saveProfile({ ...profile, keys: (profile.keys || 0) + n });
  }
  // Spend one ×2 XP Boost — starts a 1-hour window of double correct-answer XP.
  function activateBoost() {
    if ((profile.boosts || 0) <= 0) return;
    if ((profile.boostUntil || 0) > Date.now()) return; // one at a time
    saveProfile({ ...profile, boosts: profile.boosts - 1, boostUntil: Date.now() + 3600 * 1000 });
    playBoost();
  }
  function devHardReset() {
    if (typeof window !== "undefined" && !window.confirm("Reset this account to a blank Level 1 / Prestige 0? Progress, prestige, Skeleton Keys and achievements are all wiped. Name, school and PIN are kept.")) return;
    const { name, school, pin, parentToken, createdAt } = profile;
    saveProfile({ ...emptyProfile(), name, school, pin, parentToken, createdAt: createdAt || Date.now() });
    setActiveTopic(null);
    setScreen("dashboard");
  }

  function startTopic(topic) {
    if (!isUnlocked(topic, profile)) return;
    recentQRef.current = [];
    setActiveTopic(topic);
    // Caught dodging before ("Nice Try") — a topic left unanswered follows
    // you back in instead of re-rolling, so ducking out no longer works.
    const stuck = profile.dodgeLocked && profile.dodgeStuck && profile.dodgeStuck[topic.id];
    setQuestion(stuck || freshQuestion(() => pickQuestion(topic)));
    setAnswerInput(""); setWritePad(false);
    setMultiInput({});
    setDrawPts([]);
    setRegionPick(null);
    setCfPick([]);
    setVennPressed([]);
    setVennPlace({});
    setMcPick(null);
    setDrawTri([]);
    setSketchStrokes([]);
    setSketchOn(false);
    setHintShown(false);
    setShieldOffer(false);
    setShieldDeclined(false);
    setFeedback(null);
    startTimeRef.current = Date.now();
    setScreen("quiz");
  }

  // "back to topics" while a question sits unanswered — leaving and
  // re-entering a topic normally re-rolls a fresh question, which is easy
  // to abuse to dodge anything that isn't easy. Track it for "Nice Try";
  // once that's been caught, remember the exact question so it follows
  // the student back in instead of re-rolling (see startTopic).
  function leaveQuizUnanswered() {
    if (!feedback && activeTopic && question) {
      const tid = activeTopic.id;
      const next = JSON.parse(JSON.stringify(profile));
      next.dodgeCount = next.dodgeTopic === tid ? (next.dodgeCount || 0) + 1 : 1;
      next.dodgeTopic = tid;
      if (next.dodgeLocked) next.dodgeStuck = { ...(next.dodgeStuck || {}), [tid]: question };
      saveProfile(next);
    }
    setScreen("dashboard");
  }

  function nextQuestion() {
    setQuestion(freshQuestion(() => activeTopic.id === MIXED_TOPIC.id ? pickMixed() : pickQuestion(activeTopic)));
    setAnswerInput(""); setWritePad(false);
    setMultiInput({});
    setDrawPts([]);
    setRegionPick(null);
    setCfPick([]);
    setVennPressed([]);
    setVennPlace({});
    setMcPick(null);
    setDrawTri([]);
    setSketchStrokes([]);
    setSketchOn(false);
    setHintShown(false);
    setShieldOffer(false);
    setShieldDeclined(false);
    setFeedback(null);
    startTimeRef.current = Date.now();
  }

  // Equip / unequip a perk (max 2). Ignores locked perks.
  function togglePerk(id) {
    const p = PERKS[id];
    if (!p || levelFromExp(totalExp(profile)) < p.lv) return;
    patchProfile((prev) => {
      const cur = (prev.perks || []).filter((x) => PERKS[x]);
      if (cur.includes(id)) return { perks: cur.filter((x) => x !== id) };
      if (cur.length >= 2) return {};
      return { perks: [...cur, id] };
    });
  }

  // Spend a Streak Shield: the wrong answer is wiped, streak stays, retry.
  function useShield() {
    if (!shieldOffer || (profile.shields || 0) <= 0) return;
    patchProfile((p) => ({ shields: Math.max(0, (p.shields || 0) - 1) }));
    setShieldOffer(false);
    setAnswerInput("");
    setMultiInput({});
    setDrawPts([]); setRegionPick(null); setCfPick([]); setVennPressed([]); setVennPlace({}); setMcPick(null); setDrawTri([]);
    startTimeRef.current = Date.now();
    if (isDesktop) setTimeout(() => { try { answerRef.current && answerRef.current.focus(); } catch (e) { /* noop */ } }, 0);
    flash("🛟 Streak Shield used — your streak is safe. Try again.");
  }
  // Decline the shield: commit the wrong answer normally.
  function declineShield() {
    setShieldOffer(false);
    setShieldDeclined(true);
    setTimeout(() => submitAnswer(), 0);
  }

  // Spend a Hint coin to reveal the first working step for this question.
  function doHint() {
    if (hintShown || feedback || !question) return;
    if (!(question.steps && question.steps.length > 0)) { flash("No hint for this one."); return; }
    if ((profile.hints || 0) <= 0) { flash("No Hint coins — you get one every level up."); return; }
    const next = JSON.parse(JSON.stringify(profile));
    next.hints = Math.max(0, (next.hints || 0) - 1);
    next.usedHint = true; // "Every Puzzle Has an Answer"
    const unlocked = awardAchievements(next);
    setHintShown(true);
    saveProfile(next);
    if (unlocked.length) playJingle(true);
  }

  // "Draw the graph" questions: tap lattice points, keep the last two, FIFO.
  function toggleDrawPoint(pt) {
    if (feedback) return;
    setDrawPts((cur) => {
      const i = cur.findIndex(([x, y]) => x === pt[0] && y === pt[1]);
      if (i >= 0) return cur.filter((_, k) => k !== i);   // tap again to remove
      if (cur.length < 2) return [...cur, pt];
      return [cur[1], pt];                                // 3rd tap replaces the oldest
    });
  }

  // "Shade the region" questions: tap a half-plane (rejected if too near the line).
  function pickRegion(x, y) {
    if (feedback || !question.region) return;
    if (regionDist(question.region, x, y) < 0.35) { flash("Tap clearly on one side of the line."); return; }
    setRegionPick([x, y]);
  }

  // Drop a reading-guide on the cumulative-frequency graph; keep the last two.
  function pickCf(g) {
    if (feedback) return;
    setCfPick((cur) => {
      const i = cur.findIndex((p) => p.axis === g.axis && Math.abs(p.v - g.v) < 1e-9);
      if (i >= 0) return cur.filter((_, k) => k !== i);
      return [...cur, g].slice(-2);
    });
  }

  function toggleVenn(key) {
    if (feedback) return;
    setVennPressed((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }

  // Drop a number onto a Venn region (region === null puts it back in the tray).
  function placeVennEl(el, region) {
    if (feedback) return;
    setVennPlace((prev) => {
      if (region == null) { const n = { ...prev }; delete n[el]; return n; }
      return { ...prev, [el]: region };
    });
  }

  // "Draw the image" transformation questions: tap 3 lattice points for the
  // image triangle; a 4th tap drops the oldest vertex (rolling buffer of 3).
  function toggleTriPoint(pt) {
    if (feedback) return;
    setDrawTri((cur) => {
      const i = cur.findIndex(([x, y]) => x === pt[0] && y === pt[1]);
      if (i >= 0) return cur.filter((_, k) => k !== i); // tap again to remove
      if (cur.length < 3) return [...cur, pt];
      return [cur[1], cur[2], pt];
    });
  }

  function submitAnswer(override) {
    if (feedback) return;
    const typed = typeof override === "string" ? override : answerInput;
    let correct;
    if (question.venn) {
      if (vennPressed.length === 0) return;
      const t = question.venn.target;
      correct = vennPressed.length === t.length && vennPressed.every((k) => t.includes(k));
    } else if (question.placeVenn) {
      const need = question.placeVenn.universe;
      if (need.some((el) => !vennPlace[el])) return; // every number must be placed first
      correct = need.every((el) => vennPlace[el] === question.placeVenn.correct[el]);
    } else if (question.region) {
      if (!regionPick) return;
      correct = regionSideCorrect(question.region, regionPick[0], regionPick[1]);
    } else if (question.choices) {
      if (!mcPick) return;
      correct = mcPick === question.answer;
    } else if (question.drawMirror) {
      if (drawPts.length !== 2) return;
      if (drawPts[0][0] === drawPts[1][0] && drawPts[0][1] === drawPts[1][1]) return;
      const mm = question.drawMirror;
      const onL = (p) => mm.kind === "x" ? p[0] === mm.k : mm.kind === "y" ? p[1] === mm.k : mm.kind === "yx" ? p[0] === p[1] : p[0] === -p[1];
      correct = drawPts.every(onL);
    } else if (question.drawTransform) {
      if (drawTri.length !== 3) return;
      const tgt = question.drawTransform.image;
      correct = tgt.every((v) => drawTri.some((p) => p[0] === v[0] && p[1] === v[1]));
    } else if (question.drawSolve) {
      if (drawPts.length < 2) return;
      if (question.fields.some((f) => !(multiInput[f.key] || "").trim())) return;
      correct = !!question.drawSolve(drawPts, multiInput);
    } else if (question.drawGraph) {
      if (drawPts.length < 2) return;
      const [[x1, y1], [x2, y2]] = drawPts;
      if (x1 === x2) correct = false; // a vertical line is never y = mx + c
      else {
        const m = (y2 - y1) / (x2 - x1), c = y1 - m * x1;
        correct = Math.abs(m - question.drawGraph.m) < 1e-9 && Math.abs(c - question.drawGraph.c) < 1e-9;
      }
    } else if (question.fields) {
      if (question.fields.some((f) => !(multiInput[f.key] || "").trim())) return; // all cells required
      correct = question.check
        ? !!question.check(multiInput)
        : question.fields.every((f) => checkEquivalent(multiInput[f.key], question.answers[f.key]));
    } else {
      if (!typed.trim()) return;
      correct = question.check ? !!question.check(typed) : checkEquivalent(typed, question.answer);
    }
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    const expBefore = totalExp(profile);
    const scoredId = question.topicId || activeTopic.id; // Mixed Review scores the source topic
    const rankBefore = ((profile.topics || {})[scoredId] || {}).highestRank ?? -1;
    const next = JSON.parse(JSON.stringify(profile));
    const d = ensureDay(next);
    const perks = (profile.perks || []).filter((p) => PERKS[p]);

    // Wrong, holding a Streak Shield, and the Error Correction perk didn't
    // already cover it — pause and offer to spend the shield before the
    // streak breaks. Nothing is committed yet; they retry the same question.
    const forgiveCovers = perks.includes("forgive") && !(d.forgiven || []).includes(scoredId);
    if (!correct && !forgiveCovers && !shieldDeclined && (profile.shields || 0) > 0 && (profile.streak || 0) > 0) {
      setShieldOffer(true);
      return;
    }

    // Error Correction perk: the first wrong answer in each topic per day
    // is forgiven — streak, topic history and consec-wrong stay untouched.
    const forgiven = !correct && perks.includes("forgive") && !(d.forgiven || []).includes(scoredId);
    if (forgiven) d.forgiven = [...(d.forgiven || []), scoredId];

    const t = next.topics[scoredId] || { history: [], highestRank: -1, streak: 0 };
    if (!forgiven) {
      t.history = [...t.history, correct ? 1 : 0].slice(-10);
      t.streak = correct ? (t.streak || 0) + 1 : 0;
    }
    let candidateIdx = rankIndexForAvg(avgFromHistory(t.history));
    if (t.streak >= STREAK_FOR_S_PLUS) candidateIdx = Math.max(candidateIdx, RANK_ORDER.indexOf("S+"));
    t.highestRank = Math.max(t.highestRank ?? -1, candidateIdx); // ratchet: never decreases
    next.topics[scoredId] = t;
    const rankedUp = t.highestRank > rankBefore
      ? { to: RANK_ORDER[t.highestRank], topic: question.topicName || activeTopic.name }
      : null;

    const nowHour = new Date().getHours();
    if (nowHour >= 0 && nowHour < 4) next.nightOwl = true; // "Night Owl" — any answer, 12am–4am

    // Daily-task progress
    if (!(d.topics || []).includes(scoredId)) d.topics = [...(d.topics || []), scoredId];
    if (activeTopic.id === MIXED_TOPIC.id) {
      d.mixedRounds = Math.max(d.mixedRounds || 0, 1);
      if (!forgiven) {
        next.mixedStreak = correct ? (next.mixedStreak || 0) + 1 : 0;      // "Jack of All Trades"
        next.bestMixedStreak = Math.max(next.bestMixedStreak || 0, next.mixedStreak);
      }
    }

    if (correct) {
      next.streak = (next.streak || 0) + 1;
      next.bestStreak = Math.max(next.bestStreak || 0, next.streak);
      next.totalCorrect = (next.totalCorrect || 0) + 1;
      if (elapsed < 8) next.fastCorrect = (next.fastCorrect || 0) + 1;
      if (elapsed < 60) next.minuteCorrect = (next.minuteCorrect || 0) + 1;
      if ((next.consecWrong || 0) >= 3) next.comeback = true; // "Comeback Kid"
      next.consecWrong = 0;
      if (scoredId === "surds") next.solvedSurd = true; // "Root of the Problem"
      if (String(question.answer).trim() === "67") next.got67 = true; // "67"
      if ((next.streak || 0) >= 67) next.got67 = true;                 // …or a 67-long correct streak (secret)
      d.correct = (d.correct || 0) + 1;
      d.streakToday = (d.streakToday || 0) + 1;
      d.bestStreakToday = Math.max(d.bestStreakToday || 0, d.streakToday);
      if (scoredId === d.weakTopicId) d.weakCorrect = (d.weakCorrect || 0) + 1;
      // XP for a correct answer. Base is doubled by a ×2 Boost and, with
      // Momentum, on every 5th answer in a row. Compound Interest adds more
      // the longer the streak; Quick Study rewards a sub-8-second answer.
      const boosted = (profile.boostUntil || 0) > Date.now();
      let base = CORRECT_XP;
      if (perks.includes("momentum") && (next.streak || 0) % 5 === 0) base *= 2;
      if (boosted) base *= 2;
      let gain = base;
      if (perks.includes("compound")) gain += Math.min(6, Math.floor((next.streak || 0) / 4));
      if (perks.includes("quick") && elapsed < 8) gain += 2;
      next.bonusExp = (next.bonusExp || 0) + gain;
    } else if (!forgiven) {
      next.streak = 0;
      next.consecWrong = (next.consecWrong || 0) + 1;
      d.streakToday = 0;
    }
    const expAfter = totalExp(next);
    const expGain = expAfter - expBefore;
    bumpWeek(next, expGain); // feed the weekly school leaderboard
    const leveledTo = creditLevelUps(next, expBefore);
    const keysWon = (next.keys || 0) - (profile.keys || 0);
    const boostsWon = (next.boosts || 0) - (profile.boosts || 0);
    const xpDoubled = (profile.boostUntil || 0) > Date.now();

    if (correct && scoredId === "circles") next.gotCircle = true; // "What Goes Around Comes Around"

    // "Nice Try" — back out of a topic 3+ times without answering (see
    // leaveQuizUnanswered), then actually answer one correctly in it.
    // A stuck question they'd dodged is now resolved either way.
    if (next.dodgeStuck && next.dodgeStuck[scoredId] !== undefined) {
      const rest = { ...next.dodgeStuck };
      delete rest[scoredId];
      next.dodgeStuck = rest;
    }
    if (correct && next.dodgeTopic === scoredId && (next.dodgeCount || 0) >= 3 && !next.dodgeCaught) {
      next.dodgeCaught = true;
      next.dodgeLocked = true; // caught once — dodging no longer re-rolls the question, ever
    }
    if (next.dodgeTopic === scoredId) { next.dodgeTopic = null; next.dodgeCount = 0; }

    const unlocked = awardAchievements(next);
    const bonusSound = unlocked.length > 0 || leveledTo;
    if (bonusSound) playJingle(!!leveledTo);
    else if (correct) playCorrect();
    if (!correct) playWrong();
    setFeedback({ correct, forgiven, unlocked, expGain, leveledTo, keysWon, boostsWon, xpDoubled, rankedUp });
    saveProfile(next);
  }

  function doPrestige() {
    const cur = JSON.parse(JSON.stringify(profile));
    if ((cur.prestige || 0) >= PRESTIGE_CAP) return;
    if (levelFromExp(totalExp(cur)) < LEVEL_CAP) return;
    if (!allTopicsRankAtLeast(cur, TOPICS, "C")) return; // must be at least C in every topic
    cur.prestige = (cur.prestige || 0) + 1;
    cur.prestigeAt = [...(cur.prestigeAt || []), Date.now()];
    cur.topics = {};            // grades wiped
    cur.bonusExp = 0;           // level resets to 1 — the invisible XP pool goes too
    cur.streak = 0;
    cur.consecWrong = 0;
    cur.levelReachedAt = {};
    // kept: achievements, achievedAt, lifetime counters, keys, keyedTopics,
    //       name, school, and the daily tasks (prestige doesn't touch the
    //       engagement loop)
    setConfirmPrestige(false);
    setActiveTopic(null);
    setScreen("dashboard");
    playJingle(true);
    saveProfile(cur);
  }

  function useKeyOn(topic) {
    const cur = JSON.parse(JSON.stringify(profile));
    if ((cur.keys || 0) < 1) return;
    if ((cur.keyedTopics || []).includes(topic.id)) return;
    cur.keys -= 1;
    cur.keyedTopics = [...(cur.keyedTopics || []), topic.id]; // "Your Guiding Key"
    if (!(cur.milestones || {}).usekey) cur.milestones = { ...(cur.milestones || {}), usekey: "ready" };
    const unlocked = awardAchievements(cur);
    setKeyTarget(null);
    saveProfile(cur);
    if (unlocked.length) playJingle(true);
    else playUnlock();
  }

  async function loadStudents() {
    setAdminLoading(true);
    try {
      const results = await getLeaderboard();
      results.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setStudents(results);
    } catch (e) { setStudents([]); }
    setAdminLoading(false);
  }

  function openAdmin() {
    setScreen("admin");
    loadStudents();
  }

  async function doPinReset(uid) {
    if (pinResetBusy) return;
    if (!/^\d{6}$/.test(pinResetVal)) { setPinResetMsg({ uid, ok: false, text: "Enter a 6-digit PIN." }); return; }
    setPinResetBusy(true);
    setPinResetMsg(null);
    try {
      const res = await teacherResetPin(uid, pinResetVal);
      setPinResetMsg({ uid, ok: true, text: `Done. ${res.name || "This student"} now logs in with PIN ${res.newPin || pinResetVal}. Tell them in person.` });
      setPinResetVal("");
      setPinResetFor(null);
    } catch (e) {
      setPinResetMsg({ uid, ok: false, text: e && e.message ? e.message : "Couldn't reset the PIN." });
    }
    setPinResetBusy(false);
  }

  function openLeaderboard() {
    setScreen("leaderboard");
    setOpenSchool(null);
    setRosterProfile(null);
    loadBoard();
    refreshFriends(); // so the Friends tab has fresh data too
    markMilestone("leaderboard");
  }

  function openFriends() {
    setFriendView(null);
    setFriendFind(false);
    setFriendResults(null);
    setFriendQuery("");
    setScreen("friends");
    refreshFriends();
  }

  // Leaving the Friends screen clears the "new friend" dots.
  const prevScreenRef = useRef("login");
  useEffect(() => {
    if (prevScreenRef.current === "friends" && screen !== "friends") {
      const seenF = friendGraph.friends;
      const doneCh = blitzChallenges
        .filter((c) => c.score_a != null && c.score_b != null)
        .map((c) => c.id);
      const patch = {};
      if (seenF.some((u) => !(profileRef.current.seenFriends || []).includes(u))) patch.seenFriends = seenF;
      if (doneCh.some((id) => !(profileRef.current.seenChallenges || []).includes(id))) {
        patch.seenChallenges = [...new Set([...(profileRef.current.seenChallenges || []), ...doneCh])];
      }
      if (Object.keys(patch).length) patchProfile(() => patch);
    }
    prevScreenRef.current = screen;
  }, [screen, friendGraph, blitzChallenges]);

  const myChallenges = blitzChallenges.map(challengeInfo);
  const challengeAlert = myChallenges.some((c) => c.needsMe || c.unseen);

  const friendAlert =
    (friendGraph.incoming || []).length > 0 ||
    (friendGraph.friends || []).some((u) => !(profile.seenFriends || []).includes(u)) ||
    challengeAlert;

  async function refreshFriends() {
    try {
      const [graph, all, challenges] = await Promise.all([
        loadFriendGraph(), getLeaderboard(), loadBlitzChallenges(),
      ]);
      setFriendGraph(graph);
      const map = {};
      for (const p of all) if (p && p.uid) map[p.uid] = p;
      setFriendPeople(map);
      setBlitzChallenges(challenges);
      if (graph.friends.length > 0 && !profileRef.current.gotFriend) {
        const next = { ...profileRef.current, gotFriend: true }; // "Is This Friends?"
        const unlocked = awardAchievements(next);
        saveProfile(next);
        if (unlocked.length) playJingle(true);
      }
    } catch (e) { /* offline */ }
  }

  // My side of a challenge row + a derived status. (hoisted; used above)
  function challengeInfo(c) {
    const iAmA = c.a === authUid;
    const oppUid = iAmA ? c.b : c.a;
    const myScore = iAmA ? c.score_a : c.score_b;
    const oppScore = iAmA ? c.score_b : c.score_a;
    const complete = c.score_a != null && c.score_b != null;
    const seen = (profile.seenChallenges || []).includes(c.id);
    const opp = friendPeople[oppUid] || null;
    return {
      id: c.id, iAmA, oppUid, opp, myScore, oppScore, complete,
      needsMe: !iAmA && c.score_b == null,       // they challenged me, unplayed
      waiting: iAmA && c.score_b == null,        // I challenged, awaiting them
      unseen: complete && !seen,
      won: complete && myScore > oppScore,
      lost: complete && myScore < oppScore,
      tie: complete && myScore === oppScore,
    };
  }

  async function doFriendAction(kind, uid) {
    if (!uid || friendBusy) return;
    setFriendBusy(uid);
    try {
      if (kind === "request") await sendFriendRequest(uid);
      else if (kind === "accept") await acceptFriend(uid);
      else if (kind === "remove") await removeFriend(uid);
      await refreshFriends();
    } catch (e) { flash("Couldn't do that — try again."); }
    setFriendBusy(null);
  }

  // Relationship of a uid to me: "self" | "friend" | "incoming" | "outgoing" | "none"
  function friendState(uid) {
    if (!uid || uid === authUid) return "self";
    if (friendGraph.friends.includes(uid)) return "friend";
    if (friendGraph.incoming.includes(uid)) return "incoming";
    if (friendGraph.outgoing.includes(uid)) return "outgoing";
    return "none";
  }

  // Search students by name. get_leaderboard() returns every public
  // profile in one call; filter by name slug client-side.
  async function runFriendSearch() {
    const q = friendQuery.trim();
    const qs = slug(q);
    if (!qs || friendLoading) return;
    setFriendLoading(true);
    setFriendView(null);
    setFriendResults(null);
    let all = [];
    try { all = await getLeaderboard(); } catch (e) { /* offline */ }
    const out = all
      .filter((m) => m && m.name && slug(m.name).includes(qs))
      .sort((a, b) => leaderboardScore(b) - leaderboardScore(a) || (a.name || "").localeCompare(b.name || ""))
      .slice(0, 30);
    setFriendResults(out);
    setFriendLoading(false);
  }

  function openParentLink() {
    const next = { ...profile };
    if (!next.parentToken) next.parentToken = genToken();
    if (next.name && (next.milestones || {}).parentlink === undefined) next.milestones = { ...(next.milestones || {}), parentlink: "ready" };
    saveProfile(next);
    setLinkCopied(false);
    setShowParentLink(true);
  }
  function copyParentLink(text) {
    try {
      navigator.clipboard.writeText(text).then(() => {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      });
    } catch (e) { /* clipboard unavailable — the link is shown for manual copy */ }
  }

  // Client-side aggregation: pull every public profile in one RPC call,
  // then build the boards — all-time (top-10 leaderboard scores), this
  // week (XP earned since Monday) and individual players.
  async function loadBoard() {
    setBoard({ loading: true, schools: [], weekly: [], players: [] });
    let all = [];
    try { all = await getLeaderboard(); } catch (e) { /* leave all empty */ }

    const bySchool = {};
    for (const s of all) {
      if (!s || !s.school || s.school === SOLO_SCHOOL) continue;
      (bySchool[s.school] = bySchool[s.school] || []).push(s);
    }
    const schools = Object.entries(bySchool).map(([name, members]) => {
      const ranked = members
        .map((m) => ({
          name: m.name,
          score: leaderboardScore(m),
          prestige: m.prestige || 0,
          level: levelFromExp(totalExp(m)),
          title: titleFor(m),
          correct: m.totalCorrect || 0,
          achievements: (m.achievements || []).length,
          bestRank: Math.max(-1, ...Object.values(m.topics || {}).map((t) => t.highestRank ?? -1)),
          at: lastImprovementAt(m),
          full: m,
        }))
        .sort((a, b) => b.score - a.score || a.at - b.at);
      const counting = ranked.slice(0, 10);
      return {
        name,
        members: members.length,
        atMax: ranked.filter((r) => r.level >= LEVEL_CAP).length,
        score: counting.reduce((sum, r) => sum + r.score, 0),
        assembledAt: counting.length ? Math.max(...counting.map((r) => r.at)) : Infinity,
        top: counting,
        roster: ranked.slice(0, 20),
      };
    });
    schools.sort((a, b) => b.score - a.score || a.assembledAt - b.assembledAt || a.name.localeCompare(b.name));

    // ---- this week ----
    const wk = weekKey();
    const wkXp = (m) => (m.week && m.week.of === wk ? m.week.xp || 0 : 0);
    const lastXp = (m) => (m.lastWeek && m.lastWeek.xp ? m.lastWeek.xp : 0);
    const weekly = Object.entries(bySchool).map(([name, members]) => {
      const contributors = members
        .map((m) => ({ name: m.name, xp: wkXp(m), level: levelFromExp(totalExp(m)), prestige: m.prestige || 0, full: m }))
        .filter((c) => c.xp > 0)
        .sort((a, b) => b.xp - a.xp);
      return {
        name,
        members: members.length,
        xp: contributors.reduce((s, c) => s + c.xp, 0),
        active: contributors.length,
        lastXp: members.reduce((s, m) => s + lastXp(m), 0),
        contributors: contributors.slice(0, 20),
      };
    }).filter((s) => s.xp > 0 || s.lastXp > 0);
    weekly.sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
    const lastChampion = [...weekly].filter((s) => s.lastXp > 0).sort((a, b) => b.lastXp - a.lastXp)[0] || null;

    // ---- individual players (every student, all schools + solo) ----
    const players = all
      .filter((m) => m && m.name)
      .map(toBoardEntry)
      .sort((a, b) => b.score - a.score || a.at - b.at || a.name.localeCompare(b.name))
      .slice(0, 50);

    setBoard({ loading: false, schools, weekly, players, weekOf: wk, lastChampion });
  }

  function openQuestionBank() {
    setScreen("questions");
    setQbPreview(TOPIC_BY_ID[qbTopicId].generate());
  }

  function qbSelectTopic(topicId) {
    setQbTopicId(topicId);
    setQbPreview(TOPIC_BY_ID[topicId].generate());
    qbCancelEdit();
  }

  function qbNewPreview() {
    setQbPreview(TOPIC_BY_ID[qbTopicId].generate());
  }

  function qbCancelEdit() {
    setQbEditingId(null);
    setQbForm({ prompt: "", answer: "", hint: "", steps: "" });
  }

  function qbStartEdit(q) {
    setQbEditingId(q.id);
    setQbForm({ prompt: q.prompt, answer: q.answer, hint: q.hint || "", steps: (q.steps || []).join("\n") });
  }

  function qbSaveQuestion() {
    if (!qbForm.prompt.trim() || !qbForm.answer.trim()) return;
    const arr = [...(customQuestions[qbTopicId] || [])];
    const stepsArr = qbForm.steps.split("\n").map((s) => s.trim()).filter(Boolean);
    if (qbEditingId) {
      const idx = arr.findIndex((q) => q.id === qbEditingId);
      if (idx >= 0) arr[idx] = { id: qbEditingId, prompt: qbForm.prompt.trim(), answer: qbForm.answer.trim(), hint: qbForm.hint.trim(), steps: stepsArr };
    } else {
      arr.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, prompt: qbForm.prompt.trim(), answer: qbForm.answer.trim(), hint: qbForm.hint.trim(), steps: stepsArr });
    }
    saveCustomQuestions(qbTopicId, arr);
    qbCancelEdit();
  }

  function qbDeleteQuestion(id) {
    saveCustomQuestions(qbTopicId, (customQuestions[qbTopicId] || []).filter((q) => q.id !== id));
  }

  const vars = THEMES[theme] || THEMES.light;

  // Missions = today's daily tasks + unclaimed first-time bonuses. The
  // header button colours up when something is ready to claim.
  const missionDay = (profile.daily && profile.daily.date === todayKey()) ? profile.daily : freshDay(profile);
  const missionTasks = (missionDay.tasks || []).map((id) => TASK_BY_ID[id]).filter(Boolean);
  const missionMs = MILESTONES.filter((m) => (profile.milestones || {})[m.id] !== "claimed");
  const missionClaims =
    missionTasks.filter((t) => taskDone(t, missionDay) && !missionDay.claimed[t.id]).length +
    missionMs.filter((m) => (profile.milestones || {})[m.id] === "ready").length;

  // Earned achievements double as profile icons; a red dot flags the ones
  // the student hasn't seen offered yet (clears when they open the picker).
  const newIconCount = unlockedAvatarIds(profile).filter((id) => !(profile.seenIcons || []).includes(id)).length;
  const myLevel = levelFromExp(totalExp(profile));

  if (!ready) return <div style={{ ...vars, minHeight: "100dvh", background: "var(--page-bg)" }} />;

  return (
    <div style={{ ...vars, fontFamily: "Inter, sans-serif", color: "var(--ink)", background: "var(--page-bg)", minHeight: "100dvh", display: "flex", flexDirection: "column", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mub-display { font-family: 'Fraunces', serif; }
        .mub-mono { font-family: 'JetBrains Mono', monospace; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "calt" 0; }
        .mub-grid {
          background-image:
            linear-gradient(var(--grid) 1px, transparent 1px),
            linear-gradient(90deg, var(--grid) 1px, transparent 1px);
          background-size: 24px 24px;
          background-color: var(--paper);
        }
        @keyframes stampIn { 0% { transform: scale(2.2) rotate(-8deg); opacity: 0; } 60% { transform: scale(0.9) rotate(-8deg); opacity: 1; } 100% { transform: scale(1) rotate(-8deg); opacity: 1; } }
        @keyframes wobble { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
        @keyframes rankPop { 0% { transform: scale(0) rotate(-25deg); opacity: 0; } 55% { transform: scale(1.3) rotate(8deg); opacity: 1; } 78% { transform: scale(0.9) rotate(-4deg); } 100% { transform: scale(1) rotate(0); opacity: 1; } }
        @keyframes rankGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 6px currentColor; } }
        .mub-stamp { animation: stampIn 0.4s ease-out; }
        .mub-wobble { animation: wobble 0.35s ease-in-out; }
        .mub-rankpop { animation: rankPop 0.55s cubic-bezier(.2,.9,.3,1.25), rankGlow 0.7s ease-out 0.2s; }
        .mub-card { transition: transform 0.15s ease, box-shadow 0.15s ease; }
        .mub-card:hover { transform: translateY(-2px); box-shadow: 0 8px 20px var(--shadow); }
        .mub-grid input, .mub-grid textarea, .mub-grid select { color: var(--ink); background: var(--card); }
        .mub-grid input::placeholder, .mub-grid textarea::placeholder { color: var(--muted); }
        * { -webkit-tap-highlight-color: transparent; }
        svg [role], svg rect, svg circle, svg polygon { outline: none; }
      `}</style>

      <div className="mub-grid" style={{ borderRadius: 20, padding: "clamp(16px, 4vw, 28px)", flex: 1 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px 14px", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "0 10px", minWidth: 0 }}>
            <span className="mub-display" style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.5 }}>MathsUnlocked</span>
            <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>BN · Mastery Challenge</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: "6px 14px" }}>
            {screen !== "login" && screen !== "parent" && screen !== "leaderboard" && (
              <button onClick={openLeaderboard} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Leaderboard
              </button>
            )}
            {screen !== "login" && screen !== "parent" && teacherMode && screen !== "admin" && (
              <button onClick={openAdmin} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Admin view
              </button>
            )}
            {screen !== "login" && screen !== "parent" && teacherMode && screen !== "questions" && (
              <button onClick={openQuestionBank} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Question bank
              </button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              {screen !== "login" && screen !== "parent" ? (<>
                <button onClick={openFriends} aria-label="Friends" title="Friends" style={{
                  position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
                  width: 30, height: 30, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                  border: "1px solid var(--grid)", background: "var(--card)", color: "var(--muted)",
                }}>
                  <Users size={15} />
                  {friendAlert && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--red)", border: "1.5px solid var(--paper)", boxSizing: "border-box" }} />}
                </button>
                <button onClick={() => setAchOpen(true)} aria-label="Achievements" title="Achievements" style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 30, height: 30, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                  border: "1px solid var(--grid)", background: "var(--card)", color: "var(--muted)",
                }}>
                  <Trophy size={15} />
                </button>
                <button onClick={() => setMissionsOpen(true)} aria-label="Missions" title="Missions" style={{
                  position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
                  width: 30, height: 30, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                  border: missionClaims > 0 ? "none" : "1px solid var(--grid)",
                  background: missionClaims > 0 ? "var(--green)" : "var(--card)",
                  color: missionClaims > 0 ? "var(--on-accent)" : "var(--muted)",
                }}>
                  <ClipboardCheck size={15} />
                  {missionClaims > 0 && (
                    <span style={{ position: "absolute", top: -3, right: -3, minWidth: 15, height: 15, padding: "0 3px", borderRadius: 999, background: "var(--red)", color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", border: "1.5px solid var(--paper)", boxSizing: "border-box" }}>{missionClaims}</span>
                  )}
                </button>
                <button onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings" style={{
                  position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
                  width: 30, height: 30, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                  border: "1px solid var(--grid)", background: "var(--card)", color: "var(--muted)",
                }}>
                  <Settings size={16} />
                </button>
              </>) : (<>
                <button onClick={toggleSound} title={soundOn ? "Achievement sound: on" : "Achievement sound: off"} aria-label="Toggle achievement sound" style={{ fontSize: 15, lineHeight: 1, background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                  {soundOn ? "🔊" : "🔇"}
                </button>
                <button onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle dark mode" style={{ fontSize: 15, lineHeight: 1, background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                  {theme === "dark" ? "☀️" : "🌙"}
                </button>
              </>)}
            </div>
          </div>
        </div>

        {/* LOGIN */}
        {screen === "login" && (
          <div style={{ maxWidth: 380, margin: "40px auto", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 28, boxShadow: "0 6px 20px var(--shadow-soft)" }}>
            <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Start practising</div>

            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18 }}>All 30 topics from the checklist are here. Foundational topics start open; the rest unlock once their prerequisite topic reaches rank C. Enter the same name and PIN next time to pick up where you left off.</div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Your name</label>
            <input
              value={nameInput} onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startSession(); }}
              placeholder="e.g. Amirah"
              style={{ width: "100%", marginTop: 6, marginBottom: 14, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
            />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>6-digit PIN <span style={{ fontWeight: 400 }}>(pick one you'll remember)</span></label>
            <input
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") startSession(); }}
              inputMode="numeric" placeholder="e.g. 405126"
              style={{ width: "100%", marginTop: 6, marginBottom: 4, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", letterSpacing: 4 }}
            />
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14 }}>Two students can share a name but not a name + PIN. Forgot your PIN? Your teacher can set a new one.</div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>School <span style={{ fontWeight: 400 }}>(for the leaderboard — optional)</span></label>
            {schoolInput !== SOLO_SCHOOL ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--green)", borderRadius: 8, fontSize: 13, background: "var(--card)" }}>
                <span style={{ color: "var(--green)", fontWeight: 700 }}>✓</span>
                <span style={{ flex: 1, minWidth: 0 }}>{schoolInput}</span>
                <button type="button" onClick={() => { setSchoolInput(SOLO_SCHOOL); setSchoolQuery(""); }} style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>change</button>
              </div>
            ) : (
              <div style={{ position: "relative", marginTop: 6, marginBottom: 16 }}>
                <input
                  value={schoolQuery} onChange={(e) => setSchoolQuery(e.target.value)}
                  placeholder="Start typing your school… (leave blank for Solo)"
                  style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
                />
                {schoolQuery.trim().length >= 1 && (() => {
                  const q = schoolQuery.trim().toLowerCase();
                  const hits = ALL_SCHOOLS.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
                  return (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 5, marginTop: 4, background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 8, maxHeight: 220, overflowY: "auto", boxShadow: "0 6px 20px var(--shadow-soft)" }}>
                      {hits.map((s) => (
                        <button key={s} type="button" onClick={() => { setSchoolInput(s); setSchoolQuery(s); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", fontSize: 13, background: "none", border: "none", borderBottom: "1px solid var(--grid)", cursor: "pointer", color: "var(--ink)" }}>
                          {s}
                        </button>
                      ))}
                      {hits.length === 0 && (
                        <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--muted)" }}>
                          No match. You&rsquo;ll be entered as Solo — ask your teacher to add your school.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
            {startError && (
              <div style={{ fontSize: 12, color: "var(--red)", fontWeight: 600, marginBottom: 8 }}>{startError}</div>
            )}
            <button
              onClick={startSession}
              disabled={!nameInput.trim() || !/^\d{6}$/.test(pinInput) || starting}
              style={{ width: "100%", padding: "10px 12px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", opacity: !nameInput.trim() || !/^\d{6}$/.test(pinInput) || starting ? 0.6 : 1 }}
            >
              {starting ? "Loading…" : "Start / continue"}
            </button>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button onClick={() => { setForgotOpen((o) => !o); setForgotMsg(null); }} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                Forgot your PIN?
              </button>
            </div>
            {forgotOpen && (
              <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--grid)", borderRadius: 10, background: "var(--paper)" }}>
                {EMAIL_RECOVERY ? (<>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8, lineHeight: 1.5 }}>
                    Added a recovery email? Enter it and we&rsquo;ll send a reset link — open it on this device and choose a new PIN. No recovery email? Ask your teacher.
                  </div>
                  <input
                    value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitForgotPin(); }}
                    type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
                    style={{ width: "100%", padding: "9px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
                  />
                  {forgotMsg && (
                    <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, color: forgotMsg.ok === false ? "var(--red)" : forgotMsg.ok ? "var(--green)" : "var(--muted)" }}>{forgotMsg.text}</div>
                  )}
                  <button onClick={submitForgotPin} disabled={!!forgotMsg && forgotMsg.ok === null} style={{ marginTop: 8, width: "100%", padding: "9px 12px", background: "none", color: "var(--blue)", border: "1px solid var(--blue)", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                    Send reset link
                  </button>
                </>) : (
                  <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                    Ask your teacher — they can set you a new PIN from the class list. Your progress is safe; only the PIN changes.
                  </div>
                )}
              </div>
            )}
            {teacherMode && (
              <div style={{ textAlign: "center", marginTop: 14, display: "flex", justifyContent: "center", gap: 16 }}>
                <button onClick={openAdmin} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Admin view
                </button>
                <button onClick={openQuestionBank} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Question bank
                </button>
              </div>
            )}
          </div>
        )}

        {/* CHOOSE A NEW PIN (arrived via a recovery link) */}
        {screen === "reset" && (
          <div style={{ maxWidth: 380, margin: "40px auto", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 28, boxShadow: "0 6px 20px var(--shadow-soft)" }}>
            <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Choose a new PIN</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18 }}>Pick a new 6-digit PIN. From now on you log in with your name and this PIN, same as before.</div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>New 6-digit PIN</label>
            <input
              value={resetPin}
              onChange={(e) => setResetPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") submitNewPin(); }}
              inputMode="numeric" placeholder="e.g. 728461"
              style={{ width: "100%", marginTop: 6, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", letterSpacing: 4 }}
            />
            <button
              onClick={submitNewPin}
              disabled={!/^\d{6}$/.test(resetPin) || resetBusy}
              style={{ width: "100%", padding: "10px 12px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", opacity: !/^\d{6}$/.test(resetPin) || resetBusy ? 0.6 : 1 }}
            >
              {resetBusy ? "Saving…" : "Save & continue"}
            </button>
          </div>
        )}

        {/* DASHBOARD */}
        {screen === "dashboard" && (
          <div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => setShowCard(true)} style={{ position: "relative", background: "none", border: "none", padding: 0, cursor: "pointer", flexShrink: 0, borderRadius: "50%" }}>
                  <MiniAvatar profile={profile} size={46} />
                  {newIconCount > 0 && <span style={{ position: "absolute", top: 0, right: 0, width: 12, height: 12, borderRadius: "50%", background: "var(--red)", border: "2px solid var(--paper)", boxSizing: "border-box" }} />}
                </button>
                <button onClick={() => setShowCard(true)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", minWidth: 0, flex: 1 }}>
                  <div className="mub-display" style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>Hi, <span style={nameStyleOf(profile)}>{profile.name}</span></div>
                  <div style={{ fontSize: 13, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                    <PrestigeBadge prestige={profile.prestige} size={15} />
                    <span style={{ color: "var(--blue)", fontWeight: 600 }}>{titleFor(profile)}</span>
                    <span>· Current streak: {profile.streak || 0} 🔥</span>
                  </div>
                </button>
              </div>
              {EMAIL_RECOVERY && (
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => { setRecMsg(null); setRecEmail(""); setRecoveryOpen(true); }} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                    🔑 {profile.recoveryEmail ? `Recovery: ${profile.recoveryEmail}` : "Add PIN recovery"}
                  </button>
                </div>
              )}
              <div style={{ marginTop: 14 }}>
                <LevelBar profile={profile} onPrestige={() => setConfirmPrestige(true)} onOpenUnlocks={() => setUnlocksOpen(true)} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, maxWidth: 460 }}>
                <button onClick={() => setInventoryOpen(true)} style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: "var(--blue)", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 999, padding: "7px 14px", cursor: "pointer", boxShadow: "0 1px 3px var(--shadow-soft)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  🎒 Inventory
                </button>
                {(() => {
                  const perksOk = myLevel >= PERKS.compound.lv;
                  return (
                    <button onClick={() => perksOk && setPerksOpen(true)} disabled={!perksOk} title={perksOk ? undefined : `Unlocks at Level ${PERKS.compound.lv}`} style={{
                      flex: 1, fontSize: 12.5, fontWeight: 700, color: perksOk ? "var(--blue)" : "var(--muted)",
                      background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 999, padding: "7px 14px",
                      cursor: perksOk ? "pointer" : "default", opacity: perksOk ? 1 : 0.5,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: "0 1px 3px var(--shadow-soft)",
                    }}>
                      🎖 Perks {perksOk
                        ? <span style={{ letterSpacing: 1 }}>{(profile.perks || []).filter((p) => PERKS[p]).map((p) => PERKS[p].icon).join("")}</span>
                        : <span style={{ fontSize: 11 }}>🔒 Lv {PERKS.compound.lv}</span>}
                    </button>
                  );
                })()}
              </div>
              {(profile.boostUntil || 0) > Date.now() && (
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--green)", marginTop: 6 }}>
                  ⚡ ×2 XP · {Math.max(1, Math.ceil(((profile.boostUntil || 0) - Date.now()) / 60000))} min left
                </div>
              )}

              {teacherMode && (
                <div style={{ border: "1px dashed var(--amber)", borderRadius: 10, padding: "10px 12px", marginTop: 12, fontSize: 12 }}>
                  <button onClick={() => setDevOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 700, color: "var(--amber)" }}>
                    <span>🛠 Teacher / dev tools <span style={{ fontWeight: 400, color: "var(--muted)" }}>— affects your own account</span></span>
                    <span style={{ transform: devOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
                  </button>
                  {devOpen && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                    {(() => {
                      const b = { fontSize: 12, fontWeight: 600, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 10px", cursor: "pointer" };
                      return (
                        <>
                          <button onClick={devMaxAll} style={b}>Max all topics → S+ (Level 20)</button>
                          <button onClick={devCAll} style={b}>Get C in every topic</button>
                          <button onClick={() => devAddKeys(3)} style={b}>+3 Skeleton Keys</button>
                          <button onClick={() => saveProfile({ ...profile, boosts: (profile.boosts || 0) + 1 })} style={b}>+1 XP Boost</button>
                          <button onClick={() => saveProfile({ ...profile, hints: (profile.hints || 0) + 5 })} style={b}>+5 Hint coins</button>
                          <button onClick={() => saveProfile({ ...profile, shields: (profile.shields || 0) + 3 })} style={b}>+3 Streak Shields</button>
                          <select value={devJingle} onChange={(e) => setDevJingle(e.target.value)} style={{ fontSize: 12, border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 8px" }}>
                            <option value="achievement">Jingle · achievement</option>
                            <option value="levelup">Jingle · level-up</option>
                            <option value="correct">Answer · correct</option>
                            <option value="wrong">Answer · wrong</option>
                            <option value="unlock">Skeleton Key · unlock</option>
                            <option value="boost">XP Boost</option>
                            <option value="coins">Claim · coins</option>
                          </select>
                          <button onClick={() => ({
                            achievement: () => playJingle(false),
                            levelup: () => playJingle(true),
                            correct: playCorrect,
                            wrong: playWrong,
                            unlock: playUnlock,
                            boost: playBoost,
                            coins: playCoins,
                          }[devJingle] || (() => {}))()} style={b}>▶ Play jingle</button>
                          <select value={devTopic} onChange={(e) => setDevTopic(e.target.value)} style={{ fontSize: 12, border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 8px" }}>
                            {TOPICS.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
                          </select>
                          <button onClick={devMaxTopic} style={b}>Max selected → S+</button>
                          <button onClick={devHardReset} style={{ ...b, color: "var(--red)", borderColor: "var(--red)" }}>Reset → Level 1, Prestige 0</button>
                        </>
                      );
                    })()}
                  </div>
                  )}
                </div>
              )}
            </div>

            {(() => {
              const lvl = levelFromExp(totalExp(profile));
              const mixedOpen = lvl >= MIXED_UNLOCK_LEVEL;
              const blitzOpen = lvl >= BLITZ_UNLOCK_LEVEL;
              const modeBtn = (open) => ({
                width: "100%", textAlign: "left", cursor: open ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 14,
                border: `1px solid ${open ? "var(--blue)" : "var(--grid)"}`,
                background: open ? "var(--card)" : "var(--locked)", opacity: open ? 1 : 0.6,
              });
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                  <button onClick={startMixed} disabled={!mixedOpen} className={mixedOpen ? "mub-card" : ""} style={modeBtn(mixedOpen)}>
                    <span style={{ fontSize: 28, filter: mixedOpen ? "none" : "grayscale(1)" }}>🎲</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                        Mixed Review {mixedOpen ? "" : `🔒 Level ${MIXED_UNLOCK_LEVEL}`}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--muted)" }}>
                        {mixedOpen
                          ? "Random questions from every topic you've unlocked — answers still count toward each topic."
                          : `Unlocks at Level ${MIXED_UNLOCK_LEVEL}.`}
                      </span>
                    </span>
                  </button>
                  <button onClick={startBlitz} disabled={!blitzOpen} className={blitzOpen ? "mub-card" : ""} style={modeBtn(blitzOpen)}>
                    <span style={{ fontSize: 28, filter: blitzOpen ? "none" : "grayscale(1)" }}>⚡</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                        Blitz {blitzOpen ? "" : `🔒 Level ${BLITZ_UNLOCK_LEVEL}`}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--muted)" }}>
                        {blitzOpen
                          ? `${BLITZ_SECONDS} seconds, tap-only questions — answer as many as you can.`
                          : `Unlocks at Level ${BLITZ_UNLOCK_LEVEL}.`}
                      </span>
                    </span>
                    {blitzOpen && (
                      <span style={{ flexShrink: 0, textAlign: "center" }}>
                        <span style={{ display: "block", fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>Best</span>
                        <span className="mub-display" style={{ fontSize: 20, fontWeight: 700, color: "var(--blue)" }}>{profile.blitzBest || 0}</span>
                      </span>
                    )}
                  </button>
                </div>
              );
            })()}

            {(() => {
              const anyKeyButton = (profile.keys || 0) > 0 && TOPICS.some((t) => !isUnlocked(t, profile));
              const cardHeight = anyKeyButton ? 134 : 108;
              return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 10, marginBottom: 24 }}>
              {TOPICS.map((t) => {
                const topicState = profile.topics[t.id] || { history: [], highestRank: -1, streak: 0 };
                const unlocked = isUnlocked(t, profile);
                const rank = rankDisplay(topicState.highestRank);
                return (
                  <div
                    key={t.id}
                    onClick={() => startTopic(t)}
                    className={unlocked ? "mub-card" : ""}
                    title={unlocked ? undefined : lockedReason(t)}
                    style={{
                      background: unlocked ? "var(--card)" : "var(--locked)",
                      border: "1px solid var(--grid)", borderRadius: 12, padding: "9px 11px",
                      cursor: unlocked ? "pointer" : "not-allowed",
                      opacity: unlocked ? 1 : 0.55,
                      minHeight: cardHeight, display: "flex", flexDirection: "column",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 4 }}>
                      <div style={{ fontSize: 20, filter: unlocked ? "none" : "grayscale(1)" }}>{t.icon}</div>
                      {unlocked ? (
                        <div style={{ width: 24, height: 24, borderRadius: "50%", border: `2px solid ${rank.color}`, color: rank.color, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 10, flexShrink: 0 }}>
                          {rank.label}
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: "var(--muted)" }}>🔒</div>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 5, lineHeight: 1.2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {unlocked
                        ? `${(topicState.streak || 0) > 0 ? "🔥 " : ""}${topicState.streak || 0} streak`
                        : lockedReason(t)}
                    </div>
                    {!unlocked && (profile.keys || 0) > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setKeyTarget(t); }}
                        style={{ marginTop: "auto", alignSelf: "flex-start", fontSize: 10.5, fontWeight: 700, color: "var(--blue)", background: "var(--card)", border: "1px solid var(--blue)", borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}
                      >
                        🗝 Use key
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
              );
            })()}
          </div>
        )}

        {/* ADMIN */}
        {screen === "admin" && (
          <div>
            <button onClick={() => setScreen(profile.name ? "dashboard" : "login")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> back
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div className="mub-display" style={{ fontSize: 20, fontWeight: 700 }}>Registered Students ({students.length})</div>
              <button onClick={loadStudents} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <RotateCcw size={12} /> refresh
              </button>
            </div>

            {adminLoading && <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>}
            {!adminLoading && students.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>No students have registered yet.</div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {students.map((s, idx) => {
                const attempted = TOPICS.filter((t) => (s.topics[t.id] || {}).history?.length > 0);
                return (
                  <div key={idx} style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 14, padding: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {s.name}
                        <PrestigeBadge prestige={s.prestige} size={16} />
                        <span className="mub-display" style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", borderRadius: 999, padding: "1px 8px" }}>
                          LV {levelFromExp(totalExp(s))}
                        </span>
                        {s.school && s.school !== SOLO_SCHOOL && (
                          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}>{s.school}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        {attempted.length}/{TOPICS.length} topics started · 🔥 best streak {s.bestStreak || 0} · 🏆 {(s.achievements || []).length} achievements
                      </div>
                    </div>
                    {attempted.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>No questions attempted yet.</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {attempted.map((t) => {
                          const rank = rankDisplay(s.topics[t.id].highestRank);
                          return (
                            <div key={t.id} title={t.name} style={{
                              display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999,
                              border: `1px solid ${rank.color}`, fontSize: 11,
                            }}>
                              <span>{t.icon}</span>
                              <span style={{ fontWeight: 700, color: rank.color }}>{rank.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(s.achievements || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
                        {(s.achievements || [])
                          .map((aid) => ACHIEVEMENTS.find((x) => x.id === aid))
                          .filter(Boolean)
                          .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier))
                          .map((a) => (
                            <span key={a.id} title={`${a.name} · ${a.tier}`} style={{
                              fontSize: 13, lineHeight: 1, padding: 3, borderRadius: "50%",
                              boxShadow: `0 0 0 1.5px ${TIER_COLOR[a.tier]}`,
                            }}>{a.icon}</span>
                          ))}
                      </div>
                    )}
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--grid)" }}>
                      {pinResetFor === s.uid ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <input
                            value={pinResetVal}
                            onChange={(e) => setPinResetVal(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            onKeyDown={(e) => { if (e.key === "Enter") doPinReset(s.uid); }}
                            inputMode="numeric" placeholder="new 6-digit PIN" autoFocus
                            style={{ width: 150, padding: "7px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, letterSpacing: 3, boxSizing: "border-box" }}
                          />
                          <button onClick={() => doPinReset(s.uid)} disabled={pinResetBusy || !/^\d{6}$/.test(pinResetVal)} style={{ fontSize: 12, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "7px 12px", cursor: "pointer", opacity: pinResetBusy || !/^\d{6}$/.test(pinResetVal) ? 0.6 : 1 }}>
                            {pinResetBusy ? "Setting…" : "Set PIN"}
                          </button>
                          <button onClick={() => { setPinResetFor(null); setPinResetVal(""); setPinResetMsg(null); }} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "7px 12px", cursor: "pointer" }}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => { setPinResetFor(s.uid); setPinResetVal(""); setPinResetMsg(null); }} disabled={!s.uid} style={{ fontSize: 12, fontWeight: 600, color: "var(--blue)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "6px 12px", cursor: "pointer", opacity: s.uid ? 1 : 0.5 }}>
                          Reset PIN
                        </button>
                      )}
                      {pinResetMsg && pinResetMsg.uid === s.uid && (
                        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8, color: pinResetMsg.ok ? "var(--green)" : "var(--red)" }}>{pinResetMsg.text}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* QUESTION BANK */}
        {screen === "questions" && (
          <div>
            <button onClick={() => setScreen(profile.name ? "dashboard" : "login")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> back
            </button>
            <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Question Bank</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16 }}>
              Each topic writes questions from a formula (see the live example below) — that's still where most questions come from. Custom questions you add here get mixed in alongside them, roughly half the time.
            </div>

            <select
              value={qbTopicId}
              onChange={(e) => qbSelectTopic(e.target.value)}
              style={{ padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, marginBottom: 18, width: "100%", maxWidth: 320 }}
            >
              {TOPICS.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
            </select>

            {/* Generator preview */}
            <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Live generator example</div>
                <button onClick={qbNewPreview} style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>New example</button>
              </div>
              {qbPreview && (
                <div>
                  <div className="mub-mono" style={{ fontSize: 14, marginBottom: 6 }}>{qbPreview.prompt}</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Answer: <span className="mub-mono">{qbPreview.answer}</span></div>
                </div>
              )}
            </div>

            {/* Existing custom questions */}
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
              Custom questions for {TOPIC_BY_ID[qbTopicId].name} ({(customQuestions[qbTopicId] || []).length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {(customQuestions[qbTopicId] || []).length === 0 && (
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>None yet — add one below.</div>
              )}
              {(customQuestions[qbTopicId] || []).map((q) => (
                <div key={q.id} style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="mub-mono" style={{ fontSize: 13 }}>{q.prompt}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Answer: <span className="mub-mono">{q.answer}</span>{q.steps && q.steps.length ? ` · ${q.steps.length} step(s)` : ""}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button onClick={() => qbStartEdit(q)} style={{ fontSize: 12, color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }}>Edit</button>
                    <button onClick={() => qbDeleteQuestion(q.id)} style={{ fontSize: 12, color: "var(--red)", background: "none", border: "none", cursor: "pointer" }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Add / edit form */}
            <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{qbEditingId ? "Edit question" : "Add a custom question"}</div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>Question text</label>
              <textarea
                value={qbForm.prompt} onChange={(e) => setQbForm({ ...qbForm, prompt: e.target.value })}
                rows={2} placeholder="e.g. Solve for x: 3x + 4 = 19"
                style={{ width: "100%", marginTop: 4, marginBottom: 10, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
              />
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>Answer</label>
              <input
                value={qbForm.answer} onChange={(e) => setQbForm({ ...qbForm, answer: e.target.value })}
                placeholder="e.g. 5"
                style={{ width: "100%", marginTop: 4, marginBottom: 10, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, boxSizing: "border-box" }}
              />
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>Hint (optional)</label>
              <input
                value={qbForm.hint} onChange={(e) => setQbForm({ ...qbForm, hint: e.target.value })}
                placeholder="e.g. Enter a number."
                style={{ width: "100%", marginTop: 4, marginBottom: 10, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, boxSizing: "border-box" }}
              />
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>Step-by-step working (optional, one step per line)</label>
              <textarea
                value={qbForm.steps} onChange={(e) => setQbForm({ ...qbForm, steps: e.target.value })}
                rows={3} placeholder={"Subtract 4 from both sides: 3x = 15\nDivide both sides by 3: x = 5"}
                style={{ width: "100%", marginTop: 4, marginBottom: 12, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={qbSaveQuestion} style={{ padding: "8px 16px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                  {qbEditingId ? "Save changes" : "Add question"}
                </button>
                {qbEditingId && (
                  <button onClick={qbCancelEdit} style={{ padding: "8px 16px", background: "none", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* QUIZ */}
        {screen === "quiz" && question && (
          <div>
            <button onClick={leaveQuizUnanswered} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> back to topics
            </button>

            <div style={{
              maxWidth: 520, margin: "0 auto", background: "var(--card)", border: "1px solid var(--grid)",
              borderLeft: "4px solid var(--red)", borderRadius: 10, padding: "18px 16px 18px 18px",
              transform: "rotate(-0.4deg)", boxShadow: "0 6px 24px var(--shadow-soft)", position: "relative", overflow: "hidden",
              minHeight: sketchOn ? 356 : undefined, // room for the rough-working pad when the question is short
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                  {activeTopic.icon} {activeTopic.name}
                  {activeTopic.id === MIXED_TOPIC.id && question.topicName ? (
                    <span style={{ fontWeight: 400 }}> · {question.topicIcon} {question.topicName}</span>
                  ) : ""}
                </div>
                {(() => {
                  const topicStreak = (profile.topics[question.topicId || activeTopic.id] || {}).streak || 0;
                  const live = topicStreak > 0;
                  return (
                    <div title="Correct answers in a row in this topic" style={{
                      display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                      fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                      color: live ? "var(--amber)" : "var(--muted)",
                      border: `1px solid ${live ? "var(--amber)" : "var(--grid)"}`,
                      background: live ? "var(--amber-wash)" : "transparent",
                    }}>
                      {live ? "🔥" : "○"} {topicStreak} streak
                    </div>
                  );
                })()}
              </div>
              {(() => {
                const { lead, expr } = splitPrompt(question.prompt);
                // Shrink the expression's font as it gets longer so it wraps
                // gracefully instead of forcing a horizontal scroll.
                const exprSize = expr ? Math.max(13, Math.min(20, Math.round(290 / (expr.length * 0.62)))) : 17;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div className="mub-mono" style={{ fontSize: expr ? 13 : 17, lineHeight: 1.5, color: expr ? "var(--muted)" : "var(--ink)", overflowWrap: "break-word" }}><MathText text={lead} /></div>
                    {expr && (
                      <div className="mub-mono" style={{ fontSize: exprSize, fontWeight: 600, lineHeight: 1.4, marginTop: 6, color: "var(--ink)", overflowWrap: "break-word" }}><MathText text={expr} /></div>
                    )}
                  </div>
                );
              })()}

              {question.graph && <LineGraph data={question.graph} />}
              {question.motion && <MotionGraph {...question.motion} />}
              {question.figure && (
                <div>
                  <ShapeFigure shape={question.figure.shape} showSym={!!feedback && question.figure.showSymAfter} />
                  {!!feedback && question.figure.showSymAfter && (
                    <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center", marginTop: -4, marginBottom: 8 }}>
                      {(SHAPES[question.figure.shape].sym || []).length === 0
                        ? "No lines of symmetry"
                        : `Dashed = the ${(SHAPES[question.figure.shape].sym || []).length} line${(SHAPES[question.figure.shape].sym || []).length === 1 ? "" : "s"} of symmetry`}
                    </div>
                  )}
                </div>
              )}
              {question.tri && <TriangleFigure {...question.tri} />}
              {question.circle && <CircleFigure {...question.circle} />}
              {question.solid && <MensurationFigure {...question.solid} />}
              {question.vec && <VectorFigure {...question.vec} />}
              {question.cumfreq && (
                <div style={{ marginBottom: 8 }}>
                  <CumFreqGraph {...question.cumfreq} picks={cfPick} onPick={feedback ? null : pickCf} />
                  <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
                    Tap the x-axis or y-axis to drop a guide line to the curve
                  </div>
                </div>
              )}

              {(question.drawGraph || question.drawSolve) && (() => {
                const sl = question.solveLine || question.drawGraph; // { m, c }
                const solution = feedback && sl ? [[-6, sl.m * -6 + sl.c], [6, sl.m * 6 + sl.c]] : null;
                return (
                  <div style={{ marginBottom: 12 }}>
                    <DrawGraph points={drawPts} curve={question.curve || null} solution={solution}
                      solvePoints={feedback ? (question.solvePoints || null) : null}
                      onToggle={feedback ? null : toggleDrawPoint} />
                    <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
                      {feedback ? (feedback.correct ? "Your line (blue) is right" : "Green shows the correct line")
                        : drawPts.length === 0 ? "Tap a point your line passes through"
                        : drawPts.length === 1 ? "Now tap a second point"
                        : "Tap another point to move the line"}
                    </div>
                  </div>
                );
              })()}

              {question.region && (
                <div style={{ marginBottom: 12 }}>
                  <RegionGraph line={question.region} picked={regionPick} showAnswer={!!feedback}
                    onPick={feedback ? null : pickRegion} />
                  <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
                    {feedback ? (feedback.correct ? "Correct region shaded" : "Green shows the correct region")
                      : regionPick ? "Tap the other side to switch, or check your answer"
                      : "Tap the region where the inequality is true"}
                  </div>
                </div>
              )}

              {question.venn && (
                <div style={{ marginBottom: 12 }}>
                  <VennShade venn={question.venn} pressed={vennPressed} showAnswer={!!feedback}
                    onToggle={feedback ? null : toggleVenn} />
                  <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
                    {feedback ? (feedback.correct ? "Correct — that's the region" : "Green shows the correct region")
                      : "Tap every part of the region to shade it"}
                  </div>
                </div>
              )}

              {question.placeVenn && (
                <div style={{ marginBottom: 12 }}>
                  <VennPlaceBoard venn={question.placeVenn} placement={vennPlace} onPlace={placeVennEl} showAnswer={!!feedback} />
                  <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center", marginTop: 4 }}>
                    {feedback ? (feedback.correct ? "Every number is in the right region" : "Red rings show which numbers are in the wrong region")
                      : "Drag each number from the tray into the correct region"}
                  </div>
                </div>
              )}

              {question.transform && (
                <div style={{ marginBottom: 12 }}>
                  <TransformFigure
                    a={question.transform.a}
                    b={question.transform.draw ? (feedback ? question.transform.image : null) : question.transform.b}
                    centre={question.transform.centre || (feedback ? question.transform.answerCentre : null)}
                    mirror={feedback ? (question.drawMirror || question.transform.answerMirror) : null}
                    rays={question.transform.rays || (feedback ? question.transform.answerRays : null)}
                    lineMode={!!question.drawMirror}
                    tapPts={question.transform.draw ? drawTri : question.drawMirror ? drawPts : null}
                    onTap={feedback ? null : question.transform.draw ? toggleTriPoint : question.drawMirror ? toggleDrawPoint : null}
                  />
                  <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
                    {question.drawMirror
                      ? (feedback
                        ? (feedback.correct ? "Mirror line correct" : "Red shows the correct mirror line")
                        : drawPts.length < 2 ? "Tap two points on the mirror line" : "Tap a different point to adjust the line")
                      : question.transform.draw
                        ? (feedback
                          ? (feedback.correct ? "Image placed correctly" : "Green shows the correct image")
                          : drawTri.length === 0 ? "Tap the first vertex of the image"
                            : drawTri.length < 3 ? `${3 - drawTri.length} more to tap`
                              : "Tap a different point to adjust a vertex")
                        : "Triangle A (blue) is mapped onto triangle B (green)"}
                  </div>
                </div>
              )}

              {question.choices && (
                feedback ? (
                  <div style={{ fontSize: 13, marginBottom: 12 }}>You chose: <strong>{mcPick || "—"}</strong></div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                    {question.choices.map((opt) => (
                      <button key={opt} type="button" onClick={() => setMcPick(opt)} style={{
                        padding: "10px 14px", textAlign: "left", fontSize: 14, fontWeight: 600, cursor: "pointer",
                        borderRadius: 8, border: `1.5px solid ${mcPick === opt ? "var(--blue)" : "var(--grid)"}`,
                        background: mcPick === opt ? "var(--blue)" : "var(--paper)",
                        color: mcPick === opt ? "var(--on-accent)" : "var(--ink)",
                      }}>{opt}</button>
                    ))}
                  </div>
                )
              )}

              {(question.drawGraph || question.region || question.venn || question.placeVenn || question.choices || question.drawTransform || question.drawMirror) ? null : question.vector ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <span style={{ fontSize: 52, fontWeight: 200, lineHeight: 0.7, color: "var(--muted)" }}>(</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {["vx", "vy"].map((k, i) => (
                      <input key={k}
                        ref={i === 0 ? answerRef : undefined}
                        autoFocus={isDesktop && i === 0}
                        className="mub-mono" inputMode="numeric"
                        autoCapitalize="none" autoCorrect="off" spellCheck={false}
                        value={multiInput[k] || ""}
                        onChange={(e) => setMultiInput((m) => ({ ...m, [k]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") { feedback ? nextQuestion() : submitAnswer(); } }}
                        placeholder="?"
                        disabled={!!feedback || shieldOffer}
                        style={{ width: 74, padding: "8px 10px", fontSize: 17, textAlign: "center", border: "1px solid var(--grid)", borderRadius: 8, boxSizing: "border-box" }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 52, fontWeight: 200, lineHeight: 0.7, color: "var(--muted)" }}>)</span>
                </div>
              ) : question.fields ? (
                <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                  {question.fields.map((f, i) => (
                    <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="mub-mono" style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{f.label}</span>
                      <input
                        ref={i === 0 ? answerRef : undefined}
                        autoFocus={isDesktop && i === 0}
                        className="mub-mono"
                        autoCapitalize="none" autoCorrect="off" spellCheck={false}
                        value={multiInput[f.key] || ""}
                        onChange={(e) => setMultiInput((m) => ({ ...m, [f.key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") { feedback ? nextQuestion() : submitAnswer(); } }}
                        placeholder={f.placeholder || "?"}
                        disabled={!!feedback || shieldOffer}
                        style={{ width: 96, padding: "10px 12px", fontSize: 15, border: "1px solid var(--grid)", borderRadius: 8, boxSizing: "border-box" }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input
                    ref={answerRef}
                    autoFocus={isDesktop} className="mub-mono" value={answerInput}
                    autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    onChange={(e) => setAnswerInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { feedback ? nextQuestion() : submitAnswer(); } }}
                    placeholder={question.hint}
                    disabled={!!feedback || shieldOffer}
                    style={{ flex: 1, minWidth: 0, padding: "10px 12px", fontSize: 15, border: "1px solid var(--grid)", borderRadius: 8, boxSizing: "border-box" }}
                  />
                  {!feedback && myLevel >= WRITE_LV && (
                    <button type="button" onClick={() => setWritePad(true)} title="Write the answer by hand"
                      aria-label="Write the answer by hand"
                      style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--blue)", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "0 12px", cursor: "pointer" }}>
                      <Pencil size={16} />
                    </button>
                  )}
                </div>
              )}

              {!feedback && (() => {
                const ctx = `${question.hint || ""} ${question.answer || ""}`;
                const syms = question.symbols ? [...question.symbols] : [];
                if (/π/.test(ctx)) syms.push("π");
                if (/√|sqrt/i.test(ctx)) syms.push("√");
                if (question.topicId === "standardform" && /10\^/.test(question.answer || "")) syms.push("×10^");
                else if (/\^|²/.test(ctx)) syms.push("^");
                if (!syms.length) return null;
                return (
                  <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center" }}>insert:</span>
                    {syms.map((s) => (
                      <button key={s} type="button" onClick={() => insertSym(s)} className="mub-mono" style={{ fontSize: 15, minWidth: 36, padding: "4px 10px", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, cursor: "pointer", color: "var(--ink)" }}>{s}</button>
                    ))}
                  </div>
                );
              })()}

              {!feedback && !shieldOffer && question.steps && question.steps.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {hintShown ? (
                    <div style={{ fontSize: 12.5, background: "var(--amber-wash)", border: "1px solid var(--amber)", borderRadius: 8, padding: "9px 12px", color: "var(--ink)" }}>
                      <span style={{ fontWeight: 700, color: "var(--amber)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>🪙 Hint</span>
                      <div className="mub-mono" style={{ marginTop: 4 }}><MathText text={question.steps[0]} /></div>
                    </div>
                  ) : (
                    <button type="button" onClick={doHint} disabled={(profile.hints || 0) <= 0} style={{
                      fontSize: 12, fontWeight: 600,
                      color: (profile.hints || 0) > 0 ? "var(--amber)" : "var(--muted)",
                      background: "none", border: `1px solid ${(profile.hints || 0) > 0 ? "var(--amber)" : "var(--grid)"}`,
                      borderRadius: 8, padding: "6px 12px", cursor: (profile.hints || 0) > 0 ? "pointer" : "default",
                    }}>🪙 Hint · {profile.hints || 0} coin{(profile.hints || 0) === 1 ? "" : "s"}</button>
                  )}
                </div>
              )}

              {shieldOffer && (
                <div style={{ marginBottom: 12, background: "var(--paper)", border: "1.5px solid var(--blue)", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Not quite — but your streak of {profile.streak || 0} isn&rsquo;t gone yet.</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Spend a 🛟 Streak Shield (you have {profile.shields || 0}) to keep the streak and try this question again?</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={useShield} style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "9px 12px", cursor: "pointer" }}>🛟 Use Shield &amp; retry</button>
                    <button onClick={declineShield} style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>Show solution</button>
                  </div>
                </div>
              )}

              {!feedback && !shieldOffer && (() => {
                const notReady = (question.drawGraph && drawPts.length < 2)
                  || (question.region && !regionPick)
                  || (question.venn && vennPressed.length === 0)
                  || (question.placeVenn && question.placeVenn.universe.some((el) => vennPlace[el] == null))
                  || (question.choices && !mcPick)
                  || (question.drawMirror && drawPts.length < 2)
                  || (question.vector && (!(multiInput.vx || "").trim() || !(multiInput.vy || "").trim()))
                  || (question.drawTransform && drawTri.length !== 3)
                  || (question.drawSolve && (drawPts.length < 2 || (question.fields || []).some((f) => !(multiInput[f.key] || "").trim())));
                return (
                  <button onClick={submitAnswer} disabled={notReady} style={{ padding: "9px 18px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: notReady ? "default" : "pointer", opacity: notReady ? 0.5 : 1 }}>
                    Submit
                  </button>
                );
              })()}

              {feedback && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, flexWrap: "wrap" }}>
                    <div className={feedback.correct ? "mub-stamp" : "mub-wobble"} style={{
                      display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8,
                      border: `2px solid ${feedback.correct ? "var(--green)" : "var(--red)"}`,
                      color: feedback.correct ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 13,
                      transform: "rotate(-8deg)",
                    }}>
                      {feedback.correct ? <Check size={15} /> : <XIcon size={15} />}
                      {feedback.correct ? "CORRECT" : "TRY AGAIN"}
                    </div>
                    {feedback.forgiven && (
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--blue)", display: "flex", alignItems: "center", gap: 4 }}>
                        🛟 Error Correction — streak safe
                      </div>
                    )}
                    {feedback.rankedUp && (() => {
                      const ri = RANK_ORDER.indexOf(feedback.rankedUp.to);
                      const rc = rankDisplay(ri).color;
                      return (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div className="mub-rankpop" style={{
                            width: 34, height: 34, borderRadius: "50%", border: `3px solid ${rc}`,
                            color: rc, display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 800, fontSize: feedback.rankedUp.to.length > 1 ? 12 : 15, flexShrink: 0,
                          }}>{feedback.rankedUp.to}</div>
                          <div style={{ fontWeight: 700, fontSize: 12.5, color: rc }}>Rank up!</div>
                        </div>
                      );
                    })()}
                  </div>
                  {!feedback.correct && (
                    <div style={{ fontSize: 12.5, color: "var(--ink)", marginBottom: 12, background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "10px 12px" }}>
                      <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>How to solve it</div>
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {question.steps.map((s, i) => <li key={i} className="mub-mono" style={{ marginBottom: 4 }}><MathText text={s} /></li>)}
                      </ol>
                      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>Answer: <span className="mub-mono" style={{ fontWeight: 700 }}><MathText text={question.answerDisplay || question.answer} /></span></div>
                    </div>
                  )}
                  {feedback.unlocked.length > 0 && (
                    <div style={{ fontSize: 12.5, color: "var(--amber)", fontWeight: 600, marginBottom: 12 }}>
                      🎉 Achievement unlocked: {feedback.unlocked.map((a) => `${a.name} (${a.tier})`).join(", ")}
                    </div>
                  )}
                  {feedback.leveledTo && (
                    <div className="mub-stamp" style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12.5, color: "var(--blue)", fontWeight: 700, marginBottom: 6 }}>
                        ⭐ Level up! You&rsquo;re now Level {feedback.leveledTo}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--blue)", borderRadius: 8, padding: "9px 12px" }}>
                        <span style={{ fontWeight: 700, color: "var(--blue)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>🎁 Unlocked</span>
                        <div style={{ marginTop: 3 }}>{unlocksAtLevel(feedback.leveledTo).join(" · ")}</div>
                      </div>
                    </div>
                  )}
                  {feedback.expGain > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginBottom: 4, textAlign: "center" }}>
                        +{feedback.expGain} XP{feedback.xpDoubled && feedback.correct ? <span style={{ color: "var(--green)", fontWeight: 700 }}> · ⚡×2</span> : ""}
                      </div>
                      <LevelBar profile={profile} />
                    </div>
                  )}
                  <div>
                    <button ref={nextRef} onClick={nextQuestion} style={{ padding: "9px 18px", background: "var(--ink)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                      Next question →
                    </button>
                  </div>
                </div>
              )}

              {myLevel >= SKETCH_LV && (<>
                <SketchOverlay active={sketchOn} strokes={sketchStrokes} setStrokes={setSketchStrokes} />
                <button
                  onClick={() => setSketchOn((v) => !v)}
                  title={sketchOn ? "Hide rough working" : "Rough working"}
                  style={{
                    position: "absolute", bottom: 8, right: 8, zIndex: 6,
                    width: 34, height: 34, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1px solid ${sketchOn ? "var(--blue)" : "var(--grid)"}`,
                    background: sketchOn ? "var(--blue)" : "var(--card)",
                    color: sketchOn ? "var(--on-accent)" : "var(--muted)",
                    cursor: "pointer", boxShadow: "0 1px 4px var(--shadow-soft)", fontSize: 15, lineHeight: 1,
                  }}
                >
                  🗒
                </button>
              </>)}
            </div>
          </div>
        )}

        {/* PARENT LINK (read-only) */}
        {screen === "parent" && (
          <div>
            {(!parentView || parentView.__missing) ? (
              <div style={{ maxWidth: 420, margin: "48px auto", textAlign: "center" }}>
                <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Link not found</div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>This progress link is invalid or has expired. Ask the student for a fresh one from their dashboard.</div>
              </div>
            ) : (
              <div>
                <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{parentView.name}&rsquo;s progress</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 18 }}>
                  A read-only summary of practice on MathsUnlocked BN. Reload the page for the latest.
                </div>
                <StudentProfileView profile={parentView} />
              </div>
            )}
          </div>
        )}

        {/* FRIENDS */}
        {screen === "friends" && (
          <div>
            <button onClick={() => { if (friendView) setFriendView(null); else if (friendFind) setFriendFind(false); else setScreen("dashboard"); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> {friendView ? "back" : friendFind ? "my friends" : "back"}
            </button>
            {friendView ? (
              <div>
                <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{friendView.name}</div>
                {(() => {
                  const st = friendState(friendView.uid);
                  if (st === "self" || !friendView.uid) return null;
                  const busy = friendBusy === friendView.uid;
                  if (st === "friend") {
                    const myLv = levelFromExp(totalExp(profile));
                    const theirLv = levelFromExp(totalExp(friendView));
                    const canChallenge = myLv >= BLITZ_UNLOCK_LEVEL && theirLv >= BLITZ_UNLOCK_LEVEL;
                    const pend = myChallenges.find(
                      (c) => c.oppUid === friendView.uid && (c.needsMe || c.waiting || c.unseen)
                    );
                    return (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>✓ Friends</span>
                          <button onClick={() => doFriendAction("remove", friendView.uid)} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}>Remove</button>
                        </div>
                        {pend && pend.needsMe ? (
                          <button onClick={() => playChallenge(blitzChallenges.find((r) => r.id === pend.id))} style={{ fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--amber)", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer" }}>
                            ⚡ Play their challenge · beat {pend.oppScore}
                          </button>
                        ) : pend && pend.waiting ? (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>⚡ Challenge sent — you scored {pend.myScore}, waiting for {friendView.name}.</div>
                        ) : pend && pend.unseen ? (
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: pend.won ? "var(--green)" : pend.lost ? "var(--red)" : "var(--muted)" }}>
                            ⚡ {pend.won ? "You won" : pend.lost ? "You lost" : "Tie"} {pend.myScore}–{pend.oppScore}
                          </div>
                        ) : canChallenge ? (
                          <button onClick={() => startChallenge(friendView)} style={{ fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer" }}>
                            ⚡ Challenge to Blitz
                          </button>
                        ) : (
                          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Blitz challenges unlock at Level {BLITZ_UNLOCK_LEVEL} for both players.</div>
                        )}
                      </div>
                    );
                  }
                  if (st === "incoming") return (
                    <button onClick={() => doFriendAction("accept", friendView.uid)} disabled={busy} style={{ marginBottom: 14, fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>Accept friend request</button>
                  );
                  if (st === "outgoing") return <div style={{ marginBottom: 14, fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>Friend request sent</div>;
                  return (
                    <button onClick={() => doFriendAction("request", friendView.uid)} disabled={busy} style={{ marginBottom: 14, fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}>+ Add friend</button>
                  );
                })()}
                <StudentProfileView profile={friendView} />
              </div>
            ) : !friendFind ? (
              <div>
                {(() => {
                  const seen = profile.seenFriends || [];
                  const row = (uid, actions, showDot) => {
                    const p = friendPeople[uid];
                    return (
                      <div key={uid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "1px solid var(--grid)", borderRadius: 10, position: "relative" }}>
                        {showDot && <span style={{ position: "absolute", top: -4, left: -4, width: 10, height: 10, borderRadius: "50%", background: "var(--red)", border: "2px solid var(--paper)", boxSizing: "border-box" }} />}
                        {p ? <MiniAvatar profile={p} size={30} /> : <span style={{ width: 30, flexShrink: 0 }} />}
                        <button onClick={() => p && setFriendView(p)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: p ? "pointer" : "default", padding: 0, color: "var(--ink)" }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{p ? p.name : "Student"}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p ? `Lv ${levelFromExp(totalExp(p))}${p.school && p.school !== SOLO_SCHOOL ? ` · ${p.school}` : ""}` : ""}</div>
                        </button>
                        {actions}
                      </div>
                    );
                  };
                  return (<>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 10 }}>
                      <div className="mub-display" style={{ fontSize: 20, fontWeight: 700 }}>Friends <span style={{ fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>{friendGraph.friends.length}</span></div>
                      <button onClick={() => { setFriendFind(true); setFriendResults(null); setFriendQuery(""); }} style={{ fontSize: 12.5, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "7px 13px", cursor: "pointer", flexShrink: 0 }}>Find friends</button>
                    </div>
                    {friendGraph.incoming.length > 0 && (<>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Requests</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                        {friendGraph.incoming.map((uid) => row(uid, (
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button onClick={() => doFriendAction("accept", uid)} style={{ fontSize: 12, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "5px 11px", cursor: "pointer" }}>Accept</button>
                            <button onClick={() => doFriendAction("remove", uid)} aria-label="Decline" style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 9px", cursor: "pointer" }}>✕</button>
                          </div>
                        ), true))}
                      </div>
                    </>)}
                    {(() => {
                      const active = myChallenges.filter((c) => c.needsMe || c.waiting || c.unseen);
                      if (!active.length) return null;
                      const nameOf = (c) => (c.opp && c.opp.name) || "Friend";
                      return (<>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Blitz challenges</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                          {active.map((c) => (
                            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "1px solid var(--grid)", borderRadius: 10, position: "relative" }}>
                              {(c.needsMe || c.unseen) && <span style={{ position: "absolute", top: -4, left: -4, width: 10, height: 10, borderRadius: "50%", background: "var(--red)", border: "2px solid var(--paper)", boxSizing: "border-box" }} />}
                              {c.opp ? <MiniAvatar profile={c.opp} size={30} /> : <span style={{ width: 30, flexShrink: 0 }} />}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>{nameOf(c)}</div>
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                                  {c.needsMe ? `Challenged you — beat ${c.oppScore}`
                                    : c.waiting ? `You scored ${c.myScore} — waiting for them`
                                    : c.won ? `You won ${c.myScore}–${c.oppScore} 🏆`
                                    : c.lost ? `You lost ${c.myScore}–${c.oppScore}`
                                    : `Tie ${c.myScore}–${c.oppScore}`}
                                </div>
                              </div>
                              {c.needsMe && (
                                <button onClick={() => playChallenge(blitzChallenges.find((r) => r.id === c.id))} style={{ fontSize: 12, fontWeight: 700, color: "var(--on-accent)", background: "var(--amber)", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", flexShrink: 0 }}>Play</button>
                              )}
                            </div>
                          ))}
                        </div>
                      </>);
                    })()}
                    {friendGraph.friends.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 20 }}>No friends yet. Tap <b>Find friends</b> to search and send a request.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                        {friendGraph.friends.map((uid) => row(uid, null, !seen.includes(uid)))}
                      </div>
                    )}
                    {friendGraph.outgoing.length > 0 && (
                      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 16 }}>{friendGraph.outgoing.length} request{friendGraph.outgoing.length === 1 ? "" : "s"} sent, waiting for a reply.</div>
                    )}
                  </>);
                })()}
              </div>
            ) : (
              <div>
                <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Find friends</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>Search by name, open a profile, then send a request.</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <input
                    value={friendQuery} onChange={(e) => setFriendQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") runFriendSearch(); }}
                    placeholder="e.g. Nurul"
                    style={{ flex: 1, minWidth: 0, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
                  />
                  <button onClick={runFriendSearch} disabled={!friendQuery.trim() || friendLoading} style={{ fontSize: 13, fontWeight: 600, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "0 16px", cursor: "pointer", opacity: !friendQuery.trim() || friendLoading ? 0.6 : 1 }}>
                    Search
                  </button>
                </div>
                {friendLoading ? (
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>Searching…</div>
                ) : friendResults === null ? null : friendResults.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>No one found matching “{friendQuery.trim()}”.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {friendResults.map((s, i) => {
                      const st = friendState(s.uid);
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 10, background: "var(--card)", color: "var(--ink)" }}>
                          <MiniAvatar profile={s} size={30} />
                          <button onClick={() => { setFriendView(s); markMilestone("friendview"); }} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--ink)" }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Lv {levelFromExp(totalExp(s))}{s.school && s.school !== SOLO_SCHOOL ? ` · ${s.school}` : ""}</div>
                          </button>
                          {st === "friend" ? <span style={{ fontSize: 12, fontWeight: 700, color: "var(--green)", flexShrink: 0 }}>✓</span>
                            : st === "outgoing" ? <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>sent</span>
                            : st === "incoming" ? <button onClick={() => doFriendAction("accept", s.uid)} style={{ fontSize: 12, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "5px 10px", cursor: "pointer", flexShrink: 0 }}>Accept</button>
                            : st === "none" ? <button onClick={() => doFriendAction("request", s.uid)} disabled={friendBusy === s.uid} style={{ fontSize: 12, fontWeight: 700, color: "var(--blue)", background: "none", border: "1px solid var(--blue)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", flexShrink: 0 }}>+ Add</button>
                            : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* BLITZ */}
        {screen === "blitz" && (
          <div>
            <button onClick={leaveBlitz} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> {blitzPhase === "playing" ? "end run" : "back"}
            </button>

            {blitzPhase === "intro" && (() => {
              const ch = challengeRef.current;
              return (
              <div style={{ maxWidth: 460, margin: "0 auto", textAlign: "center", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: "28px 22px" }}>
                <div style={{ fontSize: 44 }}>⚡</div>
                <div className="mub-display" style={{ fontSize: 22, fontWeight: 700, margin: "6px 0 10px" }}>
                  {ch ? `Blitz vs ${ch.opponentName}` : "Blitz"}
                </div>
                {ch && ch.mode === "play" && (
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--amber)", marginBottom: 8 }}>
                    {ch.opponentName} scored {ch.opponentScore} — beat it!
                  </div>
                )}
                <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6, marginBottom: 6 }}>
                  {ch
                    ? `Same ${BLITZ_SECONDS} seconds, same questions for both of you. One tap each, locks straight in.`
                    : `${BLITZ_SECONDS} seconds. Questions from any topic, all answered with one tap. Your answer locks in and jumps straight to the next.`}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 18 }}>
                  Every correct answer is still worth +{CORRECT_XP} XP. Your best score: <b style={{ color: "var(--ink)" }}>{profile.blitzBest || 0}</b>
                </div>
                <button onClick={beginBlitzRun} style={{ padding: "12px 28px", background: "var(--blue)", color: "var(--on-accent)", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                  {ch && ch.mode === "create" ? "Play your run" : "Start"}
                </button>
              </div>
              );
            })()}

            {blitzPhase === "playing" && blitzQ && (
              <div style={{ maxWidth: 480, margin: "0 auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div style={{ flex: 1, height: 10, background: "var(--locked)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${(blitzLeft / BLITZ_SECONDS) * 100}%`, height: "100%", background: blitzLeft <= 6 ? "var(--red)" : "var(--blue)", borderRadius: 999, transition: "width 0.2s linear" }} />
                  </div>
                  <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, color: blitzLeft <= 6 ? "var(--red)" : "var(--ink)", minWidth: 26, textAlign: "right" }}>{blitzLeft}s</div>
                  <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, color: "var(--green)", minWidth: 54, textAlign: "right" }}>★ {blitzScore}</div>
                </div>

                <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderLeft: "4px solid var(--blue)", borderRadius: 10, padding: "16px 16px 18px" }}>
                  <div className="mub-mono" style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, lineHeight: 1.4 }}><MathText text={blitzQ.prompt} /></div>

                  {blitzQ.transform && <TransformFigure a={blitzQ.transform.a} b={blitzQ.transform.b} centre={blitzQ.transform.centre} />}
                  {blitzQ.figure && <ShapeFigure shape={blitzQ.figure.shape} />}
                  {blitzQ.venn && (
                    <div style={{ marginBottom: 8 }}>
                      <VennShade venn={blitzQ.venn} pressed={blitzPick && !blitzPick.correct ? [blitzPick.value] : []} showAnswer={!!blitzPick}
                        onToggle={blitzPick ? null : answerBlitzVenn} />
                      <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>tap the matching region</div>
                    </div>
                  )}

                  {blitzQ.choices && (() => {
                    const twoCol = blitzQ.choices.length === 4;
                    const longLabel = blitzQ.choices.some((c) => c.length > 9);
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: twoCol ? "1fr 1fr" : "1fr", gap: 8 }}>
                        {blitzQ.choices.map((opt) => {
                          const picked = blitzPick && blitzPick.value === opt;
                          const isAns = blitzPick && opt === blitzQ.answer;
                          const bg = picked ? (blitzPick.correct ? "var(--green)" : "var(--red)") : isAns ? "var(--green)" : "var(--paper)";
                          const fg = picked || isAns ? "var(--on-accent)" : "var(--ink)";
                          return (
                            <button key={opt} type="button" disabled={!!blitzPick} onClick={() => answerBlitz(opt)}
                              style={{ padding: twoCol ? "14px 6px" : "13px 12px", fontSize: twoCol && longLabel ? 13.5 : 15, fontWeight: 700, cursor: blitzPick ? "default" : "pointer", borderRadius: 10, border: `1.5px solid ${bg === "var(--paper)" ? "var(--grid)" : bg}`, background: bg, color: fg, transition: "background 0.1s" }}>
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {blitzPhase === "over" && blitzResult && (
              <div style={{ maxWidth: 460, margin: "0 auto", textAlign: "center", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: "28px 22px" }}>
                <div style={{ fontSize: 40 }}>{challengeResult ? "⚡" : "⏱️"}</div>
                <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 14px" }}>Time&rsquo;s up!</div>
                <div className="mub-display" style={{ fontSize: 48, fontWeight: 800, color: "var(--blue)", lineHeight: 1 }}>{blitzResult.score}</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>correct in {BLITZ_SECONDS}s</div>

                {challengeResult ? (
                  challengeBusy ? (
                    <div style={{ fontSize: 13, color: "var(--muted)", margin: "14px 0" }}>Saving your challenge…</div>
                  ) : challengeResult.mode === "create" ? (
                    <div style={{ fontSize: 13, color: "var(--muted)", margin: "14px 0", lineHeight: 1.6 }}>
                      Challenge {challengeResult.failed ? "couldn't be sent — try again from their profile." : <>sent to <b style={{ color: "var(--ink)" }}>{challengeResult.opponentName}</b>. They&rsquo;ll play the same questions and try to beat <b style={{ color: "var(--ink)" }}>{challengeResult.myScore}</b>.</>}
                    </div>
                  ) : (() => {
                    const me = challengeResult.myScore, them = challengeResult.opponentScore;
                    const win = me > them, tie = me === them;
                    return (
                      <div style={{ margin: "14px 0" }}>
                        <div className="mub-stamp" style={{ fontSize: 18, fontWeight: 800, color: win ? "var(--green)" : tie ? "var(--muted)" : "var(--red)" }}>
                          {win ? "You win! 🏆" : tie ? "It's a tie" : "You lost"}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
                          You <b style={{ color: "var(--ink)" }}>{me}</b> &nbsp;·&nbsp; {challengeResult.opponentName} <b style={{ color: "var(--ink)" }}>{them}</b>
                        </div>
                      </div>
                    );
                  })()
                ) : blitzResult.newBest ? (
                  <div className="mub-stamp" style={{ fontSize: 14, fontWeight: 800, color: "var(--green)", margin: "12px 0" }}>🎉 New best!</div>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--muted)", margin: "12px 0" }}>Your best: <b style={{ color: "var(--ink)" }}>{blitzResult.best}</b></div>
                )}

                {blitzResult.unlocked.length > 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--amber)", fontWeight: 700, marginBottom: 12 }}>
                    🏆 {blitzResult.unlocked.map((a) => `${a.name} (${a.tier})`).join(", ")}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                  {!challengeResult && (
                    <button onClick={beginBlitzRun} style={{ padding: "10px 22px", background: "var(--blue)", color: "var(--on-accent)", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Play again</button>
                  )}
                  <button onClick={leaveBlitz} style={{ padding: "10px 22px", background: "none", border: "1px solid var(--grid)", borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: "pointer", color: "var(--ink)" }}>{challengeResult ? "Done" : "Back"}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SCHOOL LEADERBOARD */}
        {screen === "leaderboard" && (
          <div>
            <button onClick={() => setScreen(profile.name ? "dashboard" : "login")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> back
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
              <div className="mub-display" style={{ fontSize: 20, fontWeight: 700 }}>Leaderboard</div>
              <button onClick={loadBoard} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <RotateCcw size={12} /> refresh
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, margin: "10px 0 14px" }}>
              {[["school", "School"], ["players", "Top players"], ["friends", "Friends"]].map(([id, label]) => (
                <button key={id} onClick={() => { setBoardTab(id); setOpenSchool(null); }} style={{
                  flex: 1, padding: "7px 10px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", borderRadius: 8,
                  border: `1.5px solid ${boardTab === id ? "var(--blue)" : "var(--grid)"}`,
                  background: boardTab === id ? "var(--blue)" : "var(--paper)",
                  color: boardTab === id ? "var(--on-accent)" : "var(--muted)",
                }}>{label}</button>
              ))}
            </div>

            {!board || board.loading ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>
            ) : boardTab === "school" ? (
              <div>
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  {[["alltime", "All-time"], ["week", "This week"]].map(([id, label]) => (
                    <button key={id} onClick={() => { setSchoolSubTab(id); setOpenSchool(null); }} style={{
                      padding: "5px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", borderRadius: 999,
                      border: `1px solid ${schoolSubTab === id ? "var(--blue)" : "var(--grid)"}`,
                      background: schoolSubTab === id ? "var(--blue)" : "none",
                      color: schoolSubTab === id ? "var(--on-accent)" : "var(--muted)",
                    }}>{label}</button>
                  ))}
                </div>
                {schoolSubTab === "week" ? (
                  <div>
                    {board.lastChampion && (
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--amber)", background: "var(--amber-wash)", border: "1px solid var(--amber)", borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
                        🏆 Last week: {board.lastChampion.name} · {board.lastChampion.lastXp.toLocaleString()} XP
                      </div>
                    )}
                    {(board.weekly || []).length === 0 ? (
                      <div style={{ fontSize: 13, color: "var(--muted)" }}>No XP earned yet this week — be the first to put your school on the board.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {board.weekly.map((s, i) => {
                          const mine = profile.school && profile.school !== SOLO_SCHOOL && s.name === profile.school;
                          const rankColor = ["#D4A017", "#9AA3AE", "#B07437"][i] || "var(--blue)";
                          const expanded = openSchool === s.name;
                          return (
                            <div key={s.name} style={{ border: `1px solid ${mine ? "var(--blue)" : "var(--grid)"}`, borderRadius: 12, background: "var(--card)", overflow: "hidden" }}>
                              <button onClick={() => setOpenSchool(expanded ? null : s.name)}
                                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left", color: "var(--ink)" }}>
                                <span className="mub-display" style={{ fontSize: 18, fontWeight: 700, color: rankColor, minWidth: 30, flexShrink: 0 }}>#{i + 1}</span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, fontSize: 13 }}>{s.name}{mine ? " · your school" : ""}</div>
                                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.active} active this week · tap to {expanded ? "hide" : "see"} who</div>
                                </div>
                                <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{s.xp.toLocaleString()}</div>
                                <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
                              </button>
                              {expanded && (
                                <div style={{ borderTop: "1px solid var(--grid)" }}>
                                  {s.contributors.map((c, j) => (
                                    <button key={j} onClick={() => { if (c.full) { setRosterProfile(c.full); markMilestone("friendview"); } }}
                                      style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", padding: "9px 14px", textAlign: "left", cursor: "pointer", color: "var(--ink)", background: "none", border: "none", borderTop: j === 0 ? "none" : "1px solid var(--grid)" }}>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", flexShrink: 0 }}>{j + 1}</span>
                                      {c.full && <MiniAvatar profile={c.full} size={30} />}
                                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                        <span style={{ textDecoration: "underline", textDecorationColor: "var(--grid)", textUnderlineOffset: 2 }}>{c.name}</span>
                                        {c.prestige > 0 && <PrestigeBadge prestige={c.prestige} size={13} />}
                                        <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--muted)" }}>Level {c.level}</span>
                                      </div>
                                      <div className="mub-display" style={{ fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{c.xp.toLocaleString()}</div>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : board.schools.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>No schools ranked yet — students choose a school when they register.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {board.schools.map((s, i) => {
                      const mine = profile.school && profile.school !== SOLO_SCHOOL && s.name === profile.school;
                      const rankColor = ["#D4A017", "#9AA3AE", "#B07437"][i] || "var(--blue)";
                      const expanded = openSchool === s.name;
                      return (
                        <div key={s.name} style={{ border: `1px solid ${mine ? "var(--blue)" : "var(--grid)"}`, borderRadius: 12, background: "var(--card)", overflow: "hidden" }}>
                          <button
                            onClick={() => setOpenSchool(expanded ? null : s.name)}
                            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left", color: "var(--ink)" }}
                          >
                            <span className="mub-display" style={{ fontSize: 18, fontWeight: 700, color: rankColor, minWidth: 30, flexShrink: 0 }}>#{i + 1}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 13 }}>{s.name}{mine ? " · your school" : ""}</div>
                              <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.members} student{s.members === 1 ? "" : "s"} · tap to {expanded ? "hide" : "see"} the top {Math.min(20, s.roster.length)}</div>
                            </div>
                            <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{s.score}</div>
                            <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
                          </button>

                          {!expanded && s.top.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 14px 12px" }}>
                              {s.top.map((m, j) => (
                                <span key={j} style={{ fontSize: 10.5, color: "var(--muted)", border: "1px solid var(--grid)", borderRadius: 999, padding: "2px 7px" }}>
                                  {m.name} · {m.prestige ? `P${m.prestige} ` : ""}L{m.level}
                                </span>
                              ))}
                            </div>
                          )}

                          {expanded && (
                            <div style={{ borderTop: "1px solid var(--grid)" }}>
                              {s.roster.map((m, j) => {
                                const rk = m.bestRank >= 0 ? rankDisplay(m.bestRank) : null;
                                return (
                                  <button key={j} onClick={() => { if (m.full) { setRosterProfile(m.full); markMilestone("friendview"); } }}
                                    style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", padding: "9px 14px", textAlign: "left", cursor: "pointer", color: "var(--ink)", background: "none", border: "none", borderTop: j === 10 ? "2px dashed var(--amber)" : j === 0 ? "none" : "1px solid var(--grid)" }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", flexShrink: 0 }}>{j + 1}</span>
                                    {m.full && <MiniAvatar profile={m.full} size={30} />}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                        <span style={{ textDecoration: "underline", textDecorationColor: "var(--grid)", textUnderlineOffset: 2 }}>{m.name}</span>
                                        {m.prestige > 0 && <PrestigeBadge prestige={m.prestige} size={13} />}
                                        {rk && <span style={{ fontSize: 10, fontWeight: 800, color: rk.color, border: `1px solid ${rk.color}`, borderRadius: 4, padding: "0 4px" }}>{rk.label}</span>}
                                      </div>
                                      <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                                        {m.title} · Level {m.level} · {m.achievements} achievement{m.achievements === 1 ? "" : "s"}
                                      </div>
                                    </div>
                                    <div className="mub-display" style={{ fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{m.score}</div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : boardTab === "players" ? (
              (board.players || []).length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--muted)" }}>No players ranked yet.</div>
              ) : (
                <div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {board.players.map((m, i) => {
                      const mine = m.full && ((authUid && m.full.uid === authUid) || (!authUid && profile.name === m.name));
                      const rankColor = ["#D4A017", "#9AA3AE", "#B07437"][i] || "var(--muted)";
                      const rk = m.bestRank >= 0 ? rankDisplay(m.bestRank) : null;
                      return (
                        <button key={i} onClick={() => { if (m.full) { setRosterProfile(m.full); markMilestone("friendview"); } }}
                          style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 12px", textAlign: "left", cursor: "pointer",
                            color: "var(--ink)", background: "var(--card)", border: `1px solid ${mine ? "var(--blue)" : "var(--grid)"}`, borderRadius: 10 }}>
                          <span className="mub-display" style={{ fontSize: 16, fontWeight: 700, color: rankColor, flexShrink: 0 }}>#{i + 1}</span>
                          {m.full && <MiniAvatar profile={m.full} size={30} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ textDecoration: "underline", textDecorationColor: "var(--grid)", textUnderlineOffset: 2 }}>{m.name}</span>
                              {mine ? <span style={{ fontSize: 10, color: "var(--blue)", fontWeight: 700 }}>you</span> : null}
                              {m.prestige > 0 && <PrestigeBadge prestige={m.prestige} size={13} />}
                              {rk && <span style={{ fontSize: 10, fontWeight: 800, color: rk.color, border: `1px solid ${rk.color}`, borderRadius: 4, padding: "0 4px" }}>{rk.label}</span>}
                            </div>
                            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                              {m.title} · Level {m.level}{m.school ? ` · ${m.school}` : ""}
                            </div>
                          </div>
                          <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, flexShrink: 0 }}>{m.score}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )
            ) : (() => {
              // Friends tab: you + your accepted friends, ranked together.
              const entries = [toBoardEntry({ ...profile, uid: authUid })];
              (friendGraph.friends || []).forEach((uid) => {
                const p = friendPeople[uid];
                if (p) entries.push(toBoardEntry(p));
              });
              entries.sort((a, b) => b.score - a.score || a.at - b.at || a.name.localeCompare(b.name));
              if (entries.length <= 1) {
                return (
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>
                    Add friends to see how you stack up. <button onClick={openFriends} style={{ color: "var(--blue)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13 }}>Find friends →</button>
                  </div>
                );
              }
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {entries.map((m, i) => {
                    const mine = m.full && m.full.uid === authUid;
                    const rankColor = ["#D4A017", "#9AA3AE", "#B07437"][i] || "var(--muted)";
                    const rk = m.bestRank >= 0 ? rankDisplay(m.bestRank) : null;
                    return (
                      <button key={i} onClick={() => { if (!mine && m.full) { setRosterProfile(m.full); markMilestone("friendview"); } }}
                        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "10px 12px", textAlign: "left", cursor: mine ? "default" : "pointer",
                          color: "var(--ink)", background: "var(--card)", border: `1px solid ${mine ? "var(--blue)" : "var(--grid)"}`, borderRadius: 10 }}>
                        <span className="mub-display" style={{ fontSize: 16, fontWeight: 700, color: rankColor, flexShrink: 0 }}>#{i + 1}</span>
                        {m.full && <MiniAvatar profile={m.full} size={30} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ textDecoration: "underline", textDecorationColor: "var(--grid)", textUnderlineOffset: 2 }}>{m.name}</span>
                            {mine ? <span style={{ fontSize: 10, color: "var(--blue)", fontWeight: 700 }}>you</span> : null}
                            {m.prestige > 0 && <PrestigeBadge prestige={m.prestige} size={13} />}
                            {rk && <span style={{ fontSize: 10, fontWeight: 800, color: rk.color, border: `1px solid ${rk.color}`, borderRadius: 4, padding: "0 4px" }}>{rk.label}</span>}
                          </div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                            {m.title} · Level {m.level}{m.school ? ` · ${m.school}` : ""}
                          </div>
                        </div>
                        <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, flexShrink: 0 }}>{m.score}</div>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      <div style={{ padding: "16px 16px 22px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: "var(--muted)" }}>
        <a href="https://www.instagram.com/mathsunlockedbn?igsi=MThmZWl6Y3E5YW9rNg==" target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)", textDecoration: "none", fontWeight: 700 }}>
          MathsUnlockedBN <Instagram size={13} />
        </a>
        <span style={{ opacity: 0.6 }}>|</span>
        <span>© 2026 MathsUnlockedBN &nbsp;·&nbsp; All rights reserved</span>
      </div>

      {showCard && (
        <div
          onClick={() => { setShowCard(false); setPickIcon(false); setPickBanner(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px", zIndex: 50, overflowY: "auto" }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setShowCard(false); setPickIcon(false); setPickBanner(false); }}
            aria-label="Close" title="Close"
            style={{ position: "fixed", top: 16, right: 16, width: 34, height: 34, borderRadius: "50%", background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.4)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 51 }}
          >
            <XIcon size={18} />
          </button>
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <ProfileCard profile={profile} onEditIcon={() => setPickIcon(true)} onEditBanner={() => setPickBanner(true)} newIcons={newIconCount > 0} />
            <button onClick={() => setStylePickerOpen(true)} style={{ fontSize: 12, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>🎨 Style — sound, title, background</button>
            <div style={{ fontSize: 11, color: "#fff", opacity: 0.8 }}>Tap your icon or banner to customise · screenshot to share</div>
          </div>
        </div>
      )}
      {pickIcon && <IconPickerModal profile={profile} onChange={patchProfile} onClose={() => setPickIcon(false)} />}
      {pickBanner && <BannerPickerModal profile={profile} onChange={patchProfile} onClose={() => setPickBanner(false)} />}
      {stylePickerOpen && <StyleModal profile={profile} onChange={patchProfile} onClose={() => setStylePickerOpen(false)} previewPack={previewPack} />}
      {writePad && question && (
        <WritePad
          mode={/^[\s\d.,/+−-]+$/.test(String(question.answerDisplay || question.answer || "").trim()) && /\d/.test(String(question.answer || "")) ? "number" : "any"}
          onInsert={(t) => { setAnswerInput(t); setTimeout(() => answerRef.current && answerRef.current.focus(), 0); }}
          onConfirm={(t) => { setAnswerInput(t); submitAnswer(t); }}
          onClose={() => setWritePad(false)}
        />
      )}

      {rosterProfile && (
        <div onClick={() => setRosterProfile(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", zIndex: 60, overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, background: "var(--page-bg)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, maxWidth: 460, width: "100%", fontFamily: "Inter, sans-serif" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
              <div className="mub-display" style={{ fontSize: 18, fontWeight: 700 }}>{rosterProfile.name}</div>
              <button onClick={() => setRosterProfile(null)} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}>Close</button>
            </div>
            <StudentProfileView profile={rosterProfile} />
          </div>
        </div>
      )}

      {showSchool && (() => {
        const q = schoolEditQuery.trim().toLowerCase();
        const hits = q ? ALL_SCHOOLS.filter((s) => s.toLowerCase().includes(q)) : ALL_SCHOOLS;
        const row = { display: "block", width: "100%", textAlign: "left", padding: "9px 12px", fontSize: 13, background: "none", border: "none", borderBottom: "1px solid var(--grid)", cursor: "pointer", color: "var(--ink)" };
        return (
          <div onClick={() => setShowSchool(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...vars, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 400, width: "100%", fontFamily: "Inter, sans-serif" }}>
              <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Your school</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>Currently: {profile.school && profile.school !== SOLO_SCHOOL ? profile.school : "Solo / Independent"}</div>
              <input
                autoFocus value={schoolEditQuery} onChange={(e) => setSchoolEditQuery(e.target.value)}
                placeholder="Type to search…"
                style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", marginBottom: 10 }}
              />
              <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--grid)", borderRadius: 8 }}>
                <button type="button" onClick={() => setSchoolAndClose(SOLO_SCHOOL)} style={{ ...row, fontWeight: 600 }}>Solo / Independent</button>
                {hits.map((s) => (
                  <button key={s} type="button" onClick={() => setSchoolAndClose(s)} style={row}>{s}</button>
                ))}
                {hits.length === 0 && <div style={{ padding: "9px 12px", fontSize: 12.5, color: "var(--muted)" }}>No match.</div>}
              </div>
            </div>
          </div>
        );
      })()}

      {perksOpen && (() => {
        const equipped = (profile.perks || []).filter((p) => PERKS[p]);
        return (
          <div onClick={() => setPerksOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "100%", maxWidth: 400, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, boxShadow: "0 14px 44px var(--shadow)", fontFamily: "Inter, sans-serif" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="mub-display" style={{ fontSize: 17, fontWeight: 700 }}>Perks</span>
                <button onClick={() => setPerksOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}><XIcon size={16} /></button>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Equip up to 2. They apply in every quiz{equipped.includes("momentum") || myLevel >= PERKS.momentum.lv ? " (Momentum works in Blitz too)" : ""}. <b style={{ color: "var(--ink)" }}>{equipped.length}/2</b> equipped.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {PERK_IDS.map((id) => {
                  const p = PERKS[id];
                  const owned = myLevel >= p.lv;
                  const on = equipped.includes(id);
                  const full = !on && equipped.length >= 2;
                  return (
                    <button key={id} type="button" disabled={!owned || full} onClick={() => togglePerk(id)} style={{
                      display: "flex", alignItems: "flex-start", gap: 12, width: "100%", textAlign: "left", padding: "11px 12px", borderRadius: 10, cursor: owned && !full ? "pointer" : "default",
                      background: on ? "var(--paper)" : "transparent",
                      border: `1.5px solid ${on ? "var(--green)" : "var(--grid)"}`,
                      opacity: owned ? (full ? 0.55 : 1) : 0.5,
                    }}>
                      <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1.2 }}>{owned ? p.icon : "🔒"}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</span>
                        {!owned && <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}> · Level {p.lv}</span>}
                        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{p.desc}</div>
                      </span>
                      <span style={{ fontSize: 13, color: "var(--green)", fontWeight: 800, flexShrink: 0 }}>{on ? "✓" : ""}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {inventoryOpen && (() => {
        const boostActive = (profile.boostUntil || 0) > Date.now();
        const boostMins = Math.max(1, Math.ceil(((profile.boostUntil || 0) - Date.now()) / 60000));
        const items = [
          { icon: "🗝", n: profile.keys || 0, name: "Skeleton Key", desc: "Opens a locked topic early — use it from a locked topic's card." },
          { icon: "🪙", n: profile.hints || 0, name: "Hint coin", desc: "Reveals the first working step of a question. +1 every level up." },
          { icon: "🛟", n: profile.shields || 0, name: "Streak Shield", desc: "Keeps your streak alive after a wrong answer, and lets you retry." },
        ];
        return (
          <div onClick={() => setInventoryOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "100%", maxWidth: 400, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, boxShadow: "0 14px 44px var(--shadow)", fontFamily: "Inter, sans-serif" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span className="mub-display" style={{ fontSize: 17, fontWeight: 700 }}>🎒 Inventory</span>
                <button onClick={() => setInventoryOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}><XIcon size={16} /></button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {items.map((it) => (
                  <div key={it.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 10, opacity: it.n > 0 ? 1 : 0.55 }}>
                    <span style={{ fontSize: 22, flexShrink: 0 }}>{it.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{it.name}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{it.desc}</div>
                    </div>
                    <span className="mub-display" style={{ fontSize: 20, fontWeight: 800, flexShrink: 0 }}>{it.n}</span>
                  </div>
                ))}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: `1px solid ${boostActive ? "var(--green)" : "var(--grid)"}`, borderRadius: 10, opacity: (profile.boosts || 0) > 0 || boostActive ? 1 : 0.55 }}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>⚡</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>XP Boost</div>
                    <div style={{ fontSize: 11, color: boostActive ? "var(--green)" : "var(--muted)", marginTop: 1, fontWeight: boostActive ? 700 : 400 }}>
                      {boostActive ? `Active — ${boostMins} min left` : "Doubles the +2 XP per correct answer for one hour."}
                    </div>
                  </div>
                  {!boostActive && (profile.boosts || 0) > 0 && (
                    <button onClick={activateBoost} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "5px 11px", cursor: "pointer" }}>Activate</button>
                  )}
                  {!boostActive && (profile.boosts || 0) === 0 && (
                    <span className="mub-display" style={{ fontSize: 20, fontWeight: 800, flexShrink: 0 }}>0</span>
                  )}
                  {boostActive && (profile.boosts || 0) > 0 && (
                    <span style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>{profile.boosts} more</span>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12 }}>Items come from levelling up. Keep grinding.</div>
            </div>
          </div>
        );
      })()}

      {achOpen && (
        <div onClick={() => setAchOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "100%", maxWidth: 420, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, boxShadow: "0 14px 44px var(--shadow)", fontFamily: "Inter, sans-serif" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <span className="mub-display" style={{ fontSize: 17, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                <Trophy size={16} /> Achievements
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}>
                  {(profile.achievements || []).filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length}/{ACHIEVEMENTS.length}
                </span>
              </span>
              <button onClick={() => setAchOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}><XIcon size={16} /></button>
            </div>
            <button onClick={() => setAchHideDone((v) => !v)} style={{
              fontSize: 12, fontWeight: 600, marginBottom: 14, cursor: "pointer",
              color: achHideDone ? "var(--on-accent)" : "var(--muted)",
              background: achHideDone ? "var(--blue)" : "none",
              border: `1px solid ${achHideDone ? "var(--blue)" : "var(--grid)"}`, borderRadius: 999, padding: "5px 12px",
            }}>{achHideDone ? "✓ Hiding completed" : "Hide completed"}</button>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {TIERS.map((tier) => {
                const all = ACHIEVEMENTS.filter((a) => a.tier === tier);
                const earned = all.filter((a) => (profile.achievements || []).includes(a.id)).length;
                if (tier === "Diamond" && earned === 0) return null; // whole tier stays hidden until unlocked
                const items = achHideDone ? all.filter((a) => !(profile.achievements || []).includes(a.id)) : all;
                if (!items.length) return null;
                const tc = TIER_COLOR[tier];
                return (
                  <div key={tier}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 9, height: 9, background: tc, transform: "rotate(45deg)", display: "inline-block" }} />
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: tc }}>{tier}</span>
                      <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{earned}/{all.length}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {items.map((a) => {
                        const unlocked = (profile.achievements || []).includes(a.id);
                        const hidden = a.secret && !unlocked;
                        return (
                          <div key={a.id} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10,
                            background: unlocked ? "var(--card)" : "transparent",
                            border: `1px solid ${unlocked ? tc : "var(--grid)"}`,
                            boxShadow: unlocked ? `inset 0 0 0 2px ${tc}22` : "none",
                            opacity: unlocked ? 1 : 0.45, fontSize: 12.5,
                          }}>
                            <span style={{ fontSize: 18, flexShrink: 0, filter: unlocked ? "none" : "grayscale(1)" }}>{hidden ? "❔" : a.icon}</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700 }}>{hidden ? "???" : a.name}</div>
                              <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{hidden ? "Secret — revealed when earned" : a.desc}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {achHideDone && (profile.achievements || []).filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length === ACHIEVEMENTS.length && (
                <div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "8px 0" }}>Every achievement earned. 🎉</div>
              )}
            </div>
          </div>
        </div>
      )}

      {unlocksOpen && (
        <div onClick={() => setUnlocksOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "100%", maxWidth: 420, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, boxShadow: "0 14px 44px var(--shadow)", fontFamily: "Inter, sans-serif" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span className="mub-display" style={{ fontSize: 17, fontWeight: 700 }}>Unlocks</span>
              <button onClick={() => setUnlocksOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}><XIcon size={16} /></button>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
              You&rsquo;re Level {myLevel}{profile.prestige ? ` · Prestige ${profile.prestige}` : ""}. Every level gives a 🪙 Hint coin plus:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {Array.from({ length: LEVEL_CAP }, (_, i) => i + 1).map((L) => {
                const done = myLevel >= L;
                return (
                  <div key={L} style={{ display: "flex", gap: 10, padding: "9px 11px", border: "1px solid var(--grid)", borderRadius: 10, background: done ? "var(--paper)" : "transparent", opacity: done ? 1 : 0.5 }}>
                    <div style={{ flexShrink: 0, width: 30, textAlign: "center" }}>
                      <div style={{ fontWeight: 800, fontSize: 13, color: done ? "var(--green)" : "var(--muted)" }}>{done ? "✓" : "🔒"}</div>
                      <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700 }}>L{L}</div>
                    </div>
                    <div style={{ flex: 1, fontSize: 12.5, alignSelf: "center" }}>{unlocksAtLevel(L).join(" · ")}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 12 }}>Card backgrounds unlock one per Prestige. Name styles and extra titles come with Prestige too.</div>
          </div>
        </div>
      )}

      {missionsOpen && (() => {
        const xpFor = (id) => (id === "showup" ? DAILY_XP.showup : DAILY_XP.task);
        const rowStyle = { display: "flex", alignItems: "center", gap: 10, fontSize: 13 };
        const nothing = missionClaims === 0;
        return (
          <div onClick={() => setMissionsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 70, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "100%", maxWidth: 400, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 20, boxShadow: "0 14px 44px var(--shadow)", fontFamily: "Inter, sans-serif" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span className="mub-display" style={{ fontSize: 17, fontWeight: 700 }}>Missions</span>
                <button onClick={() => setMissionsOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}>
                  <XIcon size={16} />
                </button>
              </div>

              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Today</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {missionTasks.map((task) => {
                  const done = taskDone(task, missionDay);
                  const claimed = !!missionDay.claimed[task.id];
                  const cur = task.id === "showup" ? 1 : task.progress(missionDay);
                  return (
                    <div key={task.id} style={rowStyle}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{claimed ? "✅" : done ? "🟢" : "⚪"}</span>
                      <div style={{ flex: 1, minWidth: 0, color: claimed ? "var(--muted)" : "var(--ink)" }}>
                        {typeof task.label === "function" ? task.label(missionDay) : task.label}
                        {!claimed && !done ? <span style={{ color: "var(--muted)" }}> · {cur}/{task.goal}</span> : ""}
                      </div>
                      {claimed ? (
                        <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 700, flexShrink: 0 }}>+{xpFor(task.id)} XP</span>
                      ) : done ? (
                        <button onClick={() => claimDailyTask(task.id)} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "5px 11px", cursor: "pointer", flexShrink: 0 }}>
                          Claim +{xpFor(task.id)}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {missionMs.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "16px 0 8px" }}>First-time bonuses</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {missionMs.map((m) => {
                      const st = (profile.milestones || {})[m.id];
                      return (
                        <div key={m.id} style={rowStyle}>
                          <span style={{ fontSize: 14, flexShrink: 0 }}>{st === "ready" ? "🟢" : "⚪"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>{m.label}</div>
                          {st === "ready" && (
                            <button onClick={() => claimMilestone(m.id)} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "5px 11px", cursor: "pointer", flexShrink: 0 }}>
                              Claim +{MILESTONE_XP}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {nothing && (
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, textAlign: "center" }}>
                  Nothing to claim right now — keep practising and check back.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {settingsOpen && (
        <div onClick={() => setSettingsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 70, display: "flex", justifyContent: "flex-end", alignItems: "flex-start", padding: "12px 12px 0" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, width: "min(300px, 82vw)", background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, boxShadow: "0 14px 44px var(--shadow)", overflow: "hidden", fontFamily: "Inter, sans-serif" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px 11px" }}>
              <span className="mub-display" style={{ fontSize: 15, fontWeight: 700 }}>Settings</span>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex", padding: 2 }}>
                <XIcon size={16} />
              </button>
            </div>
            {[
              { icon: "🪪", label: "Profile", dot: newIconCount > 0, chevron: true, onClick: () => { setSettingsOpen(false); setShowCard(true); } },
              { icon: soundOn ? "🔊" : "🔇", label: "Sound", value: soundOn ? "On" : "Off", onClick: toggleSound },
              { icon: theme === "dark" ? "🌙" : "☀️", label: "Appearance", value: theme === "dark" ? "Dark" : "Light", onClick: toggleTheme },
              { icon: "🏫", label: "School", value: profile.school && profile.school !== SOLO_SCHOOL ? "Set" : "None", chevron: true, onClick: () => { setSettingsOpen(false); setSchoolEditQuery(""); setShowSchool(true); } },
              { icon: "🎨", label: "Style", value: SOUND_PACKS[profile.soundPack] ? SOUND_PACKS[profile.soundPack].name : "Classic", chevron: true, onClick: () => { setSettingsOpen(false); setStylePickerOpen(true); } },
              { icon: "🔒", label: "Change PIN", chevron: true, onClick: () => { setSettingsOpen(false); setChangePinMsg(null); setPin1(""); setPin2(""); setChangePinOpen(true); } },
              { icon: "👪", label: "Parent link", chevron: true, onClick: () => { setSettingsOpen(false); openParentLink(); } },
              { icon: "↪", label: "Log out", danger: true, onClick: () => { setSettingsOpen(false); switchStudent(); } },
            ].map((it, i) => (
              <button key={i} onClick={it.onClick} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "13px 16px", background: "none", border: "none", borderTop: "1px solid var(--grid)", cursor: "pointer", color: it.danger ? "var(--red)" : "var(--ink)", textAlign: "left" }}>
                <span style={{ fontSize: 17, width: 22, textAlign: "center", flexShrink: 0 }}>{it.icon}</span>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                  {it.label}
                  {it.dot && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)" }} />}
                </span>
                {it.value != null && <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>{it.value}</span>}
                {it.chevron && <span style={{ fontSize: 13, color: "var(--muted)" }}>›</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {changePinOpen && (
        <div onClick={() => setChangePinOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 360, width: "100%", boxShadow: "0 10px 40px var(--shadow)" }}>
            <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Change your PIN</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
              Pick a new 6-digit PIN. You&rsquo;ll use it with your name to log in from now on. Your progress isn&rsquo;t affected.
            </div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>New PIN</label>
            <input
              value={pin1} onChange={(e) => setPin1(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric" placeholder="6 digits"
              style={{ width: "100%", marginTop: 6, marginBottom: 12, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", letterSpacing: 4 }}
            />
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Confirm new PIN</label>
            <input
              value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") submitChangePin(); }}
              inputMode="numeric" placeholder="6 digits"
              style={{ width: "100%", marginTop: 6, marginBottom: 14, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", letterSpacing: 4 }}
            />
            {changePinMsg && (
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: changePinMsg.ok ? "var(--green)" : "var(--red)" }}>{changePinMsg.text}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setChangePinOpen(false)} style={{ flex: "0 0 auto", fontSize: 13, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>
                {changePinMsg && changePinMsg.ok ? "Done" : "Cancel"}
              </button>
              {!(changePinMsg && changePinMsg.ok) && (
                <button onClick={submitChangePin} disabled={changePinBusy || !/^\d{6}$/.test(pin1) || pin1 !== pin2} style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "9px 14px", cursor: "pointer", opacity: changePinBusy || !/^\d{6}$/.test(pin1) || pin1 !== pin2 ? 0.6 : 1 }}>
                  {changePinBusy ? "Saving…" : "Change PIN"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {recoveryOpen && (
        <div onClick={() => setRecoveryOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 380, width: "100%", boxShadow: "0 10px 40px var(--shadow)" }}>
            <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Add PIN recovery</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
              Add an email so you can get back in if you ever forget your PIN.
              We&rsquo;ll send a link to confirm it. Your name + PIN keeps working exactly
              as now — this email is <b>only</b> used to send you a reset link.
            </div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Email</label>
            <input
              value={recEmail} onChange={(e) => setRecEmail(e.target.value)}
              type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
              style={{ width: "100%", marginTop: 6, marginBottom: 14, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
            />
            {recMsg && (
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: recMsg.ok ? "var(--green)" : "var(--red)" }}>{recMsg.text}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setRecoveryOpen(false)} style={{ flex: "0 0 auto", fontSize: 13, color: "var(--muted)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>
                {recMsg && recMsg.ok ? "Done" : "Cancel"}
              </button>
              {!(recMsg && recMsg.ok) && (
                <button onClick={submitRecoveryEmail} disabled={recBusy} style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "9px 14px", cursor: "pointer", opacity: recBusy ? 0.6 : 1 }}>
                  {recBusy ? "Saving…" : "Send confirmation link"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showParentLink && (() => {
        const url = typeof window !== "undefined" && profile.parentToken ? `${window.location.origin}/?p=${profile.parentToken}` : "";
        return (
          <div onClick={() => setShowParentLink(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...vars, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 420, fontFamily: "Inter, sans-serif" }}>
              <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Parent Link</div>
              <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 14 }}>
                Send this to a parent. It opens a read-only page with your level, grade in every topic, and achievements — and it updates as you practise. Anyone with the link can view it, so only share it with people you want to see your progress.
              </div>
              <div style={{ fontSize: 12, wordBreak: "break-all", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontFamily: "monospace" }}>
                {url || "Generating…"}
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setShowParentLink(false)} style={{ fontSize: 13, background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", color: "var(--ink)" }}>Close</button>
                <button onClick={() => copyParentLink(url)} disabled={!url} style={{ fontSize: 13, fontWeight: 700, background: "var(--blue)", color: "var(--on-accent)", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
                  {linkCopied ? "Copied!" : "Copy link"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmPrestige && (
        <div onClick={() => setConfirmPrestige(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 380, fontFamily: "Inter, sans-serif" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <PrestigeBadge prestige={(profile.prestige || 0) + 1} size={28} />
              <div className="mub-display" style={{ fontSize: 18, fontWeight: 700 }}>Prestige {(profile.prestige || 0) + 1}?</div>
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 18 }}>
              Every topic goes back to <b>ungraded</b> and your level resets to <b>1</b>. You keep your achievements, Skeleton Keys, and lifetime stats — and you move up to Prestige {(profile.prestige || 0) + 1} permanently. <b>This cannot be undone.</b>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmPrestige(false)} style={{ fontSize: 13, background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", color: "var(--ink)" }}>
                Cancel
              </button>
              <button onClick={doPrestige} style={{ fontSize: 13, fontWeight: 700, background: "var(--amber)", color: "var(--on-accent)", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
                Yes, prestige
              </button>
            </div>
          </div>
        </div>
      )}

      {keyTarget && (
        <div onClick={() => setKeyTarget(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...vars, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--grid)", borderRadius: 16, padding: 24, maxWidth: 360, fontFamily: "Inter, sans-serif" }}>
            <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>🗝 Use a Skeleton Key?</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 18 }}>
              Unlock <b>{keyTarget.name}</b> now, skipping its prerequisite. You have <b>{profile.keys || 0}</b> key{(profile.keys || 0) === 1 ? "" : "s"}.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setKeyTarget(null)} style={{ fontSize: 13, background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", color: "var(--ink)" }}>
                Cancel
              </button>
              <button onClick={() => useKeyOn(keyTarget)} style={{ fontSize: 13, fontWeight: 700, background: "var(--blue)", color: "var(--on-accent)", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
                Unlock it
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 60, background: "var(--ink)", color: "var(--page-bg)", fontWeight: 700, fontSize: 13, padding: "10px 18px", borderRadius: 999, boxShadow: "0 6px 20px var(--shadow)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
