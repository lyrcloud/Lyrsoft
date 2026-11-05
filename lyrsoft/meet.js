// Lyrsoft Work meetings, plugged into app.js like mail.js:
//   #/meetings     upcoming and recent meetings, scheduling (with email invitations), instant calls,
//                  and a screen recorder
//   #/meet/<id>    the meeting's lobby; joining opens the call room
//
// Calls run on Amazon Chime SDK (lyrsoft/chime-sdk.js, loaded only when someone joins). The call room
// lives in its own element on <body>, outside the app's re-rendered area, so navigating or re-rendering
// never cuts the call. The call's chat panel is the meeting's conversation (the same one as in
// Messages), drawn by chat.js's ConversationView. Recording uses the browser's screen capture and MediaRecorder: it records the
// screen, window or tab you pick, with your microphone and the call's audio, and saves a .webm file
// on your device. Nothing is uploaded.
import { attachInviteeField, inviteeField, pickPeople } from './people.js';

export function createMeetings({ api, esc, toast, render, go, initial, formatDateTime, getMe, dialog, chat }) {
  const meet = { list: null, lobby: null, scheduling: false };
  let call = null; // the active call (see joinCall)
  let recorder = null; // the active recording (see startRecording)

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const endsAt = (m) => new Date(m.startsAt).getTime() + m.durationMin * 60_000;
  const whenText = (m) =>
    `${new Date(m.startsAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${m.durationMin} min`;
  const nameOf = (email, names = {}) => names[email] || email;
  const canRecord = () => Boolean(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);
  const copy = async (text, message) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      window.prompt('Copy this link:', text);
    }
  };

  async function load(route) {
    if (route.view === 'meetings') meet.list = await api('GET', '/meetings');
    if (route.view === 'meet' && meet.lobby?.id !== route.meetingId) {
      meet.lobby = null;
      meet.lobby = (await api('GET', `/meetings/${encodeURIComponent(route.meetingId)}`)).meeting;
    }
  }

  const ready = (route) => (route.view === 'meetings' ? Boolean(meet.list) : route.view === 'meet' ? Boolean(meet.lobby) : true);

  // ---------------------------------------------------------------- meetings page

  function meetingRow(m) {
    const now = Date.now();
    const live = new Date(m.startsAt).getTime() - 10 * 60_000 <= now && now <= endsAt(m);
    const people = [m.hostEmail, ...m.invitees];
    return `
      <article class="panel meeting-row${m.cancelled ? ' cancelled' : ''}">
        <div class="meeting-date"><b>${new Date(m.startsAt).toLocaleDateString(undefined, { day: 'numeric' })}</b><span>${new Date(m.startsAt).toLocaleDateString(undefined, { month: 'short' })}</span></div>
        <div class="meeting-main">
          <h3>${esc(m.title)} ${m.cancelled ? '<span class="badge warn">Cancelled</span>' : live ? '<span class="badge ok">● Live now</span>' : ''}</h3>
          <p class="muted">${esc(whenText(m))} · Host ${esc(nameOf(m.hostEmail, m.names))}</p>
          <div class="meeting-people">${people.slice(0, 8).map((e) => `<span class="avatar small" title="${esc(nameOf(e, m.names))}">${initial(nameOf(e, m.names))}</span>`).join('')}${people.length > 8 ? `<span class="muted small">+${people.length - 8}</span>` : ''}<span class="muted small">${people.length} ${people.length === 1 ? 'person' : 'people'}</span></div>
        </div>
        <div class="meeting-actions">
          ${m.cancelled ? '' : `<a class="btn small primary" href="#/meet/${encodeURIComponent(m.id)}">Join</a>`}
          ${m.cancelled ? '' : `<button class="btn small" data-click="meet-copy" data-url="${esc(m.joinUrl)}">🔗 Copy link</button>`}
          ${m.conv ? `<a class="btn small" href="#/chat/${encodeURIComponent(m.conv)}">💬 Chat</a>` : ''}
          ${m.canManage && !m.cancelled ? `<button class="btn small" data-click="meet-invite" data-id="${esc(m.id)}">+ Invite</button><button class="btn small ghost" data-click="meet-cancel" data-id="${esc(m.id)}">Cancel</button>` : ''}
        </div>
      </article>`;
  }

  function scheduleForm() {
    const contacts = meet.list.contacts || [];
    const start = new Date(Date.now() + 60 * 60_000);
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return `
      <section class="panel">
        <div class="panel-head"><h2>Schedule a meeting</h2></div>
        <form class="meeting-form" data-form="meet-schedule">
          <label class="wide">Title<input name="title" required maxlength="120" placeholder="e.g. Weekly project review" /></label>
          <label>Date and time<input name="startsAt" type="datetime-local" required value="${local}" /></label>
          <label>Length<select name="durationMin">${[15, 30, 45, 60, 90, 120].map((n) => `<option value="${n}"${n === 30 ? ' selected' : ''}>${n} minutes</option>`).join('')}</select></label>
          <div class="wide invitee-label">
            <span>Invite people</span>
            ${inviteeField({ placeholder: contacts.length ? 'Type a name or email…' : 'Type an email address…' })}
            <div class="row"><button type="button" class="btn small" data-click="meet-browse"${contacts.length ? '' : ' hidden'}>👥 Choose from your people</button><span class="muted small">Suggestions appear as you type. Anyone with an email can be invited.</span></div>
          </div>
          <label class="check wide"><input type="checkbox" name="notify" checked /> Email the invitation with a Join link</label>
          <div class="row wide"><button class="btn primary" type="submit"${meet.scheduling ? ' disabled' : ''}>Schedule and invite</button><span class="muted small">Times are in your time zone (${esc(timeZone)}).</span></div>
        </form>
      </section>`;
  }

  function meetingsView() {
    const meetings = meet.list.meetings;
    const upcoming = meetings.filter((m) => !m.cancelled && endsAt(m) >= Date.now());
    const past = meetings.filter((m) => m.cancelled || endsAt(m) < Date.now()).reverse();
    return `
      <div class="page-head">
        <div><h1>Meetings</h1><p>Video calls with your team and clients: schedule, invite, join, share your screen and record.</p></div>
        <div class="page-actions">
          <button class="btn" data-click="meet-record"${canRecord() ? '' : ' disabled title="Screen recording needs Chrome, Edge or Firefox on a computer"'}>${recorder ? '■ Stop recording' : '⏺ Record screen'}</button>
          <button class="btn primary" data-click="meet-instant">📹 Start a call now</button>
        </div>
      </div>
      <div class="meetings-grid">
        <div>
          <h2 class="section-title">Upcoming</h2>
          ${upcoming.map(meetingRow).join('') || '<section class="panel empty"><p>No upcoming meetings. Schedule one, or start a call now.</p></section>'}
          ${past.length ? `<h2 class="section-title">Earlier</h2>${past.slice(0, 20).map(meetingRow).join('')}` : ''}
        </div>
        <div>${scheduleForm()}</div>
      </div>`;
  }

  function lobbyView() {
    const m = meet.lobby;
    const inCall = call?.meetingId === m.id;
    return `
      <section class="panel lobby">
        <span class="lobby-icon" aria-hidden="true">📹</span>
        <h1>${esc(m.title)}</h1>
        <p class="muted">${esc(whenText(m))} · Host ${esc(nameOf(m.hostEmail, m.names))}</p>
        ${
          m.cancelled
            ? '<p class="auth-error">This meeting was cancelled.</p>'
            : inCall
              ? '<p>You’re in this call. <button class="btn small" data-click="meet-show-call">Return to call</button></p>'
              : `<div class="row lobby-buttons">
                  <button class="btn primary big" data-click="meet-join" data-video="1">Join with camera</button>
                  <button class="btn big" data-click="meet-join" data-video="0">Join with audio only</button>
                </div>
                <p class="muted small">Your browser will ask to use your microphone${' '}and camera.</p>`
        }
        <div class="row lobby-links">
          <button class="btn small ghost" data-click="meet-copy" data-url="${esc(m.joinUrl)}">🔗 Copy invite link</button>
          ${m.conv ? `<a class="btn small ghost" href="#/chat/${encodeURIComponent(m.conv)}">💬 Meeting chat</a>` : ''}
          ${m.canManage && !m.cancelled ? `<button class="btn small ghost" data-click="meet-invite" data-id="${esc(m.id)}">+ Invite people</button>` : ''}
          <a class="btn small ghost" href="#/meetings">All meetings</a>
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------- the call

  function callRoot() {
    let root = document.getElementById('call-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'call-root';
      document.body.append(root);
    }
    return root;
  }

  function renderCall() {
    const root = callRoot();
    if (!call) {
      root.replaceChildren();
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.classList.toggle('minimized', call.minimized);
    if (!root.querySelector('.call')) {
      root.innerHTML = `
        <div class="call" role="dialog" aria-label="Video call">
          <header class="call-head">
            <b class="call-title"></b><span class="call-status muted"></span><span class="rec-indicator" hidden>● REC <span class="rec-time">0:00</span></span>
            <button class="icon-btn call-min" data-call="minimize" title="Minimize">▁</button>
          </header>
          <div class="call-body">
            <div class="call-stage"><div class="call-content" hidden></div><div class="call-grid"></div></div>
            <aside class="call-chat" hidden aria-label="Meeting chat">
              <header><b>💬 Meeting chat</b><a class="small" href="#/chat/${encodeURIComponent(call.conv || '')}" data-call="open-messages" title="Open in Messages (the call keeps going)">Open in Messages</a><button class="icon-btn" data-call="chat" aria-label="Close chat">✕</button></header>
              <div class="call-chat-host"></div>
            </aside>
          </div>
          <footer class="call-controls">
            <button class="call-btn" data-call="mic"></button>
            <button class="call-btn" data-call="camera"></button>
            <button class="call-btn" data-call="flip" hidden>🔄<span>Flip</span></button>
            <button class="call-btn" data-call="share"></button>
            <button class="call-btn" data-call="record"></button>
            <button class="call-btn" data-call="chat">💬<span>Chat</span></button>
            <button class="call-btn" data-call="invite">🔗<span>Invite</span></button>
            <button class="call-btn leave" data-call="leave">✆<span>Leave</span></button>
          </footer>
          <audio class="call-audio" autoplay></audio>
        </div>`;
      root.addEventListener('click', onCallClick);
      mountCallChat();
    }
    root.querySelector('.call-title').textContent = call.title;
    root.querySelector('.call-status').textContent = call.status;
    const set = (name, on, onLabel, offLabel, onIcon, offIcon, disabled = false) => {
      const button = root.querySelector(`[data-call="${name}"]`);
      button.innerHTML = `${on ? onIcon : offIcon}<span>${on ? onLabel : offLabel}</span>`;
      button.classList.toggle('off', !on);
      button.disabled = disabled;
    };
    set('mic', !call.muted, 'Mute', 'Unmute', '🎙', '🔇');
    set('camera', call.camera, 'Stop video', 'Start video', '📷', '🚫');
    // Flip shows while the camera is on and there's more than one camera (phones), or the count isn't known yet.
    root.querySelector('[data-call="flip"]').hidden = !call.camera || call.cameraCount === 1;
    set('share', call.sharing, 'Stop sharing', 'Share screen', '🖥', '🖥', !navigator.mediaDevices?.getDisplayMedia);
    set('record', Boolean(recorder), 'Stop recording', 'Record', '⏹', '⏺', !canRecord());
    root.querySelector('[data-call="share"]').classList.toggle('active', call.sharing);
    root.querySelector('[data-call="record"]').classList.toggle('active', Boolean(recorder));
    const chatButton = root.querySelector('.call-controls [data-call="chat"]');
    chatButton.classList.toggle('active', call.chatOpen);
    chatButton.innerHTML = `💬<span>Chat</span>${call.chatUnread && !call.chatOpen ? `<b class="call-badge">${call.chatUnread}</b>` : ''}`;
    chatButton.hidden = !call.conv;
    root.querySelector('.call-chat').hidden = !call.chatOpen;
    root.querySelector('.call').classList.toggle('chat-open', call.chatOpen);
    renderTiles();
  }

  // One tile per person in the call; their video (or their initial) fills it. Shared screens get the big stage.
  function renderTiles() {
    const root = callRoot();
    const grid = root.querySelector('.call-grid');
    const content = root.querySelector('.call-content');
    if (!grid) return;
    const people = [...call.people.values()];
    grid.dataset.count = String(Math.min(people.length, 9));
    for (const person of people) {
      let tile = grid.querySelector(`[data-attendee="${CSS.escape(person.attendeeId)}"]`);
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'call-tile';
        tile.dataset.attendee = person.attendeeId;
        tile.innerHTML = '<video autoplay playsinline muted></video><span class="tile-avatar"></span><span class="tile-name"></span>';
        grid.append(tile);
      }
      tile.querySelector('.tile-avatar').textContent = initial(person.name);
      tile.querySelector('.tile-name').textContent = `${person.name}${person.local ? ' (you)' : ''}${person.muted ? ' 🔇' : ''}`;
      tile.classList.toggle('has-video', Boolean(person.tileId));
      tile.classList.toggle('speaking', Boolean(person.speaking));
    }
    for (const tile of grid.querySelectorAll('.call-tile')) {
      if (!call.people.has(tile.dataset.attendee)) tile.remove();
    }
    content.hidden = !call.contentTileId;
    root.querySelector('.call-stage').classList.toggle('with-content', Boolean(call.contentTileId));
  }

  // The chat panel stays mounted (hidden) for the whole call, so new messages count up on the button.
  function mountCallChat() {
    if (!call?.conv || !chat) return;
    const host = callRoot().querySelector('.call-chat-host');
    const view = chat.viewFor(call.conv);
    view.onNewMessage = () => {
      if (!call || call.chatOpen) return;
      call.chatUnread = (call.chatUnread || 0) + 1;
      renderCall();
    };
    call.chatView = view;
    view.mount(host).catch(() => {});
  }

  function toggleCallChat() {
    call.chatOpen = !call.chatOpen;
    if (call.chatOpen) {
      call.chatUnread = 0;
      // If Messages took the conversation meanwhile, bring it back into the panel.
      const host = callRoot().querySelector('.call-chat-host');
      if (call.chatView && call.chatView.el !== host) call.chatView.mount(host).catch(() => {});
    }
    renderCall();
    if (call.chatOpen) {
      call.chatView?.scrollToEnd();
      if (window.matchMedia('(pointer: fine)').matches) call.chatView?.focus();
    }
  }

  async function joinCall(meetingId, withVideo) {
    if (call) {
      if (call.meetingId === meetingId) return showCall();
      await leaveCall();
    }
    toast('Connecting…');
    const data = await api('POST', `/meetings/${encodeURIComponent(meetingId)}/join`);
    const sdk = await import('./chime-sdk.js');
    const logger = new sdk.ConsoleLogger('lyrsoft-meet', sdk.LogLevel.WARN);
    const deviceController = new sdk.DefaultDeviceController(logger);
    const session = new sdk.DefaultMeetingSession(new sdk.MeetingSessionConfiguration(data.chime.meeting, data.chime.attendee), logger, deviceController);
    const av = session.audioVideo;
    const me = getMe();
    call = {
      meetingId,
      title: data.meeting.title,
      joinUrl: data.meeting.joinUrl,
      conv: data.conv || data.meeting.conv,
      meeting: data.meeting,
      chatOpen: false,
      chatUnread: 0,
      chatView: null,
      names: data.names || {},
      session,
      av,
      selfId: data.chime.attendee.AttendeeId,
      people: new Map(),
      muted: false,
      camera: false,
      facing: 'user', // front camera first
      cameraDeviceId: null,
      cameraCount: null,
      sharing: false,
      contentTileId: null,
      minimized: false,
      status: 'Connecting…',
    };
    const personFor = (attendeeId, externalUserId) => {
      // Content shares join as "<attendeeId>#content"; they aren't people.
      if (attendeeId.includes('#content')) return null;
      if (!call.people.has(attendeeId)) {
        const email = externalUserId || '';
        call.people.set(attendeeId, { attendeeId, email, name: attendeeId === call.selfId ? me.name || me.email : nameOf(email, call.names), local: attendeeId === call.selfId });
      }
      return call.people.get(attendeeId);
    };
    personFor(call.selfId, me.email);

    av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present, externalUserId) => {
      if (!call) return;
      if (!present) call.people.delete(attendeeId);
      else {
        const person = personFor(attendeeId, externalUserId);
        if (person) {
          av.realtimeSubscribeToVolumeIndicator(attendeeId, (_id, volume, muted) => {
            if (!call?.people.has(attendeeId)) return;
            const p = call.people.get(attendeeId);
            const speaking = (volume || 0) > 0.15;
            if (p.speaking !== speaking || p.muted !== Boolean(muted)) {
              Object.assign(p, { speaking, muted: Boolean(muted) });
              renderTiles();
            }
          });
        }
      }
      call.status = `${call.people.size} in call`;
      renderCall();
    });

    av.addObserver({
      videoTileDidUpdate(tile) {
        if (!call || !tile.boundAttendeeId) return;
        renderCall();
        if (tile.isContent) {
          call.contentTileId = tile.tileId;
          renderTiles();
          let video = callRoot().querySelector('.call-content video');
          if (!video) {
            callRoot().querySelector('.call-content').innerHTML = '<video autoplay playsinline muted></video><span class="tile-name">Shared screen</span>';
            video = callRoot().querySelector('.call-content video');
          }
          av.bindVideoElement(tile.tileId, video);
          return;
        }
        const person = personFor(tile.boundAttendeeId, tile.boundExternalUserId);
        if (!person) return;
        person.tileId = tile.tileId;
        renderTiles();
        const video = callRoot().querySelector(`[data-attendee="${CSS.escape(tile.boundAttendeeId)}"] video`);
        if (video) av.bindVideoElement(tile.tileId, video);
        video?.classList.toggle('mirror', Boolean(tile.localTile) && call.facing !== 'environment');
      },
      videoTileWasRemoved(tileId) {
        if (!call) return;
        if (call.contentTileId === tileId) {
          call.contentTileId = null;
          callRoot().querySelector('.call-content').innerHTML = '';
        }
        for (const person of call.people.values()) if (person.tileId === tileId) person.tileId = null;
        renderTiles();
      },
      audioVideoDidStart() {
        if (!call) return;
        call.status = `${call.people.size} in call`;
        renderCall();
      },
      audioVideoDidStop(status) {
        if (!call) return;
        const code = status?.statusCode?.();
        cleanupCall();
        // 1 = MeetingSessionStatusCode.Left (you left); anything else (meeting ended, network) is worth saying.
        if (code !== undefined && code !== 1) toast('The call ended.');
      },
      contentShareDidStop() {
        if (!call) return;
        call.sharing = false;
        renderCall();
      },
    });

    renderCall();
    try {
      const mics = await av.listAudioInputDevices();
      if (mics.length) await av.startAudioInput(mics[0].deviceId);
      else toast('No microphone found. Others won’t hear you.');
    } catch {
      toast('Microphone blocked. Allow it in your browser’s site settings to talk.');
    }
    await av.bindAudioElement(callRoot().querySelector('.call-audio'));
    av.start();
    if (withVideo) await toggleCamera();
    history.replaceState(null, '', `#/meet/${encodeURIComponent(meetingId)}`);
    render();
  }

  // Cameras: phones have a front ("user") and a rear ("environment") one. Asking by facing mode works
  // on phones whatever the cameras are called; computers with one camera just get that one.
  async function startCamera(facing) {
    const { av } = call;
    try {
      await av.startVideoInput({ facingMode: { exact: facing } });
    } catch {
      // No camera facing that way (most computers): use the next camera in the list instead.
      const cameras = await av.listVideoInputDevices();
      if (!cameras.length) throw new Error('No camera found.');
      const current = call.cameraDeviceId;
      const next = cameras[(cameras.findIndex((c) => c.deviceId === current) + 1) % cameras.length] || cameras[0];
      await av.startVideoInput(next.deviceId);
      call.cameraDeviceId = next.deviceId;
    }
    call.facing = facing;
    call.cameraCount = (await av.listVideoInputDevices().catch(() => [])).length;
  }

  async function toggleCamera() {
    const { av } = call;
    try {
      if (call.camera) {
        av.stopLocalVideoTile();
        await av.stopVideoInput();
        call.camera = false;
      } else {
        await startCamera(call.facing || 'user');
        av.startLocalVideoTile();
        call.camera = true;
      }
    } catch (error) {
      toast(error.message === 'No camera found.' ? 'No camera found.' : 'Camera blocked. Allow it in your browser’s site settings.');
    }
    renderCall();
    mirrorSelf();
  }

  // Switches between the front and rear camera while the video keeps going.
  async function flipCamera() {
    if (!call.camera) return;
    try {
      await startCamera(call.facing === 'environment' ? 'user' : 'environment');
      toast(call.facing === 'environment' ? 'Rear camera' : 'Front camera');
    } catch {
      toast('Couldn’t switch camera.');
    }
    renderCall();
    mirrorSelf();
  }

  // Your own front-camera picture is mirrored, like a mirror; the rear camera isn't, so text reads right.
  function mirrorSelf() {
    const self = call && callRoot().querySelector(`[data-attendee="${CSS.escape(call.selfId)}"] video`);
    self?.classList.toggle('mirror', call.facing !== 'environment');
  }

  async function toggleShare() {
    try {
      if (call.sharing) {
        await call.av.stopContentShare();
        call.sharing = false;
      } else {
        await call.av.startContentShareFromScreenCapture();
        call.sharing = true;
      }
    } catch {
      call.sharing = false;
      toast('Screen sharing was cancelled or isn’t supported on this device.');
    }
    renderCall();
  }

  function cleanupCall() {
    if (!call) return;
    const { av, chatView } = call;
    call = null;
    if (chatView?.el?.closest('#call-root')) chatView.unmount();
    if (chatView) chatView.onNewMessage = () => {};
    try {
      av.stopLocalVideoTile();
      av.stopVideoInput();
      av.stopAudioInput();
      av.stopContentShare();
    } catch {}
    renderCall();
    render();
  }

  async function leaveCall() {
    if (!call) return;
    const { av } = call;
    try {
      av.stop();
    } catch {}
    cleanupCall();
  }

  function showCall() {
    if (!call) return;
    call.minimized = false;
    renderCall();
  }

  async function onCallClick(event) {
    const button = event.target.closest('[data-call]');
    if (!button || !call) return;
    const action = button.dataset.call;
    if (action === 'mic') {
      call.muted ? call.av.realtimeUnmuteLocalAudio() : call.av.realtimeMuteLocalAudio();
      call.muted = !call.muted;
      renderCall();
    } else if (action === 'camera') await toggleCamera();
    else if (action === 'flip') await flipCamera();
    else if (action === 'share') await toggleShare();
    else if (action === 'record') await toggleRecording();
    else if (action === 'invite') {
      if (call.meeting?.canManage) await promptInvite(call.meeting);
      else await copy(call.joinUrl, 'Invite link copied. Ask the host to invite people who aren’t on the list.');
    }
    else if (action === 'chat') toggleCallChat();
    else if (action === 'open-messages') {
      // The link navigates; shrink the call so Messages shows, and the call keeps going.
      call.minimized = true;
      call.chatOpen = false;
      renderCall();
    }
    else if (action === 'minimize') {
      call.minimized = !call.minimized;
      renderCall();
    } else if (action === 'leave') await leaveCall();
  }

  // ---------------------------------------------------------------- recording

  async function toggleRecording() {
    if (recorder) return stopRecording();
    if (!canRecord()) return toast('Screen recording needs Chrome, Edge or Firefox on a computer.');
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      return toast('Recording was cancelled.');
    }
    // Mix the screen's own audio, your microphone and (in a call) everyone else into one track.
    const context = new AudioContext();
    const mix = context.createMediaStreamDestination();
    const extra = [];
    if (display.getAudioTracks().length) context.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(mix);
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
      extra.push(mic);
      context.createMediaStreamSource(mic).connect(mix);
    } catch {}
    const callAudio = document.querySelector('#call-root .call-audio')?.srcObject;
    if (callAudio?.getAudioTracks?.().length) context.createMediaStreamSource(callAudio).connect(mix);
    const stream = new MediaStream([...display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    const chunks = [];
    const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    media.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    media.onstop = () => {
      const type = media.mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Lyrsoft recording ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      for (const track of [...display.getTracks(), ...extra.flatMap((s) => s.getTracks())]) track.stop();
      context.close();
      toast(`Recording saved (${Math.max(1, Math.round(blob.size / 1024 / 1024))} MB) to your downloads.`);
    };
    // Stopping the share from the browser's own bar ends the recording too.
    display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
    media.start(1000);
    const startedAt = Date.now();
    recorder = {
      media,
      timer: setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        for (const node of document.querySelectorAll('.rec-time')) node.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }, 1000),
    };
    for (const node of document.querySelectorAll('.rec-indicator')) node.hidden = false;
    toast(call ? 'Recording. Let everyone in the call know.' : 'Recording your screen.');
    if (call) renderCall();
    render();
  }

  function stopRecording() {
    if (!recorder) return;
    const { media, timer } = recorder;
    recorder = null;
    clearInterval(timer);
    if (media.state !== 'inactive') media.stop();
    for (const node of document.querySelectorAll('.rec-indicator')) node.hidden = true;
    if (call) renderCall();
    render();
  }

  // ---------------------------------------------------------------- page actions

  // Everyone I can invite: people who share a workspace with me (staff: everyone).
  async function contacts() {
    if (!meet.contacts) meet.contacts = meet.list?.contacts || (await api('GET', '/meetings')).contacts;
    return meet.contacts;
  }

  // The invite pop-up: search existing people, or type any email. `meeting` is the API's meeting.
  async function promptInvite(meeting) {
    const id = meeting.id;
    const choosing = pickPeople({
      contacts: await contacts(),
      title: `Invite people to “${meeting.title}”`,
      allowEmail: true,
      exclude: [meeting.hostEmail, ...meeting.invitees],
      submitLabel: 'Send invitations',
      extraHtml: `<p class="muted small invite-link-row">Or share the link: <button type="button" class="btn small ghost" data-copy-link>🔗 Copy invite link</button></p>`,
    });
    document.querySelector('.people-dialog [data-copy-link]')?.addEventListener('click', () => copy(meeting.joinUrl, 'Invite link copied'));
    const picked = await choosing;
    if (!picked) return;
    try {
      const { meeting: updated, emailed } = await api('POST', `/meetings/${encodeURIComponent(id)}/invite`, { invitees: picked.emails });
      if (meet.lobby?.id === id) meet.lobby = updated;
      if (meet.list) meet.list.meetings = meet.list.meetings.map((m) => (m.id === id ? updated : m));
      if (call?.meetingId === id) call.meeting = updated;
      toast(`Invited ${picked.emails.length} ${picked.emails.length === 1 ? 'person' : 'people'}. ${emailed} email${emailed === 1 ? '' : 's'} sent.`);
      render();
    } catch (error) {
      toast(error.message);
    }
  }

  const clickActions = {
    'meet-join': async (target) => {
      try {
        await joinCall(meet.lobby.id, target.dataset.video === '1');
      } catch (error) {
        cleanupCall();
        toast(error.message || 'Couldn’t join the call.');
      }
    },
    'meet-show-call': () => showCall(),
    'meet-copy': (target) => copy(target.dataset.url, 'Meeting link copied'),
    'meet-invite': (target) => {
      const meeting = meet.lobby?.id === target.dataset.id ? meet.lobby : meet.list?.meetings.find((m) => m.id === target.dataset.id);
      if (meeting) promptInvite(meeting);
    },
    'meet-browse': async () => {
      const field = document.querySelector('.meeting-form [data-invitee-field]');
      const picked = await pickPeople({ contacts: await contacts(), title: 'Choose people to invite', allowEmail: true, exclude: field.chosenEmails(), submitLabel: 'Add' });
      if (picked) field.addPeople(picked.emails.map((email) => ({ email })));
    },
    'meet-cancel': async (target) => {
      if (!confirm('Cancel this meeting? Everyone invited gets an email.')) return;
      try {
        await api('DELETE', `/meetings/${encodeURIComponent(target.dataset.id)}`);
        meet.list = await api('GET', '/meetings');
        render();
        toast('Meeting cancelled');
      } catch (error) {
        toast(error.message);
      }
    },
    'meet-instant': async () => {
      try {
        const { meeting } = await api('POST', '/meetings', { title: `${getMe().name || getMe().email}’s call`, durationMin: 60, timeZone, notify: false });
        go(`#/meet/${encodeURIComponent(meeting.id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
    'meet-record': () => toggleRecording(),
  };

  const formActions = {
    'meet-schedule': async (form, data) => {
      meet.scheduling = true;
      form.querySelector('[type="submit"]').disabled = true;
      try {
        const { meeting, emailed } = await api('POST', '/meetings', {
          title: data.get('title'),
          startsAt: new Date(data.get('startsAt')).toISOString(),
          durationMin: Number(data.get('durationMin')),
          invitees: data.get('invitees'),
          timeZone,
          notify: data.get('notify') === 'on',
        });
        meet.list = await api('GET', '/meetings');
        toast(`“${meeting.title}” scheduled${emailed ? `. ${emailed} invitation${emailed === 1 ? '' : 's'} emailed.` : '.'}`);
      } catch (error) {
        toast(error.message);
      }
      meet.scheduling = false;
      render();
    },
  };

  // Leaving the page mid-call ends it cleanly for everyone else.
  window.addEventListener('pagehide', () => call?.av.stop());

  return {
    load,
    ready,
    view: (route) => (route.view === 'meetings' ? meetingsView() : lobbyView()),
    // The schedule form's invitee field needs its suggestions wired up after each render.
    afterRender: () => attachInviteeField(document, () => meet.contacts || meet.list?.contacts || []),
    // A small "back to call" bar on every page while a call is minimized.
    banner: () =>
      call && call.minimized
        ? `<button class="call-return" data-click="meet-show-call">📹 In call: ${esc(call.title)} · Return</button>`
        : '',
    clickActions,
    formActions,
  };
}
