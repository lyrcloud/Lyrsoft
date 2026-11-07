// One conversation's messages and composer, Messenger-style: replies, reactions, edit and unsend,
// photos and files, voice messages, emoji, "typing…", "Seen" and "Active now". Used by the Messages page (chat.js) and
// the chat panel in calls (meet.js): mount(element) draws it into any element and keeps it live with
// polling (only what's new or changed since the last poll). Its events use data-cv attributes, so they
// never mix with the app's own data-click handlers.
const POLL_MS = 3000;
const TYPING_PING_MS = 3000;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJI = '😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😉 🙂 🙃 😢 😭 😡 😮 😴 🥳 🤩 👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 👌 ❤️ 🧡 💛 💚 💙 💜 🔥 ⭐ ✨ 🎉 🎂 ☕ 🍕 🚀 ✅ ❌ ⚠️ 📌 📎 📅 💡 💯'.split(' ');
const IMAGE_RE = /^image\/(jpeg|png|gif|webp|heic|heif|avif)$/;
const AUDIO_RE = /^audio\//;
const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const ago = (iso) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 2) return 'Active now';
  if (minutes < 60) return `Active ${minutes}m ago`;
  if (minutes < 24 * 60) return `Active ${Math.round(minutes / 60)}h ago`;
  return `Active ${Math.round(minutes / 1440)}d ago`;
};

export class ConversationView {
  // onCall(video) and onJoinMeeting(meetingId), when given (Lyr Chat), turn call and meeting messages
  // into Call back / Join buttons; otherwise meetings link to #/meet/<id>.
  constructor({ id, api, esc, toast, initial, getMe, onUpdate = () => {}, onNewMessage = () => {}, onCall = null, onJoinMeeting = null }) {
    Object.assign(this, { id, api, esc, toast, initial, getMe, onUpdate, onNewMessage, onCall, onJoinMeeting });
    this.voice = null; // a voice message being recorded: { rec, stream, chunks, started, timer }
    this.messages = [];
    this.conversation = null;
    this.typing = [];
    this.reads = {};
    this.active = {};
    this.serverTime = null;
    this.draft = '';
    this.replyTo = null; // message being replied to
    this.editing = null; // own message being edited
    this.menuFor = null; // message id whose action menu is open
    this.emojiOpen = false;
    this.pending = []; // uploaded files waiting to be sent: { key, name, type, size, preview }
    this.uploading = 0;
    this.sending = false;
    this.el = null;
    this.timer = null;
    this.lastTypingPing = 0;
  }

  path(suffix = '') {
    return `/chat/${encodeURIComponent(this.id)}${suffix}`;
  }

  // ---------------------------------------------------------------- data

  async load() {
    const data = await this.api('GET', this.path('/messages'));
    this.apply(data, true);
  }

  apply(data, replace = false) {
    this.serverTime = data.serverTime;
    this.conversation = data.conversation;
    this.typing = data.typing || [];
    this.reads = data.reads || {};
    this.active = data.active || {};
    if (replace) {
      this.messages = data.messages;
      return false;
    }
    let fresh = false;
    for (const m of data.messages) {
      const i = this.messages.findIndex((x) => x.id === m.id);
      if (i === -1) {
        this.messages.push(m);
        if (m.authorEmail !== this.getMe().email) fresh = true;
      } else this.messages[i] = m;
    }
    this.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return fresh;
  }

  async poll() {
    if (!this.el?.isConnected || document.hidden) return;
    try {
      const data = await this.api('GET', `${this.path('/messages')}?since=${encodeURIComponent(this.serverTime || '')}`);
      const fresh = this.apply(data);
      if (data.messages.length || fresh) this.patch();
      else this.patchStatus();
      if (fresh) this.onNewMessage();
      this.onUpdate(this);
    } catch {
      // Try again next tick.
    }
  }

  // ---------------------------------------------------------------- mounting

  async mount(el) {
    this.unmountListeners();
    this.el = el;
    el.classList.add('cv');
    if (!this.conversation) {
      el.innerHTML = '<p class="loading">Loading…</p>';
      await this.load();
      if (this.el !== el) return;
    }
    this.render();
    this.listen();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.onUpdate(this);
  }

