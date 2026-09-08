/* MathsUnlockedBN service worker.
   Kept deliberately thin: no offline caching (the app needs Supabase to be
   useful anyway), just enough to be installable and to receive push. */

const SW_VERSION = "v2"; // v2: monochrome notification badge

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A no-op fetch handler — present so the SW counts as controlling the page.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "MathsUnlocked";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",   // MUST be white-on-transparent — a colour PNG shows as a white box
    data: { url: data.url || "/" },
    tag: data.tag || undefined,
    renotify: !!data.tag,
    vibrate: [60, 40, 60],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        if ("navigate" in client) { try { await client.navigate(target); } catch (e) { /* ignore */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
