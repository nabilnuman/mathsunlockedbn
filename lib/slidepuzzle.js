// 3x3 sliding-tile puzzle (tiles 1-8 + blank) — board model, an exact-optimal
// solver (BFS outward from the goal, since the whole depth<=9 neighborhood is
// tiny), and a deterministic daily-puzzle picker.
//
// Board representation: a flat array of 9 ints, row-major, 0 = blank.
//   [0 1 2]
//   [3 4 5]
//   [6 7 8]
export const GOAL = [1, 2, 3, 4, 5, 6, 7, 8, 0];

export function stateKey(state) {
  return state.join("");
}
export function sameState(a, b) {
  return stateKey(a) === stateKey(b);
}
export function isSolved(state) {
  return sameState(state, GOAL);
}
function neighborsOfPos(pos) {
  const r = (pos / 3) | 0, c = pos % 3;
  const out = [];
  if (r > 0) out.push(pos - 3);
  if (r < 2) out.push(pos + 3);
  if (c > 0) out.push(pos - 1);
  if (c < 2) out.push(pos + 1);
  return out;
}
function swapped(state, i, j) {
  const next = state.slice();
  next[i] = state[j];
  next[j] = state[i];
  return next;
}
// The tile a player would need to tap to move it into the blank spot,
// or -1 if `pos` isn't adjacent to the blank.
export function tileMovableAt(state, pos) {
  const blank = state.indexOf(0);
  return neighborsOfPos(blank).includes(pos) ? state[pos] : -1;
}
export function moveTileAt(state, pos) {
  const blank = state.indexOf(0);
  if (!neighborsOfPos(blank).includes(pos)) return state;
  return swapped(state, blank, pos);
}

// BFS outward from the solved state — every solvable board is within this
// same connected graph, so exploring it from GOAL instead of from a random
// scramble gives every state's exact optimal distance (and a parent pointer
// back toward GOAL) in one pass, which is all a picker constrained to an
// exact move-count range needs. The depth<=MAX_DEPTH neighborhood is a few
// hundred states, so this runs in well under a millisecond.
const MAX_DEPTH = 9;
let _bfsCache = null;
function bfsFromGoal() {
  if (_bfsCache) return _bfsCache;
  const dist = new Map([[stateKey(GOAL), 0]]);
  const parent = new Map([[stateKey(GOAL), null]]); // child key -> state one step closer to GOAL
  let frontier = [GOAL];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const state of frontier) {
      const blank = state.indexOf(0);
      for (const np of neighborsOfPos(blank)) {
        const ns = swapped(state, blank, np);
        const k = stateKey(ns);
        if (!dist.has(k)) {
          dist.set(k, depth + 1);
          parent.set(k, state);
          next.push(ns);
        }
      }
    }
    frontier = next;
  }
  _bfsCache = { dist, parent };
  return _bfsCache;
}
// The full state-by-state path from `start` to GOAL, walking the BFS parent
// pointers — length = dist(start) + 1 states, dist(start) moves.
export function solutionPath(start) {
  const { parent } = bfsFromGoal();
  const path = [start];
  let cur = start;
  while (!isSolved(cur)) {
    const p = parent.get(stateKey(cur));
    if (!p) break; // start wasn't in the depth<=MAX_DEPTH neighborhood
    path.push(p);
    cur = p;
  }
  return path;
}

// Small deterministic PRNG (mulberry32) plus a string seeder, so a given
// day-seed always produces the same puzzle for everyone.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Picks today's puzzle: an exact-optimal-6..9-move scramble of GOAL, biased
// toward 8 ("least 6, less than 10, most within 8"), fully determined by
// `seedStr` (e.g. the same Brunei day-string the rest of the app uses for
// Daily Challenge) so every player gets the identical board. Returns
// { start, path } where `path` is the full start->GOAL state sequence
// (path.length - 1 === the puzzle's true optimal move count) used both to
// scramble the board and to drive hints later.
export function dailySlidePuzzle(seedStr) {
  const { dist } = bfsFromGoal();
  const buckets = { 6: [], 7: [], 8: [], 9: [] };
  for (const [k, d] of dist) {
    if (buckets[d]) buckets[d].push(k);
  }
  const rand = mulberry32(seedFromString(String(seedStr)));
  // 60% weight on 8, the rest split across 6/7/9 — deterministic given rand().
  const roll = rand();
  const targetDepth = roll < 0.6 ? 8 : [6, 7, 9][Math.floor(rand() * 3)];
  const bucket = buckets[targetDepth].length ? buckets[targetDepth] : buckets[8];
  const key = bucket[Math.floor(rand() * bucket.length)];
  const start = key.split("").map(Number);
  return { start, path: solutionPath(start) };
}
