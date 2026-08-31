"use client";
import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, X as XIcon, Trophy, RotateCcw } from "lucide-react";
import { storage } from "../lib/storage";

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
    if (c === "x") { tokens.push({ type: "var" }); i++; continue; }
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
const pw = (p) => (p === 1 ? "" : `^${p}`); // x^1 → x, but x^-1 / x^3 keep the index
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
const sfPretty = (mant, exp) => `${Math.round(mant * 1e6) / 1e6} × 10^${exp}`;

// "Instruction: expression" → drop the expression onto its own line so it
// doesn't wrap awkwardly mid-sum. No colon → the whole prompt is the lead.
function splitPrompt(prompt) {
  const p = prompt || "";
  const i = p.indexOf(": ");
  // Only split on a colon followed by a space (the "Instruction: expr" form).
  // A colon inside a clock time like "6:23" is left alone.
  if (i === -1 || i > p.length - 3) return { lead: p, expr: "" };
  return { lead: p.slice(0, i + 1).trim(), expr: p.slice(i + 1).trim() };
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
      const frac = "Fraction or decimal.";
      const forms = [
        () => { // a^m × a^n = a^(m+n)
          const a = randInt(2, 6), b = randInt(2, 6), m = randInt(1, 4), n = randInt(1, 4);
          return { prompt: `Simplify:   ${a}x${pw(m)} × ${b}x${pw(n)}`, answer: `${a * b}x${pw(m + n)}`, hint: alg,
            steps: [`Multiply the coefficients: ${a} × ${b} = ${a * b}`, `Add the powers: x${pw(m)} × x${pw(n)} = x${pw(m + n)}`, `Answer: ${a * b}x${pw(m + n)}`] };
        },
        () => { // a^m ÷ a^n = a^(m−n)
          const a = randInt(2, 6), b = randInt(2, 5), m = randInt(1, 4), n = randInt(1, 3);
          return { prompt: `Simplify:   ${a * b}x${pw(m + n)} ÷ ${b}x${pw(n)}`, answer: `${a}x${pw(m)}`, hint: alg,
            steps: [`Divide the coefficients: ${a * b} ÷ ${b} = ${a}`, `Subtract the powers: x${pw(m + n)} ÷ x${pw(n)} = x${pw(m)}`, `Answer: ${a}x${pw(m)}`] };
        },
        () => { // (a^m)^n = a^(mn)
          const a = randInt(2, 4), m = randInt(1, 4), n = randInt(2, 3);
          return { prompt: `Simplify:   (${a}x${pw(m)})^${n}`, answer: `${a ** n}x${pw(m * n)}`, hint: alg,
            steps: [`Raise the coefficient: ${a}^${n} = ${a ** n}`, `Multiply the powers: (x${pw(m)})^${n} = x${pw(m * n)}`, `Answer: ${a ** n}x${pw(m * n)}`] };
        },
        () => { // a^0 = 1
          const a = randInt(2, 9), m = randInt(2, 4);
          const asNum = Math.random() < 0.5;
          return asNum
            ? { prompt: `Evaluate:   ${a}^0`, answer: `1`, hint: num, steps: [`Anything (except 0) to the power 0 is 1`, `${a}^0 = 1`] }
            : { prompt: `Simplify:   (${a}x${pw(m)})^0`, answer: `1`, hint: num, steps: [`Anything to the power 0 is 1`, `(${a}x${pw(m)})^0 = 1`] };
        },
        () => { // a^(−m) = 1/a^m
          const a = randInt(2, 5), m = randInt(2, 3);
          return { prompt: `Evaluate:   ${a}^-${m}`, answer: `1/${a ** m}`, hint: frac,
            steps: [`A negative index means "one over": ${a}^-${m} = 1 ÷ ${a}^${m}`, `${a}^${m} = ${a ** m}`, `Answer: 1/${a ** m}`] };
        },
        () => { // a^(1/n) = ⁿ√a
          const base = randInt(2, 6), n = randInt(2, 3);
          return { prompt: `Evaluate:   ${base ** n}^(1/${n})`, answer: `${base}`, hint: num,
            steps: [`A power of 1/${n} means the ${n === 2 ? "square" : "cube"} root`, `${n === 2 ? "√" : "∛"}${base ** n} = ${base}`] };
        },
        () => { // a^(m/n) = (ⁿ√a)^m
          const base = randInt(2, 3);
          const [n, m] = [[2, 3], [3, 2]][randInt(0, 1)];
          return { prompt: `Evaluate:   ${base ** n}^(${m}/${n})`, answer: `${base ** m}`, hint: num,
            steps: [`${base ** n}^(${m}/${n}) = (${n === 2 ? "√" : "∛"}${base ** n})^${m} = ${base}^${m}`, `Answer: ${base ** m}`] };
        },
        () => { // a^m × b^m = (ab)^m
          const a = randInt(2, 5), b = [2, 3, 4, 5].filter((x) => x !== a)[randInt(0, 2)], m = randInt(2, 3);
          return { prompt: `Evaluate:   ${a}^${m} × ${b}^${m}`, answer: `${(a * b) ** m}`, hint: num,
            steps: [`Same power, so combine the bases: ${a}^${m} × ${b}^${m} = (${a} × ${b})^${m} = ${a * b}^${m}`, `Answer: ${(a * b) ** m}`] };
        },
        () => { // (a/b)^n = a^n / b^n
          const a = randInt(2, 3), b = randInt(a + 1, 5), n = randInt(2, 3);
          return { prompt: `Evaluate:   (${a}/${b})^${n}`, answer: `${a ** n}/${b ** n}`, hint: frac,
            steps: [`Raise the top and bottom separately: (${a}/${b})^${n} = ${a}^${n} / ${b}^${n}`, `Answer: ${a ** n}/${b ** n}`] };
        },
        () => { // if a^x = a^k then x = k
          const base = randInt(2, 4), k = randInt(2, 5);
          return { prompt: `Solve for x:   ${base}^x = ${base ** k}`, answer: `${k}`, hint: num,
            steps: [`Write the right side as a power of ${base}: ${base ** k} = ${base}^${k}`, `Equal bases means equal powers: x = ${k}`] };
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
          const p = randInt(1, 3), q = randInt(1, 3), a = randInt(2, 7), b = randInt(2, 7);
          const { c, d } = surdParts(p * q, a * b);
          return { prompt: `Simplify:   ${surdStr(p, a)} × ${surdStr(q, b)}`, answer: surdStr(c, d), hint: surdHint,
            steps: [`Multiply the numbers and the roots separately: ${p} × ${q} = ${p * q},  √${a} × √${b} = √${a * b}`, `${p * q}√${a * b}${d === a * b ? "" : ` = ${surdStr(c, d)}`}`] };
        },
        () => { // rationalise a / √b
          const b = [2, 3, 5, 6, 7, 10, 11, 13][randInt(0, 7)];
          const a = randInt(1, 6), g = gcd(a, b), nc = a / g, den = b / g;
          const ans = den === 1 ? surdStr(nc, b) : `${nc === 1 ? "" : nc}√${b}/${den}`;
          return {
            prompt: `Rationalise the denominator:   ${a}/√${b}`,
            answer: ans, hint: "e.g. 3√5/5",
            check: (inp) => {
              const s = String(inp).replace(/\s/g, "");
              return checkEquivalent(inp, ans) && /√|sqrt/i.test(s) && !/\/[^/]*(√|sqrt)/i.test(s);
            },
            steps: [
              `Multiply top and bottom by √${b}:  ${a}/√${b} × √${b}/√${b}`,
              `= ${a}√${b} / ${b}`,
              den === 1 ? `= ${ans}` : `Cancel the common factor ${g}:  = ${ans}`,
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
          return { prompt: `Write ${shown} in standard form`, answer: sfString(mant, exp), hint: sfHint,
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
          return { prompt: `Work out, in standard form:   (${m1} × 10^${e1}) × (${m2} × 10^${e2})`, answer: sfString(mant, exp), hint: sfHint,
            check: (inp) => isStdForm(inp, value),
            steps: [`Multiply the numbers: ${m1} × ${m2} = ${m1 * m2}`, `Add the powers: 10^${e1} × 10^${e2} = 10^${e1 + e2}`,
              m1 * m2 >= 10 ? `Adjust so the first part is 1–10: ${m1 * m2} × 10^${e1 + e2} = ${sfPretty(mant, exp)}` : `Answer: ${sfPretty(mant, exp)}`] };
        },
        () => { // add or subtract two standard-form numbers
          const exp = [-3, -2, 2, 3, 4, 5][randInt(0, 5)];
          const plus = Math.random() < 0.5;
          const same = Math.random() < 0.35;
          let prompt, value, matchStep;
          if (same) {
            const a = randInt(2, 9), b = plus ? randInt(2, 9) : randInt(1, a - 1);
            prompt = `Work out, in standard form:   ${a} × 10^${exp} ${plus ? "+" : "−"} ${b} × 10^${exp}`;
            value = (plus ? a + b : a - b) * Math.pow(10, exp);
            matchStep = `Same power of 10 — just ${plus ? "add" : "subtract"} the front numbers: ${a} ${plus ? "+" : "−"} ${b} = ${plus ? a + b : a - b}`;
          } else {
            const diff = randInt(1, 2), e2 = exp - diff; // second number has the smaller power
            const a = randInt(2, 9), b = randInt(1, 9);
            prompt = `Work out, in standard form:   ${a} × 10^${exp} ${plus ? "+" : "−"} ${b} × 10^${e2}`;
            value = a * Math.pow(10, exp) + (plus ? 1 : -1) * b * Math.pow(10, e2);
            matchStep = `Give both the same power of 10:  ${b} × 10^${e2} = ${b / Math.pow(10, diff)} × 10^${exp},  then ${plus ? "add" : "subtract"}`;
          }
          const { mant, exp: ex } = norm(value);
          return { prompt, answer: sfString(mant, ex), hint: sfHint,
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
      const pick = units[randInt(0, units.length - 1)];
      const prec = pick.precs[randInt(0, pick.precs.length - 1)];
      const v = clean(randInt(3, 40) * prec);
      const half = clean(prec / 2);
      const bound = Math.random() < 0.5 ? "upper" : "lower";
      const ans = clean(bound === "upper" ? v + half : v - half);
      const singular = { litres: "litre", seconds: "second" }[pick.u] || pick.u;
      const precLabel = prec === 1 ? `nearest ${singular}` : `nearest ${clean(prec)} ${pick.u}`;
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
      const a = randInt(2, 9), xTarget = randInt(-10, 10), b = randInt(-10, 10), c = a * xTarget + b;
      return { prompt: `Solve for x:   ${a}x ${spaced(b)} = ${c}`, answer: `${xTarget}`, hint: "Enter a number.",
        steps: [`Subtract ${b} from both sides: ${a}x = ${c - b}`, `Divide both sides by ${a}: x = ${xTarget}`] };
    } },
  { id: "factorization", name: "Factorisation", icon: "🧩", prereqs: ["algebra"],
    generate() {
      let p = randInt(-9, 9), q = randInt(-9, 9);
      while (p === 0) p = randInt(-9, 9);
      while (q === 0) q = randInt(-9, 9);
      return { prompt: `Factorise:   x^2 ${spaced(p + q)}x ${spaced(p * q)}`, answer: `(x${tight(p)})(x${tight(q)})`, hint: "e.g. (x+2)(x-3)",
        steps: [`Find two numbers that multiply to ${p * q} and add to ${p + q}: ${p} and ${q}`, `Answer: (x${tight(p)})(x${tight(q)})`] };
    } },
  { id: "simultaneous", name: "Simultaneous Equations", icon: "🔗", prereqs: ["algebra"],
    generate() {
      const xSol = randInt(-6, 6), ySol = randInt(-6, 6);
      let a = randInt(1, 5), b = randInt(1, 5), c = randInt(1, 5), d = randInt(1, 5);
      while (a * d - b * c === 0) { c = randInt(1, 5); d = randInt(1, 5); }
      const e = a * xSol + b * ySol, f = c * xSol + d * ySol;
      const co = (n) => (n === 1 ? "" : `${n}`);
      return { prompt: `Solve for x:   ${co(a)}x + ${co(b)}y = ${e},  ${co(c)}x + ${co(d)}y = ${f}`, answer: `${xSol}`, hint: "Enter a number.",
        steps: [`Scale the equations so the y-coefficients match, then subtract to eliminate y`, `Solve the resulting equation for x`, `x = ${xSol} (then y = ${ySol})`] };
    } },
  { id: "functions", name: "Functions", icon: "🔀", prereqs: ["algebra"],
    generate() {
      const a = randInt(2, 9), b = randInt(-10, 10), k = randInt(-8, 8);
      return { prompt: `f(x) = ${a}x ${spaced(b)}.   Find f(${k})`, answer: `${a * k + b}`, hint: "Enter a number.",
        steps: [`Substitute x = ${k} into f(x) = ${a}x ${spaced(b)}`, `f(${k}) = ${a}×${k} ${spaced(b)} = ${a * k} ${spaced(b)} = ${a * k + b}`] };
    } },
  { id: "sequences", name: "Number Sequences", icon: "🔢", prereqs: ["algebra"],
    generate() {
      const a1 = randInt(-10, 10); let d = randInt(-9, 9); if (d === 0) d = 3;
      return { prompt: `Find the next term:   ${a1}, ${a1 + d}, ${a1 + 2 * d}, ${a1 + 3 * d}, ...`, answer: `${a1 + 4 * d}`, hint: "Enter a number.",
        steps: [`Find the common difference: ${a1 + d} − ${a1} = ${d}`, `Add it to the last given term: ${a1 + 3 * d} + ${d} = ${a1 + 4 * d}`] };
    } },
  { id: "proportionality", name: "Proportionality", icon: "⚖️", prereqs: ["algebra"],
    generate() {
      const k = randInt(2, 9), x1 = randInt(2, 9), x2 = randInt(2, 12), y1 = k * x1;
      return { prompt: `y is directly proportional to x. When x = ${x1}, y = ${y1}. Find y when x = ${x2}`, answer: `${k * x2}`, hint: "Enter a number.",
        steps: [`Find k: y = kx → k = ${y1} ÷ ${x1} = ${k}`, `Use k to find y when x = ${x2}: y = ${k} × ${x2} = ${k * x2}`] };
    } },
  { id: "coordgeo", name: "Co-ordinate Geometry", icon: "📍", prereqs: [],
    generate() {
      const m = randInt(-6, 6) || 2, c = randInt(-8, 8);
      let x1 = randInt(-6, 6), x2 = randInt(-6, 6);
      while (x2 === x1) x2 = randInt(-6, 6);
      const y1 = m * x1 + c, y2 = m * x2 + c;
      return { prompt: `Find the gradient of the line joining (${x1}, ${y1}) and (${x2}, ${y2})`, answer: `${m}`, hint: "Enter a number.",
        steps: [`Gradient = (y2 − y1) ÷ (x2 − x1)`, `= (${y2} − ${y1}) ÷ (${x2} − ${x1}) = ${y2 - y1} ÷ ${x2 - x1} = ${m}`] };
    } },
  { id: "graphicalsolutions", name: "Graphical Solutions", icon: "📉", prereqs: ["algebra", "coordgeo"],
    generate() {
      const xI = randInt(-6, 6);
      let m1 = randInt(-5, 5), m2 = randInt(-5, 5);
      while (m1 === m2) m2 = randInt(-5, 5);
      const c1 = randInt(-8, 8), c2 = m1 * xI + c1 - m2 * xI;
      return { prompt: `Lines y = ${m1}x ${spaced(c1)} and y = ${m2}x ${spaced(c2)} intersect. Find the x-coordinate of the intersection`, answer: `${xI}`, hint: "Enter a number.",
        steps: [`At the intersection both lines are equal: ${m1}x ${spaced(c1)} = ${m2}x ${spaced(c2)}`, `Rearrange: ${m1 - m2}x = ${c2 - c1}`, `x = ${c2 - c1} ÷ ${m1 - m2} = ${xI}`] };
    } },
  { id: "inequalities", name: "Linear Inequalities & Shading", icon: "🚧", prereqs: ["algebra", "coordgeo"],
    generate() {
      const a = randInt(2, 8), xB = randInt(-9, 9), b = randInt(-10, 10), c = a * xB + b;
      return { prompt: `Solve:   ${a}x ${spaced(b)} < ${c}.   What is the boundary value of x?`, answer: `${xB}`, hint: "Enter a number.",
        steps: [`Treat it as an equation to find the boundary: ${a}x ${spaced(b)} = ${c}`, `Subtract ${b}: ${a}x = ${c - b}`, `Divide by ${a}: x = ${xB}`] };
    } },
  { id: "transformations", name: "Transformations", icon: "🔄", prereqs: ["coordgeo"],
    generate() {
      const x = randInt(-8, 8), y = randInt(-8, 8), vx = randInt(-6, 6), vy = randInt(-6, 6);
      return { prompt: `Point (${x}, ${y}) is translated by vector (${vx}, ${vy}). Find the new x-coordinate`, answer: `${x + vx}`, hint: "Enter a number.",
        steps: [`A translation adds the vector to the coordinates`, `New x = ${x} + ${vx} = ${x + vx}`] };
    } },
  { id: "kinematics", name: "Kinematics", icon: "🚗", prereqs: ["algebra", "coordgeo", "time"],
    generate() {
      const t = randInt(2, 8), speed = randInt(20, 90), d = t * speed;
      return { prompt: `A car travels ${d} km in ${t} hours. Find its average speed in km/h`, answer: `${speed}`, hint: "Enter a number.",
        steps: [`Speed = distance ÷ time`, `= ${d} ÷ ${t} = ${speed} km/h`] };
    } },
  { id: "dailymaths", name: "Daily Maths", icon: "🛒", prereqs: ["algebra"],
    generate() {
      const p = randInt(4, 40) * 2, pct = randInt(1, 9) * 10, discount = (p * pct) / 100;
      return { prompt: `A shirt costs $${p}. It is discounted by ${pct}%. Find the new price`, answer: `${p - discount}`, hint: "Enter a number.",
        steps: [`Discount = ${pct}% of $${p} = $${discount}`, `New price = $${p} − $${discount} = $${p - discount}`] };
    } },
  { id: "mensuration", name: "Mensuration", icon: "▦", prereqs: [],
    generate() {
      const l = randInt(3, 20), w = randInt(3, 20);
      return { prompt: `Find the area of a rectangle with length ${l} cm and width ${w} cm`, answer: `${l * w}`, hint: "Enter a number (cm²).",
        steps: [`Area of a rectangle = length × width`, `= ${l} × ${w} = ${l * w} cm²`] };
    } },
  { id: "similarity", name: "Similarity", icon: "🔺", prereqs: ["mensuration"],
    generate() {
      const a = randInt(2, 6), k = randInt(2, 4), area = randInt(4, 20);
      return { prompt: `Two similar triangles have corresponding sides ${a} cm and ${a * k} cm. The smaller triangle has area ${area} cm². Find the area of the larger triangle`, answer: `${area * k * k}`, hint: "Enter a number (cm²).",
        steps: [`Scale factor (length) = ${a * k} ÷ ${a} = ${k}`, `Scale factor (area) = ${k}² = ${k * k}`, `Larger area = ${area} × ${k * k} = ${area * k * k} cm²`] };
    } },
  { id: "symmetry", name: "Symmetry", icon: "🦋", prereqs: [],
    generate() {
      const n = randInt(3, 10);
      return { prompt: `How many lines of symmetry does a regular polygon with ${n} sides have?`, answer: `${n}`, hint: "Enter a number.",
        steps: [`A regular polygon has one line of symmetry per side`, `Answer: ${n}`] };
    } },
  { id: "polygons", name: "Polygons", icon: "⬡", prereqs: [],
    generate() {
      const n = randInt(3, 12);
      return { prompt: `Find the sum of the interior angles of a polygon with ${n} sides (in degrees)`, answer: `${(n - 2) * 180}`, hint: "Enter a number.",
        steps: [`Sum of interior angles = (n − 2) × 180°`, `= (${n} − 2) × 180 = ${(n - 2) * 180}°`] };
    } },
  { id: "trigonometry", name: "Trigonometry", icon: "📐", prereqs: ["polygons"],
    generate() {
      const a = randInt(3, 12), b = randInt(3, 12);
      return { prompt: `A right-angled triangle has legs ${a} cm and ${b} cm. Find the length of the hypotenuse`, answer: `sqrt(${a}^2+${b}^2)`, hint: "e.g. sqrt(41) or a decimal",
        steps: [`Use Pythagoras' theorem: hyp² = a² + b²`, `= ${a}² + ${b}² = ${a * a} + ${b * b} = ${a * a + b * b}`, `hyp = √${a * a + b * b}`] };
    } },
  { id: "circles", name: "Circles", icon: "⭕", prereqs: ["trigonometry"],
    generate() {
      const r = randInt(2, 12);
      return { prompt: `Find the area of a circle with radius ${r} cm. Leave your answer in terms of π or as a decimal`, answer: `${r * r}π`, hint: "e.g. 25π",
        steps: [`Area of a circle = πr²`, `= π × ${r}² = ${r * r}π cm²`] };
    } },
  { id: "probability", name: "Probability", icon: "🎲", prereqs: [],
    generate() {
      const a = randInt(2, 9), b = randInt(2, 9);
      return { prompt: `A bag has ${a} red balls and ${b} blue balls. Find the probability of picking a red ball`, answer: `${a}/(${a + b})`, hint: "Fraction or decimal.",
        steps: [`P(red) = number of red ÷ total balls`, `= ${a} ÷ (${a} + ${b}) = ${a}/${a + b}`] };
    } },
  { id: "statistics", name: "Statistics", icon: "📊", prereqs: ["probability"],
    generate() {
      const n = randInt(4, 6), nums = Array.from({ length: n }, () => randInt(1, 20)), sum = nums.reduce((s, v) => s + v, 0);
      return { prompt: `Find the mean of:   ${nums.join(", ")}`, answer: `${sum}/${n}`, hint: "Decimal is fine.",
        steps: [`Mean = sum of values ÷ number of values`, `= (${nums.join(" + ")}) ÷ ${n} = ${sum} ÷ ${n}`] };
    } },
  { id: "sets", name: "Sets", icon: "∩", prereqs: ["probability"],
    generate() {
      const a = randInt(8, 20), b = randInt(8, 20), both = randInt(1, Math.min(a, b) - 1);
      return { prompt: `Set A has ${a} elements, Set B has ${b} elements, and ${both} elements are in both. Find the number of elements in A∪B`, answer: `${a + b - both}`, hint: "Enter a number.",
        steps: [`n(A∪B) = n(A) + n(B) − n(A∩B)`, `= ${a} + ${b} − ${both} = ${a + b - both}`] };
    } },
  { id: "vectors", name: "Vectors", icon: "➡️", prereqs: ["algebra"],
    generate() {
      const p1 = randInt(-8, 8), p2 = randInt(-8, 8), q1 = randInt(-8, 8), q2 = randInt(-8, 8);
      return { prompt: `p = (${p1}, ${p2})  and  q = (${q1}, ${q2}).  Find the x-component of p + q`, answer: `${p1 + q1}`, hint: "Enter a number.",
        steps: [`Add the x-components of the two vectors`, `= ${p1} + ${q1} = ${p1 + q1}`] };
    } },
];
const TOPIC_BY_ID = Object.fromEntries(TOPICS.map((t) => [t.id, t]));

// Mixed Review — a level-3 reward: random questions drawn from every topic
// the student has unlocked. Answers still score their source topic.
const MIXED_TOPIC = { id: "__mixed__", name: "Mixed Review", icon: "🎲" };
const MIXED_UNLOCK_LEVEL = 3;

/* Achievements are grouped into four tiers. Each achievement's check(p)
   runs against the whole profile after every answer; ids are permanent
   (renaming/retiering an achievement keeps anyone who already earned it).
   Rank checks read the ratcheted highestRank, so they never un-earn. */
const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
const TIER_COLOR = { Bronze: "#B07437", Silver: "#8A929E", Gold: "#C99A1E", Platinum: "#3E9CB8" };

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

  /* ---------------- Silver ---------------- */
  { id: "marathon", tier: "Silver", name: "Marathon Mind", icon: "🏅", desc: "100 correct answers in total",
    check: (p) => (p.totalCorrect || 0) >= 100 },
  { id: "perfectionist", tier: "Silver", name: "Perfectionist", icon: "💯", desc: "Reach S rank in any topic",
    check: (p) => TOPICS.some((t) => topicRankAtLeast(p, t.id, "S")) },
  { id: "aristocrat", tier: "Silver", name: "Arithmetic Aristocrat", icon: "🎩", desc: "Reach rank A in the first 8 topics",
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

  /* ---------------- Platinum ---------------- */
  { id: "unlocked", tier: "Platinum", name: "Mathematics Unlocked", icon: "🏆", desc: "Reach S+ rank in every topic",
    secret: true, check: (p) => allTopicsRankAtLeast(p, TOPICS, "S+") },
];

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
   Levelling (Mastery Challenge). XP comes from two sources:
   grade ratchet-ups (ungraded→F … S→S+) and claimed daily
   tasks (profile.bonusExp). Level 20 costs 8,500 XP — about
   what 15 topics at A + 15 at S is worth (8,550) — so full
   S+ mastery (13,500) is now well past the cap and lives on
   as the "Mathematics Unlocked" achievement + prestige fuel.
--------------------------------------------------------- */
const LEVEL_CAP = 20;
// XP for entering each rank: F, E, D, C, B, A, A*, S, S+  (arithmetic, +10)
const RANK_STEP_EXP = [10, 20, 30, 40, 50, 60, 70, 80, 90];
// RANK_CUM_EXP[k] = XP a topic is worth at rank index k
//   → [10, 30, 60, 100, 150, 210, 280, 360, 450]  (A = 210, S = 360, S+ = 450)
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
function LevelBar({ profile, onPrestige }) {
  const { level, into, need, pct, capped } = levelProgress(totalExp(profile));
  const prestige = profile.prestige || 0;
  const belowC = TOPICS.filter((t) => !topicRankAtLeast(profile, t.id, "C"));
  const prestigeSlot = capped && prestige < PRESTIGE_CAP && typeof onPrestige === "function";
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, color: "var(--blue)", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <PrestigeBadge prestige={prestige} size={18} />
        <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 0.5 }}>LV</span>{level}
      </div>
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

/* Rank titles shown under the student's name and on the profile card.
   Past Level 20 the extra flex comes from Prestige. */
const TITLES = [
  { level: 1, name: "Novice" },
  { level: 5, name: "Apprentice" },
  { level: 10, name: "Scholar" },
  { level: 15, name: "Maths Specialist" },
  { level: 20, name: "Maths Master" },
];
function titleForLevel(level) {
  let name = TITLES[0].name;
  for (const t of TITLES) if (level >= t.level) name = t.name;
  return name;
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
function RadarChart({ profile }) {
  const cx = 120, cy = 104, R = 62, labelR = 82;
  const groups = STAT_GROUPS.map((g) => ({ name: g.name, v: statGroupValue(profile, g.ids) }));
  const at = (i, frac) => {
    const a = (-90 + i * 72) * Math.PI / 180;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };
  const ring = (frac) => groups.map((_, i) => at(i, frac).join(",")).join(" ");
  const data = groups.map((g, i) => at(i, Math.max(0.02, g.v)).join(",")).join(" ");
  return (
    <svg viewBox="-28 -6 296 232" width="100%" style={{ display: "block", maxWidth: 300, margin: "0 auto" }}>
      {[0.34, 0.67, 1].map((f, k) => <polygon key={k} points={ring(f)} fill="none" stroke="var(--grid)" strokeWidth="1" />)}
      {groups.map((_, i) => { const [x, y] = at(i, 1); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--grid)" strokeWidth="1" />; })}
      <polygon points={data} fill="var(--green)" fillOpacity="0.32" stroke="var(--green)" strokeWidth="1.5" strokeLinejoin="round" />
      {groups.map((g, i) => { const [x, y] = at(i, Math.max(0.02, g.v)); return <circle key={i} cx={x} cy={y} r="2.4" fill="var(--green)" />; })}
      {groups.map((g, i) => {
        const a = (-90 + i * 72) * Math.PI / 180;
        const x = cx + Math.cos(a) * labelR, y = cy + Math.sin(a) * labelR;
        const anchor = Math.abs(x - cx) < 3 ? "middle" : x < cx ? "end" : "start";
        return (
          <text key={i} x={x} y={y} textAnchor={anchor} fill="var(--muted)">
            <tspan fontSize="9" fontWeight="700">{g.name}</tspan>
            <tspan x={x} dy="10" fontSize="8" fontWeight="700" fill="var(--green)">{Math.round(g.v * 100)}%</tspan>
          </text>
        );
      })}
    </svg>
  );
}

/* Shareable summary of a student's progress. Pure display — takes a
   profile object, so the same card backs the Parent Link and friend
   search pages. Sized to screenshot cleanly. */
function ProfileCard({ profile }) {
  const exp = totalExp(profile);
  const { level, into, need, pct, capped } = levelProgress(exp);
  const title = titleForLevel(level);
  const achCount = (profile.achievements || []).filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length;
  const stat = (label, value) => (
    <div style={{ textAlign: "center" }}>
      <div className="mub-display" style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
  return (
    <div className="mub-grid" style={{ width: 360, maxWidth: "100%", border: "1px solid var(--grid)", borderRadius: 18, padding: 22, color: "var(--ink)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="mub-display" style={{ fontSize: 16, fontWeight: 700 }}>MathsUnlocked</span>
        <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600 }}>BN · Mastery Challenge</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "16px 0 14px" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <div style={{ width: 58, height: 58, borderRadius: "50%", border: "2px solid var(--blue)", color: "var(--blue)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 8, letterSpacing: 0.5 }}>LEVEL</span>
            <span className="mub-display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{level}</span>
          </div>
          {(profile.prestige || 0) > 0 && (
            <div style={{ position: "absolute", right: -6, bottom: -4 }}>
              <PrestigeBadge prestige={profile.prestige} size={22} />
            </div>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mub-display" style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.15, wordBreak: "break-word" }}>{profile.name || "Student"}</div>
          <div style={{ fontSize: 12, color: "var(--blue)", fontWeight: 600 }}>
            {title}{(profile.prestige || 0) > 0 ? ` · Prestige ${profile.prestige}` : ""}
          </div>
          {profile.school && profile.school !== SOLO_SCHOOL && (
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1, wordBreak: "break-word" }}>{profile.school}</div>
          )}
        </div>
      </div>

      <div style={{ height: 8, background: "var(--locked)", borderRadius: 999, overflow: "hidden", marginBottom: 4 }}>
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: capped ? "var(--amber)" : "var(--blue)" }} />
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginBottom: 16 }}>
        {capped ? "MAX · Level 20" : `${into} / ${need} XP to next level`}
      </div>

      <div style={{ display: "flex", justifyContent: "space-around", background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: "12px 8px", marginBottom: 14 }}>
        {stat("Best streak", profile.bestStreak || 0)}
        {stat("Correct", profile.totalCorrect || 0)}
        {stat("Badges", `${achCount}/${ACHIEVEMENTS.length}`)}
      </div>

      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
        Mastery
      </div>
      <RadarChart profile={profile} />
    </div>
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

// Record level-ups (timestamps + Skeleton Keys) after any XP change.
function creditLevelUps(next, expBefore) {
  const before = levelFromExp(expBefore);
  const after = levelFromExp(totalExp(next));
  if (after > before) {
    next.levelReachedAt = next.levelReachedAt || {};
    for (let L = before + 1; L <= after; L++) {
      if (!next.levelReachedAt[L]) next.levelReachedAt[L] = Date.now();
      if (L % 5 === 0) next.keys = (next.keys || 0) + 1;
    }
  }
  return after > before ? after : null;
}

const emptyProfile = () => ({
  name: "", school: SOLO_SCHOOL, topics: {}, achievements: [], achievedAt: {},
  streak: 0, bestStreak: 0, fastCorrect: 0, minuteCorrect: 0, totalCorrect: 0,
  consecWrong: 0, nightOwl: false, comeback: false, solvedSurd: false, got67: false,
  prestige: 0, prestigeAt: [], keys: 0, keyedTopics: [], levelReachedAt: {},
  bonusExp: 0, daily: null, milestones: {},
});
const slug = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "student";
// A student is identified by name + 4-digit PIN, so two students who share
// a name stay separate. slug() never yields "__", so it's a safe divider.
const studentKey = (name, pin) => `student_${slug(name)}__${/^\d{4}$/.test(pin || "") ? pin : "0000"}`;
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
  const [showSchool, setShowSchool] = useState(false);
  const [schoolEditQuery, setSchoolEditQuery] = useState("");
  const [devTopic, setDevTopic] = useState(TOPICS[0].id);
  const [toast, setToast] = useState(null);
  const [activeTopic, setActiveTopic] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answerInput, setAnswerInput] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [students, setStudents] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [customQuestions, setCustomQuestions] = useState({});
  const [qbTopicId, setQbTopicId] = useState(TOPICS[0].id);
  const [qbForm, setQbForm] = useState({ prompt: "", answer: "", hint: "", steps: "" });
  const [qbEditingId, setQbEditingId] = useState(null);
  const [qbPreview, setQbPreview] = useState(null);
  const [showCard, setShowCard] = useState(false);
  const [showParentLink, setShowParentLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [parentView, setParentView] = useState(null); // read-only progress for a ?p= link
  const [board, setBoard] = useState(null);           // { loading, schools: [...] }
  const [friendQuery, setFriendQuery] = useState("");
  const [friendResults, setFriendResults] = useState(null); // null = not searched yet
  const [friendLoading, setFriendLoading] = useState(false);
  const [friendView, setFriendView] = useState(null);       // a selected student's profile
  const [confirmPrestige, setConfirmPrestige] = useState(false);
  const [keyTarget, setKeyTarget] = useState(null);
  const [theme, setTheme] = useState("light");
  const [soundOn, setSoundOn] = useState(true);
  const [teacherMode, setTeacherMode] = useState(false);
  const startTimeRef = useRef(null);
  const audioCtxRef = useRef(null);
  const answerRef = useRef(null);

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

      // Parent Link: ?p=<token> shows a read-only view of one student.
      try {
        const pTok = new URLSearchParams(window.location.search).get("p");
        if (pTok) {
          const r = await storage.get(`parent_${pTok}`, true);
          if (r && r.value) setParentView(JSON.parse(r.value));
          else setParentView({ __missing: true });
          setScreen("parent");
          setReady(true);
          return;
        }
      } catch (e) { setParentView({ __missing: true }); setScreen("parent"); setReady(true); return; }

      try {
        const res = await storage.get("profile");
        if (res && res.value) {
          setProfile(JSON.parse(res.value));
          setScreen("dashboard");
        }
      } catch (e) { /* no saved profile yet */ }
      await loadCustomQuestions();
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.background = THEMES[theme]["--page-bg"];
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Teacher-only screens are unreachable without the ?teacher=1 unlock.
  useEffect(() => {
    if (!teacherMode && (screen === "admin" || screen === "questions")) {
      setScreen(profile.name ? "dashboard" : "login");
    }
  }, [teacherMode, screen, profile.name]);

  // Roll over the daily tasks at (local) midnight / on a new day.
  useEffect(() => {
    if (!ready || !profile.name) return;
    if (!profile.daily || profile.daily.date !== todayKey()) {
      const n = JSON.parse(JSON.stringify(profile));
      n.daily = freshDay(n);
      saveProfile(n);
    }
  }, [ready, profile.name, profile.daily && profile.daily.date]);

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
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
    const lv = creditLevelUps(n, before);
    saveProfile(n);
    if (lv) playJingle(true);
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
    const lv = creditLevelUps(n, before);
    saveProfile(n);
    if (lv) playJingle(true);
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

  // Short synthesised arpeggio (C–E–G–C) played when an achievement unlocks.
  // Built lazily off the click/keydown that triggered the answer, so the
  // AudioContext is allowed to start.
  function playJingle(big) {
    if (!soundOn) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      let ctx = audioCtxRef.current;
      if (!ctx) { ctx = new AC(); audioCtxRef.current = ctx; }
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.13;
      master.connect(ctx.destination);
      const seq = big ? [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5] : [523.25, 659.25, 783.99, 1046.5];
      seq.forEach((freq, i) => {
        const t = now + i * 0.1;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
        osc.connect(g); g.connect(master);
        osc.start(t); osc.stop(t + 0.42);
      });
    } catch (e) { /* audio unavailable — no problem */ }
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
    setActiveTopic(MIXED_TOPIC);
    setQuestion(pickMixed());
    setAnswerInput("");
    setFeedback(null);
    startTimeRef.current = Date.now();
    setScreen("quiz");
  }

  async function saveProfile(next) {
    if (next.name && !next.parentToken) next.parentToken = genToken();
    setProfile(next);
    try { await storage.set("profile", JSON.stringify(next)); } catch (e) { /* ignore */ }
    if (next.name && next.pin) {
      try { await storage.set(studentKey(next.name, next.pin), JSON.stringify(next), true); } catch (e) { /* ignore */ }
      if (next.parentToken) {
        try { await storage.set(`parent_${next.parentToken}`, JSON.stringify(next), true); } catch (e) { /* ignore */ }
      }
    }
  }

  // Login by name + 4-digit PIN. An existing name+PIN resumes that
  // student's progress (the shared record survives "Switch student");
  // a new name+PIN creates a fresh profile with the chosen school.
  async function startSession() {
    if (starting) return;
    const nm = nameInput.trim();
    const pin = pinInput.trim();
    if (!nm) { setStartError("Enter your name."); return; }
    if (!/^\d{4}$/.test(pin)) { setStartError("Your PIN must be exactly 4 digits."); return; }
    setStartError("");
    setStarting(true);
    const isBlank = (p) => !p || (Object.keys(p.topics || {}).length === 0 && !(p.prestige > 0) && !(p.totalCorrect > 0));
    let prof = null;
    try {
      const r = await storage.get(studentKey(nm, pin), true);
      if (r && r.value) prof = JSON.parse(r.value);
    } catch (e) { /* first time for this name + PIN */ }
    // Legacy accounts (created before PINs) are keyed by name only. Adopt
    // one when there's no real name+PIN account yet — also when a blank
    // name+PIN account exists (e.g. from a failed recovery attempt).
    let adoptedLegacy = false;
    if (isBlank(prof)) {
      try {
        const legacy = await storage.get(`student_${slug(nm)}`, true);
        if (legacy && legacy.value) {
          const legacyProf = JSON.parse(legacy.value);
          if (!isBlank(legacyProf)) { prof = legacyProf; adoptedLegacy = true; }
        }
      } catch (e) { /* no legacy account */ }
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
    await saveProfile(prof);
    if (adoptedLegacy) {
      // Only remove the legacy key once the new name+PIN record is
      // confirmed saved — otherwise keep it as a fallback.
      try {
        const check = await storage.get(studentKey(nm, pin), true);
        if (check && check.value && !isBlank(JSON.parse(check.value))) {
          await storage.delete(`student_${slug(nm)}`, true);
        }
      } catch (e) { /* keep the legacy key */ }
    }
    setScreen("dashboard");
    setStarting(false);
  }

  // Non-destructive: forgets this device's session so the login screen
  // shows, but the student's progress stays saved (name + PIN) and
  // resumes when they sign back in.
  async function switchStudent() {
    try { await storage.delete("profile"); } catch (e) { /* ignore */ }
    setProfile(emptyProfile());
    setActiveTopic(null);
    setScreen("login");
    setNameInput("");
    setPinInput("");
    setStartError("");
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
    next.achievedAt = next.achievedAt || {};
    ACHIEVEMENTS.forEach((a) => {
      if (!next.achievements.includes(a.id) && a.check(next)) { next.achievements.push(a.id); next.achievedAt[a.id] = Date.now(); }
    });
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
  function devHardReset() {
    if (typeof window !== "undefined" && !window.confirm("Reset this account to a blank Level 1 / Prestige 0? Progress, prestige, Skeleton Keys and achievements are all wiped. Name, school and PIN are kept.")) return;
    const { name, school, pin, parentToken, createdAt } = profile;
    saveProfile({ ...emptyProfile(), name, school, pin, parentToken, createdAt: createdAt || Date.now() });
    setActiveTopic(null);
    setScreen("dashboard");
  }

  function startTopic(topic) {
    if (!isUnlocked(topic, profile)) return;
    setActiveTopic(topic);
    setQuestion(pickQuestion(topic));
    setAnswerInput("");
    setFeedback(null);
    startTimeRef.current = Date.now();
    setScreen("quiz");
  }

  function nextQuestion() {
    setQuestion(activeTopic.id === MIXED_TOPIC.id ? pickMixed() : pickQuestion(activeTopic));
    setAnswerInput("");
    setFeedback(null);
    startTimeRef.current = Date.now();
  }

  function submitAnswer() {
    if (!answerInput.trim() || feedback) return;
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    const correct = question.check ? !!question.check(answerInput) : checkEquivalent(answerInput, question.answer);
    const expBefore = totalExp(profile);
    const scoredId = question.topicId || activeTopic.id; // Mixed Review scores the source topic
    const rankBefore = ((profile.topics || {})[scoredId] || {}).highestRank ?? -1;
    const next = JSON.parse(JSON.stringify(profile));
    const t = next.topics[scoredId] || { history: [], highestRank: -1, streak: 0 };
    t.history = [...t.history, correct ? 1 : 0].slice(-10);
    t.streak = correct ? (t.streak || 0) + 1 : 0;
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
    const d = ensureDay(next);
    if (!(d.topics || []).includes(scoredId)) d.topics = [...(d.topics || []), scoredId];
    if (activeTopic.id === MIXED_TOPIC.id) d.mixedRounds = Math.max(d.mixedRounds || 0, 1);

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
      d.correct = (d.correct || 0) + 1;
      d.streakToday = (d.streakToday || 0) + 1;
      d.bestStreakToday = Math.max(d.bestStreakToday || 0, d.streakToday);
      if (scoredId === d.weakTopicId) d.weakCorrect = (d.weakCorrect || 0) + 1;
    } else {
      next.streak = 0;
      next.consecWrong = (next.consecWrong || 0) + 1;
      d.streakToday = 0;
    }
    const expAfter = totalExp(next);
    const expGain = expAfter - expBefore;
    const leveledTo = creditLevelUps(next, expBefore);
    const keysWon = (next.keys || 0) - (profile.keys || 0);

    const unlocked = [];
    next.achievedAt = next.achievedAt || {};
    ACHIEVEMENTS.forEach((a) => {
      if (!next.achievements.includes(a.id) && a.check(next)) {
        next.achievements.push(a.id);
        next.achievedAt[a.id] = Date.now();
        unlocked.push(a);
      }
    });
    if (unlocked.length > 0 || leveledTo) playJingle(!!leveledTo);
    setFeedback({ correct, unlocked, expGain, leveledTo, keysWon, rankedUp });
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
    cur.streak = 0;
    cur.consecWrong = 0;
    cur.levelReachedAt = {};
    // kept: achievements, achievedAt, lifetime counters, keys, keyedTopics,
    //       name, school, and the daily tasks / bonus XP (prestige doesn't
    //       touch the engagement loop)
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
    cur.keyedTopics = [...(cur.keyedTopics || []), topic.id];
    if (!(cur.milestones || {}).usekey) cur.milestones = { ...(cur.milestones || {}), usekey: "ready" };
    setKeyTarget(null);
    saveProfile(cur);
  }

  async function loadStudents() {
    setAdminLoading(true);
    try {
      const listRes = await storage.list("student_", true);
      const keys = (listRes && listRes.keys) || [];
      const results = [];
      for (const k of keys) {
        try {
          const r = await storage.get(k, true);
          if (r && r.value) results.push(JSON.parse(r.value));
        } catch (e) { /* skip unreadable entry */ }
      }
      results.sort((a, b) => a.name.localeCompare(b.name));
      setStudents(results);
    } catch (e) { setStudents([]); }
    setAdminLoading(false);
  }

  function openAdmin() {
    setScreen("admin");
    loadStudents();
  }

  function openLeaderboard() {
    setScreen("leaderboard");
    loadBoard();
    markMilestone("leaderboard");
  }

  function openFriends() {
    setFriendView(null);
    setFriendResults(null);
    setFriendQuery("");
    setScreen("friends");
  }

  // Search students by name. The record key already contains the name
  // slug (student_<name>__<pin>), so we filter keys first and only fetch
  // the matches — no full table scan.
  async function runFriendSearch() {
    const q = friendQuery.trim();
    const qs = slug(q);
    if (!qs || friendLoading) return;
    setFriendLoading(true);
    setFriendView(null);
    setFriendResults(null);
    let keys = [];
    try {
      const res = await storage.list("student_", true);
      keys = (res && res.keys) || [];
    } catch (e) { /* offline */ }
    const matches = keys
      .map((k) => ({ key: k, nameSlug: k.replace(/^student_/, "").replace(/__\d+$/, "") }))
      .filter((x) => x.nameSlug.includes(qs))
      .slice(0, 30);
    const out = [];
    for (const m of matches) {
      try {
        const r = await storage.get(m.key, true);
        if (r && r.value) out.push(JSON.parse(r.value));
      } catch (e) { /* skip */ }
    }
    out.sort((a, b) => leaderboardScore(b) - leaderboardScore(a) || (a.name || "").localeCompare(b.name || ""));
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

  // Client-side aggregation: read every student record, group by school,
  // rank by the sum of the school's top-10 leaderboard scores. Ties go to
  // whichever school assembled that top-10 earliest.
  async function loadBoard() {
    setBoard({ loading: true, schools: [] });
    let all = [];
    try {
      const listRes = await storage.list("student_", true);
      for (const k of (listRes && listRes.keys) || []) {
        try {
          const r = await storage.get(k, true);
          if (r && r.value) all.push(JSON.parse(r.value));
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* leave all empty */ }

    const bySchool = {};
    for (const s of all) {
      if (!s || !s.school || s.school === SOLO_SCHOOL) continue;
      (bySchool[s.school] = bySchool[s.school] || []).push(s);
    }
    const schools = Object.entries(bySchool).map(([name, members]) => {
      const ranked = members
        .map((m) => ({ name: m.name, score: leaderboardScore(m), prestige: m.prestige || 0, level: levelFromExp(totalExp(m)), at: lastImprovementAt(m) }))
        .sort((a, b) => b.score - a.score || a.at - b.at);
      const top = ranked.slice(0, 10);
      return {
        name,
        members: members.length,
        atMax: ranked.filter((r) => r.level >= LEVEL_CAP).length,
        score: top.reduce((sum, r) => sum + r.score, 0),
        assembledAt: top.length ? Math.max(...top.map((r) => r.at)) : Infinity,
        top,
      };
    });
    schools.sort((a, b) => b.score - a.score || a.assembledAt - b.assembledAt || a.name.localeCompare(b.name));
    setBoard({ loading: false, schools });
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

  if (!ready) return <div style={{ ...vars, minHeight: 400 }} />;

  return (
    <div style={{ ...vars, fontFamily: "Inter, sans-serif", color: "var(--ink)", minHeight: 560, position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mub-display { font-family: 'Fraunces', serif; }
        .mub-mono { font-family: 'JetBrains Mono', monospace; }
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
      `}</style>

      <div className="mub-grid" style={{ borderRadius: 20, padding: "clamp(16px, 4vw, 28px)", minHeight: 560 }}>
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
            {screen !== "login" && screen !== "parent" && screen !== "friends" && (
              <button onClick={openFriends} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Find friends
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
            {screen !== "login" && screen !== "parent" && (
              <button onClick={switchStudent} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                <RotateCcw size={13} /> switch student
              </button>
            )}
            <button onClick={toggleSound} title={soundOn ? "Achievement sound: on" : "Achievement sound: off"} aria-label="Toggle achievement sound" style={{ fontSize: 15, lineHeight: 1, background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              {soundOn ? "🔊" : "🔇"}
            </button>
            <button onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle dark mode" style={{ fontSize: 15, lineHeight: 1, background: "none", border: "none", cursor: "pointer", padding: 2 }}>
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
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
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>4-digit PIN <span style={{ fontWeight: 400 }}>(pick one you'll remember)</span></label>
            <input
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(e) => { if (e.key === "Enter") startSession(); }}
              inputMode="numeric" placeholder="e.g. 4051"
              style={{ width: "100%", marginTop: 6, marginBottom: 4, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", letterSpacing: 4 }}
            />
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14 }}>Two students can share a name but not a name + PIN. Forgot it? Ask your teacher.</div>
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
              disabled={!nameInput.trim() || !/^\d{4}$/.test(pinInput) || starting}
              style={{ width: "100%", padding: "10px 12px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", opacity: !nameInput.trim() || !/^\d{4}$/.test(pinInput) || starting ? 0.6 : 1 }}
            >
              {starting ? "Loading…" : "Start / continue"}
            </button>
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

        {/* DASHBOARD */}
        {screen === "dashboard" && (
          <div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div className="mub-display" style={{ fontSize: 22, fontWeight: 700 }}>Hi, {profile.name}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <PrestigeBadge prestige={profile.prestige} size={15} />
                    <span style={{ color: "var(--blue)", fontWeight: 600 }}>{titleForLevel(levelFromExp(totalExp(profile)))}</span>
                    <span>· Current streak: {profile.streak || 0} 🔥 · Best: {profile.bestStreak || 0}</span>
                  </div>
                  <button onClick={() => { setSchoolEditQuery(""); setShowSchool(true); }} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 12, textDecoration: "underline" }}>
                    🏫 {profile.school && profile.school !== SOLO_SCHOOL ? profile.school : "Add your school"}
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                  <button onClick={openParentLink} style={{ fontSize: 12, fontWeight: 600, color: "var(--blue)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
                    Parent link
                  </button>
                  <button onClick={() => setShowCard(true)} style={{ fontSize: 12, fontWeight: 600, color: "var(--blue)", background: "none", border: "1px solid var(--grid)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
                    Share card
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <LevelBar profile={profile} onPrestige={() => setConfirmPrestige(true)} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                <span style={{ fontSize: 15 }}>🔑</span>
                <span><b style={{ color: "var(--ink)" }}>{profile.keys || 0}</b> Skeleton Key{(profile.keys || 0) === 1 ? "" : "s"}</span>
                <span style={{ opacity: 0.7 }}>· opens a locked topic early</span>
              </div>

              {teacherMode && (
                <div style={{ border: "1px dashed var(--amber)", borderRadius: 10, padding: "10px 12px", marginTop: 12, fontSize: 12 }}>
                  <div style={{ fontWeight: 700, color: "var(--amber)", marginBottom: 8 }}>🛠 Teacher / dev tools <span style={{ fontWeight: 400, color: "var(--muted)" }}>— affects your own account</span></div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {(() => {
                      const b = { fontSize: 12, fontWeight: 600, color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 10px", cursor: "pointer" };
                      return (
                        <>
                          <button onClick={devMaxAll} style={b}>Max all topics → S+ (Level 20)</button>
                          <button onClick={devCAll} style={b}>Get C in every topic</button>
                          <button onClick={() => devAddKeys(3)} style={b}>+3 Skeleton Keys</button>
                          <select value={devTopic} onChange={(e) => setDevTopic(e.target.value)} style={{ fontSize: 12, border: "1px solid var(--grid)", borderRadius: 8, padding: "5px 8px" }}>
                            {TOPICS.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
                          </select>
                          <button onClick={devMaxTopic} style={b}>Max selected → S+</button>
                          <button onClick={devHardReset} style={{ ...b, color: "var(--red)", borderColor: "var(--red)" }}>Reset → Level 1, Prestige 0</button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {(() => {
              const day = (profile.daily && profile.daily.date === todayKey()) ? profile.daily : freshDay(profile);
              const dailyTasks = (day.tasks || []).map((id) => TASK_BY_ID[id]).filter(Boolean);
              const openMs = MILESTONES.filter((m) => (profile.milestones || {})[m.id] !== "claimed");
              const xpFor = (id) => (id === "showup" ? DAILY_XP.showup : DAILY_XP.task);
              const rowStyle = { display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 };
              return (
                <div style={{ border: "1px solid var(--grid)", background: "var(--card)", borderRadius: 12, padding: "12px 14px", marginBottom: 20 }}>
                  <div className="mub-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Today</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dailyTasks.map((task) => {
                      const done = taskDone(task, day);
                      const claimed = !!day.claimed[task.id];
                      const cur = task.id === "showup" ? 1 : task.progress(day);
                      return (
                        <div key={task.id} style={rowStyle}>
                          <span style={{ fontSize: 14, flexShrink: 0 }}>{claimed ? "✅" : done ? "🟢" : "⚪"}</span>
                          <div style={{ flex: 1, minWidth: 0, color: claimed ? "var(--muted)" : "var(--ink)" }}>
                            {typeof task.label === "function" ? task.label(day) : task.label}
                            {!claimed && !done ? <span style={{ color: "var(--muted)" }}> · {cur}/{task.goal}</span> : ""}
                          </div>
                          {claimed ? (
                            <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 700, flexShrink: 0 }}>+{xpFor(task.id)} XP</span>
                          ) : done ? (
                            <button onClick={() => claimDailyTask(task.id)} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--green)", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
                              Claim +{xpFor(task.id)}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {openMs.length > 0 && (
                    <>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 6px" }}>First-time bonuses</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {openMs.map((m) => {
                          const st = (profile.milestones || {})[m.id];
                          return (
                            <div key={m.id} style={rowStyle}>
                              <span style={{ fontSize: 14, flexShrink: 0 }}>{st === "ready" ? "🟢" : "⚪"}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>{m.label}</div>
                              {st === "ready" && (
                                <button onClick={() => claimMilestone(m.id)} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
                                  Claim +{MILESTONE_XP}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}

            {(() => {
              const lvl = levelFromExp(totalExp(profile));
              const mixedOpen = lvl >= MIXED_UNLOCK_LEVEL;
              return (
                <button
                  onClick={startMixed}
                  disabled={!mixedOpen}
                  className={mixedOpen ? "mub-card" : ""}
                  style={{
                    width: "100%", textAlign: "left", marginBottom: 20, cursor: mixedOpen ? "pointer" : "not-allowed",
                    display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 14,
                    border: `1px solid ${mixedOpen ? "var(--blue)" : "var(--grid)"}`,
                    background: mixedOpen ? "var(--card)" : "var(--locked)", opacity: mixedOpen ? 1 : 0.6,
                  }}
                >
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
                        🔑 Use key
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
              );
            })()}

            <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <Trophy size={16} /> Achievements
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}>
                {profile.achievements.filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length}/{ACHIEVEMENTS.length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {TIERS.map((tier) => {
                const items = ACHIEVEMENTS.filter((a) => a.tier === tier);
                if (!items.length) return null;
                const tc = TIER_COLOR[tier];
                const earned = items.filter((a) => profile.achievements.includes(a.id)).length;
                return (
                  <div key={tier}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 9, height: 9, background: tc, transform: "rotate(45deg)", display: "inline-block" }} />
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: tc }}>{tier}</span>
                      <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{earned}/{items.length}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {items.map((a) => {
                        const unlocked = profile.achievements.includes(a.id);
                        const hidden = a.secret && !unlocked;
                        return (
                          <div key={a.id} title={hidden ? "Secret achievement — revealed when earned" : a.desc} style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 999,
                            background: unlocked ? "var(--card)" : "transparent",
                            border: `1px solid ${unlocked ? tc : "var(--grid)"}`,
                            boxShadow: unlocked ? `inset 0 0 0 2px ${tc}22` : "none",
                            opacity: unlocked ? 1 : 0.4, fontSize: 12.5,
                          }}>
                            <span style={{ fontSize: 16, filter: unlocked ? "none" : "grayscale(1)" }}>{hidden ? "❔" : a.icon}</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>{hidden ? "???" : a.name}</div>
                              <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{hidden ? "???" : a.desc}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
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
            <button onClick={() => setScreen("dashboard")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> back to topics
            </button>

            <div style={{
              maxWidth: 520, margin: "0 auto", background: "var(--card)", border: "1px solid var(--grid)",
              borderLeft: "4px solid var(--red)", borderRadius: 10, padding: "18px 16px 18px 18px",
              transform: "rotate(-0.4deg)", boxShadow: "0 6px 24px var(--shadow-soft)", position: "relative", overflow: "hidden",
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
                    <div className="mub-mono" style={{ fontSize: expr ? 13 : 17, lineHeight: 1.5, color: expr ? "var(--muted)" : "var(--ink)", overflowWrap: "break-word" }}>{lead}</div>
                    {expr && (
                      <div className="mub-mono" style={{ fontSize: exprSize, fontWeight: 600, lineHeight: 1.4, marginTop: 6, color: "var(--ink)", overflowWrap: "break-word" }}>{expr}</div>
                    )}
                  </div>
                );
              })()}

              <input
                ref={answerRef}
                autoFocus className="mub-mono" value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { feedback ? nextQuestion() : submitAnswer(); } }}
                placeholder={question.hint}
                disabled={!!feedback}
                style={{ width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid var(--grid)", borderRadius: 8, boxSizing: "border-box", marginBottom: 10 }}
              />

              {!feedback && (() => {
                const ctx = `${question.hint || ""} ${question.answer || ""}`;
                const syms = [];
                if (/π/.test(ctx)) syms.push("π");
                if (/√|sqrt/i.test(ctx)) syms.push("√");
                if (question.topicId === "standardform" && /10\^/.test(question.answer || "")) syms.push("×10^");
                else if (/\^/.test(ctx)) syms.push("^");
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

              {!feedback && (
                <button onClick={submitAnswer} style={{ padding: "9px 18px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                  Check answer
                </button>
              )}

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
                        {question.steps.map((s, i) => <li key={i} className="mub-mono" style={{ marginBottom: 4 }}>{s}</li>)}
                      </ol>
                      <div style={{ marginTop: 6 }}>Answer: <span className="mub-mono" style={{ fontWeight: 700 }}>{question.answer}</span></div>
                    </div>
                  )}
                  {feedback.unlocked.length > 0 && (
                    <div style={{ fontSize: 12.5, color: "var(--amber)", fontWeight: 600, marginBottom: 12 }}>
                      🎉 Achievement unlocked: {feedback.unlocked.map((a) => `${a.name} (${a.tier})`).join(", ")}
                    </div>
                  )}
                  {feedback.leveledTo && (
                    <div className="mub-stamp" style={{ fontSize: 12.5, color: "var(--blue)", fontWeight: 700, marginBottom: 10 }}>
                      ⭐ Level up! You&rsquo;re now Level {feedback.leveledTo}
                      {feedback.keysWon > 0 && ` · 🔑 +${feedback.keysWon} Skeleton Key${feedback.keysWon > 1 ? "s" : ""}`}
                    </div>
                  )}
                  {feedback.expGain > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>+{feedback.expGain} XP</div>
                      <LevelBar profile={profile} />
                    </div>
                  )}
                  <div>
                    <button onClick={nextQuestion} style={{ padding: "9px 18px", background: "var(--ink)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                      Next question →
                    </button>
                  </div>
                </div>
              )}
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

        {/* FIND A FRIEND */}
        {screen === "friends" && (
          <div>
            <button onClick={() => { if (friendView) setFriendView(null); else setScreen("dashboard"); }} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
              <ArrowLeft size={14} /> {friendView ? "back to results" : "back"}
            </button>
            {friendView ? (
              <div>
                <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>{friendView.name}</div>
                <StudentProfileView profile={friendView} />
              </div>
            ) : (
              <div>
                <div className="mub-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Find a friend</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16 }}>Search by name to see someone&rsquo;s profile card and grades.</div>
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
                    {friendResults.map((s, i) => (
                      <button key={i} onClick={() => { setFriendView(s); markMilestone("friendview"); }} style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 10, background: "var(--card)", cursor: "pointer", color: "var(--ink)" }}>
                        <PrestigeBadge prestige={s.prestige} size={16} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.school && s.school !== SOLO_SCHOOL ? s.school : "Solo"}
                          </div>
                        </div>
                        <span className="mub-display" style={{ fontSize: 13, fontWeight: 700, color: "var(--blue)", flexShrink: 0 }}>Lv {levelFromExp(totalExp(s))}</span>
                      </button>
                    ))}
                  </div>
                )}
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
              <div className="mub-display" style={{ fontSize: 20, fontWeight: 700 }}>School Leaderboard</div>
              <button onClick={loadBoard} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <RotateCcw size={12} /> refresh
              </button>
            </div>
            <div style={{ marginBottom: 16 }} />
            {!board || board.loading ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>
            ) : board.schools.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>No schools ranked yet — students choose a school when they register.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {board.schools.map((s, i) => {
                  const mine = profile.school && profile.school !== SOLO_SCHOOL && s.name === profile.school;
                  const rankColor = ["#D4A017", "#9AA3AE", "#B07437"][i] || "var(--blue)";
                  return (
                    <div key={s.name} style={{ border: `1px solid ${mine ? "var(--blue)" : "var(--grid)"}`, borderRadius: 12, padding: "12px 14px", background: "var(--card)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="mub-display" style={{ fontSize: 18, fontWeight: 700, color: rankColor, minWidth: 30, flexShrink: 0 }}>#{i + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{s.name}{mine ? " · your school" : ""}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.members} student{s.members === 1 ? "" : "s"}</div>
                        </div>
                        <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{s.score}</div>
                      </div>
                      {s.top.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                          {s.top.map((m, j) => (
                            <span key={j} style={{ fontSize: 10.5, color: "var(--muted)", border: "1px solid var(--grid)", borderRadius: 999, padding: "2px 7px" }}>
                              {m.name} · {m.prestige ? `P${m.prestige} ` : ""}L{m.level}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {showCard && (
        <div
          onClick={() => setShowCard(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <ProfileCard profile={profile} />
            <div style={{ fontSize: 11, color: "#fff", opacity: 0.8 }}>Screenshot this to share · tap outside to close</div>
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
            <div className="mub-display" style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>🔑 Use a Skeleton Key?</div>
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
