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
  const SIZES = { normal: [940, 560], wide: [0, 620] };

  const state = {
    open: false,
    pinned: false,
    wide: store.get('wide', false),
    tab: ['control', 'chat', 'notes', 'stats', 'wallpaper', 'apps', 'power'].includes(store.get('tab', 'control')) ? store.get('tab', 'control') : 'control',
    busy: 0,          // >0 — открыт диалог, сворачиваться нельзя
    hover: false,
    cooldown: 0,
  };

  const shell = $('#shell');

  /* ───────────────────────── раскрытие / сворачивание ───────────────────────── */

  let hoverT, leaveT, collapseT;

  /* Окно всегда одного размера и «прозрачно» для мыши, пока шторка свёрнута (set_open).
     Раскрытие — только анимация внутри окна, поэтому оно плавное. */
  function expand() {
    if (state.open) return;
    clearTimeout(collapseT);
    state.open = true;
    state.hover = true;                      // раскрылись, потому что мышь на язычке
    safe('set_open', { open: true });
    onOpened();
    requestAnimationFrame(() => shell.classList.add('open'));
    maybeCollapseLater(2500);                // страховка: открыли и тут же ушли
  }

  function collapse(force = false) {
    if (!state.open) return;
    if (!force && (state.pinned || state.busy > 0)) return;
    if (force) setPinned(false);
    state.open = false;
    shell.classList.remove('open');
    clearTimeout(collapseT);
    // после анимации сжатия окно снова пропускает клики сквозь себя
    collapseT = setTimeout(() => {
      if (!state.open) safe('set_open', { open: false });
      state.cooldown = Date.now() + 500;
    }, 520);
  }

  async function applySize() {
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

  // Курсор над видимой частью шторки? (по области clip-path; нужно, когда браузер не прислал mouseenter)
  document.addEventListener('mousemove', (e) => {
    if (!state.open || !document.elementFromPoint) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const inside = !!(el && el.closest && el.closest('#shell'));
    if (inside !== state.hover) {
      state.hover = inside;
      if (inside) clearTimeout(leaveT); else maybeCollapseLater();
    }
  });

  // Язычок ловит наведение в Rust (пока окно прозрачно для мыши)
  if (T && T.event && T.event.listen) {
    T.event.listen('pill-hover', () => { if (!state.open && Date.now() >= state.cooldown) expand(); });
  }

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
  if (state.wide) applySize();

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
    // тяжёлое — после того, как вкладка уже показана
    setTimeout(() => {
      if (state.tab !== name) return;
      if (name === 'wallpaper') loadWallpapers(false);
      if (name === 'control') refreshControls();
      if (name === 'chat') $('#chat-input').focus();
      if (name === 'stats') pollNow();
    }, 30);
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

  /* ───────────────────────── прокси для Gemini ───────────────────────── */

  function normProxy(raw) {
    raw = String(raw || '').trim();
    if (!raw) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;
    return raw;
  }
  function proxyConfig() {
    if (!store.get('proxyOn', false)) return null;
    const u = normProxy(store.get('proxyUrl', ''));
    return u ? { all: u } : null;
  }
  const proxyHost = (u) => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '').replace(/\/.*$/, '');

  /* ───────────────────────── чат с Gemini ───────────────────────── */

  const DEFAULT_MODEL = 'gemini-flash-latest';
  const SYSTEM_PROMPT = 'Ты помощник в небольшой шторке на рабочем столе. Отвечай на языке пользователя, по делу и без лишней воды. Для кода используй блоки с тремя обратными кавычками.';
  const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  // сколько ждать ответа; для тестов можно подменить
  const WAIT = (window.__shTest && window.__shTest.wait) || { first: 25000, chunk: 40000, plain: 60000 };

  const cfg = {
    get key() { return store.get('gemKey', ''); },
    get model() { return store.get('gemModel', DEFAULT_MODEL); },
  };

  /* Несколько чатов: список слева, как в Gemini */
  let chats = store.get('chats', null);
  if (!chats) {
    const old = store.get('chat', []);   // прежний единственный чат
    chats = old.length ? [{ id: uid(), title: (old.find((m) => m.role === 'user') || { text: 'Чат' }).text.slice(0, 40), ts: Date.now(), msgs: old }] : [];
  }
  let chatId = chats.length ? chats[0].id : null;
  let chat = chats.length ? chats[0].msgs : [];   // сообщения открытого чата
  let chatAbort = null;
  const saveChats = () => store.set('chats', chats.slice(0, 40).map((c) => ({ ...c, msgs: c.msgs.slice(-80) })));

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
  const nearBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  const scrollDown = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };

  const SUGGEST = [
    ['Объясни простыми словами', 'Объясни простыми словами, как работает интернет'],
    ['Составь план на день', 'Составь план продуктивного дня'],
    ['Помоги с кодом', 'Помоги разобраться с кодом: '],
    ['Переведи на английский', 'Переведи на английский: '],
  ];

  function renderChatList() {
    const list = $('#chat-list');
    if (!chats.length) { list.innerHTML = '<div class="n-empty">Чатов пока нет</div>'; return; }
    list.innerHTML = chats.map((c) => `
      <div class="c-row${c.id === chatId ? ' on' : ''}" data-id="${c.id}">
        <span class="ellipsis">${esc(c.title || 'Новый чат')}</span>
        <button class="c-del" title="Удалить чат">×</button>
      </div>`).join('');
    const cur = chats.find((c) => c.id === chatId);
    $('#chat-title').textContent = cur ? (cur.title || 'Новый чат') : 'Новый чат';
  }

  function renderChat() {
    $('#chat-model').textContent = cfg.model.replace(/^models\//, '');
    if (!chat.length) {
      msgsEl.innerHTML = cfg.key
        ? `<div class="empty"><div class="spark"></div><b>Чем помочь?</b><span>Это настоящий Gemini, только прямо в шторке.</span>
            <div class="sugg">${SUGGEST.map((x, i) => `<button data-s="${i}">${esc(x[0])}</button>`).join('')}</div></div>`
        : '<div class="empty"><div class="spark"></div><b>Нужен ключ Gemini API</b><span>Нажмите на шестерёнку справа вверху и вставьте ключ из Google AI Studio.</span></div>';
      renderChatList();
      return;
    }
    msgsEl.innerHTML = chat
      .map((m, i) => `<div class="msg ${m.role === 'user' ? 'user' : m.role === 'err' ? 'err' : ''}" data-i="${i}">${md(m.text)}</div>`)
      .join('');
    scrollDown();
    renderChatList();
  }

  function selectChat(id) {
    if (chatAbort) return;           // пока идёт ответ, чат не переключаем
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    chatId = id;
    chat = c.msgs;
    renderChat();
  }

  function newChat() {
    if (chatAbort) return;
    const empty = chats.find((c) => !c.msgs.length);
    if (empty) { selectChat(empty.id); }
    else {
      const c = { id: uid(), title: 'Новый чат', ts: Date.now(), msgs: [] };
      chats.unshift(c);
      chatId = c.id;
      chat = c.msgs;
      saveChats();
      renderChat();
    }
    $('#chat-input').focus();
  }

  function parseApiError(status, bodyText) {
    let msg = '';
    try { msg = JSON.parse(bodyText).error.message || ''; } catch { msg = bodyText || ''; }
    const low = msg.toLowerCase();
    if (low.includes('location is not supported') || low.includes('not available in your')) {
      return proxyConfig()
        ? 'Gemini API недоступен в регионе вашего прокси. Возьмите прокси из страны, где Gemini работает (список на ai.google.dev, Available regions).'
        : 'Gemini API недоступен в вашем регионе. Подключите HTTP-прокси в «Управлении» (плитка «Прокси для Gemini») или выберите страну из списка на ai.google.dev (Available regions).';
    }
    if (status === 400 && low.includes('api key')) return 'Ключ не принят. Проверьте, что вставили его целиком.';
    if (status === 403) return 'Доступ запрещён (403). Проверьте ключ и включён ли доступ к Gemini API. ' + msg;
    if (status === 404) return `Модель «${cfg.model}» не найдена. Поменяйте её через шестерёнку. ` + msg;
    if (status === 429) return 'Превышен лимит запросов или бесплатная квота. Подождите минуту или включите оплату в AI Studio.';
    if (status === 503 || status === 500) return 'Серверы Gemini сейчас перегружены. Попробуйте через минуту или выберите другую модель в настройках (например, gemini-2.5-flash).';
    return `Ошибка ${status}: ${msg || 'без описания'}`;
  }

  function humanizeError(e) {
    const m = (e && e.message) ? e.message : String(e);
    if (m === 'TIMEOUT') {
      return proxyConfig()
        ? 'Gemini не ответил вовремя. Скорее всего, прокси не пропускает запросы или очень медленный: нажмите «Проверить» на плитке прокси в «Управлении».'
        : 'Gemini не ответил вовремя. Проверьте интернет; если сервис недоступен в вашей стране, подключите HTTP-прокси в «Управлении».';
    }
    if (/error sending request|failed to fetch|networkerror|connect|dns|tls|proxy/i.test(m)) {
      return proxyConfig()
        ? 'Не удалось соединиться с Gemini через прокси. Проверьте адрес, порт, логин и пароль прокси (плитка «Прокси для Gemini» в «Управлении», кнопка «Проверить»).'
        : 'Не удалось соединиться с Gemini. Проверьте интернет; если сервис недоступен в вашей стране, подключите HTTP-прокси в «Управлении».';
    }
    return m;
  }

  /** fetch с ограничением по времени; отмена пользователем тоже прерывает запрос */
  async function fetchLimited(url, opts, ms, userSignal) {
    const doFetch = (T && T.http && T.http.fetch) ? T.http.fetch : window.fetch.bind(window);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    const onUser = () => ctl.abort();
    userSignal.addEventListener('abort', onUser);
    try {
      return await doFetch(url, { ...opts, signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw new Error('TIMEOUT');
      throw e;
    } finally {
      clearTimeout(timer);
      userSignal.removeEventListener('abort', onUser);
    }
  }

  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  async function sendChat(textOverride) {
    const input = $('#chat-input');
    const text = (typeof textOverride === 'string' ? textOverride : input.value).trim();
    if (!text || chatAbort) return;
    if (!cfg.key) { openChatSetup(); return; }

    // первое сообщение создаёт чат, если открытого нет
    if (!chatId || !chats.find((c) => c.id === chatId)) {
      const c = { id: uid(), title: 'Новый чат', ts: Date.now(), msgs: [] };
      chats.unshift(c);
      chatId = c.id;
      chat = c.msgs;
    }
    const cur = chats.find((c) => c.id === chatId);
    if (!cur.msgs.some((m) => m.role === 'user')) cur.title = text.replace(/\s+/g, ' ').slice(0, 40);
    cur.ts = Date.now();
    chats = [cur, ...chats.filter((c) => c !== cur)];   // свежий чат — наверх списка

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
    const abortSignal = chatAbort.signal;
    let model = encodeURIComponent(cfg.model.replace(/^models\//, ''));
    const px = proxyConfig();
    const common = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: history }),
      ...(px && T && T.http && T.http.fetch ? { proxy: px } : {}),
    };
    const partsOf = (obj) => (obj.candidates && obj.candidates[0] && obj.candidates[0].content && obj.candidates[0].content.parts) || [];
    const show = (got) => {
      const stick = nearBottom();
      chat[chat.length - 1].text = got;
      botEl.innerHTML = md(got);
      if (stick) scrollDown();
    };

    /** Потоковый ответ: слова появляются по мере генерации */
    async function viaStream() {
      const res = await fetchLimited(`${API}${model}:streamGenerateContent?alt=sse`, common, WAIT.first, abortSignal);
      if (!res.ok) throw Object.assign(new Error(parseApiError(res.status, await res.text())), { status: res.status });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', got = '', blocked = '', first = true;
      for (;;) {
        const { value, done } = await withTimeout(reader.read(), first ? WAIT.first : WAIT.chunk);
        first = false;
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
          for (const p of partsOf(obj)) if (p.text) { got += p.text; show(got); }
        }
        if (abortSignal.aborted) break;
      }
      if (!got && !abortSignal.aborted) throw new Error(blocked ? `Запрос заблокирован Gemini (${blocked}).` : 'Gemini вернул пустой ответ.');
      return got;
    }

    /** Запасной путь: целиком, без потока (если поток завис, например, из-за прокси) */
    async function viaPlain() {
      const res = await fetchLimited(`${API}${model}:generateContent`, common, WAIT.plain, abortSignal);
      if (!res.ok) throw Object.assign(new Error(parseApiError(res.status, await res.text())), { status: res.status });
      const obj = await res.json();
      const got = partsOf(obj).map((p) => p.text || '').join('');
      if (!got) {
        const why = obj.promptFeedback && obj.promptFeedback.blockReason;
        throw new Error(why ? `Запрос заблокирован Gemini (${why}).` : 'Gemini вернул пустой ответ.');
      }
      show(got);
      return got;
    }

    // Если модель перегружена (503) — пробуем ещё раз, затем запасные модели
    const FALLBACK = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'];
    const queue = [cfg.model.replace(/^models\//, ''), ...FALLBACK.filter((m) => m !== cfg.model.replace(/^models\//, ''))];
    const busy = (e) => e && (e.status === 503 || e.status === 500);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const attempt = async () => {
      try { return await viaStream(); }
      catch (e) {
        if (e && e.message === 'TIMEOUT' && !chat[chat.length - 1].text && !abortSignal.aborted) return viaPlain();
        throw e;
      }
    };
    let got = '';
    try {
      let lastErr = null;
      for (let qi = 0; qi < queue.length && !got; qi++) {
        model = encodeURIComponent(queue[qi]);
        for (let tryN = 0; tryN < (qi === 0 ? 2 : 1) && !got; tryN++) {
          try { got = await attempt(); lastErr = null; }
          catch (e) {
            lastErr = e;
            if (!busy(e) || abortSignal.aborted || chat[chat.length - 1].text) throw e;
            botEl.innerHTML = '<span class="note">Gemini перегружен, пробую ещё раз…</span>';
            await pause(tryN === 0 && qi === 0 ? 1200 : 300);
          }
        }
      }
      if (lastErr) throw lastErr;
    } catch (e) {
      const partial = chat[chat.length - 1].text;
      if (e && e.name === 'AbortError') {
        if (!partial) chat.pop();
      } else if (partial) {
        chat.push({ role: 'err', text: humanizeError(e) });
      } else {
        chat[chat.length - 1] = { role: 'err', text: humanizeError(e) };
      }
    } finally {
      chatAbort = null;
      setSending(false);
      saveChats();
      renderChat();
    }
    return got;
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
  $('#chat-send').addEventListener('click', () => sendChat());
  $('#chat-stop').addEventListener('click', () => { if (chatAbort) chatAbort.abort(); });
  $('#chat-new').addEventListener('click', newChat);
  $('#chat-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.c-row');
    if (!row) return;
    if (e.target.closest('.c-del')) {
      if (chatAbort) return;
      const c = chats.find((x) => x.id === row.dataset.id);
      if (!c || !(await confirmDialog(`Удалить чат «${c.title}»?`, 'Удалить'))) return;
      chats = chats.filter((x) => x !== c);
      if (chatId === c.id) {
        chatId = chats.length ? chats[0].id : null;
        chat = chats.length ? chats[0].msgs : [];
      }
      saveChats();
      renderChat();
    } else {
      selectChat(row.dataset.id);
    }
  });
  msgsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sugg button');
    if (!b) return;
    const text = SUGGEST[+b.dataset.s][1];
    if (text.endsWith(': ')) { $('#chat-input').value = text; autoGrow(); $('#chat-input').focus(); }
    else sendChat(text);
  });
  $('#chat-site').addEventListener('click', () => safe('open_target', { target: 'https://gemini.google.com/app' }));
  $('#chat-settings').addEventListener('click', () => { if ($('#chat-setup').hidden) openChatSetup(); else $('#chat-setup').hidden = true; });
  $('#key-get').addEventListener('click', () => safe('open_target', { target: 'https://aistudio.google.com/apikey' }));
  $('#key-cancel').addEventListener('click', () => { $('#chat-setup').hidden = true; });
  $('#key-save').addEventListener('click', () => {
    store.set('gemKey', $('#key-input').value.trim());
    store.set('gemModel', $('#model-input').value.trim() || DEFAULT_MODEL);
    $('#chat-setup').hidden = true;
    renderChat();
    toast('Сохранено');
  });

  /* ───────────────────────── заметки ───────────────────────── */

  let notes = store.get('notes', []);   // {id, title, body, ts, pin}
  let noteId = null;
  let noteQ = '';

  const noteTitle = (n) => n.title.trim() || n.body.trim().split('\n')[0].slice(0, 60) || 'Новая заметка';
  const notePreview = (n) => n.body.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Нет текста';
  function fmtNoteDate(ts) {
    const d = new Date(ts);
    const same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }
  const saveNotes = () => store.set('notes', notes);

  function visibleNotes() {
    const q = noteQ.trim().toLowerCase();
    return [...notes]
      .filter((n) => !q || (n.title + ' ' + n.body).toLowerCase().includes(q))
      .sort((a, b) => (b.pin === true) - (a.pin === true) || b.ts - a.ts);
  }

  function renderNoteList(freshId) {
    const list = $('#note-list');
    const items = visibleNotes();
    if (!items.length) {
      list.innerHTML = `<div class="n-empty">${noteQ ? 'Ничего не найдено' : 'Заметок пока нет'}</div>`;
      return;
    }
    list.innerHTML = items.map((n) => `
      <button class="n-row${n.id === noteId ? ' on' : ''}${n.id === freshId ? ' in' : ''}" data-id="${n.id}">
        <span class="n-top"><b class="ellipsis">${n.pin ? '<i class="pinned">●</i>' : ''}${esc(noteTitle(n))}</b><em>${esc(fmtNoteDate(n.ts))}</em></span>
        <small class="ellipsis">${esc(notePreview(n))}</small>
      </button>`).join('');
  }

  function paintEditor() {
    const n = notes.find((x) => x.id === noteId);
    $('#note-edit').classList.toggle('none', !n);
    if (!n) {
      $('#note-title').value = '';
      $('#note-body').value = '';
      $('#note-date').textContent = '';
      return;
    }
    $('#note-title').value = n.title;
    $('#note-body').value = n.body;
    $('#note-date').textContent = 'Изменено ' + new Date(n.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    $('#note-pin').classList.toggle('on', !!n.pin);
  }

  function openNote(id) {
    noteId = id;
    paintEditor();
    renderNoteList();
  }

  function newNote() {
    const n = { id: uid(), title: '', body: '', ts: Date.now(), pin: false };
    notes.unshift(n);
    saveNotes();
    noteQ = '';
    $('#note-search').value = '';
    noteId = n.id;
    paintEditor();
    renderNoteList(n.id);
    setTimeout(() => $('#note-title').focus(), 60);
  }

  let noteSaveT;
  function onNoteEdit() {
    const n = notes.find((x) => x.id === noteId);
    if (!n) return;
    n.title = $('#note-title').value;
    n.body = $('#note-body').value;
    n.ts = Date.now();
    $('#note-date').textContent = 'Сохранено';
    clearTimeout(noteSaveT);
    noteSaveT = setTimeout(() => { saveNotes(); renderNoteList(); }, 250);
  }

  $('#note-new').addEventListener('click', newNote);
  $('#note-title').addEventListener('input', onNoteEdit);
  $('#note-body').addEventListener('input', onNoteEdit);
  $('#note-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#note-body').focus(); }
  });
  $('#note-search').addEventListener('input', () => { noteQ = $('#note-search').value; renderNoteList(); });
  $('#note-list').addEventListener('click', (e) => {
    const r = e.target.closest('.n-row');
    if (r) openNote(r.dataset.id);
  });
  $('#note-pin').addEventListener('click', () => {
    const n = notes.find((x) => x.id === noteId);
    if (!n) return;
    n.pin = !n.pin;
    saveNotes();
    $('#note-pin').classList.toggle('on', n.pin);
    renderNoteList();
  });
  $('#note-del').addEventListener('click', async () => {
    const n = notes.find((x) => x.id === noteId);
    if (!n || !(await confirmDialog(`Удалить заметку «${noteTitle(n)}»?`, 'Удалить'))) return;
    notes = notes.filter((x) => x.id !== n.id);
    saveNotes();
    const next = visibleNotes()[0];
    noteId = next ? next.id : null;
    paintEditor();
    renderNoteList();
  });

  function initNotes() {
    const first = visibleNotes()[0];
    noteId = first ? first.id : null;
    paintEditor();
    renderNoteList();
  }

  /* ───────────────────────── нагрузка ───────────────────────── */

  const cpuHist = [], downHist = [], upHist = [];
  const HIST = 60;
  const RING = 263.9;
  // «отображаемые» значения плавно догоняют настоящие — цифры, кольца и графики не дёргаются
  const sm = { cpu: 0, ram: 0, down: 0, up: 0 };
  const tgt = { cpu: 0, ram: 0, down: 0, up: 0 };
  let smReady = false, sampleAt = 0, lastFrame = 0, statsRaf = 0;

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
    const cls = ('fg ' + level(p)).trim();
    if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
  }

  /** Плавная кривая по истории; phase 0..1 — доля секунды с последнего замера (график едет влево непрерывно) */
  function drawChart(svg, hist, max, w, h, phase) {
    if (!svg || !hist.length) return;
    const step = w / (HIST - 1);
    const pts = hist.map((v, i) => [w - (hist.length - 1 - i) * step - step * phase, h - 3 - (Math.min(v, max) / max) * (h - 8)]);
    pts.push([w, pts[pts.length - 1][1]]);
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
  const statsVisible = () => state.open && state.tab === 'stats';

  function statsFrame(now) {
    statsRaf = 0;
    if (!statsVisible()) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    const k = 1 - Math.exp(-dt * 6);
    for (const key of Object.keys(sm)) sm[key] += (tgt[key] - sm[key]) * k;
    const phase = Math.max(0, Math.min(1, (now - sampleAt) / 1000));

    $('#st-cpu').textContent = Math.round(sm.cpu) + '%';
    setRing($('#st-cpu-ring'), sm.cpu);
    drawChart($('#st-spark'), cpuHist, 100, 300, 90, phase);
    $('#st-ram').textContent = Math.round(sm.ram) + '%';
    setRing($('#st-ram-ring'), sm.ram);
    $('#st-down').textContent = fmtRate(sm.down);
    $('#st-up').textContent = fmtRate(sm.up);
    drawChart($('#st-net-down'), downHist, Math.max(50e3, ...downHist), 300, 60, phase);
    drawChart($('#st-net-up'), upHist, Math.max(50e3, ...upHist), 300, 60, phase);
    statsRaf = requestAnimationFrame(statsFrame);
  }
  function startStatsFrames() {
    if (!statsRaf && statsVisible()) { lastFrame = performance.now(); statsRaf = requestAnimationFrame(statsFrame); }
  }

  function onStats(s) {
    push(cpuHist, s.cpu);
    push(downHist, s.net_down);
    push(upHist, s.net_up);
    const ramPct = s.mem_total ? (s.mem_used / s.mem_total) * 100 : 0;
    Object.assign(tgt, { cpu: s.cpu, ram: ramPct, down: s.net_down, up: s.net_up });
    if (!smReady) { Object.assign(sm, tgt); smReady = true; }
    sampleAt = performance.now();
    if (!statsVisible()) return;

    $('#st-ram-sub').innerHTML = `${esc(fmtBytes(s.mem_used))}<br>из ${esc(fmtBytes(s.mem_total))}`;
    // списки обновляем на месте (а не пересобираем), чтобы полоски плавно менялись, а не перезапускались
    const sync = (el, keys, build, update) => {
      const sig = keys.join('|');
      if (el.dataset.sig !== sig) {
        el.innerHTML = build();
        el.dataset.sig = sig;
        void el.offsetWidth;
      }
      update();
    };
    const disksEl = $('#st-disks');
    if (!s.disks.length) { disksEl.innerHTML = '<span class="hint">Нет данных</span>'; disksEl.dataset.sig = ''; }
    else {
      sync(disksEl, s.disks.map((d) => d.name),
        () => s.disks.map((d) => `<div class="disk"><div class="top2"><b>${esc(d.name)}</b><span></span></div><div class="bar"><i></i></div></div>`).join(''),
        () => s.disks.forEach((d, i) => {
          const p = d.total ? (d.used / d.total) * 100 : 0;
          const row = disksEl.children[i];
          row.querySelector('span').textContent = `${fmtBytes(d.used)} из ${fmtBytes(d.total)} · ${p.toFixed(0)}%`;
          const bar = row.querySelector('i');
          bar.style.width = p.toFixed(0) + '%';
          bar.className = level(p);
        }));
    }

    const fillList = (el, arr, key, fmt) => {
      const mx = Math.max(1e-9, ...arr.map((p) => p[key]));
      sync(el, arr.map((p) => p.name),
        () => arr.map((p) => `<li><span>${esc(p.name)}</span><span></span><div class="mb"><i></i></div></li>`).join(''),
        () => arr.forEach((p, i) => {
          const li = el.children[i];
          li.children[1].textContent = fmt(p[key]);
          li.querySelector('i').style.width = ((p[key] / mx) * 100).toFixed(0) + '%';
        }));
    };
    fillList($('#st-top-cpu'), s.top_cpu, 'cpu', (v) => v.toFixed(1) + '%');
    fillList($('#st-top-mem'), s.top_mem, 'mem', fmtBytes);
    startStatsFrames();
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

  const ALBUMS = {"asia": "Азия и Океания", "latin": "Латиноамерика", "rising": "Новые художники", "geometry": "Геометрия", "cities": "Города", "life": "Жизнь", "art": "Искусство", "sea": "Море", "solid": "Однотонные", "landscapes": "Пейзажи", "textures": "Текстуры", "black": "Темнокожие авторы", "earth": "Фото Земли", "lgbtq": "ЛГБТК+", "native": "Коренные народы США"};
  const WP_NAMES = {"asia-01": "По волнам", "asia-13": "Bông (хлопок)", "latin-01": "Поля чудес", "latin-13": "Marisol Ortega: Fruitful Fun", "rising-01": "Крокосипед", "rising-13": "Ловцы звезд", "geometry-01": "Tessellation 1", "geometry-12": "Tessellation 3", "cities-01": "Sergey Dzyuba", "cities-22": "Ashish Gaikwad", "life-01": "Andrzej Herman", "life-22": "Liudmyla Khalfina", "art-01": "Watercolor Art by Google", "art-29": "Magic ginkgo", "sea-01": "Коралловые рифы (Новая Каледония)", "sea-18": "Коралловые рифы (9-й ленточный риф, Большой Барьерный риф)", "solid-01": "Синий (Google)", "solid-13": "Желтый (Google)", "landscapes-01": "Giulio Rosso Chioso", "landscapes-31": "Stefano Termanini", "textures-01": "Adam Boender", "textures-18": "Espen Ericsson", "black-01": "Полет в звездах", "black-15": "Жизнь цветов , автор Laci Jordan", "earth-01": "NASA Image Library", "earth-24": "Утрера (Испания)", "lgbtq-01": "Уязвимость", "lgbtq-11": "Мое задумчивое сердце", "native-01": "Память о предках", "native-12": "ᎤᎧᏖᎾ (Рогатый змей)"};
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

  /* прокси для Gemini */
  const proxyEl = $('#proxy-url');
  proxyEl.value = store.get('proxyUrl', '');
  function paintProxy() {
    const on = !!proxyConfig();
    $('#tg-proxy').classList.toggle('on', on);
    $('#tg-proxy-s').textContent = on ? 'Включён · ' + proxyHost(normProxy(proxyEl.value)) : 'Выключен';
  }
  function proxyNote(text, kind = '') {
    const n = $('#proxy-note');
    n.textContent = text;
    n.className = 'hint ' + kind;
  }
  proxyEl.addEventListener('input', () => {
    store.set('proxyUrl', proxyEl.value.trim());
    paintProxy();
  });
  $('#tg-proxy').addEventListener('click', () => {
    const want = !store.get('proxyOn', false);
    const url = normProxy(proxyEl.value);
    if (want && !url) { toast('Сначала впишите адрес прокси', true); proxyEl.focus(); return; }
    if (want && !/^https?:\/\//i.test(url)) { toast('Поддерживается HTTP-прокси (http://адрес:порт)', true); return; }
    store.set('proxyOn', want);
    store.set('proxyUrl', proxyEl.value.trim());
    paintProxy();
    proxyNote(want ? 'Чат с Gemini теперь идёт через прокси.' : 'Прокси выключен, запросы идут напрямую.');
  });
  $('#proxy-test').addEventListener('click', async () => {
    const url = normProxy(proxyEl.value);
    if (!url) { toast('Сначала впишите адрес прокси', true); return; }
    const btn = $('#proxy-test');
    btn.disabled = true;
    proxyNote('Проверяю соединение…');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const doFetch = (T && T.http && T.http.fetch) ? T.http.fetch : window.fetch.bind(window);
      const res = await doFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
        headers: cfg.key ? { 'x-goog-api-key': cfg.key } : {},
        signal: ctl.signal,
        proxy: { all: url },
      });
      const body = await res.text();
      if (/location is not supported|not available in your/i.test(body)) {
        proxyNote('Прокси работает, но Google не принимает его страну. Нужен прокси из другой страны.', 'bad');
      } else if (res.ok) {
        proxyNote('Всё работает: Gemini отвечает через прокси.', 'ok');
      } else if (!cfg.key) {
        proxyNote('Прокси работает и Google отвечает. Ключ Gemini ещё не вписан, поэтому до конца не проверить.', 'ok');
      } else {
        proxyNote(`Прокси работает, но Google ответил ${res.status}. Проверьте ключ.`, 'bad');
      }
    } catch (e) {
      proxyNote(e && e.name === 'AbortError' ? 'Прокси не ответил за 15 секунд.' : 'Не удалось подключиться через прокси: ' + ((e && e.message) || e), 'bad');
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
    }
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
          ${a.icon
            ? `<span class="ico real"><img alt="" draggable="false" src="${a.icon}"></span>`
            : `<span class="ico" style="background:hsl(${hue(a.name)} 45% 70%)">${esc([...a.name][0] || '?').toUpperCase()}</span>`}
          <span class="nm">${esc(a.name)}</span>
        </button>`).join('');
    }
    store.set('apps', apps);
    loadIcons();
  }

  /** Подтягивает настоящие значки программ (один раз, дальше берутся из сохранённого) */
  let iconsBusy = false;
  async function loadIcons() {
    if (iconsBusy) return;
    iconsBusy = true;
    try {
      for (const a of apps.filter((x) => !x.icon && !x.noIcon)) {
        let icon = null;
        try { icon = await invoke('app_icon', { path: a.path }); } catch { /* нет значка */ }
        if (icon) a.icon = icon; else a.noIcon = true;
        store.set('apps', apps);
        const el = $(`.app[data-id="${a.id}"] .ico`);
        if (el && icon) { el.className = 'ico real'; el.removeAttribute('style'); el.innerHTML = `<img alt="" draggable="false" src="${icon}">`; }
      }
    } finally { iconsBusy = false; }
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
  initNotes();
  renderApps();
  paintNight();
  paintProxy();
  if (nightOn) applyNight();
  tickClock();
  setInterval(tickClock, 15000);
  window.addEventListener('resize', () => { moveIndicator(true); layoutWp(); });
  applySize();
  poll();
})();
