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
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }
function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }
function roundToSF(num, sf) {
  if (num === 0) return 0;
  const mag = Math.pow(10, sf - Math.ceil(Math.log10(Math.abs(num))));
  return Math.round(num * mag) / mag;
}

// "Instruction: expression" → drop the expression onto its own line so it
// doesn't wrap awkwardly mid-sum. No colon → the whole prompt is the lead.
function splitPrompt(prompt) {
  const i = (prompt || "").indexOf(":");
  if (i === -1 || i > prompt.length - 3) return { lead: prompt || "", expr: "" };
  return { lead: prompt.slice(0, i + 1).trim(), expr: prompt.slice(i + 1).trim() };
}

const TOPICS = [
  { id: "arithmetic", name: "Arithmetic", icon: "➕", prereqs: [],
    generate() {
      // A mix of BODMAS shapes — brackets, orders (powers & roots),
      // division, multiplication, add/subtract. Every answer is a
      // non-negative whole number.
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
      const q = forms[randInt(0, forms.length - 1)]();
      return { prompt: `Work out (follow the order of operations):   ${q.prompt}`, answer: `${q.answer}`, hint: "Enter a number.", steps: q.steps };
    } },
  { id: "hcflcm", name: "HCF & LCM", icon: "➗", prereqs: ["arithmetic"],
    generate() {
      const a = randInt(4, 24), b = randInt(4, 24), mode = Math.random() < 0.5 ? "HCF" : "LCM", g = gcd(a, b);
      return { prompt: `Find the ${mode} of ${a} and ${b}`, answer: `${mode === "HCF" ? g : lcm(a, b)}`, hint: "Enter a number.",
        steps: mode === "HCF"
          ? [`Use the Euclidean algorithm or list common factors of ${a} and ${b}`, `HCF(${a}, ${b}) = ${g}`]
          : [`LCM = (${a} × ${b}) ÷ HCF(${a}, ${b})`, `HCF(${a}, ${b}) = ${g}`, `LCM = ${a * b} ÷ ${g} = ${lcm(a, b)}`] };
    } },
  { id: "indices", name: "Indices", icon: "⚡", prereqs: [],
    generate() {
      const a = randInt(2, 9), b = randInt(2, 9), p = randInt(1, 4), q = randInt(1, 4);
      return { prompt: `Simplify:   ${a}x^${p} × ${b}x^${q}`, answer: `${a * b}x^${p + q}`, hint: "e.g. 12x^5",
        steps: [`Multiply the coefficients: ${a} × ${b} = ${a * b}`, `Add the powers (same base): x^${p} × x^${q} = x^${p + q}`, `Answer: ${a * b}x^${p + q}`] };
    } },
  { id: "surds", name: "Surds", icon: "√", prereqs: ["indices"],
    generate() {
      const k = randInt(2, 6), b = randInt(2, 9);
      return { prompt: `Simplify:   √${k * k * b}`, answer: `${k}√${b}`, hint: "e.g. 3√5 or sqrt(45)",
        steps: [`Split into a perfect square × another factor: ${k * k * b} = ${k * k} × ${b}`, `√${k * k * b} = √${k * k} × √${b} = ${k} × √${b}`, `Answer: ${k}√${b}`] };
    } },
  { id: "standardform", name: "Standard Form", icon: "🔟", prereqs: ["indices"],
    generate() {
      const base = randInt(10, 99) / 10, exp = randInt(2, 6), value = Math.round(base * Math.pow(10, exp));
      return { prompt: `Write ${value} in standard form`, answer: `${base}*10^${exp}`, hint: "e.g. 4.5*10^4",
        steps: [`Move the decimal point until you have a number between 1 and 10: ${base}`, `Count how many places it moved: ${exp}`, `Answer: ${base} × 10^${exp}`] };
    } },
  { id: "sigfig", name: "Significant Figures", icon: "🎯", prereqs: [],
    generate() {
      const scale = [1, 0.1, 0.01][randInt(0, 2)], raw = (randInt(1000, 9999) * scale) / 100, sf = randInt(1, 3), ans = roundToSF(raw, sf);
      return { prompt: `Round ${raw} to ${sf} significant figure${sf > 1 ? "s" : ""}`, answer: `${ans}`, hint: "Enter a number.",
        steps: [`Identify the first ${sf} significant figure${sf > 1 ? "s" : ""} of ${raw}`, `Look at the next digit to round up or keep it as is`, `Rounded: ${ans}`] };
    } },
  { id: "limits", name: "Limits of Accuracy", icon: "📏", prereqs: ["sigfig"],
    generate() {
      const v = randInt(5, 200), bound = Math.random() < 0.5 ? "upper" : "lower", ans = bound === "upper" ? v + 0.5 : v - 0.5;
      return { prompt: `A length is measured as ${v} cm, correct to the nearest cm. Find the ${bound} bound`, answer: `${ans}`, hint: "Enter a number.",
        steps: [`Rounded to the nearest cm means it could be up to 0.5 cm higher or lower`, `${bound === "upper" ? "Upper" : "Lower"} bound = ${v} ${bound === "upper" ? "+" : "−"} 0.5 = ${ans}`] };
    } },
  { id: "time", name: "Time", icon: "⏰", prereqs: [],
    generate() {
      const h = randInt(1, 4), m = randInt(0, 59);
      return { prompt: `A journey takes ${h} hour${h > 1 ? "s" : ""} and ${m} minutes. How many minutes is that in total?`, answer: `${h * 60 + m}`, hint: "Enter a number.",
        steps: [`Convert hours to minutes: ${h} × 60 = ${h * 60}`, `Add the extra minutes: ${h * 60} + ${m} = ${h * 60 + m}`] };
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
      return { prompt: `Solve for x:   ${a}x + ${b}y = ${e}   and   ${c}x + ${d}y = ${f}`, answer: `${xSol}`, hint: "Enter a number.",
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
   Levelling (Mastery Challenge). EXP is earned ONLY when a
   topic's grade ratchets up — ungraded→F, F→E, … S→S+. It's
   a pure function of the current topic ranks, never stored,
   so it can't drift and needs no migration for old profiles.
   The total EXP available across all 30 topics is exactly the
   amount needed for the Level-20 cap, so Level 20 ⇔ S+ in
   every topic. Each level costs more than the last, and the
   very first correct answer (ungraded→F) is enough for Lv 2.
--------------------------------------------------------- */
const LEVEL_CAP = 20;
// XP for entering each rank: F, E, D, C, B, A, A*, S, S+  (arithmetic, +10)
const RANK_STEP_EXP = [10, 20, 30, 40, 50, 60, 70, 80, 90];
// RANK_CUM_EXP[k] = XP a topic is worth once it has reached rank index k
//   → [10, 30, 60, 100, 150, 210, 280, 360, 450]; a maxed topic = 450, ×30 = 13500
const RANK_CUM_EXP = RANK_STEP_EXP.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], []);
// LEVEL_CUM_EXP[i] = total XP required to be level (i + 1). Per-level cost is
// 10·L·(L+1)/2 (10, 30, 60, 100, 150, 210 …) with a 2100 final push, so every
// threshold is a multiple of 10 and the total is exactly 13500 = all topics S+.
const LEVEL_CUM_EXP = [
  0, 10, 40, 100, 200, 350, 560, 840, 1200, 1650,
  2200, 2860, 3640, 4550, 5600, 6800, 8160, 9690, 11400, 13500,
];

function totalExp(profile) {
  const topics = (profile && profile.topics) || {};
  return TOPICS.reduce((sum, t) => {
    const k = (topics[t.id] || {}).highestRank ?? -1;
    return sum + (k >= 0 ? RANK_CUM_EXP[Math.min(k, RANK_CUM_EXP.length - 1)] : 0);
  }, 0);
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
  const canPrestige = capped && prestige < PRESTIGE_CAP && typeof onPrestige === "function";
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
      {canPrestige && (
        <button onClick={onPrestige} style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--amber)", border: "none", borderRadius: 8, padding: "5px 12px", cursor: "pointer", flexShrink: 0 }}>
          Prestige →
        </button>
      )}
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

/* Shareable summary of a student's progress. Pure display — takes a
   profile object, so the same card backs the (upcoming) Parent Link
   page. Sized to screenshot cleanly. */
function ProfileCard({ profile }) {
  const exp = totalExp(profile);
  const { level, into, need, pct, capped } = levelProgress(exp);
  const title = titleForLevel(level);
  const achCount = (profile.achievements || []).filter((id) => ACHIEVEMENTS.some((a) => a.id === id)).length;
  const ranked = TOPICS.filter((t) => ((profile.topics || {})[t.id] || {}).highestRank >= 0);
  const best = [...ranked]
    .sort((a, b) => ((profile.topics[b.id] || {}).highestRank ?? -1) - ((profile.topics[a.id] || {}).highestRank ?? -1))
    .slice(0, 5);
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

      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Top topics
      </div>
      {best.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>No topics ranked yet.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {best.map((t) => {
            const r = rankDisplay((profile.topics[t.id] || {}).highestRank);
            return (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 999, border: `1px solid ${r.color}`, fontSize: 11, background: "var(--card)" }}>
                <span>{t.icon}</span>
                <span style={{ fontWeight: 700, color: r.color }}>{r.label}</span>
              </div>
            );
          })}
        </div>
      )}
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

