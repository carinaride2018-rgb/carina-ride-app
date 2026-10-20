# Putting Livery online

This guide takes the app from these files to a private web address you can test with real phones. Nothing here has been done yet. Every step that creates an account or costs money is yours to approve.

## What you need

| What | Why | Rough cost |
| --- | --- | --- |
| GitHub account (private repository) | Holds the code so the host can run it, and keeps every version | Free |
| Render account, Starter web service with a 1 GB disk | Runs the app around the clock and keeps the data file | About $7/month plus about $0.25/month for the disk (check Render's current prices) |
| Your own domain, optional | `book.yourcompany.com` instead of `livery-xxxx.onrender.com` | About $12/year |

The app has no other dependencies. Railway or Fly.io work too: use the `Dockerfile` and mount a volume at `/data`.

## Steps

1. **Create the GitHub repository.** Make it private. Upload the contents of the `limo-app` folder (not `data/` or `dist/`; `.gitignore` already skips them).
2. **Create the Render service.** In Render choose New, then Blueprint, and pick the repository. Render reads `render.yaml` and sets up the web service, the health check and the 1 GB disk mounted at `/data`.
3. **Fill in the four private settings** Render asks for:
   - `PUBLIC_URL`: the address Render gives you, with a trailing slash, for example `https://livery-ab12.onrender.com/`. Change it later if you add your own domain.
   - `OWNER_NAME`: your name.
   - `OWNER_EMAIL`: the email you'll sign in with as platform owner.
   - `OWNER_PASSWORD`: at least 12 characters. It is only used on the very first start, to create your login.
4. **Deploy.** The first start creates an empty platform with only your owner login. No sample companies, no demo passwords.
5. **Sign in as owner** and add your own limo company under Companies. That creates the company admin login.
6. **Sign in as the company admin** and set up, in this order: Rates & brand, Fleet, Drivers, Pricing, Texts & emails.
7. **Install the phone app** from "Get the app" on an Android phone and an iPhone, turn on notifications, then close the app and make a test booking. The notification should still arrive. (iPhone needs iOS 16.4 or later and the app added to the home screen.)
8. **Share the booking link** (Rates & brand shows it) with a few trusted customers first.

## Switching on real services

Out of the box, texts, email, card payments, maps and flight tracking are simulated. Each one switches on when you add its settings in Render (your service, then Environment) and redeploy. You can add them one at a time, in any order. The platform owner's **Connections** tab shows which ones are on. It never shows the keys.

Every service below needs its own account, created by you. Prices change, so check each site.

### Texts: Twilio

1. Create a Twilio account and buy a local Seattle number (about $1–2/month; each text costs around a cent).
2. **Register for US texting (A2P 10DLC)** in the Twilio console under Messaging, Regulatory compliance. US carriers block business texts from unregistered numbers. Registration costs a small one-time fee plus a monthly campaign fee and can take from a few days to a few weeks. A verified toll-free number is the other option.
3. Add these settings:
   - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, from the Twilio console home page.
   - `TWILIO_FROM`: your number, for example `+12065550100`, or a Messaging Service ID starting with `MG`.
4. **Passenger replies (Inbox)**: in the Twilio console, open your number (or Messaging Service), and under "A message comes in" choose Webhook, `HTTP POST`, and enter `https://limorelay.com/twilio/sms` (your `PUBLIC_URL` followed by `twilio/sms`). Replies then show up in each company's Inbox. The app checks Twilio's signature with `TWILIO_AUTH_TOKEN`, so nothing else is needed. The owner's Connections screen shows the exact address.

### Email: Resend

1. Create a Resend account. The free plan covers about 3,000 emails a month.
2. Add your domain (for example `carinaride.com`) and add the DNS records Resend shows you where you bought the domain.
3. Add these settings:
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, for example `Bookings <bookings@carinaride.com>`.

Each email goes out under the limo company's own name, and replies go to that company's email address (set under Rates & brand).

### Card payments: Stripe Connect

Each limo company connects its own Stripe account, so their customers' money goes straight to their bank. Stripe's card fee comes out of each payment; the platform takes nothing extra.

1. Create your own Stripe account (the platform account) and turn on **Connect**.
2. Add `STRIPE_SECRET_KEY`. Start with the **test** key (`sk_test_...`): nothing is charged and the card `4242 4242 4242 4242` works. Switch to the live key (`sk_live_...`) when you're ready.
3. Each company admin opens **Rates & brand**, clicks **Connect Stripe** and fills in Stripe's form. Customers then save a card on Stripe's secure page when they book or accept a quote (no deposit). The app charges that saved card by itself: the fare 24 hours before pickup (the hours are set in Rates & brand), extras such as waiting time or added stops 30 minutes after drop-off, and refunds when a trip is cancelled. A declined card texts the passenger a link to add another one and shows up for the office.
4. Optional but recommended: in Stripe, go to Developers, then Webhooks, and add the endpoint `https://<your address>/pay/webhook`. Choose "Events on connected accounts" with `checkout.session.completed` and `account.updated`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`. This records saved cards and payments even when a customer closes the page before coming back.

5. **Membership billing (what companies pay LimoRelay)** uses your own Stripe account with the same `STRIPE_SECRET_KEY`; nothing else to set up. Company admins add a card under My account, Membership, and each invoice is charged to it. Turn on **Bill companies automatically** in the owner's Billing tab: invoices are then made on the 1st of each month and the day a free trial ends. Cards and payments are recorded when the admin comes back from Stripe's page, so no extra webhook is needed.

Without `STRIPE_SECRET_KEY`, the real site (`SAMPLE_DATA=off`) has no online card payments: the office takes payment itself (chauffeurs never take payment), and company accounts are invoiced.

### Maps: Google Maps

1. In Google Cloud, create a project, add a billing account and enable **Routes API** and **Places API (New)**.
2. Create an API key restricted to those two APIs, and set a monthly budget alert.
3. Add `GOOGLE_MAPS_API_KEY`.

Prices then use real driving distances and times, and address search suggests real addresses. Each route is looked up once and saved. The same key also finds where each pickup is, so cars and pickups sit in the right place on the Board's live map.

4. Optional, for street maps on the Board: create a second key restricted to **Maps JavaScript API** and to your site's address (Application restrictions, Websites, `https://<your address>/*`). Add it as `GOOGLE_MAPS_BROWSER_KEY`. This key is visible in the browser, which is why it gets its own website restriction. Without it, the live map is a simple drawing with landmarks instead of streets.

### Flights: FlightAware AeroAPI

1. Sign up for AeroAPI. The personal plan charges a small amount per lookup.
2. Add `FLIGHTAWARE_API_KEY`.

Tracking starts two days before a flight. The app checks each flight every 30 minutes, and every 5 minutes close to landing, and moves the pickup when a flight is late (if Flights is set to adjust automatically). Until the first answer comes in, a flight shows "Checking flight" and nothing is moved.

### Phone notifications: built in, no account

Notifications that arrive while the app is closed (Web Push) work on the live site with nothing to sign up for. They go through the phone's own push service (Apple, Google or Mozilla) at no cost. The server makes its signing key on first start and keeps it in `vapid.json` next to the data file, on the persistent disk. If that file is lost, people simply turn notifications on again. To set the key yourself, add `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; `WEB_PUSH=off` turns the feature off.

The App Store and Google Play apps can't use Web Push, so they use Apple's and Google's own notification services. Add `FCM_SERVICE_ACCOUNT` (Android, from Firebase) and `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (iPhone, from your Apple developer account). Each half is optional; without them the store apps still show alerts while open. Steps are in `mobile-app/STORES.md`.

Before submitting the store apps: fill in the bracketed parts of `public/privacy.html` (company legal name, address, privacy email, date) and have it checked. Its web address (`https://<your site>/privacy.html`) goes in both store listings; the account deletion address is `https://<your site>/#account`.

## Before real customers book

- Turn on Texts and Email first, or customers get no confirmation.
- Do a test booking and a test payment with your own phone and email.
- With sample data loaded (`SAMPLE_DATA` unset), real keys send real texts and emails to whatever numbers the sample bookings use. Use real keys only on the real site.

## Looking after the data

- Everything lives in one file, `/data/db.json`, on the Render disk. Render takes a snapshot of the disk every day.
- To keep your own copy, download the file from the Render shell now and then.
- One file is fine for your company and a handful of others. Move to Postgres before selling to many companies.

## Settings reference

See `.env.example`. `SAMPLE_DATA` left unset loads the sample companies, which is useful for a test copy but never for the real site.
