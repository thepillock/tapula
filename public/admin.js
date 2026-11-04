(function () {
'use strict';
const app = document.getElementById('app');
const $ = (s) => app.querySelector(s);
const esc = TapPlayer.esc;
const media = (id) => '/media/' + id;
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const ID_RE = /^[a-z0-9]{4,40}$/;
const SWATCHES = ['#ffffff', '#fff4e6', '#f3efe7', '#e6f0ff', '#e5f6ec', '#ffe6ec', '#17161b', '#1f2a4d', '#24453a', '#ff5a36'];
const ACCENTS = ['#ff5a36', '#6c4cf0', '#0f9d8a', '#2f6fed', '#e0457b', '#e89a00', '#17161b'];
const LABEL = { heading: ['H', 'Heading'], text: ['¶', 'Text'], image: ['▣', 'Image'], video: ['▶', 'Video'], quiz: ['?', 'Quiz'], link: ['↗', 'Button link'] };
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const VID_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
let config = { baseUrl: location.origin, maxUploadMb: 100 };
let cleanup = null;

/* ---------------- api ---------------- */
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-Tapula': '1' } : { 'X-Tapula': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || r.statusText || 'Request failed');
  }
  return r.status === 204 ? null : r.json();
}
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/media');
    x.setRequestHeader('Content-Type', file.type);
    x.setRequestHeader('X-Tapula', '1');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 401) { location.href = '/login'; return reject(new Error('Signed out')); }
      x.status >= 200 && x.status < 300 ? resolve(j) : reject(new Error(j.error || 'Upload failed'));
    };
    x.onerror = () => reject(new Error('Network error during upload'));
    x.send(file);
  });
}

/* ---------------- ui helpers ---------------- */
function shell(html) { app.innerHTML = html; }
function message(title, body) {
  shell(`<div class="msg"><div class="brand"><span class="logo"></span>Tapula</div><h1>${esc(title)}</h1><p>${body || ''}</p></div>`);
}
function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function thumb(card, accent, w) {
  const box = document.createElement('div'); box.className = 'thumb';
  box.style.width = w + 'px'; box.style.height = Math.round(w * 16 / 9) + 'px';
  const inner = document.createElement('div'); inner.className = 'thumb-inner';
  inner.style.transform = `scale(${w / 360})`;
  if (card) inner.appendChild(TapPlayer.renderCard(card, { media, accent }));
  box.appendChild(inner); return box;
}
function twoStep(btn, label, fn) {
  let armed = false, t = null;
  btn.addEventListener('click', () => {
    if (!armed) { armed = true; btn.textContent = 'Sure?'; btn.classList.add('armed'); t = setTimeout(() => { armed = false; btn.textContent = label; btn.classList.remove('armed'); }, 3000); return; }
    clearTimeout(t); armed = false; btn.classList.remove('armed'); btn.textContent = label; fn();
  });
}
const tip = document.getElementById('tip');
function tipOn(el, text) {
  el.addEventListener('mouseenter', () => { tip.textContent = text; tip.classList.add('on'); });
  el.addEventListener('mousemove', (e) => { tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; });
  el.addEventListener('mouseleave', () => tip.classList.remove('on'));
}
const pct = (x) => Math.round(x * 100) + '%';
const lessonUrl = (id) => config.baseUrl + '/l/' + id;

/* ---------------- boot ---------------- */
(async function () {
  message('Loading…', '');
  try { config = await api('GET', '/api/config'); } catch (e) { if (e.message !== 'Signed out') message('Can’t reach the server', esc(e.message)); return; }
  window.addEventListener('hashchange', route);
  route();
})();

function route() {
  tip.classList.remove('on');
  if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
  const h = location.hash.slice(1);
  if (h.startsWith('edit-') && ID_RE.test(h.slice(5))) return showEditor(h.slice(5));
  if (h.startsWith('stats-') && ID_RE.test(h.slice(6))) return showStats(h.slice(6));
  showHome();
}

