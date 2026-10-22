// Suggestion endpoint for the W→T→R→C research map.
// Receives anonymous suggestions from the page, applies them to data.json and opens a pull request.
// Runs on Cloudflare Workers (free plan). Setup: see HOSTING.md.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN      secret. Classic token, scope public_repo only, of the robot collaborator account (HOSTING.md step 3).
//                     Never a token of the repository owner: the worker refuses one.
//   GITHUB_REPO       "owner/name" of the site repository.
//   GITHUB_BRANCH     branch the site is published from (default "main").
//   DATA_PATH         path of the data file in the repository (default "data.json").
//   ALLOWED_ORIGINS   required. Comma-separated sites allowed to send, e.g. "https://you.github.io".
//   TURNSTILE_SECRET  required secret. Cloudflare Turnstile secret key (the page needs the matching site key).
//   DEV_ALLOW_UNSAFE  never set it on the real worker. "1" lets a local test run without the two settings above.
//   MAX_PER_HOUR      optional. Suggestions accepted per visitor per hour (default 6).
//   MAX_OPEN          optional. Refuse new suggestions while this many are waiting for review (default 40).
//   RATE_LIMITER      optional binding (Workers Rate Limiting), see wrangler.toml. Stronger than the built-in limit.

/* The block between the CORE markers is a copy of ../core.js. After editing core.js, run: python tools/sync_core.py */
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

const MAX_BODY = 250_000;
const recent = new Map();            // per-instance rate limit: visitor key -> timestamps
let cache = { sha: '', text: '', at: 0 }; // base data.json, reused for a minute

// settings typed in the dashboard often carry a stray space ("main "): every text setting is trimmed once
const tidy = env => Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

export default {
  async fetch(request, rawEnv) {
    const env = tidy(rawEnv);
    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigin(origin, env);
    const cors = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (allowed && origin) cors['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ ok: true, service: 'research-map suggestions', repo: env.GITHUB_REPO || null,
      branch: env.GITHUB_BRANCH || 'main', dataPath: env.DATA_PATH || 'data.json', token: !!env.GITHUB_TOKEN,
      antiSpamCheck: !!env.TURNSTILE_SECRET, allowedSites: originList(env), unsafeTestMode: devUnsafe(env) }, 200, cors);
    if (request.method !== 'POST') return json({ ok: false, error: 'Send suggestions with POST.' }, 405, cors);
    if (!allowed) return json({ ok: false, error: 'This site is not allowed to send suggestions here.' }, 403, cors);
    try {
      const out = await handle(request, env);
      return json(out, 200, cors);
    } catch (e) {
      let status = Object.prototype.hasOwnProperty.call(e, 'status') ? e.status : (e && e.name === 'SuggestionError' ? 400 : 500);
      if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
      if (status >= 500) console.error(e && e.stack || e);
      // unexpected errors keep a short reference, so the maintainer can tell a GitHub hiccup from a bug
      const ref = e && e.ref ? e.ref : e && e.name && e.name !== 'Error' ? `${e.name}: ${String(e.message).slice(0, 120)}` : '';
      const msg = status >= 500 && status !== 503 ? `The suggestion could not be saved right now. Try again in a few minutes.${ref ? ` (${ref})` : ''}` : String(e.message);
      return json({ ok: false, error: msg }, status, cors);
    }
  },
};

// browsers send the host in lower case: compare without case, so "https://Name.github.io" in the settings still works
const originList = env => String(env.ALLOWED_ORIGINS || '').split(',').map(s => { try { return new URL(s.trim()).origin.toLowerCase(); } catch { return ''; } }).filter(o => /^https?:\/\//.test(o));
// DEV_ALLOW_UNSAFE="1" is for a local test only: it lets the worker run without ALLOWED_ORIGINS and without Turnstile
const devUnsafe = env => String(env.DEV_ALLOW_UNSAFE || '') === '1';
function allowedOrigin(origin, env) {
  const list = originList(env);
  if (!list.length) return devUnsafe(env);
  return list.includes(origin.replace(/\/$/, '').toLowerCase());
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers) });
}