const emptyProfile = () => ({
  name: "", school: SOLO_SCHOOL, topics: {}, achievements: [], achievedAt: {},
  streak: 0, bestStreak: 0, fastCorrect: 0, minuteCorrect: 0, totalCorrect: 0,
  consecWrong: 0, nightOwl: false, comeback: false, solvedSurd: false, got67: false,
  prestige: 0, prestigeAt: [], keys: 0, keyedTopics: [], levelReachedAt: {},
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
  function devApplyMax(next, topicIds) {
    topicIds.forEach((id) => { next.topics[id] = { history: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], highestRank: S_PLUS_IDX, streak: STREAK_FOR_S_PLUS }; });
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
    devApplyMax(next, [devTopic]);
    saveProfile(next);
  }
  function devMaxAll() {
    const next = JSON.parse(JSON.stringify(profile));
    devApplyMax(next, TOPICS.map((t) => t.id));
    next.keys = Math.max(next.keys || 0, 4); // as if the 5/10/15/20 milestones were hit
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
    const correct = checkEquivalent(answerInput, question.answer);
    const expBefore = totalExp(profile);
    const scoredId = question.topicId || activeTopic.id; // Mixed Review scores the source topic
    const next = JSON.parse(JSON.stringify(profile));
    const t = next.topics[scoredId] || { history: [], highestRank: -1, streak: 0 };
    t.history = [...t.history, correct ? 1 : 0].slice(-10);
    t.streak = correct ? (t.streak || 0) + 1 : 0;
    let candidateIdx = rankIndexForAvg(avgFromHistory(t.history));
    if (t.streak >= STREAK_FOR_S_PLUS) candidateIdx = Math.max(candidateIdx, RANK_ORDER.indexOf("S+"));
    t.highestRank = Math.max(t.highestRank ?? -1, candidateIdx); // ratchet: never decreases
    next.topics[scoredId] = t;

    const nowHour = new Date().getHours();
    if (nowHour >= 0 && nowHour < 4) next.nightOwl = true; // "Night Owl" — any answer, 12am–4am

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
    } else {
      next.streak = 0;
      next.consecWrong = (next.consecWrong || 0) + 1;
    }
    const expAfter = totalExp(next);
    const expGain = expAfter - expBefore;
    const lvlBefore = levelFromExp(expBefore);
    const lvlAfter = levelFromExp(expAfter);
    let keysWon = 0;
    if (lvlAfter > lvlBefore) {
      next.levelReachedAt = next.levelReachedAt || {};
      for (let L = lvlBefore + 1; L <= lvlAfter; L++) {
        if (!next.levelReachedAt[L]) next.levelReachedAt[L] = Date.now();
        if (L % 5 === 0) keysWon += 1; // a Skeleton Key every 5 levels (5, 10, 15, 20)
      }
      if (keysWon) next.keys = (next.keys || 0) + keysWon;
    }
    const leveledTo = lvlAfter > lvlBefore ? lvlAfter : null;

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
    setFeedback({ correct, unlocked, expGain, leveledTo, keysWon });
    saveProfile(next);
  }

  function doPrestige() {
    const cur = JSON.parse(JSON.stringify(profile));
    if ((cur.prestige || 0) >= PRESTIGE_CAP) return;
    if (levelFromExp(totalExp(cur)) < LEVEL_CAP) return;
    cur.prestige = (cur.prestige || 0) + 1;
    cur.prestigeAt = [...(cur.prestigeAt || []), Date.now()];
    cur.topics = {};            // grades wiped → XP and level reset to 1
    cur.streak = 0;
    cur.consecWrong = 0;
    cur.levelReachedAt = {};
    // kept: achievements, achievedAt, lifetime counters, keys, keyedTopics, name, school
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
  }

  function openParentLink() {
    if (!profile.parentToken) saveProfile({ ...profile, parentToken: genToken() });
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
        .mub-stamp { animation: stampIn 0.4s ease-out; }
        .mub-wobble { animation: wobble 0.35s ease-in-out; }
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
              <LevelBar profile={profile} onPrestige={() => setConfirmPrestige(true)} />
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

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12, marginBottom: 26 }}>
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
                      border: "1px solid var(--grid)", borderRadius: 14, padding: 14,
                      cursor: unlocked ? "pointer" : "not-allowed",
                      opacity: unlocked ? 1 : 0.55,
                      position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ fontSize: 24, filter: unlocked ? "none" : "grayscale(1)" }}>{t.icon}</div>
                      {unlocked ? (
                        <div style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${rank.color}`, color: rank.color, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11 }}>
                          {rank.label}
                        </div>
                      ) : (
                        <div style={{ fontSize: 15, color: "var(--muted)" }}>🔒</div>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {unlocked
                        ? `${(topicState.streak || 0) > 0 ? "🔥 " : ""}${topicState.streak || 0} streak`
                        : lockedReason(t)}
                    </div>
                    {!unlocked && (profile.keys || 0) > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setKeyTarget(t); }}
                        style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: "var(--blue)", background: "var(--card)", border: "1px solid var(--blue)", borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}
                      >
                        🔑 Use key
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

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
              borderLeft: "4px solid var(--red)", borderRadius: 10, padding: "26px 26px 26px 30px",
              transform: "rotate(-0.4deg)", boxShadow: "0 6px 24px var(--shadow-soft)", position: "relative",
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
                const mathOnly = expr && !/[a-z]{3,}/i.test(expr);
                return (
                  <div style={{ marginBottom: 18 }}>
                    <div className="mub-mono" style={{ fontSize: expr ? 14 : 17, lineHeight: 1.55, color: expr ? "var(--muted)" : "var(--ink)" }}>{lead}</div>
                    {expr && (
                      <div className="mub-mono" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.5, marginTop: 8, color: "var(--ink)", ...(mathOnly ? { whiteSpace: "nowrap", overflowX: "auto" } : {}) }}>{expr}</div>
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
                if (/\^/.test(ctx)) syms.push("^");
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
                  <div className={feedback.correct ? "mub-stamp" : "mub-wobble"} style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8,
                    border: `2px solid ${feedback.correct ? "var(--green)" : "var(--red)"}`,
                    color: feedback.correct ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 13,
                    transform: "rotate(-8deg)", marginBottom: 12,
                  }}>
                    {feedback.correct ? <Check size={15} /> : <XIcon size={15} />}
                    {feedback.correct ? "CORRECT" : "TRY AGAIN"}
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
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
                  <ProfileCard profile={parentView} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Grade in every topic</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                  {TOPICS.map((t) => {
                    const r = rankDisplay(((parentView.topics || {})[t.id] || {}).highestRank);
                    return (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "8px 10px", border: "1px solid var(--grid)", borderRadius: 10, background: "var(--card)" }}>
                        <span style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.icon} {t.name}</span>
                        <span style={{ fontWeight: 700, fontSize: 12, color: r.color, flexShrink: 0 }}>{r.label}</span>
                      </div>
                    );
                  })}
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
    </div>
  );
}
