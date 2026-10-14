(() => {
  'use strict';

  /* ───────────────────────── база ───────────────────────── */

  const T = window.__TAURI__ || null;
  const invoke = (cmd, args) =>
    T && T.core ? T.core.invoke(cmd, args) : Promise.reject(new Error('Запущено вне Tauri'));
  const safe = (cmd, args) => invoke(cmd, args).catch(() => null);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('sh.' + k);
        return v === null ? d : JSON.parse(v);
      } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('sh.' + k, JSON.stringify(v)); } catch { /* ignore */ }
    },
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const plural = (n, f) => {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? f[1] : f[2];
  };

  /* Размеры окна: [ширина, высота]. Ширина 0 = на весь экран.
     compact — тонкая полоска ~0,5 см (19 логических px). Должна совпадать с lib.rs */
  const SIZES = { compact: [72, 8], normal: [940, 560], wide: [0, 620] };

  const state = {
    open: false,
    pinned: false,
    wide: store.get('wide', false),
    tab: store.get('tab', 'control'),
    busy: 0,          // >0 — открыт диалог, сворачиваться нельзя
    hover: false,
    cooldown: 0,
  };

  const shell = $('#shell');

  /* ───────────────────────── раскрытие / сворачивание ───────────────────────── */

  let hoverT, leaveT, collapseT;

  async function expand() {
    if (state.open) return;
    clearTimeout(collapseT);
    state.open = true;
    const [w, h] = state.wide ? SIZES.wide : SIZES.normal;
    await safe('resize_shutter', { width: w, height: h });
    onOpened();
    setTimeout(() => { if (state.open) shell.classList.add('open'); }, 40);   // даём окну дорасти, потом играем анимацию
  }

  function collapse(force = false) {
    if (!state.open) return;
    if (!force && (state.pinned || state.busy > 0)) return;
    if (force) setPinned(false);
    state.open = false;
    shell.classList.remove('open');
    clearTimeout(collapseT);
    // ждём, пока закончится анимация сжатия, и только потом уменьшаем окно
    collapseT = setTimeout(async () => {
      await safe('resize_shutter', { width: SIZES.compact[0], height: SIZES.compact[1] });
      state.cooldown = Date.now() + 500;
    }, 500);
  }

  async function applySize() {
    if (!state.open) return;
    const [w, h] = state.wide ? SIZES.wide : SIZES.normal;
    await safe('resize_shutter', { width: w, height: h });
    moveIndicator(true);
    layoutWp();
  }

  function setPinned(v) {
    state.pinned = v;
    $('#btn-pin').classList.toggle('on', v);
  }

  function textFocused() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
  }

  function maybeCollapseLater(ms = 450) {
    clearTimeout(leaveT);
    leaveT = setTimeout(() => {
      if (state.hover || state.pinned || state.busy > 0) return;
      if (textFocused() && document.hasFocus()) return;
      collapse();
    }, ms);
  }

  shell.addEventListener('mouseenter', () => {
    state.hover = true;
    clearTimeout(leaveT);
    if (state.open) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => {
      if (Date.now() >= state.cooldown) expand();
    }, 70);
  });
  shell.addEventListener('mouseleave', () => {
    state.hover = false;
    clearTimeout(hoverT);
    if (state.open) maybeCollapseLater();
  });
  shell.addEventListener('click', () => { if (!state.open) expand(); });
  window.addEventListener('blur', () => { if (state.open) maybeCollapseLater(250); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#confirm').hidden) { closeConfirm(false); return; }
      if (!$('#chat-setup').hidden) { $('#chat-setup').hidden = true; return; }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      collapse(true);
      return;
    }
    // карусель обоев: стрелки и Enter
    if (state.open && state.tab === 'wallpaper' && !textFocused() && wpItems.length) {
      if (e.key === 'ArrowRight') { e.preventDefault(); wpSetIndex(wpIndex + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); wpSetIndex(wpIndex - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); applyWallpaper(wpItems[wpIndex]); }
    }
  });

  $('#btn-pin').addEventListener('click', () => setPinned(!state.pinned));
  $('#btn-collapse').addEventListener('click', () => collapse(true));
  $('#btn-wide').addEventListener('click', () => {
    state.wide = !state.wide;
    store.set('wide', state.wide);
    $('#btn-wide').classList.toggle('on', state.wide);
    applySize();
  });
  $('#btn-wide').classList.toggle('on', state.wide);

  /* ───────────────────────── вкладки ───────────────────────── */

  /** Скользящая подсветка под активной вкладкой */
  function moveIndicator(animate = true) {
    const ind = $('#tab-ind');
    const b = $('#tabs button.on');
    if (!ind || !b) return;
    if (!animate) ind.classList.remove('anim');
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!animate) {
      void ind.offsetWidth;                       // применить без перехода
      requestAnimationFrame(() => ind.classList.add('anim'));
    }
  }

  function setTab(name) {
    state.tab = name;
    store.set('tab', name);
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
    moveIndicator(true);
    // фокус не должен «застревать» в скрытой вкладке (иначе не работают стрелки в каруселях)
    const act = document.activeElement;
    if (act && act !== document.body && act.blur && !$('#tab-' + name).contains(act)) act.blur();
    if (name === 'wallpaper') loadWallpapers(false);
    if (name === 'control') refreshControls();
    if (name === 'chat') setTimeout(() => $('#chat-input').focus(), 80);
    pollNow();
  }
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function onOpened() {
    setTab(state.tab);
    moveIndicator(false);
    tickClock();
  }

  /* ───────────────────────── уведомления и подтверждение ───────────────────────── */

  let toastT;
  function toast(text, bad = false) {
    const t = $('#toast');
    t.textContent = text;
    t.className = bad ? 'bad' : '';
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }

  let confirmResolve = null;
  function confirmDialog(text, okLabel = 'Да') {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $('#confirm-text').textContent = text;
      $('#confirm-ok').textContent = okLabel;
      $('#confirm').hidden = false;
      state.busy++;
      $('#confirm-no').focus();
    });
  }
  function closeConfirm(result) {
    if (confirmResolve) {
      $('#confirm').hidden = true;
      state.busy = Math.max(0, state.busy - 1);
      const r = confirmResolve;
      confirmResolve = null;
      r(result);
      if (!state.hover) maybeCollapseLater(700);
    }
  }
  $('#confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('#confirm-no').addEventListener('click', () => closeConfirm(false));

  /** Любой системный диалог (выбор файла/папки) — на время диалога не сворачиваемся */
  async function withBusy(fn) {
    state.busy++;
    try { return await fn(); }
    finally {
      state.busy = Math.max(0, state.busy - 1);
      if (!state.hover) maybeCollapseLater(900);
    }
  }

  /* ───────────────────────── чат с Gemini ───────────────────────── */

  const DEFAULT_MODEL = 'gemini-flash-latest';
  const SYSTEM_PROMPT = 'Ты помощник в небольшой шторке на рабочем столе. Отвечай на языке пользователя, по делу и без лишней воды. Для кода используй блоки с тремя обратными кавычками.';

  const cfg = {
    get key() { return store.get('gemKey', ''); },
    get model() { return store.get('gemModel', DEFAULT_MODEL); },
  };
  let chat = store.get('chat', []);   // [{role:'user'|'model'|'err', text}]
  let chatAbort = null;

  function mdInline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }
  function md(src) {
    return String(src)
      .split('```')
      .map((part, i) => (i % 2
        ? `<pre><code>${esc(part.replace(/^[\w+#.-]*\n/, ''))}</code></pre>`
        : mdInline(esc(part))))
      .join('');
  }

  const msgsEl = $('#msgs');

  function nearBottom() {
    return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  }
  function scrollDown() { msgsEl.scrollTop = msgsEl.scrollHeight; }

  function renderChat() {
    if (!chat.length) {
      msgsEl.innerHTML = cfg.key
        ? '<div class="empty"><b>Чем помочь?</b>Это обычный Gemini, только прямо в шторке.</div>'
        : '<div class="empty"><b>Нужен ключ Gemini API</b>Нажмите «Ключ и модель» внизу и вставьте ключ из Google AI Studio.</div>';
      return;
    }
    msgsEl.innerHTML = chat
      .map((m, i) => `<div class="msg ${m.role === 'user' ? 'user' : m.role === 'err' ? 'err' : ''}" data-i="${i}">${md(m.text)}</div>`)
      .join('');
    scrollDown();
  }

  function parseApiError(status, bodyText) {
    let msg = '';
    try { msg = JSON.parse(bodyText).error.message || ''; } catch { msg = bodyText || ''; }
    const low = msg.toLowerCase();
    if (low.includes('location is not supported') || low.includes('not available in your')) {
      return 'Gemini API недоступен в вашем регионе. Список стран есть на ai.google.dev (Available regions).';
    }
    if (status === 400 && low.includes('api key')) return 'Ключ не принят. Проверьте, что вставили его целиком.';
    if (status === 403) return 'Доступ запрещён (403). Проверьте ключ и включён ли доступ к Gemini API. ' + msg;
    if (status === 404) return `Модель «${cfg.model}» не найдена. Поменяйте её в «Ключ и модель». ` + msg;
    if (status === 429) return 'Превышен лимит запросов или бесплатная квота. Подождите минуту или включите оплату в AI Studio.';
    return `Ошибка ${status}: ${msg || 'без описания'}`;
  }

  async function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || chatAbort) return;
    if (!cfg.key) { openChatSetup(); return; }

    chat.push({ role: 'user', text });
    chat.push({ role: 'model', text: '' });
    input.value = '';
    autoGrow();
    renderChat();
    const botEl = msgsEl.lastElementChild;
    botEl.classList.add('typing');
    setSending(true);

    const history = chat
      .slice(0, -1)
      .filter((m) => m.role === 'user' || m.role === 'model')
      .slice(-24)
      .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

    chatAbort = new AbortController();
    const doFetch = (T && T.http && T.http.fetch) ? T.http.fetch : window.fetch.bind(window);
    const model = cfg.model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    let got = '';
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: history,
        }),
        signal: chatAbort.signal,
      });
      if (!res.ok) throw new Error(parseApiError(res.status, await res.text()));

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let blocked = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.promptFeedback && obj.promptFeedback.blockReason) blocked = obj.promptFeedback.blockReason;
          const parts = (obj.candidates && obj.candidates[0] && obj.candidates[0].content && obj.candidates[0].content.parts) || [];
          for (const p of parts) {
            if (p.text) {
              got += p.text;
              const stick = nearBottom();
              chat[chat.length - 1].text = got;
              botEl.innerHTML = md(got);
              if (stick) scrollDown();
            }
          }
        }
      }
      if (!got) throw new Error(blocked ? `Запрос заблокирован Gemini (${blocked}).` : 'Gemini вернул пустой ответ.');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (!got) chat.pop();
      } else {
        const msg = (e && e.message) ? e.message : String(e);
        if (got) {
          chat.push({ role: 'err', text: msg });
        } else {
          chat[chat.length - 1] = { role: 'err', text: msg };
        }
      }
    } finally {
      chatAbort = null;
      setSending(false);
      store.set('chat', chat.slice(-60));
      renderChat();
    }
  }

  function setSending(on) {
    $('#chat-send').hidden = on;
    $('#chat-stop').hidden = !on;
  }

  function autoGrow() {
    const t = $('#chat-input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }

  function openChatSetup() {
    $('#key-input').value = cfg.key;
    $('#model-input').value = cfg.model;
    $('#chat-setup').hidden = false;
    $('#key-input').focus();
  }

  $('#chat-input').addEventListener('input', autoGrow);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-stop').addEventListener('click', () => { if (chatAbort) chatAbort.abort(); });
  $('#chat-new').addEventListener('click', () => {
    if (chatAbort) chatAbort.abort();
    chat = [];
    store.set('chat', chat);
    renderChat();
    $('#chat-input').focus();
  });
  $('#chat-site').addEventListener('click', () => safe('open_target', { target: 'https://gemini.google.com/app' }));
  $('#chat-settings').addEventListener('click', openChatSetup);
  $('#key-get').addEventListener('click', () => safe('open_target', { target: 'https://aistudio.google.com/apikey' }));
  $('#key-cancel').addEventListener('click', () => { $('#chat-setup').hidden = true; });
  $('#key-save').addEventListener('click', () => {
    store.set('gemKey', $('#key-input').value.trim());
    store.set('gemModel', $('#model-input').value.trim() || DEFAULT_MODEL);
    $('#chat-setup').hidden = true;
    renderChat();
    toast('Сохранено');
  });

  /* ───────────────────────── задачи ───────────────────────── */

  let tasks = store.get('tasks', []);   // {id, text, done, due}

  function fmtDue(due) {
    const d = new Date(due);
    if (isNaN(d)) return '';
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return same ? `сегодня, ${hm}` : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm;
  }

  const EMPTY_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>';

  function sortedTasks() {
    return [...tasks].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.due && b.due) return new Date(a.due) - new Date(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
  }

  function renderTasks(freshId) {
    const list = $('#task-list');
    const sorted = sortedTasks();
    if (!sorted.length) {
      list.innerHTML = `<li class="empty">${EMPTY_ICON}<span>Всё сделано — задач нет</span></li>`;
    } else {
      list.innerHTML = sorted.map((t) => {
        const late = t.due && !t.done && new Date(t.due) < new Date();
        return `<li class="${t.done ? 'done' : ''}${t.id === freshId ? ' in' : ''}" data-id="${t.id}">
          <button class="chk" title="Готово"></button>
          <span class="txt">${esc(t.text)}</span>
          ${t.due ? `<span class="due ${late ? 'late' : ''}">${esc(fmtDue(t.due))}</span>` : ''}
          <button class="del" title="Удалить">×</button>
        </li>`;
      }).join('');
    }
    updateTaskMeta();
    store.set('tasks', tasks);
  }

  function updateTaskMeta() {
    const open = tasks.filter((t) => !t.done).length;
    $('#task-count').textContent = tasks.length ? `Осталось: ${open} из ${tasks.length}` : 'Пока пусто';
    const badge = $('#tasks-badge');
    badge.hidden = open === 0;
    badge.textContent = open;
    moveIndicator(true);   // ширина вкладки «Задачи» меняется вместе с бейджем
  }

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#task-text').value.trim();
    if (!text) return;
    const t = { id: uid(), text, done: false, due: $('#task-due').value || null };
    tasks.push(t);
    $('#task-text').value = '';
    $('#task-due').value = '';
    renderTasks(t.id);
    $('#task-text').focus();
  });

  let resortT;
  $('#task-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const t = tasks.find((x) => x.id === li.dataset.id);
    if (!t) return;
    if (e.target.closest('.chk')) {
      // галочка проигрывается на месте, а пересортировка — чуть позже, чтобы строки не прыгали
      t.done = !t.done;
      li.classList.toggle('done', t.done);
      store.set('tasks', tasks);
      updateTaskMeta();
      clearTimeout(resortT);
      resortT = setTimeout(() => renderTasks(), 650);
    } else if (e.target.closest('.del')) {
      tasks = tasks.filter((x) => x.id !== t.id);
      store.set('tasks', tasks);
      updateTaskMeta();
      li.classList.add('out');
      setTimeout(() => renderTasks(), 300);
    }
  });
  $('#task-clear').addEventListener('click', () => {
    tasks = tasks.filter((t) => !t.done);
    renderTasks();
  });

  /* ───────────────────────── нагрузка ───────────────────────── */

  const cpuHist = [], downHist = [], upHist = [];
  const HIST = 60;
  const RING = 263.9;

  const fmtBytes = (n) => {
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  };
  const fmtRate = (n) => fmtBytes(n) + '/с';
  const level = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'hot' : '');

  function setRing(el, pct) {
    const p = Math.max(0, Math.min(100, pct));
    el.style.strokeDashoffset = String(RING * (1 - p / 100));
    el.setAttribute('class', ('fg ' + level(p)).trim());
  }

  /** Плавная кривая по точкам истории; последняя точка — у правого края */
  function drawChart(svg, hist, max, w, h) {
    if (!svg || !hist.length) return;
    const step = w / (HIST - 1);
    const pts = hist.map((v, i) => [w - (hist.length - 1 - i) * step, h - 3 - (Math.min(v, max) / max) * (h - 8)]);
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
      d += ` Q ${pts[i - 1][0].toFixed(1)} ${pts[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` T ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
    svg.querySelector('.line').setAttribute('d', d);
    svg.querySelector('.area').setAttribute('d', `${d} L ${last[0].toFixed(1)} ${h} L ${pts[0][0].toFixed(1)} ${h} Z`);
  }

  const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };

  function onStats(s) {
    push(cpuHist, s.cpu);
    push(downHist, s.net_down);
    push(upHist, s.net_up);
    if (!state.open || state.tab !== 'stats') return;

    const ramPct = s.mem_total ? (s.mem_used / s.mem_total) * 100 : 0;
    $('#st-cpu').textContent = Math.round(s.cpu) + '%';
    setRing($('#st-cpu-ring'), s.cpu);
    drawChart($('#st-spark'), cpuHist, 100, 300, 90);

    $('#st-ram').textContent = Math.round(ramPct) + '%';
    setRing($('#st-ram-ring'), ramPct);
    $('#st-ram-sub').innerHTML = `${esc(fmtBytes(s.mem_used))}<br>из ${esc(fmtBytes(s.mem_total))}`;

    $('#st-down').textContent = fmtRate(s.net_down);
    $('#st-up').textContent = fmtRate(s.net_up);
    drawChart($('#st-net-down'), downHist, Math.max(50e3, ...downHist), 300, 60);
    drawChart($('#st-net-up'), upHist, Math.max(50e3, ...upHist), 300, 60);

    $('#st-disks').innerHTML = s.disks.map((d) => {
      const p = d.total ? (d.used / d.total) * 100 : 0;
      return `<div class="disk"><div class="top2"><b>${esc(d.name)}</b><span>${fmtBytes(d.used)} из ${fmtBytes(d.total)} · ${p.toFixed(0)}%</span></div><div class="bar"><i class="${level(p)}" style="width:${p.toFixed(0)}%"></i></div></div>`;
    }).join('') || '<span class="hint">Нет данных</span>';

    const list = (arr, key, fmt) => {
      const mx = Math.max(1e-9, ...arr.map((p) => p[key]));
      return arr.map((p) => `<li><span>${esc(p.name)}</span><span>${fmt(p[key])}</span><div class="mb"><i style="width:${((p[key] / mx) * 100).toFixed(0)}%"></i></div></li>`).join('');
    };
    $('#st-top-cpu').innerHTML = list(s.top_cpu, 'cpu', (v) => v.toFixed(1) + '%');
    $('#st-top-mem').innerHTML = list(s.top_mem, 'mem', fmtBytes);
  }

  $('#top-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#top-seg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#st-top-cpu').hidden = b.dataset.top !== 'cpu';
    $('#st-top-mem').hidden = b.dataset.top !== 'mem';
  });

  /* Опрос идёт только пока открыта вкладка «Нагрузка» — в свёрнутом виде приложение почти ничего не потребляет */
  let pollT;
  async function poll() {
    clearTimeout(pollT);
    if (state.open && state.tab === 'stats') {
      const s = await safe('get_stats', { full: true });
      if (s) onStats(s);
    } else if (state.open && state.tab === 'control') {
      await refreshMedia();
    }
    pollT = setTimeout(poll, 1000);
  }
  function pollNow() { clearTimeout(pollT); poll(); }

  function tickClock() {
    const now = new Date();
    $('#hdr-time').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    $('#hdr-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  }

  /* ───────────────────────── обои: карусель ───────────────────────── */

  let wpItems = [];
  let wpIndex = 0;
  let wpLoadedFor = null;

  async function defaultPicturesDir() {
    try { return await T.path.pictureDir(); } catch { return null; }
  }

  /** Раскладывает карточки: центральная большая, соседние узкие и скошенные */
  function layoutWp() {
    const cards = $$('#wp-grid .wp');
    if (!cards.length) { $('#wp-name').textContent = ''; return; }
    const stage = $('#wp-stage');
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const cw = Math.max(0, Math.min(W * 0.42, H * 1.5, 600));   // ширина центральной
    const ch = Math.min(cw * 0.625, H * 0.94);                   // 16:10, но не выше сцены
    const sw = cw * 0.3;                                         // ширина боковых
    const gap = Math.max(10, cw * 0.035);

    cards.forEach((el, i) => {
      const d = i - wpIndex;
      const a = Math.abs(d);
      const s = Math.sign(d);
      const near = a <= 5;
      if (near && !el.dataset.loaded) {
        el.firstElementChild.src = el.dataset.src;
        el.dataset.loaded = '1';
      }
      const x = a === 0 ? 0 : s * (cw / 2 + gap + (a - 1) * (sw + gap) + sw / 2);
      el.style.width = (a === 0 ? cw : sw) + 'px';
      el.style.height = (a === 0 ? ch : ch * 0.88) + 'px';
      el.style.transform = `translate(-50%, -50%) translateX(${x.toFixed(1)}px) skewX(${a === 0 ? 0 : s * 7}deg)`;
      el.style.opacity = near ? String(Math.max(0.2, 1 - a * 0.2)) : '0';
      el.style.filter = a === 0 ? 'none' : `brightness(${Math.max(0.35, 0.72 - a * 0.08)})`;
      el.style.zIndex = String(20 - a);
      el.style.pointerEvents = near ? 'auto' : 'none';
      el.classList.toggle('center', a === 0);
    });
    $('#wp-name').textContent = wpItems[wpIndex] ? wpItems[wpIndex].name : '';
  }

  function wpSetIndex(i) {
    if (!wpItems.length) return;
    wpIndex = Math.max(0, Math.min(wpItems.length - 1, i));
    layoutWp();
  }

  const ALBUMS = {
    landscapes: 'Пейзажи', sea: 'Море', space: 'Космос',
    geometry: 'Геометрия', textures: 'Текстуры', colors: 'Цвета',
  };
  const WP_NAMES = {
    'landscapes-aurora': 'Полярное сияние', 'landscapes-dunes': 'Закат в дюнах', 'landscapes-mist': 'Горы в тумане',
    'landscapes-moonpath': 'Лунная дорожка', 'sea-deep': 'Глубина', 'sea-lagoon': 'Лагуна', 'sea-sunset': 'Закат над морем',
    'space-galaxy': 'Млечный Путь', 'space-nebula': 'Туманность', 'space-planet': 'Горизонт планеты',
    'geometry-orbs': 'Градиентные сферы', 'geometry-rings': 'Кольца', 'geometry-synthwave': 'Синтвейв', 'geometry-triangles': 'Треугольники',
    'textures-marble': 'Мрамор', 'textures-paper': 'Бумага', 'textures-waves': 'Волны',
    'colors-ember': 'Янтарь', 'colors-forest': 'Лес', 'colors-graphite': 'Графит', 'colors-light': 'Пастель',
    'colors-lilac': 'Сирень', 'colors-sand': 'Песок',
  };
  let wpSource = store.get('wpSource', 'bundled');   // 'bundled' | 'folder'
  let wpAlbum = store.get('wpAlbum', 'all');
  let wpAll = [];

  function syncWpSource() {
    $$('#wp-src button').forEach((b) => b.classList.toggle('on', b.dataset.src === wpSource));
    $('#wp-pick').hidden = wpSource !== 'folder';
    $('#wp-albums').hidden = wpSource !== 'bundled';
  }

  function renderAlbums() {
    const keys = ['all', ...Object.keys(ALBUMS).filter((k) => wpAll.some((w) => w.album === k))];
    if (!keys.includes(wpAlbum)) wpAlbum = 'all';
    $('#wp-albums').innerHTML = keys
      .map((k) => `<button data-album="${k}" class="${k === wpAlbum ? 'on' : ''}">${k === 'all' ? 'Все' : ALBUMS[k]}</button>`).join('');
  }

  /** Строит карусель из wpAll с учётом выбранного альбома */
  function renderWpGrid() {
    const grid = $('#wp-grid');
    wpItems = wpSource === 'bundled' && wpAlbum !== 'all' ? wpAll.filter((w) => w.album === wpAlbum) : wpAll;
    $('#wp-count').textContent = `${wpItems.length} ${plural(wpItems.length, ['картинка', 'картинки', 'картинок'])}`;
    if (!wpItems.length) {
      grid.innerHTML = '<div class="empty">В этой папке нет картинок jpg, png или bmp</div>';
      return;
    }
    const cur = store.get('wpCurrent', '');
    grid.innerHTML = wpItems.map((w, i) => {
      const src = T.core.convertFileSrc(w.path);
      return `<button class="wp ${w.path === cur ? 'cur' : ''}" data-i="${i}" data-src="${esc(src)}" title="${esc(w.name)}"><img decoding="async" alt=""></button>`;
    }).join('');
    const at = wpItems.findIndex((w) => w.path === cur);
    wpIndex = at >= 0 ? at : 0;
    layoutWp();
  }

  async function loadWallpapers(force) {
    syncWpSource();
    const grid = $('#wp-grid');
    const key = wpSource === 'bundled' ? 'bundled' : (store.get('wpFolder', null) || (await defaultPicturesDir()));
    $('#wp-folder').textContent = wpSource === 'bundled' ? '' : (key || 'Папка не выбрана');
    if (!key) {
      wpAll = []; wpItems = [];
      $('#wp-count').textContent = '0';
      grid.innerHTML = '<div class="empty">Нажмите «Папка…» и выберите папку с картинками (jpg, png, bmp)</div>';
      return;
    }
    if (!force && wpLoadedFor === key) { layoutWp(); return; }
    try {
      wpAll = wpSource === 'bundled'
        ? await invoke('list_bundled_wallpapers')
        : await invoke('list_wallpapers', { folder: key });
      if (wpSource === 'bundled') {
        wpAll.forEach((w) => {
          w.album = String(w.name).split('-')[0];
          w.name = WP_NAMES[w.name] || w.name;
        });
        renderAlbums();
      }
      wpLoadedFor = key;
    } catch (e) {
      wpAll = []; wpItems = [];
      wpLoadedFor = null;
      $('#wp-count').textContent = '0';
      grid.innerHTML = `<div class="empty">${esc(String(e))}</div>`;
      return;
    }
    renderWpGrid();
  }

  $('#wp-albums').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    wpAlbum = b.dataset.album;
    store.set('wpAlbum', wpAlbum);
    renderAlbums();
    renderWpGrid();
  });

  $('#wp-src').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.src === wpSource) return;
    wpSource = b.dataset.src;
    store.set('wpSource', wpSource);
    loadWallpapers(true);
  });

  async function applyWallpaper(item) {
    if (!item) return;
    try {
      await invoke('set_wallpaper', { path: item.path });
      store.set('wpCurrent', item.path);
      $$('#wp-grid .wp').forEach((b) => b.classList.toggle('cur', wpItems[+b.dataset.i] === item));
      toast('Обои установлены');
    } catch (e) {
      toast(String(e), true);
    }
  }

  $('#wp-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.wp');
    if (!b) return;
    const i = +b.dataset.i;
    if (i === wpIndex) applyWallpaper(wpItems[i]);   // по центральной — поставить
    else wpSetIndex(i);                              // по боковой — выдвинуть в центр
  });

  let wheelAt = 0;
  $('#wp-stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt < 110) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 4) return;
    wheelAt = now;
    wpSetIndex(wpIndex + (d > 0 ? 1 : -1));
  }, { passive: false });

  if (window.ResizeObserver) new ResizeObserver(() => layoutWp()).observe($('#wp-stage'));

  $('#wp-random').addEventListener('click', () => {
    if (!wpItems.length) { toast('Нет картинок для выбора', true); return; }
    const i = Math.floor(Math.random() * wpItems.length);
    wpSetIndex(i);
    applyWallpaper(wpItems[i]);
  });
  $('#wp-pick').addEventListener('click', () => withBusy(async () => {
    try {
      const dir = await T.dialog.open({ directory: true, multiple: false, title: 'Папка с обоями' });
      if (dir) {
        store.set('wpFolder', dir);
        await loadWallpapers(true);
      }
    } catch (e) { toast(String(e), true); }
  }));

  /* ───────────────────────── управление ───────────────────────── */

  const setFill = (el) => {
    const min = +el.min || 0, max = +el.max || 100;
    el.style.setProperty('--v', ((el.value - min) / (max - min)) * 100 + '%');
  };
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /* громкость */
  const volEl = $('#vol-range');
  const VOL_ICO = {
    on: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/>',
    off: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  };
  let volMuted = false, volDragging = false, volSendT, volSetAt = 0;

  function paintVol(level, muted) {
    volMuted = muted;
    volEl.value = Math.round(level * 100);
    setFill(volEl);
    $('#vol-val').textContent = muted ? 'Звук выключен' : Math.round(level * 100) + '%';
    $('#vol-ico').innerHTML = muted || level === 0 ? VOL_ICO.off : VOL_ICO.on;
    $('#vol-mute').classList.toggle('off', muted);
  }

  volEl.addEventListener('input', () => {
    volDragging = true;
    setFill(volEl);
    $('#vol-val').textContent = volEl.value + '%';
    clearTimeout(volSendT);
    volSendT = setTimeout(async () => {
      volSetAt = Date.now();
      try {
        await invoke('set_volume', { level: volEl.value / 100 });
        if (volMuted) { await invoke('set_mute', { muted: false }); volMuted = false; }
        paintVol(volEl.value / 100, false);
      } catch (e) { toast(String(e), true); }
    }, 40);
  });
  volEl.addEventListener('change', () => { volDragging = false; });
  $('#vol-mute').addEventListener('click', async () => {
    try {
      await invoke('set_mute', { muted: !volMuted });
      paintVol(volEl.value / 100, !volMuted);
    } catch (e) { toast(String(e), true); }
  });

  /* Wi-Fi и Bluetooth */
  const radioUi = {
    wifi: { btn: '#tg-wifi', sub: '#tg-wifi-s', settings: 'ms-settings:network-wifi' },
    bluetooth: { btn: '#tg-bt', sub: '#tg-bt-s', settings: 'ms-settings:bluetooth' },
  };
  function paintRadio(kind, on) {
    const u = radioUi[kind];
    $(u.btn).classList.toggle('on', !!on);
    $(u.sub).textContent = on === null ? 'Нет адаптера' : on ? 'Включён' : 'Выключен';
    $(u.btn).disabled = on === null;
  }
  async function refreshRadios() {
    const list = await safe('get_radios');
    const seen = {};
    (list || []).forEach((r) => { seen[r.kind] = r.on; });
    paintRadio('wifi', 'wifi' in seen ? seen.wifi : null);
    paintRadio('bluetooth', 'bluetooth' in seen ? seen.bluetooth : null);
  }
  $$('[data-radio]').forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.radio;
    const want = !b.classList.contains('on');
    paintRadio(kind, want);
    try {
      await invoke('set_radio', { kind, on: want });
    } catch (e) {
      paintRadio(kind, !want);
      toast(String(e), true);
      return;
    }
    setTimeout(refreshRadios, 700);
  }));
  $$('[data-radio]').forEach((b) => b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    safe('open_target', { target: radioUi[b.dataset.radio].settings });
  }));

  /* тема Windows */
  let themeLight = false;
  function paintTheme(light) {
    themeLight = light;
    $('#tg-theme').classList.toggle('on', light);
    $('#tg-theme-t').textContent = light ? 'Светлая тема' : 'Тёмная тема';
    $('#theme-ico').innerHTML = light
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'
      : '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>';
  }
  $('#tg-theme').addEventListener('click', async () => {
    const want = !themeLight;
    paintTheme(want);
    try { await invoke('set_theme_light', { light: want }); }
    catch (e) { paintTheme(!want); toast(String(e), true); }
  });

  /* ночной режим */
  const nightEl = $('#night-range');
  let nightOn = store.get('nightOn', false);
  nightEl.value = store.get('nightLevel', 60);
  function paintNight() {
    setFill(nightEl);
    $('#tg-night').classList.toggle('on', nightOn);
    $('#tg-night-s').textContent = nightOn ? `Включён · ${nightEl.value}%` : 'Выключен';
  }
  async function applyNight() {
    paintNight();
    store.set('nightLevel', +nightEl.value);
    try { await invoke('set_night', { strength: nightOn ? nightEl.value / 100 : 0 }); }
    catch (e) { nightOn = false; store.set('nightOn', false); paintNight(); toast(String(e), true); }
  }
  let nightT;
  nightEl.addEventListener('input', () => {
    nightOn = true;
    store.set('nightOn', true);
    store.set('nightLevel', +nightEl.value);
    paintNight();
    clearTimeout(nightT);
    nightT = setTimeout(applyNight, 50);
  });
  $('#tg-night').addEventListener('click', () => {
    nightOn = !nightOn;
    store.set('nightOn', nightOn);
    applyNight();
  });

  /* плеер (то, что играет в Windows: Spotify, браузер, проигрыватель и т.д.) */
  let mediaKey = '', mediaBusy = false;
  function paintMedia(m) {
    const root = $('.t-media');
    root.classList.toggle('idle', !m);
    $('#m-prev').disabled = !m || !m.can_prev;
    $('#m-next').disabled = !m || !m.can_next;
    $('#m-play').disabled = !m;
    if (!m) {
      $('#m-title').textContent = 'Ничего не играет';
      $('#m-artist').textContent = 'Запустите музыку или видео';
      $('#m-app').textContent = 'Плейлист';
      $('#m-bar').style.width = '0';
      $('#m-pos').textContent = $('#m-dur').textContent = '0:00';
      $('#m-play-ico').innerHTML = '<path d="M8 5.5v13l11-6.5z"/>';
      mediaKey = '';
      setCover(null);
      return;
    }
    $('#m-title').textContent = m.title || 'Без названия';
    $('#m-artist').textContent = m.artist || '';
    $('#m-app').textContent = (m.app || 'Плейлист').replace(/\.exe$/i, '');
    $('#m-play-ico').innerHTML = m.playing
      ? '<path d="M8 5.5v13M16 5.5v13" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>'
      : '<path d="M8 5.5v13l11-6.5z"/>';
    const pct = m.duration > 0 ? Math.min(100, (m.position / m.duration) * 100) : 0;
    $('#m-bar').style.width = pct + '%';
    $('#m-pos').textContent = fmtTime(m.position);
    $('#m-dur').textContent = m.duration > 0 ? '-' + fmtTime(m.duration - m.position) : '';
    const key = (m.title || '') + '|' + (m.artist || '');
    if (key !== mediaKey) {
      mediaKey = key;
      setCover(null);
      safe('media_thumb').then((uri) => { if (mediaKey === key) setCover(uri); });
    }
  }
  function setCover(uri) {
    const c = $('#m-cover');
    c.style.backgroundImage = uri ? `url("${uri}")` : '';
    c.classList.toggle('has', !!uri);
  }
  async function refreshMedia() {
    if (mediaBusy) return;
    mediaBusy = true;
    try { paintMedia(await safe('media_state')); }
    finally { mediaBusy = false; }
  }
  const mediaCmd = (cmd) => async () => {
    try { await invoke('media_cmd', { cmd }); } catch (e) { toast(String(e), true); }
    setTimeout(refreshMedia, 250);
  };
  $('#m-play').addEventListener('click', mediaCmd('toggle'));
  $('#m-prev').addEventListener('click', mediaCmd('prev'));
  $('#m-next').addEventListener('click', mediaCmd('next'));

  async function refreshControls() {
    const [v] = await Promise.all([safe('get_volume'), refreshRadios(), refreshMedia()]);
    if (v && !volDragging && Date.now() - volSetAt > 600) paintVol(v.level, v.muted);
    const th = await safe('get_theme_light');
    if (th !== null) paintTheme(!!th);
  }

  /* ───────────────────────── приложения ───────────────────────── */

  let apps = store.get('apps', []);   // {id, name, path}

  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function renderApps() {
    const grid = $('#app-grid');
    if (!apps.length) {
      grid.innerHTML = '<div class="empty">Пока пусто. Добавьте программы или ярлыки — они будут запускаться в один клик.</div>';
    } else {
      grid.innerHTML = apps.map((a) => `
        <button class="app" data-id="${a.id}" title="${esc(a.path)}">
          <span class="ico" style="background:hsl(${hue(a.name)} 70% 74%)">${esc([...a.name][0] || '?').toUpperCase()}</span>
          <span class="nm">${esc(a.name)}</span>
        </button>`).join('');
    }
    store.set('apps', apps);
  }

  $('#app-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('.app');
    if (!b) return;
    const a = apps.find((x) => x.id === b.dataset.id);
    if (!a) return;
    try {
      await invoke('open_target', { target: a.path });
    } catch (err) { toast(String(err), true); }
  });
  $('#app-grid').addEventListener('contextmenu', async (e) => {
    const b = e.target.closest('.app');
    if (!b) return;
    e.preventDefault();
    const a = apps.find((x) => x.id === b.dataset.id);
    if (a && await confirmDialog(`Убрать «${a.name}» из шторки? Сама программа останется на месте.`, 'Убрать')) {
      apps = apps.filter((x) => x.id !== a.id);
      renderApps();
    }
  });
  $('#app-add').addEventListener('click', () => withBusy(async () => {
    try {
      const picked = await T.dialog.open({
        multiple: true,
        title: 'Программа или ярлык',
        filters: [{ name: 'Программы и ярлыки', extensions: ['exe', 'lnk', 'bat', 'cmd', 'url'] }],
      });
      const list = !picked ? [] : Array.isArray(picked) ? picked : [picked];
      for (const p of list) {
        if (apps.some((a) => a.path === p)) continue;
        const file = p.split(/[\\/]/).pop() || p;
        apps.push({ id: uid(), name: file.replace(/\.[^.]+$/, ''), path: p });
      }
      renderApps();
    } catch (e) { toast(String(e), true); }
  }));

  /* ───────────────────────── питание ───────────────────────── */

  $$('.power').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.power;
    if (b.dataset.confirm && !(await confirmDialog(b.dataset.confirm))) return;
    try {
      await invoke('power_action', { action });
    } catch (e) { toast(String(e), true); }
  }));

  /* ───────────────────────── старт ───────────────────────── */

  renderChat();
  renderTasks();
  renderApps();
  paintNight();
  if (nightOn) applyNight();
  tickClock();
  setInterval(tickClock, 15000);
  setInterval(() => { if (state.open && state.tab === 'tasks') renderTasks(); }, 30000);
  window.addEventListener('resize', () => { moveIndicator(true); layoutWp(); });
  poll();
})();
