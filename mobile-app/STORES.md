# LimoRelay phone apps (App Store and Google Play)

One app, `com.limorelay.app`, for every member company. Drivers, dispatchers and
passengers download it, sign in, and see their own company's screens. The app
opens limorelay.com inside a native shell (Capacitor), so website updates reach
the app right away; only icon, permission or plugin changes need a new store build.

## 1. Accounts (owner does these; they need ID and payment)
- Apple Developer Program, organization: https://developer.apple.com/programs/enroll ($99/year, needs a D-U-N-S number).
- Google Play Console, organization: https://play.google.com/console ($25 once).
- Firebase project (free) for Android notifications: https://console.firebase.google.com

## 2. One-time setup, then GitHub secrets (Settings > Secrets and variables > Actions)
Apple (App Store Connect > Users and Access > Integrations > App Store Connect API, role "App Manager"):
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the .p8 file's text), `APPLE_TEAM_ID`
- Create the app in App Store Connect with bundle ID `com.limorelay.app`.
- Server push keys for iPhone go in Render: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=com.limorelay.app`.

Google:
- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (upload key; make it once with
  `keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`, keep a safe copy).
- `GOOGLE_SERVICES_JSON` (Firebase > Project settings > Android app `com.limorelay.app` > google-services.json text).
- `PLAY_SERVICE_ACCOUNT_JSON` (Play Console > Setup > API access) for automatic uploads.
- Server push key for Android goes in Render: `FCM_SERVICE_ACCOUNT`.
- The very first Android upload must be done by hand in Play Console (download the .aab from the workflow run).

## 3. Build
GitHub > Actions > "Phone apps" > Run workflow. Tick "Upload" to send the build to
TestFlight and Google Play internal testing. Without secrets the workflow only
checks that both apps build.

## 4. Store review checklist
- Privacy policy: https://limorelay.com/privacy.html (fill the brackets first). Terms: /terms.html.
- Demo logins for the reviewers: one driver, one dispatcher, one passenger, on a demo company.
- Account deletion is in the app (My account > Delete my account), as Apple requires.
- Screenshots: 6.9" and 6.5" iPhone, 13" iPad (or turn iPad off), Android phone.
- Data safety / App privacy: location (drivers, while on a ride), contact info, payment handled by Stripe/Square.
- In the iPhone app, buying text packs is already hidden (Apple in-app purchase rules).
