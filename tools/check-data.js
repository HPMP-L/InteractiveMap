// Checks that data.json is consistent before a suggestion is merged.
// Runs on every pull request (.github/workflows/check-data.yml). Locally: node tools/check-data.js [--fix]
// --fix rewrites data.json in the canonical format (2-space JSON), so later suggestions keep small diffs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'data.json');
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8') + '\nglobalThis.CORE = CORE;');
const CORE = globalThis.CORE;

const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const text = fs.readFileSync(file, 'utf8');
let d;
try { d = JSON.parse(text); } catch (e) { console.error(`data.json is not valid JSON: ${e.message}`); process.exit(1); }

if (CORE.format(d) !== text) {
  if (process.argv.includes('--fix')) { fs.writeFileSync(file, CORE.format(d)); console.log('data.json reformatted.'); }
  else err('data.json', 'not in the canonical format. Run: node tools/check-data.js --fix');
}

const isStr = v => typeof v === 'string';
const pids = new Set(Object.keys(d.papers || {}));
for (const [id, p] of Object.entries(d.papers || {})) {
  const w = `papers/${id}`;
  if (!/^p[a-z0-9]{3,12}$/.test(id)) err(w, 'bad paper id');
  for (const k of CORE.PAPER_FIELDS) if (!(k in p)) err(w, `missing field ${k}`);
  for (const k of CORE.REQUIRED_NEW) if (p[k] === '' || p[k] == null) err(w, `${k} is empty`);
  for (const k of ['status', 'evidence', 'verdict', 'proximity']) if (!CORE.ENUMS[k].includes(p[k])) err(w, `unknown ${k} “${p[k]}”`);
  if (p.url && !/^https?:\/\/\S+$/.test(p.url)) err(w, 'url must start with http(s)://');
  else if (p.url) {
    // same rule as core.js: a real site name, no user name or password hidden in the address
    let u = null; try { u = new URL(p.url); } catch { /* reported below */ }
    if (!u || u.username || u.password || !u.hostname.includes('.')) err(w, 'url is not a plain web address (no user name, a real site name)');
  }
}

const tables = d.tables || {};
for (const [tid, t] of Object.entries(tables)) {
  if (t.derivedFrom) {
    if (!tables[t.derivedFrom] || !tables[t.restrictTo]) err(`tables/${tid}`, 'derived table points to a missing table');
    continue;
  }
  const rows = new Set(), cols = new Set();
  t.groups.forEach(g => g.rows.forEach(r => { if (rows.has(r.id)) err(`tables/${tid}`, `duplicate row ${r.id}`); rows.add(r.id); }));
  t.cols.forEach(c => { if (cols.has(c.id)) err(`tables/${tid}`, `duplicate column ${c.id}`); cols.add(c.id); });
  for (const k of t.target || []) { const [r, c] = k.split('|'); if (!rows.has(r) || !cols.has(c)) err(`tables/${tid}/target`, `unknown cell ${k}`); }
  for (const [k, items] of Object.entries(t.cells)) {
    const [r, c] = k.split('|');
    if (!rows.has(r) || !cols.has(c)) err(`tables/${tid}/cells/${k}`, 'unknown row or column');
    const seen = new Set();
    items.forEach((x, i) => {
      const w = `tables/${tid}/cells/${k}/${i}`;
      if (!pids.has(x.p)) err(w, `unknown paper ${x.p}`);
      if (seen.has(x.p)) err(w, `paper ${x.p} twice in the same cell`);
      seen.add(x.p);
      if (typeof x.main !== 'boolean') err(w, 'main must be true or false');
      if (!isStr(x.why) || !x.why.trim()) err(w, 'missing reason (why)');
    });
    if (!items.length) err(`tables/${tid}/cells/${k}`, 'empty cell list (delete the key instead)');
  }
}

