# Getting the app into the App Store and Google Play

This folder is the phone app for both stores. It is a native app that opens your
live website inside it, adds real phone notifications, an app icon, a launch
screen and an offline screen. Every update to the website shows up in the app
straight away, so you only send a new version to the stores when the app shell
itself changes.

The app name is a placeholder (**LimoRelay**, id `com.limorelay.app`). Change
both in `app-settings.json` before the first upload: the id can never change
once an app is in a store.

## What's ready
- Android and iPhone projects (`android/`, `ios/`), icons and launch screens for every size.
- Notifications through Apple and Google (`web-app-additions/nativepush.js` for the server).
- Cloud build setup (`codemagic.yaml`): Codemagic builds both apps, including the
  iPhone app on its Macs, so you don't need a Mac.
- `web-app-additions/`: changes the website needs before submitting (see `WEB-APP-CHANGES.md`).

## Order of steps

1. **Website live first.** The app opens the live site, so finish the Render setup
   (`limo-app/DEPLOY.md`). Put the address in `app-settings.json` as `siteUrl`.
2. **Website changes** in `web-app-additions/WEB-APP-CHANGES.md`: account deletion,
   privacy policy, store-app notifications, and hiding plan purchases in the iPhone app.
3. **Store accounts (you create these):**
   - Google Play Console, $25 once: https://play.google.com/console/signup
   - Apple Developer Program, $99 a year: https://developer.apple.com/programs/enroll/
     Enroll as an organization if you want your company name shown as the seller;
     that needs a free D-U-N-S number for your business and takes a few days.
4. **Notification keys** (free):
   - Google: make a Firebase project at https://console.firebase.google.com, add an
     Android app with the app id, download `google-services.json`. Also create a
     service account key (Project settings > Service accounts) for the server's
     `FCM_SERVICE_ACCOUNT` setting.
   - Apple: in your developer account, Keys > + > Apple Push Notifications service.
     Download the `.p8` file once and note the Key ID and your Team ID; these go in the
     server's `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` settings.
5. **Codemagic** (free tier, https://codemagic.io): sign in with GitHub, add the repo.
   - Environment variables: group `app_settings` with `APP_SITE_URL`; group `firebase`
     with `GOOGLE_SERVICES_JSON` (paste the file's contents).
   - Code signing: generate an Android upload keystore there, named `upload_key`.
     Keep a copy somewhere safe; Google needs the same key for every update.
   - Apple: in your developer account, register the app id (Identifiers > +) with
     Push Notifications ticked, and create the app in App Store Connect.
   - Integrations: add an App Store Connect API key named `apple_key`. Then, under
     Code signing identities, generate an iOS distribution certificate and fetch the
     App Store profile for the app id. Codemagic does both from its own screens.
   - If you changed the app id, also change `bundle_identifier` in `codemagic.yaml`.
6. **Build:** start "Android (Google Play)" and "iPhone (App Store)" in Codemagic.
   Android gives an `.aab` for Play and an `.apk` you can install on any Android phone
   to try it. The iPhone build goes straight to TestFlight, Apple's test app.
7. **Store listings:** name, short description, screenshots (phone sizes), the privacy
   policy link, a support email, the data-safety form (Google) and privacy labels (Apple),
   and the test logins from step 6 of the website changes in the review notes.
8. **Submit.** Google: start with an internal test, then production. Note that a new
   personal Play account must run a closed test with 12 testers for 14 days before it
   can publish; an organization account skips this. Apple: submit from TestFlight.

## Store review: what could get it rejected, and how this handles it

- **"Just a website in a wrapper"** (Apple guideline 4.2). Apple turns down apps that
  only show a website. This app has real phone notifications, a native launch screen,
  an offline screen, location for chauffeurs and camera/photo access, and it is a
  signed-in work tool for chauffeurs and dispatch, which Apple treats well. In the
  review notes, describe the chauffeur and dispatch features and give test logins.
- **Account deletion** (Apple 5.1.1, Google user-data policy): required, see the website changes.
- **Selling the software in the iPhone app** (Apple 3.1.1): hidden in the iPhone app,
  see the website changes. Riders paying for rides by card is allowed.
- **One app per company later.** If limo companies want their own branded app in the
  stores, Apple requires each one to be published under that company's own developer
  account (guideline 4.2.6). This same project can produce those apps with a different
  name, id, icon and start page (`startPath`, for example `/#book.carina`).

## Settings (`app-settings.json`)

| Setting | What it is |
|---|---|
| `appName` | Name under the icon |
| `appId` | Store id, reverse domain, can't change after the first upload |
| `siteUrl` | The live website address |
| `startPath` | Page the app opens on, e.g. `/` or `/#book.carina` |
| `brandColor` | Launch screen and status bar color |

After changing settings or icons: `npm install`, `npm run assets` (if `assets/` changed),
then `npx cap sync`.
