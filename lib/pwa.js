/* PWA install prompt + Web Push helpers. All browser-only; every function
   is a no-op / safe fallback when the API isn't there (SSR, iOS, etc.). */

let _swReg = null;
let _installEvt = null;
const _installCbs = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _installEvt = e;
    _installCbs.forEach((cb) => cb(true));
  });
  window.addEventListener("appinstalled", () => {
    _installEvt = null;
    _installCbs.forEach((cb) => cb(false));
  });
}

export async function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    _swReg = await navigator.serviceWorker.register("/sw.js");
    // if a controller already exists (returning visit) grab the ready reg
    _swReg = (await navigator.serviceWorker.ready) || _swReg;
    return _swReg;
  } catch (e) {
    return null;
  }
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

export function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent || "");
}

/* ---- install prompt ---- */
export function onInstallAvailable(cb) {
  _installCbs.add(cb);
  if (_installEvt) cb(true);
  return () => _installCbs.delete(cb);
}
export function canInstall() {
  return !!_installEvt;
}
export async function promptInstall() {
  if (!_installEvt) return "unavailable";
  _installEvt.prompt();
  let outcome = "dismissed";
  try { outcome = (await _installEvt.userChoice).outcome; } catch (e) { /* ignore */ }
  _installEvt = null;
  _installCbs.forEach((cb) => cb(false));
  return outcome; // "accepted" | "dismissed"
}

/* ---- web push ---- */
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

export function pushConfigured() {
  return !!VAPID_PUBLIC;
}
export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}
export function pushPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function isPushSubscribed() {
  try {
    const reg = _swReg || (await navigator.serviceWorker.ready);
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch (e) {
    return false;
  }
}

/* saveFn({ endpoint, p256dh, auth }) persists it (see lib/auth.savePushSubscription) */
export async function subscribeToPush(saveFn) {
  if (!VAPID_PUBLIC) return { ok: false, error: "Notifications aren't switched on for this app yet." };
  if (!pushSupported()) return { ok: false, error: "This device or browser can't do notifications." };
  const reg = _swReg || (await navigator.serviceWorker.ready);
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return { ok: false, error: perm === "denied" ? "Notifications are blocked — turn them on in your browser's site settings." : "Permission not given." };
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
  });
  const j = sub.toJSON();
  try {
    await saveFn({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  } catch (e) {
    try { await sub.unsubscribe(); } catch (e2) { /* ignore */ }
    return { ok: false, error: "Couldn't save the subscription — try again." };
  }
  return { ok: true };
}

/* removeFn(endpoint) deletes the row */
export async function unsubscribeFromPush(removeFn) {
  try {
    const reg = _swReg || (await navigator.serviceWorker.ready);
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const ep = sub.endpoint;
      await sub.unsubscribe();
      try { await removeFn(ep); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  return { ok: true };
}