  unmount() {
    if (this.voice) this.stopVoice(false);
    clearInterval(this.timer);
    this.timer = null;
    this.unmountListeners();
    this.el = null;
  }

  unmountListeners() {
    if (this.el && this.handlers) for (const [type, fn] of this.handlers) this.el.removeEventListener(type, fn);
    this.handlers = null;
  }

  // ---------------------------------------------------------------- rendering

  nameOf(email) {
    if (email === this.getMe().email) return 'You';
    return this.conversation?.names?.[email] || this.messages.find((m) => m.authorEmail === email)?.authorName || email;
  }

  activeText() {
    const others = Object.entries(this.active).filter(([, at]) => at);
    if (!others.length) return '';
    if (this.conversation?.type === 'dm') return ago(others[0][1]);
    const now = others.filter(([, at]) => Date.now() - Date.parse(at) < 2 * 60000).length;
    return now ? `${now} active now` : '';
  }

  render() {
    if (!this.el) return;
    const { esc } = this;
    this.el.innerHTML = `
      <div class="cv-messages" aria-live="polite">${this.messagesHtml()}</div>
      <div class="cv-status">${this.statusHtml()}</div>
      <form class="cv-compose" novalidate>
        ${this.replyTo || this.editing ? `<div class="cv-context"><span>${this.editing ? '✎ Editing your message' : `↩ Replying to <b>${esc(this.nameOf(this.replyTo.authorEmail))}</b>: ${esc(this.snippet(this.replyTo))}`}</span><button type="button" class="icon-btn" data-cv="cancel-context" aria-label="Cancel">✕</button></div>` : ''}
        ${this.pending.length || this.uploading ? `<div class="cv-pending">${this.pending.map((f, i) => `<span class="cv-pending-file">${f.preview ? `<img src="${esc(f.preview)}" alt="" />` : '📎'}<small>${esc(f.name)}</small><button type="button" data-cv="unattach" data-i="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join('')}${this.uploading ? `<span class="muted small">Uploading ${this.uploading}…</span>` : ''}</div>` : ''}
        ${this.emojiOpen ? `<div class="cv-emoji" role="listbox" aria-label="Emoji">${EMOJI.map((e) => `<button type="button" data-cv="emoji" data-e="${e}">${e}</button>`).join('')}</div>` : ''}
        ${this.voice ? `<div class="cv-compose-row cv-recording"><button type="button" class="icon-btn" data-cv="voice-cancel" aria-label="Cancel voice message">🗑</button><span class="cv-rec-dot" aria-hidden="true"></span><span class="cv-rec-time">${clock(Date.now() - this.voice.started)}</span><span class="muted small">Recording…</span><button type="button" class="btn primary cv-send" data-cv="voice-send" aria-label="Send voice message">➤</button></div>` : `<div class="cv-compose-row">
          <label class="icon-btn cv-attach" title="Send photos or files" aria-label="Send photos or files"><input type="file" multiple hidden data-cv-file />📎</label>
          <button type="button" class="icon-btn" data-cv="emoji-toggle" title="Emoji" aria-label="Emoji">😊</button>
          <textarea rows="1" maxlength="4000" placeholder="Aa" aria-label="Message">${esc(this.draft)}</textarea>
          ${this.draft.trim() || this.pending.length ? `<button class="btn primary cv-send" type="submit"${this.sending || this.uploading ? ' disabled' : ''} aria-label="Send">➤</button>` : this.quickButtons()}
        </div>`}
      </form>`;
    this.scrollToEnd();
    this.autosize();
  }

  // New or changed messages: redraw the list only, keeping the composer (and what's typed) as it is.
  patch() {
    const box = this.el?.querySelector('.cv-messages');
    if (!box) return this.render();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = this.messagesHtml();
    if (atBottom) box.scrollTop = box.scrollHeight;
    this.patchStatus();
  }

  patchStatus() {
    const node = this.el?.querySelector('.cv-status');
    if (node) node.innerHTML = this.statusHtml();
  }

  scrollToEnd() {
    const box = this.el?.querySelector('.cv-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  autosize() {
    const input = this.el?.querySelector('.cv-compose textarea');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  // With nothing typed: record a voice message, or send a 👍.
  quickButtons() {
    const mic = navigator.mediaDevices?.getUserMedia && window.MediaRecorder ? '<button type="button" class="cv-send quick cv-mic" data-cv="voice-start" aria-label="Record a voice message" title="Record a voice message">🎙</button>' : '';
    return `<span class="cv-send cv-quick-group">${mic}<button type="button" class="cv-send quick" data-cv="quick-like" aria-label="Send a like">👍</button></span>`;
  }

  snippet(m) {
    if (m.deleted) return 'Message unsent';
    return (m.body || '').replace(/\s+/g, ' ').slice(0, 80) || (m.attachments?.length ? `📎 ${m.attachments.length} file${m.attachments.length === 1 ? '' : 's'}` : '');
  }

  statusHtml() {
    if (!this.typing.length) return '';
    const who = this.typing.length === 1 ? this.typing[0] : this.typing.length === 2 ? `${this.typing[0]} and ${this.typing[1]}` : `${this.typing.length} people`;
    return `<span class="cv-typing"><span class="dots"><i></i><i></i><i></i></span>${this.esc(who)} ${this.typing.length === 1 ? 'is' : 'are'} typing…</span>`;
  }

  // "Seen" under my latest message: by the other person in a DM, or by name in a group.
  seenHtml(m) {
    const me = this.getMe().email;
    const mine = [...this.messages].reverse().find((x) => x.authorEmail === me && x.kind !== 'system');
    if (!mine || mine.id !== m.id) return '';
    const seenBy = Object.entries(this.reads).filter(([email, at]) => email !== me && at && at >= m.createdAt).map(([email]) => this.nameOf(email));
    if (!seenBy.length) return '<span class="cv-seen">Sent</span>';
    return `<span class="cv-seen">${this.conversation?.type === 'dm' ? 'Seen' : `Seen by ${this.esc(seenBy.slice(0, 4).join(', '))}${seenBy.length > 4 ? ` +${seenBy.length - 4}` : ''}`}</span>`;
  }

  messagesHtml() {
    const { esc, initial } = this;
    const me = this.getMe().email;
    if (!this.messages.length) return '<p class="empty-list">No messages yet. Say hello 👋</p>';
    let lastDay = '';
    let lastAuthor = '';
    return this.messages
      .map((m) => {
        const day = new Date(m.createdAt).toDateString();
        const divider = day !== lastDay ? `<p class="chat-day">${new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p>` : '';
        if (day !== lastDay) lastAuthor = '';
        lastDay = day;
        if (m.kind === 'system') {
          lastAuthor = '';
          return `${divider}<p class="chat-system">${esc(m.body)}</p>`;
        }
        const mine = m.authorEmail === me;
        const continued = lastAuthor === m.authorEmail;
        lastAuthor = m.authorEmail;
        const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        let content;
        if (m.deleted) content = `<p class="cv-unsent">${mine ? 'You unsent a message' : 'Message unsent'}</p>`;
        else if (m.kind === 'meeting') {
          content = `<div class="chat-meeting"><span aria-hidden="true">📹</span><span><b>Video meeting</b><small>${esc(m.body)}</small></span>${this.joinButton(m.meetingId)}</div>`;
        } else if (m.kind === 'call') {
          // A DM call's summary ("Missed voice call", "Voice call · 2:31"), or a group call to join.
          const group = this.conversation?.type !== 'dm';
          const missed = /^Missed|declined$/.test(m.body || '');
          content = `<div class="chat-call${missed ? ' missed' : ''}"><span class="chat-call-icon" aria-hidden="true">${m.video ? '📹' : '📞'}</span><span><b>${esc(m.body)}</b><small>${m.video ? 'Video' : 'Voice'}</small></span>${group ? this.joinButton(m.meetingId) : this.onCall ? `<button type="button" class="btn small" data-cv="call-back" data-video="${m.video ? '1' : '0'}">Call back</button>` : ''}</div>`;
        } else {
          const images = m.attachments.filter((a) => IMAGE_RE.test(a.type));
          const voices = m.attachments.filter((a) => AUDIO_RE.test(a.type));
          const files = m.attachments.filter((a) => !IMAGE_RE.test(a.type) && !AUDIO_RE.test(a.type));
          content = `
            ${m.replyTo ? `<a class="cv-quote" href="#" data-cv="jump" data-id="${esc(m.replyTo.id)}"><b>${esc(this.nameOf(m.replyTo.authorEmail))}</b>${esc(m.replyTo.snippet)}</a>` : ''}
            ${images.length ? `<div class="cv-images n${Math.min(images.length, 3)}">${images.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /></a>`).join('')}</div>` : ''}
            ${voices.map((a) => `<div class="cv-voice"><span aria-hidden="true">🎙</span><audio controls preload="metadata" src="${esc(a.url)}"></audio></div>`).join('')}
            ${files.map((a) => `<a class="cv-file" href="${esc(a.download)}" target="_blank" rel="noopener"><span aria-hidden="true">📄</span><span><b>${esc(a.name)}</b><small>${sizeText(a.size)}</small></span></a>`).join('')}
            ${m.body ? `<p>${esc(m.body).replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}</p>` : ''}`;
        }
        const bigEmoji = !m.deleted && m.kind === 'text' && !m.attachments.length && !m.replyTo && /^(\p{Extended_Pictographic}|️|‍|\s){1,8}$/u.test(m.body || '');
        return `${divider}
          <div class="chat-msg${mine ? ' mine' : ''}${continued ? ' continued' : ''}" id="cv-${esc(m.id)}" data-id="${esc(m.id)}">
            ${mine ? '' : `<span class="avatar small" title="${esc(m.authorEmail)}">${continued ? '' : initial(m.authorName || m.authorEmail)}</span>`}
            <div class="cv-bubble-wrap">
              ${!mine && !continued && this.conversation?.type !== 'dm' ? `<span class="chat-author">${esc(m.authorName || m.authorEmail)}</span>` : ''}
              <div class="cv-line">
                <div class="chat-bubble${bigEmoji ? ' big-emoji' : ''}${m.deleted ? ' unsent' : ''}" title="${esc(new Date(m.createdAt).toLocaleString())}">
                  ${content}
                  <time>${m.editedAt && !m.deleted ? 'Edited · ' : ''}${time}</time>
                </div>
                ${m.deleted || m.kind !== 'text' ? '' : `<button type="button" class="cv-more" data-cv="menu" data-id="${esc(m.id)}" aria-label="Message actions">⋯</button>`}
              </div>
              ${m.reactions.length ? `<div class="cv-reactions">${m.reactions.map((r) => `<button type="button" class="cv-reaction${r.mine ? ' mine' : ''}" data-cv="react" data-id="${esc(m.id)}" data-e="${r.emoji}" title="${esc(r.names.join(', '))}">${r.emoji}${r.count > 1 ? ` ${r.count}` : ''}</button>`).join('')}</div>` : ''}
              ${this.menuFor === m.id ? this.menuHtml(m, mine) : ''}
              ${mine ? this.seenHtml(m) : ''}
            </div>
          </div>`;
      })
      .join('');
  }

  joinButton(meetingId) {
    if (!meetingId) return '';
    return this.onJoinMeeting
      ? `<button type="button" class="btn small primary" data-cv="join-meeting" data-meeting="${this.esc(meetingId)}">Join</button>`
      : `<a class="btn small primary" href="#/meet/${encodeURIComponent(meetingId)}">Join</a>`;
  }

  // ---------------------------------------------------------------- voice messages

  async startVoice() {
    if (this.voice) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return this.toast('Microphone blocked. Allow it in your browser’s site settings to record.');
    }
    const mimeType = VOICE_TYPES.find((t) => window.MediaRecorder.isTypeSupported?.(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    this.voice = { rec, stream, chunks, started: Date.now(), timer: setInterval(() => {
      const node = this.el?.querySelector('.cv-rec-time');
      if (node && this.voice) node.textContent = clock(Date.now() - this.voice.started);
      // Voice messages stop at 15 minutes.
      if (this.voice && Date.now() - this.voice.started > 15 * 60_000) this.stopVoice(true);
    }, 500) };
    navigator.vibrate?.(30);
    this.render();
  }

  async stopVoice(send) {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    clearInterval(voice.timer);
    await new Promise((resolve) => {
      voice.rec.onstop = resolve;
      if (voice.rec.state === 'inactive') resolve();
      else voice.rec.stop();
    });
    for (const track of voice.stream.getTracks()) track.stop();
    if (!send) return this.render();
    const type = (voice.rec.mimeType || voice.chunks[0]?.type || 'audio/webm').split(';')[0];
    const blob = new Blob(voice.chunks, { type });
    if (Date.now() - voice.started < 800 || !blob.size) {
      this.toast('Tap 🎙, talk, then tap ➤ to send.');
      return this.render();
    }
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    await this.upload([new File([blob], `Voice message ${stamp}.${ext}`, { type })]);
    if (this.pending.length) await this.send('');
  }

  menuHtml(m, mine) {
    return `
      <div class="cv-menu" role="menu">
        <div class="cv-react-bar">${REACTIONS.map((e) => `<button type="button" data-cv="react" data-id="${this.esc(m.id)}" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
        <button type="button" data-cv="reply" data-id="${this.esc(m.id)}">↩ Reply</button>
        ${m.body ? `<button type="button" data-cv="copy" data-id="${this.esc(m.id)}">⧉ Copy</button>` : ''}
        ${mine ? `<button type="button" data-cv="edit" data-id="${this.esc(m.id)}">✎ Edit</button><button type="button" class="danger" data-cv="unsend" data-id="${this.esc(m.id)}">🗑 Unsend</button>` : ''}
      </div>`;
  }

  // ---------------------------------------------------------------- actions

  find(id) {
    return this.messages.find((m) => m.id === id);
  }

  replace(message) {
    const i = this.messages.findIndex((m) => m.id === message.id);
    if (i === -1) this.messages.push(message);
    else this.messages[i] = message;
  }

  async send(text) {
    const body = (text ?? this.draft).trim();
    if (text === '' && !this.pending.length) return;
    if ((!body && !this.pending.length) || this.sending || this.uploading) return;
    this.sending = true;
    try {
      if (this.editing) {
        const { message } = await this.api('PATCH', this.path(`/messages/${encodeURIComponent(this.editing.id)}`), { at: this.editing.at, body });
        this.replace(message);
      } else {
        const { message } = await this.api('POST', this.path('/messages'), {
          body,
          replyTo: this.replyTo ? { id: this.replyTo.id, at: this.replyTo.at } : undefined,
          attachments: this.pending.map(({ key, name, type, size }) => ({ key, name, type, size })),
        });
        this.replace(message);
      }
      if (text === undefined) this.draft = '';
      for (const f of this.pending) if (f.preview) URL.revokeObjectURL(f.preview);
      Object.assign(this, { pending: [], replyTo: null, editing: null, emojiOpen: false });
    } catch (error) {
      this.toast(error.message);
    }
    this.sending = false;
    this.render();
    this.focus();
    this.onUpdate(this);
  }

  focus() {
    const input = this.el?.querySelector('.cv-compose textarea');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async upload(files) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        this.toast(`${file.name} is over 25 MB.`);
        continue;
      }
      this.uploading += 1;
      this.render();
      try {
        const type = file.type || 'application/octet-stream';
        const slot = await this.api('POST', this.path('/uploads'), { name: file.name, type, size: file.size });
        const res = await fetch(slot.url, { method: 'PUT', headers: { 'content-type': slot.type }, body: file });
        if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
        this.pending.push({ key: slot.key, name: slot.name, type: slot.type, size: file.size, preview: IMAGE_RE.test(type) ? URL.createObjectURL(file) : null });
      } catch (error) {
        this.toast(`${file.name}: ${error.message}`);
      }
      this.uploading -= 1;
    }
    this.render();
    this.focus();
  }

  async onClick(event) {
    const target = event.target.closest('[data-cv]');
    if (!target || !this.el.contains(target)) {
      if (this.menuFor && !event.target.closest('.cv-menu')) {
        this.menuFor = null;
        this.patch();
      }
      return;
    }
    const action = target.dataset.cv;
    const m = target.dataset.id && this.find(target.dataset.id);
    if (action === 'jump') {
      event.preventDefault();
      const node = this.el.querySelector(`#cv-${CSS.escape(target.dataset.id)}`);
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node?.classList.add('flash');
      setTimeout(() => node?.classList.remove('flash'), 1200);
      return;
    }
    if (action === 'menu') {
      this.menuFor = this.menuFor === m.id ? null : m.id;
      return this.patch();
    }
    if (action === 'react') {
      this.menuFor = null;
      try {
        const { message } = await this.api('POST', this.path(`/messages/${encodeURIComponent(m.id)}/react`), { at: m.at, emoji: target.dataset.e });
        this.replace(message);
      } catch (error) {
        this.toast(error.message);
      }
      return this.patch();
    }
    if (action === 'reply' || action === 'edit') {
      this.menuFor = null;
      if (action === 'reply') Object.assign(this, { replyTo: m, editing: null });
      else Object.assign(this, { editing: m, replyTo: null, draft: m.body });
      this.render();
      return this.focus();
    }
    if (action === 'copy') {
      this.menuFor = null;
      this.patch();
      try {
        await navigator.clipboard.writeText(m.body);
        this.toast('Copied');
      } catch {}
      return;
    }
    if (action === 'unsend') {
      this.menuFor = null;
      if (!confirm('Unsend this message for everyone?')) return this.patch();
      try {
        const { message } = await this.api('DELETE', `${this.path(`/messages/${encodeURIComponent(m.id)}`)}?at=${encodeURIComponent(m.at)}`);
        this.replace(message);
      } catch (error) {
        this.toast(error.message);
      }
      return this.patch();
    }
    if (action === 'cancel-context') {
      if (this.editing) this.draft = '';
      Object.assign(this, { replyTo: null, editing: null });
      this.render();
      return this.focus();
    }
    if (action === 'unattach') {
      const [removed] = this.pending.splice(Number(target.dataset.i), 1);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return this.render();
    }
    if (action === 'emoji-toggle') {
      this.emojiOpen = !this.emojiOpen;
      this.render();
      return this.focus();
    }
    if (action === 'emoji') {
      const input = this.el.querySelector('.cv-compose textarea');
      const start = input.selectionStart ?? this.draft.length;
      this.draft = `${this.draft.slice(0, start)}${target.dataset.e}${this.draft.slice(input.selectionEnd ?? start)}`;
      this.render();
      const next = this.el.querySelector('.cv-compose textarea');
      next.focus();
      next.setSelectionRange(start + target.dataset.e.length, start + target.dataset.e.length);
      return;
    }
    if (action === 'quick-like') return this.send('👍');
    if (action === 'voice-start') return this.startVoice();
    if (action === 'voice-send') return this.stopVoice(true);
    if (action === 'voice-cancel') return this.stopVoice(false);
    if (action === 'call-back') return this.onCall?.(target.dataset.video === '1');
    if (action === 'join-meeting') return this.onJoinMeeting?.(target.dataset.meeting);
  }

  onInput(event) {
    if (!event.target.matches('.cv-compose textarea')) return;
    const hadText = Boolean(this.draft.trim());
    this.draft = event.target.value;
    this.autosize();
    // Swap the 👍 button for Send (and back) without redrawing the textarea.
    if (hadText !== Boolean(this.draft.trim()) && !this.pending.length) {
      const old = this.el.querySelector('.cv-send');
      old.outerHTML = this.draft.trim()
        ? '<button class="btn primary cv-send" type="submit" aria-label="Send">➤</button>'
        : this.quickButtons();
    }
    if (this.draft.trim() && Date.now() - this.lastTypingPing > TYPING_PING_MS) {
      this.lastTypingPing = Date.now();
      this.api('POST', this.path('/typing')).catch(() => {});
    }
  }

  listen() {
    const handlers = [
      ['click', (e) => this.onClick(e)],
      ['input', (e) => this.onInput(e)],
      ['change', (e) => e.target.matches('[data-cv-file]') && this.upload([...e.target.files])],
      ['submit', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.send();
      }],
      // Enter sends, Shift+Enter adds a line; Escape cancels a reply or edit.
      ['keydown', (e) => {
        if (!e.target.matches('.cv-compose textarea')) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          this.send();
        } else if (e.key === 'Escape' && (this.replyTo || this.editing)) {
          e.stopPropagation();
          if (this.editing) this.draft = '';
          Object.assign(this, { replyTo: null, editing: null });
          this.render();
          this.focus();
        }
      }],
      // Paste a screenshot straight into the chat.
      ['paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) {
          e.preventDefault();
          this.upload(files);
        }
      }],
    ];
    for (const [type, fn] of handlers) this.el.addEventListener(type, fn);
    this.handlers = handlers;
  }
}
