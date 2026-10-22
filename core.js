// ==== CORE BEGIN ====
// Shared by the page (preview of pending suggestions) and the worker (the version that opens the pull request).
// It validates a list of suggested changes and applies them to a copy of data.json. Keep both copies identical:
// run `python tools/sync_core.py` after editing core.js.
const CORE = (() => {
  const ENUMS = {
    status: ['published', 'lab-preprint', 'preprint', 'workshop'],
    evidence: ['production', 'testbed', 'simulation', 'analytical'],
    verdict: ['works', 'partial', 'weak', 'finding', 'reference'],
    proximity: [3, 2, 1],
  };
  const LIMITS = {
    changes: 30, mapBoxes: 5, reasonMin: 10, reason: 2000, name: 80, short: 80, title: 400, venue: 200, url: 500, long: 4000,
    why: 1500, linkText: 300, nodeText: 1500, noteTitle: 120, noteHtml: 8000, prose: 8000, plain: 1000, comment: 4000, target: 200,
  };
  const PAPER_FIELDS = ['short', 'title', 'venue', 'url', 'status', 'proximity', 'evidence', 'verdict',
    'does', 'keyResult', 'whyProximity', 'gap', 'limitation'];
  const REQUIRED_NEW = ['short', 'title', 'status', 'proximity', 'evidence', 'verdict', 'does'];
  const ONE_LINE = ['short', 'title', 'venue', 'url'];
  const LABEL = {
    short: 'Short name', title: 'Title', venue: 'Venue', url: 'Link', status: 'Publication status',
    proximity: 'Proximity to the goal', evidence: 'Evidence level', verdict: 'Verdict', does: 'What it does',
    keyResult: 'Key result', whyProximity: 'Why this proximity', gap: 'Contribution and gap', limitation: 'Limitation',
  };
  const NODE_KINDS = ['question', 'concept', 'paper'];
  const CHANGE_TYPES = ['paper.update', 'paper.add', 'placement.add', 'placement.update', 'placement.remove',
    'node.update', 'node.add', 'text.update', 'comment'];
  const TEXT_PATHS = [
    /^meta\/(title|intro|footer)$/,
    /^matrices\/\d+\/(nav|eyebrow|title|lede|footer)$/,
    /^matrices\/\d+\/sections\/\d+\/(title|intro|targetLabel|filterNote)$/,
    /^matrices\/\d+\/sections\/\d+\/items\/\d+\/(title|body)$/,
    /^matrices\/\d+\/sections\/\d+\/thesis\/(title|body)$/,
    /^matrices\/\d+\/sections\/\d+\/thesis\/items\/\d+$/,
    /^matrices\/\d+\/sections\/\d+\/rows\/\d+\/(a|b)$/,
    /^matrices\/\d+\/sections\/\d+\/cards\/\d+\/tag$/,
    /^matrices\/\d+\/sections\/\d+\/rules\/(title|items\/\d+)$/,
    /^tables\/m[1-3]\/(caption|corner)$/,
    /^tables\/m[1-3]\/groups\/\d+\/label$/,
    /^tables\/m[1-3]\/groups\/\d+\/rows\/\d+\/(name|desc)$/,
    /^tables\/m[1-3]\/cols\/\d+\/(stage|name|sub)$/,
    /^vocab\/(proximity|evidence|verdict|status)\/\d+\/(label|def)$/,
  ];
  // Texts shown as plain text on the site (titles, names, definitions): no formatting is allowed there.
  const PLAIN_PATH = /\/(nav|eyebrow|title|caption|corner|label|name|desc|stage|sub|targetLabel|filterNote|tag)$/;
  const INLINE = new Set(['b', 'i', 'code', 'br', 'a']);
  const BLOCK = new Set(['b', 'i', 'code', 'br', 'a', 'p', 'ul', 'ol', 'li', 'h4']);
  const PAPER_ID = /^p[a-z0-9]{3,12}$/;

  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  function fail(msg) { const e = new Error(msg); e.name = 'SuggestionError'; throw e; }

  function text(v, max, label, required) {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') fail(`${label} must be text.`);
    const s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2028\u2029\u2060-\u2064\u2066-\u2069\uFEFF]/g, '').trim();
    if (required && !s) fail(`${label} is empty.`);
    if (s.length > max) fail(`${label} is too long (${s.length} characters, ${max} at most).`);
    return s;
  }
  // single-line text: line breaks and runs of spaces become one space
  function line(v, max, label, required) { return text(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, max, label, required); }

  // what a short piece of markup text shows once its entities are read
  const decodeEntities = t => t.replace(/&#x([0-9a-f]+);/gi, (_, x) => safeChar(parseInt(x, 16))).replace(/&#(\d+);/g, (_, x) => safeChar(Number(x)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const safeChar = n => (n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '');
  // a link anywhere on the site: http(s), a real address, no user name or password
  function checkUrl(raw, label) {
    let u = null;
    try { u = new URL(raw); } catch { fail(`${label}: one link is not a valid address.`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${label}: links must start with http:// or https://.`);
    if (u.username || u.password) fail(`${label}: links cannot contain a user name or password.`);
    if (!u.hostname.includes('.')) fail(`${label}: one link has no proper site name.`);
  }

  // isPaper(id): true when the paper exists, so links inside texts never point to a missing card
  function markup(v, max, label, block, required, isPaper) {
    const s = text(v, max, label, required);
    const allowed = block ? BLOCK : INLINE;
    // every tag must be written in its one canonical form, so what reviewers read is exactly what is stored;
    // tags must also be closed in the order they were opened, so a link always has a visible end and a visible target
    const open = [];
    const rest = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g, (m, close, name, _attrs, at) => {
      const tag = name.toLowerCase();
      if (!allowed.has(tag)) fail(`${label}: <${tag}> is not allowed. Use plain text, bold, italics, lists or links.`);
      if (close) {
        if (m !== `</${tag}>`) fail(`${label}: write closing tags in lower case, like </b>.`);
        if (tag === 'br') fail(`${label}: <br> has no closing tag.`);
        const top = open.pop();
        if (!top || top.tag !== tag) fail(`${label}: </${tag}> does not match an open <${tag}>. Close tags in the order you opened them.`);
        if (tag === 'a') {
          const shown = s.slice(top.end, at).replace(/<[^<>]*>/g, '');
          if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(decodeEntities(shown))) fail(`${label}: one link has no text.`);
          if (shown.length > LIMITS.linkText) fail(`${label}: the text of a link is ${LIMITS.linkText} characters at most.`);
        }
        return '';
      }
      if (tag === 'a') {
        const am = /^<a (?:href="(https?:\/\/[^"\s<>]+)"|data-p="(p[a-z0-9]{3,12})")>$/.exec(m);
        if (!am) fail(`${label}: links must look like <a href="https://…">text</a>.`);
        if (am[2] && !(isPaper && isPaper(am[2]))) fail(`${label}: one link points to an unknown paper “${am[2]}”.`);
        if (am[1]) {
          if (/&(?!amp;)/.test(am[1])) fail(`${label}: write “&” in a link as “&amp;”.`);
          checkUrl(am[1].replace(/&amp;/g, '&'), label);
        }
        if (open.some(o => o.tag === 'a')) fail(`${label}: a link cannot contain another link.`);
      } else if (m !== `<${tag}>`) fail(`${label}: write tags in lower case and without attributes, like <b>.`);
      if (tag === 'li' && !(open.length && ['ul', 'ol'].includes(open[open.length - 1].tag))) fail(`${label}: list items (<li>) must sit directly inside <ul> or <ol>.`);
      if (tag !== 'br') open.push({ tag, end: at + m.length });
      return '';
    });
    if (open.length) { const t = open[open.length - 1].tag; fail(`${label}: <${t}> is not closed. Add </${t}>.`); }
    if (rest.includes('<') || rest.includes('>')) fail(`${label}: write “<” and “>” as “&lt;” and “&gt;”.`);
    return s;
  }

  function fieldValue(k, v, required) {
    if (k === 'proximity') {
      const n = Number(v);
      if (!ENUMS.proximity.includes(n)) fail('Proximity must be 1, 2 or 3.');
      return n;
    }
    if (k === 'status' || k === 'evidence' || k === 'verdict') {
      if (!ENUMS[k].includes(v)) fail(`${LABEL[k]}: unknown value “${String(v).slice(0, 40)}”.`);
      return v;
    }
    if (k === 'url') {
      const s = line(v, LIMITS.url, LABEL.url, required);
      if (s && !/^https?:\/\/[^\s<>"]+$/.test(s)) fail('The link must start with http:// or https://.');
      if (s) checkUrl(s, LABEL.url);
      return s;
    }
    const max = k === 'short' ? LIMITS.short : k === 'title' ? LIMITS.title : k === 'venue' ? LIMITS.venue : LIMITS.long;
    return (ONE_LINE.includes(k) ? line : text)(v, max, LABEL[k], required);
  }

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }

  // shortened label; tags are removed only from markup values (plain titles may contain “<” and “>”)
  function short(s, n, isMarkup) {
    s = String(s || '');
    if (isMarkup) s = s.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  const boxLabel = n => (n.title || n.text) ? short(n.title || n.text, 40) : short(n.html || n.id, 40, true);

  function findRow(t, id) {
    for (const g of t.groups) for (const r of g.rows) if (r.id === id) return r;
    return null;
  }

  function pageOf(d, tableId) { return (d.matrices || []).find(m => (m.sections || []).some(s => s.table === tableId)); }

  function cellLabel(d, tableId, row, col) {
    const t = d.tables[tableId];
    const r = findRow(t, row), c = t.cols.find(x => x.id === col);
    const page = pageOf(d, tableId);
    return `${page ? page.nav : tableId} · ${r ? ((r.code ? r.code + ' ' : '') + r.name) : row} × ${c ? c.name : col}`;
  }

  function getAt(obj, parts) {
    let o = obj;
    for (const p of parts) { if (!own(o, p)) return undefined; o = o[p]; }
    return o;
  }

  function isPlainPath(path) { return PLAIN_PATH.test(path); }

  function describePath(d, path) {
    const p = path.split('/');
    if (p[0] === 'matrices') {
      const m = d.matrices[+p[1]];
      if (!m) return path;
      if (p[2] !== 'sections') return `${m.nav} › page ${p[2]}`;
      const s = m.sections[+p[3]];
      const bits = [m.nav, s ? s.title : 'section'];
      if (p[4] === 'items' && s && s.items && s.items[+p[5]]) bits.push(`“${short(s.items[+p[5]].title, 50)}”`, p[6] === 'title' ? 'title' : 'text');
      else if (p[4] === 'rows') bits.push(`row ${+p[5] + 1}`, p[6] === 'a' ? 'first text' : 'second text');
      else if (p[4] === 'thesis') bits.push('thesis', p[5] === 'title' ? 'title' : p[5] === 'body' ? 'text' : `point ${+p[6] + 1}`);
      else if (p[4] === 'rules') bits.push('placement rules', p[5] === 'title' ? 'title' : `rule ${+p[6] + 1}`);
      else if (p[4] === 'cards') bits.push(`card ${+p[5] + 1}`, 'tag');
      else bits.push(p[4]);
      return bits.join(' › ');
    }
    if (p[0] === 'tables') {
      const t = d.tables[p[1]]; const page = pageOf(d, p[1]);
      const name = page ? page.nav : p[1];
      if (p[2] === 'groups' && p[4] === 'rows') { const r = t.groups[+p[3]].rows[+p[5]]; return `${name} › row “${r.name}” › ${p[6] === 'desc' ? 'definition' : 'name'}`; }
      if (p[2] === 'groups') return `${name} › group ${+p[3] + 1} › label`;
      if (p[2] === 'cols') { const c = t.cols[+p[3]]; return `${name} › column “${c.name}” › ${p[4] === 'sub' ? 'definition' : p[4]}`; }
      return `${name} › ${p[2]}`;
    }
    if (p[0] === 'vocab') return `Definitions › ${p[1]} › ${d.vocab[p[1]][+p[2]].label} › ${p[3]}`;
    return path.replace(/\//g, ' › ');
  }

  function apply(base, changes) {
    if (!Array.isArray(changes) || changes.length === 0) fail('There is nothing to send yet.');
    if (changes.length > LIMITS.changes) fail(`One suggestion holds ${LIMITS.changes} changes at most. Send the rest separately.`);
    if (changes.filter(c => c && c.type === 'node.add').length > LIMITS.mapBoxes) fail(`Add at most ${LIMITS.mapBoxes} map boxes per suggestion.`);
    const d = JSON.parse(JSON.stringify(base));
    const log = [];
    const tmp = Object.create(null);
    const nodes = new Map(d.map.nodes.map(n => [n.id, n]));

    const pname = id => (own(d.papers, id) ? `${d.papers[id].short} (${id})` : id);
    const isPaper = id => PAPER_ID.test(id) && own(d.papers, id);
    const paperRef = ref => {
      if (typeof ref !== 'string') fail('Pick a paper.');
      if (/^new:\d+$/.test(ref)) { if (!tmp[ref]) fail('The new paper must be added before it is placed.'); return tmp[ref]; }
      if (!PAPER_ID.test(ref) || !own(d.papers, ref)) fail(`Unknown paper “${ref.slice(0, 40)}”.`);
      return ref;
    };
    const tableOf = id => {
      if (!['m1', 'm2', 'm3'].includes(id) || !own(d.tables, id) || d.tables[id].derivedFrom) fail('Unknown matrix.');
      return d.tables[id];
    };
    const cellOf = (ch) => {
      const t = tableOf(ch.table);
      if (typeof ch.row !== 'string' || !findRow(t, ch.row)) fail('Unknown matrix row.');
      if (typeof ch.col !== 'string' || !t.cols.some(c => c.id === ch.col)) fail('Unknown matrix column.');
      return { t, key: `${ch.row}|${ch.col}` };
    };

    changes.forEach((ch, i) => {
      const n0 = log.length;
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) fail(`Change ${i + 1} cannot be read.`);
      switch (ch.type) {
        case 'paper.update': {
          const id = paperRef(ch.id);
          const p = d.papers[id];
          const f = own(ch, 'fields') && ch.fields && typeof ch.fields === 'object' ? ch.fields : {};
          for (const k of Object.keys(f)) {
            if (!PAPER_FIELDS.includes(k)) fail(`Unknown field “${k.slice(0, 40)}”.`);
            const v = fieldValue(k, f[k], REQUIRED_NEW.includes(k));
            if (v === p[k]) continue;
            log.push({ i, action: 'Edit paper', target: pname(id), field: LABEL[k], before: String(p[k] ?? ''), after: String(v) });
            p[k] = v;
          }
          if (log.length === n0) fail('This edit does not change anything.');
          break;
        }
        case 'paper.add': {
          if (typeof ch.tmp !== 'string' || !/^new:\d+$/.test(ch.tmp) || tmp[ch.tmp]) fail('Invalid new paper.');
          const src = own(ch, 'paper') && ch.paper && typeof ch.paper === 'object' ? ch.paper : {};
          const p = {};
          for (const k of PAPER_FIELDS) p[k] = fieldValue(k, own(src, k) ? src[k] : undefined, REQUIRED_NEW.includes(k));
          const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const dup = Object.entries(d.papers).find(([, q]) => norm(q.title) === norm(p.title));
          if (dup) fail(`“${short(p.title, 60)}” is already listed as ${dup[1].short}.`);
          let id = 'p' + hash(norm(p.title)).slice(0, 7);
          while (own(d.papers, id)) id = 'p' + hash(id + 'x').slice(0, 7);
          d.papers[id] = p;
          d.papers = Object.fromEntries(Object.entries(d.papers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
          tmp[ch.tmp] = id;
          // the whole record is shown to reviewers, codings included
          log.push({ i, action: 'Add paper', target: `${p.short} (${id})`, after: PAPER_FIELDS.filter(k => p[k] !== '').map(k => `${LABEL[k]}: ${p[k]}`).join('\n') });
          break;
        }
        case 'placement.add': {
          const { t, key } = cellOf(ch);
          const pid = paperRef(ch.paper);
          const items = own(t.cells, key) ? t.cells[key] : (t.cells[key] = []);
          if (items.some(x => x.p === pid)) fail(`${d.papers[pid].short} is already in this cell.`);
          const why = text(ch.why, LIMITS.why, 'The reason for this placement', true);
          items.push({ p: pid, main: ch.main === true, why });
          log.push({ i, action: 'Place paper', target: pname(pid), field: `${cellLabel(d, ch.table, ch.row, ch.col)} (${ch.main === true ? 'main cell' : 'secondary cell'})`, after: why });
          break;
        }
        case 'placement.update': {
          const { t, key } = cellOf(ch);
          const pid = paperRef(ch.paper);
          const it = (own(t.cells, key) ? t.cells[key] : []).find(x => x.p === pid);
          if (!it) fail('This placement no longer exists.');
          const where = cellLabel(d, ch.table, ch.row, ch.col);
          if (own(ch, 'main') && (ch.main === true) !== it.main) {
            log.push({ i, action: 'Change placement', target: pname(pid), field: where, before: it.main ? 'main cell' : 'secondary cell', after: ch.main === true ? 'main cell' : 'secondary cell' });
            it.main = ch.main === true;
          }
          if (own(ch, 'why')) {
            const why = text(ch.why, LIMITS.why, 'The reason for this placement', true);
            if (why !== it.why) { log.push({ i, action: 'Change placement', target: pname(pid), field: `${where} · reason`, before: it.why, after: why }); it.why = why; }
          }
          if (log.length === n0) fail('This edit does not change anything.');
          break;
        }
        case 'placement.remove': {
          const { t, key } = cellOf(ch);
          const pid = paperRef(ch.paper);
          const items = own(t.cells, key) ? t.cells[key] : [];
          const k = items.findIndex(x => x.p === pid);
          if (k < 0) fail('This placement no longer exists.');
          const [gone] = items.splice(k, 1);
          if (!items.length) delete t.cells[key];
          log.push({ i, action: 'Remove placement', target: pname(pid), field: cellLabel(d, ch.table, ch.row, ch.col), before: gone.why });
          break;
        }
        case 'node.update': {
          const n = typeof ch.id === 'string' ? nodes.get(ch.id) : undefined;
          if (!n) fail('This box is no longer on the map.');
          const label = `Box “${boxLabel(n)}”`;
          if (n.kind === 'note') {
            if (own(ch, 'title')) {
              const t = line(ch.title, LIMITS.noteTitle, 'The area title', true);
              if (t !== n.title) { log.push({ i, action: 'Edit map box', target: label, field: 'Area title', before: n.title || '', after: t }); n.title = t; }
            }
            if (own(ch, 'html')) {
              const v = markup(ch.html, LIMITS.noteHtml, 'The note', true, true, isPaper);
              if (v !== n.html) { log.push({ i, action: 'Edit map box', target: label, field: 'Notes', before: n.html, after: v, markup: true }); n.html = v; }
            }
            if (log.length === n0) fail('This edit does not change anything.');
          } else {
            const v = text(ch.text, LIMITS.nodeText, 'The box text', true);
            if (v === n.text) fail('This edit does not change anything.');
            log.push({ i, action: 'Edit map box', target: label, before: n.text, after: v });
            n.text = v;
          }
          break;
        }
        case 'node.add': {
          const near = typeof ch.near === 'string' ? nodes.get(ch.near) : undefined;
          if (!near) fail('Pick a box on the map to attach it to.');
          if (typeof ch.kind !== 'string' || !NODE_KINDS.includes(ch.kind)) fail('Unknown kind of box.');
          if (near.kind === 'note') fail('Attach it to a concept or a question, not to the key insights.');
          if (near.kind === 'bib') fail('Attach it to a concept or a question, not to the bibliography.');
          { let dd = 0, q = near; const seen = new Set(); while (q && q.parent && !seen.has(q.id)) { seen.add(q.id); q = nodes.get(q.parent); dd++; }
            if (dd >= 5) fail('This box is already 5 levels deep. Attach it to a box higher up.'); }
          const v = text(ch.text, LIMITS.nodeText, 'The box text', true);
          const paper = ch.kind === 'paper' ? paperRef(ch.paper) : null;
          let id = 's' + hash(near.id + '|' + v).slice(0, 7);
          while (nodes.has(id)) id = 's' + hash(id + 'x').slice(0, 7);
          // the map lays itself out: a new box only needs its parent (or, under a column header, a lane)
          const node = { id, kind: ch.kind, text: v };
          if (paper) node.paper = paper;
          let where = `below “${boxLabel(near)}”`;
          if (near.kind === 'chain') {
            const col = (d.map.columns || []).find(c => c.node === near.id);
            if (!col) fail('Pick a box on the map to attach it to.');
            const lanes = (d.map.lanes || []).filter(l => !l.span).map(l => l.id);
            const lane = lanes.includes(ch.lane) ? ch.lane : lanes[0];
            Object.assign(node, { lane, column: col.id });
            where = `in the ${lane} lane, column “${boxLabel(near)}”`;
          } else node.parent = near.id;
          d.map.nodes.push(node); nodes.set(id, node);
          const kindLabel = ch.kind === 'question' ? 'open question' : ch.kind === 'paper' ? `paper ${pname(node.paper)}` : 'concept';
          log.push({ i, action: 'Add to map', target: kindLabel, field: where, after: v });
          break;
        }
        case 'text.update': {
          if (typeof ch.path !== 'string' || !TEXT_PATHS.some(re => re.test(ch.path))) fail('This text cannot be edited.');
          const parts = ch.path.split('/');
          const parent = getAt(d, parts.slice(0, -1));
          const key = parts[parts.length - 1];
          if (!own(parent, key) || typeof parent[key] !== 'string') fail('This text no longer exists.');
          const plainField = isPlainPath(ch.path);
          const v = plainField ? line(ch.value, LIMITS.plain, 'The text', true) : markup(ch.value, LIMITS.prose, 'The text', false, true, isPaper);
          if (v === parent[key]) fail('This edit does not change anything.');
          log.push({ i, action: 'Edit text', target: describePath(d, ch.path), before: parent[key], after: v, markup: !plainField });
          parent[key] = v;
          break;
        }
        case 'comment': {
          const v = text(ch.text, LIMITS.comment, 'The comment', true);
          const target = line(ch.target, LIMITS.target, 'The comment target', false);
          log.push({ i, action: 'Comment', target: target || 'general', after: v });
          break;
        }
        default:
          fail(`Unknown kind of change “${String(ch.type).slice(0, 40)}”.`);
      }
    });
    return { data: d, log, ids: Object.assign({}, tmp) };
  }

  function format(d) { return JSON.stringify(d, null, 2) + '\n'; }

  return { apply, format, ENUMS, LIMITS, LABEL, PAPER_FIELDS, REQUIRED_NEW, TEXT_PATHS, CHANGE_TYPES, isPlainPath, cellLabel, describePath, short };
})();
// ==== CORE END ====