/* ---------------- library ---------------- */
async function showHome() {
  shell(`<div class="home">
    <header class="top"><div class="brand"><span class="logo"></span>Tapula</div>
      <div class="row"><button class="btn ghost signout" id="out">Sign out</button><button class="btn primary" id="new">+ New lesson</button></div></header>
    <section class="intro"><h1>Your lessons</h1><p>Build bite-size lessons from cards of text, images, video and quick quizzes. Publish one and anyone with the link can swipe through it, no sign-in needed.</p></section>
    <div id="list" class="grid"><div class="muted">Loading lessons…</div></div>
  </div>`);
  $('#new').addEventListener('click', createLesson);
  $('#out').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); location.href = '/login'; });
  let list;
  try { list = await api('GET', '/api/courses'); } catch (e) { $('#list').innerHTML = `<div class="muted">Couldn’t load lessons: ${esc(e.message)}</div>`; return; }
  const box = $('#list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="empty"><p>No lessons yet.</p><button class="btn primary">Create your first lesson</button></div>';
    box.querySelector('button').addEventListener('click', createLesson); return;
  }
  box.innerHTML = '';
  list.forEach((c) => {
    const el = document.createElement('div'); el.className = 'lesson';
    const rate = c.viewers ? Math.round(c.completed / c.viewers * 100) : 0;
    el.innerHTML = `<div class="cover"><span class="badge ${c.published ? 'live' : ''}">${c.published ? 'Live' : 'Draft'}</span></div>
      <div class="meta"><h3></h3><p>${c.cardCount} card${c.cardCount === 1 ? '' : 's'} · edited ${esc(ago(c.updatedAt))}</p>
      <div class="stats-line"><span><b>${c.viewers}</b> viewer${c.viewers === 1 ? '' : 's'}</span><span><b>${rate}%</b> completed</span></div></div>
      <div class="acts"><a class="btn" href="#edit-${c.id}">Edit</a><a class="btn ghost" href="#stats-${c.id}">Stats</a><span class="sp"></span><button class="btn ghost" data-a="dup" title="Duplicate">⧉</button><button class="btn ghost danger" data-a="del">Delete</button></div>`;
    el.querySelector('h3').textContent = c.title || 'Untitled lesson';
    el.querySelector('.cover').appendChild(thumb(c.firstCard, c.accent, 120));
    el.querySelector('[data-a=dup]').addEventListener('click', async () => { try { const r = await api('POST', `/api/courses/${c.id}/duplicate`); location.hash = 'edit-' + r.id; } catch (e) { alertMsg(e.message); } });
    twoStep(el.querySelector('[data-a=del]'), 'Delete', async () => { try { await api('DELETE', '/api/courses/' + c.id); el.remove(); } catch (e) { alertMsg(e.message); } });
    box.appendChild(el);
  });
}
function alertMsg(text) {
  const s = $('#status');
  if (s) { s.textContent = text; s.className = 'status err'; return; }
  const l = $('#list'); if (l) l.insertAdjacentHTML('afterbegin', `<div class="muted" style="grid-column:1/-1;color:#c0392b">${esc(text)}</div>`);
}
async function createLesson() {
  try { const r = await api('POST', '/api/courses'); location.hash = 'edit-' + r.id; }
  catch (e) { alertMsg('Couldn’t create a lesson: ' + e.message); }
}

