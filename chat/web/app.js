'use strict';

// ---------- state ----------

const STORE_KEY = 'rootrules-chat-v1';
const MODEL_KEY = 'rootrules-chat-model';

/** @type {{role:'user'|'assistant', content:string, trace?:any[], warning?:string, error?:string, streaming?:boolean}[]} */
let messages = [];
let controller = null;

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const composer = $('composer');
const modelSelect = $('model');

function load() {
  try {
    messages = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  } catch {
    messages = [];
  }
  messages = messages.filter((m) => !m.streaming);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(messages));
  } catch {
    /* storage unavailable: conversation just won't persist */
  }
}

// ---------- markdown (small, escape-first, so model output can't inject HTML) ----------

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// §4.3.1, §G.24, §9.2.9.IIIa (optionally followed by " [Title]"), FAQ-4, "rule 4.3.1"
const CITE =
  /§\s?((?:\d{1,2}|[A-Z])(?:\.(?:\d{1,2}|[IVX]{1,4}[a-z]?))*)(?: \[([^\]]+)\])?|\bFAQ-(\d+)\b|\b([Rr]ule) ((?:\d{1,2}|[A-Z])(?:\.\d{1,2})+)\b/g;

function linkify(html) {
  return html.replace(CITE, (whole, id, title, faq, ruleWord, ruleId) => {
    if (faq) return `<button type="button" class="cite" data-faq="${faq}">FAQ-${faq}</button>`;
    if (ruleId) return `${ruleWord} <button type="button" class="cite" data-rule="${ruleId}">${ruleId}</button>`;
    const label = title ? `§${id} ${title}` : `§${id}`;
    return `<button type="button" class="cite" data-rule="${id}">${label}</button>`;
  });
}

function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = linkify(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[+n]}</code>`);
}

function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  const isBlockStart = (l) => /^(```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>)/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(4, Math.max(3, line.match(/^#+/)[0].length + 1));
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s/.test(lines[i]); i++) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${md(quote.join('\n'))}</blockquote>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i])); i++) para.push(lines[i]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('');
}

/** Split inline <think>…</think> (some models put reasoning in the content) from the answer. */
function splitThinking(text) {
  const m = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)([\s\S]*)$/);
  return m ? { thinking: m[1].trim(), answer: m[3].trim() } : { thinking: '', answer: text };
}

// ---------- rendering ----------

function argSummary(name, json) {
  try {
    const a = JSON.parse(json || '{}');
    if (name === 'search_rules') return `“${a.query ?? ''}”${a.faction ? ` · ${a.faction}` : ''}`;
    if (name === 'get_rules') return (a.ids || []).join(', ');
    if (name === 'lookup_term') return `“${a.term ?? ''}”`;
    if (name === 'table_of_contents') return a.section || 'all sections';
    return Object.values(a).join(', ');
  } catch {
    return json;
  }
}

const TOOL_LABEL = {
  search_rules: 'Search',
  get_rules: 'Read',
  lookup_term: 'Term',
  table_of_contents: 'Contents',
};

function traceSummary(msg) {
  const tools = msg.trace.filter((t) => t.kind === 'tool');
  if (msg.streaming) {
    const last = msg.trace[msg.trace.length - 1];
    if (last?.kind === 'tool' && last.result == null) {
      return `${TOOL_LABEL[last.name] ?? last.name} ${argSummary(last.name, last.args)}…`;
    }
    return msg.trace.some((t) => t.kind === 'thinking') && !tools.length ? 'Thinking…' : 'Working…';
  }
  return tools.length ? `Checked the rules (${tools.length} lookup${tools.length === 1 ? '' : 's'})` : 'Reasoning';
}

