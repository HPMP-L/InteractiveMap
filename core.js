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

  /* ---------- README: the whole list as an "awesome" Markdown page ----------
     Generated from data.json: by the worker in every suggestion that changes the data, by tools/readme.html, and checked
     by tools/check-data.js. Text that comes from data.json is written as plain text: no link, image, HTML, heading, list
     or math can come from it. Only paper links (http/https, already checked) and the site's own address become links.
     The README has no totals: each paper or question is one line of its own, so two suggestions merged one after the
     other still give exactly the README of the merged data. */
  // The public site and its repository. Kept here, not in data.json, so a suggestion cannot change where the list points.
  const SITE = 'https://hpmp-l.github.io/InteractiveMap/';
  const REPO = 'HPMP-L/InteractiveMap';
  const ZW = '\u200b';
  const STATUS_MARK = { published: '🟢', 'lab-preprint': '🔵', preprint: '🟠', workshop: '🟣' };
  function mdText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
      .replace(/&/g, '&amp;')
      .replace(/[\\`*_{}[\]()<>#+!|~$]/g, c => '\\' + c)
      .replace(/^([-=])/, '\\$1').replace(/^(\d{1,9})([.)])/, '$1\\$2') // never the start of a list or a heading underline
      .replace(/:\/\//g, ':' + ZW + '//').replace(/www\./gi, m => m.slice(0, 3) + ZW + '.') // no auto-links
      .replace(/@/g, '@' + ZW);
  }
  const mdHref = u => (/^https?:\/\/\S+$/.test(String(u || ''))
    ? String(u).replace(/[()<>"'\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) : '');
  function firstSentence(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const m = /^(.{20,220}?[.!?])(?:\s|$)/u.exec(t);
    const one = m ? m[1] : t;
    const cps = Array.from(one); // cut on characters, never inside one
    return cps.length > 220 ? cps.slice(0, 217).join('').replace(/\s+\S*$/u, '') + '…' : one;
  }
  // the anchors GitHub gives to headings, counted over every heading in page order: lower case; letters, marks, digits,
  // "_", "-" and spaces kept; each space becomes a hyphen; repeats get -1, -2…
  function slugger() {
    const seen = {};
    return text => {
      const s = String(text).replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
      const k = seen[s] || 0; seen[s] = k + 1;
      return k ? `${s}-${k}` : s;
    };
  }
  function readme(d) {
    const meta = d.meta || {};
    const site = SITE, add = `${SITE}#suggest/new/paper`;
    const name = String(meta.title || 'Awesome list').replace(/\s+/g, ' ').trim();
    const papers = d.papers || {};
    const m1 = (d.tables || {}).m1 || {};
    const cols = m1.cols || [], groups = m1.groups || [];
    const vocab = (list, key) => { const v = ((d.vocab || {})[list] || []).find(x => x.key === key); return v ? v.label : String(key); };
    const statusRank = s => { const i = ['published', 'lab-preprint', 'preprint', 'workshop'].indexOf(s); return i < 0 ? 9 : i; };
    const link = (text, url) => { const href = mdHref(url); return href ? `[${text}](${href})` : text; };
    const onSite = (hash, text) => `[${text}](${site}#${hash})`;
    const slug = slugger();
    const titleLine = `🛰️ ${name} Awesome`; // the H1 as GitHub reads it: emoji, name, then the badge's alt text
    slug(titleLine); slug('Contents');
    const body = [], toc = [];
    // a heading: written once, its anchor counted in page order, and listed in the contents when it is a section
    const head = (level, text, inToc) => { const a = slug(text); body.push(`${'#'.repeat(level)} ${mdText(text)}`, ''); if (inToc) toc.push([text, a]); };

    // where each paper sits: its main cell of the first matrix (kind of approach × link of the chain)
    const rowGroup = {}, rowName = {};
    groups.forEach((g, gi) => (g.rows || []).forEach(r => { rowGroup[r.id] = gi; rowName[r.id] = r.name; }));
    const sections = cols.map(c => ({ c, parts: groups.map(g => ({ g, items: [] })) }));
    const placed = new Set();
    for (const [key, items] of Object.entries(m1.cells || {})) {
      const [row, col] = key.split('|');
      const si = cols.findIndex(c => c.id === col), gi = rowGroup[row];
      for (const x of items || []) {
        if (!x || !x.main || !own(papers, x.p) || placed.has(x.p) || si < 0 || gi == null) continue;
        placed.add(x.p); sections[si].parts[gi].items.push({ id: x.p, row });
      }
    }
    const other = Object.keys(papers).filter(id => !placed.has(id)).map(id => ({ id, row: null }));
    const order = (a, b) => {
      const p = papers[a.id], q = papers[b.id];
      return (q.proximity - p.proximity) || (statusRank(p.status) - statusRank(q.status))
        || (String(p.short) < String(q.short) ? -1 : String(p.short) > String(q.short) ? 1 : 0) || (a.id < b.id ? -1 : 1);
    };
    const entry = ({ id, row }) => {
      const p = papers[id];
      const marks = [STATUS_MARK[p.status] || '', p.proximity === 3 ? '⭐' : ''].filter(Boolean).join(' ');
      const venue = mdText(p.venue), does = mdText(firstSentence(p.does));
      const sameName = String(p.title || '').trim().toLowerCase() === String(p.short || '').trim().toLowerCase();
      const more = [row ? `_${mdText(rowName[row])}_` : '', onSite('papers/paper/' + encodeURIComponent(id), 'map ↗')].filter(Boolean).join(' · ');
      return `- **${link(mdText(p.short), p.url)}** ${marks}${sameName ? '' : ' ' + mdText(p.title)}${venue ? ` *(${venue})*` : ''}${does ? ` — ${does}` : ''} · ${more}`;
    };

    // open problems: the questions of the map, with where they sit
    const nodes = ((d.map || {}).nodes) || [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const lanes = ((d.map || {}).lanes) || [];
    const firstLine = n => String(n.text || n.title || '').split('\n')[0];
    const rootOf = n => { let q = n; const seen = new Set(); while (q && q.parent && byId.has(q.parent) && !seen.has(q.id)) { seen.add(q.id); q = byId.get(q.parent); } return q; };
    const trail = n => {
      const names = []; const seen = new Set();
      let q = n.parent && byId.get(n.parent);
      while (q && !seen.has(q.id)) { seen.add(q.id); if (q.kind !== 'chain') names.unshift(firstLine(q)); q = q.parent && byId.get(q.parent); }
      return names;
    };
    const questions = nodes.filter(n => n.kind === 'question');
    const problem = n => {
      const where = trail(n);
      return `- ${mdText(n.text)}${where.length ? ` — _${where.map(mdText).join(' › ')}_` : ''} · ${onSite('map/node/' + encodeURIComponent(n.id), 'map ↗')}`;
    };

    head(2, 'How to read this list', true);
    body.push('Each link of the chain has its own section, split by what the work does: measure, predict, decide, model or reproduce. Within a part, the papers closest to capacity planning come first.', '');
    body.push(Object.keys(STATUS_MARK).map(k => `${STATUS_MARK[k]} ${mdText(vocab('status', k))}`).join(' · ') + ` · ⭐ ${mdText(vocab('proximity', 3))}`, '');
    body.push('**map ↗** opens the paper on the interactive map, with its full coding: key result, contribution and gap, limitation.', '');
    sections.forEach(s => {
      if (!s.parts.some(p => p.items.length)) return;
      head(2, s.c.stage ? `${s.c.name} (${s.c.stage})` : String(s.c.name), true);
      if (s.c.sub) body.push(mdText(s.c.sub), '');
      s.parts.forEach(p => {
        if (!p.items.length) return;
        head(3, String(p.g.label));
        p.items.slice().sort(order).forEach(it => body.push(entry(it)));
        body.push('');
      });
    });
    if (other.length) { head(2, 'Other papers', true); other.sort(order).forEach(it => body.push(entry(it))); body.push(''); }
    if (questions.length) {
      head(2, 'Open problems', true);
      body.push(`Questions the map raises and no listed paper answers yet. **Working on one of them? [Add your paper](${add}).**`, '');
      lanes.forEach(l => {
        const qs = questions.filter(n => (rootOf(n) || {}).lane === l.id);
        if (!qs.length) return;
        head(3, String(l.label)); qs.forEach(n => body.push(problem(n))); body.push('');
      });
      const loose = questions.filter(n => !lanes.some(l => l.id === (rootOf(n) || {}).lane));
      if (loose.length) { head(3, 'Other'); loose.forEach(n => body.push(problem(n))); body.push(''); }
    }
    head(2, 'Contributing', true);
    body.push('**Your paper, system, trace or benchmark belongs here?** Add it in two minutes, without a GitHub account:', '');
    body.push(`1. Open [Add your paper](${add}) on the interactive map.`,
      '2. Fill in its card and, if you like, its place in a matrix and on the map.',
      '3. Say why in one sentence and send. Your suggestion becomes a pull request; once the maintainer merges it, it appears in this list and on the site.', '');
    body.push('You can correct or complete any entry the same way, with **Suggest an edit** on its card, or leave a comment.', '');
    body.push('With a GitHub account, you can also edit [`data.json`](data.json) and open a pull request. This README is generated from `data.json`: do not edit it by hand.', '');
    body.push('**What fits:** research and systems on agent workloads and trajectories, the inference and tool resources agents use, the orchestration of long-running agents (state, messages, sleep and wake), and capacity planning (placement, sizing, SLOs), including traces, benchmarks and simulators.', '');
    head(2, 'Show that your work is listed', true);
    body.push('If your paper or system is in this list, you can add this badge to your README or project page. On the site, each paper\'s card gives the same badge with a link to that card.', '');
    const badgeName = name.replace(/[[\]`]/g, '');
    body.push(`[![Mentioned in ${mdText(name)}](https://awesome.re/mentioned-badge.svg)](${site})`, '');
    body.push('```md', `[![Mentioned in ${badgeName}](https://awesome.re/mentioned-badge.svg)](${site})`, '```', '');
    head(2, 'About this list', true);
    body.push(`It started as a literature review on predicting the infrastructure demand of LLM agents. The [interactive map](${site}) shows how the papers connect, and its three matrices code every paper. How the site and its suggestion pipeline work: [DEVELOPING.md](DEVELOPING.md).`, '');

    const out = [];
    out.push('<!-- Generated from data.json by CORE.readme (core.js). Do not edit this file by hand: change data.json, or use the site, and it follows. -->', '');
    out.push(`# 🛰️ ${mdText(name)} [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)`, '');
    if (meta.subtitle) out.push(`> ${mdText(meta.subtitle)}`, '');
    out.push(`[🗺️ **Explore the interactive map**](${site}) · [➕ **Add your paper**](${add}) (no GitHub account needed) · [✏️ Suggest a change](${site}#suggest)`, '');
    out.push('A curated, living list of papers on what LLM agents demand from infrastructure, organized along the chain **Workload → Trajectory → Resources → Capacity**, with the open problems no paper solves yet. Every entry is also placed on an interactive map and coded in three matrices (key result, contribution, limitation).', '');
    out.push('## Contents', '');
    toc.forEach(([t, a]) => out.push(`- [${mdText(t)}](#${a})`));
    out.push('');
    return out.concat(body).join('\n');
  }

  function format(d) { return JSON.stringify(d, null, 2) + '\n'; }

  return { apply, format, readme, SITE, REPO, ENUMS, LIMITS, LABEL, PAPER_FIELDS, REQUIRED_NEW, TEXT_PATHS, CHANGE_TYPES, isPlainPath, cellLabel, describePath, short };
})();
// ==== CORE END ====