function clientError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (declared && declared > MAX_BODY) throw clientError('This suggestion is too large. Send it in smaller parts.', 413);
  if (!request.body || !request.body.getReader) {
    const t = await request.text();
    if (t.length > MAX_BODY) throw clientError('This suggestion is too large. Send it in smaller parts.', 413);
    return t;
  }
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { try { await reader.cancel(); } catch { /* ignore */ } throw clientError('This suggestion is too large. Send it in smaller parts.', 413); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

function visitorKey(request) {
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  // expand "2001:db8::1" to eight groups, then keep the first 56 bits: one subscriber usually owns at least a /56
  const [head, tail = ''] = ip.split('::');
  const hd = head ? head.split(':') : [], tl = tail ? tail.split(':') : [];
  const full = [...hd, ...Array(Math.max(0, 8 - hd.length - tl.length)).fill('0'), ...tl].map(x => (x.includes('.') ? '0' : x));
  const g = full.slice(0, 4).map(x => parseInt(x || '0', 16) || 0);
  return [g[0], g[1], g[2], g[3] & 0xff00].map(x => x.toString(16)).join(':') + '::/56';
}

async function handle(request, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw clientError('The suggestion service is not configured yet.', 503);
  // the anti-spam check is required: without it, a script could open pull requests until the queue is full
  if (!env.TURNSTILE_SECRET && !devUnsafe(env)) throw clientError('The suggestion service is not configured yet (anti-spam check missing).', 503);
  const key = visitorKey(request);
  await rateLimit(env, key, Number(env.MAX_PER_HOUR) || 6);

  const raw = await readBody(request);
  let body;
  try { body = JSON.parse(raw); } catch { throw clientError('The suggestion could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw clientError('The suggestion could not be read.');

  // cheap checks first, before any call to GitHub
  if (body.website) throw clientError('The suggestion was rejected.');
  if (typeof body.elapsed !== 'number' || body.elapsed < 3000) throw clientError('Please take a moment to review your suggestion before sending it.');
  const changes = body.changes;
  if (!Array.isArray(changes) || !changes.length) throw clientError('There is nothing to send yet.');
  if (changes.length > CORE.LIMITS.changes) throw clientError(`One suggestion holds ${CORE.LIMITS.changes} changes at most. Send the rest separately.`);
  if (!changes.every(c => c && typeof c === 'object' && CORE.CHANGE_TYPES.includes(c.type))) throw clientError('The suggestion contains a change this site does not know.');
  const reason = typeof body.reason === 'string' ? body.reason.replace(/\r\n?/g, '\n').trim() : '';
  if (reason.length < CORE.LIMITS.reasonMin) throw clientError('Explain your suggestion in a sentence (10 characters at least).');
  if (reason.length > CORE.LIMITS.reason) throw clientError(`The explanation is too long (${CORE.LIMITS.reason} characters at most).`);
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, CORE.LIMITS.name) : '';
  if (env.TURNSTILE_SECRET) await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstile, request.headers.get('CF-Connecting-IP') || '', env);

  const repo = env.GITHUB_REPO, base = env.GITHUB_BRANCH || 'main', path = env.DATA_PATH || 'data.json';
  await checkToken(env.GITHUB_TOKEN, repo);
  const gh = github(env.GITHUB_TOKEN, repo);

  const ref = await gh(`/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = ref.object.sha;
  if (cache.sha !== baseSha || Date.now() - cache.at > 60_000) {
    const t = await gh(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${baseSha}`, { raw: true });
    cache = { sha: baseSha, text: t, at: Date.now() };
  }
  const text = cache.text;
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('data.json on the base branch is not valid JSON'); }

  const result = CORE.apply(data, changes); // throws SuggestionError with a readable message
  const newText = CORE.format(result.data);
  const dataChanged = newText !== text;
  const comments = result.log.filter(l => l.action === 'Comment');
  if (!dataChanged && !comments.length) throw clientError('This suggestion does not change anything in the current version of the site.');

  // do not pile up: refuse while too many suggestions are waiting for review
  const open = await gh(`/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
  const waiting = open.filter(p => p.head && p.head.repo && String(p.head.repo.full_name).toLowerCase() === String(repo).toLowerCase() && typeof p.head.ref === 'string' && p.head.ref.startsWith('suggestion/')).length;
  if (waiting >= (Number(env.MAX_OPEN) || 40)) throw clientError('Many suggestions are already waiting for review. Please try again in a few days.', 429);

  const stamp = new Date().toISOString();
  const slug = reason.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
  const branch = `suggestion/${stamp.slice(0, 10)}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const title = prTitle(result.log);
  const bodyMd = prBody(reason, name, result.log, stamp);

  const files = [];
  if (dataChanged) files.push({ path, content: newText });
  if (comments.length) files.push({ path: `suggestions/${branch.replace('suggestion/', '')}.md`, content: noteFile(title, reason, name, result.log, stamp) });

  const baseCommit = await gh(`/git/commits/${baseSha}`);
  const tree = [];
  for (const f of files) {
    const blob = await gh('/git/blobs', { method: 'POST', body: { content: f.content, encoding: 'utf-8' } });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh('/git/trees', { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree } });
  // the visitor's text stays out of the commit message (closing keywords, co-author trailers): it is in the PR description
  const commit = await gh('/git/commits', { method: 'POST', body: { message: title, tree: newTree.sha, parents: [baseSha] } });
  await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  let pr;
  try {
    pr = await gh('/pulls', { method: 'POST', body: { title, head: branch, base, body: bodyMd } });
  } catch (e) {
    try { await gh(`/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); } catch { /* best effort */ }
    throw e;
  }
  try { await gh(`/issues/${pr.number}/labels`, { method: 'POST', body: { labels: ['suggestion'] } }); } catch { /* labels are optional */ }
  return { ok: true, number: pr.number, url: pr.html_url };
}

async function rateLimit(env, key, max) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) throw clientError('Too many suggestions from this connection. Try again later.', 429);
  }
  const now = Date.now(), hour = 3600_000;
  const list = (recent.get(key) || []).filter(t => now - t < hour);
  if (list.length >= max) throw clientError('Too many suggestions from this connection in the last hour. Try again later.', 429);
  list.push(now); recent.set(key, list);
  if (recent.size > 20000) for (const k of [...recent.keys()].slice(0, 10000)) recent.delete(k);
}

async function verifyTurnstile(secret, token, ip, env) {
  if (!token || typeof token !== 'string') throw clientError('Please complete the anti-spam check, then send again.');
  const form = new FormData();
  form.append('secret', secret); form.append('response', token.slice(0, 2048)); if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = res.ok ? await res.json().catch(() => null) : null;
  if (!out) throw clientError('The anti-spam service did not answer. Try again in a few minutes.', 503);
  const codes = Array.isArray(out['error-codes']) ? out['error-codes'] : [];
  if (codes.some(c => c === 'missing-input-secret' || c === 'invalid-input-secret')) {
    console.error('Turnstile secret refused by Cloudflare: check TURNSTILE_SECRET', codes);
    throw clientError('The suggestion service is not configured correctly (anti-spam key).', 503);
  }
  const failed = 'The anti-spam check failed. Reload the page and try again.';
  if (!out.success) throw clientError(failed);
  // the check must have been solved on this site's page, for sending a suggestion (not reused from another form)
  const hosts = originList(env).map(o => new URL(o).hostname);
  if (hosts.length && !hosts.includes(String(out.hostname || '').toLowerCase())) { console.warn('Turnstile solved on another site:', out.hostname); throw clientError(failed); }
  if (out.action !== 'suggest') { console.warn('Turnstile solved for another action:', out.action); throw clientError(failed); }
}

// the worker must not hold the owner's token (it could bypass the review) nor a token with more rights than public_repo
const tokenOk = new Set();
async function checkToken(token, repo) {
  if (tokenOk.has(token)) return;
  // a fine-grained token can only reach repositories of its own account, never the owner's repository as a collaborator
  if (/^github_pat_/.test(token)) {
    console.error('GITHUB_TOKEN is a fine-grained token: the robot account needs a classic token with public_repo (HOSTING.md step 3)');
    throw clientError('The suggestion service is not set up correctly: the GitHub token is a fine-grained token. The robot account needs a classic token with the public_repo scope. Please tell the maintainer.', 503);
  }
  const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'research-map-suggestions' } });
  if (res.status === 401) throw clientError('The suggestion service is not configured correctly (GitHub token refused).', 503);
  if (!res.ok) { const e = new Error(`GitHub ${res.status} on GET /user`); e.status = 502; e.ref = e.message; throw e; }
  const me = await res.json();
  const owner = String(repo).split('/')[0].toLowerCase();
  if (String(me.login || '').toLowerCase() === owner) {
    console.error('GITHUB_TOKEN belongs to the repository owner: use the robot account token (HOSTING.md step 3)');
    throw clientError('The suggestion service is not configured correctly (it must use the robot account, not the owner).', 503);
  }
  const scopes = res.headers.get('X-OAuth-Scopes');
  if (scopes !== null && scopes.split(',').map(x => x.trim()).filter(Boolean).some(x => x !== 'public_repo')) {
    console.error('GITHUB_TOKEN has more scopes than public_repo:', scopes);
    throw clientError('The suggestion service is not configured correctly (the GitHub token has too many rights).', 503);
  }
  tokenOk.add(token);
}

function github(token, repo) {
  return async (path, opts = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'research-map-suggestions',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const step = `${opts.method || 'GET'} ${path.split('?')[0]}`;
      const e = new Error(`GitHub ${res.status} on ${step}: ${detail.slice(0, 300)}`);
      if (res.status >= 500 || res.status === 429) { e.status = 502; e.ref = `GitHub ${res.status} on ${step}`; throw e; } // GitHub hiccup: try again later
      // anything else is a setup problem (rights of the robot account, token, branch rules): say which step GitHub refused
      let why = '';
      try { const j = JSON.parse(detail); why = [j.message, ...(Array.isArray(j.errors) ? j.errors.map(x => (x && (x.message || x.code)) || '') : [])].filter(Boolean).join('; '); } catch { why = detail; }
      console.error(e.message);
      e.status = 503;
      e.message = `The suggestion service is not set up correctly: GitHub answered ${res.status} on ${step}${why ? ` (${why.replace(/\s+/g, ' ').slice(0, 200)})` : ''}. Please tell the maintainer.`;
      throw e;
    }
    if (res.status === 204) return null;
    return opts.raw ? res.text() : res.json();
  };
}

/* ---------- pull request text ---------- */
const ZW = String.fromCharCode(0x200b); // zero-width space, breaks GitHub auto-links without changing what people read
const BLOCK_MAX = 1500, BODY_MAX = 60000;
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// keep visitor text from pinging people or referencing issues (with no issue reference, closing keywords do nothing)
const quiet = s => String(s)
  .replace(/\[(?=\s*(?:skip|ci|no|actions)\b)/gi, '[' + ZW) // "[skip ci]" and friends never reach a commit message
  .replace(/skip-checks/gi, m => m.slice(0, 4) + ZW + m.slice(4))
  .replace(/@(?=[A-Za-z0-9-])/g, '@' + ZW)
  .replace(/#(?=\d)/g, '#' + ZW)
  .replace(/\bGH-(?=\d)/gi, m => m.slice(0, 2) + ZW + '-')
  .replace(/github\.com\//gi, m => 'github' + ZW + m.slice(6));
// one-line label: no line breaks, markdown and HTML characters escaped
const oneLine = s => quiet(String(s || '').replace(/\s+/g, ' ').trim()).replace(/:\/\//g, ':' + ZW + '//').replace(/\bwww\./gi, m => m.slice(0, 3) + ZW + '.')
  .replace(/[\\`*_[\]<>&|~]/g, c => '\\' + c);
const cap = (s, n) => (s.length > n ? s.slice(0, n) + `… (${s.length - n} more characters: see Files changed)` : s);
// markup made readable and honest: link targets stay visible
function readable(s, isMarkup) {
  s = String(s || '');
  if (!isMarkup) return s;
  return decode(s
    // the target is written where the link starts, before its text, so a long text can never push it out of view
    .replace(/<a href="([^"]*)">/g, '[→ $1] ').replace(/<a data-p="([^"]*)">/g, '[paper $1] ')
    .replace(/<br>/g, '\n').replace(/<\/(p|li|h4)>/g, '\n').replace(/<li>/g, '• ')
    .replace(/<[^>]+>/g, '')).trim();
}
function quote(s, isMarkup, max = BLOCK_MAX) {
  // fenced block: nothing in it is rendered as markdown or HTML on GitHub
  const body = cap(quiet(readable(s, isMarkup)), max).replace(/~{3,}/g, m => m.split('').join(' ')).replace(/`{3,}/g, m => m.split('').join(' '));
  return ['~~~text', ...body.split('\n'), '~~~'].map(l => '   ' + l).join('\n');
}
// ordered list of links, target first then a short text; every opening link tag counts, even one without its end
const linkList = s => [...String(s || '').matchAll(/<a (?:href|data-p)="([^"]*)">(?:((?:(?!<a |<\/a>)[\s\S])*)<\/a>)?/g)].map(m => {
  const text = decode((m[2] === undefined ? '(no end)' : m[2]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return { target: decode(m[1]), text: text.length > 80 ? text.slice(0, 80) + '…' : text };
});
const hostOf = t => { try { return new URL(t).host; } catch { return ''; } };
function prTitle(log) {
  const first = log[0];
  const what = first.action === 'Comment' ? `Comment on ${first.target}` : `${first.action}: ${first.target}${first.field ? ' · ' + first.field : ''}`;
  const more = log.length > 1 ? ` (+${log.length - 1} more)` : '';
  // no square brackets: the title becomes a commit message, where "[skip ci]" would switch off the checks
  const t = 'Suggestion: ' + quiet(String(what).replace(/\s+/g, ' ').replace(/[<>]/g, '').replace(/\[/g, '(').replace(/\]/g, ')'));
  return (t.length + more.length > 110 ? t.slice(0, 106 - more.length) + '…' : t) + more;
}
function prBody(reason, name, log, stamp) {
  const lines = [];
  lines.push('### Why', '', quote(reason, false).replace(/^ {3}/gm, ''), '');
  lines.push(`Suggested by **${name ? oneLine(name) : 'an anonymous visitor'}** on ${stamp.slice(0, 16).replace('T', ' ')} UTC through the research map.`, '');
  // every changed link target, in full, before the details (which may be cut): what a click would open
  const linkWarnings = [];
  log.forEach((l, k) => {
    const before = l.markup ? linkList(l.before) : [], after = l.markup ? linkList(l.after) : [];
    if (l.field === 'Link' || /^Add paper/.test(l.action)) {
      const was = /https?:\/\/\S+/.exec(String(l.before || '')), now = /https?:\/\/\S+/.exec(String(l.after || ''));
      if (was) before.push({ target: was[0], text: 'paper link' });
      if (now) after.push({ target: now[0], text: 'paper link' });
    }
    const key = x => x.map(y => y.target + ' ' + y.text).join('\n');
    if (key(before) !== key(after)) linkWarnings.push({ k, after });
  });
  if (linkWarnings.length) {
    const hosts = [...new Set(linkWarnings.flatMap(w => w.after.map(x => hostOf(x.target))).filter(Boolean))];
    lines.push(`### ⚠️ Links changed${hosts.length ? ' (sites: ' + hosts.map(oneLine).join(', ') + ')' : ''}`, '');
    linkWarnings.forEach(w => lines.push(`Change ${w.k + 1}, links after the change:`, '',
      quote(w.after.map(x => `${x.target}   ← “${x.text}”`).join('\n') || 'none', false, 20000).replace(/^ {3}/gm, ''), ''));
  }
  lines.push(`### Changes (${log.length})`, '');
  log.forEach((l, k) => {
    lines.push(`${k + 1}. **${l.action}** · ${oneLine(l.target)}${l.field ? ' · ' + oneLine(l.field) : ''}`);
    if (l.before !== undefined && l.before !== '') lines.push('', '   Before:', '', quote(l.before, l.markup));
    if (l.after !== undefined && l.after !== '') lines.push('', l.action === 'Comment' ? '   Comment:' : '   After:', '', quote(l.after, l.markup));
    if (linkWarnings.some(w => w.k === k)) lines.push('', '   ⚠️ Its links changed: see “Links changed” above.');
    lines.push('');
  });
  lines.push('---', 'Check the **Files changed** tab (it is the source of truth), then merge to publish or close with a reply. The site updates after the merge.');
  let body = lines.join('\n');
  if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX) + '\n\n… The description is cut here. See **Files changed** for every change.';
  return body;
}
function noteFile(title, reason, name, log, stamp) {
  // visitor text sits in fenced blocks, so nothing in it is rendered as a link or an image on GitHub
  const fence = t => quote(t, false, 20000).replace(/^ {3}/gm, '');
  return [`# ${title}`, '', `Date: ${stamp}`, `From: ${name ? oneLine(name) : 'anonymous'}`, '', '## Why', '', fence(reason), '', '## Comments', '',
    ...log.filter(l => l.action === 'Comment').flatMap(l => [`On ${oneLine(l.target)}:`, '', fence(l.after), '']), ''].join('\n');
}
