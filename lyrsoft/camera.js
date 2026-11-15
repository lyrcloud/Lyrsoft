// The message box's camera: take a photo or record a video, look at it, then attach it to the message
// (a caption can be typed before sending). openCamera() resolves with a File, or null if closed.
// Without camera access in the page (old browsers), it falls back to the phone's own camera picker.
import { icon } from './icons.js';

const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const VIDEO_MAX_MS = 2.5 * 60_000; // keeps a video under the 25 MB attachment limit
const VIDEO_MAX_BYTES = 24 * 1024 * 1024;
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

function pickFile() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,video/*' });
    input.setAttribute('capture', 'environment');
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.click();
  });
}

export function openCamera({ toast = () => {} } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) return pickFile();
  return new Promise((resolve) => {
    const s = { facing: 'user', mode: 'photo', stream: null, rec: null, chunks: [], started: 0, timer: null, result: null, url: null, cameras: 0 };
    const root = document.createElement('div');
    root.className = 'cam';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Camera');
    root.innerHTML = `
      <video class="cam-live" autoplay playsinline muted></video>
      <div class="cam-shot" hidden></div>
      <div class="cam-top">
        <button type="button" class="cam-round" data-cam="close" aria-label="Close camera">${icon('close')}</button>
        <span class="cam-time" hidden>0:00</span>
        <button type="button" class="cam-round" data-cam="flip" aria-label="Switch camera" hidden>${icon('flip')}</button>
      </div>
      <div class="cam-bottom">
        <div class="cam-modes" role="tablist"><button type="button" role="tab" data-cam="mode" data-mode="photo" class="on">Photo</button><button type="button" role="tab" data-cam="mode" data-mode="video">Video</button></div>
        <div class="cam-row cam-take"><span></span><button type="button" class="cam-shutter" data-cam="shutter" aria-label="Take photo"><i></i></button><span></span></div>
        <div class="cam-row cam-review" hidden>
          <button type="button" class="cam-pill" data-cam="retake">${icon('back')}<span>Retake</span></button>
          <button type="button" class="cam-pill go" data-cam="use">${icon('check')}<span>Attach</span></button>
        </div>
      </div>`;
    document.body.append(root);
    document.body.classList.add('cam-open');
    const $ = (sel) => root.querySelector(sel);
    const live = $('.cam-live');

    const stopStream = () => {
      for (const t of s.stream?.getTracks() || []) t.stop();
      s.stream = null;
    };
    async function start() {
      stopStream();
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: s.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: s.mode === 'video' ? { echoCancellation: true, noiseSuppression: true } : false,
        });
      } catch (error) {
        if (error?.name === 'OverconstrainedError' && s.facing === 'environment') {
          s.facing = 'user';
          return start();
        }
        toast('Camera blocked. Allow the camera (and microphone for video) in your settings.');
        return finish(null);
      }
      live.srcObject = s.stream;
      live.classList.toggle('mirror', s.facing === 'user');
      if (!s.cameras) s.cameras = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput').length;
      $('[data-cam="flip"]').hidden = s.cameras === 1;
    }

    function finish(file) {
      clearInterval(s.timer);
      if (s.rec?.state === 'recording') {
        s.rec.onstop = null;
        s.rec.stop();
      }
      stopStream();
      if (s.url && !file) URL.revokeObjectURL(s.url);
      document.removeEventListener('keydown', onKey);
      root.classList.add('closing');
      setTimeout(() => root.remove(), 180);
      document.body.classList.remove('cam-open');
      resolve(file);
    }

    function review(file) {
      s.result = file;
      s.url = URL.createObjectURL(file);
      const shot = $('.cam-shot');
      shot.innerHTML = file.type.startsWith('video/')
        ? `<video src="${s.url}" autoplay loop playsinline controls></video>`
        : `<img src="${s.url}" alt="Your photo" />`;
      shot.hidden = false;
      live.hidden = true;
      stopStream();
      $('.cam-take').hidden = true;
      $('.cam-modes').hidden = true;
      $('.cam-review').hidden = false;
      $('[data-cam="flip"]').hidden = true;
      $('.cam-time').hidden = true;
    }

    async function retake() {
      URL.revokeObjectURL(s.url);
      s.result = s.url = null;
      $('.cam-shot').hidden = true;
      $('.cam-shot').innerHTML = '';
      live.hidden = false;
      $('.cam-take').hidden = false;
      $('.cam-modes').hidden = false;
      $('.cam-review').hidden = true;
      await start();
    }

    function takePhoto() {
      if (!live.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = live.videoWidth;
      canvas.height = live.videoHeight;
      canvas.getContext('2d').drawImage(live, 0, 0);
      root.classList.add('flash');
      setTimeout(() => root.classList.remove('flash'), 250);
      canvas.toBlob((blob) => blob && review(new File([blob], `Photo ${stamp()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.88);
    }

    function toggleVideo() {
      if (s.rec?.state === 'recording') return s.rec.stop();
      if (!window.MediaRecorder) return toast('This browser can’t record video.');
      const mimeType = VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
      s.chunks = [];
      let size = 0;
      s.rec = new MediaRecorder(s.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000 });
      s.rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        s.chunks.push(e.data);
        size += e.data.size;
        if (size > VIDEO_MAX_BYTES && s.rec.state === 'recording') s.rec.stop();
      };
      s.rec.onstop = () => {
        clearInterval(s.timer);
        root.classList.remove('recording');
        const type = (s.rec.mimeType || 'video/webm').split(';')[0];
        const blob = new Blob(s.chunks, { type });
        if (blob.size) review(new File([blob], `Video ${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type }));
      };
      s.rec.start(500);
      s.started = Date.now();
      root.classList.add('recording');
      $('.cam-time').hidden = false;
      $('.cam-time').textContent = '0:00';
      s.timer = setInterval(() => {
        const ms = Date.now() - s.started;
        $('.cam-time').textContent = clock(ms);
        if (ms >= VIDEO_MAX_MS && s.rec.state === 'recording') s.rec.stop();
      }, 250);
    }

    async function setMode(mode) {
      if (s.mode === mode || s.rec?.state === 'recording') return;
      s.mode = mode;
      for (const b of root.querySelectorAll('[data-cam="mode"]')) b.classList.toggle('on', b.dataset.mode === mode);
      root.classList.toggle('video-mode', mode === 'video');
      $('.cam-shutter').setAttribute('aria-label', mode === 'video' ? 'Start or stop recording' : 'Take photo');
      await start(); // video needs the microphone too
    }

    root.addEventListener('click', async (event) => {
      const b = event.target.closest('[data-cam]');
      if (!b) return;
      const what = b.dataset.cam;
      if (what === 'close') finish(null);
      else if (what === 'flip') {
        if (s.rec?.state === 'recording') return;
        s.facing = s.facing === 'user' ? 'environment' : 'user';
        b.classList.remove('spin');
        void b.offsetWidth;
        b.classList.add('spin');
        await start();
      } else if (what === 'mode') await setMode(b.dataset.mode);
      else if (what === 'shutter') (s.mode === 'photo' ? takePhoto() : toggleVideo());
      else if (what === 'retake') await retake();
      else if (what === 'use') finish(s.result);
    });
    // Swipe left/right on the picture to switch Photo/Video, like a phone camera.
    let x0 = null;
    live.addEventListener('pointerdown', (e) => (x0 = e.clientX));
    live.addEventListener('pointerup', (e) => {
      if (x0 !== null && Math.abs(e.clientX - x0) > 60) setMode(e.clientX < x0 ? 'video' : 'photo');
      x0 = null;
    });
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      if ((e.key === ' ' || e.key === 'Enter') && !s.result && !e.target.closest?.('button')) {
        e.preventDefault();
        $('.cam-shutter').click();
      }
    };
    document.addEventListener('keydown', onKey);
    start();
  });
}
