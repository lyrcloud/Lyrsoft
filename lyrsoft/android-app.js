// "Get the Lyr Chat app" bar for Android visitors (home page and Lyr Chat). The APK is built from
// mobile/ and served at /download/lyrchat.apk (scripts/deploy-lyrsoft.sh uploads it). Hidden inside
// the app itself (its user agent ends in LyrChatApp) and for 30 days after someone closes it.
export const APK_URL = '/download/lyrchat.apk';
const KEY = 'lyr-apk-bar-closed';
const DAYS = 30;

export const isAndroid = () => /Android/i.test(navigator.userAgent);
export const inApp = () => /LyrChatApp/.test(navigator.userAgent) || Boolean(window.Capacitor?.isNativePlatform?.());

function closedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) || 0) < DAYS * 86400000;
  } catch {
    return false;
  }
}

// top: true keeps it clear of a chat's message box at the bottom of the screen.
export function showAndroidAppBar({ top = false } = {}) {
  if (!isAndroid() || inApp() || closedRecently() || document.querySelector('.lyr-apk-bar')) return;
  const style = document.createElement('style');
  style.textContent = `
    .lyr-apk-bar { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 9999; display: flex; align-items: center; gap: 12px;
      padding: 12px 14px; border-radius: 14px; background: #1d1b2f; color: #fff; box-shadow: 0 8px 30px rgba(0,0,0,.25);
      font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .lyr-apk-bar img { width: 40px; height: 40px; border-radius: 10px; flex: none; }
    .lyr-apk-bar div { flex: 1; min-width: 0; }
    .lyr-apk-bar b { display: block; }
    .lyr-apk-bar small { opacity: .8; }
    .lyr-apk-bar a { flex: none; padding: 9px 14px; border-radius: 999px; background: #6247ea; color: #fff; font-weight: 600; text-decoration: none; }
    .lyr-apk-bar button { flex: none; width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: #fff; font-size: 20px; cursor: pointer; }
    .lyr-apk-bar.top { top: 12px; bottom: auto; }`;
  const bar = document.createElement('div');
  bar.className = `lyr-apk-bar${top ? ' top' : ''}`;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Lyr Chat Android app');
  bar.innerHTML = `<img src="/brand/icon-192.png" alt="" onerror="this.remove()" />
    <div><b>Lyr Chat for Android</b><small>Messages and calls in an app.</small></div>
    <a href="${APK_URL}" download="LyrChat.apk">Download</a>
    <button type="button" aria-label="Close">×</button>`;
  bar.querySelector('button').addEventListener('click', () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* private mode: it just shows again next time */
    }
    bar.remove();
  });
  // After tapping Download, explain the one-time "install unknown apps" step.
  bar.querySelector('a').addEventListener('click', () => {
    bar.querySelector('small').textContent = 'Open the downloaded file. If Android asks, allow your browser to install apps, then tap Install.';
  });
  document.head.append(style);
  document.body.append(bar);
}
