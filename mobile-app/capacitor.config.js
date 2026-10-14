// Settings for the store apps. Change app-settings.json (or set APP_SITE_URL,
// APP_NAME, APP_ID when building) and run `npx cap sync`.
const settings = require('./app-settings.json');
const env = process.env;
const site = (env.APP_SITE_URL || settings.siteUrl).replace(/\/+$/, '');
const host = new URL(site).hostname;
// The offline page's "Try again" button goes back to the site.
require('fs').writeFileSync(require('path').join(__dirname, 'www', 'site.js'), `window.SITE_URL = ${JSON.stringify(site + (env.APP_START_PATH || settings.startPath || '/'))};\n`);

module.exports = {
  appId: env.APP_ID || settings.appId,
  appName: env.APP_NAME || settings.appName,
  webDir: 'www',
  server: {
    // The app opens the live site, so every update to the site reaches the
    // apps at once without a new store release.
    url: site + (env.APP_START_PATH || settings.startPath || '/'),
    // Shown when the phone is offline or the site can't be reached.
    errorPath: 'offline.html',
    // Pages that stay inside the app instead of opening the phone's browser:
    // the site itself and Stripe's secure card page (it sends people back).
    allowNavigation: [host, 'checkout.stripe.com', '*.stripe.com'],
  },
  android: { allowMixedContent: false },
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, backgroundColor: settings.brandColor, showSpinner: false, androidScaleType: 'CENTER_CROP' },
    StatusBar: { overlaysWebView: false, style: 'DARK', backgroundColor: settings.brandColor },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