const nodes = new Map();
const laneIds = new Set((d.map.lanes || []).map(l => l.id));
const spanLanes = new Set((d.map.lanes || []).filter(l => l.span).map(l => l.id));
const colIds = new Set((d.map.columns || []).map(c => c.id));
if (!laneIds.size) err('map/lanes', 'no lanes');
// links to the matrices (on boxes and on lanes): the table, row and column must exist
const checkLinks = (links, w) => (links || []).forEach(l => {
  let t = tables[l.table];
  if (!t) return err(w, `link to unknown table ${l.table}`);
  if (t.derivedFrom) t = tables[t.derivedFrom] || { groups: [], cols: [] };
  if (l.row && !t.groups.some(g => g.rows.some(r => r.id === l.row))) err(w, `link to unknown row ${l.row}`);
  if (l.col && !t.cols.some(c => c.id === l.col)) err(w, `link to unknown column ${l.col}`);
});
const seenLanes = new Set();
(d.map.lanes || []).forEach((l, i) => {
  const w = `map/lanes/${i} (${l.id})`;
  if (seenLanes.has(l.id)) err(w, 'duplicate lane id'); seenLanes.add(l.id);
  if (!isStr(l.label) || !l.label.trim()) err(w, 'missing label');
  checkLinks(l.links, w);
});
(d.map.columns || []).forEach(c => { if (!(d.map.nodes || []).some(n => n.id === c.node && n.kind === 'chain')) err(`map/columns/${c.id}`, `header box ${c.node} is missing or not a chain box`); });
(d.map.nodes || []).forEach(n => { if (nodes.has(n.id)) err(`map/nodes (${n.id})`, 'duplicate node id'); nodes.set(n.id, n); });
(d.map.nodes || []).forEach((n, i) => {
  const w = `map/nodes/${i} (${n.id})`;
  if (n.kind !== 'chain') {
    if (n.parent) {
      if (n.lane || n.column) err(w, 'a box with a parent takes no lane or column (it sits where its parent is)');
      if (!nodes.has(n.parent)) err(w, `unknown parent ${n.parent}`);
      else if (nodes.get(n.parent).kind === 'note') err(w, 'a note cannot have boxes below it');
      else if (nodes.get(n.parent).kind === 'bib') err(w, 'the bibliography cannot have boxes below it');
      else if (nodes.get(n.parent).kind === 'chain') err(w, 'a column header cannot be a parent: give the box a lane and a column instead');
      // no loops: following parents must end at a root
      const seen = new Set([n.id]); let p = n.parent;
      while (p && nodes.has(p)) { if (seen.has(p)) { err(w, 'parents form a loop'); break; } seen.add(p); p = nodes.get(p).parent; }
      if (seen.size > 6) err(w, 'more than 5 levels below its lane: attach it higher up');
    } else if (n.kind === 'bib' || n.kind === 'framing') {
      if (n.lane || n.column) err(w, 'the bibliography and the problem framing sit above the lanes: no lane or column');
    } else {
      if (!laneIds.has(n.lane)) err(w, `a box without a parent needs a known lane (got “${n.lane || 'none'}”)`);
      else if (spanLanes.has(n.lane)) { if (n.column) err(w, 'a box in a lane that spans the columns takes no column'); }
      else if (!colIds.has(n.column)) err(w, `a box without a parent needs a column of the chain (got “${n.column || 'none'}”)`);
    }
  }
  (n.also || []).forEach(o => { if (!nodes.has(o)) err(w, `unknown related box ${o}`); });
  if (n.paper && !pids.has(n.paper)) err(w, `unknown paper ${n.paper}`);
  if (n.kind === 'note' ? !isStr(n.html) : !isStr(n.text)) err(w, 'missing text');
  checkLinks(n.links, w);
});

// paper links inside texts: <a data-p="p000">
const walk = (o, where) => {
  if (isStr(o)) { for (const m of o.matchAll(/data-p="([^"]+)"/g)) if (!pids.has(m[1])) err(where, `text links to unknown paper ${m[1]}`); return; }
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${where}/${i}`));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${where}/${k}`);
};
walk(d.matrices, 'matrices'); walk(d.map, 'map'); walk(d.meta, 'meta');
(d.matrices || []).forEach((m, mi) => m.sections.forEach((s, si) => {
  if (s.table && !tables[s.table]) err(`matrices/${mi}/sections/${si}`, `unknown table ${s.table}`);
  (s.cards || []).forEach((c, ci) => { if (!pids.has(c.p)) err(`matrices/${mi}/sections/${si}/cards/${ci}`, `unknown paper ${c.p}`); });
}));

if (errors.length) {
  console.error(`data.json has ${errors.length} problem(s):`);
  errors.slice(0, 200).forEach(e => console.error('  - ' + e));
  process.exit(1);
}
console.log(`data.json OK: ${pids.size} papers, ${nodes.size} map boxes, ${Object.keys(tables).length} tables.`);