/* ---------------- editor ---------------- */
async function showEditor(cid) {
  shell(`<div class="ed">
    <header class="ed-top">
      <a class="btn ghost" href="#">← Lessons</a>
      <input id="title" class="title-in" placeholder="Lesson title" maxlength="120" aria-label="Lesson title">
      <span id="status" class="status"></span>
      <span class="sp"></span>
      <label class="toggle" title="Published lessons can be opened by anyone with the link"><input type="checkbox" id="pub"> <span id="pubTxt">Draft</span></label>
      <a class="btn ghost" href="/l/${cid}?preview" target="_blank" rel="noopener">▶ Preview</a>
      <a class="btn ghost" href="#stats-${cid}">Stats</a>
      <button class="btn ghost" id="export">Export HTML</button>
      <button class="btn primary" id="share">Share</button>
    </header>
    <div class="ed-body">
      <aside class="rail"><div id="cards" class="cards"></div><button class="btn add-card" id="addCard">+ Card</button></aside>
      <main class="stage"><div class="phone" id="phone"><div class="pad muted">Loading…</div></div>
        <div class="stage-nav"><button class="btn ghost sm" id="sPrev" aria-label="Previous card">‹</button><span id="sIdx"></span><button class="btn ghost sm" id="sNext" aria-label="Next card">›</button></div></main>
      <aside class="insp" id="insp"></aside>
    </div>
    <div class="modal" id="modal" hidden></div>
  </div>`);

  let course = null, sel = 0, dirty = false, saving = false, timer = null, alive = true;
  const statusEl = $('#status');
  const setStatus = (s, cls) => { statusEl.textContent = s; statusEl.className = 'status ' + (cls || ''); };

  function touch() { dirty = true; setStatus('Saving…'); clearTimeout(timer); timer = setTimeout(flush, 600); }
  async function flush() {
    clearTimeout(timer);
    if (!dirty || !course) return;
    if (saving) { timer = setTimeout(flush, 300); return; }
    saving = true; dirty = false;
    try {
      await api('PUT', '/api/courses/' + cid, { title: course.title, accent: course.accent, cards: course.cards });
      if (!dirty && alive) setStatus('Saved', 'ok');
    } catch (e) {
      dirty = true;
      if (alive) { setStatus('Not saved — retrying', 'err'); timer = setTimeout(flush, 3000); }
    } finally { saving = false; }
  }
  const onUnload = (e) => { if (dirty || saving) { flush(); e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);
  cleanup = () => { alive = false; window.removeEventListener('beforeunload', onUnload); if (dirty) flush(); };

  try { course = await api('GET', '/api/courses/' + cid); }
  catch (e) { return message('Lesson not found', esc(e.message) + ' <a href="#">Back to lessons</a>'); }
  if (!alive) return;
  normalize();

  function normalize() {
    if (!Array.isArray(course.cards)) course.cards = [];
    course.cards.forEach((c) => {
      if (!c.id) c.id = rid();
      if (!Array.isArray(c.blocks)) c.blocks = [];
      c.blocks.forEach((b) => { if (!b.id) b.id = rid(); });
    });
    if (!course.cards.length) course.cards.push({ id: rid(), bg: '#ffffff', blocks: [] });
    if (!course.accent) course.accent = '#ff5a36';
    sel = Math.min(sel, course.cards.length - 1);
  }

  /* header */
  const titleIn = $('#title');
  titleIn.value = course.title || '';
  titleIn.addEventListener('input', () => { course.title = titleIn.value; touch(); });
  const pub = $('#pub'), pubTxt = $('#pubTxt');
  const showPub = () => { pub.checked = !!course.published; pubTxt.textContent = course.published ? 'Live' : 'Draft'; };
  showPub();
  pub.addEventListener('change', async () => {
    const want = pub.checked;
    try { await flush(); await api('POST', `/api/courses/${cid}/publish`, { published: want }); course.published = want; showPub(); setStatus(want ? 'Published' : 'Unpublished', 'ok'); }
    catch (e) { pub.checked = !want; setStatus(e.message, 'err'); }
  });
  $('#addCard').addEventListener('click', () => { const prevBg = (course.cards[sel] || {}).bg || '#ffffff'; course.cards.splice(sel + 1, 0, { id: rid(), bg: prevBg, blocks: [{ id: rid(), type: 'heading', text: '' }] }); sel++; touch(); renderAll(); });
  $('#sPrev').addEventListener('click', () => { if (sel > 0) { sel--; renderAll(); } });
  $('#sNext').addEventListener('click', () => { if (sel < course.cards.length - 1) { sel++; renderAll(); } });
  $('#share').addEventListener('click', openShare);
  $('#export').addEventListener('click', (e) => exportHtml(e.currentTarget));

  renderAll();

  function renderAll() { if (!alive) return; renderRail(); renderStage(); renderInsp(); }

  /* rail */
  let dragFrom = null;
  function renderRail() {
    const box = $('#cards'); box.innerHTML = '';
    course.cards.forEach((c, k) => {
      const it = document.createElement('button'); it.type = 'button'; it.className = 'cthumb' + (k === sel ? ' on' : ''); it.draggable = true;
      it.setAttribute('aria-label', 'Card ' + (k + 1));
      it.innerHTML = `<span class="num">${k + 1}</span>`; it.appendChild(thumb(c, course.accent, 96));
      it.addEventListener('click', () => { sel = k; renderAll(); });
      it.addEventListener('dragstart', (e) => { dragFrom = k; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(k)); } catch (_) {} });
      it.addEventListener('dragover', (e) => { if (dragFrom === null) return; e.preventDefault(); it.classList.add('drop'); });
      it.addEventListener('dragleave', () => it.classList.remove('drop'));
      it.addEventListener('drop', (e) => { e.preventDefault(); it.classList.remove('drop'); if (dragFrom === null || dragFrom === k) return; const [m] = course.cards.splice(dragFrom, 1); course.cards.splice(k, 0, m); sel = k; dragFrom = null; touch(); renderAll(); });
      it.addEventListener('dragend', () => { dragFrom = null; });
      box.appendChild(it);
    });
  }
  let thumbRaf = 0;
  function updateThumb() {
    cancelAnimationFrame(thumbRaf);
    thumbRaf = requestAnimationFrame(() => {
      const it = $('#cards') && $('#cards').children[sel]; if (!it) return;
      const old = it.querySelector('.thumb'); if (old) old.replaceWith(thumb(course.cards[sel], course.accent, 96));
    });
  }

  /* stage */
  function renderStage() {
    const ph = $('#phone'); ph.innerHTML = '';
    const c = course.cards[sel];
    if (c) ph.appendChild(TapPlayer.renderCard(c, { media, accent: course.accent, editing: true }));
    $('#sIdx').textContent = `Card ${sel + 1} of ${course.cards.length}`;
  }
  const live = () => { touch(); renderStage(); updateThumb(); };

  /* inspector */
  function section(title) { const s = document.createElement('div'); s.className = 'sec'; s.innerHTML = `<h4>${esc(title)}</h4>`; return s; }
  function field(label, el, hint) { const l = document.createElement('label'); l.className = 'fld'; l.innerHTML = `<span>${esc(label)}</span>`; l.appendChild(el); if (hint) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = hint; l.appendChild(d); } return l; }
  function input(val, on, ph) { const i = document.createElement('input'); i.className = 'in'; i.value = val || ''; if (ph) i.placeholder = ph; i.addEventListener('input', () => on(i.value)); return i; }
  function textarea(val, on, ph) { const t = document.createElement('textarea'); t.className = 'ta'; t.value = val || ''; if (ph) t.placeholder = ph; t.addEventListener('input', () => on(t.value)); return t; }
  function swatchRow(list, current, on) {
    const row = document.createElement('div'); row.className = 'row';
    list.forEach((col) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sw' + (col.toLowerCase() === (current || '').toLowerCase() ? ' on' : ''); b.style.background = col; b.setAttribute('aria-label', col); b.addEventListener('click', () => { on(col); row.querySelectorAll('.sw').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }); row.appendChild(b); });
    const ci = document.createElement('input'); ci.type = 'color'; ci.className = 'colorin'; ci.value = /^#[0-9a-f]{6}$/i.test(current || '') ? current : '#ffffff'; ci.title = 'Custom colour';
    ci.addEventListener('input', () => { on(ci.value); row.querySelectorAll('.sw').forEach((x) => x.classList.remove('on')); });
    row.appendChild(ci); return row;
  }

  function renderInsp() {
    const ins = $('#insp'); const scroll = ins.scrollTop; ins.innerHTML = '';
    const card = course.cards[sel]; if (!card) return;

    const cs = section('Card ' + (sel + 1) + ' background');
    cs.appendChild(swatchRow(SWATCHES, card.bg, (col) => { card.bg = col; live(); }));
    const acts = document.createElement('div'); acts.className = 'row card-acts';
    acts.innerHTML = `<button class="btn sm" data-a="up" ${sel === 0 ? 'disabled' : ''}>↑ Move</button><button class="btn sm" data-a="down" ${sel === course.cards.length - 1 ? 'disabled' : ''}>↓ Move</button><button class="btn sm" data-a="dup">Duplicate</button><button class="btn sm danger" data-a="del" ${course.cards.length < 2 ? 'disabled' : ''}>Delete</button>`;
    acts.querySelector('[data-a=up]').addEventListener('click', () => { const [m] = course.cards.splice(sel, 1); course.cards.splice(sel - 1, 0, m); sel--; touch(); renderAll(); });
    acts.querySelector('[data-a=down]').addEventListener('click', () => { const [m] = course.cards.splice(sel, 1); course.cards.splice(sel + 1, 0, m); sel++; touch(); renderAll(); });
    acts.querySelector('[data-a=dup]').addEventListener('click', () => { const copy = JSON.parse(JSON.stringify(card)); copy.id = rid(); copy.blocks.forEach((b) => { b.id = rid(); }); course.cards.splice(sel + 1, 0, copy); sel++; touch(); renderAll(); });
    twoStep(acts.querySelector('[data-a=del]'), 'Delete', () => { course.cards.splice(sel, 1); sel = Math.max(0, sel - 1); touch(); renderAll(); });
    cs.appendChild(acts); ins.appendChild(cs);

    const bs = section('Blocks');
    if (!card.blocks.length) { const p = document.createElement('div'); p.className = 'hint'; p.style.marginBottom = '10px'; p.textContent = 'This card is empty. Add a block below.'; bs.appendChild(p); }
    card.blocks.forEach((b, bi) => bs.appendChild(blockEditor(card, b, bi)));
    const adds = document.createElement('div'); adds.className = 'adds';
    Object.keys(LABEL).forEach((type) => {
      const btn = document.createElement('button'); btn.type = 'button'; btn.innerHTML = `<b>${LABEL[type][0]}</b>${LABEL[type][1]}`;
      btn.addEventListener('click', () => {
        card.blocks.push(newBlock(type)); touch(); renderAll();
        const all = $('#insp').querySelectorAll('.blk'); const last = all[all.length - 1];
        if (last) { last.scrollIntoView({ block: 'nearest' }); const f = last.querySelector('input.in,textarea'); if (f) f.focus(); }
      });
      adds.appendChild(btn);
    });
    bs.appendChild(adds); ins.appendChild(bs);

    const ls = section('Lesson accent colour');
    ls.appendChild(swatchRow(ACCENTS, course.accent, (col) => { course.accent = col; touch(); renderStage(); renderRail(); }));
    const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Used for buttons, quiz highlights and the “next” button.'; ls.appendChild(h);
    ins.appendChild(ls);
    ins.scrollTop = scroll;
  }

  function newBlock(type) {
    const id = rid();
    switch (type) {
      case 'heading': return { id, type, text: '' };
      case 'text': return { id, type, text: '' };
      case 'image': return { id, type, asset: null, caption: '', fill: false };
      case 'video': return { id, type, asset: null, caption: '' };
      case 'quiz': return { id, type, question: '', options: ['', ''], correct: 0, explain: '' };
      case 'link': return { id, type, label: 'Learn more', url: 'https://' };
    }
  }

  function blockEditor(card, b, bi) {
    const w = document.createElement('div'); w.className = 'blk';
    const [ic, name] = LABEL[b.type] || ['•', b.type];
    w.innerHTML = `<div class="blk-h"><span class="blk-t"><i>${ic}</i>${esc(name)}</span><span class="sp"></span>
      <button class="ib" data-a="up" title="Move up" ${bi === 0 ? 'disabled' : ''}>↑</button><button class="ib" data-a="down" title="Move down" ${bi === card.blocks.length - 1 ? 'disabled' : ''}>↓</button><button class="ib" data-a="del" title="Remove">×</button></div>`;
    w.querySelector('[data-a=up]').addEventListener('click', () => { card.blocks.splice(bi - 1, 0, card.blocks.splice(bi, 1)[0]); touch(); renderAll(); });
    w.querySelector('[data-a=down]').addEventListener('click', () => { card.blocks.splice(bi + 1, 0, card.blocks.splice(bi, 1)[0]); touch(); renderAll(); });
    twoStep(w.querySelector('[data-a=del]'), '×', () => { card.blocks.splice(bi, 1); touch(); renderAll(); });

    switch (b.type) {
      case 'heading': w.appendChild(input(b.text, (v) => { b.text = v; live(); }, 'Heading')); break;
      case 'text': w.appendChild(field('Text', textarea(b.text, (v) => { b.text = v; live(); }, 'Write something…'), 'Wrap words in **double asterisks** for bold.')); break;
      case 'image':
      case 'video': {
        w.appendChild(mediaPicker(b));
        w.appendChild(field('Caption (optional)', input(b.caption, (v) => { b.caption = v; live(); })));
        if (b.type === 'image') {
          const l = document.createElement('label'); l.className = 'chk';
          l.innerHTML = '<input type="checkbox"> Fill the whole card (other blocks sit on top)';
          const cb = l.querySelector('input'); cb.checked = !!b.fill; cb.addEventListener('change', () => { b.fill = cb.checked; live(); });
          w.appendChild(l);
        }
        break;
      }
      case 'quiz': {
        w.appendChild(field('Question', input(b.question, (v) => { b.question = v; live(); }, 'Ask something…')));
        const ol = document.createElement('div'); ol.className = 'fld'; ol.innerHTML = '<span>Answers <span class="muted">— tick the correct one</span></span>';
        const name = 'q' + rid();
        b.options.forEach((o, oi) => {
          const r = document.createElement('div'); r.className = 'opt-row';
          const rad = document.createElement('input'); rad.type = 'radio'; rad.name = name; rad.checked = b.correct === oi; rad.title = 'Correct answer'; rad.disabled = b.correct === -1;
          rad.addEventListener('change', () => { b.correct = oi; live(); });
          const inp = input(o, (v) => { b.options[oi] = v; live(); }, 'Answer ' + (oi + 1));
          const x = document.createElement('button'); x.type = 'button'; x.className = 'ib'; x.textContent = '×'; x.title = 'Remove answer'; x.disabled = b.options.length <= 2;
          x.addEventListener('click', () => { b.options.splice(oi, 1); if (b.correct === oi) b.correct = 0; else if (b.correct > oi) b.correct--; touch(); renderAll(); });
          r.append(rad, inp, x); ol.appendChild(r);
        });
        const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
        const add = document.createElement('button'); add.type = 'button'; add.className = 'btn sm'; add.textContent = '+ Answer'; add.disabled = b.options.length >= 6;
        add.addEventListener('click', () => { b.options.push(''); touch(); renderAll(); });
        const none = document.createElement('label'); none.className = 'chk'; none.style.marginTop = '0';
        none.innerHTML = '<input type="checkbox"> Poll (no right answer)';
        const nc = none.querySelector('input'); nc.checked = b.correct === -1;
        nc.addEventListener('change', () => { b.correct = nc.checked ? -1 : 0; touch(); renderAll(); });
        row.append(add, none); ol.appendChild(row);
        w.appendChild(ol);
        w.appendChild(field('Feedback after answering (optional)', textarea(b.explain, (v) => { b.explain = v; live(); }, 'Explain the answer…')));
        break;
      }
      case 'link': {
        w.appendChild(field('Button label', input(b.label, (v) => { b.label = v; live(); })));
        const warn = document.createElement('div'); warn.className = 'warn';
        const check = (v) => { let ok = false; try { ok = /^https?:$/.test(new URL(v).protocol); } catch (e) {} warn.textContent = ok || !v ? '' : 'Use a full web address starting with https://'; };
        w.appendChild(field('Web address', input(b.url, (v) => { b.url = v; check(v); live(); }, 'https://…')));
        w.appendChild(warn); check(b.url);
        break;
      }
    }
    return w;
  }

  function mediaPicker(b) {
    const isImg = b.type === 'image';
    const wrap = document.createElement('div');
    const p = document.createElement('div'); p.className = 'pick';
    const pv = document.createElement('div'); pv.className = 'pv';
    if (b.asset) { if (isImg) pv.style.backgroundImage = `url("${media(b.asset)}")`; else { const v = document.createElement('video'); v.src = media(b.asset); v.muted = true; v.preload = 'metadata'; pv.appendChild(v); } }
    const label = () => (b.asset ? 'Replace' : 'Upload ' + (isImg ? 'image' : 'video'));
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn sm'; btn.textContent = label();
    const fi = document.createElement('input'); fi.type = 'file'; fi.hidden = true; fi.accept = (isImg ? IMG_TYPES : VID_TYPES).join(',');
    const note = document.createElement('div'); note.className = 'hint';
    note.textContent = isImg ? 'PNG, JPG, GIF or WebP. Large photos are resized automatically.' : `MP4 (H.264) plays everywhere. WebM and MOV also accepted. Up to ${config.maxUploadMb} MB.`;
    const bar = document.createElement('div'); bar.className = 'bar'; bar.hidden = true; bar.innerHTML = '<i></i>';
    const col = document.createElement('div'); col.style.flex = '1'; col.append(btn, bar);
    p.append(pv, col, fi); wrap.append(p, note);
    btn.addEventListener('click', () => fi.click());
    fi.addEventListener('change', async () => {
      let file = fi.files && fi.files[0]; fi.value = ''; if (!file) return;
      const fail = (t) => { note.className = 'warn'; note.textContent = t; btn.disabled = false; btn.textContent = label(); bar.hidden = true; };
      const types = isImg ? IMG_TYPES : VID_TYPES;
      if (!types.includes(file.type)) return fail(isImg ? 'Use a PNG, JPG, GIF or WebP image.' : 'Use an MP4, WebM or MOV video.');
      btn.disabled = true; btn.textContent = 'Uploading…'; bar.hidden = false;
      try {
        if (isImg && file.type !== 'image/gif' && file.size > 1.2 * 1024 * 1024) file = await shrink(file);
        if (file.size > config.maxUploadMb * 1048576) return fail(`That file is over ${config.maxUploadMb} MB.`);
        const r = await upload(file, (f) => { bar.firstChild.style.width = (f * 100).toFixed(1) + '%'; btn.textContent = 'Uploading ' + Math.round(f * 100) + '%'; });
        b.asset = r.id; touch(); renderAll();
      } catch (e) { fail(e.message || 'Upload failed.'); }
    });
    return wrap;
  }

  function shrink(file) {
    return new Promise((res) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const max = 1800, s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
        c.toBlob((bl) => res(bl && bl.size < file.size ? new File([bl], 'img', { type: bl.type }) : file), type, 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); res(file); };
      img.src = url;
    });
  }

  /* share & export */
  function openShare() {
    flush();
    const modal = $('#modal');
    const link = lessonUrl(cid);
    modal.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="Share lesson"><h2>Share this lesson</h2>
      <p id="shareState"></p>
      <div class="copy"><input class="in" readonly><button class="btn primary" id="cp">Copy</button></div>
      <ol class="steps"><li>Anyone with the link can open the lesson. No account needed.</li>
      <li>Each viewer's progress is tracked anonymously; see the <b>Stats</b> page.</li>
      <li>Edits go live as soon as they're saved. Switch the lesson back to <b>Draft</b> to take the link offline.</li></ol>
      <div class="dlg-a"><button class="btn" id="cl">Close</button></div></div>`;
    const inp = modal.querySelector('input'); inp.value = link;
    const st = modal.querySelector('#shareState');
    const paint = () => {
      st.innerHTML = course.published ? 'This lesson is <b>live</b>. Send learners this link:' : 'This lesson is a <b>draft</b>, so the link won’t work yet. <button class="btn sm primary" id="goLive">Publish now</button>';
      const g = st.querySelector('#goLive');
      if (g) g.addEventListener('click', async () => { g.disabled = true; try { await flush(); await api('POST', `/api/courses/${cid}/publish`, { published: true }); course.published = true; showPub(); paint(); } catch (e) { g.disabled = false; st.append(' ' + e.message); } });
    };
    paint();
    modal.hidden = false;
    const close = () => { modal.hidden = true; modal.innerHTML = ''; };
    modal.querySelector('#cl').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
    const cp = modal.querySelector('#cp');
    cp.addEventListener('click', () => {
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(() => { cp.textContent = 'Copied ✓'; })
        .catch(() => { inp.focus(); inp.select(); cp.textContent = 'Press Ctrl+C'; });
    });
  }

  async function exportHtml(btn) {
    const lbl = 'Export HTML';
    const done = (t) => { btn.textContent = t; btn.disabled = false; setTimeout(() => { btn.textContent = lbl; }, 2500); };
    btn.disabled = true; btn.textContent = 'Packing…';
    try {
      await flush();
      const ids = [...new Set(course.cards.flatMap((c) => c.blocks).filter((b) => (b.type === 'image' || b.type === 'video') && b.asset).map((b) => b.asset))];
      const M = {};
      for (const id of ids) {
        const r = await fetch(media(id)); if (!r.ok) throw new Error('media');
        const bl = await r.blob();
        M[id] = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(bl); });
      }
      const [css, js] = await Promise.all([fetch('/static/player.css').then((r) => r.text()), fetch('/static/player.js').then((r) => r.text())]);
      const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
      const SC = '</' + 'script>';
      const data = { title: course.title, accent: course.accent, cards: course.cards };
      const html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>' + esc(course.title || 'Lesson') + '</title>'
        + '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">'
        + '<style>html,body{margin:0;height:100%;background:#0d0c10}' + css + '</style></head><body><div id="r"></div>'
        + '<script>' + js + SC
        + '<script>var C=' + safe(data) + ',M=' + safe(M) + ';TapPlayer.play(document.getElementById("r"),C,{media:function(id){return M[id]||"";}});' + SC
        + '</body></html>';
      const fname = ((course.title || 'lesson').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lesson') + '.html';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      done('Exported ✓');
    } catch (e) { done('Export failed'); }
  }
}

/* ---------------- stats ---------------- */
async function showStats(cid) {
  shell(`<div class="st"><div class="st-top"><a class="btn ghost" href="#">← Lessons</a><span class="sp"></span>
    <a class="btn ghost" href="#edit-${cid}">Edit lesson</a><button class="btn ghost" id="refresh">Refresh</button><button class="btn ghost danger" id="reset">Reset stats</button></div>
    <div id="body"><p class="muted" style="margin-top:30px">Loading stats…</p></div></div>`);
  let alive = true;
  cleanup = () => { alive = false; };
  $('#refresh').addEventListener('click', load);
  twoStep($('#reset'), 'Reset stats', async () => { try { await api('POST', `/api/courses/${cid}/stats/reset`); load(); } catch (e) { alert(e.message); } });
  load();

  async function load() {
    let course, s;
    try { [course, s] = await Promise.all([api('GET', '/api/courses/' + cid), api('GET', `/api/courses/${cid}/stats`)]); }
    catch (e) { if (alive) $('#body').innerHTML = `<p class="muted">Couldn’t load stats: ${esc(e.message)}</p>`; return; }
    if (!alive) return;
    const body = $('#body');
    body.innerHTML = `<h1></h1><p class="sub">${course.published ? '<span class="badge live">Live</span>' : '<span class="badge">Draft</span>'} &nbsp;${s.cards} cards · <a href="${esc(lessonUrl(cid))}" target="_blank" rel="noopener">${esc(lessonUrl(cid))}</a></p>
      <div class="tiles">
        <div class="tile"><div class="k">Viewers</div><div class="v">${s.viewers}</div></div>
        <div class="tile"><div class="k">Total visits</div><div class="v">${s.visits}</div></div>
        <div class="tile"><div class="k">Completed</div><div class="v">${s.completed}<small>${s.viewers ? pct(s.completionRate) : ''}</small></div></div>
        <div class="tile"><div class="k">Average progress</div><div class="v">${s.viewers ? pct(s.avgProgress) : '—'}</div></div>
      </div>
      <div class="panel" id="funnelP"><h3>How far people got</h3><p class="note">Share of viewers who reached each card. The biggest drops show where people stop.</p><div class="funnel" id="funnel"></div></div>
      <div class="panel"><h3>New viewers, last 30 days</h3><p class="note">First-time viewers per day.</p><div class="daily" id="daily"></div><div class="daily-ax"><span>30 days ago</span><span>Today</span></div></div>
      <div class="panel" id="quizP"><h3>Quiz answers</h3><p class="note">How viewers answered each question (first answer only).</p><div id="quizzes"></div></div>
      <div class="panel"><h3>Recent viewers</h3><p class="note">Anonymous. Each browser gets its own random ID.</p><div style="overflow-x:auto"><table class="recent" id="recent"></table></div></div>`;
    body.querySelector('h1').textContent = course.title || 'Untitled lesson';

    if (!s.viewers) {
      $('#funnel').innerHTML = `<div class="empty-stats">No views yet. ${course.published ? 'Share the link to start collecting stats.' : 'Publish the lesson and share its link to start collecting stats.'}</div>`;
    } else {
      const f = $('#funnel');
      s.reach.forEach((n, k) => {
        const share = n / s.viewers;
        const prev = k ? s.reach[k - 1] : s.viewers;
        const drop = prev ? (prev - n) / s.viewers : 0;
        const row = document.createElement('div'); row.className = 'frow';
        row.innerHTML = `<span class="lbl">Card ${k + 1}</span><div class="track"><div class="fill" style="width:${(share * 100).toFixed(1)}%"></div></div><span class="val"><b>${pct(share)}</b>${drop >= 0.1 ? `<span class="drop">−${pct(drop)}</span>` : ''}</span>`;
        tipOn(row, `Card ${k + 1}: ${n} of ${s.viewers} viewers (${pct(share)})`);
        f.appendChild(row);
      });
      const done = document.createElement('div'); done.className = 'frow';
      done.innerHTML = `<span class="lbl">Finished</span><div class="track"><div class="fill" style="width:${(s.completionRate * 100).toFixed(1)}%"></div></div><span class="val"><b>${pct(s.completionRate)}</b></span>`;
      tipOn(done, `${s.completed} of ${s.viewers} viewers reached the end`);
      f.appendChild(done);
    }

    const d = $('#daily'); const mx = Math.max(1, ...s.daily);
    s.daily.forEach((n, k) => {
      const bar = document.createElement('div'); bar.className = 'd'; bar.style.height = (n / mx * 100) + '%';
      const date = new Date(Date.now() - (29 - k) * 864e5).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      tipOn(bar, `${date}: ${n} new viewer${n === 1 ? '' : 's'}`);
      d.appendChild(bar);
    });

    const qz = $('#quizzes');
    if (!s.quizzes.length) $('#quizP').remove();
    s.quizzes.forEach((qq) => {
      const w = document.createElement('div'); w.className = 'quiz';
      w.innerHTML = `<div class="qq"></div>`;
      w.querySelector('.qq').textContent = qq.question || '(no question)';
      w.querySelector('.qq').insertAdjacentHTML('beforeend', `<span>Card ${qq.card + 1} · ${qq.total} answer${qq.total === 1 ? '' : 's'}${qq.correct >= 0 ? '' : ' · poll'}</span>`);
      qq.options.forEach((o, oi) => {
        const n = qq.counts[oi] || 0, share = qq.total ? n / qq.total : 0;
        const r = document.createElement('div'); r.className = 'qrow';
        r.innerHTML = `<span class="t"></span><div class="track"><div class="fill" style="width:${(share * 100).toFixed(1)}%"></div></div><span class="val">${pct(share)}</span>`;
        r.querySelector('.t').textContent = o || `Answer ${oi + 1}`;
        if (qq.correct === oi) r.querySelector('.t').insertAdjacentHTML('afterbegin', '<span class="ok">✓ </span>');
        tipOn(r, `${n} answer${n === 1 ? '' : 's'}${qq.correct === oi ? ' (correct answer)' : ''}`);
        w.appendChild(r);
      });
      qz.appendChild(w);
    });

    const t = $('#recent');
    if (!s.recent.length) t.innerHTML = '<tr><td class="muted">Nobody yet.</td></tr>';
    else {
      t.innerHTML = '<thead><tr><th>Viewer</th><th>First seen</th><th>Last seen</th><th>Visits</th><th>Progress</th></tr></thead><tbody></tbody>';
      const tb = t.querySelector('tbody');
      s.recent.forEach((v) => {
        const tr = document.createElement('tr');
        const prog = v.completed ? '✓ Finished' : `Card ${Math.min(v.furthest + 1, s.cards)} of ${s.cards}`;
        tr.innerHTML = `<td class="mono">${esc(v.viewer)}</td><td>${esc(ago(v.firstAt))}</td><td>${esc(ago(v.lastAt))}</td><td>${v.visits}</td><td>${esc(prog)}</td>`;
        tb.appendChild(tr);
      });
    }
  }
}
})();
