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
  const SIZES = { normal: [1100, 590], wide: [0, 640] };

  const state = {
    open: false,
    pinned: false,
    wide: store.get('wide', false),
    tab: ['control', 'today', 'chat', 'translate', 'notes', 'stats', 'wallpaper', 'apps', 'power'].includes(store.get('tab', 'control')) ? store.get('tab', 'control') : 'control',
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
    // сначала подгоняем окно под вкладку, потом плавно раскрываем
    fitShell().then(() => requestAnimationFrame(() => { if (state.open) shell.classList.add('open'); }));
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

  /* Высота шторки подстраивается под содержимое вкладки (как в Hitodama):
     «Питание» — низкая, «Приложения» растут вместе с числом ярлыков, остальные — на полную высоту.
     Окно всегда подгоняется под шторку, чтобы пустая часть не перехватывала клики. */
  let winH = 0, fitT;
  let ZOOM = 0.86;                       // всё интерфейс чуть мельче и аккуратнее
  async function initZoom() {
    try { await T.webview.getCurrentWebview().setZoom(ZOOM); } catch { ZOOM = 1; }
  }
  const maxH = () => (state.wide ? SIZES.wide[1] : SIZES.normal[1]);
  function naturalH() {
    const hd = $('header').offsetHeight;
    if (state.tab === 'power') return hd + 12 + $(".power-grid").offsetHeight + 30;
    return maxH();
  }
  async function fitShell() {
    const h = Math.round(Math.min(Math.max(naturalH(), 230), maxH()));
    const need = h + 8;               // в px интерфейса
    const winPx = Math.round(need * ZOOM);
    const w0 = state.wide ? SIZES.wide[0] : SIZES.normal[0];
    const width = w0 > 0 ? Math.round(w0 * ZOOM) : 0;
    clearTimeout(fitT);
    if (need > winH) {
      winH = need;
      await safe('resize_shutter', { width, height: winPx });
      shell.style.setProperty('--h', h + 'px');
    } else {
      shell.style.setProperty('--h', h + 'px');
      fitT = setTimeout(() => {          // окно сжимаем после анимации
        if (winH !== need) { winH = need; safe('resize_shutter', { width, height: winPx }); }
      }, 800);
    }
  }

  async function applySize() {
    shell.style.height = maxH() + 'px';
    winH = 0;
    await fitShell();
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

  function maybeCollapseLater(ms = 40) {
    clearTimeout(leaveT);
    leaveT = setTimeout(() => {
      if (state.hover || state.pinned || state.busy > 0) return;
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
  window.addEventListener('blur', () => { if (state.open) maybeCollapseLater(120); });
  document.documentElement.addEventListener('mouseleave', () => { state.hover = false; if (state.open) maybeCollapseLater(0); });

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
    fitShell();
    // фокус не должен «застревать» в скрытой вкладке (иначе не работают стрелки в каруселях)
    const act = document.activeElement;
    if (act && act !== document.body && act.blur && !$('#tab-' + name).contains(act)) act.blur();
    // тяжёлое — после того, как вкладка уже показана
    setTimeout(() => {
      if (state.tab !== name) return;
      if (name === 'wallpaper') loadWallpapers(false);
      if (name === 'today') onTodayShown();
      if (name === 'translate') $('#tr-in').focus();
      if (name === 'apps') { renderApps(true); refreshStartApps(); }
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
  let genArr = null;   // чат, в котором сейчас идёт ответ
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
      .map((m, i) => `<div class="msg ${m.role === 'user' ? 'user' : m.role === 'err' ? 'err' : ''}${genArr === chat && i === chat.length - 1 && m.role === 'model' ? ' typing' : ''}" data-i="${i}">${md(m.text)}</div>`)
      .join('');
    scrollDown();
    renderChatList();
  }

  function selectChat(id) {
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    chatId = id;
    chat = c.msgs;
    renderChat();
  }

  function newChat() {
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

    const arr = cur.msgs;
    const isHere = () => chatId === cur.id;
    arr.push({ role: 'user', text });
    arr.push({ role: 'model', text: '' });
    genArr = arr;
    input.value = '';
    autoGrow();
    renderChat();
    const botEl = { set innerHTML(h) { const e = isHere() ? msgsEl.lastElementChild : null; if (e) e.innerHTML = h; } };
    setSending(true);

    const history = arr
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
      const stick = isHere() && nearBottom();
      arr[arr.length - 1].text = got;
      botEl.innerHTML = md(got);
      if (stick && isHere()) scrollDown();
    };

    /** Потоковый ответ: слова появляются по мере генерации */
    async function viaStream() {
      const res = await fetchLimited(`${API}${model}:streamGenerateContent?alt=sse`, common, WAIT.first, abortSignal);
      if (!res.ok) throw Object.assign(new Error(parseApiError(res.status, await res.text())), { status: res.status });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', got = '', blocked = '', first = true, finished = false;
      for (;;) {
        let r;
        try { r = await withTimeout(reader.read(), first ? WAIT.first : WAIT.chunk); }
        catch (e) {
          // ответ уже получен, а соединение «зависло» (бывает через прокси) — считаем его законченным
          if (e && e.message === 'TIMEOUT' && got) { try { reader.cancel(); } catch { /* ок */ } break; }
          throw e;
        }
        const { value, done } = r;
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
          if (obj.candidates && obj.candidates[0] && obj.candidates[0].finishReason) finished = true;
        }
        if (abortSignal.aborted) break;
        if (finished) { try { reader.cancel(); } catch { /* ок */ } break; }
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
        if (e && e.message === 'TIMEOUT' && !arr[arr.length - 1].text && !abortSignal.aborted) return viaPlain();
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
            if (!busy(e) || abortSignal.aborted || arr[arr.length - 1].text) throw e;
            botEl.innerHTML = '<span class="note">Gemini перегружен, пробую ещё раз…</span>';
            await pause(tryN === 0 && qi === 0 ? 1200 : 300);
          }
        }
      }
      if (lastErr) throw lastErr;
    } catch (e) {
      const partial = arr[arr.length - 1].text;
      if (e && e.name === 'AbortError') {
        if (!partial) arr.pop();
      } else if (partial) {
        arr.push({ role: 'err', text: humanizeError(e) });
      } else {
        arr[arr.length - 1] = { role: 'err', text: humanizeError(e) };
      }
    } finally {
      chatAbort = null;
      genArr = null;
      setSending(false);
      saveChats();
      if (isHere()) renderChat(); else renderChatList();
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
      const c = chats.find((x) => x.id === row.dataset.id);
      if (!c || !(await confirmDialog(`Удалить чат «${c.title}»?`, 'Удалить'))) return;
      if (chatAbort && genArr === c.msgs) chatAbort.abort();
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
  /** Диагностика: что именно мешает — ключ, регион, прокси или сеть */
  async function probe(useProxy) {
    const key = $('#key-input').value.trim() || cfg.key;
    const model = encodeURIComponent(($('#model-input').value.trim() || cfg.model).replace(/^models\//, ''));
    const px = useProxy ? proxyConfig() : null;
    const t0 = Date.now();
    try {
      const res = await fetchLimited(`${API}${model}`, {
        method: 'GET', headers: { 'x-goog-api-key': key },
        ...(px && T && T.http && T.http.fetch ? { proxy: px } : {}),
      }, WAIT.probe || 12000, new AbortController().signal);
      const ms = Date.now() - t0;
      if (res.ok) return { ok: true, text: `Соединение есть (${ms} мс), ключ и модель приняты.` };
      return { ok: false, reached: true, text: parseApiError(res.status, await res.text()) };
    } catch (e) {
      return { ok: false, reached: false, text: e && e.message === 'TIMEOUT' ? 'нет ответа за 12 секунд' : humanizeError(e) };
    }
  }
  $('#key-test').addEventListener('click', async () => {
    const out = $('#key-test-res');
    const btn = $('#key-test');
    if (!($('#key-input').value.trim() || cfg.key)) { out.hidden = false; out.textContent = 'Сначала вставьте ключ.'; return; }
    btn.disabled = true; out.hidden = false; out.textContent = 'Проверяю…';
    const viaProxy = !!proxyConfig();
    const r = await probe(true);
    let msg = (viaProxy ? 'Через прокси: ' : 'Напрямую: ') + r.text;
    if (!r.ok && viaProxy) {
      const d = await probe(false);
      msg += `\nНапрямую, без прокси: ${d.text}`;
      if (!r.reached) msg += '\nПрокси не отвечает. Проверьте адрес и порт или отключите его, если у вас включён VPN на весь компьютер.';
    } else if (!r.ok && !r.reached) {
      msg += '\nGoogle напрямую недоступен. Включите VPN на компьютере или подключите HTTP-прокси в «Управлении».';
    }
    out.textContent = msg;
    out.style.whiteSpace = 'pre-line';
    btn.disabled = false;
  });
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
  const hv = { cpu: 0, down: 0, up: 0 };          // сглаженные значения для истории графиков
  const smMax = { down: 50e3, up: 50e3 };         // масштаб сетевых графиков тоже меняется плавно
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
    const k = 1 - Math.exp(-dt * 2.6);
    for (const key of Object.keys(sm)) sm[key] += (tgt[key] - sm[key]) * k;
    const km = 1 - Math.exp(-dt * 1.4);
    const wantDown = Math.max(50e3, ...downHist), wantUp = Math.max(50e3, ...upHist);
    smMax.down += (wantDown - smMax.down) * km;
    smMax.up += (wantUp - smMax.up) * km;
    const live = (arr, v) => (arr.length ? [...arr.slice(0, -1), v] : arr);
    const phase = Math.max(0, Math.min(1, (now - sampleAt) / 1000));

    $('#st-cpu').textContent = Math.round(sm.cpu) + '%';
    setRing($('#st-cpu-ring'), sm.cpu);
    drawChart($('#st-spark'), live(cpuHist, sm.cpu), 100, 300, 90, phase);
    $('#st-ram').textContent = Math.round(sm.ram) + '%';
    setRing($('#st-ram-ring'), sm.ram);
    $('#st-down').textContent = fmtRate(sm.down);
    $('#st-up').textContent = fmtRate(sm.up);
    drawChart($('#st-net-down'), live(downHist, sm.down), smMax.down, 300, 60, phase);
    drawChart($('#st-net-up'), live(upHist, sm.up), smMax.up, 300, 60, phase);
    statsRaf = requestAnimationFrame(statsFrame);
  }
  function startStatsFrames() {
    if (!statsRaf && statsVisible()) { lastFrame = performance.now(); statsRaf = requestAnimationFrame(statsFrame); }
  }

  function onStats(s) {
    // история хранит слегка сглаженные значения, поэтому резкие всплески не рисуют «пилу»
    const a = smReady ? 0.5 : 1;
    hv.cpu += (s.cpu - hv.cpu) * a;
    hv.down += (s.net_down - hv.down) * a;
    hv.up += (s.net_up - hv.up) * a;
    push(cpuHist, hv.cpu);
    push(downHist, hv.down);
    push(upHist, hv.up);
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
    $('#hdr-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
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

  /* ───────────────────────── сегодня ───────────────────────── */

  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MONTHS_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  let calView = new Date();

  function renderToday() {
    const now = new Date();
    $('#td-day').textContent = now.getDate();
    $('#td-month').textContent = MONTHS_G[now.getMonth()];
    $('#td-wd').textContent = WEEKDAYS[now.getDay()];
  }

  function renderCal() {
    const y = calView.getFullYear(), m = calView.getMonth();
    $('#cal-title').textContent = `${MONTHS[m]} ${y}`;
    const first = (new Date(y, m, 1).getDay() + 6) % 7;      // понедельник = 0
    const days = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const t = new Date();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = i - first + 1;
      let n = d, cls = '';
      if (d < 1) { n = prevDays + d; cls = 'o'; } else if (d > days) { n = d - days; cls = 'o'; }
      else if (d === t.getDate() && m === t.getMonth() && y === t.getFullYear()) cls = 'today';
      cells.push(`<span class="${cls}">${n}</span>`);
    }
    $('#cal-grid').innerHTML = cells.join('');
  }
  $('#cal-prev').addEventListener('click', () => { calView = new Date(calView.getFullYear(), calView.getMonth() - 1, 1); renderCal(); });
  $('#cal-next').addEventListener('click', () => { calView = new Date(calView.getFullYear(), calView.getMonth() + 1, 1); renderCal(); });
  $('#cal-title').addEventListener('click', () => { calView = new Date(); renderCal(); });

  /* погода: Open-Meteo, без ключа */
  const WX_ICONS = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    'cloud-sun': '<path d="M7 11.5a3.6 3.6 0 0 1 6.5-2"/><path d="M7 4V2.5M2.6 6.4l1-1M12 5.4l1-1"/><path d="M7.5 20.5h9.2a3.8 3.8 0 0 0 .5-7.6 5.2 5.2 0 0 0-9.9 1.1A3.3 3.3 0 0 0 7.500 20.500z"/>',
    cloud: '<path d="M7.5 19.5h9.2a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.500 1.200A3.500 3.500 0 0 0 7.500 19.500z"/>',
    rain: '<path d="M7.5 15.500h9.200a4 4 0 0 0 .5-8 5.500 5.500 0 0 0-10.500 1.200A3.400 3.400 0 0 0 7.500 15.500z"/><path d="M8 18.500l-1 2.500M12 18.500l-1 2.500M16 18.500l-1 2.500"/>',
    snow: '<path d="M7.500 14.500h9.200a4 4 0 0 0 .5-8 5.500 5.500 0 0 0-10.500 1.200A3.400 3.400 0 0 0 7.500 14.500z"/><path d="M8 18h.01M12 19.500h.01M16 18h.01M10 21h.01M14 21h.01"/>',
    storm: '<path d="M7.500 14.500h9.200a4 4 0 0 0 .5-8 5.500 5.500 0 0 0-10.500 1.200A3.400 3.400 0 0 0 7.500 14.500z"/><path d="M12.500 14l-2.500 4h3l-2 4"/>',
    fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
  };
  function wxInfo(code) {
    if (code === 0) return ['Ясно', 'sun'];
    if (code <= 2) return ['Малооблачно', 'cloud-sun'];
    if (code === 3) return ['Пасмурно', 'cloud'];
    if (code === 45 || code === 48) return ['Туман', 'fog'];
    if (code >= 51 && code <= 57) return ['Морось', 'rain'];
    if (code >= 61 && code <= 67) return ['Дождь', 'rain'];
    if (code >= 71 && code <= 77) return ['Снег', 'snow'];
    if (code >= 80 && code <= 82) return ['Ливень', 'rain'];
    if (code === 85 || code === 86) return ['Снегопад', 'snow'];
    if (code >= 95) return ['Гроза', 'storm'];
    return ['Облачно', 'cloud'];
  }
  let place = store.get('place', { name: 'Москва', lat: 55.7558, lon: 37.6173 });
  let wx = store.get('wx', null);
  let wxFailed = false;

  function paintWeather() {
    $('#wx-city').textContent = place.name;
    if (!wx) { $('#wx-temp').textContent = '–'; $('#wx-desc').textContent = 'Нет данных о погоде'; $('#wx-ic').innerHTML = ''; return; }
    const [txt, ic] = wxInfo(wx.code);
    $('#wx-temp').textContent = `${wx.temp > 0 ? '+' : ''}${Math.round(wx.temp)}°`;
    $('#wx-desc').textContent = `${txt} · ${Math.round(wx.min)}…${Math.round(wx.max)}°`;
    $('#wx-ic').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${WX_ICONS[ic]}</svg>`;
  }
  async function getJson(url, opts = {}) {
    const attempts = [window.fetch && window.fetch.bind(window), T && T.http && T.http.fetch].filter(Boolean);
    let lastErr = null;
    for (const doFetch of attempts) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await doFetch(url, { ...opts, signal: ctl.signal });
        if (!r.ok) throw new Error('http ' + r.status);
        return await r.json();
      } catch (e) { lastErr = e; }
      finally { clearTimeout(t); }
    }
    throw lastErr || new Error('нет связи');
  }
  async function loadWeather(force) {
    if (!force && wx && Date.now() - wx.at < 20 * 60 * 1000 && wx.place === place.name) { paintWeather(); return; }
    paintWeather();
    try {
      const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
      wx = { temp: j.current.temperature_2m, code: j.current.weather_code, min: j.daily.temperature_2m_min[0], max: j.daily.temperature_2m_max[0], at: Date.now(), place: place.name };
      store.set('wx', wx);
    } catch (e) {
      paintWeather();
      if (!wx) $('#wx-desc').textContent = 'Нет связи с сервисом погоды. Нажмите, чтобы повторить';
      wxFailed = true;
      return;
    }
    wxFailed = false;
    paintWeather();
  }
  $('#td-wx').addEventListener('click', () => {
    if (wxFailed) { loadWeather(true); return; }
    $('#td-cityform').hidden = false;
    $('#td-wx').hidden = true;
    $('#td-city').value = place.name;
    $('#td-city').focus();
    $('#td-city').select();
  });
  $('#td-cityform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#td-city').value.trim();
    $('#td-cityform').hidden = true;
    $('#td-wx').hidden = false;
    if (!q || q === place.name) return;
    try {
      const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ru`);
      const r = j.results && j.results[0];
      if (!r) { toast('Город не найден', true); return; }
      place = { name: r.name, lat: r.latitude, lon: r.longitude };
      store.set('place', place);
      loadWeather(true);
    } catch { toast('Не удалось найти город: нет связи', true); }
  });
  $('#td-city').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); $('#td-cityform').hidden = true; $('#td-wx').hidden = false; }
  });

  /* секундомер и таймер */
  const tm = { mode: 'sw', running: false, base: 0, start: 0, total: 5 * 60 * 1000, raf: 0, done: false };
  const fmt2 = (n) => String(n).padStart(2, '0');
  function tmElapsed() { return tm.base + (tm.running ? performance.now() - tm.start : 0); }
  function paintTimer() {
    const el = tmElapsed();
    const shown = tm.mode === 'sw' ? el : Math.max(0, tm.total - el);
    const sec = Math.floor(shown / 1000);
    $('#tm-main').textContent = sec >= 3600 ? `${Math.floor(sec / 3600)}:${fmt2(Math.floor(sec / 60) % 60)}:${fmt2(sec % 60)}` : `${fmt2(Math.floor(sec / 60))}:${fmt2(sec % 60)}`;
    $('#tm-sub').textContent = tm.mode === 'sw' ? '.' + fmt2(Math.floor((shown % 1000) / 10)) : '';
    const C = 2 * Math.PI * 52;
    const frac = tm.mode === 'sw' ? (el % 60000) / 60000 : 1 - Math.min(1, el / tm.total);
    const arc = $('#tm-arc');
    arc.style.strokeDasharray = `${C}`;
    arc.style.strokeDashoffset = `${C * (1 - frac)}`;
    if (tm.mode === 'tm' && tm.running && el >= tm.total && !tm.done) {
      tm.done = true; tm.running = false; tm.base = tm.total;
      beep(); toast('Время вышло');
      syncTmButtons();
    }
  }
  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.22, 0.44].forEach((d) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, ac.currentTime + d);
        g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d + 0.18);
        o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.2);
      });
    } catch { /* без звука */ }
  }
  function tmLoop() {
    cancelAnimationFrame(tm.raf);
    const step = () => {
      if (state.tab !== 'today') { tm.raf = 0; return; }
      paintTimer();
      if (tm.running) tm.raf = requestAnimationFrame(step); else tm.raf = 0;
    };
    step();
  }
  function syncTmButtons() {
    $('#tm-go').textContent = tm.running ? 'Пауза' : (tm.base > 0 && !tm.done ? 'Продолжить' : 'Старт');
    $$('#tm-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === tm.mode));
    $('#tm-presets').hidden = tm.mode !== 'tm';
    $$('#tm-presets button').forEach((b) => b.classList.toggle('on', +b.dataset.min * 60000 === tm.total));
  }
  $('#tm-go').addEventListener('click', () => {
    if (tm.running) { tm.base = tmElapsed(); tm.running = false; }
    else {
      if (tm.mode === 'tm' && (tm.done || tm.base >= tm.total)) { tm.base = 0; tm.done = false; }
      tm.start = performance.now(); tm.running = true;
    }
    syncTmButtons(); tmLoop();
  });
  $('#tm-reset').addEventListener('click', () => { tm.running = false; tm.base = 0; tm.done = false; syncTmButtons(); tmLoop(); });
  $('#tm-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.m === tm.mode) return;
    tm.mode = b.dataset.m; tm.running = false; tm.base = 0; tm.done = false;
    syncTmButtons(); tmLoop();
  });
  $('#tm-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tm.total = +b.dataset.min * 60000; tm.running = false; tm.base = 0; tm.done = false;
    syncTmButtons(); tmLoop();
  });

  function renderTodayNotes() {
    const list = notes.slice().sort((a, b) => (b.pin - a.pin) || (b.ts - a.ts)).slice(0, 3);
    $('#td-notelist').innerHTML = list.length
      ? list.map((n) => `<button class="td-n" data-id="${n.id}"><b class="ellipsis">${esc(noteTitle(n))}</b><small class="ellipsis">${esc((n.body || '').replace(/\s+/g, ' ').slice(0, 60) || 'Пустая заметка')}</small></button>`).join('')
      : '<div class="n-empty">Заметок пока нет</div>';
  }
  $('#td-notelist').addEventListener('click', (e) => {
    const b = e.target.closest('.td-n');
    if (!b) return;
    setTab('notes');
    openNote(b.dataset.id);
  });
  $('#td-allnotes').addEventListener('click', () => setTab('notes'));

  function onTodayShown() {
    renderToday(); renderCal(); renderTodayNotes(); syncTmButtons(); tmLoop(); loadWeather(false);
  }

  /* ───────────────────────── приложения ───────────────────────── */

  let customApps = store.get('apps', []);          // {id, name, path}: добавлено вручную
  let startApps = store.get('startApps', []);      // {name, path}: из меню «Пуск»
  let pins = store.get('pins', []);                // пути закреплённых
  let recent = store.get('recent', []);            // пути недавно запущенных
  let icons = store.get('icons', {});              // path → data-url (или 0, если значка нет)
  let apQuery = '';
  let apIO = null;

  function hue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  const allApps = () => {
    const seen = new Set();
    const out = [];
    for (const a of startApps) { const k = a.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ name: a.name, path: a.path, custom: false }); } }
    for (const a of customApps) out.push({ name: a.name, path: a.path, custom: true, id: a.id });
    return out.sort((x, y) => x.name.localeCompare(y.name, 'ru'));
  };

  function apRow(a) {
    const ic = icons[a.path];
    const pinned = pins.includes(a.path);
    return `<div class="ap-row" data-path="${esc(a.path)}" title="${esc(a.path)}">
      <span class="ap-ic" style="${ic ? '' : `background:hsl(${hue(a.name)} 40% 66%)`}">${ic ? `<img alt="" draggable="false" src="${ic}">` : esc([...a.name][0] || '?').toUpperCase()}</span>
      <span class="ap-nm ellipsis">${esc(a.name)}</span>
      <span class="ap-kind">${a.custom ? 'Добавлено' : 'Приложение'}</span>
      <button class="ap-pin${pinned ? ' on' : ''}" data-pin="1" title="${pinned ? 'Открепить' : 'Закрепить'}"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z"/></svg></button>
    </div>`;
  }

  function renderApps(keepScroll) {
    const list = $('#ap-list');
    const top = keepScroll ? list.scrollTop : 0;
    const all = allApps();
    const byPath = new Map(all.map((a) => [a.path, a]));
    const q = apQuery.trim().toLowerCase();
    let html = '';
    if (q) {
      const found = all.filter((a) => a.name.toLowerCase().includes(q));
      html = found.length ? found.map(apRow).join('') : '<div class="n-empty">Ничего не найдено</div>';
      $('#ap-count').textContent = `${found.length} найдено`;
    } else {
      const pinned = pins.map((p) => byPath.get(p)).filter(Boolean);
      const rec = recent.map((p) => byPath.get(p)).filter((a) => a && !pins.includes(a.path)).slice(0, 4);
      if (pinned.length) html += `<div class="ap-h">Закреплённые</div>${pinned.map(apRow).join('')}`;
      if (rec.length) html += `<div class="ap-h">Недавние</div>${rec.map(apRow).join('')}`;
      html += `<div class="ap-h">Все приложения</div>${all.length ? all.map(apRow).join('') : '<div class="n-empty">Список загружается…</div>'}`;
      $('#ap-count').textContent = `${all.length} ${plural(all.length, ['приложение', 'приложения', 'приложений'])}`;
    }
    list.innerHTML = html;
    list.scrollTop = top;
    observeRows();
  }

  /* строки плавно «въезжают» при прокрутке, значки подгружаются по мере появления */
  function observeRows() {
    const list = $('#ap-list');
    if (apIO) apIO.disconnect();
    if (!('IntersectionObserver' in window)) { $$('.ap-row', list).forEach((r) => r.classList.add('in')); queueIcons(); return; }
    apIO = new IntersectionObserver((entries) => {
      let any = false;
      for (const e of entries) {
        e.target.classList.toggle('in', e.isIntersecting);
        if (e.isIntersecting) any = true;
      }
      if (any) queueIcons();
    }, { root: list, threshold: 0.05 });
    $$('.ap-row', list).forEach((r) => apIO.observe(r));
  }

  let iconT = 0, iconBusy = false;
  function queueIcons() { clearTimeout(iconT); iconT = setTimeout(loadVisibleIcons, 90); }
  async function loadVisibleIcons() {
    if (iconBusy) { queueIcons(); return; }
    iconBusy = true;
    try {
      for (let guard = 0; guard < 8; guard++) {
        const batch = $$('#ap-list .ap-row.in').filter((r) => icons[r.dataset.path] === undefined).slice(0, 12).map((r) => r.dataset.path);
        if (!batch.length) break;
        let res = [];
        try { res = await invoke('app_icons', { paths: batch }); } catch { res = []; }
        batch.forEach((p, i) => { icons[p] = (res && res[i]) || 0; });
        store.set('icons', icons);
        for (const p of batch) {
          const row = [...$$('#ap-list .ap-row')].find((r) => r.dataset.path === p);
          const ic = icons[p];
          if (row && ic) { const box = row.querySelector('.ap-ic'); box.removeAttribute('style'); box.innerHTML = `<img alt="" draggable="false" src="${ic}">`; }
        }
      }
    } finally { iconBusy = false; }
  }

  async function refreshStartApps() {
    try {
      const fresh = await invoke('list_start_apps');
      if (Array.isArray(fresh) && fresh.length) {
        startApps = fresh;
        store.set('startApps', startApps);
      }
    } catch { /* остаётся кэш */ }
    renderApps(true);
  }

  $('#ap-search').addEventListener('input', (e) => { apQuery = e.target.value; renderApps(); });
  $('#ap-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const r = $('#ap-list .ap-row'); if (r) launchApp(r.dataset.path); }
    if (e.key === 'Escape' && apQuery) { e.stopPropagation(); e.target.value = ''; apQuery = ''; renderApps(); }
  });

  async function launchApp(path) {
    try {
      await invoke('open_target', { target: path });
      recent = [path, ...recent.filter((p) => p !== path)].slice(0, 8);
      store.set('recent', recent);
    } catch (err) { toast(String(err), true); }
  }

  $('#ap-list').addEventListener('click', (e) => {
    const row = e.target.closest('.ap-row');
    if (!row) return;
    const path = row.dataset.path;
    if (e.target.closest('[data-pin]')) {
      pins = pins.includes(path) ? pins.filter((p) => p !== path) : [path, ...pins];
      store.set('pins', pins);
      renderApps(true);
      return;
    }
    launchApp(path);
  });
  $('#ap-list').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ap-row');
    if (!row) return;
    e.preventDefault();
    const path = row.dataset.path;
    const app = allApps().find((x) => x.path === path);
    if (!app) return;
    const pinned = pins.includes(path);
    const items = [
      { icon: 'open', label: 'Открыть', run: () => launchApp(path) },
      { icon: 'admin', label: 'Запустить от имени администратора', run: async () => {
        try { await invoke('run_as_admin', { path }); recent = [path, ...recent.filter((p) => p !== path)].slice(0, 8); store.set('recent', recent); }
        catch (err) { toast(String(err), true); }
      } },
      '-',
      { icon: 'pin', label: pinned ? 'Открепить' : 'Закрепить', run: () => { pins = pinned ? pins.filter((p) => p !== path) : [path, ...pins]; store.set('pins', pins); renderApps(true); } },
      { icon: 'folder', label: 'Показать в папке', run: () => safe('reveal_in_folder', { path }) },
    ];
    if (app.custom) {
      items.push('-', { icon: 'del', danger: true, label: 'Убрать из списка', run: async () => {
        if (!(await confirmDialog(`Убрать «${app.name}» из списка? Сама программа останется на месте.`, 'Убрать'))) return;
        customApps = customApps.filter((x) => x.id !== app.id);
        pins = pins.filter((p) => p !== path);
        store.set('apps', customApps); store.set('pins', pins);
        renderApps(true);
      } });
    }
    showCtx(e.clientX, e.clientY, items);
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
        if (customApps.some((a) => a.path === p) || startApps.some((a) => a.path === p)) continue;
        const file = p.split(/[\\/]/).pop() || p;
        customApps.push({ id: uid(), name: file.replace(/\.[^.]+$/, ''), path: p });
      }
      store.set('apps', customApps);
      renderApps(true);
    } catch (e) { toast(String(e), true); }
  }));

  /* ───────────────────────── переводчик ───────────────────────── */

  const LANGS = [
    ['auto', 'Определить язык'], ['ru', 'Русский'], ['en', 'Английский'], ['uk', 'Украинский'], ['de', 'Немецкий'],
    ['fr', 'Французский'], ['es', 'Испанский'], ['it', 'Итальянский'], ['pt', 'Португальский'], ['tr', 'Турецкий'],
    ['pl', 'Польский'], ['zh-CN', 'Китайский'], ['ja', 'Японский'], ['ko', 'Корейский'], ['ar', 'Арабский'],
  ];
  const langName = (c) => (LANGS.find((l) => l[0] === c) || [c, c])[1].replace('Определить язык', 'Авто');
  let trFrom = store.get('trFrom', 'auto');
  let trTo = store.get('trTo', 'en');
  let trTimer = 0, trSeq = 0, trLast = '';

  function fillLangs() {
    $('#tr-from').innerHTML = LANGS.map((l) => `<option value="${l[0]}">${l[1]}</option>`).join('');
    $('#tr-to').innerHTML = LANGS.filter((l) => l[0] !== 'auto').map((l) => `<option value="${l[0]}">${l[1]}</option>`).join('');
    $('#tr-from').value = trFrom;
    $('#tr-to').value = trTo;
  }

  async function translateOnce(text, from, to) {
    // 1) Google (без ключа)
    try {
      const j = await getJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`);
      const out = (j[0] || []).map((p) => p[0] || '').join('');
      if (out) return { text: out, det: j[2] || from, eng: 'Google' };
    } catch { /* пробуем другой */ }
    // 2) MyMemory
    const pair = `${from === 'auto' ? (/[а-яё]/i.test(text) ? 'ru' : 'en') : from}|${to}`;
    const j = await getJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${encodeURIComponent(pair)}`);
    const out = j && j.responseData && j.responseData.translatedText;
    if (!out) throw new Error('нет перевода');
    return { text: out, det: pair.split('|')[0], eng: 'MyMemory' };
  }

  async function runTranslate() {
    const text = $('#tr-in').value.trim();
    const out = $('#tr-out');
    $('#tr-count').textContent = text ? `${text.length} симв.` : '';
    if (!text) { out.className = 'tr-out ph'; out.textContent = 'Перевод появится здесь'; $('#tr-det').textContent = ''; $('#tr-eng').textContent = ''; trLast = ''; return; }
    const seq = ++trSeq;
    out.className = 'tr-out ph'; out.textContent = 'Перевожу…';
    try {
      const r = await translateOnce(text, trFrom, trTo);
      if (seq !== trSeq) return;
      out.className = 'tr-out'; out.textContent = r.text;
      trLast = r.text;
      $('#tr-det').textContent = trFrom === 'auto' ? `определён: ${langName(r.det)}` : '';
      $('#tr-eng').textContent = r.eng;
    } catch {
      if (seq !== trSeq) return;
      out.className = 'tr-out err';
      out.textContent = 'Не удалось перевести: нет связи с сервисами перевода. Проверьте интернет или VPN.';
    }
  }
  const trSoon = () => { clearTimeout(trTimer); trTimer = setTimeout(runTranslate, 450); };
  $('#tr-in').addEventListener('input', trSoon);
  $('#tr-from').addEventListener('change', (e) => { trFrom = e.target.value; store.set('trFrom', trFrom); trSoon(); });
  $('#tr-to').addEventListener('change', (e) => { trTo = e.target.value; store.set('trTo', trTo); trSoon(); });
  $('#tr-swap').addEventListener('click', () => {
    const from = trFrom === 'auto' ? ($('#tr-in').value && /[а-яё]/i.test($('#tr-in').value) ? 'ru' : 'en') : trFrom;
    const text = trLast || $('#tr-in').value;
    trFrom = trTo; trTo = from;
    store.set('trFrom', trFrom); store.set('trTo', trTo);
    fillLangs();
    $('#tr-in').value = text;
    runTranslate();
  });
  $('#tr-clear').addEventListener('click', () => { $('#tr-in').value = ''; runTranslate(); $('#tr-in').focus(); });
  $('#tr-copy').addEventListener('click', async () => {
    if (!trLast) return;
    try { await navigator.clipboard.writeText(trLast); toast('Скопировано'); } catch { toast('Не удалось скопировать', true); }
  });
  $('#tr-paste').addEventListener('click', async () => {
    try { $('#tr-in').value = await navigator.clipboard.readText(); runTranslate(); } catch { toast('Нет доступа к буферу обмена', true); }
  });

  /* ───────────────────────── контекстное меню ───────────────────────── */

  const ctx = $('#ctx');
  const CTX_ICONS = {
    admin: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.500-3 8-7 10-4-2-7-5.500-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M8 5.500v13l11-6.500z"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 3.500l2.600 5.400 5.900.8-4.300 4.100 1 5.900L12 17l-5.200 2.700 1-5.900-4.300-4.100 5.900-.8z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  };
  let ctxItems = [];
  function showCtx(x, y, items) {
    ctxItems = items;
    ctx.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${CTX_ICONS[it.icon] || ''}<span>${it.label}</span></button>`).join('');
    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    ctx.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
  }
  const hideCtx = () => { ctx.hidden = true; };
  ctx.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const it = ctxItems[+b.dataset.i];
    hideCtx();
    if (it && it.run) it.run();
  });
  document.addEventListener('mousedown', (e) => { if (!ctx.hidden && !e.target.closest('#ctx')) hideCtx(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ctx.hidden) { e.stopPropagation(); hideCtx(); } }, true);
  window.addEventListener('blur', hideCtx);

  /* ───────────────────────── питание ───────────────────────── */

  $$('.power').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.power;
    if (b.dataset.confirm && !(await confirmDialog(b.dataset.confirm))) return;
    try {
      await invoke('power_action', { action });
    } catch (e) { toast(String(e), true); }
  }));

  /* ───────────────────────── старт ───────────────────────── */

  fillLangs();
  document.addEventListener('selectstart', (e) => {
    const t = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (t && t.closest && !t.closest('input, textarea, .msg, .tr-out')) e.preventDefault();
  });
  renderChat();
  initNotes();
  renderApps();
  paintNight();
  paintProxy();
  if (nightOn) applyNight();
  tickClock();
  setInterval(tickClock, 15000);
  window.addEventListener('resize', () => { moveIndicator(true); layoutWp(); });
  initZoom().then(applySize);
  poll();
})();