function renderTrace(msg, { thinking }) {
  const items = [...msg.trace];
  if (thinking) items.unshift({ kind: 'thinking', text: thinking });
  if (!items.length && !msg.streaming) return null;

  const details = document.createElement('details');
  details.className = 'trace';
  const summary = document.createElement('summary');
  if (msg.streaming) summary.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  summary.append(traceSummary(msg));
  details.append(summary);

  const steps = document.createElement('div');
  steps.className = 'trace-steps';
  for (const t of items) {
    const el = document.createElement('div');
    el.className = 'step';
    if (t.kind === 'thinking') {
      el.innerHTML = `<div class="step-name">Thinking</div><div class="thinking"></div>`;
      el.querySelector('.thinking').textContent = t.text;
    } else if (t.kind === 'note') {
      el.innerHTML = `<div class="note"></div>`;
      el.querySelector('.note').textContent = t.text;
    } else {
      if (t.isError) el.classList.add('err');
      el.innerHTML =
        `<span class="step-name">${esc(TOOL_LABEL[t.name] ?? t.name)}</span> ` +
        `<span class="step-args">${esc(argSummary(t.name, t.args))}</span>` +
        (t.result != null ? `<details><summary>What the model read</summary><pre></pre></details>` : '');
      const pre = el.querySelector('pre');
      if (pre) pre.textContent = t.result;
    }
    steps.append(el);
  }
  details.append(steps);
  return details;
}

function renderMessage(msg) {
  const el = document.createElement('article');
  el.className = `msg ${msg.role}`;
  if (msg.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content;
    el.append(bubble);
    return el;
  }
  const parts = splitThinking(msg.content);
  const trace = renderTrace(msg, parts);
  if (trace) el.append(trace);
  if (parts.answer) {
    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.innerHTML = md(parts.answer);
    el.append(answer);
  }
  if (msg.warning) {
    const warn = document.createElement('div');
    warn.className = 'warning';
    warn.textContent = `⚠ ${msg.warning}`;
    el.append(warn);
  }
  if (msg.error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = msg.error;
    el.append(err);
  }
  return el;
}

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function renderAll() {
  $('empty').hidden = messages.length > 0;
  log.querySelectorAll('.msg').forEach((n) => n.remove());
  for (const m of messages) log.append(renderMessage(m));
  log.scrollTop = log.scrollHeight;
}

/** Re-render only the last message (cheap enough per token for a chat this size). */
function renderLast() {
  const stick = nearBottom();
  const last = log.querySelector('.msg:last-of-type');
  const msg = messages[messages.length - 1];
  const wasOpen = last?.querySelector('.trace')?.open;
  const fresh = renderMessage(msg);
  if (wasOpen && fresh.querySelector('.trace')) fresh.querySelector('.trace').open = true;
  last ? last.replaceWith(fresh) : log.append(fresh);
  if (stick) log.scrollTop = log.scrollHeight;
}

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderLast();
  });
}

// ---------- chat ----------

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('send').setAttribute('aria-label', busy ? 'Stop' : 'Send');
}

function history() {
  return messages
    .filter((m) => !m.streaming && !m.error)
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : m.content }))
    .filter((m) => m.content);
}

