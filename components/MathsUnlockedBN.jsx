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

const TOPICS = [
  { id: "arithmetic", name: "Arithmetic", icon: "➕", prereqs: [],
    generate() {
      const a = randInt(2, 12), b = randInt(2, 9), c = randInt(2, 9), d = randInt(1, 10);
      return { prompt: `Work out (follow order of operations):   ${a} + ${b} × ${c} − ${d}`, answer: `${a + b * c - d}`, hint: "Enter a number.",
        steps: [`Multiply first: ${b} × ${c} = ${b * c}`, `Then add/subtract left to right: ${a} + ${b * c} − ${d} = ${a + b * c - d}`] };
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
// EXP for entering each rank: F, E, D, C, B, A, A*, S, S+
const RANK_STEP_EXP = [2, 3, 4, 6, 9, 14, 20, 28, 40];
// RANK_CUM_EXP[k] = EXP a topic is worth once it has reached rank index k
const RANK_CUM_EXP = RANK_STEP_EXP.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], []);
// EXP to go from level L to L+1, for L = 1..19 (sums to 3780 = 30 topics × 126)
const LEVEL_STEP_EXP = [2, 13, 25, 40, 56, 75, 95, 118, 142, 169, 198, 228, 261, 295, 332, 370, 411, 453, 497];
// LEVEL_CUM_EXP[i] = total EXP required to be level (i + 1)
const LEVEL_CUM_EXP = LEVEL_STEP_EXP.reduce((acc, v) => [...acc, acc[acc.length - 1] + v], [0]);

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
function LevelBar({ exp }) {
  const { level, into, need, pct, capped } = levelProgress(exp);
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--grid)", borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
      <div className="mub-display" style={{ fontSize: 15, fontWeight: 700, color: "var(--blue)", flexShrink: 0, display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 0.5 }}>LV</span>{level}
      </div>
      <div style={{ flex: 1, minWidth: 40 }}>
        <div style={{ height: 8, background: "var(--locked)", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: capped ? "var(--amber)" : "var(--blue)", transition: "width 0.4s ease" }} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", flexShrink: 0, fontWeight: 600 }}>
        {capped ? "MAX · Level 20" : `${into} / ${need} XP`}
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
  return topic.prereqs.every((pid) => ((profile.topics[pid] || {}).highestRank ?? -1) >= UNLOCK_RANK);
}
function lockedReason(topic) {
  const names = topic.prereqs.map((pid) => TOPIC_BY_ID[pid].name);
  return `Unlocks after reaching C in ${names.join(" & ")}`;
}

