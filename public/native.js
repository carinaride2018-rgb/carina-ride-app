// Store-app bridge: only does anything inside the App Store / Google Play app
// (Capacitor). In a normal browser window.LiveryNative stays null and the site
// works exactly as before. Load it before app.js.
'use strict';
window.LiveryNative = (function () {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  const P = C.Plugins || {};
  const Push = P.PushNotifications, App = P.App, Splash = P.SplashScreen;
  const platform = C.getPlatform(); // 'ios' or 'android'
  document.documentElement.classList.add('native-app', 'native-' + platform);
  if (Splash) Splash.hide().catch(() => {});

  let token = '', waiting = null;
  if (Push) {
    Push.addListener('registration', (t) => { token = t.value; if (waiting) { waiting.resolve(token); waiting = null; } });
    Push.addListener('registrationError', (e) => { if (waiting) { waiting.reject(new Error(e.error || 'registration failed')); waiting = null; } });
  }

  const api = {
    platform,
    // 'granted', 'denied' or 'prompt': same meaning as Notification.permission.
    async permission() {
      if (!Push) return 'denied';
      const p = await Push.checkPermissions();
      return p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'default';
    },
    async askPermission() {
      if (!Push) return 'denied';
      const p = await Push.requestPermissions();
      return p.receive === 'granted' ? 'granted' : 'denied';
    },
    // The phone's notification address, e.g. "fcm:abc…" or "apns:abc…". Asks
    // Apple or Google for it once per launch.
    async pushEndpoint() {
      if (!Push || (await api.permission()) !== 'granted') return '';
      if (!token) {
        const got = new Promise((resolve, reject) => { waiting = { resolve, reject }; });
        await Push.register();
        await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000))]);
      }
      return (platform === 'ios' ? 'apns:' : 'fcm:') + token;
    },
    // Tapping a notification opens the right screen (the server sends a #hash).
    onOpen(fn) {
      if (Push) Push.addListener('pushNotificationActionPerformed', (a) => { const d = (a.notification && a.notification.data) || {}; if (d.hash) fn(String(d.hash)); });
    },
    // A notification that arrives while the app is open on screen.
    onShow(fn) {
      if (Push) Push.addListener('pushNotificationReceived', (n) => fn({ title: n.title, body: n.body, hash: (n.data && n.data.hash) || '' }));
    },
  };

  // Android back button: go back a screen, or leave the app from the first one.
  if (App) App.addListener('backButton', (e) => { if (e.canGoBack) history.back(); else App.exitApp(); });
  // Coming back to the app refreshes what's on screen.
  if (App) App.addListener('resume', () => window.dispatchEvent(new Event('focus')));
  return api;
})();