async function send(text) {
  if (controller || !text.trim()) return;
  messages.push({ role: 'user', content: text.trim() });
  const msg = { role: 'assistant', content: '', trace: [], streaming: true };
  const body = JSON.stringify({ model: modelSelect.value, messages: history() });
  messages.push(msg);
  renderAll();
  setBusy(true);
  controller = new AbortController();

  try {
    const res = await fetch('api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    await readEvents(res.body, (event, data) => handleEvent(msg, event, data));
  } catch (e) {
    if (e.name !== 'AbortError') msg.error = e.message || String(e);
    else if (!msg.content) msg.error = 'Stopped.';
  } finally {
    if (msg.error && msg.error !== 'Stopped.') checkHealth();
    msg.streaming = false;
    controller = null;
    setBusy(false);
    save();
    renderLast();
  }
}

function handleEvent(msg, event, data) {
  switch (event) {
    case 'delta':
      msg.content += data.text;
      break;
    case 'reasoning': {
      const last = msg.trace[msg.trace.length - 1];
      if (last?.kind === 'thinking') last.text += data.text;
      else msg.trace.push({ kind: 'thinking', text: data.text });
      break;
    }
    case 'tool_call': {
      // Text the model wrote before deciding to use a tool is commentary, not the answer.
      const { thinking, answer } = splitThinking(msg.content);
      if (thinking) msg.trace.push({ kind: 'thinking', text: thinking });
      if (answer) msg.trace.push({ kind: 'note', text: answer });
      msg.content = '';
      msg.trace.push({ kind: 'tool', id: data.id, name: data.name, args: data.arguments, result: null });
      break;
    }
    case 'tool_result': {
      const t = msg.trace.find((x) => x.kind === 'tool' && x.id === data.id && x.result == null);
      if (t) {
        t.result = data.text;
        t.isError = data.isError;
      }
      break;
    }
    case 'retract': {
      // The model answered without looking anything up; keep the withdrawn text in the trace only.
      const { thinking, answer } = splitThinking(msg.content);
      if (thinking) msg.trace.push({ kind: 'thinking', text: thinking });
      msg.trace.push({ kind: 'note', text: answer ? `${data.reason}\n\nWithdrawn: ${answer}` : data.reason });
      msg.content = '';
      break;
    }
    case 'warning':
      msg.warning = data.message;
      break;
    case 'error':
      msg.error = data.message;
      break;
  }
  scheduleRender();
}

async function readEvents(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// ---------- rule sheet ----------

const sheet = $('sheet');
const sheetBody = $('sheet-body');
const sheetStack = [];

function chip(id, title) {
  return `<button type="button" class="cite" data-rule="${esc(id)}">§${esc(id)}${title ? ` ${esc(title)}` : ''}</button>`;
}

function ruleHtml(r) {
  const base = r.subrules.length ? Math.min(...r.subrules.map((s) => s.depth)) : 0;
  const parts = [
    `<h2>§${esc(r.id)} ${esc(r.title)}</h2>`,
    `<div class="meta">${r.path.map((p) => chip(p.id, p.title)).join(' › ')}` +
      `${r.lawId !== r.id ? ` <span>· printed Law ${esc(r.lawId)}</span>` : ''}` +
      `${r.faction ? ` <span>· ${esc(r.faction)}</span>` : ''}</div>`,
    ...r.context.map((c) => `<blockquote><strong>${esc(c.id)} ${esc(c.title)}:</strong> ${inline(c.text)}</blockquote>`),
    r.text ? md(r.text) : '',
  ];
  if (r.subrules.length) {
    parts.push(
      ...r.subrules.map(
        (s) =>
          `<p class="sub" style="margin-left:${(s.depth - base) * 14}px"><strong>${esc(s.id)} ${esc(s.title)}.</strong> ${inline(s.text)}</p>`,
      ),
    );
  }
  if (r.faq.length) {
    parts.push('<h3>FAQ</h3>', ...r.faq.map(faqHtml));
  }
  if (r.errata.length) {
    parts.push('<h3>Errata</h3>', ...r.errata.map((e) => `<p>${inline(e.text)}</p>`));
  }
  if (r.refersTo.length) parts.push('<h3>Refers to</h3>', `<div class="chips">${r.refersTo.map((x) => chip(x.id, x.title)).join('')}</div>`);
  if (r.referencedBy.length) parts.push('<h3>Referenced by</h3>', `<div class="chips">${r.referencedBy.map((x) => chip(x.id, x.title)).join('')}</div>`);
  return parts.join('');
}

function faqHtml(f) {
  return (
    `<div class="faq"><p><strong>${esc(f.id)}: ${inline(f.question)}</strong></p><p>${inline(f.answer)}</p>` +
    `<div class="chips">${f.rules.map((x) => chip(x.id, x.title)).join('')}</div></div>`
  );
}

async function showCitation(ref, push = true) {
  if (push) sheetStack.push(ref);
  $('sheet-back').hidden = sheetStack.length < 2;
  sheet.hidden = false;
  $('sheet-title').textContent = ref.rule ? `§${ref.rule}` : `FAQ-${ref.faq}`;
  sheetBody.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const url = ref.rule ? `api/rule?ids=${encodeURIComponent(ref.rule)}` : `api/faq/${encodeURIComponent(ref.faq)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (ref.rule) {
      const r = data.rules[0];
      $('sheet-title').textContent = `§${r.id} ${r.title}`;
      sheetBody.innerHTML = ruleHtml(r);
    } else {
      sheetBody.innerHTML = faqHtml(data);
    }
    sheetBody.scrollTop = 0;
  } catch (e) {
    sheetBody.innerHTML = `<p class="error">${esc(e.message || String(e))}</p>`;
  }
}

function closeSheet() {
  sheet.hidden = true;
  sheetStack.length = 0;
}

document.addEventListener('click', (e) => {
  const cite = e.target.closest('.cite:not(.demo)');
  if (cite) {
    e.preventDefault();
    showCitation(cite.dataset.faq ? { faq: cite.dataset.faq } : { rule: cite.dataset.rule });
    return;
  }
  if (e.target.closest('[data-close]')) closeSheet();
});

$('sheet-back').addEventListener('click', () => {
  sheetStack.pop();
  showCitation(sheetStack[sheetStack.length - 1], false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});

// ---------- composer & setup ----------

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) {
    controller.abort();
    return;
  }
  const text = input.value;
  input.value = '';
  autosize();
  send(text);
});

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

document.querySelectorAll('.examples button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

$('reset').addEventListener('click', () => {
  if (controller) controller.abort();
  messages = [];
  save();
  renderAll();
  input.focus();
});

modelSelect.addEventListener('change', () => {
  try {
    localStorage.setItem(MODEL_KEY, modelSelect.value);
  } catch {
    /* ignore */
  }
});

async function loadModels() {
  const res = await fetch('api/models');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  let saved = null;
  try {
    saved = localStorage.getItem(MODEL_KEY);
  } catch {
    /* ignore */
  }
  modelSelect.innerHTML = data.models.map((m) => `<option>${esc(m)}</option>`).join('');
  modelSelect.value = data.models.includes(saved) ? saved : data.default;
}

// ---------- health ----------

// LM Studio and the rules server may be off; poll so the banner appears and clears on its own.
const HEALTH_INTERVAL_MS = 15_000;
let healthTimer = null;

function showProblems(problems) {
  const banner = $('banner');
  banner.hidden = problems.length === 0;
  banner.replaceChildren(
    ...problems.map(([text, detail]) => {
      const p = document.createElement('p');
      p.textContent = text;
      if (detail) p.title = detail;
      return p;
    }),
  );
}

async function checkHealth() {
  clearTimeout(healthTimer);
  const problems = [];
  try {
    const res = await fetch('api/health');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const { llm, rules } = await res.json();
    if (!llm.ok) problems.push(["LM Studio isn't answering, so questions can't be answered right now.", llm.error]);
    if (!rules.ok) problems.push(["The rules server isn't answering, so questions can't be answered right now.", rules.error]);
    // Fill the model list once LM Studio is reachable (it may have been off at page load).
    if (llm.ok && !modelSelect.options.length) {
      await loadModels().catch((e) => problems.push(["Couldn't load the model list.", e.message || String(e)]));
    }
  } catch (e) {
    problems.push(["The chat server isn't answering. Check your connection.", e.message || String(e)]);
  }
  showProblems(problems);
  if (document.visibilityState === 'visible') healthTimer = setTimeout(checkHealth, HEALTH_INTERVAL_MS);
}

// Check right away when the app comes back to the foreground; don't poll while hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkHealth();
  else clearTimeout(healthTimer);
});

load();
renderAll();
checkHealth();