const emptyProfile = () => ({
  name: "", topics: {}, achievements: [], streak: 0, bestStreak: 0,
  fastCorrect: 0, minuteCorrect: 0, totalCorrect: 0, consecWrong: 0,
  nightOwl: false, comeback: false, solvedSurd: false, got67: false,
});
const slug = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "student";

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
  const [theme, setTheme] = useState("light");
  const [soundOn, setSoundOn] = useState(true);
  const [teacherMode, setTeacherMode] = useState(false);
  const startTimeRef = useRef(null);
  const audioCtxRef = useRef(null);

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
    if (bank.length && Math.random() < 0.5) {
      const q = bank[randInt(0, bank.length - 1)];
      return { prompt: q.prompt, answer: q.answer, hint: q.hint || "Enter your answer.", steps: q.steps && q.steps.length ? q.steps : ["Check your working carefully."] };
    }
    return topic.generate();
  }

  async function saveProfile(next) {
    setProfile(next);
    try { await storage.set("profile", JSON.stringify(next)); } catch (e) { /* ignore */ }
    if (next.name) {
      try { await storage.set(`student_${slug(next.name)}`, JSON.stringify(next), true); } catch (e) { /* ignore */ }
    }
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
    setQuestion(pickQuestion(activeTopic));
    setAnswerInput("");
    setFeedback(null);
    startTimeRef.current = Date.now();
  }

  function submitAnswer() {
    if (!answerInput.trim() || feedback) return;
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    const correct = checkEquivalent(answerInput, question.answer);
    const expBefore = totalExp(profile);
    const next = JSON.parse(JSON.stringify(profile));
    const t = next.topics[activeTopic.id] || { history: [], highestRank: -1, streak: 0 };
    t.history = [...t.history, correct ? 1 : 0].slice(-10);
    t.streak = correct ? (t.streak || 0) + 1 : 0;
    let candidateIdx = rankIndexForAvg(avgFromHistory(t.history));
    if (t.streak >= STREAK_FOR_S_PLUS) candidateIdx = Math.max(candidateIdx, RANK_ORDER.indexOf("S+"));
    t.highestRank = Math.max(t.highestRank ?? -1, candidateIdx); // ratchet: never decreases
    next.topics[activeTopic.id] = t;

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
      if (activeTopic.id === "surds") next.solvedSurd = true; // "Root of the Problem"
      if (String(question.answer).trim() === "67") next.got67 = true; // "67"
    } else {
      next.streak = 0;
      next.consecWrong = (next.consecWrong || 0) + 1;
    }
    const expAfter = totalExp(next);
    const expGain = expAfter - expBefore;
    const leveledTo = levelFromExp(expAfter) > levelFromExp(expBefore) ? levelFromExp(expAfter) : null;

    const unlocked = [];
    ACHIEVEMENTS.forEach((a) => {
      if (!next.achievements.includes(a.id) && a.check(next)) { next.achievements.push(a.id); unlocked.push(a); }
    });
    if (unlocked.length > 0 || leveledTo) playJingle(!!leveledTo);
    setFeedback({ correct, unlocked, expGain, leveledTo });
    saveProfile(next);
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

  async function resetDemo() {
    try { await storage.delete("profile"); } catch (e) { /* ignore */ }
    setProfile(emptyProfile());
    setScreen("login");
    setNameInput("");
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
            {screen !== "login" && teacherMode && screen !== "admin" && (
              <button onClick={openAdmin} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Admin view
              </button>
            )}
            {screen !== "login" && teacherMode && screen !== "questions" && (
              <button onClick={openQuestionBank} style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                Question bank
              </button>
            )}
            {screen !== "login" && (
              <button onClick={resetDemo} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                <RotateCcw size={13} /> reset demo
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
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18 }}>All 30 topics from the checklist are here. Foundational topics start open; the rest unlock once their prerequisite topic reaches rank C.</div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Your name</label>
            <input
              value={nameInput} onChange={(e) => setNameInput(e.target.value)}
              placeholder="e.g. Amirah"
              style={{ width: "100%", marginTop: 6, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--grid)", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
            />
            <button
              onClick={() => { if (!nameInput.trim()) return; const p = emptyProfile(); p.name = nameInput.trim(); saveProfile(p); setScreen("dashboard"); }}
              style={{ width: "100%", padding: "10px 12px", background: "var(--green)", color: "var(--on-accent)", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer" }}
            >
              Create profile & begin
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
              <div className="mub-display" style={{ fontSize: 22, fontWeight: 700 }}>Hi, {profile.name}</div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>Current streak: {profile.streak || 0} 🔥 · Best: {profile.bestStreak || 0}</div>
              <LevelBar exp={totalExp(profile)} />
            </div>

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
                      {unlocked ? `${topicState.history.length} attempted` : lockedReason(t)}
                    </div>
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
                      <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                        {s.name}
                        <span className="mub-display" style={{ fontSize: 11, fontWeight: 700, color: "var(--on-accent)", background: "var(--blue)", borderRadius: 999, padding: "1px 8px" }}>
                          LV {levelFromExp(totalExp(s))}
                        </span>
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
                <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{activeTopic.icon} {activeTopic.name}</div>
                {(() => {
                  const topicStreak = (profile.topics[activeTopic.id] || {}).streak || 0;
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
              <div className="mub-mono" style={{ fontSize: 17, lineHeight: 1.6, marginBottom: 18 }}>{question.prompt}</div>

              <input
                autoFocus className="mub-mono" value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { feedback ? nextQuestion() : submitAnswer(); } }}
                placeholder={question.hint}
                disabled={!!feedback}
                style={{ width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid var(--grid)", borderRadius: 8, boxSizing: "border-box", marginBottom: 14 }}
              />

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
                    </div>
                  )}
                  {feedback.expGain > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginBottom: 4 }}>+{feedback.expGain} XP</div>
                      <LevelBar exp={totalExp(profile)} />
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
      </div>
    </div>
  );
}
