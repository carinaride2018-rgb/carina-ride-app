/*
 * Livery core: all booking, dispatch, pricing, fleet, driver and billing rules.
 *
 * The same file runs on the Node server (server.js) and inside the browser
 * for the offline demo. It knows nothing about HTTP or storage: callers pass
 * in load/save/hash/randomId functions and then use core.call(token, method, args).
 *
 * Every method checks the caller's role and company, so one company can never
 * read or change another company's trips, drivers, vehicles or customers.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.LimoCore = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 5;
  const VEHICLE_TYPES = ['Sedan', 'SUV', 'Business Van', 'Sprinter Van', 'Party Bus'];
  const SERVICES = { transfer: 'Transfer', airport: 'Airport transfer', hourly: 'By the hour' };
  const EVENT_TYPES = ['Wedding', 'Prom or homecoming', 'Corporate event', 'Airport group', 'Night out', 'Funeral', 'Tour', 'Other'];
  const DEFAULT_QUOTE = { validDays: 7 }; // no deposits: the customer saves a card instead
  const STATUS_LABELS = {
    confirmed: 'Confirmed', assigned: 'Driver assigned', accepted: 'Driver accepted',
    en_route: 'On the way', arrived: 'Arrived', on_board: 'Passenger on board',
    completed: 'Completed', cancelled: 'Cancelled',
  };
  // What the driver's single "next" button moves a trip to.
  const DRIVER_FLOW = { accepted: 'en_route', en_route: 'arrived', arrived: 'on_board', on_board: 'completed' };
  const ACTIVE = ['assigned', 'accepted', 'en_route', 'arrived', 'on_board'];
  // Every plan includes dispatch, the driver app and the passenger app; they
  // differ only in price and texts. Founding is for the first 100 companies,
  // with no setup fee and the price locked for 2 years. Paying a year up front
  // costs 10 months and skips the setup fee. New companies can start with a
  // 30-day free trial.
  // Platform contact address: shown on the home page and used as reply-to on emails that come from LimoRelay itself.
  const PLATFORM_EMAIL = 'info@limorelay.com';
  const PLANS = {
    founding: { label: 'Founding', monthly: 49, setup: 0, texts: 500, lockMonths: 24, limit: 100, note: 'First 100 companies, price locked for 2 years' },
    standard: { label: 'Standard', monthly: 99, setup: 299, texts: 1000, note: 'Everything included' },
    fleet: { label: 'Fleet', monthly: 199, setup: 299, texts: 3000, note: 'For busy fleets' },
  };
  const YEARLY_MONTHS = 10; // a yearly plan costs 10 months: 2 months free
  const TRIAL_DAYS = 30;
  const DEFAULT_RATES = {
    currency: 'USD', base: 15, perMile: 3.75, minFare: 85, hourly: 95, minHours: 3,
    airportFlat: 125, gratuityPct: 20, taxPct: 0, waitPerMin: 1.5,
    multipliers: { 'Sedan': 1, 'SUV': 1.3, 'Business Van': 1.9, 'Sprinter Van': 1.7, 'Party Bus': 2.6 },
  };
  // Automatic price adjustments, add-ons and promo codes for each company.
  const DEFAULT_PRICING = {
    nightPct: 15, nightStart: 22, nightEnd: 5,
    weekendPct: 0,
    busyPct: 20, busyThreshold: 75, // add busyPct when this % of a vehicle type is already booked around that time
    // Stops are priced by the extra miles they add plus the wait booked at each
    // one (stopWait minutes by default, at the waiting rate). extraStop is an
    // optional fixed fee on top.
    addons: { childSeat: 15, meetGreet: 25, extraStop: 0, stopWait: 10 },
    peakDates: [],
    promos: [],
  };
  const DEFAULT_FLIGHT = { autoAdjust: true, minDelay: 10 };
  // Texts each company gets per month, and the packs it can buy when it runs
  // out. The platform owner can change these (db.textPlan). Emails are unlimited.
  const DEFAULT_TEXTS = { included: 500, packSize: 500, packPrice: 15, warnPct: 80, plans: { founding: 500, standard: 1000, fleet: 3000 } };
  // Messages to passengers: confirmation, 24-hour reminder, review request.
  // Passenger texts and emails a company can reword. {words} in braces are
  // filled in per trip; the *_line ones are whole sentences or empty.
  const MSG_TEMPLATES = {
    confirm_sms: { label: 'Booking confirmed (text)', text: '{company}: booking {ref} confirmed for {pickup_time} from {pickup}. Total {total}.{landing_short_line}{call_line}' },
    confirm_email: { label: 'Booking confirmed (email)', text: "{company}: your booking {ref} is confirmed. {pickup_time}. {ride}. Pickup: {pickup}.{dropoff_line}{flight_line} Total {total}.{landing_line} We'll send your chauffeur's name and a live tracking link when they set off.{call_line}" },
    reminder_sms: { label: '24-hour reminder (text)', text: "{company}: reminder, your ride {ref} is {pickup_time} from {pickup}.{flight_short_line} Reply or call {phone} to change it." },
    reminder_email: { label: '24-hour reminder (email)', text: "{company}: a reminder that your ride {ref} is {pickup_time}. Pickup: {pickup}.{dropoff_line} {vehicle_type}, {passengers}.{chauffeur_line}{flight_track_line} Need to change something? Call {phone}." },
    accepted: { label: 'Chauffeur confirmed', text: '{company}: your chauffeur for {ref} is {driver}{vehicle_line}.' },
    en_route: { label: 'On the way', text: '{company}: {driver} is on the way to {pickup}.{car_line}{track_line}' },
    approach: { label: 'About 10 minutes away', text: '{company}: {driver_first} is about 10 minutes away from {pickup}.{track_line}' },
    arrived: { label: 'Chauffeur arrived', text: '{company}: your chauffeur has arrived at {pickup}.{car_line}' },
    receipt: { label: 'Receipt (email)', text: '{company}: thanks for riding with us. Receipt for {ref}: {total}.' },
    review_sms: { label: 'Review request (text)', text: '{company}: thank you for riding with us{driver_and}. How was your trip? Rate it in one tap: {review_link}' },
    review_email: { label: 'Review request (email)', text: '{company}: thank you for riding with us{driver_and}. How was your trip? Rate it in one tap: {review_link} Your feedback goes straight to our team.' },
    cancelled: { label: 'Booking cancelled', text: '{company}: booking {ref} has been cancelled.' },
    no_show: { label: 'No-show', text: "{company}: your chauffeur waited{waited} at {pickup} and couldn't find you, so {ref} is closed as a no-show.{fee_line}{wrong_line}" },
    card_charged: { label: 'Fare charged to card', text: '{company}: we charged {amount} to your card ending {last4} for ride {ref}, {pickup_time}.' },
    card_extra: { label: 'Extras charged to card', text: '{company}: extras on ride {ref} ({extras}) came to {amount}, charged to your card ending {last4}.' },
    card_refund: { label: 'Refund to card', text: '{company}: we refunded {amount} to your card ending {last4} for {ref}.' },
    card_failed: { label: "Card couldn't be charged", text: "{company}: we couldn't charge {amount} to your card ending {last4} for ride {ref}. Please add a card here: {card_link}{call_line}" },
  };
  const MSG_WORDS = ['company', 'ref', 'passenger', 'pickup_time', 'pickup', 'dropoff', 'vehicle_type', 'passengers', 'ride', 'driver', 'driver_first', 'driver_and', 'vehicle', 'plate', 'vehicle_line', 'car_line', 'total', 'phone', 'flight', 'track_link', 'review_link', 'call_line', 'wrong_line', 'dropoff_line', 'flight_line', 'flight_short_line', 'flight_track_line', 'chauffeur_line', 'track_line', 'landing_line', 'landing_short_line', 'waited', 'fee', 'fee_line', 'amount', 'last4', 'extras', 'card_link'];
  const INCIDENT_KINDS = { accident: 'Accident', damage: 'Vehicle damage', injury: 'Injury', complaint: 'Complaint', lost_item: 'Lost item', other: 'Other' };
  const DEFAULT_CLIENT_MSGS = { confirmText: true, confirmEmail: true, remind24: true, approach: true, review: true, reviewDelayMin: 0 };
  // Corporate accounts: payment terms in days (0 = due on receipt).
  const ACCOUNT_TERMS = [0, 15, 30, 45];
  // Smart dispatch: auto-assign, accept timer, reminders, late-start alert.
  const DEFAULT_DISPATCH = { autoAssign: false, horizonHours: 24, acceptMin: 20, onNoAnswer: 'next', remindEvening: true, eveningHour: 18, remindBeforeMin: 120, lateStartMin: 20, minNoticeHours: 3 };
  // Automatic farm-out: send a trip to network partners, in the company's order,
  // when its own drivers can't cover it. Off until the company turns it on.
  const DEFAULT_AUTOFARM = { on: false, noDriver: true, lastCallHours: 2, ratePct: 87.5, answerMin: 15, partners: [] };
  // Suitcases each vehicle type takes; companies can change these.
  const DEFAULT_BAGS = { 'Sedan': 2, 'SUV': 5, 'Business Van': 8, 'Sprinter Van': 12, 'Party Bus': 4 };
  // Cancellation and free waiting, shown to customers when they book.
  // Travel agents and other bookers who book rides for their clients earn a
  // commission on the ride price (before gratuity and tax).
  const DEFAULT_AGENTS = { commissionPct: 10, on: true };
  const DEFAULT_POLICY = { cancelHours: 24, cancelFeePct: 100, waitAirport: 60, waitOther: 15, noShowFeePct: 100, chargeWhen: 'booking', chargeHours: 24 };
  // Ride preferences a passenger can ask for; saved on their profile.
  const TEMPS = { '': 'No preference', cool: 'Cool', warm: 'Warm' };
  const MUSIC = { '': 'No preference', soft: 'Soft music', none: 'No music', own: 'Own music by Bluetooth' };
  const MAX_STOPS = 5;
  const STOP_WAITS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
  const anA = (w) => (/^(SUV|[AEIOU])/.test(w) ? 'An' : 'A');
  const VEHICLE_STATUS = { active: 'In service', maintenance: 'In the shop', retired: 'Retired' };
  const MAINT_KINDS = ['Oil change', 'Scheduled service', 'Tires', 'Brakes', 'Inspection', 'Repair', 'Detailing', 'Other'];
  const PAY_TYPES = { percent: '% of fare', hourly: 'Per hour', perTrip: 'Per trip' };
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const AIRLINES = {
    AA: 'American Airlines', UA: 'United Airlines', DL: 'Delta Air Lines', WN: 'Southwest Airlines', B6: 'JetBlue',
    AS: 'Alaska Airlines', NK: 'Spirit Airlines', F9: 'Frontier Airlines', BA: 'British Airways', LH: 'Lufthansa',
    AF: 'Air France', EK: 'Emirates', AC: 'Air Canada', KL: 'KLM', QR: 'Qatar Airways', ET: 'Ethiopian Airlines',
  };

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status || 400; }
  }
  const fail = (msg, status) => { throw new ApiError(msg, status); };

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const money = (n) => round2(n).toFixed(2);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 300);
  const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const slugify = (s) => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const addMonths = (iso, n) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };
  const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const daysUntil = (dateStr, from) => Math.floor((new Date(dateStr + 'T12:00:00Z').getTime() - from.getTime()) / 86400000);

  // Date parts in the company's own time zone, used for night, weekend and shift rules.
  function localParts(iso, tz) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
      const p = {};
      for (const x of f.formatToParts(new Date(iso))) p[x.type] = x.value;
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), day: p.weekday.slice(0, 3).toLowerCase() };
    } catch (e) {
      const d = new Date(iso);
      return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getUTCDay()] };
    }
  }

  // A wall-clock date and time in a company's time zone, as an ISO instant.
  // Accepts 2026-10-14 or 10/14/2026, and 14:30 or 2:30 PM.
  function localToIso(date, time, c) {
    let y, mo, d;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date).trim());
    if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(date).trim()))) [mo, d, y] = [+m[1], +m[2], +m[3] < 100 ? 2000 + +m[3] : +m[3]];
    else return null;
    const t = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(String(time).trim());
    if (!t) return null;
    let h = +t[1]; const mi = +t[2];
    if (t[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/^p/i.test(t[3]) ? 12 : 0); }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    // Guess UTC, then correct by the zone's offset at that moment (twice, for DST edges).
    let ms = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {
      const p = localParts(new Date(ms).toISOString(), c.timezone);
      const [py, pm, pd] = p.date.split('-').map(Number);
      ms += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
    }
    const back = localParts(new Date(ms).toISOString(), c.timezone);
    if (back.date !== `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`) return null;
    return new Date(ms).toISOString();
  }

  // ---- Live services -------------------------------------------------------
  // The server plugs real maps and flight data in here (see providers.js).
  // A hook returns null when it has nothing, and the built-in estimate is used.
  const providers = { route: null, flight: null, places: null };
  function setProviders(p) { Object.assign(providers, p || {}); }

  // ---- Distance --------------------------------------------------------------

  // Stand-in for a maps service. Gives a stable, plausible distance for two
  // addresses so quotes are repeatable. Replace with Google Maps Distance Matrix.
  function estimateRoute(a, b) {
    const x = str(a).toLowerCase().replace(/\s+/g, ' ');
    const y = str(b).toLowerCase().replace(/\s+/g, ' ');
    if (!x || !y) return { miles: 0, minutes: 0 };
    if (x === y) return { miles: 1, minutes: 5 };
    if (providers.route) { const r = providers.route(str(a), str(b)); if (r) return r; }
    const miles = 4 + (fnv(x < y ? x + '|' + y : y + '|' + x) % 380) / 10;
    return { miles: round2(miles), minutes: Math.round(miles * 2.1 + 8) };
  }

  // Distance and time through each stop in turn, plus 5 minutes at each stop.
  function routeVia(points) {
    let miles = 0, minutes = 0;
    for (let i = 0; i < points.length - 1; i++) { const r = estimateRoute(points[i], points[i + 1]); miles += r.miles; minutes += r.minutes; }
    return { miles: round2(miles), minutes: minutes + 5 * Math.max(0, points.length - 2) };
  }

  // Minutes booked at stop i (trip.stopWaits), else the company default.
  function stopWait(b, i, def) {
    const w = Array.isArray(b.stopWaits) ? num(b.stopWaits[i], NaN) : NaN;
    return w >= 0 && w <= 240 ? Math.round(w) : def;
  }

  const AIRPORT_RE = /airport|terminal|\b(jfk|lga|ewr|lax|sfo|ord|mdw|atl|dca|iad|bwi|dfw|iah|sea|bfi|pae|mia|bos|den|phx|las|msp|dtw|clt|phl)\b/i;
  // Cruise and ferry terminals are not airports.
  const isAirport = (addr) => AIRPORT_RE.test(str(addr)) && !/cruise|ferry|pier \d/i.test(str(addr));
  const airportCode = (addr) => { const m = str(addr).match(/\b(JFK|LGA|EWR|LAX|SFO|ORD|MDW|ATL|DCA|IAD|BWI|DFW|IAH|SEA|BFI|PAE|MIA|BOS|DEN|PHX|LAS|MSP|DTW|CLT|PHL)\b/i); return m ? m[1].toUpperCase() : ''; };

  // ---- Address suggestions -------------------------------------------------

  // Stand-in for Google Places Autocomplete: a list of well-known places per
  // region plus the caller's own recent addresses. Replace suggestPlaces() with
  // a server-side call to Places (keep the same return shape).
  const PLACES = {
    seattle: [
      ['Seattle-Tacoma International Airport (SEA)', '17801 International Blvd, SeaTac, WA 98158', 'airport'],
      ['Boeing Field, King County International Airport (BFI)', '7277 Perimeter Rd S, Seattle, WA 98108', 'airport'],
      ['Paine Field Airport (PAE)', '3300 100th St SW, Everett, WA 98204', 'airport'],
      ['King Street Station', '303 S Jackson St, Seattle, WA 98104', 'place'],
      ['Seattle Cruise Terminal, Pier 66', '2225 Alaskan Way, Seattle, WA 98121', 'place'],
      ['Smith Cove Cruise Terminal, Pier 91', '2001 W Garfield St, Seattle, WA 98119', 'place'],
      ['Fairmont Olympic Hotel', '411 University St, Seattle, WA 98101', 'place'],
      ['Four Seasons Hotel Seattle', '99 Union St, Seattle, WA 98101', 'place'],
      ['The Edgewater Hotel', '2411 Alaskan Way, Seattle, WA 98121', 'place'],
      ['Hotel Sorrento', '900 Madison St, Seattle, WA 98104', 'place'],
      ['Inn at the Market', '86 Pine St, Seattle, WA 98101', 'place'],
      ['The Westin Bellevue', '600 Bellevue Way NE, Bellevue, WA 98004', 'place'],
      ['The Woodmark Hotel', '1200 Carillon Point, Kirkland, WA 98033', 'place'],
      ['Pike Place Market', '85 Pike St, Seattle, WA 98101', 'place'],
      ['Space Needle', '400 Broad St, Seattle, WA 98109', 'place'],
      ['Seattle Convention Center', '705 Pike St, Seattle, WA 98101', 'place'],
      ['Climate Pledge Arena', '334 1st Ave N, Seattle, WA 98109', 'place'],
      ['Lumen Field', '800 Occidental Ave S, Seattle, WA 98134', 'place'],
      ['T-Mobile Park', '1250 1st Ave S, Seattle, WA 98134', 'place'],
      ['Benaroya Hall', '200 University St, Seattle, WA 98101', 'place'],
      ['University of Washington', '1410 NE Campus Pkwy, Seattle, WA 98195', 'place'],
      ['Microsoft Campus, Redmond', '1 Microsoft Way, Redmond, WA 98052', 'place'],
      ['Amazon Spheres', '2111 7th Ave, Seattle, WA 98121', 'place'],
      ['Bellevue Square', '575 Bellevue Square, Bellevue, WA 98004', 'place'],
      ['Chateau Ste. Michelle', '14111 NE 145th St, Woodinville, WA 98072', 'place'],
      ['Salish Lodge & Spa', '6501 Railroad Ave SE, Snoqualmie, WA 98065', 'place'],
      ['Tulalip Resort Casino', '10200 Quil Ceda Blvd, Tulalip, WA 98271', 'place'],
      ['Tacoma Dome', '2727 E D St, Tacoma, WA 98421', 'place'],
      ['Seattle–Bainbridge Ferry, Colman Dock', '801 Alaskan Way, Seattle, WA 98104', 'place'],
    ],
    dc: [
      ['Reagan National Airport (DCA)', '2401 Smith Blvd, Arlington, VA 22202', 'airport'],
      ['Dulles International Airport (IAD)', '1 Saarinen Cir, Dulles, VA 20166', 'airport'],
      ['Baltimore/Washington Airport (BWI)', '7035 Elm Rd, Baltimore, MD 21240', 'airport'],
      ['Union Station', '50 Massachusetts Ave NE, Washington, DC 20002', 'place'],
      ['The Willard InterContinental', '1401 Pennsylvania Ave NW, Washington, DC 20004', 'place'],
      ['Four Seasons Georgetown', '2800 Pennsylvania Ave NW, Washington, DC 20007', 'place'],
      ['The Hay-Adams', '800 16th St NW, Washington, DC 20006', 'place'],
      ['The Watergate Hotel', '2650 Virginia Ave NW, Washington, DC 20037', 'place'],
      ['Mandarin Oriental Washington DC', '1330 Maryland Ave SW, Washington, DC 20024', 'place'],
      ['The Ritz-Carlton, Tysons Corner', '1700 Tysons Blvd, McLean, VA 22102', 'place'],
      ['Kennedy Center', '2700 F St NW, Washington, DC 20566', 'place'],
      ['Capital One Arena', '601 F St NW, Washington, DC 20004', 'place'],
      ['Nationals Park', '1500 S Capitol St SE, Washington, DC 20003', 'place'],
      ['The Wharf', '760 Maine Ave SW, Washington, DC 20024', 'place'],
      ['Georgetown University', '3700 O St NW, Washington, DC 20057', 'place'],
      ['The Pentagon', '1400 Defense Pentagon, Arlington, VA 22202', 'place'],
      ['Gaylord National Resort', '201 Waterfront St, National Harbor, MD 20745', 'place'],
      ['MGM National Harbor', '101 MGM National Ave, Oxon Hill, MD 20745', 'place'],
      ['Tysons Corner Center', '1961 Chain Bridge Rd, Tysons, VA 22102', 'place'],
      ['Wolf Trap', '1551 Trap Rd, Vienna, VA 22182', 'place'],
      ['Mount Vernon', '3200 Mount Vernon Memorial Hwy, Mount Vernon, VA 22121', 'place'],
      ['Arlington National Cemetery', '1 Memorial Ave, Arlington, VA 22211', 'place'],
      ['The Inn at Little Washington', '309 Middle St, Washington, VA 22747', 'place'],
      ['Washington Convention Center', '801 Mt Vernon Pl NW, Washington, DC 20001', 'place'],
    ],
    denver: [
      ['Denver International Airport (DEN)', '8500 Peña Blvd, Denver, CO 80249', 'airport'],
      ['Denver Union Station', '1701 Wynkoop St, Denver, CO 80202', 'place'],
      ['The Brown Palace Hotel', '321 17th St, Denver, CO 80202', 'place'],
      ['Four Seasons Hotel Denver', '1111 14th St, Denver, CO 80202', 'place'],
      ['The Ritz-Carlton, Denver', '1881 Curtis St, Denver, CO 80202', 'place'],
      ['Red Rocks Amphitheatre', '18300 W Alameda Pkwy, Morrison, CO 80465', 'place'],
      ['Ball Arena', '1000 Chopper Cir, Denver, CO 80204', 'place'],
      ['Coors Field', '2001 Blake St, Denver, CO 80205', 'place'],
      ['Colorado Convention Center', '700 14th St, Denver, CO 80202', 'place'],
      ['St Julien Hotel, Boulder', '900 Walnut St, Boulder, CO 80302', 'place'],
      ['Vail Village', '241 E Meadow Dr, Vail, CO 81657', 'place'],
      ['Breckenridge Main Street', '150 W Adams Ave, Breckenridge, CO 80424', 'place'],
      ['The Little Nell, Aspen', '675 E Durant Ave, Aspen, CO 81611', 'place'],
    ],
    airports: [
      ['JFK International Airport (JFK)', 'Queens, NY 11430', 'airport'],
      ['LaGuardia Airport (LGA)', 'Queens, NY 11371', 'airport'],
      ['Newark Liberty Airport (EWR)', '3 Brewster Rd, Newark, NJ 07114', 'airport'],
      ["Chicago O'Hare Airport (ORD)", '10000 W Balmoral Ave, Chicago, IL 60666', 'airport'],
      ['Los Angeles International Airport (LAX)', '1 World Way, Los Angeles, CA 90045', 'airport'],
      ['Atlanta Airport (ATL)', '6000 N Terminal Pkwy, Atlanta, GA 30320', 'airport'],
      ['Boston Logan Airport (BOS)', '1 Harborside Dr, Boston, MA 02128', 'airport'],
      ['Miami International Airport (MIA)', '2100 NW 42nd Ave, Miami, FL 33142', 'airport'],
      ['San Francisco Airport (SFO)', 'San Francisco, CA 94128', 'airport'],
      ['Philadelphia Airport (PHL)', '8000 Essington Ave, Philadelphia, PA 19153', 'airport'],
    ],
  };
  const REGION_CITY = { seattle: 'Seattle, WA', dc: 'Washington, DC', denver: 'Denver, CO' };
  // Airports a flight can land at, for the "ride when you land" offer: where it
  // is, its local time zone and, when the platform has a service area there,
  // which region (so a partner company there can take the pickup).
  const AIRPORTS = {
    SEA: ['Seattle-Tacoma International Airport (SEA)', '17801 International Blvd, SeaTac, WA 98158', 'Seattle', 47.4502, -122.3088, 'America/Los_Angeles', 'seattle'],
    BFI: ['Boeing Field, King County International Airport (BFI)', '7277 Perimeter Rd S, Seattle, WA 98108', 'Seattle', 47.5300, -122.3020, 'America/Los_Angeles', 'seattle'],
    PAE: ['Paine Field Airport (PAE)', '3300 100th St SW, Everett, WA 98204', 'Everett', 47.9063, -122.2816, 'America/Los_Angeles', 'seattle'],
    DEN: ['Denver International Airport (DEN)', '8500 Peña Blvd, Denver, CO 80249', 'Denver', 39.8561, -104.6737, 'America/Denver', 'denver'],
    DCA: ['Reagan National Airport (DCA)', '2401 Smith Blvd, Arlington, VA 22202', 'Washington, DC', 38.8512, -77.0402, 'America/New_York', 'dc'],
    IAD: ['Dulles International Airport (IAD)', '1 Saarinen Cir, Dulles, VA 20166', 'Washington, DC', 38.9531, -77.4565, 'America/New_York', 'dc'],
    BWI: ['Baltimore/Washington Airport (BWI)', '7035 Elm Rd, Baltimore, MD 21240', 'Baltimore', 39.1754, -76.6683, 'America/New_York', 'dc'],
    LAX: ['Los Angeles International Airport (LAX)', '1 World Way, Los Angeles, CA 90045', 'Los Angeles', 33.9416, -118.4085, 'America/Los_Angeles', ''],
    SFO: ['San Francisco Airport (SFO)', 'San Francisco, CA 94128', 'San Francisco', 37.6213, -122.3790, 'America/Los_Angeles', ''],
    LAS: ['Las Vegas Harry Reid Airport (LAS)', '5757 Wayne Newton Blvd, Las Vegas, NV 89119', 'Las Vegas', 36.0840, -115.1537, 'America/Los_Angeles', ''],
    PHX: ['Phoenix Sky Harbor Airport (PHX)', '3400 E Sky Harbor Blvd, Phoenix, AZ 85034', 'Phoenix', 33.4342, -112.0116, 'America/Phoenix', ''],
    JFK: ['JFK International Airport (JFK)', 'Queens, NY 11430', 'New York', 40.6413, -73.7781, 'America/New_York', ''],
    LGA: ['LaGuardia Airport (LGA)', 'Queens, NY 11371', 'New York', 40.7769, -73.8740, 'America/New_York', ''],
    EWR: ['Newark Liberty Airport (EWR)', '3 Brewster Rd, Newark, NJ 07114', 'Newark', 40.6895, -74.1745, 'America/New_York', ''],
    BOS: ['Boston Logan Airport (BOS)', '1 Harborside Dr, Boston, MA 02128', 'Boston', 42.3656, -71.0096, 'America/New_York', ''],
    PHL: ['Philadelphia Airport (PHL)', '8000 Essington Ave, Philadelphia, PA 19153', 'Philadelphia', 39.8744, -75.2424, 'America/New_York', ''],
    ORD: ["Chicago O'Hare Airport (ORD)", '10000 W Balmoral Ave, Chicago, IL 60666', 'Chicago', 41.9742, -87.9073, 'America/Chicago', ''],
    MDW: ['Chicago Midway Airport (MDW)', '5700 S Cicero Ave, Chicago, IL 60638', 'Chicago', 41.7868, -87.7522, 'America/Chicago', ''],
    MSP: ['Minneapolis–St Paul Airport (MSP)', '4300 Glumack Dr, St Paul, MN 55111', 'Minneapolis', 44.8848, -93.2223, 'America/Chicago', ''],
    DTW: ['Detroit Metro Airport (DTW)', '2580 World Gateway Pl, Detroit, MI 48242', 'Detroit', 42.2162, -83.3554, 'America/Detroit', ''],
    DFW: ['Dallas/Fort Worth Airport (DFW)', '2400 Aviation Dr, DFW Airport, TX 75261', 'Dallas', 32.8998, -97.0403, 'America/Chicago', ''],
    IAH: ['Houston Bush Airport (IAH)', '2800 N Terminal Rd, Houston, TX 77032', 'Houston', 29.9902, -95.3368, 'America/Chicago', ''],
    ATL: ['Atlanta Airport (ATL)', '6000 N Terminal Pkwy, Atlanta, GA 30320', 'Atlanta', 33.6407, -84.4277, 'America/New_York', ''],
    CLT: ['Charlotte Douglas Airport (CLT)', '5501 Josh Birmingham Pkwy, Charlotte, NC 28208', 'Charlotte', 35.2144, -80.9473, 'America/New_York', ''],
    MIA: ['Miami International Airport (MIA)', '2100 NW 42nd Ave, Miami, FL 33142', 'Miami', 25.7959, -80.2870, 'America/New_York', ''],
  };
  const airportInfo = (code) => { const a = AIRPORTS[code]; return a ? { code, name: a[0], address: a[1], city: a[2], lat: a[3], lng: a[4], tz: a[5], region: a[6] } : null; };
  // Which place list and map centre a company uses: its own region if set,
  // otherwise guessed from its time zone. Pacific time means Seattle for now.
  const regionOf = (c) => (c && PLACES[c.region] ? c.region : c && /Denver/.test(c.timezone || '') ? 'denver' : c && /Los_Angeles|Vancouver/.test(c.timezone || '') ? 'seattle' : 'dc');
  const fold = (x) => str(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // recent: the caller's own past addresses, newest first. Returns up to 8
  // { label, sub, address, kind: 'recent' | 'airport' | 'place' | 'street' }.
  function suggestPlaces(company, query, recent) {
    const region = regionOf(company);
    const q = fold(query);
    const words = q ? q.split(' ') : [];
    const pool = [
      ...(recent || []).map((a) => ({ label: a.split(',')[0], sub: a.split(',').slice(1).join(',').trim(), address: a, kind: 'recent' })),
      ...PLACES[region].concat(PLACES.airports).map(([n, addr, kind]) => ({ label: n, sub: addr, address: `${n}, ${addr}`, kind })),
    ];
    const seen = new Set(); const out = [];
    if (!q) {
      const rec = pool.filter((p) => p.kind === 'recent').slice(0, 4);
      const air = pool.filter((p) => p.kind === 'airport' && PLACES[region].some((x) => x[0] === p.label) && !rec.some((r) => fold(r.label) === fold(p.label)));
      return rec.concat(air);
    }
    const scored = [];
    pool.forEach((p, i) => {
      const hay = fold(p.label + ' ' + p.sub);
      if (!words.every((w) => hay.includes(w))) return;
      const name = fold(p.label);
      let score = name.startsWith(q) ? 0 : name.split(' ').some((w) => w.startsWith(words[0])) ? 1 : 2;
      if (p.kind === 'recent') score -= 0.5;
      if (p.kind === 'airport' && /^[a-z]{3}$/.test(q) && name.includes('(' + q + ')')) score = -1;
      scored.push([score, i, p]);
    });
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , p] of scored) { const k = fold(p.label); if (seen.has(k)) continue; seen.add(k); out.push(p); if (out.length >= 7) break; }
    // A typed street address ("1200 K St NW") gets completed with the local city.
    if (/^\d+\s+\S+/.test(str(query).trim()) && out.length < 8) {
      const typed = str(query).trim().replace(/\s+/g, ' ');
      const full = /,/.test(typed) ? typed : `${typed}, ${REGION_CITY[region]}`;
      if (!seen.has(fold(typed.split(',')[0]))) out.push({ label: typed.split(',')[0], sub: full.split(',').slice(1).join(',').trim(), address: full, kind: 'street' });
    }
    return out;
  }

  // ---- Map positions -------------------------------------------------------

  // Stand-in for geocoding: airports have real coordinates, other addresses get
  // a stable spot within ~13 miles of the company's city. Replace with Google
  // Geocoding when Maps is connected.
  const REGION_CENTER = { seattle: { lat: 47.6062, lng: -122.3321 }, dc: { lat: 38.9007, lng: -77.0369 }, denver: { lat: 39.7392, lng: -104.9903 } };
  const AIRPORT_POINTS = { SEA: { lat: 47.4502, lng: -122.3088 }, BFI: { lat: 47.53, lng: -122.3019 }, PAE: { lat: 47.9063, lng: -122.2816 }, DCA: { lat: 38.8512, lng: -77.0402 }, IAD: { lat: 38.9531, lng: -77.4565 }, BWI: { lat: 39.1774, lng: -76.6684 }, DEN: { lat: 39.8561, lng: -104.6737 } };
  const offset = (p, miles, angle) => ({ lat: p.lat + (miles / 69) * Math.cos(angle), lng: p.lng + (miles / (69 * Math.cos(p.lat * Math.PI / 180))) * Math.sin(angle) });
  // Reference points drawn on the built-in map so dispatchers can orient themselves.
  const LANDMARKS = {
    seattle: [['Downtown Seattle', 47.6062, -122.3321], ['SEA airport', 47.4502, -122.3088], ['Boeing Field', 47.53, -122.3019], ['Paine Field', 47.9063, -122.2816], ['Bellevue', 47.6101, -122.2015], ['Redmond', 47.674, -122.1215], ['Kirkland', 47.6769, -122.206], ['Renton', 47.4829, -122.2171], ['Lynnwood', 47.8209, -122.3151], ['Tacoma', 47.2529, -122.4443], ['Issaquah', 47.5301, -122.0326]],
    dc: [['Downtown DC', 38.9007, -77.0369], ['DCA airport', 38.8512, -77.0402], ['Dulles', 38.9531, -77.4565], ['BWI', 39.1774, -76.6684], ['Arlington', 38.8816, -77.091], ['Bethesda', 38.9847, -77.0947], ['Alexandria', 38.8048, -77.0469]],
    denver: [['Downtown Denver', 39.7392, -104.9903], ['DEN airport', 39.8561, -104.6737], ['Aurora', 39.7294, -104.8319], ['Boulder', 40.015, -105.2705], ['Lakewood', 39.7047, -105.0814], ['Centennial', 39.5807, -104.8772]],
  };
  function addressPoint(company, addr) {
    if (providers.geo) { const g = providers.geo(str(addr)); if (g) return { lat: g.lat, lng: g.lng }; }
    const code = airportCode(addr);
    if (AIRPORT_POINTS[code]) return { ...AIRPORT_POINTS[code] };
    const h = fnv(fold(addr) || 'x');
    return offset(REGION_CENTER[regionOf(company)], 1 + ((h >>> 12) % 120) / 10, ((h % 3600) / 3600) * 2 * Math.PI);
  }
  function milesBetween(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  // A gentle curve between two points, so the simulated route doesn't look like a ruler line.
  function bendPoint(a, b) { return { lat: (a.lat + b.lat) / 2 + (b.lng - a.lng) * 0.18, lng: (a.lng + b.lng) / 2 - (b.lat - a.lat) * 0.18 }; }
  function onCurve(a, c, b, f) { const g = 1 - f; return { lat: g * g * a.lat + 2 * g * f * c.lat + f * f * b.lat, lng: g * g * a.lng + 2 * g * f * c.lng + f * f * b.lng }; }

  // ---- Flights -------------------------------------------------------------

  const FLIGHT_RE = /^([A-Z0-9]{2})\s?(\d{1,4})$/;
  function normFlight(f) {
    const m = str(f, 20).toUpperCase().replace(/[^A-Z0-9 ]/g, '').match(FLIGHT_RE);
    return m ? `${m[1]} ${m[2]}` : null;
  }

  // Stand-in for a flight data service (FlightAware AeroAPI or similar).
  // Gives each flight on each day a stable delay, then works out its status
  // from the clock, so a flight moves from scheduled to in the air to landed.
  function flightStatus(flight, scheduledIso, kind, nowDate, airport) {
    const code = normFlight(flight);
    if (!code) return null;
    const sched = new Date(scheduledIso);
    if (providers.flight) { const r = providers.flight(code, sched.toISOString(), kind, nowDate, airport || ''); if (r) return { airline: AIRLINES[code.slice(0, 2)] || code.slice(0, 2), ...r, flight: code, kind }; }
    const h = fnv(code + '|' + sched.toISOString().slice(0, 10));
    const r = h % 100;
    let delay = 0, cancelled = false;
    if (r < 55) delay = 0;
    else if (r < 85) delay = 15 + ((h >>> 8) % 46);
    else if (r < 97) delay = 61 + ((h >>> 8) % 90);
    else cancelled = true;
    const est = new Date(sched.getTime() + delay * 60000);
    const t = nowDate.getTime();
    let status;
    if (cancelled) status = 'cancelled';
    else if (kind === 'arrival') status = t >= est.getTime() ? 'landed' : t >= est.getTime() - 3 * 3600e3 ? 'in_air' : 'scheduled';
    else status = t >= est.getTime() ? 'departed' : 'scheduled';
    const label = {
      cancelled: 'Cancelled', landed: 'Landed', departed: 'Departed', in_air: 'In the air',
      scheduled: delay ? 'Delayed' : 'On time',
    }[status];
    return {
      flight: code, airline: AIRLINES[code.slice(0, 2)] || code.slice(0, 2), kind, airport: airport || '',
      scheduled: sched.toISOString(), estimated: est.toISOString(), delayMin: delay, status, label,
      terminal: String.fromCharCode(65 + (h >>> 3) % 4), claim: kind === 'arrival' ? 1 + ((h >>> 5) % 12) : null,
      checkedAt: nowDate.toISOString(),
    };
  }

  // ---- Pricing -------------------------------------------------------------

  // ctx carries what is decided once at booking: busy-time pricing, the
  // customer's account discount and any promo code.
  function quote(company, b, ctx) {
    ctx = ctx || {};
    const r = company.rates;
    const p = company.pricing || DEFAULT_PRICING;
    const type = VEHICLE_TYPES.includes(b.vehicleType) ? b.vehicleType : 'Sedan';
    const mult = num(r.multipliers && r.multipliers[type], 1);
    let service = SERVICES[b.service] ? b.service : 'transfer';
    if (service === 'transfer' && (isAirport(b.pickup) || isAirport(b.dropoff))) service = 'airport';
    const via = service !== 'hourly' && Array.isArray(b.stopList) ? b.stopList.filter(Boolean) : [];
    const route = b.dropoff ? routeVia([b.pickup, ...via, b.dropoff]) : { miles: 0, minutes: 0 };
    const overridden = b.milesOverride != null && b.milesOverride !== '';
    let miles = overridden ? num(b.milesOverride, route.miles) : route.miles;
    // Each stop's extra miles: the leg from the last point through the stop
    // to the drop-off, minus going straight there. They add up to the detour.
    // Without a maps service the distances are rough guesses, so the detour
    // is a steady 1 to 8 miles instead of a difference of two guesses.
    const detours = via.map((s, i) => {
      const from = i ? via[i - 1] : b.pickup;
      if (!b.dropoff) return 0;
      if (!providers.route) return round2(1 + (fnv(`${from}|${s}|${b.dropoff}`.toLowerCase()) % 70) / 10);
      return Math.max(0, round2(routeVia([from, s, b.dropoff]).miles - routeVia([from, b.dropoff]).miles));
    });
    const fareMiles = overridden || !via.length ? miles : routeVia([b.pickup, b.dropoff]).miles;
    if (!overridden && via.length && b.dropoff) miles = round2(fareMiles + detours.reduce((x, y) => x + y, 0));
    const lines = [];
    let fare;
    if (service === 'hourly') {
      const hours = Math.max(num(b.hours, r.minHours), r.minHours);
      fare = hours * r.hourly * mult;
      lines.push({ label: `${hours} hours × $${money(r.hourly * mult)}/hr (${type})`, amount: round2(fare), kind: 'fare' });
    } else if (service === 'airport') {
      fare = r.airportFlat * mult;
      lines.push({ label: `Airport flat rate (${type})`, amount: round2(fare), kind: 'fare' });
    } else {
      fare = Math.max((r.base + fareMiles * r.perMile) * mult, r.minFare * mult);
      lines.push({ label: `${fareMiles} mi at $${money(r.perMile * mult)}/mi + $${money(r.base * mult)} base (${type})`, amount: round2(fare), kind: 'fare' });
    }
    fare = round2(fare);

    // Automatic surcharges on the fare
    let surcharges = 0;
    const add = (label, pct) => { if (!pct) return; const a = round2(fare * pct / 100); surcharges += a; lines.push({ label, amount: a, kind: 'surcharge' }); };
    if (b.pickupAt && !isNaN(new Date(b.pickupAt))) {
      const lp = localParts(b.pickupAt, company.timezone);
      const night = p.nightStart > p.nightEnd ? (lp.hour >= p.nightStart || lp.hour < p.nightEnd) : (lp.hour >= p.nightStart && lp.hour < p.nightEnd);
      if (night) add(`Late night ${p.nightPct}%`, p.nightPct);
      if (lp.day === 'sat' || lp.day === 'sun') add(`Weekend ${p.weekendPct}%`, p.weekendPct);
      const peak = (p.peakDates || []).filter((d) => d.date === lp.date).sort((x, y) => y.pct - x.pct)[0];
      if (peak) add(`${peak.label} ${peak.pct}%`, peak.pct);
    }
    if (ctx.busy) add(`Busy time ${p.busyPct}%`, p.busyPct);

    // Add-ons
    let addons = 0;
    const ad = p.addons || DEFAULT_PRICING.addons;
    const childSeats = Math.max(0, Math.min(4, Math.round(num(b.childSeats, 0))));
    const stops = via.length || Math.max(0, Math.min(10, Math.round(num(b.stops, 0))));
    if (childSeats) { const a = round2(childSeats * ad.childSeat); addons += a; lines.push({ label: `Child seat × ${childSeats}`, amount: a, kind: 'addon' }); }
    if (b.meetGreet) { addons += ad.meetGreet; lines.push({ label: 'Meet & greet inside', amount: round2(ad.meetGreet), kind: 'addon' }); }
    if (stops && service !== 'hourly') {
      const defWait = num(ad.stopWait, 10), fee = num(ad.extraStop, 0);
      if (via.length) {
        via.forEach((s, i) => {
          const w = stopWait(b, i, defWait);
          const dist = overridden ? 0 : round2(detours[i] * r.perMile * mult);
          const a = round2(dist + w * r.waitPerMin + fee);
          addons += a;
          const bits = [overridden ? '' : `+${detours[i]} mi`, w ? `${w} min wait` : ''].filter(Boolean).join(', ');
          lines.push({ label: `Stop ${i + 1}: ${s.split(',')[0]}${bits ? ` (${bits})` : ''}`, amount: a, kind: 'addon', stop: i, miles: overridden ? null : detours[i], wait: w });
        });
      } else {
        // Older trips only have a count: charge the usual wait for each.
        const a = round2(stops * (defWait * r.waitPerMin + fee)); addons += a;
        lines.push({ label: `Stop × ${stops} (${defWait} min wait each)`, amount: a, kind: 'addon' });
      }
    }

    // Discounts
    const pre = round2(fare + surcharges + addons);
    let discounts = 0;
    if (ctx.discountPct) { const a = round2(pre * ctx.discountPct / 100); discounts += a; lines.push({ label: `Account discount ${ctx.discountPct}%`, amount: -a, kind: 'discount' }); }
    if (ctx.promo) {
      const base = pre - discounts;
      const a = round2(Math.min(base, ctx.promo.type === 'amount' ? ctx.promo.value : base * ctx.promo.value / 100));
      discounts += a;
      lines.push({ label: `Promo ${ctx.promo.code}`, amount: -a, kind: 'discount' });
    }
    const subtotal = round2(pre - discounts);
    const gratuity = round2(subtotal * r.gratuityPct / 100);
    const tax = round2(subtotal * r.taxPct / 100);
    const waitMin = Math.max(0, num(b.waitMin, 0));
    const tolls = Math.max(0, num(b.tolls, 0));
    const extras = round2(waitMin * r.waitPerMin + tolls);
    if (gratuity) lines.push({ label: `Gratuity ${r.gratuityPct}%`, amount: gratuity, kind: 'gratuity' });
    if (tax) lines.push({ label: `Tax ${r.taxPct}%`, amount: tax, kind: 'tax' });
    if (waitMin) lines.push({ label: `Wait time ${waitMin} min`, amount: round2(waitMin * r.waitPerMin), kind: 'extra' });
    if (tolls) lines.push({ label: 'Tolls and parking', amount: round2(tolls), kind: 'extra' });
    const adj = b.adjustment && num(b.adjustment.amount, 0) ? round2(b.adjustment.amount) : 0;
    if (adj) lines.push({ label: b.adjustment.reason ? `Adjustment: ${b.adjustment.reason}` : 'Adjustment by dispatch', amount: adj, kind: 'adjustment' });
    let total = round2(Math.max(0, subtotal + gratuity + tax + extras + adj));
    if (b.priceOverride != null && b.priceOverride !== '') {
      total = round2(num(b.priceOverride, total));
      lines.push({ label: b.quoteNumber ? `Price from quote ${b.quoteNumber}` : 'Fixed price set by dispatch', amount: null, kind: 'override' });
    }
    // Credit saved from business rides, spent on a personal ride.
    let credit = 0;
    if (ctx.creditMax > 0 && total > 0) { credit = round2(Math.min(total, ctx.creditMax)); total = round2(total - credit); lines.push({ label: 'Your business ride credit', amount: -credit, kind: 'credit' }); }
    return { service, vehicleType: type, miles, minutes: route.minutes, lines, fare, surcharges: round2(surcharges), addons: round2(addons), discounts: round2(discounts), subtotal, gratuity, tax, extras, adjustment: adj, credit, total, promoError: ctx.promoError || null };
  }

  // ---- Factory --------------------------------------------------------------

  function createCore(opts) {
    const { load, save, hash, randomId } = opts;
    const now = opts.now || (() => new Date());
    const reloadEachCall = !!opts.reloadEachCall;
    // Card payments: 'demo' marks trips paid with no charge (sample data and the
    // offline demo), 'stripe' takes real payments through each company's own
    // Stripe account, 'off' means no online card payments (real site without Stripe).
    const payMode = opts.payMode || 'demo';
    const live = opts.live || {};
    let db = null;
    let seeding = null;

    async function ensure() {
      // seed() fills db as it goes; wait for it to finish before anyone reads.
      if (seeding) return seeding;
      if (db && !reloadEachCall) return db;
      const loaded = load();
      if (loaded && loaded.version === SCHEMA_VERSION) { db = normalize(loaded); return db; }
      if (loaded && loaded.version >= 1 && loaded.version < SCHEMA_VERSION) {
        let d = loaded;
        if (d.version === 1) d = migrate1to2(d);
        if (d.version === 2) d = migrate2to3(d);
        if (d.version === 3) d = migrate3to4(d);
        if (d.version === 4) d = migrate4to5(d);
        db = normalize(d); save(db); return db;
      }
      if (!seeding) seeding = seed().then((d) => { db = d; save(db); seeding = null; return d; });
      return seeding;
    }

    // Fills in the fields added for flights, pricing, fleet and drivers.
    function migrate1to2(d) {
      for (const c of d.companies) { c.pricing = c.pricing || clone(DEFAULT_PRICING); c.flight = c.flight || clone(DEFAULT_FLIGHT); }
      for (const v of d.vehicles) { v.status = v.status || (v.active ? 'active' : 'retired'); v.serviceEvery = v.serviceEvery || 5000; v.odometer = v.odometer || 0; v.lastServiceOdometer = v.lastServiceOdometer || 0; }
      for (const u of d.users) if (u.role === 'driver') { delete u.schedule; u.payType = u.payType || 'percent'; u.payRate = u.payRate == null ? 35 : u.payRate; }
      for (const t of d.trips) { t.scheduledPickupAt = t.scheduledPickupAt || t.pickupAt; t.priceCtx = t.priceCtx || {}; }
      d.maintenance = d.maintenance || []; d.timeOff = d.timeOff || []; d.payouts = d.payouts || [];
      d.version = 2;
      return d;
    }

    // Adds the company network (farm-in / farm-out between companies).
    function migrate2to3(d) {
      for (const c of d.companies) c.network = c.network || defaultNetwork(c);
      d.farmouts = d.farmouts || []; d.netMessages = d.netMessages || [];
      d.version = 3;
      return d;
    }
    // Stretch Limo became Business Van (10 passengers).
    function migrate3to4(d) {
      const rn = (x) => (x === 'Stretch Limo' ? 'Business Van' : x);
      for (const v of d.vehicles) if (v.type === 'Stretch Limo') { v.type = 'Business Van'; v.capacity = 10; if (v.name === 'Lincoln Navigator Stretch') v.name = 'Ford Transit'; }
      for (const t of d.trips) t.vehicleType = rn(t.vehicleType);
      for (const c of d.companies) {
        const m = c.rates && c.rates.multipliers;
        if (m && 'Stretch Limo' in m) { if (!('Business Van' in m)) m['Business Van'] = m['Stretch Limo']; delete m['Stretch Limo']; }
      }
      d.version = 4;
      return d;
    }
    // One membership plan: $45 a month plus a $299 setup fee.
    function migrate4to5(d) {
      for (const c of d.companies) { c.plan = 'membership'; c.monthlyFee = 45; c.setupFee = 299; }
      d.version = 5;
      return d;
    }
    // Collections added without a schema bump. Old free-text "company account"
    // names on customers become real corporate accounts.
    function normalize(d) {
      d.accounts = d.accounts || [];
      d.leads = d.leads || [];
      d.pwTokens = d.pwTokens || [];
      d.clientInvoices = d.clientInvoices || [];
      d.quotes = d.quotes || [];
      d.incidents = d.incidents || [];
      d.timeEntries = d.timeEntries || [];
      d.vehiclePhotos = d.vehiclePhotos || {};
      d.inbox = d.inbox || [];
      d.smsOptOut = d.smsOptOut || {};
      if (d.sample === undefined) d.sample = d.users.some((u) => u.email === 'owner@demo.com');
      for (const m of d.messages || []) if (m.metered === undefined) m.metered = true;
      // The single $45 Membership became Founding / Standard / Fleet (v37).
      // Members keep the Founding price, locked from when they joined.
      for (const c of d.companies) if (!PLANS[c.plan]) { c.plan = 'founding'; c.monthlyFee = PLANS.founding.monthly; c.setupFee = 0; c.billing = c.billing || 'monthly'; c.priceLockedUntil = addMonths(c.createdAt || new Date().toISOString(), PLANS.founding.lockMonths).slice(0, 10); }
      // Stops moved from a flat fee to extra miles + wait (v36).
      for (const c of d.companies) { const ad = c.pricing && c.pricing.addons; if (ad && ad.stopWait === undefined) { ad.stopWait = 10; ad.extraStop = 0; } }
      // Sample fleet now runs CT6 / Navigator / Transit / Sprinter (matched by
      // the sample VINs, so a company's own cars are never renamed).
      const SAMPLE_CARS = { W1K6G7GB5PA184417: ['Cadillac CT6', 2020, '1G6KB5RS4LU184417'], '1GYS4KKL2RR108820': ['Lincoln Navigator', 2024, '5LMJJ3LT2REL08820'], '1GKS2DKL8NR303091': ['Lincoln Navigator', 2022, '5LMJJ2LT8NEL03091'], '1FBAX2CG5PKA01200': ['Ford Transit'] };
      for (const v of d.vehicles) { const m = SAMPLE_CARS[v.vin]; if (m) { v.name = m[0]; if (m[1]) { v.year = m[1]; v.vin = m[2]; } } }
      for (const u of d.users) {
        if (u.role !== 'customer' || !u.account || u.accountId) continue;
        let a = d.accounts.find((x) => x.companyId === u.companyId && x.name.toLowerCase() === u.account.toLowerCase());
        if (!a) {
          d.seq.acct = (d.seq.acct || 0) + 1;
          a = { id: `acct_${d.seq.acct}`, companyId: u.companyId, name: u.account, contact: u.name, billingEmail: u.email || '', phone: u.phone || '', address: '', terms: 30, discountPct: u.discountPct || 0, requirePo: false, notes: '', active: true, createdAt: new Date().toISOString() };
          d.accounts.push(a);
        }
        u.accountId = a.id;
      }
      return d;
    }
    function defaultNetwork(c) { return { joined: false, areas: '', about: c ? c.tagline || '' : '', read: {} }; }

    const id = (prefix) => { db.seq[prefix] = (db.seq[prefix] || 0) + 1; return `${prefix}_${db.seq[prefix]}`; };
    const findUser = (uid) => db.users.find((u) => u.id === uid);
    const findCompany = (cid) => db.companies.find((c) => c.id === cid);
    const findVehicle = (vid) => db.vehicles.find((v) => v.id === vid);
    const findAccount = (c, aid) => aid ? (db.accounts || []).find((x) => x.id === aid && x.companyId === c.id) : null;
    const pubUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, companyId: u.companyId, active: u.active !== false, vehicleId: u.vehicleId || null, available: !!u.available, ...(u.role === 'customer' ? { prefs: pubUserPrefs(u), card: pubCard(u.card), agent: u.agent ? { agency: u.agent.agency, commissionPct: agentPct(u), commissionOn: u.agent.commissionOn !== false } : null, credit: u.credit ? u.credit.balance : 0 } : {}), ...(u.role === 'driver' ? { photo: u.photo || '' } : {}), ...(u.role === 'admin' || u.role === 'dispatcher' ? { perms: staffPerms(u) } : {}), ...(u.role === 'admin' ? { master: isMaster(u) } : {}) });
    const bagsCfg = (c) => ({ ...DEFAULT_BAGS, ...((c.rates && c.rates.bags) || {}) });
    const pcfg = (c) => ({ ...DEFAULT_POLICY, ...(c.policy || {}) });
    const agentCfg = (c) => ({ ...DEFAULT_AGENTS, ...((c && c.agents) || {}) });
    const agentPct = (u) => { if (!u || !u.agent || u.agent.commissionOn === false) return 0; const c = findCompany(u.companyId); return u.agent.commissionPct != null ? u.agent.commissionPct : agentCfg(c).on ? agentCfg(c).commissionPct : 0; };
    // Commission on a finished ride: the ride price before gratuity and tax.
    const commissionOf = (t) => (t.agent && t.status === 'completed' ? round2(((t.price && t.price.subtotal) || 0) * (t.agent.pct || 0) / 100) : 0);
    const pubUserPrefs = (u) => (u && u.prefs ? clone(u.prefs) : null);
    const cardsOn = (c) => payMode === 'demo' || (payMode === 'stripe' && !!(c.stripe && c.stripe.ready));
    const pubCompany = (c) => c && ({ id: c.id, slug: c.slug, name: c.name, tagline: c.tagline, color: c.color, phone: c.phone, email: c.email, status: c.status, timezone: c.timezone, cards: cardsOn(c), payMode });

    async function hashPw(pw, salt) { return hash(String(pw), salt); }
    async function setPassword(u, pw) { u.salt = randomId(8); u.passHash = await hashPw(pw, u.salt); }
    // Each company has one master login: the only one who can open payment
    // settings, after entering the payment PIN. It starts as the first admin.
    function masterOf(c) {
      const admins = db.users.filter((u) => c && u.companyId === c.id && u.role === 'admin' && u.active !== false);
      return admins.find((u) => u.id === c.masterId) || admins[0] || null;
    }
    const isMaster = (u) => !!u && u.role === 'admin' && masterOf(findCompany(u.companyId)) === u;
    const PIN_TRIES = 5, PIN_LOCK_MIN = 15, PIN_OPEN_MIN = 15;
    function payLockState(u, token) {
      const c = findCompany(u.companyId), m = masterOf(c), s = token && db.sessions[token];
      const until = s && s.payUnlockedUntil && s.payUnlockedUntil > now().toISOString() ? s.payUnlockedUntil : null;
      return { isMaster: m === u, masterName: m ? m.name : '', pinSet: !!c.paymentPin, unlocked: m === u && !!c.paymentPin && !!until, until, lockedUntil: c.pinLockUntil && c.pinLockUntil > now().toISOString() ? c.pinLockUntil : null };
    }
    // Throws unless this is the master login with payments unlocked by PIN.
    function payGate(u, token) {
      const st = payLockState(u, token);
      if (!st.isMaster) fail(`Only the master login${st.masterName ? ` (${st.masterName})` : ''} can open payment settings.`, 403);
      if (!st.pinSet) fail('Set a payment PIN first.', 423);
      if (!st.unlocked) fail('Enter your payment PIN to open payment settings.', 423);
    }

    function log(trip, status, by, note) { trip.history.push({ at: now().toISOString(), status, by, ...(note ? { note } : {}) }); }
    function fmtLocal(iso, c, withDay) {
      try { return new Date(iso).toLocaleString('en-US', { timeZone: c.timezone || 'America/New_York', ...(withDay ? { weekday: 'short', month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' }); }
      catch (e) { return iso; }
    }

    const cmsg = (c) => ({ ...DEFAULT_CLIENT_MSGS, ...(c.clientMsgs || {}) });
    const reviewUrl = (t) => `${opts.publicUrl || ''}#review.${t.reviewToken}`;
    const cardUrl = (t) => `${opts.publicUrl || ''}#card.${t.cardToken}`;
    // The words a template can use, for one trip.
    function msgVars(t, extra) {
      const c = findCompany(t.companyId);
      const aff = !t.driverId && t.affiliate;
      const d = t.driverId ? findUser(t.driverId) : aff && aff.driver ? aff.driver : null;
      const v = t.vehicleId ? findVehicle(t.vehicleId) : aff && aff.vehicle ? aff.vehicle : null;
      const ns = t.noShow || {};
      const lt = t.landingId && db.trips.find((x) => x.id === t.landingId);
      const away = (x) => (x.outOfTown ? { timezone: x.outOfTown.tz } : c);
      return {
        company: c.name, ref: t.ref, passenger: (t.passengerName || '').split(' ')[0], pickup_time: fmtLocal(t.pickupAt, away(t), true) + (t.outOfTown ? ` ${t.outOfTown.city} time` : ''),
        landing_line: lt && lt.status !== 'cancelled' ? ` Your pickup when you land: ${lt.ref}, ${lt.pickup.split(',')[0]}, ${fmtLocal(lt.pickupAt, away(lt), true)}${lt.outOfTown ? ` ${lt.outOfTown.city} time` : ''}, to ${lt.dropoff}. We follow your flight and move it if you land late.` : '',
        landing_short_line: lt && lt.status !== 'cancelled' ? ` Pickup when you land: ${lt.ref}.` : '', pickup: t.pickup, dropoff: t.dropoff || '',
        vehicle_type: t.vehicleType, passengers: `${t.passengers} passenger${t.passengers === 1 ? '' : 's'}`,
        ride: `${SERVICES[t.service] || 'Ride'}${t.service === 'hourly' ? `, ${t.hours} h` : ''}, ${t.vehicleType}, ${t.passengers} passenger${t.passengers === 1 ? '' : 's'}`,
        driver: d ? d.name : 'Your chauffeur', driver_first: d && d.name ? d.name.split(' ')[0] : 'Your chauffeur', driver_and: d && d.name ? ` and ${d.name.split(' ')[0]}` : '',
        vehicle: v ? v.name : t.vehicleType, plate: v ? v.plate || '' : '', vehicle_line: v ? `, ${[v.color, v.name].filter(Boolean).join(' ')}${v.plate ? `, plate ${v.plate}` : ''}` : '',
        car_line: v ? ` Look for a ${[v.color, v.name].filter(Boolean).join(' ')}${v.plate ? `, plate ${v.plate}` : ''}.` : '',
        total: `$${money(t.price.total)}`, phone: c.phone || 'us', flight: t.flight || '',
        track_link: t.trackToken ? trackUrl(t) : '', review_link: t.reviewToken ? reviewUrl(t) : '', card_link: t.cardToken ? cardUrl(t) : '',
        call_line: c.phone ? ` Questions? Call ${c.phone}.` : '', wrong_line: c.phone ? ` If this is wrong, call ${c.phone}.` : '',
        dropoff_line: t.dropoff ? ` Drop-off: ${t.dropoff}.` : '',
        flight_line: t.flight ? ` Flight ${t.flight}; we track it and adjust pickup if it's late.` : '',
        flight_short_line: t.flight ? ` We're tracking flight ${t.flight}.` : '',
        flight_track_line: t.flight ? ` We're tracking flight ${t.flight} and will adjust pickup if it's late.` : '',
        chauffeur_line: d && t.status !== 'assigned' && t.status !== 'confirmed' ? ` Your chauffeur is ${d.name.split(' ')[0]}${v ? `, ${[v.color, v.name].filter(Boolean).join(' ')}${v.plate ? `, plate ${v.plate}` : ''}` : ''}.` : '',
        track_line: t.trackToken ? ` Follow the car live: ${trackUrl(t)}` : '',
        amount: `$${money(t.price.total)}`, last4: t.card ? t.card.last4 : '', extras: extrasText(t),
        waited: ns.waitedMin ? ` ${ns.waitedMin} min` : '', fee: ns.fee ? `$${money(ns.fee)}` : '', fee_line: ns.fee ? ` A no-show fee of $${money(ns.fee)} applies.` : '',
        ...(extra || {}),
      };
    }
    // A company's own wording if it set one, otherwise the default.
    function msgText(t, key, extra) {
      const c = findCompany(t.companyId);
      const own = c.templates && c.templates[key];
      const vars = msgVars(t, extra);
      return (own || MSG_TEMPLATES[key].text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/ {2,}/g, ' ').trim();
    }
    function reviewMsgs(t) {
      const out = [];
      if (t.passengerPhone) out.push({ recipient: t.passengerPhone, channel: 'sms', body: msgText(t, 'review_sms') });
      if (t.passengerEmail) out.push({ recipient: t.passengerEmail, channel: 'email', body: msgText(t, 'review_email') });
      return out;
    }
    // Text and/or email to the passenger, each on its own line in the log.
    function toClient(t, sms, email, kind) {
      for (const [recipient, channel, body] of [[t.passengerPhone, 'sms', sms], [t.passengerEmail, 'email', email]]) {
        if (!recipient || !body) continue;
        db.messages.unshift({ id: id('msg'), companyId: t.companyId, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient, channel, body, kind });
      }
      if (db.messages.length > 600) db.messages.length = 600;
    }

    function notify(trip, kind, extra) {
      const c = findCompany(trip.companyId);
      const aff = !trip.driverId && trip.affiliate;
      const driver = trip.driverId ? findUser(trip.driverId) : aff && aff.driver ? aff.driver : null;
      const vehicle = trip.vehicleId ? findVehicle(trip.vehicleId) : aff && aff.vehicle ? aff.vehicle : null;
      const when = fmtLocal(trip.pickupAt, c, true);
      const to = trip.passengerPhone || trip.passengerEmail || trip.passengerName;
      const channel = trip.passengerPhone ? 'sms' : 'email';
      const msgs = [];
      // A trip taken from a partner: the partner's office talks to the passenger
      // under its own brand, so only driver messages go out from here.
      const passenger = [to, trip.passengerPhone, trip.passengerEmail].filter(Boolean);
      const say = (recipient, ch, body) => { if (trip.farmIn && passenger.includes(recipient)) return; msgs.push({ recipient, channel: ch, body }); };
      if (kind === 'booked') {
        const cm = cmsg(c);
        const sent = [];
        if (cm.confirmText && trip.passengerPhone) { say(trip.passengerPhone, 'sms', msgText(trip, 'confirm_sms')); sent.push(1); }
        if (cm.confirmEmail && trip.passengerEmail) {
          say(trip.passengerEmail, 'email', msgText(trip, 'confirm_email'));
          sent.push(1);
        }
        if (!sent.length && !trip.passengerPhone && !trip.passengerEmail) say(to, channel, `${c.name}: booking ${trip.ref} confirmed for ${when} from ${trip.pickup}.`);
      }
      if (kind === 'assigned' && driver && trip.driverId) say(driver.phone || driver.email, 'sms', `New trip ${trip.ref} ${when}: pickup ${trip.pickup}. Open the driver app to accept${extra && extra.minutes ? ` within ${extra.minutes} min` : ''}.`);
      if (kind === 'accepted' && driver) {
        say(to, channel, msgText(trip, 'accepted'));
        // Booked with an email too: the chauffeur and car go there as well.
        if (channel === 'sms' && trip.passengerEmail && cmsg(c).confirmEmail) say(trip.passengerEmail, 'email', msgText(trip, 'accepted'));
      }
      if (kind === 'en_route' && driver) say(to, channel, msgText(trip, 'en_route'));
      if (kind === 'approach') say(to, channel, msgText(trip, 'approach'));
      if (kind === 'arrived') say(to, channel, msgText(trip, 'arrived'));
      if (kind === 'completed') {
        say(trip.passengerEmail || to, 'email', msgText(trip, 'receipt'));
        if (!trip.farmIn && cmsg(c).review && !trip.rating && !trip.reviewSentAt) {
          if (!trip.reviewToken) trip.reviewToken = randomId(6);
          const delay = cmsg(c).reviewDelayMin;
          if (delay > 0) trip.reviewDueAt = new Date(now().getTime() + delay * 60e3).toISOString();
          else for (const m of reviewMsgs(trip)) say(m.recipient, m.channel, m.body), trip.reviewSentAt = now().toISOString();
        }
      }
      if (kind === 'cancelled') say(to, channel, msgText(trip, 'cancelled'));
      if (kind === 'no_show') {
        say(to, channel, msgText(trip, 'no_show'));
      }
      if (kind === 'flight_moved') {
        const msg = `${c.name}: flight ${trip.flight} is running ${extra.delayMin} min late. Pickup for ${trip.ref} moved to ${fmtLocal(trip.pickupAt, c)}.`;
        say(to, channel, msg);
        if (driver && trip.driverId) say(driver.phone || driver.email, 'sms', msg);
      }
      if (kind === 'flight_cancelled') say(c.phone || c.email || 'Dispatch office', 'email', `Flight ${trip.flight} for ${trip.ref} (${trip.passengerName}) shows as cancelled. Call the passenger to rebook.`);
      for (const m of msgs) db.messages.unshift({ id: id('msg'), companyId: trip.companyId, tripId: trip.id, ref: trip.ref, at: now().toISOString(), ...m });
      if (db.messages.length > 600) db.messages.length = 600;
    }

    // ---- Live tracking -------------------------------------------------------
    // Starts when the driver taps "On the way". The driver app sends GPS
    // (driver.location); without fresh GPS the position is simulated along the
    // route so the demo moves. Ends when the driver arrives.
    function startTracking(t) {
      const c = findCompany(t.companyId);
      const to = addressPoint(c, t.pickup);
      const h = fnv(t.id + '|' + (t.driverId || t.ref));
      const miles = 2.5 + (h % 85) / 10;
      const from = offset(to, miles, (((h >>> 8) % 360) * Math.PI) / 180);
      t.tracking = { startedAt: now().toISOString(), from, to, ctrl: bendPoint(from, to), minutes: Math.max(8, Math.round(miles * 2.4 + 4)), gps: null };
      if (!t.trackToken) t.trackToken = randomId(6);
    }
    function liveOf(t) {
      const tr = t.tracking;
      if (!tr || !['en_route', 'arrived'].includes(t.status)) return null;
      const n = now().getTime();
      const fresh = tr.gps && n - new Date(tr.gps.at).getTime() < 3 * 60e3;
      let pos, source = fresh ? 'gps' : 'simulated';
      if (t.status === 'arrived') pos = tr.to;
      else if (fresh) pos = { lat: tr.gps.lat, lng: tr.gps.lng };
      else {
        const f = Math.min(0.97, Math.max(0.02, (n - new Date(tr.startedAt).getTime()) / (tr.minutes * 60e3)));
        pos = onCurve(tr.from, tr.ctrl, tr.to, f);
      }
      const left = t.status === 'arrived' ? 0 : milesBetween(pos, tr.to);
      return {
        from: tr.from, to: tr.to, ctrl: tr.ctrl, pos, source, arrived: t.status === 'arrived',
        milesLeft: Math.round(left * 10) / 10, etaMin: t.status === 'arrived' ? 0 : Math.max(1, Math.round(left * 2.4 + 1)),
        updatedAt: fresh ? tr.gps.at : now().toISOString(), startedAt: tr.startedAt,
      };
    }
    const trackUrl = (t) => `${opts.publicUrl || ''}#track.${t.trackToken}`;

    function tripView(t) {
      const d = t.driverId && findUser(t.driverId);
      const v = t.vehicleId && findVehicle(t.vehicleId);
      return {
        ...clone(t),
        card: pubCard(t.card),
        pay: payView(t),
        live: liveOf(t),
        account: t.accountId ? (() => { const a = db.accounts.find((x) => x.id === t.accountId); const inv = t.invoiceId && db.clientInvoices.find((x) => x.id === t.invoiceId); return a ? { id: a.id, name: a.name, invoice: inv ? { id: inv.id, number: inv.number, status: inv.status } : null } : null; })() : null,
        statusLabel: t.noShow ? 'No-show' : STATUS_LABELS[t.status],
        serviceLabel: SERVICES[t.service],
        wait: waitInfo(t),
        commission: t.agent ? commissionOf(t) : 0,
        cancelTerms: ['confirmed', 'assigned', 'accepted'].includes(t.status) ? cancelTerms(t) : null,
        landing: (() => { const o = (t.landingId || t.landingOf) && db.trips.find((x) => x.id === (t.landingId || t.landingOf)); return o ? { kind: t.landingId ? 'landing' : 'outbound', id: o.id, ref: o.ref, pickupAt: o.pickupAt, status: o.status, city: (o.outOfTown || t.outOfTown || {}).city || '' } : null; })(),
        awayTime: t.outOfTown ? `${fmtLocal(t.pickupAt, { timezone: t.outOfTown.tz }, true)} ${t.outOfTown.city} time` : '',
        pair: (() => { const o = (t.returnId || t.returnOf) && db.trips.find((x) => x.id === (t.returnId || t.returnOf)); return o ? { kind: t.returnId ? 'return' : 'outbound', id: o.id, ref: o.ref, pickupAt: o.pickupAt } : null; })(),
        driver: d ? { id: d.id, name: d.name, phone: d.phone } : (t.affiliate && t.affiliate.driver ? { id: null, name: t.affiliate.driver.name, phone: t.affiliate.driver.phone, partner: t.affiliate.companyName } : null),
        vehicle: v ? { id: v.id, name: v.name, type: v.type, plate: v.plate, capacity: v.capacity, color: v.color || '', year: v.year || null } : (t.affiliate && t.affiliate.vehicle ? { id: null, ...t.affiliate.vehicle } : null),
      };
    }

    // The chauffeur's photo, for the passenger's own screens only (lists for the
    // office skip it to stay small). A partner's chauffeur comes from the copy.
    const driverPhoto = (t) => { const d = t.driverId && findUser(t.driverId); return (d && d.photo) || (t.affiliate && t.affiliate.driver && t.affiliate.driver.photo) || ''; };
    const withPhoto = (view, t) => (view.driver ? { ...view, driver: { ...view.driver, photo: driverPhoto(t) } } : view);
    // Photos arrive as small data URLs the browser has already cropped and shrunk.
    function cleanPhoto(p) {
      const s = String(p || '');
      if (!s) return '';
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) fail('Choose a JPEG or PNG photo.');
      if (s.length > 200000) fail('That photo is too large. Try a smaller one.');
      return s;
    }
    // A booking and, when asked for, its return: the same ride the other way at
    // returnAt. Both are checked before either is made.
    function bookingPair(company, raw, o) {
      const b = cleanBooking(company, raw, o);
      if (!raw.returnAt) return [b, null];
      if (b.service === 'hourly') fail('A return trip is only for transfers. For by-the-hour, book the hours you need.');
      let r;
      try {
        r = cleanBooking(company, { ...raw, pickup: b.dropoff, dropoff: b.pickup, stopList: (b.stopList || []).slice().reverse(), stopWaits: (b.stopWaits || []).slice().reverse(), pickupAt: raw.returnAt, flight: raw.returnFlight || '', meetGreet: isAirport(b.dropoff) && b.meetGreet }, o);
      } catch (e) { if (e instanceof ApiError) e.message = 'Return trip: ' + e.message; throw e; }
      if (new Date(r.pickupAt) <= new Date(b.pickupAt)) fail('Return trip: the return pickup must be after the first pickup.');
      return [b, r];
    }
    // ---- Repeating rides ----------------------------------------------------------
    // "Every Mon, Wed and Fri until Dec 18": the first ride is booked as usual and
    // each later date gets its own trip (and return), all made up front and
    // linked by series.id so the office and customer can cancel the rest at once.
    const MAX_REPEAT = 60, REPEAT_DAYS_AHEAD = 183;
    const clock12 = (p) => `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
    const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
    function repeatPlan(company, b, raw) {
      const rep = raw.repeat;
      if (!rep || !rep.on) return null;
      const days = (Array.isArray(rep.days) ? rep.days : []).filter((d) => DAYS.includes(d));
      if (!days.length) fail('Repeat: pick the days the ride repeats.');
      if (!dateOk(rep.until)) fail('Repeat: choose the last date.');
      const tz = company.timezone, first = localParts(b.pickupAt, tz);
      if (rep.until <= first.date) fail('Repeat: the last date must be after the first ride.');
      if (dayDiff(first.date, rep.until) > REPEAT_DAYS_AHEAD) fail('Repeat: rides can be booked up to 6 months ahead.');
      const hm = (p) => `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      const ret = raw.returnAt && raw.returnAt !== 'missing' ? localParts(raw.returnAt, tz) : null;
      const out = [];
      for (let date = addDays(first.date, 1); date <= rep.until; date = addDays(date, 1)) {
        if (!days.includes(localParts(localToIso(date, '12:00', company), tz).day)) continue;
        out.push({ pickupAt: localToIso(date, hm(first), company), returnAt: ret ? localToIso(addDays(date, dayDiff(first.date, ret.date)), hm(ret), company) : undefined });
        if (out.length > MAX_REPEAT) fail(`Repeat: that makes more than ${MAX_REPEAT} rides. Pick an earlier last date.`);
      }
      if (!out.length) fail('Repeat: no ride dates fall on those days before the last date.');
      return { days, until: rep.until, dates: out };
    }
    // Checks every later ride before any is made, then makes them quietly and
    // sends the passenger one message for the whole series.
    function bookRepeats(company, raw, plan, t, r, customer, source, by, o) {
      if (!plan) return [];
      const pairs = plan.dates.map((d, i) => {
        try { return bookingPair(company, { ...raw, pickupAt: d.pickupAt, returnAt: d.returnAt, promoCode: '', repeat: undefined }, o); }
        catch (e) { if (e instanceof ApiError) e.message = `Repeat ride ${i + 2}: ` + e.message.replace(/^Return trip: /, 'return: '); throw e; }
      });
      const sid = id('ser'), total = pairs.length + 1;
      const tag = (x, n) => { x.series = { id: sid, n, of: total, days: plan.days, until: plan.until }; };
      tag(t, 1); if (r) tag(r, 1);
      const made = [];
      pairs.forEach(([b2, rb2], i) => {
        const t2 = newTrip(company, b2, customer, source, by, '', true); tag(t2, i + 2);
        if (t.termsAgreed) t2.termsAgreed = t.termsAgreed;
        let r2 = null;
        if (rb2) { r2 = newTrip(company, rb2, customer, source, by, '', true); tag(r2, i + 2); linkReturn(t2, r2); if (t.termsAgreed) r2.termsAgreed = t.termsAgreed; }
        made.push(t2); if (r2) made.push(r2);
      });
      const to = t.passengerPhone || t.passengerEmail;
      if (to) {
        const dn = plan.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
        db.messages.unshift({ id: id('msg'), companyId: company.id, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: to, channel: t.passengerPhone ? 'sms' : 'email', kind: 'series',
          body: `${company.name}: your repeating ride is booked. ${total} rides, every ${dn} at ${clock12(localParts(t.pickupAt, company.timezone))}, from ${t.pickup}${t.dropoff ? ` to ${t.dropoff}` : ''}${r ? ', with the return' : ''}, until ${plan.until}. First ride ${t.ref}.` });
      }
      return made;
    }
    // Later rides in the series from this one on that haven't started.
    const seriesRest = (t) => t.series ? db.trips.filter((x) => x.series && x.series.id === t.series.id && x.pickupAt >= t.pickupAt && ['confirmed', 'assigned', 'accepted'].includes(x.status)).sort((a, b) => a.pickupAt.localeCompare(b.pickupAt)) : [];
    function linkReturn(t, r) { t.returnId = r.id; r.returnOf = t.id; log(r, 'confirmed', 'System', `Return of ${t.ref}`); }
    // The company's own booking terms. Customers tick a box to agree when
    // booking online; the trip keeps which version they agreed to.
    function agreeTerms(c, a, by) {
      const text = (c.terms || '').trim();
      if (!text) return null;
      if (!a.agreeTerms) fail(`Please read and agree to ${c.name}'s booking terms.`);
      const version = fnv(text).toString(36);
      c.termsVersions = c.termsVersions || {};
      if (!c.termsVersions[version]) c.termsVersions[version] = { text, since: now().toISOString() };
      return { version, at: now().toISOString(), by: str(by, 80) };
    }
    // Free cancellation until cancelHours before pickup, then a fee.
    function cancelTerms(t) {
      const c = findCompany(t.companyId), pol = pcfg(c);
      const freeUntil = new Date(new Date(t.pickupAt).getTime() - pol.cancelHours * 3600e3);
      const late = now() > freeUntil;
      return { freeUntil: freeUntil.toISOString(), late, fee: late && pol.cancelFeePct > 0 ? round2(t.price.total * pol.cancelFeePct / 100) : 0, hours: pol.cancelHours, pct: pol.cancelFeePct };
    }

    // Free waiting at pickup. It starts when the driver arrives, or at the
    // pickup time if they're early; after it a no-show can be marked.
    function waitInfo(t) {
      if (t.status !== 'arrived') return null;
      const pol = pcfg(findCompany(t.companyId)), airport = isAirport(t.pickup);
      const arr = t.history.filter((h) => h.status === 'arrived').pop();
      const start = Math.max(arr ? new Date(arr.at).getTime() : now().getTime(), new Date(t.pickupAt).getTime());
      const freeMin = airport ? pol.waitAirport : pol.waitOther;
      return { from: new Date(start).toISOString(), freeMin, endsAt: new Date(start + freeMin * 60e3).toISOString(), airport };
    }
    // Closes the trip as a no-show. It counts as cancelled everywhere (driver
    // free, not billed as a ride); the fee is recorded for the office.
    function markNoShow(t, by, note) {
      const w = waitInfo(t), pct = pcfg(findCompany(t.companyId)).noShowFeePct;
      const waitedMin = w ? Math.max(0, Math.round((now().getTime() - new Date(w.from).getTime()) / 60e3)) : 0;
      const fee = pct > 0 ? round2(t.price.total * pct / 100) : 0;
      t.status = 'cancelled'; t.offer = null; t.needsDriver = null;
      t.noShow = { at: now().toISOString(), by, waitedMin, fee, note: str(note, 200) };
      log(t, 'no_show', by, [waitedMin ? `Waited ${waitedMin} min` : '', fee ? `No-show fee $${money(fee)}` : '', t.noShow.note].filter(Boolean).join('. '));
      notify(t, 'no_show');
      payStep(t);
    }

    // ---- Card on file -----------------------------------------------------------
    // No deposits. The customer saves a card when booking and the fare goes on it
    // straight away (policy.chargeWhen 'booking', the default), or, if the company
    // chooses 'before', policy.chargeHours before pickup (at once when sooner). Extras (waiting, stops, a new destination, tolls) go on the same
    // card EXTRAS_AFTER_MIN after drop-off. A cancellation keeps any fee and
    // refunds the rest. Demo charges settle at once (a card ending 0341 is
    // declined); with Stripe the server runs queued charges off-session.
    const EXTRAS_AFTER_MIN = 30;
    const pubCard = (k) => (k ? { brand: k.brand || 'Card', last4: k.last4, exp: k.exp || '', savedAt: k.savedAt } : null);
    const onFile = (t) => t.payment.method === 'card_on_file' && !t.accountId && !t.farmIn;
    function demoCard(a, by) {
      const digits = String((a && (a.number || a.card)) || '').replace(/\D/g, '');
      if (digits.length < 12 || digits.length > 19) fail('Enter the card number.');
      const exp = str(a.exp, 7);
      if (exp && !/^(0[1-9]|1[0-2])\s*\/\s*\d{2}$/.test(exp)) fail('Enter the expiry as MM/YY.');
      return { brand: { 4: 'Visa', 5: 'Mastercard', 3: 'Amex', 6: 'Discover' }[digits[0]] || 'Card', last4: digits.slice(-4), exp: exp.replace(/\s/g, ''), savedAt: now().toISOString(), by: str(by, 80) };
    }
    const atBooking = (c) => pcfg(c).chargeWhen !== 'before';
    const chargeAt = (t) => { const c = findCompany(t.companyId); return atBooking(c) && !(t.series && t.series.n > 1) ? (t.createdAt || now().toISOString()) : new Date(new Date(t.pickupAt).getTime() - pcfg(c).chargeHours * 3600e3).toISOString(); };
    // How the fare timing reads in texts and errors.
    const chargeNote = (c) => atBooking(c) ? 'The fare is charged when the card is saved' : `Nothing is charged until ${pcfg(c).chargeHours} hours before pickup`;
    const refundedOf = (t, cid) => (t.payment.charges || []).filter((r) => r.kind === 'refund' && r.of === cid && r.status !== 'failed').reduce((n, r) => n + r.amount, 0);
    function payState(t) {
      const ch = t.payment.charges || [];
      const took = ch.filter((x) => x.kind !== 'refund' && x.status === 'paid').reduce((n, x) => n + x.amount, 0);
      const back = ch.filter((x) => x.kind === 'refund' && x.status !== 'failed').reduce((n, x) => n + x.amount, 0);
      const paid = round2(took - back);
      const due = t.status === 'cancelled' ? round2(t.noShow ? t.noShow.fee || 0 : t.cancelFee || 0) : round2(t.price.total);
      return { paid, due, balance: round2(due - paid), pending: ch.find((x) => x.status === 'pending') || null, failed: ch.find((x) => x.status === 'failed' && !x.retired) || null, fare: ch.some((x) => x.kind === 'fare' && x.status === 'paid') };
    }
    function payView(t) {
      if (!onFile(t)) return null;
      const s = payState(t), c = findCompany(t.companyId);
      return { chargeAt: chargeAt(t), chargeWhen: atBooking(c) ? 'booking' : 'before', chargeHours: pcfg(c).chargeHours, extrasAfterMin: EXTRAS_AFTER_MIN, paid: s.paid, due: s.due, balance: s.balance, fareCharged: s.fare, pending: !!s.pending,
        failed: s.failed ? { amount: s.failed.amount, error: s.failed.error, at: s.failed.at } : null, needsCard: !t.card, cardLink: t.cardToken ? cardUrl(t) : '',
        charges: (t.payment.charges || []).map((x) => ({ id: x.id, kind: x.kind, amount: x.amount, status: x.status, at: x.doneAt || x.at, last4: x.last4, error: x.error || '', retired: !!x.retired, by: x.by })) };
    }
    // Marks the trip paid once the charges cover what's owed.
    function settle(t) {
      const s = payState(t);
      if (s.due > 0 && s.balance <= 0.004) {
        if (t.payment.status !== 'paid') { const last = (t.payment.charges || []).filter((x) => x.status === 'paid' && x.kind !== 'refund').pop(); t.payment.status = 'paid'; t.payment.paidAt = (last && (last.doneAt || last.at)) || now().toISOString(); t.payment.last4 = last ? last.last4 : ''; }
      } else { t.payment.status = 'unpaid'; t.payment.paidAt = null; }
    }
    function extrasText(t) {
      const out = [];
      if (t.waitMin) out.push(`waiting ${t.waitMin} min`);
      if (t.tolls) out.push('tolls');
      if (t.adjustment && t.adjustment.amount > 0) out.push(t.adjustment.reason || 'an added charge');
      return out.join(', ') || 'changes to the ride';
    }
    function cardSay(t, key, x) {
      const to = t.passengerPhone || t.passengerEmail;
      if (!to) return;
      db.messages.unshift({ id: id('msg'), companyId: t.companyId, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: to, channel: t.passengerPhone ? 'sms' : 'email', body: msgText(t, key, { amount: `$${money(x.amount)}`, last4: x.last4 || (t.card && t.card.last4) || '', extras: extrasText(t) }) });
    }
    function finishCharge(t, x, r) {
      if (!x || x.status !== 'pending') return;
      x.doneAt = now().toISOString();
      if (r.ok) {
        x.status = 'paid'; x.ref = str(r.ref, 80);
        if (x.kind === 'refund') { log(t, 'refunded', 'Card', `$${money(x.amount)} refunded to card ending ${x.last4}`); cardSay(t, 'card_refund', x); }
        else { log(t, 'paid', 'Card', `${x.kind === 'extra' ? 'Extras' : x.kind === 'fee' ? 'Fee' : 'Fare'} $${money(x.amount)} charged to card ending ${x.last4}`); cardSay(t, x.kind === 'extra' ? 'card_extra' : 'card_charged', x); }
      } else {
        x.status = 'failed'; x.error = str(r.error, 200) || 'Card declined';
        log(t, 'card_failed', 'Card', `${x.kind === 'refund' ? 'Refund' : 'Charge'} of $${money(x.amount)} failed: ${x.error}`);
        if (x.kind !== 'refund') cardSay(t, 'card_failed', x);
      }
      settle(t);
    }
    function queueCharge(t, kind, amount, by) {
      t.payment.charges = t.payment.charges || [];
      const x = { id: id('chg'), kind, amount: round2(amount), status: 'pending', at: now().toISOString(), by: by || 'System', last4: t.card ? t.card.last4 : '' };
      t.payment.charges.push(x);
      if (payMode === 'demo') finishCharge(t, x, t.card && t.card.last4 === '0341' ? { ok: false, error: 'Card declined' } : { ok: true, ref: `demo_${randomId(5)}` });
      return x;
    }
    // Refunds come off the newest charges first.
    function queueRefund(t, amount, by) {
      let left = round2(amount);
      for (const x of (t.payment.charges || []).filter((y) => y.kind !== 'refund' && y.status === 'paid').reverse()) {
        const room = round2(x.amount - refundedOf(t, x.id));
        if (left <= 0.004 || room <= 0.004) continue;
        const r = { id: id('rfd'), kind: 'refund', of: x.id, amount: round2(Math.min(room, left)), status: 'pending', at: now().toISOString(), by: by || 'System', last4: x.last4 };
        t.payment.charges.push(r); left = round2(left - r.amount);
        if (payMode === 'demo') finishCharge(t, r, { ok: true, ref: `demo_${randomId(5)}` });
      }
    }
    // What the card should do next for this trip, if anything. Runs with the
    // dispatch timers and right after anything that changes what's owed.
    function payStep(t) {
      if (!onFile(t) || !cardsOn(findCompany(t.companyId))) return false;
      const s = payState(t);
      if (s.pending || s.failed) return false;
      const n = now().getTime();
      if (t.status === 'cancelled') {
        if (s.balance < -0.004) { queueRefund(t, -s.balance); return true; }
        if (s.balance > 0.004 && t.card) { queueCharge(t, 'fee', s.balance); return true; }
        return false;
      }
      if (!t.card) return false;
      if (t.status === 'completed') {
        const done = t.history.filter((h) => h.status === 'completed').pop();
        if (s.balance > 0.004 && (!done || n - new Date(done.at).getTime() >= EXTRAS_AFTER_MIN * 60e3)) { queueCharge(t, s.fare ? 'extra' : 'fare', s.balance); return true; }
        return false;
      }
      if (!s.fare && s.balance > 0.004 && n >= new Date(chargeAt(t)).getTime()) { queueCharge(t, 'fare', s.balance); return true; }
      return false;
    }
    // A new card for a trip (its return, and the rest of a repeating series that
    // has no card yet). A failed charge is retried on it.
    function attachCard(t, card) {
      const both = [t, ...db.trips.filter((x) => x.id !== t.id && (x.id === t.returnId || x.id === t.returnOf || (t.series && x.series && x.series.id === t.series.id && !x.card && !['completed', 'cancelled'].includes(x.status))))];
      for (const x of both) {
        if (!onFile(x) || x.status === 'completed' && x.payment.status === 'paid') continue;
        x.card = clone(card);
        for (const ch of x.payment.charges || []) if (ch.status === 'failed') ch.retired = true;
        log(x, 'card_saved', card.by || 'Customer', `Card ending ${card.last4} saved`);
        payStep(x);
      }
    }
    function saveCustomerCard(u, card) {
      u.card = clone(card);
      for (const x of db.trips) if (x.customerId === u.id && onFile(x) && !['completed', 'cancelled'].includes(x.status)) attachCard(x, card);
    }

    // Online bookings and quote requests need this much notice; the office can
    // still book a sooner pickup by phone.
    function checkNotice(company, pickupAt) {
      const h = dcfg(company).minNoticeHours;
      if (h && new Date(pickupAt).getTime() < now().getTime() + h * 3600e3 - 60e3) fail(`Online bookings need at least ${h} hour${h === 1 ? '' : 's'}' notice. For a sooner pickup, call ${company.name}${company.phone ? ` at ${company.phone}` : ''}.`);
    }
    function cleanBooking(company, b, { allowPast } = {}) {
      const out = {
        service: SERVICES[b.service] ? b.service : 'transfer',
        pickup: str(b.pickup, 200),
        dropoff: str(b.dropoff, 200),
        pickupAt: str(b.pickupAt, 40),
        hours: Math.min(24, Math.max(1, Math.round(num(b.hours, company.rates.minHours)))),
        passengers: Math.round(num(b.passengers, 1)),
        vehicleType: VEHICLE_TYPES.includes(b.vehicleType) ? b.vehicleType : 'Sedan',
        flight: '',
        notes: str(b.notes, 500),
        passengerName: str(b.passengerName, 80),
        passengerPhone: str(b.passengerPhone, 30),
        // Ride texts only with the passenger's OK (booking page checkbox). Left out = not asked here.
        ...('smsOk' in b ? { smsOk: b.smsOk === true || b.smsOk === 'on' || b.smsOk === 'true' } : {}),
        ...(b.useCredit === true || b.useCredit === 'true' ? { useCredit: true } : {}),
        passengerEmail: str(b.passengerEmail, 120).toLowerCase(),
        childSeats: Math.max(0, Math.min(4, Math.round(num(b.childSeats, 0)))),
        meetGreet: !!b.meetGreet && b.meetGreet !== 'false',
        stops: Math.max(0, Math.min(10, Math.round(num(b.stops, 0)))),
        accountId: null,
        poNumber: str(b.poNumber, 40),
        costCenter: str(b.costCenter, 40),
      };
      if (b.accountId) {
        const acc = findAccount(company, b.accountId);
        if (!acc || acc.active === false) fail('Choose a valid company account to bill.');
        out.accountId = acc.id;
        if (acc.requirePo && !out.poNumber) fail(`${acc.name} needs a PO number on every booking.`);
      } else { out.poNumber = ''; out.costCenter = ''; }
      if (!out.pickup) fail('Enter a pickup address.');
      if (out.service !== 'hourly' && !out.dropoff) fail('Enter a drop-off address.');
      if (out.service !== 'hourly') out.service = isAirport(out.pickup) || isAirport(out.dropoff) ? 'airport' : 'transfer';
      if (str(b.flight)) {
        const f = normFlight(b.flight);
        if (!f) fail('Enter the flight as airline code and number, for example AA 1342.');
        out.flight = f;
      }
      // Airport pickups are timed to the landing, so the flight is required.
      if (isAirport(out.pickup) && !out.flight) fail('Pickups at the airport need the flight number, for example AS 331, so we can follow the landing.');
      const when = new Date(out.pickupAt);
      if (isNaN(when)) fail('Choose a pickup date and time.');
      if (!allowPast && when.getTime() < now().getTime() - 5 * 60000) fail('Pickup time is in the past. Choose a later time.');
      out.pickupAt = when.toISOString();
      if (!(out.passengers >= 1 && out.passengers <= 60)) fail('Passengers must be between 1 and 60.');
      const fleet = db.vehicles.filter((v) => v.companyId === company.id && v.status === 'active' && v.type === out.vehicleType);
      if (!fleet.length) fail(`${company.name} has no ${out.vehicleType} available. Choose another vehicle.`);
      const cap = Math.max(...fleet.map((v) => v.capacity));
      if (out.passengers > cap) fail(`${anA(out.vehicleType)} ${out.vehicleType} seats up to ${cap}. Choose a larger vehicle.`);
      // Stops on the way, by address. Old trips only had a count; keep it
      // until someone edits the stops.
      if (b.stopList !== undefined) {
        const list = (Array.isArray(b.stopList) ? b.stopList : String(b.stopList).split('\n')).map((x) => str(x, 200)).filter(Boolean);
        if (list.length > MAX_STOPS) fail(`Up to ${MAX_STOPS} stops online. Call us for a longer route.`);
        out.stopList = out.service === 'hourly' ? [] : list;
        out.stops = out.stopList.length;
        const def = num((company.pricing.addons || {}).stopWait, 10);
        const waits = Array.isArray(b.stopWaits) ? b.stopWaits : String(b.stopWaits == null ? '' : b.stopWaits).split(/[,\s]+/).filter(Boolean);
        out.stopWaits = out.stopList.map((x, i) => {
          if (waits[i] === undefined || waits[i] === '') return def;
          const w = Math.round(num(waits[i], NaN));
          if (!(w >= 0 && w <= 240)) fail(`Stop ${i + 1}: choose a wait from 0 to 240 minutes.`);
          return w;
        });
      }
      out.bags = Math.max(0, Math.min(40, Math.round(num(b.bags, 0))));
      const bagCap = bagsCfg(company)[out.vehicleType];
      if (out.bags > bagCap) fail(`${anA(out.vehicleType)} ${out.vehicleType} takes up to ${bagCap} suitcase${bagCap === 1 ? '' : 's'}. Choose a larger vehicle.`);
      out.signName = str(b.signName, 60);
      const pr = b.prefs || {};
      out.prefs = { temp: TEMPS[pr.temp] ? pr.temp : '', music: MUSIC[pr.music] ? pr.music : '', quiet: !!pr.quiet && pr.quiet !== 'false' };
      return out;
    }

    // How long a trip keeps a car and driver busy, for overlap checks.
    function tripWindow(t) {
      const start = new Date(t.pickupAt).getTime();
      const mins = t.service === 'hourly' ? t.hours * 60 : (t.price && t.price.minutes ? t.price.minutes : estimateRoute(t.pickup, t.dropoff).minutes) + 30;
      return [start - 15 * 60000, start + mins * 60000];
    }
    const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

    function isBusy(company, b, excludeId) {
      const p = company.pricing;
      if (!p.busyPct) return false;
      const fleet = db.vehicles.filter((v) => v.companyId === company.id && v.status === 'active' && v.type === b.vehicleType).length;
      if (!fleet) return false;
      const at = new Date(b.pickupAt).getTime();
      const booked = db.trips.filter((t) => t.companyId === company.id && t.id !== excludeId && t.status !== 'cancelled' && t.vehicleType === b.vehicleType && Math.abs(new Date(t.pickupAt).getTime() - at) <= 2 * 3600e3).length;
      return booked > 0 && booked / fleet * 100 >= p.busyThreshold;
    }

    function findPromo(company, code) {
      const c = str(code, 30).toUpperCase();
      if (!c) return { promo: null };
      const p = (company.pricing.promos || []).find((x) => x.code === c);
      if (!p || !p.active) return { error: `Promo code ${c} isn't valid.` };
      if (p.expires && localParts(now().toISOString(), company.timezone).date > p.expires) return { error: `Promo code ${c} has expired.` };
      if (p.maxUses && p.uses >= p.maxUses) return { error: `Promo code ${c} has been used up.` };
      return { promo: p };
    }

    function priceCtx(company, b, customer, promoCode, excludeId) {
      const ctx = { busy: isBusy(company, b, excludeId), discountPct: discountFor(company, customer, b.accountId) };
      const bal = creditOf(customer);
      if (bal > 0 && !b.accountId && b.useCredit && b.useCredit !== 'false' && !customer.agent) ctx.creditMax = bal;
      const pr = findPromo(company, promoCode);
      if (pr.error) ctx.promoError = pr.error;
      if (pr.promo) ctx.promo = { code: pr.promo.code, type: pr.promo.type, value: pr.promo.value };
      return ctx;
    }

    // The better of the customer's own discount and the billed account's. An
    // account that saves credit instead gives no discount on the ride itself.
    function discountFor(company, customer, accountId) {
      const acc = findAccount(company, accountId);
      return Math.max(customer && customer.discountPct ? customer.discountPct : 0, acc && acc.discountPct && acc.reward !== 'credit' ? acc.discountPct : 0);
    }

    // ---- Business ride credit ---------------------------------------------------
    // A company account can save its discount as credit instead: each completed
    // business ride adds that % of the ride (before gratuity and tax) to the
    // booker's credit, and the booker spends it on their own personal rides.
    const creditOf = (u) => (u && u.credit ? u.credit.balance : 0);
    function addCredit(u, amount, entry) {
      u.credit = u.credit || { balance: 0, log: [] };
      u.credit.balance = round2(u.credit.balance + amount);
      u.credit.log = [{ at: now().toISOString(), amount: round2(amount), ...entry }, ...u.credit.log].slice(0, 200);
    }
    const creditBase = (t) => round2(t.price.subtotal);
    // Runs before every save: earns credit on newly completed business rides,
    // gives back credit from a cancelled personal ride (or a price that fell).
    function syncCredits() {
      for (const t of db.trips) {
        if (t.accountId && t.status === 'completed' && !t.creditEarned && t.customerId) {
          const acc = db.accounts.find((a) => a.id === t.accountId);
          const done = t.history.filter((h) => h.status === 'completed').pop();
          if (!acc || acc.reward !== 'credit' || !(acc.discountPct > 0) || !done || (acc.rewardSince && done.at < acc.rewardSince)) continue;
          const u = findUser(t.customerId);
          if (!u || u.role !== 'customer') continue;
          const amount = round2(creditBase(t) * acc.discountPct / 100);
          if (amount <= 0) continue;
          t.creditEarned = { amount, userId: u.id, pct: acc.discountPct, at: now().toISOString() };
          addCredit(u, amount, { kind: 'earned', tripId: t.id, ref: t.ref, note: `${acc.discountPct}% of business ride ${t.ref} (${acc.name})` });
        }
        const cu = t.creditUsed;
        if (cu && !cu.refunded) {
          const u = findUser(cu.userId);
          if (!u) continue;
          if (t.status === 'cancelled') { cu.refunded = now().toISOString(); addCredit(u, cu.amount, { kind: 'refund', tripId: t.id, ref: t.ref, note: `Ride ${t.ref} cancelled` }); }
          else if (t.price.credit < cu.amount - 0.004) {
            const back = round2(cu.amount - t.price.credit);
            cu.amount = round2(t.price.credit); t.priceCtx.creditMax = cu.amount;
            addCredit(u, back, { kind: 'refund', tripId: t.id, ref: t.ref, note: `Price of ${t.ref} went down` });
          }
        }
      }
    }
    function newTrip(company, booking, customer, source, by, promoCode, quiet) {
      const ctx = priceCtx(company, booking, customer, promoCode);
      if (ctx.promoError) fail(ctx.promoError);
      delete ctx.promoError;
      company.nextRef = (company.nextRef || 1000) + 1;
      const t = {
        id: id('trip'), ref: `${company.refPrefix}-${company.nextRef}`, companyId: company.id,
        customerId: customer ? customer.id : null, ...booking,
        scheduledPickupAt: booking.pickupAt,
        // A travel agent's client is the passenger, not the agent.
        passengerName: booking.passengerName || (customer && !customer.agent && customer.name) || '',
        passengerPhone: booking.passengerPhone || (customer && !customer.agent && customer.phone) || '',
        passengerEmail: booking.passengerEmail || (customer && !customer.agent && customer.email) || '',
        waitMin: 0, tolls: 0, milesOverride: null, priceOverride: null, adjustment: null, priceCtx: ctx,
        status: 'confirmed', driverId: null, vehicleId: null, flightInfo: null, rating: null,
        payment: { status: 'unpaid', method: booking.accountId ? 'account' : cardsOn(company) ? 'card_on_file' : null, paidAt: null },
        source, createdAt: now().toISOString(), history: [],
      };
      if (t.payment.method === 'card_on_file') { t.cardToken = randomId(6); if (customer && customer.card) t.card = clone(customer.card); }
      t.price = quote(company, t, ctx);
      if (t.price.credit > 0 && customer) {
        // The credit is taken now; repricing never takes more than this.
        ctx.creditMax = t.price.credit;
        t.creditUsed = { amount: t.price.credit, userId: customer.id, at: now().toISOString() };
        addCredit(customer, -t.price.credit, { kind: 'spent', tripId: t.id, ref: t.ref, note: `Used on ride ${t.ref}` });
      } else delete ctx.creditMax;
      if (ctx.promo) { const p = company.pricing.promos.find((x) => x.code === ctx.promo.code); if (p) p.uses = (p.uses || 0) + 1; }
      log(t, 'confirmed', by);
      db.trips.push(t);
      checkFlight(t, false);
      if (!quiet) notify(t, 'booked');
      return t;
    }

    function reprice(t) { t.price = quote(findCompany(t.companyId), t, t.priceCtx); if (t.payment && onFile(t) && (t.payment.charges || []).length) settle(t); }

    // ---- Flight monitoring ---------------------------------------------------
    // When the flight itself is due: arrivals land at the pickup time; for
    // departures, the drive plus two hours at the airport.
    const flightSched = (t, kind) => kind === 'arrival' ? t.scheduledPickupAt : new Date(new Date(t.scheduledPickupAt).getTime() + ((t.price && t.price.minutes) || 40) * 60000 + 2 * 3600e3).toISOString();
    function flightKind(t) { return isAirport(t.pickup) ? 'arrival' : isAirport(t.dropoff) ? 'departure' : 'arrival'; }

    // Refreshes one trip's flight. For arrivals running late, moves the pickup
    // when the company has automatic adjustment on. Returns what changed.
    function checkFlight(t, allowNotify) {
      if (!t.flight || ['completed', 'cancelled', 'on_board'].includes(t.status)) return null;
      const c = findCompany(t.companyId);
      const kind = flightKind(t);
      const sched = flightSched(t, kind);
      const info = flightStatus(t.flight, sched, kind, now(), airportCode(kind === 'arrival' ? t.pickup : t.dropoff));
      if (!info) return null;
      const prev = t.flightInfo;
      t.flightInfo = info;
      const out = { trip: t, info, moved: false, cancelledNow: false };
      if (kind === 'arrival' && !info.cancelled) {
        const target = info.delayMin >= (c.flight.minDelay || 0) ? info.estimated : t.scheduledPickupAt;
        info.suggestedPickup = target;
        if (c.flight.autoAdjust && target !== t.pickupAt && ['confirmed', 'assigned', 'accepted', 'en_route'].includes(t.status)) {
          t.pickupAt = target; out.moved = true;
          log(t, 'pickup_moved', 'Flight monitor', `Flight ${info.label.toLowerCase()}${info.delayMin ? `, ${info.delayMin} min late` : ''}`);
          reprice(t);
          if (allowNotify && info.delayMin) notify(t, 'flight_moved', info);
        }
      }
      if (info.status === 'cancelled' && (!prev || prev.status !== 'cancelled')) {
        out.cancelledNow = true;
        log(t, 'flight_cancelled', 'Flight monitor');
        if (allowNotify) notify(t, 'flight_cancelled');
      }
      return out;
    }

    function monitorFlights(company, force) {
      const n = now();
      if (!force && company.flight.lastRun && n.getTime() - new Date(company.flight.lastRun).getTime() < 2 * 60000) return null;
      company.flight.lastRun = n.toISOString();
      const lo = n.getTime() - 6 * 3600e3, hi = n.getTime() + 48 * 3600e3;
      const results = [];
      for (const t of db.trips) {
        if (t.companyId !== company.id || !t.flight) continue;
        const at = new Date(t.scheduledPickupAt).getTime();
        if (at < lo || at > hi) continue;
        const r = checkFlight(t, true);
        if (r) results.push(r);
      }
      return results;
    }

    // ---- Alerts --------------------------------------------------------------
    function companyAlerts(company) {
      const n = now();
      const out = [];
      const docs = (label, dateStr, who) => {
        if (!dateOk(dateStr)) return;
        const d = daysUntil(dateStr, n);
        if (d < 0) out.push({ level: 'bad', area: 'fleet', text: `${who}: ${label} expired ${-d} day${d === -1 ? '' : 's'} ago` });
        else if (d <= 30) out.push({ level: 'warn', area: 'fleet', text: `${who}: ${label} expires in ${d} day${d === 1 ? '' : 's'}` });
      };
      for (const v of db.vehicles) {
        if (v.companyId !== company.id || v.status === 'retired') continue;
        docs('registration', v.registrationExp, v.name); docs('insurance', v.insuranceExp, v.name); docs('inspection', v.inspectionExp, v.name);
        if (v.status === 'maintenance') out.push({ level: 'info', area: 'fleet', text: `${v.name} is in the shop` });
      }
      for (const u of db.users) {
        if (u.companyId !== company.id || u.role !== 'driver' || u.active === false) continue;
        const who = u.name;
        for (const [label, d] of [["driver's license", u.licenseExp], ['chauffeur permit', u.permitExp]]) {
          if (!dateOk(d)) continue;
          const left = daysUntil(d, n);
          if (left < 0) out.push({ level: 'bad', area: 'drivers', text: `${who}: ${label} expired` });
          else if (left <= 30) out.push({ level: 'warn', area: 'drivers', text: `${who}: ${label} expires in ${left} day${left === 1 ? '' : 's'}` });
        }
      }
      for (const t of db.trips) {
        if (t.companyId !== company.id || !t.flightInfo || ['completed', 'cancelled'].includes(t.status)) continue;
        const f = t.flightInfo;
        if (f.status === 'cancelled') out.push({ level: 'bad', area: 'flights', text: `${t.ref}: flight ${f.flight} cancelled`, tripId: t.id });
        else if (f.delayMin >= 15 && f.kind === 'arrival' && f.status !== 'landed') out.push({ level: 'warn', area: 'flights', text: `${t.ref}: ${f.flight} ${f.delayMin} min late${t.pickupAt === f.estimated ? ', pickup moved' : ''}`, tripId: t.id });
      }
      const cfg = dcfg(company), nowMs = n.getTime();
      for (const t of db.trips) {
        if (t.companyId !== company.id || t.farmout || !busyStatus(t.status)) continue;
        const pickMs = new Date(t.pickupAt).getTime();
        const at = fmtLocal(t.pickupAt, company);
        const d = t.driverId && findUser(t.driverId);
        if (t.status === 'confirmed' && t.needsDriver && pickMs > nowMs - 3600e3) out.push({ level: 'bad', area: 'dispatch', text: `${t.ref} at ${at} needs a driver: ${t.needsDriver.why.charAt(0).toLowerCase() + t.needsDriver.why.slice(1).replace(/\.$/, '')}`, tripId: t.id });
        else if (t.status === 'assigned' && t.offer && d) {
          const left = Math.max(0, Math.ceil((new Date(t.offer.expiresAt).getTime() - nowMs) / 60e3));
          out.push({ level: 'info', area: 'dispatch', text: `${t.ref}: waiting for ${d.name} to accept (${left} min left)`, tripId: t.id });
        }
        if (cfg.lateStartMin && d && ['assigned', 'accepted'].includes(t.status) && nowMs >= pickMs - cfg.lateStartMin * 60e3 && nowMs < pickMs + 3600e3) {
          out.push({ level: 'bad', area: 'dispatch', text: `${t.ref}: ${d.name} hasn't set off yet. Pickup ${nowMs >= pickMs ? 'was' : 'is'} at ${at}.`, tripId: t.id });
        }
      }
      const unread = unreadTexts(company);
      if (unread) out.push({ level: 'warn', area: 'inbox', text: `${unread} unread text${unread === 1 ? '' : 's'} from passengers or drivers. Open Inbox to answer.` });
      for (const inv of db.clientInvoices) {
        if (inv.companyId !== company.id || inv.status !== 'open') continue;
        const late = Math.floor((nowMs - new Date(inv.dueAt).getTime()) / 86400e3);
        const acc = db.accounts.find((x) => x.id === inv.accountId);
        if (late > 0) out.push({ level: 'warn', area: 'billing', text: `Invoice ${inv.number} for ${acc ? acc.name : 'an account'} is ${late} day${late === 1 ? '' : 's'} overdue ($${money(inv.total)})` });
      }
      const monthStart = localParts(n.toISOString(), company.timezone).date.slice(0, 8) + '01';
      for (const acc of db.accounts) {
        if (acc.companyId !== company.id) continue;
        const old = db.trips.filter((t) => t.accountId === acc.id && t.status === 'completed' && !t.invoiceId && localParts(t.pickupAt, company.timezone).date < monthStart);
        if (old.length) out.push({ level: 'warn', area: 'billing', text: `${acc.name} has ${old.length} trip${old.length === 1 ? '' : 's'} from before this month not invoiced yet` });
      }
      const waiting = db.quotes.filter((q) => q.companyId === company.id && q.status === 'new');
      if (waiting.length) out.push({ level: 'warn', area: 'quotes', text: `${waiting.length} quote request${waiting.length === 1 ? '' : 's'} waiting for a price` });
      const offers = (db.farmouts || []).filter((f) => f.toCompanyId === company.id && f.status === 'offered');
      if (offers.length) out.push({ level: 'warn', area: 'network', text: `${offers.length} trip offer${offers.length === 1 ? '' : 's'} from partner companies waiting for your answer` });
      for (const f of (db.farmouts || [])) {
        if (f.fromCompanyId !== company.id || f.status !== 'returned' || f.seenReturn) continue;
        out.push({ level: 'bad', area: 'network', text: `${f.ref}: ${f.toName} handed the trip back. Assign it or send it to another partner.`, tripId: f.tripId });
      }
      const order = { bad: 0, warn: 1, info: 2 };
      return out.sort((a, b) => order[a.level] - order[b.level]);
    }

    // ---- Assignment checks ---------------------------------------------------
    function assignWarnings(t) {
      const w = [];
      const c = findCompany(t.companyId);
      const d = t.driverId && findUser(t.driverId);
      const v = t.vehicleId && findVehicle(t.vehicleId);
      const win = tripWindow(t);
      const lp = localParts(t.pickupAt, c.timezone);
      const n = now();
      if (d) {
        if (!d.available && new Date(t.pickupAt).getTime() - n.getTime() < 12 * 3600e3) w.push(`${d.name} is marked off duty.`);
        if (dateOk(d.licenseExp) && d.licenseExp < lp.date) w.push(`${d.name}'s driver's license will have expired.`);
        if (dateOk(d.permitExp) && d.permitExp < lp.date) w.push(`${d.name}'s chauffeur permit will have expired.`);
        const clash = db.trips.find((x) => x.id !== t.id && x.driverId === d.id && !['cancelled', 'completed'].includes(x.status) && overlaps(win, tripWindow(x)));
        if (clash) w.push(`${d.name} already has ${clash.ref} at ${fmtLocal(clash.pickupAt, c)}.`);
      }
      if (v) {
        if (v.status !== 'active') w.push(`${v.name} is ${VEHICLE_STATUS[v.status].toLowerCase()}.`);
        if (v.capacity < t.passengers) w.push(`${v.name} seats ${v.capacity}, but the trip has ${t.passengers} passengers.`);
        if (v.type !== t.vehicleType) w.push(`Customer booked a ${t.vehicleType}; ${v.name} is a ${v.type}.`);
        for (const [label, dt] of [['registration', v.registrationExp], ['insurance', v.insuranceExp], ['inspection', v.inspectionExp]]) {
          if (dateOk(dt) && dt < lp.date) w.push(`${v.name}'s ${label} will have expired.`);
        }
        const clash = db.trips.find((x) => x.id !== t.id && x.vehicleId === v.id && !['cancelled', 'completed'].includes(x.status) && overlaps(win, tripWindow(x)));
        if (clash) w.push(`${v.name} is already on ${clash.ref} at ${fmtLocal(clash.pickupAt, c)}.`);
      }
      return w;
    }

    // ---- Smart dispatch ------------------------------------------------------
    // Auto-assign picks the closest free driver with a suitable car. The driver
    // has acceptMin minutes to accept; otherwise the trip moves to the next
    // driver (or back to the office). Reminders go out the evening before and
    // shortly before pickup, and the office is alerted when a driver hasn't
    // set off in time. sweepDispatch() runs these timers.
    const dcfg = (c) => ({ ...DEFAULT_DISPATCH, ...(c.dispatch || {}) });
    const acfg = (c) => ({ ...DEFAULT_AUTOFARM, ...((c.network && c.network.auto) || {}) });
    const busyStatus = (s) => !['cancelled', 'completed'].includes(s);
    // Where the driver will be when this trip starts: the drop-off of their
    // previous trip that day, the car's live position if pickup is soon, or home base.
    function driverPointFor(d, t) {
      const c = findCompany(t.companyId);
      const start = new Date(t.pickupAt).getTime();
      const day = localParts(t.pickupAt, c.timezone).date;
      const prev = db.trips
        .filter((x) => x.id !== t.id && x.driverId === d.id && x.status !== 'cancelled' && tripWindow(x)[1] <= start + 15 * 60000 && localParts(x.pickupAt, c.timezone).date === day)
        .sort((x, y) => y.pickupAt.localeCompare(x.pickupAt))[0];
      if (prev) return { point: addressPoint(c, prev.dropoff || prev.pickup), from: `after ${prev.ref}` };
      const live = db.trips.map((x) => x.driverId === d.id && liveOf(x)).find(Boolean);
      if (live && start - now().getTime() < 2 * 3600e3) return { point: live.pos, from: 'live position' };
      if (d.base) return { point: addressPoint(c, d.base), from: 'home base' };
      const h = fnv(d.id + '|' + d.name);
      return { point: offset(REGION_CENTER[regionOf(c)], 2 + (h % 90) / 10, ((h >>> 9) % 360) * Math.PI / 180), from: 'home base' };
    }
    function vehicleFor(d, t) {
      const win = tripWindow(t);
      const free = (v) => v && v.status === 'active' && v.capacity >= t.passengers && !db.trips.some((x) => x.id !== t.id && x.vehicleId === v.id && busyStatus(x.status) && overlaps(win, tripWindow(x)));
      const own = findVehicle(d.vehicleId);
      if (own && own.type === t.vehicleType && free(own)) return own;
      return db.vehicles.find((v) => v.companyId === t.companyId && v.type === t.vehicleType && free(v)) || null;
    }
    // Every active driver ranked for this trip. ok = no warnings and a free car.
    function rankDrivers(t) {
      const c = findCompany(t.companyId);
      const skip = new Set(t.passedBy || []);
      const pick = addressPoint(c, t.pickup);
      const keep = { driverId: t.driverId, vehicleId: t.vehicleId };
      const out = [];
      for (const d of db.users) {
        if (d.companyId !== c.id || d.role !== 'driver' || d.active === false) continue;
        const v = vehicleFor(d, t);
        t.driverId = d.id; t.vehicleId = v ? v.id : null;
        const warnings = assignWarnings(t);
        if (!v) warnings.push(`No free ${t.vehicleType} for ${d.name}.`);
        if (skip.has(d.id)) warnings.push(`${d.name} already passed on this trip.`);
        const where = driverPointFor(d, t);
        const miles = Math.round(milesBetween(where.point, pick) * 10) / 10;
        out.push({ driverId: d.id, name: d.name, vehicleId: v ? v.id : null, vehicle: v ? v.name : null, miles, minutes: Math.max(3, Math.round(miles * 2.4 + 2)), from: where.from, warnings, ok: !warnings.length });
      }
      Object.assign(t, keep);
      return out.sort((a, b) => (b.ok - a.ok) || a.miles - b.miles);
    }
    // Sends the trip to a driver and starts the accept timer.
    function offerTo(t, d, vehicleId, by) {
      const cfg = dcfg(findCompany(t.companyId));
      t.driverId = d.id; t.vehicleId = vehicleId; t.status = 'assigned';
      const left = new Date(t.pickupAt).getTime() - now().getTime();
      // Never let the timer run past the point where the driver needs to set off.
      const mins = Math.max(2, Math.min(cfg.acceptMin, Math.floor((left - 30 * 60e3) / 60e3)));
      t.offer = { driverId: d.id, sentAt: now().toISOString(), expiresAt: new Date(now().getTime() + mins * 60e3).toISOString() };
      t.reminders = {};
      log(t, 'assigned', by);
      notify(t, 'assigned', { minutes: mins });
    }
    // Picks the best driver; returns null when nobody fits.
    function autoAssign(t, by) {
      const best = rankDrivers(t).find((r) => r.ok);
      if (!best) return null;
      offerTo(t, findUser(best.driverId), best.vehicleId, by);
      return best;
    }
    // After a decline or a timeout: next driver, or back to the office.
    function passOn(t, d, why) {
      t.passedBy = [...new Set([...(t.passedBy || []), d.id])];
      t.driverId = null; t.vehicleId = null; t.status = 'confirmed'; t.offer = null;
      const c = findCompany(t.companyId);
      if (dcfg(c).onNoAnswer === 'next' && !t.farmout && autoAssign(t, 'Auto-dispatch')) return;
      t.needsDriver = { at: now().toISOString(), why };
    }
    function sweepDispatch(company, force) {
      const n = now();
      if (!force && company.dispatchRun && n.getTime() - new Date(company.dispatchRun).getTime() < 30000) return false;
      company.dispatchRun = n.toISOString();
      const cfg = dcfg(company);
      const nowMs = n.getTime();
      let changed = false;
      const cm = cmsg(company);
      for (const t of db.trips) {
        if (t.companyId !== company.id || t.farmIn) continue;
        if (payStep(t)) changed = true;
        // "Final approach": one text when the car is about 10 minutes out.
        // Skipped when the driver set off that close already.
        if (t.status === 'en_route' && cm.approach && t.approach !== 'sent' && t.approach !== 'skip') {
          const l = liveOf(t);
          if (l && t.approach == null) { t.approach = l.etaMin <= 12 ? 'skip' : 'wait'; changed = true; }
          else if (l && l.etaMin <= 10) { t.approach = 'sent'; notify(t, 'approach'); changed = true; }
        }
        if (t.status === 'completed' && t.reviewDueAt && !t.reviewSentAt && new Date(t.reviewDueAt).getTime() <= nowMs) {
          if (cm.review && !t.rating) for (const m of reviewMsgs(t)) toClient(t, m.channel === 'sms' ? m.body : '', m.channel === 'email' ? m.body : '', 'review');
          t.reviewSentAt = n.toISOString(); changed = true;
        }
        if (!cm.remind24 || t.clientReminded || !busyStatus(t.status)) continue;
        const pickMs = new Date(t.pickupAt).getTime();
        // Only for trips booked more than a day ahead, and not once the pickup is close.
        if (pickMs - nowMs > 24 * 3600e3 || pickMs - nowMs < 2 * 3600e3 || new Date(t.createdAt).getTime() > pickMs - 24 * 3600e3) continue;
        toClient(t, msgText(t, 'reminder_sms'), msgText(t, 'reminder_email'), 'reminder24');
        t.clientReminded = n.toISOString(); changed = true;
      }
      for (const t of db.trips) {
        if (t.companyId !== company.id || !busyStatus(t.status) || t.farmout) continue;
        const pickMs = new Date(t.pickupAt).getTime();
        if (t.status === 'assigned' && t.offer && new Date(t.offer.expiresAt).getTime() <= nowMs) {
          const d = findUser(t.driverId);
          log(t, 'no_answer', 'Auto-dispatch', d ? `${d.name} didn't accept in time` : '');
          passOn(t, d || { id: t.driverId }, `${d ? d.name : 'The driver'} didn't accept in time`);
          changed = true;
          continue;
        }
        if (t.outOfTown && t.status === 'confirmed') {
          if (!t.needsDriver) { t.needsDriver = { at: n.toISOString(), why: `Out of town in ${t.outOfTown.city}: arrange a local company`, outOfTown: true }; changed = true; }
          continue;
        }
        if (cfg.autoAssign && t.status === 'confirmed' && !t.needsDriver && pickMs > nowMs && pickMs - nowMs < cfg.horizonHours * 3600e3) {
          if (!autoAssign(t, 'Auto-dispatch')) t.needsDriver = { at: n.toISOString(), why: 'No free driver with a suitable car' };
          changed = true;
          continue;
        }
        if (!t.driverId || !['assigned', 'accepted'].includes(t.status)) continue;
        const d = findUser(t.driverId);
        if (!d) continue;
        t.reminders = t.reminders || {};
        const to = d.phone || d.email;
        const lp = localParts(t.pickupAt, company.timezone);
        const when = fmtLocal(t.pickupAt, company, true);
        if (cfg.remindEvening && !t.reminders.evening && pickMs - nowMs > 3 * 3600e3) {
          const today = localParts(n.toISOString(), company.timezone);
          const tomorrow = localParts(new Date(nowMs + 86400e3).toISOString(), company.timezone).date;
          if (lp.date === tomorrow && today.hour >= cfg.eveningHour) {
            t.reminders.evening = n.toISOString(); changed = true;
            sendTo(t, to, `Reminder: tomorrow ${when}, ${t.ref}, pickup ${t.pickup}${t.flight ? `, flight ${t.flight}` : ''}.${t.status === 'assigned' ? ' Please accept it in the driver app.' : ''}`);
          }
        }
        if (cfg.remindBeforeMin && !t.reminders.before && pickMs - nowMs <= cfg.remindBeforeMin * 60e3 && pickMs > nowMs) {
          t.reminders.before = n.toISOString(); changed = true;
          sendTo(t, to, `Coming up: ${t.ref} at ${fmtLocal(t.pickupAt, company)}, pickup ${t.pickup}. Tap "On the way" when you set off.`);
        }
      }
      if (sweepAutoFarm(company)) changed = true;
      return changed;
    }
    function sendTo(t, recipient, body) {
      db.messages.unshift({ id: id('msg'), companyId: t.companyId, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient, channel: 'sms', body, kind: 'reminder' });
      if (db.messages.length > 600) db.messages.length = 600;
    }

    // ---- Driver performance and pay -----------------------------------------
    function tripHours(t) { return t.service === 'hourly' ? Math.max(t.hours, findCompany(t.companyId).rates.minHours) : round2(((t.price.minutes || 30) + 30) / 60); }
    function driverPay(u, trips) {
      const fares = round2(trips.reduce((s, t) => s + t.price.subtotal, 0));
      const tips = round2(trips.reduce((s, t) => s + t.price.gratuity, 0));
      const reimb = round2(trips.reduce((s, t) => s + (t.tolls || 0), 0));
      const hours = round2(trips.reduce((s, t) => s + tripHours(t), 0));
      const rate = num(u.payRate, 0);
      const base = u.payType === 'hourly' ? hours * rate : u.payType === 'perTrip' ? trips.length * rate : fares * rate / 100;
      return { trips: trips.length, fares, tips, reimbursed: reimb, hours, base: round2(base), total: round2(base + tips + reimb) };
    }
    function driverStats(u, days) {
      const since = now().getTime() - (days || 30) * 86400000;
      const mine = db.trips.filter((t) => t.driverId === u.id || t.history.some((h) => h.by === u.name && h.status === 'declined'));
      let accepted = 0, declined = 0, onTime = 0, arrivals = 0;
      for (const t of db.trips) {
        for (const h of t.history) {
          if (h.by !== u.name || t.companyId !== u.companyId) continue;
          if (h.status === 'accepted') accepted++;
          if (h.status === 'declined') declined++;
          if (h.status === 'arrived' && t.driverId === u.id) { arrivals++; if (new Date(h.at).getTime() <= new Date(t.pickupAt).getTime() + 5 * 60000) onTime++; }
        }
      }
      const done = mine.filter((t) => t.driverId === u.id && t.status === 'completed' && new Date(t.pickupAt).getTime() >= since);
      const rated = db.trips.filter((t) => t.driverId === u.id && t.rating);
      return {
        completed30: done.length,
        revenue30: round2(done.reduce((s, t) => s + t.price.total, 0)),
        acceptance: accepted + declined ? Math.round(accepted / (accepted + declined) * 100) : null,
        onTime: arrivals ? Math.round(onTime / arrivals * 100) : null,
        rating: rated.length ? round2(rated.reduce((s, t) => s + t.rating.stars, 0) / rated.length) : null,
        ratings: rated.length,
        reviews: rated.filter((t) => t.rating.comment).slice(-5).reverse().map((t) => ({ ref: t.ref, stars: t.rating.stars, comment: t.rating.comment, at: t.rating.at })),
      };
    }

    // ---- Method table -------------------------------------------------------
    const M = {};
    // roles: 'public' | 'any' | array of roles. write: persist after success.
    const def = (name, roles, write, fn) => { M[name] = { roles, write, fn }; };
    const STAFF = ['admin', 'dispatcher'];
    // Access levels for dispatchers. Admins can do everything; a dispatcher can
    // do what their admin ticked (defaults below). Seeing the board, trips,
    // calendar, quotes, flights and messages is open to every office login.
    const STAFF_PERMS = {
      bookings: { label: 'Book, edit and cancel rides', on: true },
      assign: { label: 'Assign drivers and send trips to partners', on: true },
      payments: { label: 'Charge cards and mark rides paid', on: true },
      customers: { label: 'Customers, company accounts and invoices', on: true },
      drivers: { label: 'Drivers, cars and hours', on: true },
      pay: { label: 'Driver pay', on: true },
      reports: { label: 'Reports and sales totals', on: false },
    };
    const PERM_OF = {};
    for (const [perm, names] of Object.entries({
      bookings: ['dispatch.createTrip', 'dispatch.updateTrip', 'dispatch.setStatus', 'dispatch.cancelSeries', 'dispatch.noShow', 'dispatch.importTrips', 'dispatch.applyFlight', 'dispatch.sendCardLink', 'dispatch.inboxSend', 'dispatch.saveQuote', 'dispatch.sendQuote', 'dispatch.quoteAction'],
      assign: ['dispatch.assign', 'dispatch.autoAssign', 'network.offer', 'network.respond', 'network.cancelOffer', 'network.handBack'],
      payments: ['dispatch.chargeCard', 'dispatch.markPaid', 'network.settle'],
      customers: ['dispatch.saveCustomer', 'dispatch.sendCustomerLogin', 'dispatch.saveAccount', 'dispatch.accountBooker', 'dispatch.createInvoice', 'dispatch.invoiceAction', 'dispatch.invoices', 'dispatch.invoice'],
      drivers: ['dispatch.saveDriver', 'dispatch.setDriverPhoto', 'dispatch.saveVehicle', 'dispatch.setVehiclePhoto', 'dispatch.addMaintenance', 'dispatch.deleteMaintenance'],
      pay: ['dispatch.payroll', 'dispatch.markPayout'],
      reports: ['dispatch.reports'],
    })) for (const n of names) PERM_OF[n] = perm;
    function staffPerms(u) {
      const out = {};
      for (const [k, d] of Object.entries(STAFF_PERMS)) out[k] = u.role === 'admin' ? true : (u.perms && k in u.perms ? !!u.perms[k] : d.on);
      return out;
    }

    function companyBySlug(slug) {
      const c = db.companies.find((x) => x.slug === str(slug, 60).toLowerCase());
      if (!c) fail('That company was not found.', 404);
      if (c.status !== 'active') fail(`${c.name} is not taking bookings right now.`, 403);
      return c;
    }
    function ownTrip(ctx, tid) {
      const t = db.trips.find((x) => x.id === tid && x.companyId === ctx.company.id);
      if (!t) fail('Trip not found.', 404);
      return t;
    }
    function ownDriver(ctx, did) {
      const u = db.users.find((x) => x.id === did && x.companyId === ctx.company.id && x.role === 'driver');
      if (!u) fail('Driver not found.', 404);
      return u;
    }
    function ownVehicle(ctx, vid) {
      const v = db.vehicles.find((x) => x.id === vid && x.companyId === ctx.company.id);
      if (!v) fail('Vehicle not found.', 404);
      return v;
    }
    // What customers choose from: each type in the active fleet with seats,
    // suitcases and the actual models ("Lincoln Navigator or similar").
    function vehicleTypesFor(c) {
      const out = {}, names = {};
      for (const v of db.vehicles) {
        if (v.companyId !== c.id || v.status !== 'active') continue;
        out[v.type] = Math.max(out[v.type] || 0, v.capacity);
        (names[v.type] = names[v.type] || []).includes(v.name) || names[v.type].push(v.name);
      }
      const bags = bagsCfg(c);
      // The picture on the booking card: the first active car of the type with
      // a photo. Without one the page draws a picture of the type.
      const vp = db.vehiclePhotos || {}, photoOf = (t) => { const v = db.vehicles.find((x) => x.companyId === c.id && x.status === 'active' && x.type === t && vp[x.id]); return v ? vp[v.id] : ''; };
      return VEHICLE_TYPES.filter((t) => out[t]).map((t) => ({ type: t, capacity: out[t], bags: bags[t], models: names[t].slice(0, 2).join(' or ') + ' or similar', multiplier: c.rates.multipliers[t] || 1, photo: photoOf(t) }));
    }
    function quoteFor(company, raw, customer) {
      const b = { ...raw, vehicleType: VEHICLE_TYPES.includes(raw.vehicleType) ? raw.vehicleType : 'Sedan' };
      return quote(company, b, priceCtx(company, b, customer, raw.promoCode));
    }
    function flightPreview(company, raw) {
      const code = normFlight(raw.flight);
      if (!str(raw.flight)) return null;
      if (!code) return { error: 'Enter the flight as airline code and number, for example AA 1342.' };
      if (!raw.pickupAt || isNaN(new Date(raw.pickupAt))) return { error: 'Choose the pickup date and time to look up this flight.' };
      const t = { flight: code, pickup: str(raw.pickup), dropoff: str(raw.dropoff), scheduledPickupAt: new Date(raw.pickupAt).toISOString() };
      const kind = flightKind(t);
      const sched = kind === 'arrival' ? t.scheduledPickupAt : new Date(new Date(t.scheduledPickupAt).getTime() + estimateRoute(t.pickup, t.dropoff).minutes * 60000 + 2 * 3600e3).toISOString();
      return flightStatus(code, sched, kind, now(), airportCode(kind === 'arrival' ? t.pickup : t.dropoff));
    }

    // ---- Ride when you land --------------------------------------------------
    // A passenger flying out offers to book their pickup at the other end. The
    // flight gives the arrival airport and time (from the flight data service
    // when connected; otherwise a stand-in). A network partner serving that
    // city takes it at its own prices; if none does, the office arranges it.
    const LANDING_HUBS = ['DEN', 'LAX', 'SFO', 'JFK', 'ORD', 'LAS', 'PHX', 'BOS', 'DCA', 'ATL', 'DFW', 'MIA', 'SEA'];
    function flightMinutes(from, to) {
      const a = airportInfo(from), b = airportInfo(to);
      return a && b ? Math.round(milesBetween(a, b) / 8 + 30) : 180;
    }
    function landingPartner(c, code, t) {
      const ap = airportInfo(code);
      if (!ap || !ap.region || !isMember(c)) return null;
      const order = acfg(c).partners;
      return db.companies.filter((x) => x.id !== c.id && isMember(x) && regionOf(x) === ap.region && partnerFits(x, t))
        .sort((x, y) => ((order.indexOf(x.id) + 1 || 99) - (order.indexOf(y.id) + 1 || 99)) || x.name.localeCompare(y.name))[0] || null;
    }
    function landingPreview(c, raw) {
      const flight = normFlight(raw.flight);
      if (!flight || raw.service === 'hourly' || !isAirport(raw.dropoff) || isAirport(raw.pickup)) return null;
      const pickMs = new Date(raw.pickupAt).getTime();
      if (!pickMs) return null;
      const origin = airportCode(raw.dropoff);
      const departs = new Date(pickMs + estimateRoute(str(raw.pickup), str(raw.dropoff)).minutes * 60e3 + 2 * 3600e3).toISOString();
      const fs = flightStatus(flight, departs, 'departure', now(), origin) || {};
      const asked = raw.landing && airportInfo(str(raw.landing.dest, 4).toUpperCase()) ? str(raw.landing.dest, 4).toUpperCase() : '';
      const hubs = LANDING_HUBS.filter((k) => k !== origin && airportInfo(k).region !== (airportInfo(origin) || {}).region);
      const dest = asked || (airportInfo(fs.destination) ? fs.destination : hubs[fnv(flight) % hubs.length]);
      const ap = airportInfo(dest);
      if (!ap || dest === origin) return null;
      // Scheduled landing; the pickup is booked for that and flight tracking
      // moves it if the flight runs late, like any airport pickup.
      const arrivesAt = fs.arrives && dest === fs.destination ? new Date(fs.arrives).toISOString()
        : new Date(new Date(departs).getTime() + flightMinutes(origin, dest) * 60e3).toISOString();
      const est = (flightStatus(flight, arrivesAt, 'arrival', now(), dest) || {}).estimated || arrivesAt;
      const home = ap.region && ap.region === regionOf(c);
      const t = { vehicleType: VEHICLE_TYPES.includes(raw.vehicleType) ? raw.vehicleType : 'Sedan', passengers: Math.max(1, Math.round(num(raw.passengers, 1))) };
      const partner = home ? null : landingPartner(c, dest, t);
      const by = home ? c : partner || c;
      const q = quote(by, { service: 'transfer', pickup: `${ap.name}, ${ap.address}`, dropoff: str(raw.landing && raw.landing.dropoff, 200), vehicleType: t.vehicleType, passengers: t.passengers }, {});
      return {
        flight, origin, dest: { code: dest, name: ap.name, city: ap.city }, arrivesAt, estimated: est, localTime: fmtLocal(est, { timezone: ap.tz }, true),
        home, partner: partner ? { id: partner.id, name: partner.name } : null, price: q.total, estimate: !home && !partner,
        fromFlightData: !!(fs.arrives && dest === fs.destination),
        airports: Object.keys(AIRPORTS).filter((k) => k !== origin).map((k) => ({ code: k, name: AIRPORTS[k][0], city: AIRPORTS[k][2] })),
      };
    }
    // Books the landing pickup as its own trip, linked to the outbound one.
    function landingTrip(c, t, raw, customer, source, by) {
      const lp = landingPreview(c, { ...t, pickupAt: t.scheduledPickupAt, landing: raw.landing });
      if (!lp) fail('The ride when you land needs a flight from the airport you are going to.');
      const drop = str(raw.landing.dropoff, 200);
      if (!drop) fail(`Enter where to take you in ${lp.dest.city}.`);
      const ap = airportInfo(lp.dest.code);
      const lb = cleanBooking(c, {
        service: 'transfer', pickup: `${ap.name}, ${ap.address}`, dropoff: drop, pickupAt: lp.arrivesAt, flight: t.flight, vehicleType: t.vehicleType, passengers: t.passengers,
        passengerName: t.passengerName, passengerPhone: t.passengerPhone, passengerEmail: t.passengerEmail, meetGreet: !!raw.landing.meetGreet, signName: t.signName,
        accountId: t.accountId, poNumber: t.poNumber, costCenter: t.costCenter, prefs: t.prefs, notes: `Pickup when they land in ${ap.city} after ${t.ref}.`, ...('smsOk' in t ? { smsOk: t.smsOk } : {}),
      }, { allowPast: true });
      const lt = newTrip(c, lb, customer, source, by, '', true);
      t.landingId = lt.id; lt.landingOf = t.id;
      lt.outOfTown = lp.home ? null : { code: ap.code, city: ap.city, tz: ap.tz, partnerId: lp.partner ? lp.partner.id : null, partnerName: lp.partner ? lp.partner.name : '' };
      log(lt, 'confirmed', 'System', `Pickup when they land, after ${t.ref}`);
      if (lp.partner) {
        const p = findCompany(lp.partner.id);
        lt.priceOverride = lp.price; reprice(lt);
        makeOffer(c, lt, p, round2(lt.price.total * acfg(c).ratePct / 100), `Passenger booked this with their flight ${t.flight} from ${t.ref}. Priced at your rates.`, 'System', true);
      } else if (!lp.home) {
        lt.needsDriver = { at: now().toISOString(), why: `Out of town in ${ap.city}: arrange a local company`, outOfTown: true };
      }
      return lt;
    }

    // Public (no login)
    def('public.info', 'public', false, () => ({ sample: !!db.sample, live: clone(live), payMode, pushKey: opts.pushKey || '', nativePush: opts.nativePush || null, mapsKey: opts.mapsKey || '' }));
    def('public.companies', 'public', false, () =>
      db.companies.filter((c) => c.status === 'active').map(pubCompany));
    def('public.company', 'public', false, (ctx, a) => {
      const c = companyBySlug(a.slug);
      return { company: pubCompany(c), rates: clone(c.rates), addons: clone(c.pricing.addons), vehicleTypes: vehicleTypesFor(c), services: SERVICES, minNoticeHours: dcfg(c).minNoticeHours, policy: pcfg(c), terms: c.terms || '' };
    });
    def('public.quote', 'public', false, (ctx, a) => {
      const c = companyBySlug(a.slug);
      const b = a.booking || {};
      return { ...quoteFor(c, b, null), flight: flightPreview(c, b), landing: landingPreview(c, b) };
    });

    // Address suggestions. Public so the booking page can use it; a signed-in
    // customer also sees their own past addresses, staff see the company's.
    def('places.suggest', 'public', false, async (ctx, a) => {
      let c = a.slug ? db.companies.find((x) => x.slug === a.slug) : null;
      const s = ctx.token && db.sessions[ctx.token];
      const u0 = s && findUser(s.userId);
      const u = u0 && u0.active !== false ? u0 : null;
      if (u && u.companyId && (!c || c.id === u.companyId)) c = findCompany(u.companyId);
      const recent = [];
      if (u && c && u.companyId === c.id && ['customer', 'admin', 'dispatcher'].includes(u.role)) {
        const mine = db.trips.filter((t) => t.companyId === c.id && (u.role === 'customer' ? t.customerId === u.id : true))
          .sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
        const seen = new Set();
        for (const t of mine) for (const addr of [t.pickup, t.dropoff]) {
          const k = str(addr).toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); recent.push(str(addr));
        }
      }
      const own = suggestPlaces(c, str(a.q, 120), recent.slice(0, u && u.role === 'customer' ? 6 : 4));
      // With Google Places on, real addresses follow the caller's own recent ones.
      if (!providers.places || str(a.q, 120).length < 3) return own;
      const live = await providers.places(str(a.q, 120), REGION_CENTER[regionOf(c)]);
      if (!live) return own;
      const seen = new Set();
      return own.filter((p) => p.kind === 'recent').concat(live).filter((p) => { const k = fold(p.address); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
    });

    // Passenger tracking page, opened from the "on the way" text. No login.
    def('public.track', 'public', false, (ctx, a) => {
      const tok = str(a.token, 40);
      const t = tok && db.trips.find((x) => x.trackToken === tok);
      if (!t) fail('This tracking link is not valid.', 404);
      const c = findCompany(t.companyId);
      const v = tripView(t);
      return {
        company: pubCompany(c), ref: t.ref, status: t.status, statusLabel: t.noShow ? 'No-show' : STATUS_LABELS[t.status], pickup: t.pickup, dropoff: t.dropoff, pickupAt: t.pickupAt,
        passengerName: (t.passengerName || '').split(' ')[0], driver: v.driver ? { name: v.driver.name.split(' ')[0], photo: driverPhoto(t), partner: v.driver.partner || '' } : null,
        vehicle: v.vehicle ? { name: v.vehicle.name, type: v.vehicle.type, plate: v.vehicle.plate, color: v.vehicle.color || '', year: v.vehicle.year || null } : null, live: v.live,
      };
    });

    // Review page, opened from the thank-you text. No login.
    function reviewTrip(a) {
      const tok = str(a.token, 40);
      const t = tok && db.trips.find((x) => x.reviewToken === tok);
      if (!t) fail('This review link is not valid.', 404);
      return t;
    }
    def('public.review', 'public', false, (ctx, a) => {
      const t = reviewTrip(a);
      const v = tripView(t);
      return { company: pubCompany(findCompany(t.companyId)), ref: t.ref, pickupAt: t.pickupAt, pickup: t.pickup, dropoff: t.dropoff, status: t.status,
        passengerName: (t.passengerName || '').split(' ')[0], driver: v.driver ? { name: v.driver.name.split(' ')[0] } : null, rating: t.rating ? clone(t.rating) : null };
    });
    def('public.rate', 'public', true, (ctx, a) => {
      const t = reviewTrip(a);
      if (t.status !== 'completed') fail('You can rate this trip once it is completed.');
      if (t.rating) fail('Thanks, this trip already has a rating.');
      const stars = Math.round(num(a.stars, 0));
      if (!(stars >= 1 && stars <= 5)) fail('Choose 1 to 5 stars.');
      t.rating = { stars, comment: str(a.comment, 400), at: now().toISOString(), via: 'link' };
      return { ok: true, stars };
    });

    // Phone notifications: what's new for the signed-in person. The app polls
    // this and shows anything it hasn't shown before (keys are stable per event).
    function feedFor(u) {
      const c = u.companyId ? findCompany(u.companyId) : null, out = [];
      if (!c) return out;
      const n = now().getTime(), recent = (iso, h) => iso && n - new Date(iso).getTime() < (h || 6) * 3600e3;
      const lastOf = (t, st) => t.history.filter((h) => h.status === st).pop();
      const at = (t) => fmtLocal(t.pickupAt, c, true);
      const add = (key, title, body, hash, when) => out.push({ key, title, body, hash, at: when || now().toISOString() });
      if (u.role === 'driver') {
        for (const t of db.trips) {
          if (t.driverId !== u.id) continue;
          if (t.status === 'assigned' && t.offer) add(`offer:${t.id}:${t.offer.sentAt}`, `New trip ${t.ref}`, `${at(t)} from ${t.pickup}. Accept within ${Math.max(0, Math.ceil((new Date(t.offer.expiresAt).getTime() - n) / 60e3))} min.`, '#driver', t.offer.sentAt);
          else if (t.status === 'assigned' && recent(lastOf(t, 'assigned') && lastOf(t, 'assigned').at)) add(`assigned:${t.id}`, `New trip ${t.ref}`, `${at(t)} from ${t.pickup}. Open the app to accept.`, '#driver');
          const mv = lastOf(t, 'pickup_moved');
          if (mv && recent(mv.at) && busyStatus(t.status)) add(`moved:${t.id}:${t.pickupAt}`, `Pickup moved for ${t.ref}`, `New pickup time ${at(t)}. ${mv.note || ''}`.trim(), '#driver', mv.at);
          const cx = lastOf(t, 'cancelled');
          if (t.status === 'cancelled' && cx && recent(cx.at)) add(`cancel:${t.id}`, `${t.ref} was cancelled`, `${at(t)} from ${t.pickup}.`, '#driver', cx.at);
        }
      } else if (u.role === 'customer') {
        for (const t of db.trips) {
          if (t.customerId !== u.id) continue;
          const v = tripView(t), d = v.driver ? v.driver.name.split(' ')[0] : 'Your chauffeur';
          const h = (st) => lastOf(t, st);
          if (h('accepted') && recent(h('accepted').at, 24) && busyStatus(t.status)) add(`accepted:${t.id}:${t.driverId}`, `Chauffeur confirmed for ${t.ref}`, `${v.driver ? v.driver.name : 'Your chauffeur'}${v.vehicle ? `, ${v.vehicle.name} (${v.vehicle.plate || ''})` : ''}. Pickup ${at(t)}.`, '#customer', h('accepted').at);
          if (t.status === 'en_route') add(`enroute:${t.id}`, `${d} is on the way`, v.live ? `About ${v.live.etaMin} min away. Tap to follow the car.` : 'Tap to follow the car.', t.trackToken ? `#track.${t.trackToken}` : '#customer', h('en_route') && h('en_route').at);
          if (t.status === 'arrived') add(`arrived:${t.id}`, `${d} has arrived`, `Waiting at ${t.pickup}.`, '#customer', h('arrived') && h('arrived').at);
          const mv = h('pickup_moved');
          if (mv && recent(mv.at) && busyStatus(t.status)) add(`moved:${t.id}:${t.pickupAt}`, `Pickup moved for ${t.ref}`, `Your flight changed, so pickup is now ${at(t)}.`, '#customer', mv.at);
          const pv = onFile(t) && payView(t);
          if (pv && pv.failed) add(`cardfail:${t.id}:${pv.failed.at}`, `Card declined for ${t.ref}`, `$${money(pv.failed.amount)} didn't go through. Tap to add another card.`, `#card.${t.cardToken}`, pv.failed.at);
          if (t.noShow && recent(t.noShow.at, 24)) add(`noshow:${t.id}`, `${t.ref} closed as a no-show`, `Your chauffeur waited at ${t.pickup}.${t.noShow.fee ? ` A $${money(t.noShow.fee)} fee applies.` : ''}`, '#customer', t.noShow.at);
          if (t.status === 'completed' && !t.rating && t.reviewToken && recent(h('completed') && h('completed').at)) add(`review:${t.id}`, 'How was your ride?', `Rate your trip with ${d}.`, `#review.${t.reviewToken}`, h('completed').at);
        }
        for (const q of db.quotes) {
          if (q.customerId === u.id && q.status === 'sent' && recent(q.sentAt, 48)) add(`qsent:${q.id}:${q.sentAt}`, `Your quote ${q.number} is ready`, `$${money(quoteTotals(q).total)}. Tap to review and book.`, `#quote.${q.token}`, q.sentAt);
        }
      } else if (STAFF.includes(u.role)) {
        for (const t of db.trips) {
          if (t.companyId !== c.id) continue;
          if (t.source === 'online' && !t.farmIn && !t.landingOf && recent(t.createdAt, 3) && t.status !== 'cancelled') add(`booked:${t.id}`, `New booking ${t.ref}`, `${t.passengerName || 'Passenger'}, ${at(t)}, ${t.vehicleType}. $${money(t.price.total)}.${(() => { const l = t.landingId && db.trips.find((x) => x.id === t.landingId); return l ? ` Plus a pickup when they land${l.outOfTown ? ` in ${l.outOfTown.city}` : ''} (${l.ref}${l.farmout ? `, sent to ${l.farmout.toName}` : l.outOfTown ? ', needs a local company' : ''}).` : ''; })()}`, '#dispatch', t.createdAt);
          if (t.status === 'confirmed' && t.needsDriver && !t.farmout && recent(t.needsDriver.at)) add(`need:${t.id}:${t.needsDriver.at}`, `${t.ref} needs a driver`, `${t.needsDriver.why}. Pickup ${at(t)}.`, '#dispatch', t.needsDriver.at);
          const cx = lastOf(t, 'cancelled');
          if (t.noShow && recent(t.noShow.at, 3) && t.noShow.by !== u.name) add(`noshow:${t.id}`, `No-show on ${t.ref}`, `${t.passengerName || 'Passenger'}. ${t.noShow.waitedMin ? `Driver waited ${t.noShow.waitedMin} min.` : ''}${t.noShow.fee ? ` Fee $${money(t.noShow.fee)}.` : ''}`.trim(), '#dispatch', t.noShow.at);
          const pv = onFile(t) && payView(t);
          if (pv && pv.failed) add(`cardfail:${t.id}:${pv.failed.at}`, `Card declined on ${t.ref}`, `${t.passengerName || 'Passenger'}: $${money(pv.failed.amount)} didn't go through. We texted them a link to add a card.`, '#dispatch', pv.failed.at);
          else if (pv && pv.needsCard && !['completed', 'cancelled'].includes(t.status) && n >= new Date(pv.chargeAt).getTime()) add(`nocard:${t.id}`, `No card on file for ${t.ref}`, `${t.passengerName || 'Passenger'}, pickup ${at(t)}. Text them the card link or collect another way.`, '#dispatch', pv.chargeAt);
          if (t.status === 'cancelled' && cx && recent(cx.at, 3) && cx.by !== u.name) add(`cancel:${t.id}`, `${t.ref} was cancelled`, `By ${cx.by || 'the customer'}. Pickup was ${at(t)}.`, '#dispatch', cx.at);
        }
        for (const f of db.farmouts || []) {
          if (f.toCompanyId === c.id && f.status === 'offered') add(`farm:${f.id}`, `Trip offer from ${f.fromName}`, `${f.ref}: $${money(f.rate)}. Open Network to accept or decline.`, '#dispatch', f.createdAt);
          if (f.fromCompanyId === c.id && f.status === 'returned' && !f.seenReturn) add(`ret:${f.id}`, `${f.toName} handed back ${f.ref}`, 'Assign it or send it to another partner.', '#dispatch');
        }
        for (const q of db.quotes) {
          if (q.companyId !== c.id) continue;
          if (q.status === 'new' && q.source === 'online' && recent(q.createdAt, 24)) add(`quote:${q.id}`, `Quote request ${q.number}`, `${q.contact.name}: ${[q.eventType, q.eventName].filter(Boolean).join(', ')}. Open Quotes to price it.`, '#dispatch', q.createdAt);
          if (q.status === 'accepted' && recent(q.decidedAt, 24)) add(`qacc:${q.id}`, `Quote ${q.number} accepted`, `${q.contact.name} booked ${q.tripIds.length} vehicle${q.tripIds.length === 1 ? '' : 's'}.`, '#dispatch', q.decidedAt);
          if (q.status === 'declined' && recent(q.decidedAt, 24)) add(`qdec:${q.id}`, `Quote ${q.number} declined`, q.declineReason || q.contact.name, '#dispatch', q.decidedAt);
        }
        for (const x of db.inbox || []) {
          if (x.companyId !== c.id || x.dir !== 'in' || x.read || x.key === 'deleted' || !recent(x.at, 24)) continue;
          const p = personForPhone(c.id, x.key);
          add(`sms:${x.id}`, `Text from ${p.name || x.phone}${x.ref ? ` (${x.ref})` : ''}`, String(x.body).slice(0, 140), '#dispatch', x.at);
        }
        const ts = u.role === 'admin' ? textStatus(c) : {};
        if (ts.out) add(`textsout:${ts.month}:${ts.packs.length}`, 'Out of texts this month', 'Passenger messages go by email until you buy more. Open Texts & emails.', '#dispatch');
        else if (ts.low) add(`textslow:${ts.month}:${ts.packs.length}`, 'Running low on texts', `${ts.left} left this month. Buy more in Texts & emails.`, '#dispatch');
      }
      return out.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 20);
    }
    def('notify.feed', 'any', false, (ctx) => feedFor(ctx.user));

    // Web Push: the phone gets notifications even when the app is closed.
    // What's already in the feed when someone subscribes counts as seen.
    // The store apps send an Apple or Google token instead ("apns:…" / "fcm:…").
    def('push.subscribe', 'any', true, (ctx, a) => {
      if (a.native) {
        const endpoint = str(a.native, 500);
        const kind = /^apns:/.test(endpoint) ? 'ios' : /^fcm:/.test(endpoint) ? 'android' : '';
        if (!kind || !/^(apns|fcm):[\w:.\-]{20,}$/.test(endpoint) || !(opts.nativePush && opts.nativePush[kind])) fail('Phone notifications are not set up for this app yet.');
        db.pushSubs = (db.pushSubs || []).filter((x) => x.endpoint !== endpoint);
        db.pushSubs.push({ userId: ctx.user.id, endpoint, at: now().toISOString() });
      } else {
        if (!opts.pushKey) fail('Phone notifications are not set up on this site.');
        const s = a.subscription || {}, endpoint = str(s.endpoint, 1000), keys = s.keys || {};
        if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) fail('That browser did not give a usable subscription.');
        db.pushSubs = (db.pushSubs || []).filter((x) => x.endpoint !== endpoint);
        db.pushSubs.push({ userId: ctx.user.id, endpoint, keys: { p256dh: str(keys.p256dh, 200), auth: str(keys.auth, 100) }, at: now().toISOString() });
      }
      const u = ctx.user, seen = new Set(u.pushSeen || []);
      for (const n of feedFor(u)) seen.add(n.key);
      u.pushSeen = [...seen].slice(-80);
      return { ok: true };
    });
    def('push.unsubscribe', 'any', true, (ctx, a) => {
      const endpoint = str(a.endpoint, 1000);
      db.pushSubs = (db.pushSubs || []).filter((x) => !(x.userId === ctx.user.id && (!endpoint || x.endpoint === endpoint)));
      return { ok: true };
    });

    // Sign in
    def('auth.login', 'public', true, async (ctx, a) => {
      const email = str(a.email, 120).toLowerCase();
      const pw = String(a.password || '');
      const slug = str(a.slug, 60).toLowerCase();
      let candidates = db.users.filter((u) => u.email === email && u.active !== false);
      if (slug) {
        const c = db.companies.find((x) => x.slug === slug);
        const scoped = candidates.filter((u) => u.role === 'owner' || (c && u.companyId === c.id));
        if (scoped.length) candidates = scoped;
      }
      let user = null;
      for (const u of candidates) {
        if (u.passHash && (await hashPw(pw, u.salt)) === u.passHash) { user = u; break; }
      }
      if (!user) fail('Email or password is incorrect.', 401);
      if (user.companyId) {
        const c = findCompany(user.companyId);
        if (c.status !== 'active') fail(closedMsg(c), 403);
      }
      const token = randomId(24);
      db.sessions[token] = { userId: user.id, at: now().toISOString() };
      return { token, user: pubUser(user), company: pubCompany(findCompany(user.companyId)) };
    });
    def('auth.signup', 'public', true, async (ctx, a) => {
      const c = companyBySlug(a.slug);
      const email = str(a.email, 120).toLowerCase();
      const name = str(a.name, 80);
      if (!name) fail('Enter your name.');
      if (!emailOk(email)) fail('Enter a valid email address.');
      if (String(a.password || '').length < 8) fail('Use a password of at least 8 characters.');
      const existing = db.users.find((u) => u.email === email && u.companyId === c.id);
      if (existing && existing.passHash) fail('That email already has an account here. Sign in instead.');
      const u = existing || { id: id('usr'), role: 'customer', companyId: c.id, email, createdAt: now().toISOString() };
      u.name = name; u.phone = str(a.phone, 30); u.active = true;
      if (a.agent) {
        const agency = str(a.agency, 80);
        if (!agency) fail('Enter your agency or company name.');
        u.agent = { agency, since: now().toISOString() };
      }
      await setPassword(u, a.password);
      if (!existing) db.users.push(u);
      const token = randomId(24);
      db.sessions[token] = { userId: u.id, at: now().toISOString() };
      return { token, user: pubUser(u), company: pubCompany(c) };
    });
    def('auth.me', 'any', false, (ctx) => ({ user: pubUser(ctx.user), company: pubCompany(ctx.company) }));
    def('auth.logout', 'any', true, (ctx, a) => {
      delete db.sessions[ctx.token];
      // This device stops getting the person's notifications once they sign out.
      const endpoint = str(a.pushEndpoint, 1000);
      if (endpoint && db.pushSubs) db.pushSubs = db.pushSubs.filter((x) => x.endpoint !== endpoint);
      return true;
    });

    // Delete my account (both app stores require it). Trip and payment records
    // stay for the company's books, with the person's name and contact removed.
    // The platform owner and company admins can move their own login to a new email.
    def('auth.changeEmail', ['owner', 'admin'], true, async (ctx, a) => {
      const u = ctx.user;
      const email = str(a.email, 120).toLowerCase();
      if (!emailOk(email)) fail('Enter a valid email address.');
      if (!u.passHash || (await hashPw(String(a.password || ''), u.salt)) !== u.passHash) fail('That password is not right.', 401);
      if (email === u.email) fail('That is already your sign-in email.');
      if (db.users.some((x) => x.id !== u.id && x.email === email && x.active !== false)) fail('Another login already uses that email.');
      u.email = email;
      return { user: pubUser(u) };
    });
    def('auth.deleteAccount', 'any', true, async (ctx, a) => {
      const u = ctx.user;
      if (!u.passHash || (await hashPw(String(a.password || ''), u.salt)) !== u.passHash) fail('That password is not right.', 401);
      if (u.role === 'owner') fail('The platform owner account cannot be deleted here.');
      if (u.role === 'admin' && !db.users.some((x) => x.id !== u.id && x.companyId === u.companyId && x.role === 'admin' && x.active !== false))
        fail(`You are the only admin for ${ctx.company.name}. Add another admin first, or contact support to close the company.`);
      const open = db.trips.filter((t) => (u.role === 'customer' ? t.customerId === u.id : t.driverId === u.id) && ['confirmed', 'assigned', 'accepted', 'en_route', 'arrived', 'on_board'].includes(t.status));
      if (open.length) fail(u.role === 'customer' ? `You have ${open.length} upcoming ride${open.length === 1 ? '' : 's'} (${open.map((t) => t.ref).join(', ')}). Cancel ${open.length === 1 ? 'it' : 'them'} first, then delete your account.` : `You have ${open.length} upcoming trip${open.length === 1 ? '' : 's'}. Ask the office to reassign ${open.length === 1 ? 'it' : 'them'} first.`);
      const label = u.role === 'customer' ? 'Deleted customer' : u.role === 'driver' ? 'Deleted chauffeur' : 'Deleted user';
      const contacts = [u.email, u.phone].filter(Boolean);
      for (const t of db.trips) {
        if (u.role === 'customer' && t.customerId === u.id) {
          t.customerId = null;
          if (t.passengerEmail === u.email || t.passengerName === u.name) { t.passengerName = label; t.passengerPhone = ''; t.passengerEmail = ''; t.signName = ''; }
          if (t.rating) t.rating.by = label;
        }
        if (t.affiliate && t.affiliate.driver && t.driverId === u.id) t.affiliate.driver = { name: label, phone: '' };
      }
      for (const m of db.messages) if (contacts.includes(m.recipient)) { m.recipient = label; m.body = '[Removed when the account was deleted]'; }
      const gone = u.phone && phoneKey(u.phone);
      if (gone) for (const x of db.inbox || []) if (x.key === gone) { x.key = 'deleted'; x.phone = ''; x.body = '[Removed when the account was deleted]'; }
      for (const q of db.quotes || []) if (q.customerId === u.id || (q.contact && q.contact.email && q.contact.email === u.email)) { q.customerId = null; q.contact = { ...q.contact, name: label, phone: '', email: '' }; }
      for (const [tok, x] of Object.entries(db.sessions)) if (x.userId === u.id) delete db.sessions[tok];
      db.pushSubs = (db.pushSubs || []).filter((x) => x.userId !== u.id);
      if (u.role === 'customer') db.users = db.users.filter((x) => x.id !== u.id);
      else {
        // Staff and chauffeurs stay as a blank, switched-off record so past trips
        // and pay history still add up.
        Object.assign(u, { name: label, email: `deleted-${u.id}@deleted.invalid`, phone: '', photo: '', active: false, available: false, passHash: '', salt: '', licenseNumber: '', notes: '', card: null, prefs: null, deletedAt: now().toISOString() });
      }
      return { deleted: true };
    });

    // Customer
    def('customer.accounts', ['customer'], false, (ctx) => {
      const acc = findAccount(ctx.company, ctx.user.accountId);
      return acc && acc.active !== false ? [{ id: acc.id, name: acc.name, requirePo: !!acc.requirePo, reward: acc.reward === 'credit' ? 'credit' : 'discount', pct: acc.discountPct || 0 }] : [];
    });
    // The booker's credit from business rides, and what earned or used it.
    def('customer.credit', ['customer'], false, (ctx) => {
      const acc = findAccount(ctx.company, ctx.user.accountId);
      const c = ctx.user.credit || { balance: 0, log: [] };
      return { balance: c.balance, log: c.log.slice(0, 50).map(clone), account: acc && acc.active !== false && acc.reward === 'credit' ? { name: acc.name, pct: acc.discountPct || 0 } : null };
    });
    def('customer.quote', ['customer'], false, (ctx, a) => { const b = a.booking || {}; return { ...quoteFor(ctx.company, b, ctx.user), flight: flightPreview(ctx.company, b), landing: landingPreview(ctx.company, b) }; });
    def('customer.book', ['customer'], true, (ctx, a) => {
      const agent = ctx.user.agent;
      const payByPassenger = !!(agent && (a.booking || {}).payBy === 'passenger');
      if (agent) {
        const x = a.booking || {};
        if (!str(x.passengerName)) fail("Enter your client's name.");
        if (!str(x.passengerPhone) && !str(x.passengerEmail)) fail("Enter your client's mobile or email so the chauffeur can reach them.");
        if (payByPassenger && !cardsOn(ctx.company)) fail(`${ctx.company.name} doesn't take cards online. Choose another way to pay.`);
      }
      const [b, rb] = bookingPair(ctx.company, a.booking || {});
      checkNotice(ctx.company, b.pickupAt);
      const plan = repeatPlan(ctx.company, b, a.booking || {});
      const agreed = agreeTerms(ctx.company, a.booking || {}, ctx.user.name);
      if (agreed) { b.termsAgreed = agreed; if (rb) rb.termsAgreed = agreed; }
      if (b.accountId && b.accountId !== ctx.user.accountId) fail("You can't bill that company account.");
      // Card on file: typed here in the demo; with Stripe it's saved on Stripe's page right after booking.
      const cardIn = a.card || (a.booking || {}).card;
      const card = cardIn && !payByPassenger && payMode === 'demo' && !b.accountId && cardsOn(ctx.company) ? demoCard(cardIn, ctx.user.name) : null;
      if (!card && !payByPassenger && !ctx.user.card && !b.accountId && cardsOn(ctx.company) && payMode === 'demo') fail(`Add a card. ${chargeNote(ctx.company)}.`);
      if (card) ctx.user.card = card;
      const wantsLanding = !!((a.booking || {}).landing && a.booking.landing.on);
      const t = newTrip(ctx.company, b, ctx.user, 'online', ctx.user.name, (a.booking || {}).promoCode, wantsLanding);
      let r = null;
      if (rb) { r = newTrip(ctx.company, rb, ctx.user, 'online', ctx.user.name, ''); linkReturn(t, r); }
      const lt = wantsLanding ? landingTrip(ctx.company, t, a.booking, ctx.user, 'online', ctx.user.name) : null;
      if (lt) notify(t, 'booked');
      const reps = bookRepeats(ctx.company, a.booking || {}, plan, t, r, ctx.user, 'online', ctx.user.name);
      if (agent) agentBooked(ctx, [t, r, lt, ...reps].filter(Boolean), payByPassenger);
      payStep(t); if (r) payStep(r); if (lt) payStep(lt); reps.forEach(payStep);
      // Remember how they like to ride for next time (an agent's clients differ).
      if (!agent) ctx.user.prefs = { ...b.prefs, signName: b.signName || (ctx.user.prefs && ctx.user.prefs.signName) || '' };
      return { ...tripView(t), returnTrip: r ? tripView(r) : null, landingTrip: lt ? tripView(lt) : null, repeats: reps.filter((x) => !x.returnOf).length };
    });
    // A travel agent's booking: the ride carries who booked it and the
    // commission rate at the time. The passenger gets the usual texts; the
    // agent gets an email copy. "Passenger pays" sends the client a card link
    // instead of using the agent's card.
    function agentBooked(ctx, trips, payByPassenger) {
      const u = ctx.user, c = ctx.company;
      for (const t of trips) {
        t.agent = { id: u.id, name: u.name, agency: u.agent.agency, pct: agentPct(u), payBy: payByPassenger ? 'passenger' : 'agent' };
        if (payByPassenger && onFile(t)) {
          delete t.card;
          if (t.series && t.series.n > 1) continue; // the first ride's link covers the series
          const to = t.passengerPhone || t.passengerEmail;
          db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: to, channel: t.passengerPhone ? 'sms' : 'email',
            body: `${c.name}: ${u.name} of ${u.agent.agency} booked ride ${t.ref} for you, ${fmtLocal(t.pickupAt, c, true)}. Please add a card for it. ${chargeNote(c)}: ${cardUrl(t)}` });
          log(t, 'card_link', u.name, `Card link sent to ${to}`);
        }
      }
      const t = trips[0];
      db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: u.email, channel: 'email', kind: 'agent',
        body: `${c.name}: booked ${trips.map((x) => x.ref).join(', ')} for ${t.passengerName}, ${fmtLocal(t.pickupAt, c, true)} from ${t.pickup}${t.dropoff ? ` to ${t.dropoff}` : ''}. Total $${money(trips.reduce((s2, x) => s2 + x.price.total, 0))}${payByPassenger ? ', paid by the passenger (we sent them a card link)' : ''}.${t.agent.pct ? ` Your commission: ${t.agent.pct}% of the ride price once completed.` : ''}` });
    }
    // The agent's clients, from past bookings, for quick re-booking.
    def('customer.clients', ['customer'], false, (ctx) => {
      const seen = new Map();
      for (const t of db.trips.filter((x) => x.customerId === ctx.user.id && x.agent).sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
        const k = (t.passengerName || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.set(k, { name: t.passengerName, phone: t.passengerPhone || '', email: t.passengerEmail || '', trips: 0, last: t.pickupAt });
      }
      for (const t of db.trips) if (t.customerId === ctx.user.id && t.agent) { const x = seen.get((t.passengerName || '').toLowerCase()); if (x) x.trips++; }
      return [...seen.values()];
    });
    function commissionRows(trips) {
      const months = {};
      for (const t of trips) {
        const m = t.pickupAt.slice(0, 7);
        const x = months[m] = months[m] || { month: m, trips: 0, sales: 0, commission: 0, paid: 0, owed: 0 };
        if (t.status !== 'completed') continue;
        const cm = commissionOf(t);
        x.trips++; x.sales = round2(x.sales + ((t.price && t.price.subtotal) || 0)); x.commission = round2(x.commission + cm);
        if (t.agent.paidAt) x.paid = round2(x.paid + cm); else x.owed = round2(x.owed + cm);
      }
      return Object.values(months).sort((x, y) => y.month.localeCompare(x.month));
    }
    def('customer.commission', ['customer'], false, (ctx) => {
      if (!ctx.user.agent) fail('Only travel agent accounts earn commission.', 403);
      const trips = db.trips.filter((t) => t.customerId === ctx.user.id && t.agent);
      const rows = commissionRows(trips);
      const upcoming = trips.filter((t) => !['completed', 'cancelled'].includes(t.status));
      return { pct: agentPct(ctx.user), on: ctx.user.agent.commissionOn !== false, months: rows, owed: round2(rows.reduce((s2, r) => s2 + r.owed, 0)), paid: round2(rows.reduce((s2, r) => s2 + r.paid, 0)),
        upcoming: upcoming.length, upcomingEstimate: round2(upcoming.reduce((s2, t) => s2 + ((t.price && t.price.subtotal) || 0) * (t.agent.pct || 0) / 100, 0)) };
    });
    // Office: every travel agent, what they booked, and commission owed.
    def('dispatch.agents', STAFF, false, (ctx) => ({
      cfg: agentCfg(ctx.company),
      agents: db.users.filter((u) => u.companyId === ctx.company.id && u.role === 'customer' && u.agent).map((u) => {
        const trips = db.trips.filter((t) => t.customerId === u.id && t.agent);
        const rows = commissionRows(trips);
        return { ...pubUser(u), agency: u.agent.agency, since: u.agent.since, pct: agentPct(u), customPct: u.agent.commissionPct != null, commissionOn: u.agent.commissionOn !== false,
          trips: trips.filter((t) => t.status !== 'cancelled').length, upcoming: trips.filter((t) => !['completed', 'cancelled'].includes(t.status)).length,
          sales: round2(rows.reduce((s2, r) => s2 + r.sales, 0)), owed: round2(rows.reduce((s2, r) => s2 + r.owed, 0)), paid: round2(rows.reduce((s2, r) => s2 + r.paid, 0)),
          clients: new Set(trips.map((t) => (t.passengerName || '').toLowerCase())).size, last: trips.map((t) => t.pickupAt).sort().pop() || null };
      }).sort((x, y) => y.owed - x.owed || y.trips - x.trips),
    }));
    def('dispatch.saveAgent', ['admin'], true, (ctx, a) => {
      const u = db.users.find((x) => x.id === a.id && x.companyId === ctx.company.id && x.agent);
      if (!u) fail('Travel agent not found.', 404);
      if ('commissionPct' in a) {
        if (a.commissionPct === '' || a.commissionPct == null) delete u.agent.commissionPct;
        else { const n = num(a.commissionPct, NaN); if (!(n >= 0 && n <= 30)) fail('Commission must be between 0 and 30%.'); u.agent.commissionPct = round2(n); }
      }
      if ('commissionOn' in a) u.agent.commissionOn = !!a.commissionOn;
      if (a.agency !== undefined && str(a.agency)) u.agent.agency = str(a.agency, 80);
      return pubUser(u);
    });
    def('dispatch.saveAgentCfg', ['admin'], true, (ctx, a) => {
      const n = num(a.commissionPct, NaN);
      if (!(n >= 0 && n <= 30)) fail('Commission must be between 0 and 30%.');
      ctx.company.agents = { commissionPct: round2(n), on: a.on !== false };
      return agentCfg(ctx.company);
    });
    // Mark an agent's commission paid for every finished ride up to a month.
    def('dispatch.payCommission', ['admin'], true, (ctx, a) => {
      const u = db.users.find((x) => x.id === a.id && x.companyId === ctx.company.id && x.agent);
      if (!u) fail('Travel agent not found.', 404);
      const through = /^\d{4}-\d{2}$/.test(a.through || '') ? a.through : monthKey(now());
      let n = 0, amt = 0;
      for (const t of db.trips) if (t.customerId === u.id && t.agent && t.status === 'completed' && !t.agent.paidAt && t.pickupAt.slice(0, 7) <= through && commissionOf(t) > 0) { t.agent.paidAt = now().toISOString(); t.agent.paidBy = ctx.user.name; n++; amt += commissionOf(t); }
      if (!n) fail('No unpaid commission up to that month.');
      return { trips: n, amount: round2(amt) };
    });
    def('customer.trips', ['customer'], false, (ctx) => {
      if (monitorFlights(ctx.company)) ctx.dirty = true;
      return db.trips.filter((t) => t.customerId === ctx.user.id).sort((x, y) => y.pickupAt.localeCompare(x.pickupAt))
        .map((t) => (['assigned', 'accepted', 'en_route', 'arrived', 'on_board'].includes(t.status) ? withPhoto(tripView(t), t) : tripView(t)));
    });
    def('customer.cancel', ['customer'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.customerId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (!['confirmed', 'assigned', 'accepted'].includes(t.status)) fail('This trip is already under way. Call the office to change it.');
      const ct = cancelTerms(t);
      if (ct.fee > 0 && !a.acceptFee) fail(`Free cancellation ended ${fmtLocal(ct.freeUntil, ctx.company, true)}. Cancelling now has a $${money(ct.fee)} fee.`, 409);
      t.status = 'cancelled';
      if (ct.fee > 0) t.cancelFee = ct.fee;
      log(t, 'cancelled', ctx.user.name, ct.fee > 0 ? `Late cancellation, fee $${money(ct.fee)}` : '');
      notify(t, 'cancelled');
      payStep(t);
      return tripView(t);
    });
    // Cancel this ride and the rest of its repeating series. Late rides (inside
    // the free cancellation time) carry the usual fee once accepted.
    function cancelSeries(t, by, fees, quietName) {
      const rest = seriesRest(t);
      if (!rest.length) fail('There are no upcoming rides left in this series.');
      for (const x of rest) {
        const ct = cancelTerms(x);
        if (fees && ct.fee > 0) x.cancelFee = ct.fee;
        x.status = 'cancelled'; x.offer = null; x.needsDriver = null;
        log(x, 'cancelled', by, `Repeating ride cancelled from ${t.ref} on${x.cancelFee ? `. Late cancellation, fee $${money(x.cancelFee)}` : ''}`);
        payStep(x);
      }
      const c = findCompany(t.companyId), to = t.passengerPhone || t.passengerEmail, n = rest.filter((x) => !x.returnOf).length;
      if (to) db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: to, channel: t.passengerPhone ? 'sms' : 'email', kind: 'series',
        body: `${c.name}: your repeating ride is cancelled from ${fmtLocal(t.pickupAt, c, true)} on (${n} ride${n === 1 ? '' : 's'}).` });
      return rest;
    }
    def('customer.cancelSeries', ['customer'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.customerId === ctx.user.id);
      if (!t || !t.series) fail('Trip not found.', 404);
      const fee = seriesRest(t).reduce((n, x) => n + cancelTerms(x).fee, 0);
      if (fee > 0 && !a.acceptFee) fail(`Some of these rides are inside the free cancellation time. Cancelling them has $${money(fee)} in fees.`, 409);
      return cancelSeries(t, ctx.user.name, true).map(tripView).length;
    });
    def('dispatch.cancelSeries', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      if (!t.series) fail('This ride does not repeat.');
      return cancelSeries(t, ctx.user.name, !!a.keepFee).length;
    });
    // Demo payment. In production this becomes a Stripe Checkout session on
    // the company's connected account; the webhook then marks the trip paid.
    def('customer.pay', ['customer'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.customerId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (t.status === 'cancelled') fail('This trip was cancelled.');
      if (t.payment.status === 'paid') fail('This trip is already paid.');
      if (t.accountId) fail('This trip is billed to your company account.');
      if (onFile(t)) fail('This trip goes on your saved card automatically.');
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Card payments open a secure Stripe page. Reload and tap Pay again.' : `Online card payment isn't set up yet. Call ${ctx.company.name} to pay.`);
      t.payment = { status: 'paid', method: 'card', paidAt: now().toISOString(), last4: str(a.last4, 4) || '4242' };
      return tripView(t);
    });
    def('customer.saveCard', ['customer'], true, (ctx, a) => {
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Cards are saved on a secure Stripe page. Reload and try again.' : "Card payments aren't set up yet.");
      saveCustomerCard(ctx.user, demoCard(a, ctx.user.name));
      return pubUser(ctx.user);
    });
    def('customer.rate', ['customer'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.customerId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (t.status !== 'completed') fail('You can rate a trip once it is completed.');
      const stars = Math.round(num(a.stars, 0));
      if (!(stars >= 1 && stars <= 5)) fail('Choose 1 to 5 stars.');
      t.rating = { stars, comment: str(a.comment, 400), at: now().toISOString() };
      return tripView(t);
    });

    // Driver
    def('driver.trips', ['driver'], false, (ctx) => {
      if (monitorFlights(ctx.company)) ctx.dirty = true;
      const n = now();
      const monday = new Date(n); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const week = db.trips.filter((t) => t.driverId === ctx.user.id && t.status === 'completed' && new Date(t.pickupAt) >= monday);
      return {
        me: { ...pubUser(ctx.user), payType: ctx.user.payType, payRate: ctx.user.payRate },
        trips: db.trips.filter((t) => t.driverId === ctx.user.id && t.status !== 'cancelled').sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).map(tripView),
        week: { from: monday.toISOString(), ...driverPay(ctx.user, week) },
        stats: driverStats(ctx.user, 30),
      };
    });
    def('driver.respond', ['driver'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.driverId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (t.status !== 'assigned') fail('This trip is not waiting for your answer.');
      if (a.accept) { t.status = 'accepted'; t.offer = null; t.needsDriver = null; log(t, 'accepted', ctx.user.name); notify(t, 'accepted'); }
      else { log(t, 'declined', ctx.user.name, str(a.reason, 200)); passOn(t, ctx.user, `${ctx.user.name} declined`); }
      return tripView(t);
    });
    def('driver.advance', ['driver'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.driverId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      const next = DRIVER_FLOW[t.status];
      if (!next) fail('This trip has no next step.');
      t.status = next; log(t, next, ctx.user.name);
      if (next === 'en_route') startTracking(t);
      notify(t, next);
      if (next === 'completed' && t.vehicleId) {
        const v = findVehicle(t.vehicleId);
      }
      return tripView(t);
    });
    def('driver.noShow', ['driver'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.driverId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (t.status !== 'arrived') fail('Tap Arrived first. The free waiting time starts then.');
      const w = waitInfo(t);
      if (now() < new Date(w.endsAt)) fail(`Free waiting runs until ${fmtLocal(w.endsAt, ctx.company, true)}. Keep trying the passenger, or call dispatch.`);
      markNoShow(t, ctx.user.name, a.note);
      return tripView(t);
    });
    def('driver.location', ['driver'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.driverId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (!['en_route', 'arrived', 'on_board'].includes(t.status)) return { ok: false };
      const lat = Number(a.lat), lng = Number(a.lng);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail('Bad location.');
      const fix = { lat, lng, acc: Math.round(num(a.accuracy, 0)), at: now().toISOString() };
      ctx.user.lastLoc = fix;
      if (t.status === 'en_route' && t.tracking) t.tracking.gps = fix;
      return { ok: true };
    });
    def('driver.extras', ['driver'], true, (ctx, a) => {
      const t = db.trips.find((x) => x.id === a.id && x.driverId === ctx.user.id);
      if (!t) fail('Trip not found.', 404);
      if (t.status === 'completed' && t.payment.status === 'paid' && !onFile(t)) fail('This trip is closed and paid.');
      t.waitMin = Math.min(600, Math.max(0, Math.round(num(a.waitMin, 0))));
      t.tolls = Math.min(1000, Math.max(0, round2(num(a.tolls, 0))));
      reprice(t);
      return tripView(t);
    });
    // Chauffeurs never take payment: every trip is paid by card on file, company
    // account or partner billing, and the office records anything else.
    def('driver.collect', ['driver'], true, () => fail("Chauffeurs don't take payment. The office handles it."));
    def('driver.setPhoto', ['driver'], true, (ctx, a) => { ctx.user.photo = cleanPhoto(a.photo); return pubUser(ctx.user); });
    def('driver.availability', ['driver'], true, (ctx, a) => { ctx.user.available = !!a.available; return pubUser(ctx.user); });
    def('dispatch.board', STAFF, false, (ctx, a) => {
      if (monitorFlights(ctx.company)) ctx.dirty = true;
      const from = new Date(a.from), to = new Date(a.to);
      if (isNaN(from) || isNaN(to)) fail('Choose a day.');
      const trips = db.trips.filter((t) => t.companyId === ctx.company.id && t.pickupAt >= from.toISOString() && t.pickupAt < to.toISOString())
        .sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).map(tripView);
      const day = localParts(new Date((from.getTime() + to.getTime()) / 2).toISOString(), ctx.company.timezone).date;
      const drivers = db.users.filter((u) => u.companyId === ctx.company.id && u.role === 'driver' && u.active !== false)
        .map((u) => pubUser(u));
      const vehicles = db.vehicles.filter((v) => v.companyId === ctx.company.id && v.status !== 'retired').map(clone);
      const unassignedLater = db.trips.filter((t) => t.companyId === ctx.company.id && t.status === 'confirmed' && !t.farmout && t.pickupAt >= to.toISOString()).length;
      return { trips, drivers, vehicles, unassignedLater, alerts: companyAlerts(ctx.company) };
    });
    def('dispatch.alerts', STAFF, false, (ctx) => companyAlerts(ctx.company));
    def('dispatch.trips', STAFF, false, (ctx, a) => {
      const q = str(a.q, 80).toLowerCase();
      const status = str(a.status, 20);
      const iso = (x) => { const d = new Date(x); return x && !isNaN(d) ? d.toISOString() : null; };
      const range = iso(a.from) && iso(a.to) ? [iso(a.from), iso(a.to)] : null;
      if (range && new Date(range[1]) - new Date(range[0]) > 62 * 86400e3) fail('Pick a range of two months or less.');
      return db.trips.filter((t) => t.companyId === ctx.company.id)
        .filter((t) => !status || (status === 'active' ? ACTIVE.includes(t.status) : t.status === status))
        .filter((t) => !q || [t.ref, t.passengerName, t.pickup, t.dropoff, t.flight, t.passengerPhone].join(' ').toLowerCase().includes(q))
        // A date range (the calendar) returns every trip in it; otherwise the newest 300.
        .filter((t) => !range || (t.pickupAt >= range[0] && t.pickupAt < range[1]))
        .sort((x, y) => y.pickupAt.localeCompare(x.pickupAt)).slice(0, range ? 3000 : 300).map(tripView);
    });
    def('dispatch.trip', STAFF, false, (ctx, a) => { const t = ownTrip(ctx, a.id); return { ...tripView(t), warnings: assignWarnings(t) }; });
    def('dispatch.quote', STAFF, false, (ctx, a) => {
      const b = a.booking || {};
      const email = str(b.passengerEmail, 120).toLowerCase();
      const cust = email ? db.users.find((u) => u.companyId === ctx.company.id && u.role === 'customer' && u.email === email) : null;
      return { ...quoteFor(ctx.company, b, cust), flight: flightPreview(ctx.company, b), landing: landingPreview(ctx.company, b) };
    });
    def('dispatch.createTrip', STAFF, true, async (ctx, a) => {
      const [b, rb] = bookingPair(ctx.company, a.booking || {}, { allowPast: true });
      if (!b.passengerName) fail('Enter the passenger name.');
      const plan = repeatPlan(ctx.company, b, a.booking || {});
      let customer = null;
      if (b.passengerEmail) {
        if (!emailOk(b.passengerEmail)) fail('Enter a valid passenger email or leave it blank.');
        customer = db.users.find((u) => u.companyId === ctx.company.id && u.email === b.passengerEmail && u.role === 'customer');
        if (!customer) {
          // A customer record without a password; they can create a login later
          // with the same email on the booking page.
          customer = { id: id('usr'), role: 'customer', companyId: ctx.company.id, email: b.passengerEmail, name: b.passengerName, phone: b.passengerPhone, active: true, createdAt: now().toISOString() };
          db.users.push(customer);
        }
      }
      const wantsLanding = !!((a.booking || {}).landing && a.booking.landing.on);
      const t = newTrip(ctx.company, b, customer, 'phone', ctx.user.name, (a.booking || {}).promoCode, wantsLanding);
      let r = null;
      if (rb) { r = newTrip(ctx.company, rb, customer, 'phone', ctx.user.name, ''); linkReturn(t, r); }
      const lt = wantsLanding ? landingTrip(ctx.company, t, a.booking, customer, 'phone', ctx.user.name) : null;
      if (lt) notify(t, 'booked');
      const reps = bookRepeats(ctx.company, a.booking || {}, plan, t, r, customer, 'phone', ctx.user.name, { allowPast: true });
      sweepDispatch(ctx.company, true);
      return { ...tripView(t), returnTrip: r ? tripView(r) : null, landingTrip: lt ? tripView(lt) : null, repeats: reps.filter((x) => !x.returnOf).length };
    });
    def('dispatch.updateTrip', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      const p = a.patch || {};
      const priceOnly = ['notes', 'priceOverride', 'adjustment'];
      if (t.farmout && Object.keys(p).some((k) => !priceOnly.includes(k))) fail(`This trip is with ${t.farmout.toName}. Take it back from them before changing the details.`);
      if (['completed', 'cancelled'].includes(t.status) && Object.keys(p).some((k) => !priceOnly.includes(k))) fail('This trip is closed. Only notes and price can change.');
      const before = t.pickupAt;
      if (t.invoiceId && Object.keys(p).some((k) => !['notes'].includes(k))) fail('This trip is on an invoice. Void the invoice first to change it.');
      const beforeAcct = t.accountId || null;
      const merged = { ...t, ...p };
      if (!['completed', 'cancelled'].includes(t.status)) {
        const b = cleanBooking(ctx.company, merged, { allowPast: true });
        Object.assign(t, b);
        if (t.pickupAt !== before) t.scheduledPickupAt = t.pickupAt;
      } else if ('notes' in p) t.notes = str(p.notes, 500);
      if ('milesOverride' in p) t.milesOverride = p.milesOverride === '' || p.milesOverride == null ? null : Math.max(0, num(p.milesOverride, 0));
      if ('priceOverride' in p) t.priceOverride = p.priceOverride === '' || p.priceOverride == null ? null : Math.max(0, round2(num(p.priceOverride, 0)));
      if ('waitMin' in p) t.waitMin = Math.max(0, Math.round(num(p.waitMin, 0)));
      if ('tolls' in p) t.tolls = Math.max(0, round2(num(p.tolls, 0)));
      if ('adjustment' in p) {
        const amt = round2(num(p.adjustment && p.adjustment.amount, 0));
        t.adjustment = amt ? { amount: amt, reason: str(p.adjustment.reason, 80) } : null;
      }
      if (t.farmIn) { const f = db.farmouts.find((x) => x.id === t.farmIn.id); if (f) { t.priceOverride = f.rate; t.adjustment = null; } }
      if (t.pickupAt !== before && t.status === 'confirmed') { t.needsDriver = null; t.passedBy = []; }
      if ((t.accountId || null) !== beforeAcct) {
        t.priceCtx = { ...(t.priceCtx || {}), discountPct: discountFor(ctx.company, t.customerId && findUser(t.customerId), t.accountId) };
        if (t.payment.status !== 'paid') t.payment = { status: 'unpaid', method: t.accountId ? 'account' : cardsOn(ctx.company) ? 'card_on_file' : null, paidAt: null, ...(t.payment.charges ? { charges: t.payment.charges } : {}) };
        if (t.payment.method === 'card_on_file' && !t.cardToken) t.cardToken = randomId(6);
      }
      reprice(t);
      if (t.flight) checkFlight(t, false);
      log(t, 'edited', ctx.user.name);
      return { ...tripView(t), warnings: assignWarnings(t) };
    });
    def('dispatch.assign', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      notWithPartner(t);
      if (['on_board', 'completed', 'cancelled'].includes(t.status)) fail(`This trip is ${STATUS_LABELS[t.status].toLowerCase()} and can't be reassigned.`);
      if (!a.driverId) {
        t.driverId = null; t.vehicleId = null; t.status = 'confirmed'; t.offer = null; t.needsDriver = { at: now().toISOString(), why: 'Unassigned by the office' }; log(t, 'unassigned', ctx.user.name);
        return { ...tripView(t), warnings: [] };
      }
      const d = db.users.find((u) => u.id === a.driverId && u.companyId === ctx.company.id && u.role === 'driver' && u.active !== false);
      if (!d) fail('Driver not found.', 404);
      let vid = a.vehicleId || null;
      if (!vid) {
        // Default: the driver's own vehicle if it fits and is free, else a free vehicle of the booked type.
        const win = tripWindow(t);
        const free = (v) => v && v.status === 'active' && !db.trips.some((x) => x.id !== t.id && x.vehicleId === v.id && !['cancelled', 'completed'].includes(x.status) && overlaps(win, tripWindow(x)));
        const own = findVehicle(d.vehicleId);
        const ofType = db.vehicles.filter((v) => v.companyId === ctx.company.id && v.type === t.vehicleType && v.capacity >= t.passengers);
        const pick = (own && own.type === t.vehicleType && free(own) && own) || ofType.find(free) || (own && own.status === 'active' && own) || ofType[0];
        vid = pick ? pick.id : null;
      }
      if (vid) ownVehicle(ctx, vid);
      const changed = t.driverId !== d.id;
      t.needsDriver = null;
      t.passedBy = (t.passedBy || []).filter((x) => x !== d.id);
      if (changed || t.status === 'confirmed') offerTo(t, d, vid, ctx.user.name);
      else t.vehicleId = vid;
      return { ...tripView(t), warnings: assignWarnings(t) };
    });
    def('dispatch.setStatus', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      const s = str(a.status, 20);
      if (!STATUS_LABELS[s]) fail('Unknown status.');
      if (s !== 'cancelled') notWithPartner(t);
      if (s !== 'confirmed' && s !== 'cancelled' && !t.driverId) fail('Assign a driver first.');
      if (s === 'confirmed') { t.driverId = null; t.vehicleId = null; }
      if (s !== 'assigned') t.offer = null;
      if (s === 'cancelled' && a.keepFee && t.status !== 'cancelled') { const ct = cancelTerms(t); if (ct.fee > 0) t.cancelFee = ct.fee; }
      t.status = s; log(t, s, ctx.user.name, s === 'cancelled' && t.cancelFee ? `Late cancellation, fee $${money(t.cancelFee)} kept` : '');
      if (s === 'en_route') startTracking(t);
      if (['en_route', 'arrived', 'completed', 'cancelled'].includes(s)) notify(t, s);
      payStep(t);
      return tripView(t);
    });
    // The office running the card now instead of waiting: the fare early, the
    // extras, a retry after a decline, or a refund when the price came down.
    def('dispatch.chargeCard', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      if (!onFile(t)) fail("This trip isn't paid by card on file.");
      if (!cardsOn(ctx.company)) fail('Card payments are not switched on.');
      const s = payState(t);
      if (s.pending) fail('A card charge is already going through. Try again in a minute.');
      if (s.balance < -0.004) { queueRefund(t, -s.balance, ctx.user.name); return tripView(t); }
      if (!t.card) fail('No card on file yet. Text the passenger the card link.');
      if (s.balance <= 0.004) fail('Nothing left to charge.');
      if (s.failed) s.failed.retired = true;
      queueCharge(t, t.status === 'cancelled' ? 'fee' : s.fare ? 'extra' : 'fare', s.balance, ctx.user.name);
      return tripView(t);
    });
    def('dispatch.sendCardLink', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      if (!onFile(t)) fail("This trip isn't paid by card on file.");
      const to = t.passengerPhone || t.passengerEmail;
      if (!to) fail('Add a passenger mobile or email first.');
      if (!t.cardToken) t.cardToken = randomId(6);
      const c = ctx.company, ph = pcfg(c).chargeHours;
      db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: t.id, ref: t.ref, at: now().toISOString(), recipient: to, channel: t.passengerPhone ? 'sms' : 'email',
        body: `${c.name}: please add a card for ride ${t.ref}, ${fmtLocal(t.pickupAt, c, true)}. ${chargeNote(c)}: ${cardUrl(t)}` });
      log(t, 'card_link', ctx.user.name, `Card link sent to ${to}`);
      return tripView(t);
    });
    // ---- Incidents: accidents, damage, complaints, lost items -----------------
    function incView(x) {
      const t = x.tripId && db.trips.find((y) => y.id === x.tripId), d = x.driverId && findUser(x.driverId), v = x.vehicleId && findVehicle(x.vehicleId);
      return { ...clone(x), kindLabel: INCIDENT_KINDS[x.kind] || 'Other', trip: t ? { id: t.id, ref: t.ref, pickupAt: t.pickupAt, passengerName: t.passengerName } : null, driver: d ? { id: d.id, name: d.name } : null, vehicle: v ? { id: v.id, name: v.name, plate: v.plate } : null };
    }
    function incFields(ctx, a, x) {
      if (!INCIDENT_KINDS[a.kind]) fail('Choose what happened.');
      const description = str(a.description, 2000);
      if (description.length < 5) fail('Describe what happened.');
      x.kind = a.kind; x.description = description;
      x.severity = ['low', 'medium', 'high'].includes(a.severity) ? a.severity : 'medium';
      x.happenedAt = a.happenedAt && !isNaN(new Date(a.happenedAt)) ? new Date(a.happenedAt).toISOString() : x.happenedAt || now().toISOString();
      x.location = str(a.location, 200);
    }
    def('driver.reportIncident', ['driver'], true, (ctx, a) => {
      const t = a.tripId ? db.trips.find((x) => x.id === a.tripId && x.driverId === ctx.user.id) : null;
      if (a.tripId && !t) fail('Trip not found.', 404);
      const x = { id: id('inc'), companyId: ctx.company.id, tripId: t ? t.id : null, driverId: ctx.user.id, vehicleId: (t && t.vehicleId) || ctx.user.vehicleId || null, reportedBy: ctx.user.name, createdAt: now().toISOString(), status: 'open', resolution: '' };
      incFields(ctx, a, x);
      db.incidents.unshift(x);
      return incView(x);
    });
    def('dispatch.incidents', STAFF, false, (ctx, a) => {
      const st = a.status === 'closed' ? 'closed' : a.status === 'all' ? '' : 'open';
      return db.incidents.filter((x) => x.companyId === ctx.company.id && (!st || x.status === st)).map(incView);
    });
    def('dispatch.saveIncident', STAFF, true, (ctx, a) => {
      let x = a.id ? db.incidents.find((y) => y.id === a.id && y.companyId === ctx.company.id) : null;
      if (a.id && !x) fail('Incident not found.', 404);
      if (!x) { x = { id: id('inc'), companyId: ctx.company.id, reportedBy: ctx.user.name, createdAt: now().toISOString(), status: 'open', resolution: '' }; db.incidents.unshift(x); }
      incFields(ctx, a, x);
      const t = a.tripRef ? db.trips.find((y) => y.companyId === ctx.company.id && y.ref.toLowerCase() === str(a.tripRef, 20).toLowerCase()) : null;
      if (a.tripRef && !t) fail(`No trip ${str(a.tripRef, 20)}.`);
      if (t) { x.tripId = t.id; x.driverId = x.driverId || t.driverId || null; x.vehicleId = x.vehicleId || t.vehicleId || null; } else if ('tripRef' in a) x.tripId = null;
      if ('driverId' in a) { const d = a.driverId && findUser(a.driverId); if (a.driverId && (!d || d.companyId !== ctx.company.id)) fail('Driver not found.'); x.driverId = a.driverId || null; }
      if ('vehicleId' in a) { if (a.vehicleId) ownVehicle(ctx, a.vehicleId); x.vehicleId = a.vehicleId || null; }
      x.resolution = str(a.resolution, 1000);
      const closing = a.status === 'closed' && x.status !== 'closed';
      x.status = a.status === 'closed' ? 'closed' : 'open';
      if (closing) { x.closedAt = now().toISOString(); x.closedBy = ctx.user.name; } else if (x.status === 'open') { x.closedAt = null; x.closedBy = null; }
      return incView(x);
    });

    // ---- Trip import (manifest upload) ----------------------------------------
    // Rows from a spreadsheet. With check set, nothing is saved: each row comes
    // back with its price or what's wrong, so the office can fix the file first.
    const IMPORT_SERVICE = { transfer: 'transfer', 'point to point': 'transfer', airport: 'airport', 'airport transfer': 'airport', hourly: 'hourly', 'by the hour': 'hourly', hour: 'hourly' };
    def('dispatch.importTrips', STAFF, true, (ctx, a) => {
      const rows = Array.isArray(a.rows) ? a.rows.slice(0, 500) : [];
      if (!rows.length) fail('The file has no trips in it.');
      const c = ctx.company, out = [];
      const vt = (x) => VEHICLE_TYPES.find((t) => t.toLowerCase() === String(x || '').trim().toLowerCase()) || (String(x || '').trim() ? null : 'Sedan');
      const plans = [];
      rows.forEach((r, i) => {
        try {
          const date = str(r.date, 20), time = str(r.time, 20);
          const at = localToIso(date, time, c);
          if (!at) fail('Use a date like 2026-10-14 and a time like 14:30 or 2:30 PM.');
          const type = vt(r.vehicleType);
          if (!type) fail(`Vehicle type must be one of: ${VEHICLE_TYPES.join(', ')}.`);
          const service = IMPORT_SERVICE[String(r.service || '').trim().toLowerCase()] || (r.hours ? 'hourly' : 'transfer');
          let accountId = '';
          if (r.account) { const acc = db.accounts.find((x) => x.companyId === c.id && x.name.toLowerCase() === str(r.account, 120).toLowerCase()); if (!acc) fail(`No company account named ${str(r.account, 60)}.`); accountId = acc.id; }
          const raw = { service, pickupAt: at, pickup: r.pickup, dropoff: r.dropoff, vehicleType: type, passengers: r.passengers || 1, hours: r.hours, flight: r.flight, passengerName: r.passengerName, passengerPhone: r.passengerPhone, passengerEmail: r.passengerEmail, notes: r.notes, accountId, poNumber: r.poNumber };
          const b = cleanBooking(c, raw, { allowPast: false });
          if (!b.passengerName) fail('Passenger name is missing.');
          if (b.passengerEmail && !emailOk(b.passengerEmail)) fail('Passenger email is not valid.');
          const price = quote(c, b, priceCtx(c, b, null, ''));
          plans.push({ row: i + 1, b });
          out.push({ row: i + 1, ok: true, pickupAt: b.pickupAt, passengerName: b.passengerName, pickup: b.pickup, dropoff: b.dropoff, vehicleType: b.vehicleType, total: price.total });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          out.push({ row: i + 1, ok: false, error: e.message, passengerName: str(r.passengerName, 80) });
        }
      });
      const bad = out.filter((x) => !x.ok).length;
      if (a.check || bad) return { saved: 0, bad, rows: out };
      for (const { row, b } of plans) {
        let customer = null;
        if (b.passengerEmail) {
          customer = db.users.find((u) => u.companyId === c.id && u.email === b.passengerEmail && u.role === 'customer');
          if (!customer) { customer = { id: id('usr'), role: 'customer', companyId: c.id, email: b.passengerEmail, name: b.passengerName, phone: b.passengerPhone, active: true, createdAt: now().toISOString() }; db.users.push(customer); }
        }
        const t = newTrip(c, b, customer, 'import', ctx.user.name, '', !a.confirm);
        out.find((x) => x.row === row).ref = t.ref;
      }
      return { saved: plans.length, bad: 0, rows: out };
    });

    // ---- Accounting export (QuickBooks) ----------------------------------------
    // Company-account invoices become QuickBooks invoices; rides paid by card or
    // cash become sales receipts. Both match QuickBooks Online's import columns.
    def('dispatch.accountingExport', ['admin'], false, (ctx, a) => {
      const c = ctx.company, tz = c.timezone;
      const from = dateOk(a.from) ? a.from : '0000-01-01', to = dateOk(a.to) ? a.to : '9999-12-31';
      const d = (iso) => { const p = localParts(iso, tz).date.split('-'); return `${p[1]}/${p[2]}/${p[0]}`; };
      const inRange = (iso) => { const x = localParts(iso, tz).date; return x >= from && x <= to; };
      const invoices = [];
      for (const inv of db.clientInvoices.filter((x) => x.companyId === c.id && inRange(x.issuedAt))) {
        const acc = db.accounts.find((x) => x.id === inv.accountId);
        for (const l of inv.lines) invoices.push({ InvoiceNo: inv.number, Customer: acc ? acc.name : '', InvoiceDate: d(inv.issuedAt), DueDate: d(inv.dueAt), Terms: inv.terms ? `Net ${inv.terms}` : 'Due on receipt', 'Item(Product/Service)': 'Chauffeured transportation', ItemDescription: [l.ref, l.passenger, l.route].filter(Boolean).join(' · '), ItemQuantity: 1, ItemRate: l.amount, ItemAmount: l.amount });
      }
      const receipts = db.trips.filter((t) => t.companyId === c.id && t.payment.status === 'paid' && !t.accountId && t.payment.paidAt && inRange(t.payment.paidAt)).map((t) => ({
        SalesReceiptNo: t.ref, Customer: t.passengerName || 'Walk-in', SalesReceiptDate: d(t.payment.paidAt), PaymentMethod: t.payment.method === 'cash' ? 'Cash' : 'Credit Card', 'Product/Service': 'Chauffeured transportation',
        Description: `${t.pickup}${t.dropoff ? ' to ' + t.dropoff : ''}`, Qty: 1, Rate: t.price.total, Amount: t.price.total,
      }));
      return { from, to, invoices, receipts };
    });

    // ---- Live map for the dispatch board -------------------------------------
    // Every driver's car (live GPS when the phone shares it, otherwise an
    // estimate) and the pickups coming up in the next hours.
    def('dispatch.fleetMap', STAFF, false, (ctx, a) => {
      const c = ctx.company, n = now(), nowMs = n.getTime(), region = regionOf(c);
      const hours = Math.min(24, Math.max(1, num(a.hours, 6)));
      const fresh = (loc, min) => loc && nowMs - new Date(loc.at).getTime() < min * 60e3;
      const at = (h) => h && new Date(h.at).getTime();
      const cars = [];
      for (const d of db.users.filter((u) => u.companyId === c.id && u.role === 'driver' && u.active !== false)) {
        const mine = db.trips.filter((t) => t.driverId === d.id && t.companyId === c.id);
        const live = mine.find((t) => ['en_route', 'arrived', 'on_board'].includes(t.status));
        const next = mine.filter((t) => ['accepted', 'assigned'].includes(t.status) && t.pickupAt > n.toISOString()).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt))[0];
        const v = (live && live.vehicleId && findVehicle(live.vehicleId)) || (d.vehicleId && findVehicle(d.vehicleId));
        const car = { id: d.id, name: d.name, vehicle: v ? { name: v.name, plate: v.plate || '', type: v.type } : null, available: !!d.available };
        if (live && live.status !== 'on_board') {
          const l = liveOf(live) || {};
          if (live.status === 'arrived' && fresh(d.lastLoc, 3)) Object.assign(l, { pos: { lat: d.lastLoc.lat, lng: d.lastLoc.lng }, source: 'gps' });
          Object.assign(car, { state: live.status, pos: l.pos || addressPoint(c, live.pickup), to: addressPoint(c, live.pickup), source: l.source || 'estimate', etaMin: l.etaMin || 0, trip: { id: live.id, ref: live.ref, passengerName: live.passengerName, place: live.pickup } });
        } else if (live) {
          const from = addressPoint(c, live.pickup), to = addressPoint(c, live.dropoff || live.pickup);
          const started = at(live.history.filter((h) => h.status === 'on_board').pop()) || nowMs;
          const mins = live.service === 'hourly' ? (live.hours || 2) * 60 : Math.max(10, (live.price && live.price.minutes) || estimateRoute(live.pickup, live.dropoff).minutes || 30);
          const f = Math.min(0.97, Math.max(0.02, (nowMs - started) / (mins * 60e3)));
          const gps = fresh(d.lastLoc, 3);
          const pos = gps ? { lat: d.lastLoc.lat, lng: d.lastLoc.lng } : live.service === 'hourly' ? offset(from, 0.6, f * 2 * Math.PI) : onCurve(from, bendPoint(from, to), to, f);
          Object.assign(car, { state: 'on_board', pos, to: live.dropoff ? to : null, source: gps ? 'gps' : 'estimate', etaMin: live.service === 'hourly' ? 0 : Math.max(1, Math.round(milesBetween(pos, to) * 2.4 + 1)), trip: { id: live.id, ref: live.ref, passengerName: live.passengerName, place: live.dropoff || live.pickup } });
        } else {
          // Not on a trip: last GPS fix, else where the last trip ended today, else the garage.
          const done = mine.filter((t) => t.status === 'completed' && nowMs - new Date(t.pickupAt).getTime() < 12 * 3600e3).sort((x, y) => y.pickupAt.localeCompare(x.pickupAt))[0];
          const gps = fresh(d.lastLoc, 30);
          const h = fnv(d.id);
          const base = c.base && c.base.lat ? c.base : offset(REGION_CENTER[region], 1.5 + (h % 30) / 10, ((h >>> 8) % 360) * Math.PI / 180);
          Object.assign(car, { state: d.available ? 'free' : 'off', pos: gps ? { lat: d.lastLoc.lat, lng: d.lastLoc.lng } : done ? addressPoint(c, done.dropoff || done.pickup) : base, source: gps ? 'gps' : 'estimate', where: gps ? 'Last GPS fix' : done ? `Dropped off ${done.ref}` : 'At base', to: null });
        }
        if (next) car.next = { id: next.id, ref: next.ref, pickupAt: next.pickupAt, pickup: next.pickup };
        cars.push(car);
      }
      const until = new Date(nowMs + hours * 3600e3).toISOString();
      const pickups = db.trips.filter((t) => t.companyId === c.id && ['confirmed', 'assigned', 'accepted'].includes(t.status) && t.pickupAt <= until && t.pickupAt >= new Date(nowMs - 3600e3).toISOString())
        .sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).slice(0, 40)
        .map((t) => ({ id: t.id, ref: t.ref, pickupAt: t.pickupAt, pickup: t.pickup, passengerName: t.passengerName, status: t.status, driver: t.driverId ? (findUser(t.driverId) || {}).name || '' : t.farmout ? 'Partner' : '', unassigned: t.status === 'confirmed' && !t.farmout, pos: addressPoint(c, t.pickup) }));
      return { center: REGION_CENTER[region], landmarks: (LANDMARKS[region] || []).map(([name, lat, lng]) => ({ name, lat, lng })), cars, pickups, at: n.toISOString() };
    });

    // The office can close a no-show at any point once a driver has the trip.
    def('dispatch.noShow', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      notWithPartner(t);
      if (!['accepted', 'en_route', 'arrived'].includes(t.status)) fail('Only a trip whose driver has accepted it can be marked a no-show.');
      markNoShow(t, ctx.user.name, a.note);
      return tripView(t);
    });
    def('dispatch.suggest', STAFF, false, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      return rankDrivers(t).slice(0, 6);
    });
    def('dispatch.autoAssign', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      notWithPartner(t);
      if (!['confirmed', 'assigned'].includes(t.status)) fail('Only trips without an accepted driver can be auto-assigned.');
      const keep = { driverId: t.driverId, status: t.status };
      if (t.driverId) t.passedBy = [...new Set([...(t.passedBy || []), t.driverId])];
      t.driverId = null; t.vehicleId = null; t.status = 'confirmed';
      const best = autoAssign(t, ctx.user.name);
      if (!best) {
        if (keep.driverId) { t.passedBy = t.passedBy.filter((x) => x !== keep.driverId); Object.assign(t, keep); }
        fail('No free driver with a suitable car for this trip. Check the suggestions or send it to a partner company.');
      }
      t.needsDriver = null;
      return { ...tripView(t), warnings: assignWarnings(t), picked: best };
    });
    def('dispatch.rules', STAFF, false, (ctx) => dcfg(ctx.company));
    // Message wording: defaults, the company's own, and a preview on a real trip.
    def('dispatch.templates', STAFF, false, (ctx) => {
      const own = ctx.company.templates || {};
      const mine = db.trips.filter((t) => t.companyId === ctx.company.id), soon = mine.filter((t) => t.pickupAt > now().toISOString()).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
      const sample = soon.find((t) => t.driverId) || soon[0] || mine[mine.length - 1];
      return Object.entries(MSG_TEMPLATES).map(([key, m]) => ({ key, label: m.label, default: m.text, text: own[key] || '', preview: sample ? msgText(sample, key) : '' }));
    });
    def('dispatch.saveTemplates', ['admin'], true, (ctx, a) => {
      const out = {};
      for (const [k, v] of Object.entries(a.templates || {})) {
        if (!MSG_TEMPLATES[k]) continue;
        const t = str(v, 1000);
        if (!t || t === MSG_TEMPLATES[k].text) continue;
        const bad = (t.match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1)).filter((x) => !MSG_WORDS.includes(x));
        if (bad.length) fail(`${MSG_TEMPLATES[k].label}: {${bad[0]}} isn't a word we can fill in.`);
        out[k] = t;
      }
      ctx.company.templates = out;
      return { ok: true, saved: Object.keys(out).length };
    });
    def('dispatch.clientMsgs', STAFF, false, (ctx) => cmsg(ctx.company));
    def('dispatch.saveClientMsgs', ['admin'], true, (ctx, a) => {
      const r = a.settings || {}, cur = cmsg(ctx.company);
      const b = (k) => (k in r ? !!r[k] : cur[k]);
      ctx.company.clientMsgs = { confirmText: b('confirmText'), confirmEmail: b('confirmEmail'), remind24: b('remind24'), approach: b('approach'), review: b('review'), reviewDelayMin: Math.min(1440, Math.max(0, Math.round(num(r.reviewDelayMin, cur.reviewDelayMin)))) };
      return clone(ctx.company.clientMsgs);
    });
    def('dispatch.saveRules', ['admin'], true, (ctx, a) => {
      const c = ctx.company, r = a.rules || {};
      const int = (v, lo, hi, d) => { const x = Math.round(num(v, d)); return Math.min(hi, Math.max(lo, x)); };
      const cur = dcfg(c);
      c.dispatch = {
        autoAssign: 'autoAssign' in r ? !!r.autoAssign : cur.autoAssign,
        horizonHours: int(r.horizonHours, 1, 168, cur.horizonHours),
        acceptMin: int(r.acceptMin, 2, 240, cur.acceptMin),
        onNoAnswer: r.onNoAnswer === 'office' ? 'office' : r.onNoAnswer === 'next' ? 'next' : cur.onNoAnswer,
        remindEvening: 'remindEvening' in r ? !!r.remindEvening : cur.remindEvening,
        eveningHour: int(r.eveningHour, 12, 23, cur.eveningHour),
        remindBeforeMin: int(r.remindBeforeMin, 0, 720, cur.remindBeforeMin),
        lateStartMin: int(r.lateStartMin, 0, 240, cur.lateStartMin),
        minNoticeHours: int(r.minNoticeHours, 0, 72, cur.minNoticeHours),
      };
      // Trips parked for lack of a driver get another try under the new rules.
      if (c.dispatch.autoAssign) for (const t of db.trips) if (t.companyId === c.id && t.status === 'confirmed') t.needsDriver = null;
      return clone(c.dispatch);
    });
    def('dispatch.markPaid', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      if (t.invoiceId) fail('This trip is on an invoice. Mark the invoice paid instead.');
      const keep = t.payment.charges ? { charges: t.payment.charges } : {};
      if (a.unpaid) t.payment = { status: 'unpaid', method: t.cardToken && cardsOn(ctx.company) ? 'card_on_file' : null, paidAt: null, ...keep };
      else t.payment = { status: 'paid', method: ['cash', 'card', 'invoice'].includes(a.method) ? a.method : 'card', paidAt: now().toISOString(), ...keep };
      if (onFile(t)) settle(t);
      return tripView(t);
    });
    // ---- Event quotes ----------------------------------------------------------
    // A customer (or the office, for a phone call) asks for a price on an event:
    // one or more rides, each with a vehicle type and how many vehicles. The
    // office prices each line (suggested from the normal rates), sends the quote
    // with a deposit, and the customer accepts on the quote page. Accepting takes
    // the deposit and books one trip per vehicle.
    const QUOTE_LABELS = { new: 'Needs a price', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', cancelled: 'Cancelled' };
    const qcfg = (c) => ({ ...DEFAULT_QUOTE, ...(c.quoteCfg || {}) });
    const quoteUrl = (q) => `${opts.publicUrl || ''}#quote.${q.token}`;
    const todayIn = (c) => localParts(now().toISOString(), c.timezone).date;
    // Sent quotes lapse after their valid-until date without anyone touching them.
    const qStatus = (q, c) => q.status === 'sent' && q.validUntil && todayIn(c) > q.validUntil ? 'expired' : q.status;
    const splitPax = (total, n, i) => Math.floor(total / n) + (i < total % n ? 1 : 0);
    function qlog(q, what, by) { q.history = q.history || []; q.history.push({ at: now().toISOString(), what, by: by || '' }); }
    function cleanQuoteLines(c, lines, { allowPast, keepPrice } = {}) {
      if (!Array.isArray(lines) || !lines.length) fail('Add at least one ride.');
      if (lines.length > 12) fail('A quote can have up to 12 rides.');
      return lines.map((l, i) => {
        const count = Math.round(num(l.count, 1));
        if (!(count >= 1 && count <= 20)) fail(`Ride ${i + 1}: choose 1 to 20 vehicles.`);
        const pax = Math.round(num(l.passengers, 1));
        if (!(pax >= 1 && pax <= 400)) fail(`Ride ${i + 1}: enter how many passengers.`);
        let b;
        try { b = cleanBooking(c, { ...l, passengers: splitPax(pax, count, 0) }, { allowPast }); } catch (e) { fail(`Ride ${i + 1}: ${e.message}`); }
        const price = keepPrice && l.unitPrice !== '' && l.unitPrice != null ? Math.max(0, round2(num(l.unitPrice, 0))) : null;
        // Optional contact for this group (bridal party, groomsmen...): the
        // chauffeur's texts for this ride go to it instead of the organizer.
        const phone = str(l.phone, 30);
        const digits = phone.replace(/\D/g, '').length;
        if (phone && (digits < 7 || digits > 15)) fail(`Ride ${i + 1}: check the phone number.`);
        return { service: b.service, pickup: b.pickup, dropoff: b.dropoff, pickupAt: b.pickupAt, hours: b.hours, vehicleType: b.vehicleType, flight: b.flight, count, passengers: pax, notes: str(l.notes, 200), phone, unitPrice: price };
      });
    }
    function quoteTotals(q) {
      const total = round2(q.lines.reduce((s, l) => s + (l.unitPrice || 0) * l.count, 0));
      return { total };
    }
    function quoteView(q, staff) {
      const c = findCompany(q.companyId);
      const status = qStatus(q, c);
      const out = {
        id: q.id, number: q.number, status, statusLabel: QUOTE_LABELS[status], company: pubCompany(c), contact: clone(q.contact), eventType: q.eventType, eventName: q.eventName, eventDate: q.lines.length ? q.lines.map((l) => l.pickupAt).sort()[0] : null,
        notes: q.notes, message: q.message, depositPct: q.depositPct, validUntil: q.validUntil, createdAt: q.createdAt, sentAt: q.sentAt || null, decidedAt: q.decidedAt || null, declineReason: q.declineReason || '',
        depositPaid: q.depositPaid ? clone(q.depositPaid) : null, ...quoteTotals(q), source: q.source,
        card: pubCard(q.card), cards: cardsOn(c), chargeWhen: atBooking(c) ? 'booking' : 'before', chargeHours: pcfg(c).chargeHours, needsCard: status === 'accepted' && cardsOn(c) && !q.card && (q.tripIds || []).some((tid) => { const t = db.trips.find((x) => x.id === tid); return t && onFile(t) && !['completed', 'cancelled'].includes(t.status); }),
        lines: q.lines.map((l) => ({ ...clone(l), serviceLabel: SERVICES[l.service], lineTotal: round2((l.unitPrice || 0) * l.count) })),
        trips: (q.tripIds || []).map((tid) => db.trips.find((t) => t.id === tid)).filter(Boolean).map((t) => ({ id: t.id, ref: t.ref, pickupAt: t.pickupAt, vehicleType: t.vehicleType, status: t.status, statusLabel: STATUS_LABELS[t.status] })),
      };
      if (staff) {
        const cust = q.customerId && findUser(q.customerId);
        out.token = q.token; out.history = clone(q.history || []); out.customer = cust ? { id: cust.id, name: cust.name } : null;
        out.lines.forEach((l, i) => {
          const src = q.lines[i];
          const fleet = db.vehicles.filter((v) => v.companyId === c.id && v.status === 'active' && v.type === src.vehicleType).length;
          try { l.suggested = quote(c, { ...src, passengers: splitPax(src.passengers, src.count, 0) }, priceCtx(c, src, cust)).total; } catch (e) { l.suggested = null; }
          l.fleet = fleet;
          if (src.count > fleet) l.warning = `You have ${fleet} ${src.vehicleType}${fleet === 1 ? '' : 's'}. Send the rest to a partner company once it's booked.`;
        });
      }
      return out;
    }
    function quoteSay(q, sms, email) {
      for (const [recipient, channel, body] of [[q.contact.phone, 'sms', sms], [q.contact.email, 'email', email]]) {
        if (!recipient || !body) continue;
        db.messages.unshift({ id: id('msg'), companyId: q.companyId, tripId: null, quoteId: q.id, ref: q.number, at: now().toISOString(), recipient, channel, body, kind: 'quote' });
      }
      if (db.messages.length > 600) db.messages.length = 600;
    }
    function cleanContact(a) {
      const contact = { name: str(a.name, 80), phone: str(a.phone, 30), email: str(a.email, 120).toLowerCase(), org: str(a.org, 80) };
      if (!contact.name) fail('Enter the name of the person planning the event.');
      if (!contact.phone && !contact.email) fail('Enter a phone number or email so we can send the quote.');
      if (contact.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) fail('Check the email address.');
      return contact;
    }
    function newQuote(c, a, source, customer, by) {
      const contact = cleanContact(a.contact || {});
      const lines = cleanQuoteLines(c, a.lines, { allowPast: source !== 'online', keepPrice: source !== 'online' });
      c.nextQuote = (c.nextQuote || 0) + 1;
      const q = {
        id: id('quote'), companyId: c.id, number: `${c.refPrefix}-Q-${String(c.nextQuote).padStart(4, '0')}`, token: randomId(8), status: 'new', source,
        customerId: customer ? customer.id : null, contact, eventType: EVENT_TYPES.includes(a.eventType) ? a.eventType : 'Other', eventName: str(a.eventName, 100), notes: str(a.notes, 800),
        lines, message: str(a.message, 800), validUntil: '', createdAt: now().toISOString(), history: [], tripIds: [],
      };
      qlog(q, source === 'online' ? 'Requested online' : 'Created by the office', by || contact.name);
      db.quotes.push(q);
      return q;
    }
    // Books one trip per vehicle at the quoted price, each on the card saved
    // with the quote. One confirmation goes to the contact instead of one per car.
    function bookQuote(q, by, card) {
      const c = findCompany(q.companyId);
      const cust = q.customerId && findUser(q.customerId);
      const { total } = quoteTotals(q);
      const label = [q.eventType, q.eventName].filter(Boolean).join(': ');
      const made = [];
      if (card) q.card = clone(card);
      const units = q.lines.flatMap((l) => Array.from({ length: l.count }, (_, i) => ({ l, i })));
      units.forEach(({ l, i }, k) => {
        const b = cleanBooking(c, { ...l, passengers: splitPax(l.passengers, l.count, i), passengerName: q.contact.name + (l.count > 1 ? ` (car ${i + 1} of ${l.count})` : ''), passengerPhone: l.phone || q.contact.phone, passengerEmail: q.contact.email, notes: [`Quote ${q.number}${label ? ` (${label})` : ''}`, l.notes].filter(Boolean).join('. ') }, { allowPast: false });
        const t = newTrip(c, b, cust || null, q.source === 'online' ? 'online' : 'phone', by, '', true);
        t.quoteId = q.id; t.quoteNumber = q.number; t.priceOverride = l.unitPrice; reprice(t);
        if (q.termsAgreed) t.termsAgreed = clone(q.termsAgreed);
        if (onFile(t) && q.card) t.card = clone(q.card);
        made.push(t);
      });
      q.tripIds = made.map((t) => t.id);
      q.status = 'accepted'; q.decidedAt = now().toISOString();
      const first = made.map((t) => t.pickupAt).sort()[0];
      const refs = made.map((t) => t.ref).join(', ');
      const ph = pcfg(c).chargeHours, onCard = made.some(onFile);
      const cardLine = !onCard ? '' : q.card ? (atBooking(c) ? ` The rides are charged to your card ending ${q.card.last4} now.` : ` Nothing is charged now; each ride goes on your card ending ${q.card.last4} ${ph} hours before pickup.`) : ` Please add a card for the rides: ${quoteUrl(q)}`;
      quoteSay(q, `${c.name}: quote ${q.number} is booked. ${made.length} vehicle${made.length === 1 ? '' : 's'} from ${fmtLocal(first, c, true)}.${cardLine}`,
        `${c.name}: thank you, your ${label || 'event'} is booked. Quote ${q.number}, total $${money(total)}. Trips: ${refs}. First pickup ${fmtLocal(first, c, true)}.${cardLine} We'll send each chauffeur's details on the day.${c.phone ? ` Questions? Call ${c.phone}.` : ''}`);
      for (const t of made) payStep(t);
      return made;
    }
    // Whoever books the quote online is the contact on every trip: the name and
    // mobile they type replace what the request had.
    function bookingContact(a) {
      const name = str(a.name, 80), phone = str(a.phone, 30);
      if (!name) fail('Type your name to accept the quote.');
      if (phone.replace(/\D/g, '').length < 7) fail('Enter a mobile number so the chauffeur can reach you on the day.');
      return { name, phone };
    }
    function quoteCard(q, card) {
      q.card = clone(card);
      for (const tid of q.tripIds || []) { const t = db.trips.find((x) => x.id === tid); if (t && onFile(t) && !['completed', 'cancelled'].includes(t.status)) attachCard(t, card); }
      qlog(q, `Card ending ${card.last4} saved for the rides`, card.by || q.contact.name);
    }
    const quoteByToken = (tok) => { const q = str(tok, 40) && db.quotes.find((x) => x.token === str(tok, 40)); if (!q) fail('This quote link is not valid.', 404); return q; };
    const ownQuote = (ctx, qid) => { const q = db.quotes.find((x) => x.id === qid && x.companyId === ctx.company.id); if (!q) fail('Quote not found.', 404); return q; };

    def('public.requestQuote', 'public', true, (ctx, a) => {
      const c = companyBySlug(a.slug);
      const s = ctx.token && db.sessions[ctx.token];
      const u = s && findUser(s.userId);
      const cust = u && u.role === 'customer' && u.companyId === c.id && u.active !== false ? u : null;
      if (Array.isArray(a.lines)) for (const l of a.lines) if (l && l.pickupAt && !isNaN(new Date(l.pickupAt))) checkNotice(c, new Date(l.pickupAt).toISOString());
      const q = newQuote(c, a, 'online', cust, null);
      quoteSay(q, `${c.name}: we got your quote request ${q.number}. We'll text you the price soon.`, `${c.name}: thank you for your quote request ${q.number}${q.eventName ? ` for ${q.eventName}` : ''}. Our team is pricing it now and will send you a link to review and book.`);
      return { number: q.number, company: pubCompany(c) };
    });
    // The card link: anyone with it can add or replace the card for that ride.
    const tripByCardToken = (tok) => { const t = str(tok, 40) && db.trips.find((x) => x.cardToken === str(tok, 40)); if (!t || !onFile(t)) fail('This card link is not valid.', 404); return t; };
    function cardPage(t) {
      const c = findCompany(t.companyId), pv = payView(t);
      return { company: pubCompany(c), ref: t.ref, pickupAt: t.pickupAt, pickupLabel: fmtLocal(t.pickupAt, c, true), pickup: t.pickup, dropoff: t.dropoff, service: SERVICES[t.service], vehicleType: t.vehicleType, passengerName: t.passengerName, total: t.price.total,
        status: t.status, statusLabel: t.noShow ? 'No-show' : STATUS_LABELS[t.status], card: pubCard(t.card), closed: t.status === 'cancelled' || (t.status === 'completed' && t.payment.status === 'paid'),
        chargeAt: pv.chargeAt, chargeLabel: fmtLocal(pv.chargeAt, c, true), chargeWhen: pv.chargeWhen, chargeHours: pv.chargeHours, paid: pv.paid, balance: pv.balance, failed: pv.failed, fareCharged: pv.fareCharged };
    }
    def('public.cardInfo', 'public', false, (ctx, a) => cardPage(tripByCardToken(a.token)));
    def('public.saveCard', 'public', true, (ctx, a) => {
      const t = tripByCardToken(a.token);
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Your card is saved on a secure Stripe page. Reload and try again.' : "Card payments aren't set up yet.");
      if (t.status === 'cancelled' || (t.status === 'completed' && t.payment.status === 'paid')) fail('This ride is closed.');
      const cu = t.customerId && findUser(t.customerId);
      const card = demoCard(a.card || a, cu ? cu.name : t.passengerName);
      if (cu) saveCustomerCard(cu, card);
      if (!t.card || t.card.savedAt !== card.savedAt || t.card.last4 !== card.last4) attachCard(t, card);
      return cardPage(t);
    });
    def('public.viewQuote', 'public', false, (ctx, a) => { const q = quoteByToken(a.token); return { ...quoteView(q, false), terms: findCompany(q.companyId).terms || '' }; });
    def('public.acceptQuote', 'public', true, (ctx, a) => {
      const q = quoteByToken(a.token);
      const c = findCompany(q.companyId);
      const st = qStatus(q, c);
      if (st === 'accepted') fail('This quote is already booked.');
      if (st === 'expired') fail(`This quote expired on ${q.validUntil}. Call ${c.name} for a new one.`);
      if (st !== 'sent') fail('This quote is not open for booking.');
      const who = bookingContact(a);
      q.termsAgreed = agreeTerms(c, a, who.name) || undefined;
      // With Stripe the card is saved on Stripe's page first (pay.complete books
      // it). A company without card payments books now and collects later.
      if (cardsOn(c) && payMode === 'stripe') fail('Your card is saved on a secure Stripe page. Reload and tap the button again.');
      const card = cardsOn(c) ? demoCard(a.card || {}, who.name) : null;
      Object.assign(q.contact, who);
      bookQuote(q, who.name, card);
      qlog(q, `Accepted online by ${who.name}${card ? `, card ending ${card.last4} saved` : ''}`, who.name);
      return quoteView(q, false);
    });
    // A card for a quote the office booked without one: goes on every open ride.
    def('public.saveQuoteCard', 'public', true, (ctx, a) => {
      const q = quoteByToken(a.token);
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Your card is saved on a secure Stripe page. Reload and try again.' : "Card payments aren't set up yet.");
      if (qStatus(q, findCompany(q.companyId)) !== 'accepted') fail('This quote is not booked yet.');
      quoteCard(q, demoCard(a.card || a, q.contact.name));
      return quoteView(q, false);
    });
    def('public.declineQuote', 'public', true, (ctx, a) => {
      const q = quoteByToken(a.token);
      if (qStatus(q, findCompany(q.companyId)) !== 'sent') fail('This quote is not open.');
      q.status = 'declined'; q.decidedAt = now().toISOString(); q.declineReason = str(a.reason, 300);
      qlog(q, 'Declined by the customer' + (q.declineReason ? `: ${q.declineReason}` : ''), q.contact.name);
      return quoteView(q, false);
    });
    def('customer.quotes', ['customer'], false, (ctx) => db.quotes.filter((q) => q.customerId === ctx.user.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((q) => ({ ...quoteView(q, false), token: q.token })));
    def('dispatch.quotes', STAFF, false, (ctx) => db.quotes.filter((q) => q.companyId === ctx.company.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((q) => quoteView(q, true)));
    def('dispatch.getQuote', STAFF, false, (ctx, a) => quoteView(ownQuote(ctx, a.id), true));
    def('dispatch.saveQuote', STAFF, true, (ctx, a) => {
      const c = ctx.company;
      let q;
      if (!a.id) q = newQuote(c, a, 'phone', a.customerId ? db.users.find((u) => u.id === a.customerId && u.companyId === c.id && u.role === 'customer') : null, ctx.user.name);
      else {
        q = ownQuote(ctx, a.id);
        const st = qStatus(q, c);
        if (['accepted', 'cancelled'].includes(st)) fail(`This quote is ${QUOTE_LABELS[st].toLowerCase()} and can't be changed.`);
        if (a.contact) q.contact = cleanContact(a.contact);
        if (a.lines) q.lines = cleanQuoteLines(c, a.lines, { allowPast: true, keepPrice: true });
        if ('eventType' in a) q.eventType = EVENT_TYPES.includes(a.eventType) ? a.eventType : 'Other';
        if ('eventName' in a) q.eventName = str(a.eventName, 100);
        if ('notes' in a) q.notes = str(a.notes, 800);
        qlog(q, 'Edited', ctx.user.name);
      }
      if ('message' in a) q.message = str(a.message, 800);
      if ('validUntil' in a) { if (a.validUntil && !dateOk(a.validUntil)) fail('Choose a real date for "valid until".'); q.validUntil = a.validUntil || ''; }
      return quoteView(q, true);
    });
    def('dispatch.sendQuote', STAFF, true, (ctx, a) => {
      const c = ctx.company, q = ownQuote(ctx, a.id);
      const st = qStatus(q, c);
      if (['accepted', 'cancelled'].includes(st)) fail(`This quote is ${QUOTE_LABELS[st].toLowerCase()}.`);
      const miss = q.lines.findIndex((l) => !(l.unitPrice > 0));
      if (miss >= 0) fail(`Set a price for ride ${miss + 1} first.`);
      if (q.lines.some((l) => new Date(l.pickupAt).getTime() < now().getTime())) fail('One of the rides is in the past. Change its date first.');
      if (!q.validUntil || q.validUntil < todayIn(c)) q.validUntil = new Date(Date.parse(todayIn(c) + 'T12:00:00Z') + qcfg(c).validDays * 86400e3).toISOString().slice(0, 10);
      const resend = !!q.sentAt;
      q.status = 'sent'; q.sentAt = now().toISOString();
      const { total } = quoteTotals(q);
      const what = [q.eventType, q.eventName].filter(Boolean).join(': ') || 'your event';
      quoteSay(q, `${c.name}: your quote ${q.number} for ${what} is ready: $${money(total)}. Review and book: ${quoteUrl(q)}`,
        `${c.name}: here is your quote ${q.number} for ${what}. Total $${money(total)}${cardsOn(c) ? (atBooking(c) ? '. No deposit: you save a card when you book and the rides are charged then' : `. No deposit: you save a card when you book, and each ride is charged ${pcfg(c).chargeHours} hours before pickup`) : ''}. Valid until ${q.validUntil}.${q.message ? ` ${q.message}` : ''} Review and book online: ${quoteUrl(q)}`);
      qlog(q, resend ? 'Sent again' : 'Sent to the customer', ctx.user.name);
      return quoteView(q, true);
    });
    def('dispatch.quoteAction', STAFF, true, (ctx, a) => {
      const c = ctx.company, q = ownQuote(ctx, a.id), st = qStatus(q, c);
      if (a.action === 'cancel') {
        if (['accepted', 'cancelled'].includes(st)) fail('This quote is already closed.');
        q.status = 'cancelled'; q.decidedAt = now().toISOString(); qlog(q, 'Cancelled', ctx.user.name);
      } else if (a.action === 'reopen') {
        if (!['declined', 'expired', 'cancelled'].includes(st)) fail('Only declined, expired or cancelled quotes can be reopened.');
        q.status = 'new'; q.validUntil = ''; q.decidedAt = null; q.declineReason = ''; qlog(q, 'Reopened', ctx.user.name);
      } else if (a.action === 'accept') {
        if (!['new', 'sent', 'expired'].includes(st)) fail('This quote is closed.');
        const miss = q.lines.findIndex((l) => !(l.unitPrice > 0));
        if (miss >= 0) fail(`Set a price for ride ${miss + 1} first.`);
        bookQuote(q, ctx.user.name, null);
        qlog(q, `Booked by the office${cardsOn(c) ? '. The customer was sent a link to add a card' : ''}`, ctx.user.name);
      } else fail('Unknown action.');
      return quoteView(q, true);
    });

    def('dispatch.messages', STAFF, false, (ctx) => db.messages.filter((m) => m.companyId === ctx.company.id).slice(0, 150).map(hideLink));

    // ---- Two-way texting ------------------------------------------------------
    // Passengers (and drivers) can answer any text. Every company sends from the
    // platform's one Twilio number, so a reply goes to the company that last
    // texted that number, or else the one with that passenger's next ride. The
    // office reads and answers it in the Inbox.
    function phoneKey(s) {
      const d = String(s || '').replace(/\D/g, '');
      return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length >= 7 ? d : '';
    }
    const inboxOf = () => db.inbox || (db.inbox = []);
    const STOP_WORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|optout|revoke)$/i;
    const START_WORDS = /^(start|unstop|yes)$/i;
    const LIVE_STATUS = ['confirmed', 'assigned', 'accepted', 'en_route', 'arrived', 'on_board'];
    // The ride a conversation is most likely about: in progress or next, else the latest.
    function tripForPhone(companyId, key) {
      const mine = db.trips.filter((t) => t.companyId === companyId && phoneKey(t.passengerPhone) === key);
      const live = mine.filter((t) => LIVE_STATUS.includes(t.status)).sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
      return live[0] || mine.sort((a, b) => b.pickupAt.localeCompare(a.pickupAt))[0] || null;
    }
    function personForPhone(companyId, key) {
      const t = tripForPhone(companyId, key);
      const u = db.users.find((x) => x.companyId === companyId && x.active !== false && ['driver', 'customer'].includes(x.role) && phoneKey(x.phone) === key);
      if (u && u.role === 'driver') return { name: u.name, who: 'Driver', trip: null };
      return { name: (t && t.passengerName) || (u && u.name) || '', who: t || u ? 'Passenger' : '', trip: t };
    }
    function routeInbound(key) {
      const m = db.messages.find((x) => x.channel === 'sms' && x.companyId && phoneKey(x.recipient) === key);
      const ib = inboxOf().find((x) => x.companyId && x.key === key);
      const last = m && ib ? (m.at > ib.at ? m : ib) : m || ib;
      if (last && findCompany(last.companyId)) return last.companyId;
      const t = db.trips.filter((x) => phoneKey(x.passengerPhone) === key).sort((a, b) => (LIVE_STATUS.includes(b.status) - LIVE_STATUS.includes(a.status)) || b.pickupAt.localeCompare(a.pickupAt))[0];
      if (t) return t.companyId;
      const u = db.users.find((x) => x.companyId && x.active !== false && phoneKey(x.phone) === key);
      return u ? u.companyId : null;
    }
    const tripBrief = (t) => t ? { id: t.id, ref: t.ref, pickupAt: t.pickupAt, pickup: t.pickup, status: t.status } : null;
    function conversations(c) {
      const by = new Map();
      for (const x of inboxOf()) {
        if (x.companyId !== c.id || x.key === 'deleted') continue;
        const k = by.get(x.key) || { key: x.key, phone: '', last: null, unread: 0, count: 0 };
        if (!k.last) k.last = { body: x.body, at: x.at, dir: x.dir };
        if (!k.phone && x.phone) k.phone = x.phone;
        if (x.dir === 'in' && !x.read) k.unread++;
        k.count++;
        by.set(x.key, k);
      }
      return [...by.values()].map((k) => { const p = personForPhone(c.id, k.key); return { ...k, name: p.name, who: p.who, trip: tripBrief(p.trip) }; })
        .sort((a, b) => b.last.at.localeCompare(a.last.at));
    }
    const unreadTexts = (c) => inboxOf().filter((x) => x.companyId === c.id && x.dir === 'in' && !x.read && x.key !== 'deleted').length;
    // One conversation: what they texted, what the office answered, and the
    // automatic texts the system sent that number, oldest first.
    function threadView(c, key, tripId) {
      const p = personForPhone(c.id, key);
      const t = (tripId && db.trips.find((x) => x.id === tripId && x.companyId === c.id)) || p.trip;
      const mine = inboxOf().filter((x) => x.companyId === c.id && x.key === key);
      const linked = new Set(mine.map((x) => x.msgId).filter(Boolean));
      const auto = db.messages.filter((m) => m.companyId === c.id && m.channel === 'sms' && !linked.has(m.id) && phoneKey(m.recipient) === key)
        .map((m) => ({ id: m.id, dir: 'out', auto: true, body: hideLink(m).body, at: m.at, ref: m.ref, delivery: m.delivery || null }));
      const status = new Map(db.messages.filter((m) => linked.has(m.id)).map((m) => [m.id, m.delivery || null]));
      // Only the latest few automatic texts, for context. Both lists are newest
      // first; reversed, a tie on time keeps the order they happened.
      auto.length = Math.min(auto.length, 6); auto.reverse();
      const items = [...mine.slice().reverse().map((x) => ({ id: x.id, dir: x.dir, body: x.body, at: x.at, by: x.by || '', ref: x.ref || '', stop: !!x.stop, delivery: x.msgId ? status.get(x.msgId) || null : null })), ...auto]
        .sort((a, b) => a.at.localeCompare(b.at)).slice(-120);
      const phone = (mine.find((x) => x.phone) || {}).phone || (t && t.passengerPhone) || '';
      const texted = mine.some((x) => x.dir === 'in');
      return { key, phone, name: p.name || (t && t.passengerName) || '', who: p.who || (t ? 'Passenger' : ''), trip: tripBrief(t), items,
        optedOut: !!(db.smsOptOut || {})[key], noConsent: !texted && !!t && t.smsOk === false && phoneKey(t.passengerPhone) === key };
    }
    function threadKey(ctx, a) {
      if (a.tripId) {
        const t = ownTrip(ctx, str(a.tripId, 40));
        const key = phoneKey(t.passengerPhone);
        if (!key) fail('This ride has no passenger phone number.');
        return { key, tripId: t.id };
      }
      const key = phoneKey(a.key);
      if (!key) fail('Conversation not found.', 404);
      return { key, tripId: null };
    }
    def('dispatch.inbox', STAFF, false, (ctx) => ({ conversations: conversations(ctx.company).slice(0, 200), unread: unreadTexts(ctx.company), live: !!(opts.live && opts.live.sms) }));
    def('dispatch.inboxCount', STAFF, false, (ctx) => ({ unread: unreadTexts(ctx.company) }));
    // Opening a conversation marks it read.
    def('dispatch.inboxThread', STAFF, false, (ctx, a) => {
      const { key, tripId } = threadKey(ctx, a);
      for (const x of inboxOf()) if (x.companyId === ctx.company.id && x.key === key && x.dir === 'in' && !x.read) { x.read = true; x.readBy = ctx.user.name; ctx.dirty = true; }
      return threadView(ctx.company, key, tripId);
    });
    def('dispatch.inboxSend', STAFF, true, (ctx, a) => {
      const c = ctx.company;
      const { key, tripId } = threadKey(ctx, a);
      const text = str(a.body, 600).trim();
      if (!text) fail('Type a message first.');
      const th = threadView(c, key, tripId);
      if (th.optedOut) fail('They texted STOP, so texts to this number are off until they text START. Call or email them instead.');
      if (th.noConsent) fail("This passenger didn't agree to texts when they booked. Call or email them instead.");
      if (!th.phone) fail('No phone number for this conversation.');
      const t = th.trip && db.trips.find((x) => x.id === th.trip.id);
      // One number serves every company, so each text says who it's from.
      const body = text.toLowerCase().startsWith(c.name.toLowerCase()) ? text : `${c.name}: ${text}`;
      const at = now().toISOString();
      const msgId = id('msg');
      db.messages.unshift({ id: msgId, companyId: c.id, tripId: t ? t.id : null, ref: t ? t.ref : 'Inbox', at, recipient: th.phone, channel: 'sms', body, kind: 'chat', reply: true });
      if (db.messages.length > 600) db.messages.length = 600;
      inboxOf().unshift({ id: id('sms'), companyId: c.id, key, phone: th.phone, dir: 'out', body, at, by: ctx.user.name, tripId: t ? t.id : null, ref: t ? t.ref : '', msgId });
      for (const x of inboxOf()) if (x.companyId === c.id && x.key === key && x.dir === 'in' && !x.read) x.read = true;
      if (db.inbox.length > 3000) db.inbox.length = 3000;
      meterTexts();
      return threadView(c, key, tripId);
    });
    // A text that came in (from the server's Twilio webhook, or the sample data).
    function takeInbound({ from, body, sid, media, at }) {
      const key = phoneKey(from);
      if (!key) return { ok: false };
      if (sid && inboxOf().some((x) => x.sid === sid)) return { ok: true, duplicate: true };
      const words = String(body || '').trim();
      const stop = STOP_WORDS.test(words), start = START_WORDS.test(words);
      db.smsOptOut = db.smsOptOut || {};
      if (stop) db.smsOptOut[key] = now().toISOString();
      if (start) delete db.smsOptOut[key];
      const companyId = routeInbound(key);
      const p = companyId ? personForPhone(companyId, key) : { trip: null };
      inboxOf().unshift({ id: id('sms'), companyId, key, phone: str(from, 30), dir: 'in', body: str(words, 1600) + (media ? `${words ? ' ' : ''}[${media === 1 ? 'a picture' : media + ' pictures'}]` : ''), at: at || now().toISOString(), read: false,
        tripId: p.trip ? p.trip.id : null, ref: p.trip ? p.trip.ref : '', sid: str(sid, 64), ...(stop ? { stop: true } : {}), ...(start ? { start: true } : {}) });
      if (db.inbox.length > 3000) db.inbox.length = 3000;
      return { ok: true, routed: !!companyId };
    }

    // ---- Text allowance -----------------------------------------------------
    // Each company gets textPlan().included texts a month (the owner can set a
    // different number per company). Bought packs top it up and never expire.
    // A text over 160 characters counts as several, the way carriers bill it.
    const textPlan = () => { const t = db.textPlan || {}; return { ...DEFAULT_TEXTS, ...t, plans: { ...DEFAULT_TEXTS.plans, ...(t.plans || {}) } }; };
    const textsIncluded = (c) => { if (c.textsIncluded != null) return c.textsIncluded; const tp = textPlan(); return tp.plans[c.plan] != null ? tp.plans[c.plan] : tp.included; };
    const segments = (body) => { const n = String(body || '').length; return n <= 160 ? 1 : Math.ceil(n / 153); };
    function texts(c) {
      const m = monthKey(now());
      if (!c.texts) c.texts = { month: m, used: 0, fromPacks: 0, credits: 0, held: 0, autoTopUp: false, packs: [], past: [], warned: '' };
      const x = c.texts;
      if (x.month !== m) {
        x.past = [{ month: x.month, used: x.used, held: x.held || 0 }, ...(x.past || [])].slice(0, 12);
        Object.assign(x, { month: m, used: 0, fromPacks: 0, held: 0, warned: '' });
      }
      return x;
    }
    const textsLeft = (c) => { const x = texts(c); return Math.max(0, textsIncluded(c) - (x.used - x.fromPacks)) + x.credits; };
    function buyTexts(c, packs, by, auto, free) {
      const x = texts(c), tp = textPlan(), n = packs * tp.packSize;
      x.credits += n;
      x.packs = [{ id: id('txp'), at: now().toISOString(), texts: n, price: free ? 0 : round2(packs * tp.packPrice), by: by || '', auto: !!auto, free: !!free, invoiceId: null }, ...(x.packs || [])].slice(0, 50);
      x.warned = '';
      return x.packs[0];
    }
    function spendTexts(c, n) {
      const x = texts(c), inc = textsIncluded(c);
      if (textsLeft(c) < n && x.autoTopUp) {
        const p = buyTexts(c, Math.max(1, Math.ceil((n - textsLeft(c)) / textPlan().packSize)), 'Automatic top-up', true);
        companyEmail(c, `${c.name}: you ran out of texts this month, so we added ${p.texts} more for $${money(p.price)}. It goes on your next monthly invoice. Turn automatic top-up off in Texts & emails.`);
      }
      if (textsLeft(c) < n) return false;
      for (let i = 0; i < n; i++) { if (x.used - x.fromPacks < inc) x.used++; else { x.credits--; x.fromPacks++; x.used++; } }
      return true;
    }
    function companyEmail(c, body) {
      const admin = db.users.find((u) => u.companyId === c.id && u.role === 'admin' && u.active !== false);
      db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: null, ref: 'Texts', at: now().toISOString(), recipient: c.email || (admin && admin.email) || 'Company admin', channel: 'email', body, kind: 'texts', metered: true });
    }
    // Runs before every save: counts new texts against the allowance. When a
    // company is out, a passenger text goes by email instead (or is held when
    // the passenger already got the same message by email, or has no email).
    function meterTexts() {
      const touched = new Set();
      for (let i = db.messages.length - 1; i >= 0; i--) {
        const m = db.messages[i];
        if (m.metered) continue;
        m.metered = true;
        if (m.channel !== 'sms') continue;
        const c = findCompany(m.companyId);
        if (!c) continue;
        // No text consent from the passenger: email instead, or don't send.
        // A reply to someone who texted in is fine; a number that texted STOP is not.
        const tc = m.tripId && db.trips.find((x) => x.id === m.tripId);
        const stopped = (db.smsOptOut || {})[phoneKey(m.recipient)];
        if ((tc && tc.smsOk === false && m.recipient === tc.passengerPhone && !m.reply) || stopped) {
          const em = tc && m.recipient === tc.passengerPhone ? tc.passengerEmail : '';
          const dup = em && db.messages.some((o) => o !== m && o.channel === 'email' && o.recipient === em && o.tripId === m.tripId && Math.abs(new Date(o.at) - new Date(m.at)) < 60e3);
          if (em && !dup) { m.channel = 'email'; m.recipient = em; m.noTexts = 'email'; }
          else { m.noTexts = dup ? 'emailed' : 'held'; m.delivery = { status: 'optout', error: stopped ? 'They texted STOP, so texts to this number are off.' : dup ? 'No text consent. The same message went by email.' : 'No text consent from the passenger. Not sent.' }; }
          continue;
        }
        touched.add(c);
        const n = segments(m.body);
        if (spendTexts(c, n)) { m.texts = n; continue; }
        texts(c).held = (texts(c).held || 0) + 1;
        const t = m.tripId && db.trips.find((x) => x.id === m.tripId);
        const q = m.quoteId && db.quotes.find((x) => x.id === m.quoteId);
        const email = t && m.recipient === t.passengerPhone ? t.passengerEmail : q && q.contact ? q.contact.email : '';
        const twin = email && db.messages.some((o) => o !== m && o.channel === 'email' && o.recipient === email && (o.tripId || o.quoteId) === (m.tripId || m.quoteId) && Math.abs(new Date(o.at) - new Date(m.at)) < 60e3);
        if (email && !twin) { m.channel = 'email'; m.recipient = email; m.outOfTexts = 'email'; }
        else { m.outOfTexts = twin ? 'emailed' : 'held'; m.delivery = { status: 'held', error: twin ? 'Out of texts. The same message went by email.' : 'Out of texts. Not sent.' }; }
      }
      for (const c of touched) {
        const x = texts(c), inc = textsIncluded(c), left = textsLeft(c), tp = textPlan();
        const buy = `Buy more in Texts & emails: ${tp.packSize} texts for $${money(tp.packPrice)}.`;
        if (left <= 0 && !x.warned.includes('out')) {
          x.warned += ' out';
          companyEmail(c, `${c.name}: you're out of texts for ${x.month}. Until you buy more, passenger messages go by email and texts to drivers and passengers without an email are held. ${buy}`);
        } else if (left > 0 && inc > 0 && left <= inc * (100 - tp.warnPct) / 100 && !x.warned.includes('low')) {
          x.warned += ' low';
          companyEmail(c, `${c.name}: you've used ${x.used} texts this month and have ${left} left. ${buy}`);
        }
      }
    }
    function textStatus(c) {
      const x = texts(c), tp = textPlan(), inc = textsIncluded(c), left = textsLeft(c);
      return {
        month: x.month, included: inc, used: x.used, fromPacks: x.fromPacks, credits: x.credits, left, held: x.held || 0,
        pct: inc ? Math.min(100, Math.round(((x.used - x.fromPacks) / inc) * 100)) : 100,
        low: left > 0 && left <= inc * (100 - tp.warnPct) / 100, out: left <= 0,
        autoTopUp: !!x.autoTopUp, packSize: tp.packSize, packPrice: tp.packPrice, packs: (x.packs || []).slice(0, 12), past: x.past || [],
      };
    }
    def('dispatch.texts', STAFF, false, (ctx) => ({ ...textStatus(ctx.company), planInfo: planInfo(ctx.company) }));
    def('dispatch.buyTexts', ['admin'], true, (ctx, a) => {
      const packs = Math.round(num(a.packs, 1));
      if (packs < 1 || packs > 20) fail('Choose between 1 and 20 packs.');
      buyTexts(ctx.company, packs, ctx.user.name);
      return textStatus(ctx.company);
    });
    def('dispatch.saveTexts', ['admin'], true, (ctx, a) => { texts(ctx.company).autoTopUp = !!a.autoTopUp; return textStatus(ctx.company); });

    // ---- Company network: farm-out and farm-in ------------------------------
    // A company sends a trip it can't cover to another member company at an
    // agreed rate. The partner accepts or declines; once accepted the partner
    // gets its own copy of the trip and dispatches it, and status, chauffeur and
    // vehicle flow back to the sender's trip, which keeps its customer and price.
    const FARM_LABELS = { offered: 'Waiting for answer', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', returned: 'Handed back', expired: 'Expired', completed: 'Completed' };
    const isMember = (c) => c && c.status === 'active' && c.network && c.network.joined;
    function notWithPartner(t) {
      if (t.farmout) fail(`This trip is with ${t.farmout.toName}. Take it back from them first.`);
    }
    function netNote(fromCompany, toCompany, text, farmoutId, by) {
      db.netMessages.push({ id: id('nm'), fromCompanyId: fromCompany.id, toCompanyId: toCompany.id, farmoutId: farmoutId || null, text, by: by || '', system: !by, at: now().toISOString() });
      if (db.netMessages.length > 2000) db.netMessages.splice(0, db.netMessages.length - 2000);
    }
    function setFarm(f, status, by, note) {
      f.status = status; f.updatedAt = now().toISOString();
      const parent = db.trips.find((t) => t.id === f.tripId);
      if (parent) {
        if (['offered', 'accepted'].includes(status)) parent.farmout = { id: f.id, toCompanyId: f.toCompanyId, toName: f.toName, status, rate: f.rate, auto: !!f.auto };
        else if (status === 'completed') parent.farmout = { id: f.id, toCompanyId: f.toCompanyId, toName: f.toName, status, rate: f.rate, done: true };
        else { parent.farmout = null; parent.affiliate = null; }
        log(parent, 'farm_' + status, by, note || f.toName);
      }
    }
    // Copies the partner's progress back to the sender. Runs after every change.
    function syncFarmouts() {
      if (!db.farmouts || !db.farmouts.length) return;
      const n = now().toISOString();
      for (const f of db.farmouts) {
        const parent = db.trips.find((t) => t.id === f.tripId);
        if (f.status === 'offered') {
          if (!parent || parent.status === 'cancelled') { setFarm(f, 'cancelled', 'System', 'Trip cancelled'); continue; }
          if (parent.pickupAt < n) { setFarm(f, 'expired', 'System'); netNote(findCompany(f.toCompanyId), findCompany(f.fromCompanyId), `Offer for ${f.ref} expired before anyone answered.`, f.id); }
          continue;
        }
        if (f.status !== 'accepted') continue;
        const child = db.trips.find((t) => t.id === f.childTripId);
        if (!parent || !child) continue;
        const from = findCompany(f.fromCompanyId), to = findCompany(f.toCompanyId);
        if (parent.status === 'cancelled' && child.status !== 'cancelled') {
          if (child.status !== 'completed') { child.status = 'cancelled'; log(child, 'cancelled', from.name, 'Cancelled by the sending company'); }
          setFarm(f, 'cancelled', from.name, 'Trip cancelled');
          netNote(from, to, `${from.name} cancelled ${f.ref} (your ${child.ref}).`, f.id);
          continue;
        }
        if (child.status === 'cancelled' && child.noShow) {
          // The partner's driver went and the passenger didn't show: the
          // partner is still owed, and the sending company closes its trip.
          if (parent.status !== 'cancelled') {
            parent.status = 'cancelled';
            const pct = pcfg(from).noShowFeePct;
            parent.noShow = { ...clone(child.noShow), by: `${child.noShow.by} (${to.name})`, fee: pct > 0 ? round2(parent.price.total * pct / 100) : 0 };
            log(parent, 'no_show', parent.noShow.by, child.noShow.waitedMin ? `Waited ${child.noShow.waitedMin} min` : '');
            notify(parent, 'no_show');
          }
          f.completedAt = n; setFarm(f, 'completed', to.name);
          netNote(to, from, `${f.ref}: passenger was a no-show. $${money(f.rate)} owed to ${to.name}.`, f.id);
          continue;
        }
        if (child.status === 'cancelled') {
          setFarm(f, 'returned', to.name);
          parent.status = parent.driverId ? parent.status : 'confirmed';
          netNote(to, from, `${to.name} handed ${f.ref} back.`, f.id);
          continue;
        }
        const d = child.driverId && findUser(child.driverId);
        const v = child.vehicleId && findVehicle(child.vehicleId);
        parent.affiliate = { companyId: to.id, companyName: to.name, companyPhone: to.phone, ref: child.ref, driver: d ? { name: d.name, phone: d.phone, photo: d.photo || '' } : null, vehicle: v ? { name: v.name, type: v.type, plate: v.plate, capacity: v.capacity, color: v.color || '', year: v.year || null } : null };
        if (child.pickupAt !== parent.pickupAt && child.flight && child.flight === parent.flight) { /* both follow the same flight */ }
        if (child.tracking) { parent.tracking = clone(child.tracking); if (!parent.trackToken) parent.trackToken = randomId(6); }
        if (child.status !== parent.status && child.status !== 'confirmed') {
          parent.status = child.status;
          log(parent, child.status, d ? `${d.name} (${to.name})` : to.name);
          if (['accepted', 'en_route', 'arrived', 'completed'].includes(child.status)) notify(parent, child.status);
        } else if (child.status === 'confirmed' && parent.status !== 'confirmed') { parent.status = 'confirmed'; }
        if (child.status === 'completed') { f.completedAt = n; setFarm(f, 'completed', to.name); netNote(to, from, `${f.ref} completed by ${to.name}. $${money(f.rate)} owed to ${to.name}.`, f.id); }
      }
    }
    function farmRow(f, me) {
      const parent = db.trips.find((t) => t.id === f.tripId);
      const child = f.childTripId && db.trips.find((t) => t.id === f.childTripId);
      const sent = f.fromCompanyId === me.id;
      const view = parent ? {
        pickupAt: parent.pickupAt, pickup: parent.pickup, dropoff: parent.dropoff, service: parent.service, serviceLabel: SERVICES[parent.service], hours: parent.hours,
        vehicleType: parent.vehicleType, passengers: parent.passengers, flight: parent.flight, childSeats: parent.childSeats, meetGreet: parent.meetGreet, stops: parent.stops, stopList: parent.stopList ? parent.stopList.slice() : undefined, stopWaits: parent.stopWaits ? parent.stopWaits.slice() : undefined, bags: parent.bags || 0, signName: parent.signName || '', prefs: parent.prefs ? clone(parent.prefs) : undefined,
        passengerName: parent.passengerName, notes: parent.notes, status: sent ? parent.status : (child ? child.status : null),
      } : null;
      const out = {
        id: f.id, direction: sent ? 'sent' : 'incoming', auto: !!f.auto, status: f.status, statusLabel: FARM_LABELS[f.status], rate: f.rate, note: f.note, reason: f.reason || '',
        partnerId: sent ? f.toCompanyId : f.fromCompanyId, partnerName: sent ? f.toName : f.fromName,
        ref: f.ref, childRef: child ? child.ref : null, tripId: sent ? f.tripId : (child ? child.id : null),
        createdAt: f.createdAt, updatedAt: f.updatedAt, completedAt: f.completedAt || null, settledAt: f.settledAt || null, trip: view,
      };
      if (sent && parent) { out.price = parent.price.total; out.margin = round2(parent.price.total - f.rate); out.affiliate = clone(parent.affiliate || null); }
      return out;
    }
    function memberCard(c, me) {
      const vehicles = db.vehicles.filter((v) => v.companyId === c.id && v.status === 'active');
      const types = {};
      for (const v of vehicles) { const x = types[v.type] || (types[v.type] = { type: v.type, count: 0, capacity: 0 }); x.count++; x.capacity = Math.max(x.capacity, v.capacity); }
      const between = db.farmouts.filter((f) => (f.fromCompanyId === me.id && f.toCompanyId === c.id) || (f.toCompanyId === me.id && f.fromCompanyId === c.id));
      const done = between.filter((f) => f.status === 'completed');
      const offeredTo = db.farmouts.filter((f) => f.toCompanyId === c.id && f.status !== 'cancelled');
      const answered = offeredTo.filter((f) => ['accepted', 'completed', 'declined', 'returned'].includes(f.status));
      return {
        id: c.id, name: c.name, color: c.color, phone: c.phone, email: c.email, areas: c.network.areas, about: c.network.about,
        region: REGION_CITY[regionOf(c)], timezone: c.timezone, vehicleTypes: VEHICLE_TYPES.filter((t) => types[t]).map((t) => types[t]), drivers: db.users.filter((u) => u.companyId === c.id && u.role === 'driver' && u.active !== false).length,
        sentToThem: done.filter((f) => f.fromCompanyId === me.id).length, gotFromThem: done.filter((f) => f.toCompanyId === me.id).length,
        acceptRate: answered.length ? Math.round(answered.filter((f) => ['accepted', 'completed'].includes(f.status)).length / answered.length * 100) : null,
      };
    }
    function balances(me) {
      const by = {};
      for (const f of db.farmouts) {
        if (f.status !== 'completed' || f.settledAt) continue;
        if (f.fromCompanyId === me.id) { const b = by[f.toCompanyId] || (by[f.toCompanyId] = { partnerId: f.toCompanyId, partnerName: f.toName, youOwe: 0, owedToYou: 0, trips: 0 }); b.youOwe = round2(b.youOwe + f.rate); b.trips++; }
        if (f.toCompanyId === me.id) { const b = by[f.fromCompanyId] || (by[f.fromCompanyId] = { partnerId: f.fromCompanyId, partnerName: f.fromName, youOwe: 0, owedToYou: 0, trips: 0 }); b.owedToYou = round2(b.owedToYou + f.rate); b.trips++; }
      }
      return Object.values(by).map((b) => ({ ...b, net: round2(b.owedToYou - b.youOwe) }));
    }
    const unreadFrom = (me) => {
      const read = (me.network && me.network.read) || {};
      const out = {};
      for (const m of db.netMessages) if (m.toCompanyId === me.id && m.at > (read[m.fromCompanyId] || '')) out[m.fromCompanyId] = (out[m.fromCompanyId] || 0) + 1;
      return out;
    };

    def('network.overview', STAFF, false, (ctx) => {
      const me = ctx.company;
      const members = db.companies.filter((c) => c.id !== me.id && isMember(c)).map((c) => memberCard(c, me));
      const rows = db.farmouts.filter((f) => f.fromCompanyId === me.id || f.toCompanyId === me.id)
        .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)).map((f) => farmRow(f, me));
      const unread = unreadFrom(me);
      for (const f of db.farmouts) if (f.fromCompanyId === me.id && f.status === 'returned' && !f.seenReturn) { f.seenReturn = true; ctx.dirty = true; }
      return {
        me: { joined: !!me.network.joined, areas: me.network.areas, about: me.network.about, region: REGION_CITY[regionOf(me)] },
        auto: { ...acfg(me), order: autoPartners(me).map((c) => c.id) },
        members, sent: rows.filter((r) => r.direction === 'sent'), incoming: rows.filter((r) => r.direction === 'incoming'),
        balances: balances(me), unread, unreadTotal: Object.values(unread).reduce((s, x) => s + x, 0),
        waiting: rows.filter((r) => r.direction === 'incoming' && r.status === 'offered').length,
      };
    });
    def('network.saveSettings', ['admin'], true, (ctx, a) => {
      const n = ctx.company.network;
      if ('joined' in a) n.joined = a.joined === true || a.joined === 'true' || a.joined === 'on';
      if ('areas' in a) n.areas = str(a.areas, 200);
      if ('about' in a) n.about = str(a.about, 400);
      return { joined: n.joined, areas: n.areas, about: n.about };
    });
    def('network.saveAuto', ['admin'], true, (ctx, a) => {
      const cur = acfg(ctx.company);
      const bool = (k) => (k in a ? a[k] === true || a[k] === 'true' || a[k] === 'on' : cur[k]);
      const whole = (k, lo, hi) => (k in a ? Math.min(hi, Math.max(lo, Math.round(num(a[k], cur[k])))) : cur[k]);
      const partners = Array.isArray(a.partners) ? [...new Set(a.partners.map(String))].filter((pid) => { const c = findCompany(pid); return c && c.id !== ctx.company.id && isMember(c); }) : cur.partners;
      const next = { on: bool('on'), noDriver: bool('noDriver'), lastCallHours: whole('lastCallHours', 0, 48), ratePct: Math.round(('ratePct' in a ? Math.min(100, Math.max(10, num(a.ratePct, cur.ratePct))) : cur.ratePct) * 2) / 2, answerMin: whole('answerMin', 5, 240), partners };
      if (next.on && !ctx.company.network.joined) fail('Join the network first, under Network settings.');
      if (next.on && Array.isArray(a.partners) && !partners.length) fail('Pick at least one partner to send trips to.');
      if (next.on && !next.noDriver && !next.lastCallHours) fail('Choose when trips should be sent: when no driver is free, or a set time before pickup.');
      ctx.company.network.auto = next;
      // New settings get another try at trips every partner had passed on.
      for (const t of db.trips) if (t.companyId === ctx.company.id && t.autoFarm && t.autoFarm.exhausted && !t.autoFarm.stopped) { t.autoFarm.exhausted = false; t.autoFarm.tried = []; }
      if (next.on) sweepAutoFarm(ctx.company);
      return { ...acfg(ctx.company), order: autoPartners(ctx.company).map((c) => c.id) };
    });
    def('network.offer', STAFF, true, (ctx, a) => {
      const me = ctx.company;
      if (!me.network.joined) fail('Join the network first, under Network settings.');
      const t = ownTrip(ctx, a.tripId);
      if (t.farmIn) fail('This trip came from a partner. Hand it back to them instead of passing it on.');
      if (t.farmout) fail(`This trip is already with ${t.farmout.toName}.`);
      if (!['confirmed', 'assigned'].includes(t.status)) fail('Only trips that have not started can go to a partner.');
      if (t.pickupAt < now().toISOString()) fail('This pickup time has passed.');
      const to = findCompany(a.toCompanyId);
      if (!to || to.id === me.id || !isMember(to)) fail('Choose a partner company from the network.');
      const rate = round2(num(a.rate, 0));
      if (!(rate > 0)) fail('Enter the amount you will pay the partner.');
      if (t.driverId) { t.driverId = null; t.vehicleId = null; t.status = 'confirmed'; log(t, 'unassigned', ctx.user.name); }
      // Sending by hand ends any automatic farm-out on this trip.
      if (t.autoFarm) t.autoFarm.stopped = true;
      return farmRow(makeOffer(me, t, to, rate, str(a.note, 300), ctx.user.name), me);
    });
    function makeOffer(me, t, to, rate, note, by, auto) {
      const f = { id: id('farm'), fromCompanyId: me.id, fromName: me.name, toCompanyId: to.id, toName: to.name, tripId: t.id, ref: t.ref, childTripId: null, rate, note, status: 'offered', createdAt: now().toISOString(), by, auto: !!auto };
      db.farmouts.push(f);
      setFarm(f, 'offered', by, `${auto ? 'Sent automatically to' : 'Offered to'} ${to.name} for $${money(rate)}`);
      netNote(me, to, `New trip offer ${t.ref}: ${fmtLocal(t.pickupAt, to, true)}, ${t.vehicleType}, ${t.passengers} pax, from ${t.pickup}. Pays $${money(rate)}.`, f.id);
      db.messages.unshift({ id: id('msg'), companyId: to.id, tripId: null, ref: t.ref, at: now().toISOString(), recipient: to.email || to.phone || 'Dispatch office', channel: 'email', body: `${me.name} offered you a trip on ${fmtLocal(t.pickupAt, to, true)} for $${money(rate)}. Open Network to accept or decline.` });
      return f;
    }
    // Does this partner run a vehicle of the trip's type that seats everyone, or
    // a bigger one (never a party bus unless that's what was booked)?
    const partnerFits = (c, t) => db.vehicles.some((v) => v.companyId === c.id && v.status === 'active' && v.capacity >= t.passengers
      && (v.type === t.vehicleType || (v.type !== 'Party Bus' && VEHICLE_TYPES.indexOf(v.type) > VEHICLE_TYPES.indexOf(t.vehicleType))));
    // The company's partner order for automatic farm-out: the chosen list, or
    // every network member in the same area when none is chosen yet.
    function autoPartners(c) {
      const cfg = acfg(c);
      const ids = cfg.partners.length ? cfg.partners : db.companies.filter((x) => x.id !== c.id && isMember(x) && regionOf(x) === regionOf(c)).map((x) => x.id);
      return ids.map(findCompany).filter((x) => x && x.id !== c.id && isMember(x));
    }
    // Runs in the dispatch sweep. Sends trips nobody on staff can cover to the
    // next partner in order, moves on when a partner declines or doesn't answer
    // in time, and flags the trip for the office when every partner has passed.
    function sweepAutoFarm(c) {
      const cfg = acfg(c);
      if (!cfg.on || !isMember(c)) return false;
      const n = now(), nowMs = n.getTime();
      let changed = false;
      for (const f of db.farmouts) {
        if (f.fromCompanyId !== c.id || !f.auto || f.status !== 'offered') continue;
        if (nowMs - new Date(f.createdAt).getTime() < cfg.answerMin * 60e3) continue;
        setFarm(f, 'expired', 'Auto farm-out', `No answer from ${f.toName} in ${cfg.answerMin} min`);
        netNote(c, findCompany(f.toCompanyId), `${c.name} withdrew the offer for ${f.ref}: no answer in ${cfg.answerMin} minutes.`, f.id);
        changed = true;
      }
      for (const t of db.trips) {
        if (t.companyId !== c.id || t.farmIn || t.farmout || t.driverId || t.outOfTown || t.status !== 'confirmed') continue;
        if (t.autoFarm && (t.autoFarm.stopped || t.autoFarm.exhausted)) continue;
        const pickMs = new Date(t.pickupAt).getTime();
        if (pickMs <= nowMs + 15 * 60e3) continue;
        const started = t.autoFarm && t.autoFarm.tried && t.autoFarm.tried.length;
        const noDriver = cfg.noDriver && t.needsDriver && !/office/i.test(t.needsDriver.why || '');
        const lastCall = cfg.lastCallHours > 0 && pickMs - nowMs <= cfg.lastCallHours * 3600e3;
        if (!started && !noDriver && !lastCall) continue;
        t.autoFarm = t.autoFarm || { tried: [], at: n.toISOString() };
        const next = autoPartners(c).find((p) => !t.autoFarm.tried.includes(p.id) && partnerFits(p, t));
        if (!next) {
          t.autoFarm.exhausted = true;
          t.needsDriver = { at: n.toISOString(), why: t.autoFarm.tried.length ? 'No partner took it' : `No partner runs a ${t.vehicleType} for ${t.passengers}` };
          log(t, 'auto_farm_none', 'Auto farm-out', t.needsDriver.why);
          changed = true;
          continue;
        }
        t.autoFarm.tried.push(next.id);
        const rate = Math.max(1, round2(t.price.total * cfg.ratePct / 100));
        makeOffer(c, t, next, rate, 'Sent automatically: no free car of our own.', 'Auto farm-out', true);
        t.needsDriver = null;
        changed = true;
      }
      return changed;
    }
    function ownFarm(ctx, fid, side) {
      const f = db.farmouts.find((x) => x.id === fid && (side === 'from' ? x.fromCompanyId : x.toCompanyId) === ctx.company.id);
      if (!f) fail('Offer not found.', 404);
      return f;
    }
    def('network.respond', STAFF, true, (ctx, a) => {
      const f = ownFarm(ctx, a.id, 'to');
      if (f.status !== 'offered') fail(`This offer is already ${FARM_LABELS[f.status].toLowerCase()}.`);
      const me = ctx.company, from = findCompany(f.fromCompanyId), parent = db.trips.find((t) => t.id === f.tripId);
      if (!a.accept) {
        f.reason = str(a.reason, 200);
        setFarm(f, 'declined', `${ctx.user.name} (${me.name})`, f.reason || '');
        netNote(me, from, `${me.name} declined ${f.ref}${f.reason ? ': ' + f.reason : '.'}`, f.id);
        return farmRow(f, me);
      }
      if (parent.status === 'cancelled') fail('The sending company cancelled this trip.');
      me.nextRef = (me.nextRef || 1000) + 1;
      const child = {
        ...clone(parent), id: id('trip'), ref: `${me.refPrefix}-${me.nextRef}`, companyId: me.id, customerId: null, passengerEmail: '',
        status: 'confirmed', driverId: null, vehicleId: null, rating: null, affiliate: null, farmout: null, autoFarm: null, outOfTown: null, landingId: null, landingOf: null, needsDriver: null,
        farmIn: { id: f.id, fromCompanyId: from.id, fromName: from.name, fromPhone: from.phone, fromRef: f.ref },
        waitMin: 0, tolls: 0, adjustment: null, priceOverride: f.rate, priceCtx: {},
        payment: { status: 'unpaid', method: null, paidAt: null }, source: 'partner', createdAt: now().toISOString(), history: [],
      };
      reprice(child);
      log(child, 'confirmed', `${ctx.user.name}`, `From ${from.name} (${f.ref})`);
      db.trips.push(child);
      f.childTripId = child.id;
      setFarm(f, 'accepted', `${ctx.user.name} (${me.name})`);
      netNote(me, from, `${me.name} accepted ${f.ref}. Their reference is ${child.ref}.`, f.id);
      return { ...farmRow(f, me), childTripId: child.id };
    });
    def('network.cancelOffer', STAFF, true, (ctx, a) => {
      const f = ownFarm(ctx, a.id, 'from');
      if (!['offered', 'accepted'].includes(f.status)) fail(`This offer is already ${FARM_LABELS[f.status].toLowerCase()}.`);
      const me = ctx.company, to = findCompany(f.toCompanyId);
      if (f.status === 'accepted') {
        const child = db.trips.find((t) => t.id === f.childTripId);
        if (child && ['on_board', 'completed'].includes(child.status)) fail('The partner has already picked up the passenger.');
        if (child && child.status !== 'cancelled') { child.status = 'cancelled'; log(child, 'cancelled', me.name, 'Taken back by the sending company'); }
      }
      const parent = db.trips.find((t) => t.id === f.tripId);
      if (parent && parent.autoFarm) parent.autoFarm.stopped = true;
      setFarm(f, 'cancelled', ctx.user.name, `Taken back from ${to.name}`);
      if (parent && parent.status !== 'cancelled') parent.status = 'confirmed';
      netNote(me, to, `${me.name} took back ${f.ref}. No need to cover it.`, f.id);
      return farmRow(f, me);
    });
    def('network.handBack', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.tripId);
      if (!t.farmIn) fail('This trip did not come from a partner.');
      if (['on_board', 'completed', 'cancelled'].includes(t.status)) fail('This trip can no longer be handed back.');
      t.status = 'cancelled'; t.driverId = null; t.vehicleId = null;
      log(t, 'cancelled', ctx.user.name, `Handed back to ${t.farmIn.fromName}${a.reason ? ': ' + str(a.reason, 200) : ''}`);
      const f = db.farmouts.find((x) => x.id === t.farmIn.id);
      if (f) f.reason = str(a.reason, 200);
      return tripView(t);
    });
    def('network.settle', STAFF, true, (ctx, a) => {
      const f = db.farmouts.find((x) => x.id === a.id && (x.fromCompanyId === ctx.company.id || x.toCompanyId === ctx.company.id));
      if (!f) fail('Offer not found.', 404);
      if (f.status !== 'completed') fail('Only completed trips can be settled.');
      f.settledAt = a.undo ? null : now().toISOString();
      const child = db.trips.find((t) => t.id === f.childTripId);
      if (child) child.payment = a.undo ? { status: 'unpaid', method: null, paidAt: null } : { status: 'paid', method: 'partner', paidAt: f.settledAt };
      return farmRow(f, ctx.company);
    });
    def('network.thread', STAFF, false, (ctx, a) => {
      const other = findCompany(a.companyId);
      if (!other || other.id === ctx.company.id) fail('Company not found.', 404);
      const me = ctx.company;
      const msgs = db.netMessages.filter((m) => (m.fromCompanyId === me.id && m.toCompanyId === other.id) || (m.fromCompanyId === other.id && m.toCompanyId === me.id)).slice(-200)
        .map((m) => ({ id: m.id, mine: m.fromCompanyId === me.id, text: m.text, by: m.by, system: !!m.system, at: m.at, farmoutId: m.farmoutId }));
      me.network.read = me.network.read || {};
      const last = msgs.length ? msgs[msgs.length - 1].at : '';
      if (last && me.network.read[other.id] !== last) { me.network.read[other.id] = last; ctx.dirty = true; }
      return { partner: { id: other.id, name: other.name, phone: other.phone, email: other.email, member: isMember(other) }, messages: msgs };
    });
    def('network.send', STAFF, true, (ctx, a) => {
      const other = findCompany(a.companyId);
      if (!other || other.id === ctx.company.id || !isMember(other)) fail('Choose a partner company from the network.');
      const text = str(a.text, 1000);
      if (!text) fail('Type a message.');
      netNote(ctx.company, other, text, null, `${ctx.user.name}`);
      ctx.company.network.read[other.id] = now().toISOString();
      return { ok: true };
    });
    def('network.partnersFor', STAFF, false, (ctx, a) => {
      const t = ownTrip(ctx, a.tripId);
      return db.companies.filter((c) => c.id !== ctx.company.id && isMember(c)).map((c) => memberCard(c, ctx.company))
        .map((m) => ({ ...m, fits: m.vehicleTypes.some((v) => v.type === t.vehicleType && v.capacity >= t.passengers) }))
        .sort((x, y) => (y.fits - x.fits) || (y.region === REGION_CITY[regionOf(ctx.company)]) - (x.region === REGION_CITY[regionOf(ctx.company)]));
    });

    // Flights
    def('dispatch.flights', STAFF, false, (ctx, a) => {
      const results = monitorFlights(ctx.company, !!a.force);
      if (results) ctx.dirty = true;
      const lo = now().getTime() - 6 * 3600e3;
      const trips = db.trips.filter((t) => t.companyId === ctx.company.id && t.flight && t.status !== 'cancelled' && new Date(t.pickupAt).getTime() >= lo)
        .sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).slice(0, 100).map(tripView);
      return { trips, settings: clone(ctx.company.flight), moved: results ? results.filter((r) => r.moved).map((r) => r.trip.ref) : [] };
    });
    def('dispatch.applyFlight', STAFF, true, (ctx, a) => {
      const t = ownTrip(ctx, a.id);
      if (!t.flightInfo || !t.flightInfo.suggestedPickup) fail('There is no new pickup time to apply.');
      if (!['confirmed', 'assigned', 'accepted', 'en_route'].includes(t.status)) fail('This trip is already under way.');
      t.pickupAt = t.flightInfo.suggestedPickup;
      log(t, 'pickup_moved', ctx.user.name, `Matched to flight ${t.flight}`);
      reprice(t);
      if (t.flightInfo.delayMin) notify(t, 'flight_moved', t.flightInfo);
      return tripView(t);
    });
    def('dispatch.saveFlightSettings', ['admin'], true, (ctx, a) => {
      ctx.company.flight.autoAdjust = !!a.autoAdjust;
      const m = Math.round(num(a.minDelay, 10));
      if (!(m >= 0 && m <= 180)) fail('Minimum delay must be between 0 and 180 minutes.');
      ctx.company.flight.minDelay = m;
      return clone(ctx.company.flight);
    });

    // Customers
    // Corporate accounts and invoices
    const ownAccount = (ctx, aid) => { const a = findAccount(ctx.company, aid); if (!a) fail('Account not found.', 404); return a; };
    const unbilled = (a) => db.trips.filter((t) => t.accountId === a.id && t.status === 'completed' && !t.invoiceId && t.payment.status !== 'paid');
    const invView = (inv) => {
      const overdueDays = inv.status === 'open' ? Math.floor((now().getTime() - new Date(inv.dueAt).getTime()) / 86400e3) : 0;
      return { ...clone(inv), overdue: overdueDays > 0, overdueDays: Math.max(0, overdueDays), accountName: (db.accounts.find((x) => x.id === inv.accountId) || {}).name || '' };
    };
    function accountSummary(a) {
      const ub = unbilled(a);
      const inv = db.clientInvoices.filter((i) => i.accountId === a.id && i.status !== 'void').map(invView);
      const open = inv.filter((i) => i.status === 'open');
      return {
        ...clone(a), bookers: db.users.filter((u) => u.accountId === a.id && u.role === 'customer').length,
        unbilledCount: ub.length, unbilledTotal: round2(ub.reduce((s, t) => s + t.price.total, 0)),
        openBalance: round2(open.reduce((s, i) => s + i.total, 0)), overdueBalance: round2(open.filter((i) => i.overdue).reduce((s, i) => s + i.total, 0)),
        upcoming: db.trips.filter((t) => t.accountId === a.id && busyStatus(t.status)).length,
      };
    }
    def('dispatch.accounts', STAFF, false, (ctx) => db.accounts.filter((a) => a.companyId === ctx.company.id).map(accountSummary).sort((x, y) => x.name.localeCompare(y.name)));
    def('dispatch.account', STAFF, false, (ctx, a) => {
      const acc = ownAccount(ctx, a.id);
      return {
        account: accountSummary(acc),
        bookers: db.users.filter((u) => u.accountId === acc.id && u.role === 'customer').map((u) => ({ ...pubUser(u), hasLogin: !!u.passHash })),
        unbilled: unbilled(acc).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).map(tripView),
        upcoming: db.trips.filter((t) => t.accountId === acc.id && busyStatus(t.status)).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).map(tripView),
        invoices: db.clientInvoices.filter((i) => i.accountId === acc.id).sort((x, y) => y.issuedAt.localeCompare(x.issuedAt)).map(invView),
      };
    });
    def('dispatch.saveAccount', STAFF, true, (ctx, a) => {
      const name = str(a.name, 80);
      if (!name) fail('Enter the company name.');
      const dup = db.accounts.find((x) => x.companyId === ctx.company.id && x.id !== a.id && x.name.toLowerCase() === name.toLowerCase());
      if (dup) fail(`There is already an account called ${dup.name}.`);
      const email = str(a.billingEmail, 120).toLowerCase();
      if (email && !emailOk(email)) fail('Enter a valid billing email.');
      const disc = num(a.discountPct, 0);
      if (!(disc >= 0 && disc <= 50)) fail('Discount must be between 0 and 50%.');
      const terms = Number(a.terms);
      const fields = { name, contact: str(a.contact, 80), billingEmail: email, phone: str(a.phone, 30), address: str(a.address, 200), terms: ACCOUNT_TERMS.includes(terms) ? terms : 30, discountPct: round2(disc), reward: a.reward === 'credit' ? 'credit' : 'discount', requirePo: !!a.requirePo && a.requirePo !== 'false', notes: str(a.notes, 400), active: a.active !== false && a.active !== 'false' };
      let acc;
      const was = a.id ? ownAccount(ctx, a.id).reward : null;
      // Credit counts from when it's switched on, not for rides already done.
      if (fields.reward === 'credit' && was !== 'credit') fields.rewardSince = now().toISOString();
      if (a.id) { acc = ownAccount(ctx, a.id); Object.assign(acc, fields); }
      else { acc = { id: id('acct'), companyId: ctx.company.id, createdAt: now().toISOString(), ...fields }; db.accounts.push(acc); }
      return accountSummary(acc);
    });
    def('dispatch.accountBooker', STAFF, true, async (ctx, a) => {
      const acc = ownAccount(ctx, a.accountId);
      if (a.remove) {
        const u = db.users.find((x) => x.id === a.remove && x.accountId === acc.id);
        if (u) delete u.accountId;
        return true;
      }
      const email = str(a.email, 120).toLowerCase();
      if (!emailOk(email)) fail("Enter the booker's email.");
      let u = db.users.find((x) => x.companyId === ctx.company.id && x.email === email);
      if (u && u.role !== 'customer') fail('That email belongs to a staff login.');
      if (!u) {
        // A customer record without a password; they can create a login on the booking page with this email.
        u = { id: id('usr'), role: 'customer', companyId: ctx.company.id, email, name: str(a.name, 80) || email.split('@')[0], phone: str(a.phone, 30), active: true, createdAt: now().toISOString() };
        db.users.push(u);
      }
      const other = u.accountId && u.accountId !== acc.id && db.accounts.find((x) => x.id === u.accountId);
      if (other) fail(`${u.name} already books for ${other.name}. Remove them there first.`);
      u.accountId = acc.id;
      return pubUser(u);
    });
    def('dispatch.createInvoice', STAFF, true, (ctx, a) => {
      const acc = ownAccount(ctx, a.accountId);
      const through = dateOk(a.through) ? a.through : localParts(now().toISOString(), ctx.company.timezone).date;
      const trips = unbilled(acc).filter((t) => localParts(t.pickupAt, ctx.company.timezone).date <= through).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
      if (!trips.length) fail(`No completed trips to invoice for ${acc.name} up to that date.`);
      ctx.company.nextInvoice = (ctx.company.nextInvoice || 0) + 1;
      const issued = now();
      const lines = trips.map((t) => ({ tripId: t.id, ref: t.ref, date: t.pickupAt, passenger: t.passengerName, route: t.dropoff ? `${t.pickup} to ${t.dropoff}` : `${t.pickup} (${t.hours} h)`, vehicle: t.vehicleType, po: t.poNumber || '', costCenter: t.costCenter || '', amount: t.price.total }));
      const inv = {
        id: id('cinv'), companyId: ctx.company.id, accountId: acc.id, number: `${ctx.company.refPrefix}-INV-${String(ctx.company.nextInvoice).padStart(4, '0')}`,
        from: lines[0].date, through, lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)), terms: acc.terms,
        issuedAt: issued.toISOString(), dueAt: new Date(issued.getTime() + acc.terms * 86400e3).toISOString(), status: 'open', paidAt: null, sentTo: '', sentAt: null, by: ctx.user.name,
      };
      db.clientInvoices.push(inv);
      for (const t of trips) { t.invoiceId = inv.id; t.payment = { status: 'unpaid', method: 'account', paidAt: null }; }
      if (a.send !== false) sendInvoice(ctx.company, acc, inv);
      return invView(inv);
    });
    function sendInvoice(c, acc, inv) {
      const to = acc.billingEmail || (db.users.find((u) => u.accountId === acc.id) || {}).email;
      if (!to) return false;
      const due = inv.terms ? `due ${fmtLocal(inv.dueAt, c, true).replace(/,? \d+:\d+.*$/, '')}` : 'due on receipt';
      db.messages.unshift({ id: id('msg'), companyId: c.id, tripId: null, ref: inv.number, at: now().toISOString(), recipient: to, channel: 'email', kind: 'invoice',
        body: `${c.name}: invoice ${inv.number} for ${acc.name}, ${inv.lines.length} trip${inv.lines.length === 1 ? '' : 's'}, total $${money(inv.total)}, ${due}. The itemized invoice is attached.${c.phone ? ` Questions? Call ${c.phone}.` : ''}` });
      inv.sentTo = to; inv.sentAt = now().toISOString();
      return true;
    }
    def('dispatch.invoices', STAFF, false, (ctx) => db.clientInvoices.filter((i) => i.companyId === ctx.company.id).sort((x, y) => y.issuedAt.localeCompare(x.issuedAt)).map(invView));
    def('dispatch.invoice', STAFF, false, (ctx, a) => {
      const inv = db.clientInvoices.find((i) => i.id === a.id && i.companyId === ctx.company.id);
      if (!inv) fail('Invoice not found.', 404);
      const acc = db.accounts.find((x) => x.id === inv.accountId);
      return { invoice: invView(inv), account: clone(acc), company: { ...pubCompany(ctx.company), address: ctx.company.address || '' } };
    });
    def('dispatch.invoiceAction', STAFF, true, (ctx, a) => {
      const inv = db.clientInvoices.find((i) => i.id === a.id && i.companyId === ctx.company.id);
      if (!inv) fail('Invoice not found.', 404);
      const acc = db.accounts.find((x) => x.id === inv.accountId);
      const trips = db.trips.filter((t) => t.invoiceId === inv.id);
      if (a.action === 'paid') {
        if (inv.status !== 'open') fail('Only open invoices can be marked paid.');
        inv.status = 'paid'; inv.paidAt = now().toISOString(); inv.paidMethod = ['check', 'ach', 'card', 'wire'].includes(a.method) ? a.method : 'check';
        for (const t of trips) t.payment = { status: 'paid', method: 'invoice', paidAt: inv.paidAt };
      } else if (a.action === 'unpaid') {
        if (inv.status !== 'paid') fail('This invoice is not marked paid.');
        inv.status = 'open'; inv.paidAt = null;
        for (const t of trips) t.payment = { status: 'unpaid', method: 'account', paidAt: null };
      } else if (a.action === 'void') {
        if (inv.status === 'paid') fail('Mark it unpaid before voiding.');
        inv.status = 'void'; inv.voidedAt = now().toISOString();
        for (const t of trips) { t.invoiceId = null; t.payment = { status: 'unpaid', method: 'account', paidAt: null }; }
      } else if (a.action === 'send') {
        if (inv.status === 'void') fail('This invoice is void.');
        if (!sendInvoice(ctx.company, acc, inv)) fail(`${acc.name} has no billing email. Add one to the account.`);
      } else fail('Unknown action.');
      return invView(inv);
    });

    def('dispatch.customers', STAFF, false, (ctx) => db.users.filter((u) => u.companyId === ctx.company.id && u.role === 'customer').map((u) => {
      const trips = db.trips.filter((t) => t.customerId === u.id);
      const done = trips.filter((t) => t.status === 'completed');
      const acc = u.accountId && db.accounts.find((x) => x.id === u.accountId);
      return { ...pubUser(u), hasLogin: !!u.passHash, discountPct: u.discountPct || 0, accountId: u.accountId || '', account: acc ? acc.name : '', notes: u.notes || '', trips: trips.length, spend: round2(done.reduce((s, t) => s + t.price.total, 0)), lastTrip: trips.map((t) => t.pickupAt).sort().pop() || null };
    }));
    def('dispatch.saveCustomer', STAFF, true, (ctx, a) => {
      const u = db.users.find((x) => x.id === a.id && x.companyId === ctx.company.id && x.role === 'customer');
      if (!u) fail('Customer not found.', 404);
      const d = num(a.discountPct, 0);
      if (!(d >= 0 && d <= 50)) fail('Account discount must be between 0 and 50%.');
      u.discountPct = round2(d); u.notes = str(a.notes, 300);
      if ('accountId' in a) { if (a.accountId) { ownAccount(ctx, a.accountId); u.accountId = a.accountId; } else delete u.accountId; }
      if (str(a.phone)) u.phone = str(a.phone, 30);
      return pubUser(u);
    });

    // Drivers
    const driverFull = (u) => ({
      ...pubUser(u), licenseNumber: u.licenseNumber || '', licenseExp: u.licenseExp || '', permitExp: u.permitExp || '', hireDate: u.hireDate || '',
      payType: u.payType || 'percent', payRate: u.payRate == null ? 35 : u.payRate, notes: u.notes || '',
    });
    def('dispatch.drivers', STAFF, false, (ctx) => db.users.filter((u) => u.companyId === ctx.company.id && u.role === 'driver').map((u) => {
      const s = driverStats(u, 30);
      return { ...driverFull(u), completed30: s.completed30, rating: s.rating, acceptance: s.acceptance, onTime: s.onTime };
    }));
    def('dispatch.driver', STAFF, false, (ctx, a) => {
      const u = ownDriver(ctx, a.id);
      return {
        driver: driverFull(u), stats: driverStats(u, 30),
        recent: db.trips.filter((t) => t.driverId === u.id).sort((x, y) => y.pickupAt.localeCompare(x.pickupAt)).slice(0, 8).map(tripView),
      };
    });
    def('dispatch.saveDriver', STAFF, true, async (ctx, a) => saveStaffUser(ctx, a, 'driver'));
    def('dispatch.setDriverPhoto', STAFF, true, (ctx, a) => { const u = ownDriver(ctx, a.id); u.photo = cleanPhoto(a.photo); return driverFull(u); });
    def('dispatch.payroll', STAFF, false, (ctx, a) => {
      if (!dateOk(a.from) || !dateOk(a.to)) fail('Choose a pay period.');
      const drivers = db.users.filter((u) => u.companyId === ctx.company.id && u.role === 'driver');
      return drivers.map((u) => {
        const trips = db.trips.filter((t) => t.driverId === u.id && t.status === 'completed' && (() => { const d = localParts(t.pickupAt, ctx.company.timezone).date; return d >= a.from && d <= a.to; })());
        const paid = db.payouts.find((p) => p.driverId === u.id && p.from === a.from && p.to === a.to);
        return { driverId: u.id, name: u.name, payType: u.payType || 'percent', payRate: u.payRate == null ? 35 : u.payRate, ...driverPay(u, trips), paidAt: paid ? paid.paidAt : null, paidAmount: paid ? paid.amount : null };
      });
    });
    def('dispatch.markPayout', STAFF, true, (ctx, a) => {
      const u = ownDriver(ctx, a.driverId);
      if (!dateOk(a.from) || !dateOk(a.to)) fail('Choose a pay period.');
      const i = db.payouts.findIndex((p) => p.driverId === u.id && p.from === a.from && p.to === a.to);
      if (a.undo) { if (i >= 0) db.payouts.splice(i, 1); return true; }
      if (i >= 0) fail('This period is already marked paid.');
      const p = { id: id('pay'), companyId: ctx.company.id, driverId: u.id, from: a.from, to: a.to, amount: round2(num(a.amount, 0)), paidAt: now().toISOString(), by: ctx.user.name };
      db.payouts.push(p); return clone(p);
    });

    // Fleet
    function vehicleStats(v) {
      const m = now().toISOString().slice(0, 7);
      const trips = db.trips.filter((t) => t.vehicleId === v.id && t.status === 'completed' && t.pickupAt.slice(0, 7) === m);
      const costs = db.maintenance.filter((x) => x.vehicleId === v.id && x.date.slice(0, 7) === m);
      return { tripsMonth: trips.length, revenueMonth: round2(trips.reduce((s, t) => s + t.price.total, 0)), costMonth: round2(costs.reduce((s, x) => s + x.cost, 0)), serviceDueIn: v.serviceEvery ? v.serviceEvery - ((v.odometer || 0) - (v.lastServiceOdometer || 0)) : null };
    }
    // Reports: completed trips by pickup date (company time zone) between from and to, inclusive.
    def('dispatch.reports', STAFF, false, (ctx, a) => {
      const c = ctx.company, tz = c.timezone;
      const from = dateOk(a.from) ? a.from : localParts(now().toISOString(), tz).date.slice(0, 8) + '01';
      const to = dateOk(a.to) ? a.to : localParts(now().toISOString(), tz).date;
      if (to < from) fail('The end date must be on or after the start date.');
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
      if (days > 400) fail('Choose a range of up to 13 months.');
      const group = ['day', 'week', 'month'].includes(a.group) ? a.group : days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
      const dayOf = (t) => localParts(t.pickupAt, tz).date;
      const inRange = db.trips.filter((t) => t.companyId === c.id && (() => { const d = dayOf(t); return d >= from && d <= to; })());
      const done = inRange.filter((t) => t.status === 'completed');
      const cancelled = inRange.filter((t) => t.status === 'cancelled');
      const sum = (arr, f) => round2(arr.reduce((x, t) => x + f(t), 0));
      // Money we keep: trips sent to partners only earn the margin.
      const kept = (t) => t.farmout ? t.price.total - (t.farmout.rate || 0) : t.price.total;
      // Buckets
      const keyOf = (d) => {
        if (group === 'month') return d.slice(0, 7);
        if (group === 'week') { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
        return d;
      };
      const buckets = [];
      for (let i = 0; i < days; i++) { const d = new Date(Date.parse(from + 'T12:00:00Z') + i * 86400e3).toISOString().slice(0, 10); const k = keyOf(d); if (!buckets.length || buckets[buckets.length - 1].key !== k) buckets.push({ key: k, trips: 0, revenue: 0 }); }
      const bIdx = Object.fromEntries(buckets.map((b, i) => [b.key, i]));
      for (const t of done) { const b = buckets[bIdx[keyOf(dayOf(t))]]; if (b) { b.trips++; b.revenue = round2(b.revenue + t.price.total); } }
      const by = (keyFn, labelFn) => {
        const m = new Map();
        for (const t of done) { const k = keyFn(t); if (k == null) continue; const r = m.get(k) || { key: k, label: labelFn ? labelFn(t) : k, trips: 0, revenue: 0 }; r.trips++; r.revenue = round2(r.revenue + t.price.total); m.set(k, r); }
        return [...m.values()].sort((x, y) => y.revenue - x.revenue);
      };
      const srcLabel = (t) => t.farmIn ? 'From partner companies' : t.source === 'phone' ? 'Phone and office' : 'Online';
      const customers = by((t) => t.accountId ? 'a:' + t.accountId : t.customerId ? 'c:' + t.customerId : 'p:' + (t.passengerName || '').toLowerCase(), (t) => {
        if (t.accountId) { const acc = db.accounts.find((x) => x.id === t.accountId); return (acc ? acc.name : 'Account') + ' (account)'; }
        const u = t.customerId && findUser(t.customerId); return u ? u.name : t.passengerName || 'Walk-in';
      }).slice(0, 10);
      const drivers = db.users.filter((u) => u.companyId === c.id && u.role === 'driver').map((u) => {
        const mine = done.filter((t) => t.driverId === u.id);
        const pay = driverPay(u, mine);
        const rated = mine.filter((t) => t.rating);
        let late = 0, arrivals = 0;
        for (const t of mine) { const h = t.history.find((x) => x.status === 'arrived'); if (h) { arrivals++; if (new Date(h.at) > new Date(new Date(t.pickupAt).getTime() + 5 * 60e3)) late++; } }
        return { id: u.id, name: u.name, trips: mine.length, revenue: sum(mine, (t) => t.price.total), hours: pay.hours, pay: pay.total, tips: pay.tips, rating: rated.length ? round2(rated.reduce((x, t) => x + t.rating.stars, 0) / rated.length) : null, onTime: arrivals ? Math.round((arrivals - late) / arrivals * 100) : null };
      }).sort((x, y) => y.revenue - x.revenue);
      const vehicles = db.vehicles.filter((v) => v.companyId === c.id && v.status !== 'retired').map((v) => {
        const mine = done.filter((t) => t.vehicleId === v.id);
        const hours = round2(mine.reduce((x, t) => x + tripHours(t), 0));
        // Use against a 12-hour working day.
        return { id: v.id, name: v.name, type: v.type, trips: mine.length, revenue: sum(mine, (t) => t.price.total), hours, use: Math.min(100, Math.round(hours / (days * 12) * 100)) };
      }).sort((x, y) => y.revenue - x.revenue);
      const paid = done.filter((t) => t.payment.status === 'paid');
      const onAccount = done.filter((t) => t.payment.status !== 'paid' && t.payment.method === 'account');
      const unpaid = done.filter((t) => t.payment.status !== 'paid' && t.payment.method !== 'account' && !t.farmIn);
      const farmedOut = done.filter((t) => t.farmout);
      return {
        from, to, days, group, timezone: tz,
        totals: {
          trips: done.length, revenue: sum(done, (t) => t.price.total), kept: sum(done, kept), fares: sum(done, (t) => t.price.subtotal), gratuity: sum(done, (t) => t.price.gratuity), tolls: sum(done, (t) => t.tolls || 0),
          avgTrip: done.length ? round2(sum(done, (t) => t.price.total) / done.length) : 0, cancelled: cancelled.length,
          cancelRate: done.length + cancelled.length ? Math.round(cancelled.length / (done.length + cancelled.length) * 100) : 0,
          paid: sum(paid, (t) => t.price.total), onAccount: sum(onAccount, (t) => t.price.total), unpaid: sum(unpaid, (t) => t.price.total),
          farmedOut: farmedOut.length, partnerMargin: sum(farmedOut, kept), upcoming: db.trips.filter((t) => t.companyId === c.id && busyStatus(t.status)).length,
        },
        series: buckets,
        bySource: by(srcLabel), byService: by((t) => SERVICES[t.service] || t.service), byVehicleType: by((t) => t.vehicleType),
        byPayment: [['Paid', paid], ['On company account', onAccount], ['Not paid yet', unpaid]].map(([label, arr]) => ({ key: label, label, trips: arr.length, revenue: sum(arr, (t) => t.price.total) })).filter((r) => r.trips),
        customers, drivers, vehicles,
        rows: done.concat(cancelled).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).map((t) => {
          const v = tripView(t);
          return { date: dayOf(t), time: localParts(t.pickupAt, tz).hour + ':' + String(localParts(t.pickupAt, tz).minute).padStart(2, '0'), ref: t.ref, status: STATUS_LABELS[t.status], service: SERVICES[t.service], passenger: t.passengerName, account: v.account ? v.account.name : '', po: t.poNumber || '', costCenter: t.costCenter || '',
            pickup: t.pickup, dropoff: t.dropoff, vehicleType: t.vehicleType, vehicle: v.vehicle ? v.vehicle.name : '', driver: v.driver ? v.driver.name : '', source: srcLabel(t), partner: t.farmout ? t.farmout.toName : '',
            fare: t.price.subtotal, gratuity: t.price.gratuity, tolls: t.tolls || 0, total: t.price.total, payment: t.payment.status === 'paid' ? `Paid (${t.payment.method === 'card_on_file' ? 'card' : t.payment.method || ''})` : t.payment.method === 'account' ? 'On account' : 'Unpaid', rating: t.rating ? t.rating.stars : '' };
        }),
      };
    });
    def('dispatch.vehicles', STAFF, false, (ctx) => db.vehicles.filter((v) => v.companyId === ctx.company.id).map((v) => ({ ...clone(v), ...vehicleStats(v) })));
    def('dispatch.vehicle', STAFF, false, (ctx, a) => {
      const v = ownVehicle(ctx, a.id);
      return { vehicle: { ...clone(v), ...vehicleStats(v), photo: (db.vehiclePhotos || {})[v.id] || '' }, log: db.maintenance.filter((x) => x.vehicleId === v.id).sort((x, y) => y.date.localeCompare(x.date)).map(clone),
        upcoming: db.trips.filter((t) => t.vehicleId === v.id && !['completed', 'cancelled'].includes(t.status)).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt)).slice(0, 6).map(tripView) };
    });
    // Vehicle photos live apart from the vehicles so the board and lists stay small.
    def('dispatch.setVehiclePhoto', STAFF, true, (ctx, a) => {
      const v = ownVehicle(ctx, a.id), photo = cleanPhoto(a.photo);
      db.vehiclePhotos = db.vehiclePhotos || {};
      if (photo) db.vehiclePhotos[v.id] = photo; else delete db.vehiclePhotos[v.id];
      return { id: v.id, photo };
    });
    def('dispatch.saveVehicle', STAFF, true, (ctx, a) => {
      const name = str(a.name, 60), plate = str(a.plate, 15).toUpperCase();
      if (!name) fail('Enter a vehicle name, for example "Lincoln Navigator".');
      if (!VEHICLE_TYPES.includes(a.type)) fail('Choose a vehicle type.');
      const capacity = Math.round(num(a.capacity, 0));
      if (!(capacity >= 1 && capacity <= 60)) fail('Seats must be between 1 and 60.');
      const status = VEHICLE_STATUS[a.status] ? a.status : (a.active === false ? 'retired' : 'active');
      for (const k of ['registrationExp', 'insuranceExp', 'inspectionExp']) if (a[k] && !dateOk(a[k])) fail('Use real dates for the documents.');
      let v = a.id ? ownVehicle(ctx, a.id) : null;
      if (!v) { v = { id: id('veh'), companyId: ctx.company.id, odometer: 0, lastServiceOdometer: 0 }; db.vehicles.push(v); }
      const year = a.year ? Math.round(num(a.year, 0)) : null;
      Object.assign(v, {
        name, plate, type: a.type, capacity, color: str(a.color, 30), status, active: status === 'active',
        year: year && year > 1950 && year < 2100 ? year : null, vin: str(a.vin, 20).toUpperCase(),
        registrationExp: a.registrationExp || '', insuranceExp: a.insuranceExp || '', inspectionExp: a.inspectionExp || '',
        serviceEvery: Math.max(0, Math.round(num(a.serviceEvery, v.serviceEvery || 5000))),
      });
      if (a.odometer !== undefined && a.odometer !== '') v.odometer = Math.max(0, Math.round(num(a.odometer, v.odometer)));
      return clone(v);
    });
    def('dispatch.addMaintenance', STAFF, true, (ctx, a) => {
      const v = ownVehicle(ctx, a.vehicleId);
      if (!dateOk(a.date)) fail('Choose the service date.');
      const kind = MAINT_KINDS.includes(a.kind) ? a.kind : 'Other';
      const odo = a.odometer === '' || a.odometer == null ? v.odometer : Math.max(0, Math.round(num(a.odometer, v.odometer)));
      const e = { id: id('mnt'), companyId: ctx.company.id, vehicleId: v.id, date: a.date, kind, odometer: odo, cost: Math.max(0, round2(num(a.cost, 0))), vendor: str(a.vendor, 80), notes: str(a.notes, 300), by: ctx.user.name };
      db.maintenance.push(e);
      if (odo > (v.odometer || 0)) v.odometer = odo;
      if (kind === 'Oil change' || kind === 'Scheduled service') v.lastServiceOdometer = Math.max(v.lastServiceOdometer || 0, odo);
      if (a.backInService && v.status === 'maintenance') { v.status = 'active'; v.active = true; }
      return clone(e);
    });
    def('dispatch.deleteMaintenance', STAFF, true, (ctx, a) => {
      const i = db.maintenance.findIndex((x) => x.id === a.id && x.companyId === ctx.company.id);
      if (i < 0) fail('Entry not found.', 404);
      db.maintenance.splice(i, 1); return true;
    });

    // Team, settings and pricing
    def('dispatch.team', ['admin'], false, (ctx) => db.users.filter((u) => u.companyId === ctx.company.id && STAFF.includes(u.role)).map(pubUser));
    def('dispatch.staffPerms', ['admin'], false, () => Object.entries(STAFF_PERMS).map(([key, d]) => ({ key, label: d.label, on: d.on })));
    def('dispatch.saveStaff', ['admin'], true, async (ctx, a) => {
      const role = a.role === 'admin' ? 'admin' : 'dispatcher';
      const cur = a.id ? db.users.find((x) => x.id === a.id && x.companyId === ctx.company.id && STAFF.includes(x.role)) : null;
      if (a.id && !cur) fail('Person not found.', 404);
      if (cur && cur.role !== role && cur.id === ctx.user.id) fail("You can't change your own access level. Ask another admin.");
      const res = await saveStaffUser(ctx, a, cur ? cur.role : role);
      const who = db.users.find((x) => x.id === res.id);
      who.role = role;
      if (role === 'admin') delete who.perms;
      else if (a.perms && typeof a.perms === 'object') {
        who.perms = {};
        for (const k of Object.keys(STAFF_PERMS)) who.perms[k] = !!a.perms[k];
      }
      return pubUser(who);
    });
    def('dispatch.settings', STAFF, false, (ctx) => ({ company: { ...pubCompany(ctx.company), refPrefix: ctx.company.refPrefix, plan: ctx.company.plan, planInfo: planInfo(ctx.company), terms: ctx.company.terms || '', policy: pcfg(ctx.company), bags: bagsCfg(ctx.company), stripe: ctx.company.stripe ? { ready: !!ctx.company.stripe.ready, since: ctx.company.stripe.connectedAt || null } : null }, rates: clone(ctx.company.rates), addons: clone(ctx.company.pricing.addons), vehicleTypes: VEHICLE_TYPES }));
    def('dispatch.saveSettings', ['admin'], true, (ctx, a) => {
      const c = ctx.company;
      const name = str(a.name, 80);
      if (!name) fail('Enter the company name.');
      const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : c.color;
      Object.assign(c, { name, tagline: str(a.tagline, 120), color, phone: str(a.phone, 30), email: str(a.email, 120) });
      if ('terms' in a) c.terms = str(a.terms, 6000);
      const r = a.rates || {};
      const pos = (k, max) => { if (k in r) { const n = num(r[k], NaN); if (!(n >= 0 && n <= max)) fail(`Check the value for ${k}.`); c.rates[k] = round2(n); } };
      pos('base', 1000); pos('perMile', 100); pos('minFare', 5000); pos('hourly', 2000); pos('minHours', 24);
      pos('airportFlat', 5000); pos('gratuityPct', 50); pos('taxPct', 30); pos('waitPerMin', 20);
      if (r.multipliers) for (const t of VEHICLE_TYPES) if (t in r.multipliers) {
        const n = num(r.multipliers[t], NaN); if (!(n > 0 && n <= 10)) fail(`Check the multiplier for ${t}.`); c.rates.multipliers[t] = round2(n);
      }
      if (r.bags) {
        c.rates.bags = bagsCfg(c);
        for (const t of VEHICLE_TYPES) if (t in r.bags) { const n = Math.round(num(r.bags[t], NaN)); if (!(n >= 0 && n <= 40)) fail(`Check the suitcases for ${t}.`); c.rates.bags[t] = n; }
      }
      if (a.policy) {
        const pol = pcfg(c), pa = a.policy;
        const whole = (k, max, label) => { if (k in pa) { const n = Math.round(num(pa[k], NaN)); if (!(n >= 0 && n <= max)) fail(`Check the ${label}.`); pol[k] = n; } };
        whole('cancelHours', 168, 'free cancellation hours'); whole('cancelFeePct', 100, 'late cancellation fee');
        whole('waitAirport', 180, 'free waiting at airports'); whole('waitOther', 120, 'free waiting elsewhere'); whole('noShowFeePct', 100, 'no-show fee');
        whole('chargeHours', 168, 'hours before pickup to charge the card');
        if ('chargeWhen' in pa) pol.chargeWhen = pa.chargeWhen === 'before' ? 'before' : 'booking';
        c.policy = pol;
      }
      return { company: pubCompany(c), rates: clone(c.rates), policy: pcfg(c) };
    });
    def('dispatch.pricing', STAFF, false, (ctx) => ({ pricing: clone(ctx.company.pricing), flight: clone(ctx.company.flight), timezone: ctx.company.timezone || 'America/New_York' }));
    def('dispatch.savePricing', ['admin'], true, (ctx, a) => {
      const p = ctx.company.pricing;
      const pct = (v, label, max) => { const n = num(v, NaN); if (!(n >= 0 && n <= (max || 200))) fail(`Check the ${label}.`); return round2(n); };
      const hr = (v, label) => { const n = Math.round(num(v, NaN)); if (!(n >= 0 && n <= 23)) fail(`Check the ${label} (0 to 23).`); return n; };
      if ('nightPct' in a) p.nightPct = pct(a.nightPct, 'late night surcharge');
      if ('nightStart' in a) p.nightStart = hr(a.nightStart, 'late night start hour');
      if ('nightEnd' in a) p.nightEnd = hr(a.nightEnd, 'late night end hour');
      if ('weekendPct' in a) p.weekendPct = pct(a.weekendPct, 'weekend surcharge');
      if ('busyPct' in a) p.busyPct = pct(a.busyPct, 'busy-time surcharge');
      if ('busyThreshold' in a) p.busyThreshold = pct(a.busyThreshold, 'busy-time trigger', 100);
      if (a.addons) for (const k of ['childSeat', 'meetGreet', 'extraStop', 'stopWait']) if (k in a.addons) p.addons[k] = k === 'stopWait' ? Math.round(pct(a.addons[k], 'wait booked at each stop', 240)) : pct(a.addons[k], 'add-on price', 1000);
      if (Array.isArray(a.peakDates)) {
        p.peakDates = a.peakDates.filter((d) => d && (d.date || d.label)).map((d) => {
          if (!dateOk(d.date)) fail('Each busy date needs a real date.');
          if (!str(d.label)) fail('Give each busy date a name, for example "New Year\'s Eve".');
          return { id: d.id || id('peak'), date: d.date, label: str(d.label, 60), pct: pct(d.pct, 'busy date surcharge') };
        }).sort((x, y) => x.date.localeCompare(y.date));
      }
      if (Array.isArray(a.promos)) {
        const seen = new Set();
        p.promos = a.promos.filter((x) => x && str(x.code)).map((x) => {
          const code = str(x.code, 30).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!code) fail('Promo codes can use letters and numbers only.');
          if (seen.has(code)) fail(`Promo code ${code} is listed twice.`);
          seen.add(code);
          const type = x.type === 'amount' ? 'amount' : 'percent';
          const value = num(x.value, NaN);
          if (!(value > 0 && (type === 'amount' ? value <= 1000 : value <= 100))) fail(`Check the discount for ${code}.`);
          if (x.expires && !dateOk(x.expires)) fail(`Check the end date for ${code}.`);
          const old = (ctx.company.pricing.promos || []).find((o) => o.code === code);
          return { id: x.id || id('promo'), code, type, value: round2(value), active: x.active !== false, expires: x.expires || '', maxUses: Math.max(0, Math.round(num(x.maxUses, 0))), uses: old ? old.uses || 0 : 0 };
        });
      }
      return clone(p);
    });

    async function saveStaffUser(ctx, a, role) {
      const email = str(a.email, 120).toLowerCase();
      const name = str(a.name, 80);
      if (!name) fail('Enter a name.');
      if (!emailOk(email)) fail('Enter a valid email address.');
      let u = a.id ? db.users.find((x) => x.id === a.id && x.companyId === ctx.company.id && x.role === role) : null;
      if (a.id && !u) fail('Person not found.', 404);
      const clash = db.users.find((x) => x.email === email && x.companyId === ctx.company.id && x !== u);
      if (clash) fail('Someone at this company already uses that email.');
      if (!u) {
        if (String(a.password || '').length < 8) fail('Set a password of at least 8 characters.');
        u = { id: id('usr'), role, companyId: ctx.company.id, createdAt: now().toISOString(), available: role === 'driver' };
        if (role === 'driver') Object.assign(u, { payType: 'percent', payRate: 35 });
        db.users.push(u);
      }
      if (u.id === ctx.user.id && a.active === false) fail("You can't deactivate your own login.");
      Object.assign(u, { name, email, phone: str(a.phone, 30), active: a.active !== false });
      if (role === 'driver') {
        u.vehicleId = a.vehicleId && db.vehicles.find((v) => v.id === a.vehicleId && v.companyId === ctx.company.id) ? a.vehicleId : (a.vehicleId === undefined ? u.vehicleId || null : null);
        for (const k of ['licenseExp', 'permitExp', 'hireDate']) if (k in a) { if (a[k] && !dateOk(a[k])) fail('Use real dates for license, permit and hire date.'); u[k] = a[k] || ''; }
        if ('licenseNumber' in a) u.licenseNumber = str(a.licenseNumber, 30).toUpperCase();
        if ('notes' in a) u.notes = str(a.notes, 300);
        if ('payType' in a) u.payType = PAY_TYPES[a.payType] ? a.payType : 'percent';
        if ('payRate' in a) { const r = num(a.payRate, NaN); if (!(r >= 0 && r <= 1000)) fail('Check the pay rate.'); u.payRate = round2(r); }
      }
      if (a.password) {
        if (String(a.password).length < 8) fail('Use a password of at least 8 characters.');
        await setPassword(u, a.password);
      }
      return pubUser(u);
    }

    // Platform owner
    function monthKey(d) { return d.toISOString().slice(0, 7); }
    const foundingLeft = (except) => PLANS.founding.limit - db.companies.filter((c) => c.plan === 'founding' && c !== except && c.status !== 'pending').length;
    const inTrial = (c, at) => !!(c.trialEnds && (at || now().toISOString().slice(0, 10)) < c.trialEnds);
    // What a company pays: its plan's price (the Founding price stays locked),
    // or 10 months once a year on yearly billing.
    function setPlan(c, plan, billing) {
      if (!PLANS[plan]) fail('Unknown plan.');
      if (plan === 'founding' && c.plan !== 'founding' && foundingLeft(c) <= 0) fail(`All ${PLANS.founding.limit} Founding places are taken. Choose Standard or Fleet.`);
      if (billing && !['monthly', 'yearly'].includes(billing)) fail('Choose monthly or yearly billing.');
      if (plan !== c.plan) {
        c.plan = plan; c.monthlyFee = PLANS[plan].monthly; c.setupFee = PLANS[plan].setup;
        c.priceLockedUntil = plan === 'founding' ? addMonths(now().toISOString(), PLANS.founding.lockMonths).slice(0, 10) : null;
      }
      if (billing) c.billing = billing;
    }
    function planInfo(c) {
      const yearly = c.billing === 'yearly';
      return {
        plan: c.plan, planLabel: PLANS[c.plan].label, billing: yearly ? 'yearly' : 'monthly', monthlyFee: c.monthlyFee,
        yearlyFee: round2(c.monthlyFee * YEARLY_MONTHS), monthlyEquivalent: yearly ? round2(c.monthlyFee * YEARLY_MONTHS / 12) : c.monthlyFee,
        setupFee: yearly ? 0 : c.setupFee, setupBilled: !!c.setupBilled, trialEnds: c.trialEnds || null, inTrial: inTrial(c),
        priceLockedUntil: c.priceLockedUntil || null, paidThrough: c.paidThrough || null,
      };
    }
    // Free-trial requests from the home page. The platform owner follows up
    // and adds the company (Companies > Add company).
    // ---- Login links: set or reset a password from an emailed link --------
    const WELCOME_DAYS = 7, RESET_HOURS = 2;
    const loginUrl = (tok) => `${opts.publicUrl || ''}#setpw.${tok}`;
    function loginLink(u, purpose) {
      const t = now().getTime();
      db.pwTokens = (db.pwTokens || []).filter((x) => x.userId !== u.id && new Date(x.expires).getTime() > t);
      const token = randomId(24);
      db.pwTokens.push({ token, userId: u.id, purpose, expires: new Date(t + (purpose === 'reset' ? RESET_HOURS * 3600e3 : WELCOME_DAYS * 864e5)).toISOString() });
      return loginUrl(token);
    }
    function linkUser(token) {
      const x = (db.pwTokens || []).find((r) => r.token === String(token || ''));
      const u = x && new Date(x.expires).getTime() > now().getTime() && findUser(x.userId);
      if (!u || u.active === false) fail('This link has expired or was already used. Ask for a new one.', 404);
      return { x, u };
    }
    function mailUser(u, companyId, kind, body) {
      db.messages.unshift({ id: id('msg'), companyId, tripId: null, ref: '', at: now().toISOString(), recipient: u.email, channel: 'email', kind, metered: true, body });
    }
    // Welcome email for a company admin, from LimoRelay, with a set-your-password link.
    function sendWelcome(c, u) {
      const link = loginLink(u, 'welcome');
      const site = (opts.publicUrl || 'https://limorelay.com/').replace(/#.*$/, '');
      mailUser(u, null, 'login', `Welcome to LimoRelay, ${u.name.split(' ')[0]}. ${c.name} is set up on LimoRelay. Your sign-in email is ${u.email}. Set your password with this link (it works for ${WELCOME_DAYS} days): ${link} After that, sign in any time at ${site} to add your drivers, cars and dispatchers. Questions? Reply to this email or write to ${PLATFORM_EMAIL}.`);
      return link;
    }
    // Message logs show these emails without the link inside.
    const hideLink = (m) => (m.kind === 'login' || m.kind === 'reset' ? { ...m, body: String(m.body).replace(/https?:\/\/\S*#setpw\.\S+|#setpw\.\S+/g, '[private link]') } : m);
    def('public.forgotPassword', 'public', true, (ctx, a) => {
      const email = str(a.email, 120).toLowerCase();
      if (!emailOk(email)) fail('Enter the email you sign in with.');
      for (const u of db.users.filter((x) => x.email === email && x.active !== false)) {
        const c = u.companyId && findCompany(u.companyId);
        mailUser(u, c ? c.id : null, 'reset', `${c ? c.name + ': r' : 'R'}eset your password with this link (it works for ${RESET_HOURS} hours): ${loginLink(u, 'reset')} If you didn't ask for this, ignore this email and your password stays the same.`);
      }
      return { ok: true };
    });
    def('public.loginLink', 'public', false, (ctx, a) => {
      const { x, u } = linkUser(a.token);
      const c = u.companyId && findCompany(u.companyId);
      return { email: u.email, name: u.name.split(' ')[0], purpose: x.purpose, company: c ? c.name : '' };
    });
    def('public.setPassword', 'public', true, async (ctx, a) => {
      const { u } = linkUser(a.token);
      const pw = String(a.password || '');
      if (pw.length < 8) fail('Choose a password of at least 8 characters.');
      if (u.companyId) { const c = findCompany(u.companyId); if (c && c.status !== 'active') fail(closedMsg(c), 403); }
      await setPassword(u, pw);
      db.pwTokens = db.pwTokens.filter((r) => r.userId !== u.id);
      for (const [k, sx] of Object.entries(db.sessions)) if (sx.userId === u.id) delete db.sessions[k];
      const token = randomId(24);
      db.sessions[token] = { userId: u.id, at: now().toISOString() };
      return { token, user: pubUser(u), company: pubCompany(findCompany(u.companyId)) };
    });
    // Login email for a customer, from their limo company: a link to set (or
    // reset) their password, then sign in to book and see their rides.
    function sendCustomerLogin(c, u) {
      const link = loginLink(u, 'welcome');
      const site = `${(opts.publicUrl || 'https://limorelay.com/').replace(/#.*$/, '')}#book.${c.slug}`;
      mailUser(u, c.id, 'login', `Hi ${u.name.split(' ')[0]}, here are your ${c.name} login details. Your sign-in email is ${u.email}. ${u.passHash ? 'Choose a new password' : 'Set your password'} with this link (it works for ${WELCOME_DAYS} days): ${link} Then sign in any time at ${site} to book rides, see your trips and keep your card on file.${c.phone ? ` Questions? Call ${c.phone}.` : ''}`);
      return link;
    }
    def('dispatch.sendCustomerLogin', STAFF, true, (ctx, a) => {
      const c = ctx.company;
      const pick = a.all ? db.users.filter((u) => u.companyId === c.id && u.role === 'customer' && u.active !== false && !u.passHash)
        : db.users.filter((u) => u.id === a.id && u.companyId === c.id && u.role === 'customer' && u.active !== false);
      if (!a.all && !pick.length) fail('Customer not found.', 404);
      const ok = pick.filter((u) => emailOk(u.email));
      if (!a.all && !ok.length) fail('This customer has no email address. Add one first.');
      const links = ok.map((u) => ({ email: u.email, link: sendCustomerLogin(c, u) }));
      return { sent: ok.map((u) => u.email), emailOn: !!live.email, links: live.email ? [] : links };
    });
    def('owner.sendLogin', ['owner'], true, (ctx, a) => {
      const c = findCompany(a.id);
      if (!c) fail('Company not found.', 404);
      const admins = db.users.filter((u) => u.companyId === c.id && u.role === 'admin' && u.active !== false);
      if (!admins.length) fail(`${c.name} has no admin login.`);
      const links = admins.map((u) => ({ email: u.email, link: sendWelcome(c, u) }));
      return { sent: admins.map((u) => u.email), emailOn: !!live.email, links: live.email ? [] : links };
    });
    const closedMsg = (c) => c.status === 'pending'
      ? `${c.name} is waiting for approval. We'll email you as soon as it's approved.`
      : `${c.name}'s account is paused. Contact the platform owner.`;
    // A new company record with LimoRelay's default rates and settings.
    function makeCompany(f) {
      const plan = PLANS[f.plan] ? f.plan : 'standard';
      const prefix = (f.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'TRP').padEnd(3, 'X');
      return {
        id: id('co'), slug: f.slug, name: f.name, tagline: str(f.tagline, 120), color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#3d4f7c',
        phone: str(f.phone, 30), email: f.email, status: f.status || 'active', plan,
        monthlyFee: f.monthlyFee != null && f.monthlyFee !== '' ? round2(num(f.monthlyFee, PLANS[plan].monthly)) : PLANS[plan].monthly,
        setupFee: f.setupFee != null && f.setupFee !== '' ? round2(num(f.setupFee, PLANS[plan].setup)) : PLANS[plan].setup,
        billing: f.billing === 'yearly' ? 'yearly' : 'monthly', trialEnds: f.trial ? new Date(now().getTime() + TRIAL_DAYS * 864e5).toISOString().slice(0, 10) : null,
        priceLockedUntil: plan === 'founding' ? addMonths(now().toISOString(), PLANS.founding.lockMonths).slice(0, 10) : null,
        setupBilled: false, refPrefix: prefix, timezone: str(f.timezone, 40) || 'America/Los_Angeles', nextRef: 1000, network: defaultNetwork(null),
        rates: clone(DEFAULT_RATES), pricing: clone(DEFAULT_PRICING), flight: clone(DEFAULT_FLIGHT), createdAt: now().toISOString(),
      };
    }
    const siteUrl = () => (opts.publicUrl || 'https://limorelay.com/').replace(/#.*$/, '');
    const loginTaken = (email) => db.users.some((u) => u.email === email && u.role !== 'customer');
    // Companies sign themselves up from the home page. They can't sign in
    // until the platform owner approves them; the free trial starts then.
    def('public.companySignup', 'public', true, async (ctx, a) => {
      const company = str(a.company, 80), name = str(a.name, 80), email = str(a.email, 120).toLowerCase();
      const phone = str(a.phone, 30), city = str(a.city, 80), fleet = str(a.fleet, 20), note = str(a.note, 600);
      const pw = String(a.password || '');
      if (!company) fail('Enter your company name.');
      if (!name) fail('Enter your name.');
      if (!emailOk(email)) fail('Enter a valid email address.');
      if (phone.replace(/\D/g, '').length < 10) fail('Enter your phone number.');
      if (pw.length < 8) fail('Choose a password of at least 8 characters.');
      if (!a.terms) fail('Please agree to the Terms to continue.');
      if (loginTaken(email)) fail('That email already has a login. Sign in, or use Forgot password.');
      const slug = slugify(a.slug || company);
      if (!slug || slug.length < 3) fail('Choose a booking link name of at least 3 letters.');
      if (db.companies.some((c) => c.slug === slug)) fail('That booking link name is taken. Choose another.');
      if (db.companies.filter((c) => c.status === 'pending' && new Date(c.createdAt).getTime() > now().getTime() - 3600e3).length >= 20) fail('Too many sign-ups right now. Please try again later.', 429);
      const plan = PLANS[a.plan] ? a.plan : foundingLeft() > 0 ? 'founding' : 'standard';
      if (plan === 'founding' && foundingLeft() <= 0) fail(`All ${PLANS.founding.limit} Founding places are taken. Choose Standard or Fleet.`);
      const c = makeCompany({ name: company, slug, plan, phone, email, status: 'pending' });
      c.signup = { city, fleet, note, at: c.createdAt };
      db.companies.push(c);
      const u = { id: id('usr'), role: 'admin', companyId: c.id, name, email, phone, active: true, createdAt: now().toISOString() };
      await setPassword(u, pw);
      db.users.push(u);
      mailUser(u, null, 'signup', `Welcome aboard, ${name.split(' ')[0]}! We've received the sign-up for ${company} on LimoRelay. We welcome every new member personally and will email you at ${email} as soon as you're approved, within 3 to 7 business days. Your 30-day free trial starts then, with no card needed. Questions? Reply to this email or write to ${PLATFORM_EMAIL}.`);
      const owner = db.users.find((x) => x.role === 'owner' && x.active !== false);
      if (owner && owner.email) db.messages.unshift({ id: id('msg'), companyId: null, tripId: null, ref: '', at: c.createdAt, recipient: owner.email, channel: 'email', kind: 'signup', metered: true, replyTo: email,
        body: `New company sign-up waiting for your approval: ${company}${city ? ', ' + city : ''}. ${name}, ${email}, ${phone}${fleet ? '. Fleet: ' + fleet + ' vehicles' : ''}. Plan: ${PLANS[plan].label}.${note ? ' Note: ' + note : ''} Approve or decline it at ${siteUrl()} under Companies.` });
      return { ok: true, company, email };
    });
    def('owner.reviewSignup', ['owner'], true, (ctx, a) => {
      const c = findCompany(a.id);
      if (!c || c.status !== 'pending') fail('That sign-up was not found or was already reviewed.', 404);
      const admins = db.users.filter((u) => u.companyId === c.id);
      if (a.approve) {
        if (c.plan === 'founding' && foundingLeft(c) <= 0) setPlan(c, 'standard');
        c.status = 'active';
        c.trialEnds = new Date(now().getTime() + TRIAL_DAYS * 864e5).toISOString().slice(0, 10);
        c.approvedAt = now().toISOString();
        for (const u of admins) mailUser(u, null, 'approved', `Good news, ${u.name.split(' ')[0]}: ${c.name} is approved on LimoRelay. Your 30-day free trial has started. Sign in at ${siteUrl()} with ${u.email} and the password you chose, then add your drivers, cars and rates. Your booking page is ${siteUrl()}#book.${c.slug}. Questions? Reply to this email or write to ${PLATFORM_EMAIL}.`);
        return { ...pubCompany(c), approved: true };
      }
      for (const u of admins) mailUser(u, null, 'declined', `Hello ${u.name.split(' ')[0]}, thank you for signing up ${c.name} for LimoRelay. We weren't able to approve this account. If you think this is a mistake, reply to this email or write to ${PLATFORM_EMAIL}.`);
      const ids = new Set(admins.map((u) => u.id));
      db.users = db.users.filter((u) => !ids.has(u.id));
      db.pwTokens = (db.pwTokens || []).filter((r) => !ids.has(r.userId));
      db.companies = db.companies.filter((x) => x !== c);
      return { declined: true, name: c.name };
    });
    def('public.requestTrial', 'public', true, (ctx, a) => {
      const name = str(a.name, 80), company = str(a.company, 100), email = str(a.email, 120).toLowerCase();
      const phone = str(a.phone, 30), city = str(a.city, 80), fleet = str(a.fleet, 20), note = str(a.note, 600);
      if (!name) fail('Enter your name.');
      if (!company) fail('Enter your company name.');
      if (!emailOk(email)) fail('Enter a valid email address.');
      if (phone && phone.replace(/\D/g, '').length < 7) fail('Check the phone number.');
      const day = now().getTime() - 86400e3;
      db.leads = db.leads || [];
      if (db.leads.some((l) => l.email === email && new Date(l.at).getTime() > day)) return { ok: true, again: true };
      if (db.leads.filter((l) => new Date(l.at).getTime() > now().getTime() - 3600e3).length >= 30) fail('Too many requests right now. Please try again later.', 429);
      const lead = { id: id('lead'), at: now().toISOString(), name, company, email, phone, city, fleet, note, status: 'new' };
      db.leads.unshift(lead);
      const owner = db.users.find((u) => u.role === 'owner' && u.active !== false);
      if (owner && owner.email) db.messages.unshift({ id: id('msg'), companyId: null, tripId: null, ref: 'Trial', at: lead.at, recipient: owner.email, channel: 'email', kind: 'lead', metered: true, replyTo: email,
        body: `New free-trial request: ${name}, ${company}${city ? ', ' + city : ''}. Email ${email}${phone ? ', phone ' + phone : ''}${fleet ? '. Fleet: ' + fleet + ' vehicles' : ''}.${note ? ' Note: ' + note : ''}` });
      return { ok: true };
    });
    def('owner.leads', ['owner'], false, () => clone(db.leads || []));
    def('owner.leadAction', ['owner'], true, (ctx, a) => {
      const l = (db.leads || []).find((x) => x.id === a.id);
      if (!l) fail('Request not found.', 404);
      if (a.action === 'delete') db.leads = db.leads.filter((x) => x !== l);
      else if (['new', 'contacted', 'signed'].includes(a.action)) l.status = a.action;
      else fail('Unknown action.');
      return clone(db.leads);
    });
    def('owner.plans', ['owner'], false, () => ({ plans: clone(PLANS), yearlyMonths: YEARLY_MONTHS, trialDays: TRIAL_DAYS, foundingLeft: foundingLeft(), texts: textPlan().plans }));
    def('owner.companies', ['owner'], false, () => {
      const m = monthKey(now());
      return db.companies.map((c) => {
        const trips = db.trips.filter((t) => t.companyId === c.id && t.pickupAt.slice(0, 7) === m);
        const admin = db.users.find((u) => u.companyId === c.id && u.role === 'admin');
        return {
          ...pubCompany(c), ...planInfo(c), createdAt: c.createdAt, signup: c.signup ? clone(c.signup) : null, adminPhone: admin ? admin.phone || '' : '', masterName: masterOf(c) ? masterOf(c).name : '', pinSet: !!c.paymentPin,
          adminEmail: admin ? admin.email : '', adminName: admin ? admin.name : '', adminId: admin ? admin.id : '', drivers: db.users.filter((u) => u.companyId === c.id && u.role === 'driver' && u.active !== false).length,
          vehicles: db.vehicles.filter((v) => v.companyId === c.id && v.status !== 'retired').length,
          tripsMonth: trips.filter((t) => t.status !== 'cancelled').length,
          bookedMonth: round2(trips.filter((t) => t.status !== 'cancelled').reduce((s, t) => s + t.price.total, 0)),
          texts: (({ used, included, credits, left, low, out, held, fromPacks }) => ({ used, included, credits, left, low, out, held, fromPacks, custom: c.textsIncluded != null }))(textStatus(c)),
        };
      });
    });
    def('owner.createCompany', ['owner'], true, async (ctx, a) => {
      const name = str(a.name, 80);
      if (!name) fail('Enter the company name.');
      const slug = slugify(a.slug || name);
      if (!slug || slug.length < 3) fail('Choose a booking link name of at least 3 letters.');
      if (db.companies.some((c) => c.slug === slug)) fail('That booking link name is taken. Choose another.');
      const plan = PLANS[a.plan] ? a.plan : 'standard';
      if (plan === 'founding' && foundingLeft() <= 0) fail(`All ${PLANS.founding.limit} Founding places are taken. Choose Standard or Fleet.`);
      const billing = a.billing === 'yearly' ? 'yearly' : 'monthly';
      const adminEmail = str(a.adminEmail, 120).toLowerCase();
      if (!str(a.adminName, 80)) fail("Enter the company admin's name.");
      if (!emailOk(adminEmail)) fail("Enter the company admin's email.");
      if (a.adminPassword && String(a.adminPassword).length < 8) fail('Make the temporary password at least 8 characters, or leave it blank.');
      const c = makeCompany({ ...a, name, slug, plan, billing, email: adminEmail, status: 'active' });
      db.companies.push(c);
      const u = { id: id('usr'), role: 'admin', companyId: c.id, name: str(a.adminName, 80), email: adminEmail, phone: c.phone, active: true, createdAt: now().toISOString() };
      if (a.adminPassword) await setPassword(u, a.adminPassword);
      db.users.push(u);
      const link = sendWelcome(c, u);
      return { ...pubCompany(c), emailOn: !!live.email, loginLink: live.email ? '' : link };
    });
    def('owner.updateCompany', ['owner'], true, (ctx, a) => {
      const c = findCompany(a.id);
      if (!c) fail('Company not found.', 404);
      if (a.plan || a.billing) setPlan(c, a.plan || c.plan, a.billing);
      if (a.endTrial) c.trialEnds = null;
      // A forgotten payment PIN: only the platform owner can clear it.
      if (a.resetPin) { delete c.paymentPin; delete c.pinFails; delete c.pinLockUntil; for (const s of Object.values(db.sessions)) delete s.payUnlockedUntil; }
      // The company's details and its admin login, edited by the platform owner.
      if (a.info) {
        const x = a.info;
        const name = str(x.name, 80);
        if (!name) fail('Enter the company name.');
        const slug = slugify(x.slug || c.slug);
        if (!slug || slug.length < 3) fail('Choose a booking link name of at least 3 letters.');
        if (db.companies.some((o) => o !== c && o.slug === slug)) fail('That booking link name is taken. Choose another.');
        const email = str(x.email, 120).toLowerCase();
        if (email && !emailOk(email)) fail('Enter a valid company email.');
        const admin = db.users.find((u) => u.companyId === c.id && u.role === 'admin');
        const adminEmail = str(x.adminEmail, 120).toLowerCase();
        if (admin) {
          if (!str(x.adminName, 80)) fail("Enter the company admin's name.");
          if (!emailOk(adminEmail)) fail("Enter the company admin's email.");
          if (db.users.some((u) => u !== admin && u.email === adminEmail && (u.role !== 'customer' || u.companyId === c.id))) fail('Another login already uses that email.');
          admin.name = str(x.adminName, 80);
          if (admin.email !== adminEmail) admin.email = adminEmail;
        }
        Object.assign(c, { name, slug, email, phone: str(x.phone, 30), tagline: str(x.tagline, 120), ...(/^#[0-9a-f]{6}$/i.test(x.color || '') ? { color: x.color } : {}), ...(str(x.timezone, 40) ? { timezone: str(x.timezone, 40) } : {}) });
      }
      if (a.monthlyFee != null && a.monthlyFee !== '') c.monthlyFee = Math.max(0, round2(num(a.monthlyFee, c.monthlyFee)));
      if (a.textsIncluded !== undefined) {
        if (a.textsIncluded === '' || a.textsIncluded === null) delete c.textsIncluded;
        else { const n = Math.round(num(a.textsIncluded, -1)); if (n < 0 || n > 100000) fail('Texts per month must be between 0 and 100,000.'); c.textsIncluded = n; }
      }
      if (a.giftPacks) {
        const n = Math.round(num(a.giftPacks, 0));
        if (n < 1 || n > 20) fail('Give between 1 and 20 free packs.');
        buyTexts(c, n, ctx.user.name, false, true);
      }
      if (a.status) {
        if (!['active', 'suspended'].includes(a.status)) fail('Unknown status.');
        c.status = a.status;
        if (a.status === 'suspended') for (const [tok, s] of Object.entries(db.sessions)) {
          const u = findUser(s.userId); if (u && u.companyId === c.id) delete db.sessions[tok];
        }
      }
      return pubCompany(c);
    });
    def('owner.textPlan', ['owner'], false, () => textPlan());
    def('owner.saveTextPlan', ['owner'], true, (ctx, a) => {
      const n = (k, lo, hi, label) => { const v = num(a[k], NaN); if (!(v >= lo && v <= hi)) fail(`${label} must be between ${lo} and ${hi}.`); return v; };
      const cur = textPlan();
      const plans = { ...cur.plans };
      for (const k of Object.keys(PLANS)) if (a.plans && a.plans[k] !== undefined && a.plans[k] !== '') { const v = Math.round(num(a.plans[k], NaN)); if (!(v >= 0 && v <= 100000)) fail(`${PLANS[k].label} texts per month must be between 0 and 100000.`); plans[k] = v; }
      db.textPlan = { plans, included: a.included !== undefined ? Math.round(n('included', 0, 100000, 'Texts per month')) : cur.included, packSize: Math.round(n('packSize', 50, 100000, 'Pack size')), packPrice: round2(n('packPrice', 0, 10000, 'Pack price')), warnPct: Math.round(n('warnPct', 50, 99, 'Warning point')) };
      return textPlan();
    });
    def('owner.invoices', ['owner'], false, () => db.invoices.slice().sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((i) => ({ ...clone(i), companyName: (findCompany(i.companyId) || {}).name })));
    // ---- Membership billing: each company pays LimoRelay for its plan ---------
    // Invoices are made on the 1st of each month (and the day a free trial
    // ends). A company with a card on file is charged automatically; the others
    // get an email with a link to pay.
    const companyAdmins = (c) => db.users.filter((u) => u.companyId === c.id && u.role === 'admin' && u.active !== false);
    const billingCfg = () => ({ autoBill: false, ...(db.billing || {}) });
    function chargeInvoice(inv, c) {
      if (inv.status !== 'open' || !c.billingCard || inv.total <= 0) return;
      if (inv.charge && inv.charge.status === 'pending') return;
      if (payMode === 'demo') {
        const bad = c.billingCard.last4 === '0341';
        inv.charge = { id: id('ich'), status: bad ? 'failed' : 'paid', at: now().toISOString(), last4: c.billingCard.last4, ...(bad ? { error: 'Card declined' } : { ref: `demo_${randomId(5)}` }) };
        if (!bad) { inv.status = 'paid'; inv.paidAt = now().toISOString(); inv.paidBy = `${c.billingCard.brand} ending ${c.billingCard.last4}`; }
        else billingMail(c, 'billing', `we couldn't charge your card ending ${c.billingCard.last4} for LimoRelay invoice ${inv.number} ($${money(inv.total)}). Please add another card under My account, Membership, at ${siteUrl()}#account.`);
      } else if (payMode === 'stripe' && c.billingCard.stripe) {
        inv.charge = { id: id('ich'), status: 'pending', at: now().toISOString(), last4: c.billingCard.last4 };
      }
    }
    function billingMail(c, kind, body) { for (const u of companyAdmins(c)) mailUser(u, null, kind, `Hello ${u.name.split(' ')[0]}, ${body} Questions? Reply to this email or write to ${PLATFORM_EMAIL}.`); }
    function billCompanies(period, trialAt) {
      const made = [];
      for (const c of db.companies) {
        if (c.status !== 'active') continue;
        if (db.invoices.some((i) => i.companyId === c.id && i.period === period)) continue;
        // Free trial: nothing is billed until it ends.
        if (inTrial(c, trialAt || `${period}-28`)) continue;
        const items = [];
        if (c.billing === 'yearly') {
          // One invoice covers 12 months for the price of 10, no setup fee.
          if (!(c.paidThrough && c.paidThrough >= period)) {
            const through = addMonths(`${period}-15T12:00:00Z`, 11).slice(0, 7);
            items.push({ label: `${PLANS[c.plan].label} plan, yearly ${period} to ${through} (2 months free)`, amount: round2(c.monthlyFee * YEARLY_MONTHS) });
            c.paidThrough = through;
          }
          if (!c.setupBilled) c.setupBilled = true;
        } else {
          items.push({ label: `${PLANS[c.plan].label} plan, ${period}`, amount: c.monthlyFee });
          if (!c.setupBilled && c.setupFee > 0) items.push({ label: 'One-time setup', amount: c.setupFee });
          c.setupBilled = true;
        }
        const packs = ((c.texts && c.texts.packs) || []).filter((p) => !p.invoiceId && !p.free && p.price > 0);
        for (const p of packs.slice().reverse()) items.push({ label: `${p.texts} extra texts, bought ${p.at.slice(0, 10)}${p.auto ? ' (automatic)' : ''}`, amount: p.price });
        const total = round2(items.reduce((sum, i) => sum + i.amount, 0));
        if (!items.length || total <= 0) continue;
        const inv = { id: id('inv'), number: `INV-${period.replace('-', '')}-${String(db.seq.inv).padStart(3, '0')}`, companyId: c.id, period, items, total, status: 'open', createdAt: now().toISOString(), paidAt: null };
        for (const p of packs) p.invoiceId = inv.id;
        db.invoices.push(inv); made.push(inv);
        chargeInvoice(inv, c);
        if (inv.status === 'open' && !(inv.charge && inv.charge.status === 'failed')) {
          billingMail(c, 'planinvoice', inv.charge && inv.charge.status === 'pending'
            ? `your LimoRelay invoice ${inv.number} for $${money(inv.total)} is ready. We're charging your card ending ${c.billingCard.last4}, so there's nothing to do.`
            : `your LimoRelay invoice ${inv.number} for $${money(inv.total)} is ready. Pay it or add a card for automatic payments under My account, Membership, at ${siteUrl()}#account.`);
        }
      }
      return made;
    }
    def('owner.runBilling', ['owner'], true, (ctx, a) => {
      const period = /^\d{4}-\d{2}$/.test(a.period || '') ? a.period : monthKey(now());
      return { created: billCompanies(period).length, period };
    });
    def('owner.billingSettings', ['owner'], true, (ctx, a) => {
      db.billing = { ...billingCfg(), autoBill: a.autoBill !== false };
      return billingCfg();
    });
    def('owner.billingInfo', ['owner'], false, () => ({ ...billingCfg(), payMode }));
    const memberInv = (i) => ({ id: i.id, number: i.number, period: i.period, items: clone(i.items), total: i.total, status: i.status, createdAt: i.createdAt, paidAt: i.paidAt, paidBy: i.paidBy || '', charge: i.charge ? { status: i.charge.status, error: i.charge.error || '', last4: i.charge.last4 || '' } : null });
    // The company admin's view of their own LimoRelay membership.
    def('company.membership', ['admin'], false, (ctx) => {
      payGate(ctx.user, ctx.token);
      const c = ctx.company, k = c.billingCard;
      return {
        ...planInfo(c), payMode, cardsOn: payMode === 'demo' || payMode === 'stripe', autoBill: billingCfg().autoBill,
        card: k ? { brand: k.brand, last4: k.last4, exp: k.exp, savedAt: k.savedAt } : null,
        invoices: db.invoices.filter((i) => i.companyId === c.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(memberInv),
      };
    });
    // Demo only: the live site saves cards and takes payment on Stripe's page.
    def('company.saveBillingCard', ['admin'], true, (ctx, a) => {
      payGate(ctx.user, ctx.token);
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Your card is saved on a secure Stripe page. Reload and try again.' : "Card payments aren't set up yet.");
      ctx.company.billingCard = demoCard(a, ctx.user.name);
      for (const inv of db.invoices.filter((i) => i.companyId === ctx.company.id && i.status === 'open')) { delete inv.charge; chargeInvoice(inv, ctx.company); }
      return { ok: true };
    });
    def('company.payInvoice', ['admin'], true, (ctx, a) => {
      payGate(ctx.user, ctx.token);
      if (payMode !== 'demo') fail(payMode === 'stripe' ? 'Payments open a secure Stripe page. Reload and tap Pay again.' : "Card payments aren't set up yet.");
      const inv = db.invoices.find((i) => i.id === a.id && i.companyId === ctx.company.id);
      if (!inv) fail('Invoice not found.', 404);
      if (inv.status === 'paid') fail('This invoice is already paid.');
      const k = demoCard(a, ctx.user.name);
      if (k.last4 === '0341') fail('Card declined. Try another card.');
      Object.assign(inv, { status: 'paid', paidAt: now().toISOString(), paidBy: `${k.brand} ending ${k.last4}` });
      return memberInv(inv);
    });
    // Master login and payment PIN.
    def('company.payLock', ['admin'], false, (ctx) => payLockState(ctx.user, ctx.token));
    const pinOk = (pin) => /^\d{4,6}$/.test(String(pin || ''));
    async function pinMatches(c, pin) { return !!c.paymentPin && (await hashPw(String(pin || ''), c.paymentPin.salt)) === c.paymentPin.hash; }
    function openPayments(ctx) { const s = db.sessions[ctx.token]; if (s) s.payUnlockedUntil = new Date(now().getTime() + PIN_OPEN_MIN * 6e4).toISOString(); }
    async function checkPin(ctx, pin) {
      const c = ctx.company;
      if (c.pinLockUntil && c.pinLockUntil > now().toISOString()) fail(`Too many wrong PINs. Try again after ${fmtLocal(c.pinLockUntil, c)}.`, 429);
      if (await pinMatches(c, pin)) { delete c.pinFails; delete c.pinLockUntil; return; }
      c.pinFails = (c.pinFails || 0) + 1;
      if (c.pinFails >= PIN_TRIES) {
        c.pinFails = 0; c.pinLockUntil = new Date(now().getTime() + PIN_LOCK_MIN * 6e4).toISOString();
        ctx.dirty = true; save(db);
        fail(`Too many wrong PINs. Payments are locked for ${PIN_LOCK_MIN} minutes.`, 429);
      }
      ctx.dirty = true; save(db);
      fail(`Wrong PIN. ${PIN_TRIES - c.pinFails} ${PIN_TRIES - c.pinFails === 1 ? 'try' : 'tries'} left.`, 400);
    }
    async function checkPassword(ctx, pw) {
      const c = ctx.company, u = ctx.user;
      if (c.pinLockUntil && c.pinLockUntil > now().toISOString()) fail(`Too many wrong tries. Try again after ${fmtLocal(c.pinLockUntil, c)}.`, 429);
      if (u.passHash && (await hashPw(String(pw || ''), u.salt)) === u.passHash) { delete c.pinFails; delete c.pinLockUntil; return; }
      c.pinFails = (c.pinFails || 0) + 1;
      if (c.pinFails >= PIN_TRIES) { c.pinFails = 0; c.pinLockUntil = new Date(now().getTime() + PIN_LOCK_MIN * 6e4).toISOString(); save(db); fail(`Too many wrong tries. Payments are locked for ${PIN_LOCK_MIN} minutes.`, 429); }
      save(db);
      fail('That password is not right.', 400);
    }
    def('company.setPayPin', ['admin'], true, async (ctx, a) => {
      const c = ctx.company;
      if (!isMaster(ctx.user)) fail('Only the master login can set the payment PIN.', 403);
      if (!pinOk(a.pin)) fail('Choose a PIN of 4 to 6 digits.');
      // Forgot the PIN: the master proves who they are with their login password.
      if (c.paymentPin && a.password != null) await checkPassword(ctx, a.password);
      else if (c.paymentPin) await checkPin(ctx, a.current);
      const salt = randomId(8);
      c.paymentPin = { salt, hash: await hashPw(String(a.pin), salt), setAt: now().toISOString(), by: ctx.user.name };
      openPayments(ctx);
      return payLockState(ctx.user, ctx.token);
    });
    def('company.unlockPayments', ['admin'], true, async (ctx, a) => {
      if (!isMaster(ctx.user)) fail('Only the master login can open payment settings.', 403);
      if (!ctx.company.paymentPin) fail('Set a payment PIN first.');
      await checkPin(ctx, a.pin);
      openPayments(ctx);
      return payLockState(ctx.user, ctx.token);
    });
    def('company.lockPayments', ['admin'], true, (ctx) => {
      const s = db.sessions[ctx.token]; if (s) delete s.payUnlockedUntil;
      return payLockState(ctx.user, ctx.token);
    });
    // The master hands the master login to another admin. The PIN is cleared
    // so the new master chooses their own.
    def('dispatch.makeMaster', ['admin'], true, (ctx, a) => {
      const c = ctx.company;
      payGate(ctx.user, ctx.token);
      const to = db.users.find((u) => u.id === a.id && u.companyId === c.id && u.role === 'admin' && u.active !== false);
      if (!to) fail('Only an active admin can be the master login.');
      if (to === ctx.user) fail('You are already the master login.');
      c.masterId = to.id;
      delete c.paymentPin; delete c.pinFails; delete c.pinLockUntil;
      for (const s of Object.values(db.sessions)) delete s.payUnlockedUntil;
      return { masterId: to.id };
    });
    // Runs from the server clock: invoices on the 1st and when a trial ends,
    // and a reminder 3 days before a trial ends for companies with no card.
    function billingTick() {
      let changed = false;
      const today = now().toISOString().slice(0, 10);
      if (billingCfg().autoBill && billCompanies(monthKey(now()), today).length) changed = true;
      for (const c of db.companies) {
        if (c.status !== 'active' || !c.trialEnds || c.billingCard || c.trialReminded === c.trialEnds) continue;
        const days = (new Date(c.trialEnds + 'T12:00:00Z').getTime() - new Date(today + 'T12:00:00Z').getTime()) / 864e5;
        if (days > 3 || days < 0) continue;
        c.trialReminded = c.trialEnds;
        const fee = c.billing === 'yearly' ? `$${money(c.monthlyFee * YEARLY_MONTHS)} a year` : `$${money(c.monthlyFee)} a month`;
        billingMail(c, 'billing', `your free LimoRelay trial for ${c.name} ends on ${c.trialEnds}. To keep going without a break, add a card under My account, Membership, at ${siteUrl()}#account. Your ${PLANS[c.plan].label} plan is ${fee}.`);
        changed = true;
      }
      return changed;
    }
    def('owner.markInvoice', ['owner'], true, (ctx, a) => {
      const inv = db.invoices.find((i) => i.id === a.id);
      if (!inv) fail('Invoice not found.', 404);
      inv.status = a.paid === false ? 'open' : 'paid';
      inv.paidAt = inv.status === 'paid' ? now().toISOString() : null;
      return clone(inv);
    });

    // ---- Dispatcher ---------------------------------------------------------
    async function call(token, method, args) {
      const m = M[method];
      if (!m) throw new ApiError('Unknown action.', 404);
      await ensure();
      const ctx = { token, user: null, company: null, dirty: false };
      if (m.roles !== 'public') {
        const s = token && db.sessions[token];
        const u = s && findUser(s.userId);
        if (!u || u.active === false) throw new ApiError('Please sign in again.', 401);
        ctx.user = u;
        ctx.company = u.companyId ? findCompany(u.companyId) : null;
        if (ctx.company && ctx.company.status !== 'active') throw new ApiError(`${ctx.company.name}'s account is paused.`, 403);
        if (m.roles !== 'any' && !m.roles.includes(u.role)) throw new ApiError("Your login can't do that.", 403);
        if (u.role === 'dispatcher' && PERM_OF[method] && !staffPerms(u)[PERM_OF[method]]) throw new ApiError(`Your access level doesn't include “${STAFF_PERMS[PERM_OF[method]].label.toLowerCase()}”. Ask your company admin.`, 403);
      }
      if (ctx.company && sweepDispatch(ctx.company)) ctx.dirty = true;
      const result = await m.fn(ctx, args || {});
      if (m.write) { if (ctx.company) sweepDispatch(ctx.company, true); syncFarmouts(); }
      if (m.write || ctx.dirty) { syncCredits(); meterTexts(); save(db); }
      return result;
    }

    // ---- Demo data ----------------------------------------------------------
    // A real business starts empty with just the platform owner's login.
    async function seedBlank() {
      const o = opts.owner || {};
      if (!o.email || !o.password) throw new Error('Set the owner email and password before the first start.');
      db = { version: SCHEMA_VERSION, seq: {}, sample: false, companies: [], users: [], vehicles: [], trips: [], messages: [], invoices: [], maintenance: [], timeOff: [], payouts: [], farmouts: [], netMessages: [], accounts: [], clientInvoices: [], quotes: [], sessions: {} };
      const u = { id: id('usr'), role: 'owner', companyId: null, name: str(o.name, 80) || 'Platform owner', email: str(o.email, 120).toLowerCase(), phone: '', active: true, createdAt: now().toISOString() };
      await setPassword(u, o.password);
      db.users.push(u);
      return db;
    }
    // Drawn stand-in portraits for the sample chauffeurs (real ones upload a photo).
    function sampleFace(bg, skin, hair, suit, long) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${bg}"/>`
        + (long ? `<path d="M34 58c0-22 11-34 26-34s26 12 26 34v26H34z" fill="${hair}"/>` : '')
        + `<path d="M18 120c2-24 18-36 42-36s40 12 42 36z" fill="${suit}"/><path d="M50 84l10 18 10-18z" fill="#f4f4f4"/><path d="M58 88l2 14 2-14z" fill="#2b2f38"/>`
        + `<rect x="52" y="68" width="16" height="18" rx="6" fill="${skin}"/><ellipse cx="60" cy="54" rx="19" ry="22" fill="${skin}"/>`
        + `<path d="M40 52c0-16 9-24 20-24s20 8 20 24c-4-8-10-12-20-12s-16 4-20 12z" fill="${hair}"/></svg>`;
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
    async function seed() {
      if (opts.blank) return seedBlank();
      db = { version: SCHEMA_VERSION, seq: {}, companies: [], users: [], vehicles: [], trips: [], messages: [], invoices: [], maintenance: [], timeOff: [], payouts: [], farmouts: [], netMessages: [], accounts: [], clientInvoices: [], sessions: {} };
      const t0 = now();
      const base = new Date(Math.round(t0.getTime() / (5 * 60000)) * 5 * 60000);
      const at = (mins) => new Date(base.getTime() + mins * 60000).toISOString();
      const day = (d) => new Date(base.getTime() + d * 86400000).toISOString().slice(0, 10);
      const PW = 'demo1234';
      const mkUser = async (o) => { const u = { id: id('usr'), active: true, createdAt: at(-60 * 24 * 40), ...o }; await setPassword(u, PW); db.users.push(u); return u; };
      const mkDriver = (o) => mkUser({ role: 'driver', payType: 'percent', payRate: 35, available: true, ...o });
      const mkCo = (o) => { const c = { id: id('co'), status: 'active', setupBilled: true, nextRef: 1000, rates: clone(DEFAULT_RATES), pricing: clone(DEFAULT_PRICING), flight: clone(DEFAULT_FLIGHT), network: { joined: true, areas: '', about: o.tagline || '', read: {} }, createdAt: at(-60 * 24 * 75), ...o }; db.companies.push(c); return c; };
      const mkVeh = (c, o) => { const v = { id: id('veh'), companyId: c.id, status: 'active', active: true, serviceEvery: 5000, registrationExp: day(240), insuranceExp: day(150), inspectionExp: day(200), ...o }; v.active = v.status === 'active'; db.vehicles.push(v); return v; };
      const mnt = (v, o) => db.maintenance.push({ id: id('mnt'), companyId: v.companyId, vehicleId: v.id, by: 'Nadia Hassan', vendor: '', notes: '', ...o });

      await mkUser({ role: 'owner', companyId: null, name: 'Platform Owner', email: 'owner@demo.com', phone: '' });

      const cap = mkCo({ slug: 'carina', name: 'Carina Ride', tagline: 'Chauffeured cars across Seattle, the Eastside and all three airports', color: '#7a2433', phone: '(206) 555-0147', email: 'book@carina.demo', plan: 'founding', monthlyFee: 49, setupFee: 0, billing: 'monthly', priceLockedUntil: at(60 * 24 * 655).slice(0, 10), refPrefix: 'CR', timezone: 'America/Los_Angeles' });
      cap.pricing.peakDates = [
        { id: id('peak'), date: day(3), label: 'Marathon weekend', pct: 25 },
        { id: id('peak'), date: `${base.getFullYear()}-12-31`, label: "New Year's Eve", pct: 50 },
      ];
      cap.pricing.promos = [
        { id: id('promo'), code: 'WELCOME10', type: 'percent', value: 10, active: true, expires: '', maxUses: 0, uses: 4 },
        { id: id('promo'), code: 'PROM25', type: 'amount', value: 25, active: true, expires: day(60), maxUses: 50, uses: 7 },
      ];
      const sClass = mkVeh(cap, { name: 'Cadillac CT6', type: 'Sedan', capacity: 3, plate: 'WA 4417', color: 'Black', year: 2020, vin: '1G6KB5RS4LU184417', odometer: 38210, lastServiceOdometer: 35400 });
      const esc = mkVeh(cap, { name: 'Lincoln Navigator', type: 'SUV', capacity: 6, plate: 'WA 8820', color: 'Black', year: 2024, vin: '5LMJJ3LT2REL08820', odometer: 21480, lastServiceOdometer: 20100, insuranceExp: day(12) });
      const yuk = mkVeh(cap, { name: 'Lincoln Navigator', type: 'SUV', capacity: 6, plate: 'WA 3091', color: 'Black', year: 2022, vin: '5LMJJ2LT8NEL03091', odometer: 61950, lastServiceOdometer: 56700, inspectionExp: day(-4) });
      const str8 = mkVeh(cap, { name: 'Ford Transit', type: 'Business Van', capacity: 10, plate: 'WA 1200', color: 'Black', year: 2023, vin: '1FBAX2CG5PKA01200', odometer: 74300, lastServiceOdometer: 71000 });
      const spr = mkVeh(cap, { name: 'Mercedes-Benz Sprinter', type: 'Sprinter Van', capacity: 14, plate: 'WA 7764', color: 'Black', year: 2023, vin: 'W1W4EBHY3PT127764', odometer: 44820, lastServiceOdometer: 40100 });
      const c300 = mkVeh(cap, { name: 'Cadillac CT6', type: 'Sedan', capacity: 3, plate: 'WA 5512', color: 'Silver', year: 2020, vin: '1G6KA5RS3LU105512', odometer: 98400, lastServiceOdometer: 95600, status: 'maintenance' });
      mnt(sClass, { date: day(-40), kind: 'Oil change', odometer: 35400, cost: 189, vendor: 'Mercedes-Benz of Seattle' });
      mnt(yuk, { date: day(-75), kind: 'Scheduled service', odometer: 56700, cost: 640, vendor: 'Lithia GMC Renton' });
      mnt(yuk, { date: day(-12), kind: 'Tires', odometer: 61200, cost: 1180, vendor: 'Tire Rack install', notes: 'Four new all-season tires' });
      mnt(spr, { date: day(-55), kind: 'Oil change', odometer: 40100, cost: 245, vendor: 'Mercedes-Benz Vans of Seattle' });
      mnt(c300, { date: day(-1), kind: 'Repair', odometer: 98400, cost: 2350, vendor: 'Cadillac of Bellevue', notes: 'Transmission service, back on Friday' });
      mnt(esc, { date: day(-20), kind: 'Detailing', odometer: 21200, cost: 160, vendor: 'Prestige Detail' });

      await mkUser({ role: 'admin', companyId: cap.id, name: 'Nadia Hassan', email: 'dispatch@carina.demo', phone: '(206) 555-0147' });
      // A night-shift dispatcher on the standard access level (everything but reports).
      await mkUser({ role: 'dispatcher', companyId: cap.id, name: 'Omar Haddad', email: 'nights@carina.demo', phone: '(206) 555-0149' });
      const marcus = await mkDriver({ companyId: cap.id, name: 'Marcus Bell', photo: sampleFace('#c9d6ea', '#8d5a3b', '#1d1612', '#1f2a44'), email: 'marcus@carina.demo', phone: '(206) 555-0181', vehicleId: sClass.id, licenseNumber: 'WA-B4471920', licenseExp: day(410), permitExp: day(190), hireDate: day(-900), payType: 'percent', payRate: 35 });
      const elena = await mkDriver({ companyId: cap.id, name: 'Elena Ruiz', photo: sampleFace('#ead9c9', '#d9a77f', '#3a2418', '#2b2f38', true), email: 'elena@carina.demo', phone: '(206) 555-0119', vehicleId: spr.id, licenseNumber: 'WA-T88213004', licenseExp: day(700), permitExp: day(320), hireDate: day(-420), payType: 'hourly', payRate: 28 });
      const tom = await mkDriver({ companyId: cap.id, name: 'Tom Okafor', photo: sampleFace('#d4e4d8', '#5c3a26', '#141010', '#22262e'), email: 'tom@carina.demo', phone: '(206) 555-0133', vehicleId: esc.id, licenseNumber: 'WA-O5521980', licenseExp: day(250), permitExp: day(19), hireDate: day(-200), payType: 'percent', payRate: 32 });
      const sam = await mkDriver({ companyId: cap.id, name: 'Sam Whitfield', email: 'sam@carina.demo', phone: '(206) 555-0166', vehicleId: str8.id, available: false, licenseNumber: 'WA-W2209381', licenseExp: day(90), permitExp: day(-6), hireDate: day(-1500), payType: 'perTrip', payRate: 60 });
      const jane = await mkUser({ role: 'customer', companyId: cap.id, name: 'Jane Porter', email: 'jane@demo.com', phone: '(206) 555-0102' });
      jane.prefs = { temp: 'cool', music: 'soft', quiet: true, signName: 'J. Porter' };
      const robert = await mkUser({ role: 'customer', companyId: cap.id, name: 'Robert Chen', email: 'robert@demo.com', phone: '(206) 555-0190' });
      const priya = await mkUser({ role: 'customer', companyId: cap.id, name: 'Priya Shah', email: 'travel@acme.demo', phone: '(206) 555-0175', account: 'Acme Corp', discountPct: 10, notes: 'Corporate account, invoice monthly' });

      const sum = mkCo({ slug: 'summit', name: 'Summit Black Car', tagline: 'Denver airport and mountain transfers', color: '#24584a', phone: '(303) 555-0120', email: 'rides@summit.demo', plan: 'standard', monthlyFee: 99, setupFee: 299, billing: 'monthly', refPrefix: 'SUM', timezone: 'America/Denver' });
      const sub = mkVeh(sum, { name: 'Chevrolet Suburban', type: 'SUV', capacity: 6, plate: 'CO 552-KRT', color: 'Black', year: 2023, odometer: 30500, lastServiceOdometer: 28000 });
      mkVeh(sum, { name: 'Lincoln Aviator', type: 'Sedan', capacity: 3, plate: 'CO 118-LMV', color: 'Grey', year: 2022, odometer: 41200, lastServiceOdometer: 40000 });
      await mkUser({ role: 'admin', companyId: sum.id, name: 'Greg Lindqvist', email: 'dispatch@summit.demo', phone: '(303) 555-0120' });
      const ana = await mkDriver({ companyId: sum.id, name: 'Ana Morales', photo: sampleFace('#e8d3dc', '#c68e66', '#2a1a12', '#1f2a44', true), email: 'ana@summit.demo', phone: '(303) 555-0144', vehicleId: sub.id, licenseExp: day(500), permitExp: day(300), hireDate: day(-300) });
      const kyle = await mkUser({ role: 'customer', companyId: sum.id, name: 'Kyle Dunn', email: 'kyle@demo.com', phone: '(720) 555-0108' });

      const trip = (c, cust, b, state) => {
        const t = newTrip(c, { service: 'transfer', hours: 3, passengers: 1, vehicleType: 'Sedan', flight: '', notes: '', passengerName: '', passengerPhone: '', passengerEmail: '', childSeats: 0, meetGreet: false, stops: 0, ...b, flight: normFlight(b.flight) || '' }, cust, state.source || 'online', cust ? cust.name : 'Office');
        t.createdAt = at(state.createdMin || -60 * 24);
        t.history[0].at = t.createdAt;
        const tl = (k) => at((state.createdMin || -1440) + 30 + k * 20);
        if (state.driver) { t.driverId = state.driver.id; t.vehicleId = state.vehicle.id; t.status = 'assigned'; t.history.push({ at: tl(0), status: 'assigned', by: 'Nadia Hassan' }); }
        const steps = ['accepted', 'en_route', 'arrived', 'on_board', 'completed'];
        const target = state.status || t.status;
        for (const s of steps) {
          if (t.status === target) break;
          t.status = s;
          // Arrivals land a few minutes before pickup so on-time stats look real.
          const when = s === 'arrived' ? new Date(new Date(t.pickupAt).getTime() - (state.late ? -12 : 6) * 60000).toISOString()
            : s === 'en_route' ? new Date(new Date(t.pickupAt).getTime() - 35 * 60000).toISOString()
            : s === 'on_board' ? new Date(new Date(t.pickupAt).getTime() + 4 * 60000).toISOString()
            : s === 'completed' ? new Date(new Date(t.pickupAt).getTime() + ((t.price.minutes || 40) + 5) * 60000).toISOString() : tl(1);
          t.history.push({ at: when, status: s, by: state.driver ? state.driver.name : '' });
        }
        if (state.cancel) { t.status = 'cancelled'; t.history.push({ at: at(-600), status: 'cancelled', by: cust ? cust.name : 'Office' }); }
        if (state.paid) t.payment = { status: 'paid', method: state.paid, paidAt: at(state.paidMin || -60) };
        if (state.waitMin || state.tolls) { t.waitMin = state.waitMin || 0; t.tolls = state.tolls || 0; reprice(t); }
        if (state.rating) t.rating = { stars: state.rating[0], comment: state.rating[1] || '', at: t.pickupAt };
        if (state.declinedBy) t.history.push({ at: tl(0), status: 'declined', by: state.declinedBy.name });
        return t;
      };

      // History for pay, ratings and on-time figures
      const pastRoutes = [
        ['Fairmont Olympic Hotel, 411 University St, Seattle, WA', 'Seattle-Tacoma International Airport (SEA)', 'Sedan', jane, marcus, sClass, [5, 'Marcus was early and the car was spotless.']],
        ['10500 NE 8th St, Bellevue, WA', 'Benaroya Hall, 200 University St, Seattle, WA', 'SUV', robert, elena, yuk, [4, '']],
        ['Acme Corp, 1201 3rd Ave, Seattle, WA', 'Seattle-Tacoma International Airport (SEA)', 'SUV', priya, tom, esc, [5, 'Smooth ride to the airport.']],
        ['Pike Place Market, 85 Pike St', 'King Street Station, 303 S Jackson St', 'Sedan', robert, marcus, sClass, [5, '']],
        ['Four Seasons Hotel Seattle, 99 Union St', 'Paine Field Airport (PAE), Everett', 'Sprinter Van', priya, elena, spr, [3, 'Driver took a long route.']],
        ['4210 E Madison St, Seattle, WA', 'Chateau Ste. Michelle, 14111 NE 145th St, Woodinville, WA', 'SUV', jane, tom, esc, null],
        ['The Westin Bellevue, 600 Bellevue Way NE, Bellevue', 'Seattle-Tacoma International Airport (SEA)', 'Sedan', jane, marcus, sClass, [5, 'Always reliable.']],
      ];
      pastRoutes.forEach(([pu, dr, vt, cust, drv, veh, rating], i) => {
        trip(cap, cust, { pickup: pu, dropoff: dr, pickupAt: at(-60 * 24 * (i + 1) - 60 * (2 + i)), vehicleType: vt, passengers: 2 }, { createdMin: -60 * 24 * (i + 4), driver: drv, vehicle: veh, status: 'completed', paid: 'card', paidMin: -60 * 24 * (i + 1), rating, late: i === 4, tolls: i % 2 ? 0 : 6.5 });
      });

      trip(cap, robert, { pickup: '10500 NE 8th St, Bellevue, WA', dropoff: 'Benaroya Hall, 200 University St, Seattle, WA', pickupAt: at(-185), vehicleType: 'SUV', passengers: 4 }, { createdMin: -60 * 30, driver: elena, vehicle: yuk, status: 'completed', paid: 'card', paidMin: -120, rating: [5, 'Elena was wonderful.'] });
      trip(cap, priya, { service: 'hourly', hours: 4, pickup: 'Acme Corp, 1201 3rd Ave, Seattle, WA', dropoff: '', pickupAt: at(-35), vehicleType: 'SUV', passengers: 3, notes: 'Client meetings downtown. Bill to Acme corporate account.' }, { createdMin: -60 * 48, driver: tom, vehicle: esc, status: 'on_board', source: 'phone' });
      trip(cap, jane, { pickup: 'Seattle-Tacoma International Airport (SEA), baggage claim 12', dropoff: '4210 E Madison St, Seattle, WA', pickupAt: at(25), vehicleType: 'Sedan', passengers: 1, bags: 2, flight: 'AS 1342', meetGreet: true, signName: 'J. Porter', prefs: { temp: 'cool', music: 'soft', quiet: true }, notes: 'Meet at baggage claim with a name sign.' }, { createdMin: -60 * 26, driver: marcus, vehicle: sClass, status: 'en_route' });
      trip(cap, null, { pickup: 'The Edgewater Hotel, 2411 Alaskan Way, Seattle, WA', dropoff: 'The Woodmark Hotel, 1200 Carillon Point, Kirkland, WA', pickupAt: at(95), vehicleType: 'Sprinter Van', passengers: 12, stops: 1, stopList: ['St. James Cathedral, 804 9th Ave, Seattle, WA'], bags: 0, passengerName: 'David & Amara wedding party', passengerPhone: '(425) 555-0157', notes: 'Wedding guests. Water and ice on board.' }, { createdMin: -60 * 24 * 20, driver: elena, vehicle: spr, source: 'phone' });
      trip(cap, robert, { service: 'hourly', hours: 4, pickup: '10500 NE 8th St, Bellevue, WA', dropoff: '', pickupAt: at(150), vehicleType: 'Business Van', passengers: 8, notes: 'Anniversary dinner and city lights tour.' }, { createdMin: -60 * 10, declinedBy: sam });
      trip(cap, null, { pickup: 'Seattle-Tacoma International Airport (SEA), main terminal', dropoff: 'Four Seasons Hotel Seattle, 99 Union St', pickupAt: at(140), vehicleType: 'SUV', passengers: 2, passengerName: 'Mr. & Mrs. Alvarez', passengerPhone: '(206) 555-0193', flight: 'BA 293', childSeats: 1 }, { createdMin: -60 * 3, source: 'phone' });
      trip(cap, null, { pickup: 'Seattle-Tacoma International Airport (SEA), arrivals', dropoff: 'Hotel Max, 620 Stewart St', pickupAt: at(200), vehicleType: 'Sedan', passengers: 1, passengerName: 'Dr. Lena Okoye', passengerPhone: '(617) 555-0122', flight: 'AS 331' }, { createdMin: -60 * 7, source: 'phone' });
      trip(cap, null, { pickup: 'Inn at the Market, 86 Pine St, Seattle, WA', dropoff: 'Seattle-Tacoma International Airport (SEA), arrivals', pickupAt: at(150), vehicleType: 'Sedan', passengers: 1, passengerName: 'Michael Chen', passengerPhone: '(206) 555-0166', notes: 'Booked online. Auto-dispatch picks the driver.' }, { createdMin: -12 });
      trip(cap, jane, { pickup: '4210 E Madison St, Seattle, WA', dropoff: 'King Street Station, 303 S Jackson St, Seattle, WA', pickupAt: at(300), vehicleType: 'Sedan', passengers: 1 }, { createdMin: -40, driver: marcus, vehicle: sClass });
      trip(cap, priya, { pickup: 'Paine Field Airport (PAE), Everett', dropoff: 'Acme Corp, 1201 3rd Ave, Seattle, WA', pickupAt: at(60 * 24 + 120), vehicleType: 'SUV', passengers: 4, flight: 'AS 2207' }, { createdMin: -60 * 5, driver: marcus, vehicle: esc, status: 'accepted', source: 'phone' });
      trip(cap, jane, { pickup: '4210 E Madison St, Seattle, WA', dropoff: 'The Herbfarm, 14590 NE 145th St, Woodinville, WA', pickupAt: at(60 * 24 + 480), vehicleType: 'SUV', passengers: 4, notes: 'Dinner reservation at 7:30.' }, { createdMin: -30 });
      trip(cap, robert, { pickup: '10500 NE 8th St, Bellevue, WA', dropoff: 'Climate Pledge Arena, 334 1st Ave N', pickupAt: at(-60 * 24 * 2), vehicleType: 'SUV', passengers: 3 }, { createdMin: -60 * 24 * 4, cancel: true });

      // Four months of older trips so reports have something to show.
      {
        let r = 7; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
        const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
        const spots = ['Fairmont Olympic Hotel, 411 University St, Seattle, WA', '10500 NE 8th St, Bellevue, WA', 'Pike Place Market, 85 Pike St', 'Four Seasons Hotel Seattle, 99 Union St', 'The Westin Bellevue, 600 Bellevue Way NE, Bellevue', 'King Street Station, 303 S Jackson St', 'Benaroya Hall, 200 University St, Seattle, WA', '4210 E Madison St, Seattle, WA'];
        const airports = ['Seattle-Tacoma International Airport (SEA)', 'Seattle-Tacoma International Airport (SEA)', 'Paine Field Airport (PAE), Everett'];
        const crew = [[marcus, sClass, 'Sedan'], [marcus, sClass, 'Sedan'], [elena, spr, 'Sprinter Van'], [tom, esc, 'SUV'], [tom, esc, 'SUV'], [sam, str8, 'Business Van'], [elena, yuk, 'SUV']];
        const walkIns = ['Karen Mills', 'Ahmed Saleh', 'Olivia Grant', 'Peter Novak', 'Hannah Lee', 'Carlos Vega', 'Rachel Stone', 'Victor Osei'];
        for (let d = 120; d >= 8; d--) {
          const wd = new Date(base.getTime() - d * 86400000).getDay();
          // Busier on Thursday to Saturday, and business grows over time.
          const n = Math.floor(rnd() * 2.2 + (wd >= 4 && wd <= 6 ? 1.2 : 0.4) + (120 - d) / 90);
          for (let k = 0; k < n; k++) {
            const [drv, veh, vt] = pick(crew);
            const cust = rnd() < 0.35 ? pick([jane, robert]) : null;
            const toAir = rnd() < 0.55, hourly = !toAir && rnd() < 0.18;
            const pu = pick(spots), when = -60 * 24 * d + 60 * (7 + Math.floor(rnd() * 13) - 12) + 5 * Math.floor(rnd() * 12);
            const roll = rnd();
            trip(cap, cust, { service: hourly ? 'hourly' : 'transfer', hours: hourly ? 3 + Math.floor(rnd() * 3) : 3, pickup: pu, dropoff: hourly ? '' : toAir ? pick(airports) : pick(spots.filter((x) => x !== pu)), pickupAt: at(when), vehicleType: vt, passengers: vt === 'Sedan' ? 1 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 6), passengerName: cust ? '' : pick(walkIns), passengerPhone: cust ? '' : '(206) 555-01' + String(10 + Math.floor(rnd() * 89)) },
              roll < 0.04 ? { createdMin: when - 60 * 24 * 2, cancel: true }
                : { createdMin: when - 60 * 24 * (1 + Math.floor(rnd() * 6)), source: rnd() < 0.3 ? 'phone' : 'online', driver: drv, vehicle: veh, status: 'completed', paid: 'card', paidMin: when + 90, late: rnd() < 0.08, tolls: toAir && rnd() < 0.5 ? 6.5 : 0, rating: rnd() < 0.45 ? [rnd() < 0.8 ? 5 : 4, ''] : null });
          }
        }
      }

      trip(sum, kyle, { pickup: 'Denver International Airport (DEN), East terminal', dropoff: 'The Little Nell, 675 E Durant Ave, Aspen, CO', pickupAt: at(70), vehicleType: 'SUV', passengers: 4, flight: 'WN 3381' }, { createdMin: -60 * 24, driver: ana, vehicle: sub, status: 'accepted' });
      trip(sum, kyle, { pickup: 'The Little Nell, 675 E Durant Ave, Aspen, CO', dropoff: 'Denver International Airport (DEN)', pickupAt: at(60 * 24 * 4), vehicleType: 'SUV', passengers: 4 }, { createdMin: -60 * 24 });


      // A second Seattle-area company so the network has a local partner.
      const pot = mkCo({ slug: 'pugetsound', name: 'Puget Sound Executive Cars', tagline: 'Executive sedans and SUVs for Seattle, the Eastside and Tacoma', color: '#1f4e79', phone: '(425) 555-0188', email: 'ops@pugetsound.demo', plan: 'fleet', monthlyFee: 199, setupFee: 299, billing: 'yearly', paidThrough: '', refPrefix: 'PSE', timezone: 'America/Los_Angeles' });
      const eCls = mkVeh(pot, { name: 'Mercedes-Benz E-Class', type: 'Sedan', capacity: 3, plate: 'WA 7Y2031', color: 'Black', year: 2023, odometer: 27400, lastServiceOdometer: 25000 });
      const tahoe = mkVeh(pot, { name: 'Chevrolet Tahoe', type: 'SUV', capacity: 6, plate: 'WA 9K4410', color: 'Black', year: 2024, odometer: 15800, lastServiceOdometer: 15000 });
      mkVeh(pot, { name: 'Ford Transit Executive', type: 'Sprinter Van', capacity: 12, plate: 'WA TRN-88', color: 'Black', year: 2022, odometer: 52100, lastServiceOdometer: 50000 });
      mkVeh(pot, { name: 'Freightliner Party Bus', type: 'Party Bus', capacity: 30, plate: 'WA BUS-30', color: 'White', year: 2020, odometer: 88200, lastServiceOdometer: 86000 });
      await mkUser({ role: 'admin', companyId: pot.id, name: 'Grace Lin', email: 'dispatch@pugetsound.demo', phone: '(425) 555-0188' });
      const james = await mkDriver({ companyId: pot.id, name: 'James Carter', photo: sampleFace('#dcdcef', '#f0c8a8', '#7a5532', '#2b2f38'), email: 'james@pugetsound.demo', phone: '(425) 555-0124', vehicleId: tahoe.id, licenseExp: day(600), permitExp: day(240), hireDate: day(-700) });
      const omar = await mkDriver({ companyId: pot.id, name: 'Omar Haddad', photo: sampleFace('#efe2c8', '#b9835c', '#1a1410', '#1d2230'), email: 'omar@pugetsound.demo', phone: '(425) 555-0139', vehicleId: eCls.id, licenseExp: day(380), permitExp: day(150), hireDate: day(-260) });
      cap.network.areas = 'Seattle, Bellevue, Redmond, Tacoma and Everett; SEA, Boeing Field and Paine Field';
      pot.network.areas = 'Seattle, Bellevue, Tacoma, Everett and SEA airport';
      sum.network.areas = 'Denver, Boulder, Vail, Aspen, Breckenridge, DEN airport';

      // Farm-outs between the companies, in different stages.
      const farm = (parent, to, rate, note, stage, o = {}) => {
        const from = findCompany(parent.companyId);
        const f = { id: id('farm'), fromCompanyId: from.id, fromName: from.name, toCompanyId: to.id, toName: to.name, tripId: parent.id, ref: parent.ref, childTripId: null, rate, note, status: 'offered', createdAt: parent.createdAt, by: o.by || 'Office' };
        db.farmouts.push(f);
        setFarm(f, 'offered', f.by, `Offered to ${to.name} for $${money(rate)}`);
        netNote(from, to, `New trip offer ${parent.ref}: ${fmtLocal(parent.pickupAt, to, true)}, ${parent.vehicleType}, ${parent.passengers} pax, from ${parent.pickup}. Pays $${money(rate)}.`, f.id);
        if (stage === 'declined') { f.reason = o.reason || ''; setFarm(f, 'declined', to.name, f.reason); netNote(to, from, `${to.name} declined ${f.ref}: ${f.reason}`, f.id); }
        if (stage === 'accepted' || stage === 'completed') {
          to.nextRef = (to.nextRef || 1000) + 1;
          const child = { ...clone(parent), id: id('trip'), ref: `${to.refPrefix}-${to.nextRef}`, companyId: to.id, customerId: null, passengerEmail: '', status: 'confirmed', driverId: null, vehicleId: null, rating: null, farmout: null, affiliate: null, autoFarm: null,
            farmIn: { id: f.id, fromCompanyId: from.id, fromName: from.name, fromPhone: from.phone, fromRef: f.ref }, waitMin: 0, tolls: 0, adjustment: null, priceOverride: rate, priceCtx: {}, payment: { status: 'unpaid', method: null, paidAt: null }, source: 'partner', history: [] };
          reprice(child); log(child, 'confirmed', to.name, `From ${from.name} (${f.ref})`);
          db.trips.push(child); f.childTripId = child.id;
          setFarm(f, 'accepted', to.name);
          netNote(to, from, `${to.name} accepted ${f.ref}. Their reference is ${child.ref}.`, f.id);
          if (o.driver) { child.driverId = o.driver.id; child.vehicleId = o.vehicle.id; child.status = o.childStatus || 'assigned'; log(child, child.status, o.driver.name); }
          if (stage === 'completed') { child.status = 'completed'; }
          syncFarmouts();
          if (o.settled) { f.settledAt = at(-60 * 24); child.payment = { status: 'paid', method: 'partner', paidAt: f.settledAt }; }
        }
        return f;
      };
      const fo1 = trip(cap, robert, { pickup: '10500 NE 8th St, Bellevue, WA', dropoff: 'Paine Field Airport (PAE), Everett', pickupAt: at(240), vehicleType: 'SUV', passengers: 3 }, { createdMin: -60 * 20 });
      farm(fo1, pot, 120, 'All our SUVs are out this afternoon. Customer prefers a quiet ride.', 'accepted', { driver: james, vehicle: tahoe, childStatus: 'accepted', by: 'Nadia Hassan' });
      const fo2 = trip(cap, jane, { pickup: 'King Street Station, 303 S Jackson St, Seattle, WA', dropoff: 'Tulalip Resort Casino, 10200 Quil Ceda Blvd, Tulalip, WA', pickupAt: at(-60 * 24 * 3), vehicleType: 'Sedan', passengers: 2 }, { createdMin: -60 * 24 * 5, paid: 'card', paidMin: -60 * 24 * 3 });
      farm(fo2, pot, 95, '', 'completed', { driver: omar, vehicle: eCls, by: 'Nadia Hassan' });
      const fo3 = trip(pot, null, { pickup: 'Seattle-Tacoma International Airport (SEA)', dropoff: 'Hotel Sorrento, 900 Madison St, Seattle, WA', pickupAt: at(-60 * 24 * 6), vehicleType: 'Business Van', passengers: 8, flight: 'DL 2041', passengerName: 'Okafor anniversary party', passengerPhone: '(425) 555-0170' }, { createdMin: -60 * 24 * 9, source: 'phone' });
      farm(fo3, cap, 260, 'We do not have a 10-seat van free. Thank you!', 'completed', { driver: sam, vehicle: str8, settled: true, by: 'Grace Lin' });
      const fo4 = trip(sum, kyle, { pickup: 'Seattle-Tacoma International Airport (SEA), arrivals', dropoff: 'Four Seasons Hotel Seattle, 99 Union St, Seattle, WA', pickupAt: at(60 * 24 + 300), vehicleType: 'SUV', passengers: 2, flight: 'UA 1517', meetGreet: true, notes: 'Our regular client from Denver, travelling for work.' }, { createdMin: -90 });
      farm(fo4, cap, 140, 'Our client is flying into Seattle tomorrow. Could you cover the airport pickup?', 'offered', { by: 'Greg Lindqvist' });
      const fo5 = trip(cap, priya, { service: 'hourly', hours: 6, pickup: 'Acme Corp, 1201 3rd Ave, Seattle, WA', dropoff: '', pickupAt: at(60 * 24 * 2), vehicleType: 'Party Bus', passengers: 24 }, { createdMin: -60 * 30, source: 'phone' });
      farm(fo5, pot, Math.round(fo5.price.total * 0.8), 'Company offsite, party bus for the day.', 'declined', { reason: 'Our party bus is booked for a wedding that day.', by: 'Nadia Hassan' });
      db.netMessages.push({ id: id('nm'), fromCompanyId: pot.id, toCompanyId: cap.id, farmoutId: null, text: 'Hi Nadia, we have two Tahoes free this weekend if you need cover for the marathon.', by: 'Grace Lin', system: false, at: at(-60 * 5) });
      db.netMessages.push({ id: id('nm'), fromCompanyId: cap.id, toCompanyId: pot.id, farmoutId: null, text: 'Thanks Grace, I will send anything we cannot cover. Same rates as last month?', by: 'Nadia Hassan', system: false, at: at(-60 * 4) });
      db.netMessages.push({ id: id('nm'), fromCompanyId: pot.id, toCompanyId: cap.id, farmoutId: null, text: 'Yes, same rates. SUV airport runs at $120.', by: 'Grace Lin', system: false, at: at(-60 * 3) });
      cap.network.read = { [pot.id]: at(-60 * 4) };

      // Trips already on the way get a tracking session that started when the driver set off.
      for (const t of db.trips) if (t.status === 'en_route') { startTracking(t); const h = t.history.filter((x) => x.status === 'en_route').pop(); if (h) t.tracking.startedAt = h.at; }

      // Carina Ride uses auto-dispatch for trips in the next 3 hours; drivers waiting
      // to accept get a running timer.
      cap.dispatch = { ...DEFAULT_DISPATCH, autoAssign: true, horizonHours: 3 };
      // Corporate accounts. Acme's past trips are on an invoice that's now overdue;
      // the latest ones are waiting for the next invoice.
      normalize(db);
      const acme = db.accounts.find((x) => x.companyId === cap.id && x.name === 'Acme Corp');
      Object.assign(acme, { contact: 'Accounts Payable', billingEmail: 'ap@acme.demo', address: '1201 3rd Ave, Seattle, WA 98101', terms: 30, notes: 'Monthly invoice. PO optional.' });
      db.accounts.push({ id: id('acct'), companyId: cap.id, name: 'Seattle U Law Events', contact: 'Maria Lopez', billingEmail: 'events@gtlaw.demo', phone: '(206) 555-0133', address: '901 12th Ave, Seattle, WA 98122', terms: 15, discountPct: 5, requirePo: true, notes: 'PO required on every trip.', active: true, createdAt: at(-60 * 24 * 40) });
      const dan = await mkUser({ role: 'customer', companyId: cap.id, name: 'Daniel Kim', email: 'dkim@acme.demo', phone: '(206) 555-0182', accountId: acme.id });
      const acmeTrip = (who, b, st) => { const t = trip(cap, who, { vehicleType: 'Sedan', passengers: 1, ...b }, { source: 'online', ...st }); return t; };
      acmeTrip(dan, { pickup: 'Acme Corp, 1201 3rd Ave, Seattle, WA', dropoff: 'Seattle-Tacoma International Airport (SEA), arrivals', pickupAt: at(-60 * 24 * 46 - 300) }, { createdMin: -60 * 24 * 48, driver: marcus, vehicle: sClass, status: 'completed' });
      acmeTrip(priya, { pickup: 'Seattle-Tacoma International Airport (SEA), main terminal', dropoff: 'Acme Corp, 1201 3rd Ave, Seattle, WA', pickupAt: at(-60 * 24 * 43 - 120), vehicleType: 'SUV', passengers: 3, flight: 'UA 921' }, { createdMin: -60 * 24 * 45, driver: elena, vehicle: yuk, status: 'completed' });
      acmeTrip(dan, { service: 'hourly', hours: 3, pickup: 'Acme Corp, 1201 3rd Ave, Seattle, WA', dropoff: '', pickupAt: at(-60 * 24 * 40 - 240), vehicleType: 'SUV', passengers: 4 }, { createdMin: -60 * 24 * 41, driver: tom, vehicle: esc, status: 'completed' });
      acmeTrip(dan, { pickup: 'King Street Station, 303 S Jackson St, Seattle, WA', dropoff: 'Acme Corp, 1201 3rd Ave, Seattle, WA', pickupAt: at(-60 * 24 * 4 - 200) }, { createdMin: -60 * 24 * 5, driver: marcus, vehicle: sClass, status: 'completed' });
      acmeTrip(priya, { pickup: 'Acme Corp, 1201 3rd Ave, Seattle, WA', dropoff: 'Paine Field Airport (PAE), Everett', pickupAt: at(-60 * 24 * 2 - 90), vehicleType: 'SUV', passengers: 2 }, { createdMin: -60 * 24 * 3, driver: elena, vehicle: yuk, status: 'completed' });
      for (const t of db.trips) if (t.companyId === cap.id && (t.customerId === priya.id || t.customerId === dan.id)) {
        t.accountId = acme.id; t.costCenter = t.customerId === dan.id ? 'Business development' : 'Sales'; t.poNumber = t.service === 'hourly' ? 'PO-44120' : '';
        t.payment = { status: 'unpaid', method: 'account', paidAt: null };
      }
      const issued = new Date(t0.getTime() - 38 * 86400e3);
      const oldOnes = db.trips.filter((t) => t.accountId === acme.id && t.status === 'completed' && new Date(t.pickupAt) < issued).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
      if (oldOnes.length) {
        cap.nextInvoice = 1;
        const lines = oldOnes.map((t) => ({ tripId: t.id, ref: t.ref, date: t.pickupAt, passenger: t.passengerName, route: t.dropoff ? `${t.pickup} to ${t.dropoff}` : `${t.pickup} (${t.hours} h)`, vehicle: t.vehicleType, po: t.poNumber, costCenter: t.costCenter, amount: t.price.total }));
        const inv = { id: id('cinv'), companyId: cap.id, accountId: acme.id, number: `${cap.refPrefix}-INV-0001`, from: lines[0].date, through: lines[lines.length - 1].date.slice(0, 10), lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)), terms: 30, issuedAt: issued.toISOString(), dueAt: new Date(issued.getTime() + 30 * 86400e3).toISOString(), status: 'open', paidAt: null, sentTo: 'ap@acme.demo', sentAt: issued.toISOString(), by: 'Nadia Hassan' };
        db.clientInvoices.push(inv);
        for (const t of oldOnes) { t.invoiceId = inv.id; t.payment = { status: 'unpaid', method: 'account', paidAt: null }; }
      }
      // Event quotes in each stage: a new wedding request, a prom quote sent to
      // Jane, a corporate event already booked, and one the customer turned down.
      {
        const dayAt = (d, hh, mm) => { const x = new Date(base.getTime() + d * 86400000); x.setHours(hh, mm || 0, 0, 0); return x.toISOString(); };
        const priceUp = (q) => { const v = quoteView(q, true); q.lines.forEach((l, i) => { l.unitPrice = Math.round((v.lines[i].suggested || 200) / 5) * 5; }); };
        const stamp = (q, mins) => { q.createdAt = at(mins); q.history.forEach((h) => { h.at = q.createdAt; }); };
        const wed = newQuote(cap, { contact: { name: 'Emily Hughes', phone: '(206) 555-0161', email: 'emily.hughes@example.com' }, eventType: 'Wedding', eventName: 'Hughes & Patel wedding', notes: 'Ceremony at 3 pm, reception until 11. Would love a white car for the couple if you have one.',
          lines: [
            { service: 'transfer', pickup: 'Fairmont Olympic Hotel, 411 University St, Seattle, WA', dropoff: 'St. James Cathedral, 804 9th Ave, Seattle', pickupAt: dayAt(23, 14, 15), vehicleType: 'SUV', count: 2, passengers: 8, notes: 'Bridal party', phone: '(206) 555-0148' },
            { service: 'hourly', hours: 5, pickup: 'St. James Cathedral, 804 9th Ave, Seattle', pickupAt: dayAt(23, 16, 30), vehicleType: 'Sprinter Van', count: 2, passengers: 26, notes: 'Guests to the reception and back to hotels' },
          ] }, 'online', null, null);
        stamp(wed, -95);
        const prom = newQuote(cap, { contact: { name: jane.name, phone: jane.phone, email: jane.email }, eventType: 'Prom or homecoming', eventName: 'Garfield High prom', notes: 'Eight students, pickup at our house for photos first.',
          lines: [{ service: 'hourly', hours: 5, pickup: '4210 E Madison St, Seattle, WA', pickupAt: dayAt(16, 17, 30), vehicleType: 'Business Van', count: 1, passengers: 8 }] }, 'online', jane, null);
        stamp(prom, -60 * 30); priceUp(prom);
        prom.message = 'Includes a red carpet at pickup and soft drinks on board. No alcohol for under-21 riders.';
        prom.status = 'sent'; prom.sentAt = at(-60 * 26); prom.validUntil = day(5);
        prom.history.push({ at: prom.sentAt, what: 'Sent to the customer', by: 'Nadia Hassan' });
        const corp = newQuote(cap, { contact: { name: 'Marcus Dlamini', phone: '(206) 555-0177', email: 'events@hartwell.demo', org: 'Hartwell Capital' }, eventType: 'Corporate event', eventName: 'Hartwell Capital partner offsite', notes: 'Partners arriving by train, then dinner.',
          lines: [
            { service: 'transfer', pickup: 'King Street Station, 303 S Jackson St, Seattle, WA', dropoff: 'Salish Lodge & Spa, 6501 Railroad Ave SE, Snoqualmie, WA', pickupAt: dayAt(9, 10, 0), vehicleType: 'SUV', count: 2, passengers: 9 },
            { service: 'transfer', pickup: 'Salish Lodge & Spa, 6501 Railroad Ave SE, Snoqualmie, WA', dropoff: 'King Street Station, 303 S Jackson St, Seattle, WA', pickupAt: dayAt(10, 15, 0), vehicleType: 'SUV', count: 2, passengers: 9 },
          ] }, 'phone', null, 'Nadia Hassan');
        stamp(corp, -60 * 24 * 6); priceUp(corp); corp.validUntil = day(1); corp.sentAt = at(-60 * 24 * 5);
        corp.history.push({ at: corp.sentAt, what: 'Sent to the customer', by: 'Nadia Hassan' });
        corp.status = 'sent';
        corp.decidedAt = at(-60 * 24 * 4);
        bookQuote(corp, 'Marcus Dlamini', { brand: 'Visa', last4: '1881', exp: '08/28', savedAt: corp.decidedAt, by: 'Marcus Dlamini' });
        corp.decidedAt = at(-60 * 24 * 4);
        corp.history.push({ at: corp.decidedAt, what: 'Accepted online by Marcus Dlamini, card ending 1881 saved', by: 'Marcus Dlamini' });
        for (const tid of corp.tripIds) { const t = db.trips.find((x) => x.id === tid); t.createdAt = corp.decidedAt; t.history[0].at = corp.decidedAt; }
        const night = newQuote(cap, { contact: { name: 'Tyler Brooks', phone: '(206) 555-0109', email: '' }, eventType: 'Night out', eventName: 'Birthday bar crawl',
          lines: [{ service: 'hourly', hours: 4, pickup: '10500 NE 8th St, Bellevue, WA', pickupAt: dayAt(4, 20, 0), vehicleType: 'Sprinter Van', count: 1, passengers: 12 }] }, 'online', null, null);
        stamp(night, -60 * 24 * 3); priceUp(night); night.status = 'declined'; night.sentAt = at(-60 * 24 * 3 + 120); night.decidedAt = at(-60 * 24 * 2); night.declineReason = 'A bit over budget for us this time.';
        night.history.push({ at: night.sentAt, what: 'Sent to the customer', by: 'Nadia Hassan' }, { at: night.decidedAt, what: 'Declined by the customer: A bit over budget for us this time.', by: 'Tyler Brooks' });
        // The request texts were for the live flow; keep the log tidy with the ones that matter.
        db.messages = db.messages.filter((m) => !(m.kind === 'quote' && m.quoteId !== corp.id));
      }
      // A business account that saves its 6% as credit for the booker's personal rides.
      {
        const nl = { id: id('acct'), companyId: cap.id, name: 'Northlake Architects', contact: 'Owen Park', billingEmail: 'accounts@northlake.demo', phone: '(206) 555-0124', address: '3400 Stone Way N, Seattle, WA 98103', terms: 30, discountPct: 6, reward: 'credit', rewardSince: at(-60 * 24 * 60), requirePo: false, notes: 'Owen books client visits; his 6% goes to credit.', active: true, createdAt: at(-60 * 24 * 60) };
        db.accounts.push(nl);
        const owen = await mkUser({ role: 'customer', companyId: cap.id, name: 'Owen Park', email: 'owen@northlake.demo', phone: '(206) 555-0124', accountId: nl.id });
        for (const [d, pu, dr, vt] of [[21, 'Northlake Architects, 3400 Stone Way N, Seattle, WA', 'Seattle-Tacoma International Airport (SEA), main terminal', 'Sedan'], [12, 'Seattle-Tacoma International Airport (SEA), main terminal', 'Northlake Architects, 3400 Stone Way N, Seattle, WA', 'Sedan'], [5, 'Northlake Architects, 3400 Stone Way N, Seattle, WA', 'Bellevue Square, 575 Bellevue Square, Bellevue, WA', 'SUV']]) {
          const t = trip(cap, owen, { pickup: pu, dropoff: dr, pickupAt: at(-60 * 24 * d), vehicleType: vt, passengers: 1 }, { createdMin: -60 * 24 * (d + 2), driver: marcus, vehicle: sClass, status: 'completed', source: 'online' });
          t.accountId = nl.id; t.payment = { status: 'unpaid', method: 'account', paidAt: null };
        }
        syncCredits();
      }
      // Booked days ahead for tomorrow morning, so the 24-hour reminder goes out.
      trip(cap, null, { pickup: 'Hotel Sorrento, 900 Madison St, Seattle, WA', dropoff: 'Seattle-Tacoma International Airport (SEA), main terminal', pickupAt: at(60 * 22), vehicleType: 'SUV', passengers: 2, passengerName: 'Laura Bennett', passengerPhone: '(206) 555-0148', passengerEmail: 'laura.bennett@example.com', notes: 'Two large suitcases.' }, { createdMin: -60 * 24 * 3, source: 'phone' });
      // The latest finished trip without a rating gets its review request.
      const lastDone = db.trips.filter((t) => t.companyId === cap.id && t.status === 'completed' && !t.rating && !t.farmIn).sort((x, y) => y.pickupAt.localeCompare(x.pickupAt))[0];
      if (lastDone) notify(lastDone, 'completed');
      for (const t of db.trips) if (t.status === 'assigned' && t.driverId) t.offer = { driverId: t.driverId, sentAt: at(-6), expiresAt: at(14) };

      // Run the flight monitor once so delays show up straight away.
      for (const c of [cap, sum, pot]) monitorFlights(c, true);

      // Last month's platform invoices, already paid.
      const last = new Date(base.getFullYear(), base.getMonth() - 1, 1);
      const period = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
      for (const c of [cap, sum]) {
        const inv = { id: id('inv'), number: `INV-${period.replace('-', '')}-${String((db.seq.inv || 0) + 1).padStart(3, '0')}`, companyId: c.id, period, items: [{ label: `${PLANS[c.plan].label} plan, ${period}`, amount: c.monthlyFee }], total: c.monthlyFee, status: 'paid', createdAt: new Date(last.getFullYear(), last.getMonth(), 1, 9).toISOString(), paidAt: new Date(last.getFullYear(), last.getMonth(), 4, 9).toISOString() };
        id('inv');
        db.invoices.push(inv);
      }
      // Puget Sound pays yearly: one invoice for 12 months at the price of 10.
      {
        const from = new Date(base.getFullYear(), base.getMonth() - 2, 1);
        const fp = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
        const through = addMonths(`${fp}-15T12:00:00Z`, 11).slice(0, 7);
        const amt = round2(pot.monthlyFee * YEARLY_MONTHS);
        db.invoices.push({ id: id('inv'), number: `INV-${fp.replace('-', '')}-${String((db.seq.inv || 0) + 1).padStart(3, '0')}`, companyId: pot.id, period: fp, items: [{ label: `${PLANS.fleet.label} plan, yearly ${fp} to ${through} (2 months free)`, amount: amt }], total: amt, status: 'paid', createdAt: new Date(from.getFullYear(), from.getMonth(), 1, 9).toISOString(), paidAt: new Date(from.getFullYear(), from.getMonth(), 3, 9).toISOString() });
        id('inv'); pot.paidThrough = through;
      }
      // Cards on file: every sample customer has one and fares inside the charge
      // window were already charged. One phone booking still needs a card and
      // one card was declined, so the office sees both cases.
      const brands = [['Visa', '4242'], ['Mastercard', '4444'], ['Amex', '0005'], ['Visa', '1117']];
      const seedCard = (who, k, when) => ({ brand: brands[k % 4][0], last4: brands[k % 4][1], exp: '09/29', savedAt: when, by: who });
      let needCard = false, declined = false;
      for (const t of db.trips.slice().sort((x, y) => x.pickupAt.localeCompare(y.pickupAt))) {
        if (!onFile(t) || t.companyId !== cap.id) continue;
        const cu = t.customerId && findUser(t.customerId);
        if (cu && !cu.card) cu.card = seedCard(cu.name, fnv(cu.id), at(-60 * 24 * 40));
        const open = !['completed', 'cancelled'].includes(t.status), due = new Date(chargeAt(t)).getTime() <= now().getTime();
        if (!t.card && !cu && open && !due && !needCard) { needCard = true; continue; }
        if (!t.card) t.card = cu ? clone(cu.card) : seedCard(t.passengerName || 'Passenger', fnv(t.id), t.createdAt);
        if (!t.card.savedAt) t.card.savedAt = t.createdAt;
        const owe = payState(t).due;
        if (!(owe > 0) || (open && !due)) continue;
        const when = new Date(Math.max(new Date(t.createdAt).getTime(), new Date(chargeAt(t)).getTime())).toISOString();
        if (open && !cu && !declined && t.status === 'confirmed') {
          declined = true; t.card = { ...t.card, brand: 'Visa', last4: '0341' };
          t.payment.charges = [{ id: id('chg'), kind: 'fare', amount: owe, status: 'failed', error: 'Card declined', at: when, doneAt: when, by: 'System', last4: '0341' }];
          t.history.push({ at: when, status: 'card_failed', by: 'Card', note: `Charge of $${money(owe)} failed: Card declined` });
        } else {
          t.payment.charges = [{ id: id('chg'), kind: t.status === 'cancelled' ? 'fee' : 'fare', amount: owe, status: 'paid', ref: `demo_${randomId(5)}`, at: when, doneAt: when, by: 'System', last4: t.card.last4 }];
        }
        settle(t);
      }
      // A travel agent who books for her clients: commission paid for last
      // month, owed for this month, and two upcoming rides (one the client pays).
      {
        const sofia = await mkUser({ role: 'customer', companyId: cap.id, name: 'Sofia Reyes', email: 'sofia@travel.demo', phone: '(206) 555-0128' });
        sofia.agent = { agency: 'Emerald City Travel', since: at(-60 * 24 * 70) };
        sofia.card = seedCard(sofia.name, 1, at(-60 * 24 * 70));
        const ag = (t, payBy, paid) => { t.agent = { id: sofia.id, name: sofia.name, agency: 'Emerald City Travel', pct: 10, payBy: payBy || 'agent', ...(paid ? { paidAt: at(-60 * 24 * 8), paidBy: 'Nadia Hassan' } : {}) }; return t; };
        const done = (t) => { t.card = clone(sofia.card); t.payment.charges = [{ id: id('chg'), kind: 'fare', amount: t.price.total, status: 'paid', ref: `demo_${randomId(5)}`, at: t.pickupAt, doneAt: t.pickupAt, by: 'System', last4: sofia.card.last4 }]; settle(t); return t; };
        const thisMonth = new Date(now().getFullYear(), now().getMonth(), 1).getTime();
        const ago = (d) => -60 * 24 * d;
        [
          [38, 'Seattle-Tacoma International Airport (SEA)', 'Fairmont Olympic Hotel, 411 University St, Seattle, WA', 'SUV', 'Mr. & Mrs. Tanaka', '(415) 555-0161', 'AS 1077', marcus, sClass],
          [33, 'Four Seasons Hotel Seattle, 99 Union St', 'Seattle-Tacoma International Airport (SEA)', 'Sedan', 'David Okoro', '(312) 555-0144', '', marcus, sClass],
          [Math.min(6, new Date(now()).getDate() - 1) || 1, 'Seattle-Tacoma International Airport (SEA)', 'The Edgewater Hotel, 2411 Alaskan Way, Seattle, WA', 'Sedan', 'Hannah Weiss', '(646) 555-0170', 'DL 2412', tom, esc],
          [Math.min(3, new Date(now()).getDate() - 1) || 1, 'Inn at the Market, 86 Pine St, Seattle, WA', 'Chateau Ste. Michelle, 14111 NE 145th St, Woodinville, WA', 'SUV', 'Mr. & Mrs. Tanaka', '(415) 555-0161', '', tom, esc],
        ].forEach(([d, pu, dr, vt, name, phone, fl, drv, veh]) => {
          const t = trip(cap, sofia, { pickup: pu, dropoff: dr, pickupAt: at(ago(d)), vehicleType: vt, passengers: 2, passengerName: name, passengerPhone: phone, flight: fl }, { createdMin: ago(d) - 60 * 24 * 5, driver: drv, vehicle: veh, status: 'completed', rating: [5, ''] });
          ag(done(t), 'agent', new Date(t.pickupAt).getTime() < thisMonth);
        });
        ag(trip(cap, sofia, { pickup: 'Seattle-Tacoma International Airport (SEA)', dropoff: 'Hotel Sorrento, 900 Madison St, Seattle, WA', pickupAt: at(60 * 24 * 3 + 120), vehicleType: 'Sedan', passengers: 1, passengerName: 'Lucas Moreau', passengerPhone: '(917) 555-0136', passengerEmail: 'lucas@example.com', flight: 'AF 338', meetGreet: true, signName: 'Mr. Moreau' }, { createdMin: -60 * 26 }), 'agent').card = clone(sofia.card);
        const pp = ag(trip(cap, sofia, { pickup: 'Hotel Sorrento, 900 Madison St, Seattle, WA', dropoff: 'Seattle-Tacoma International Airport (SEA)', pickupAt: at(60 * 24 * 6 + 300), vehicleType: 'Sedan', passengers: 1, passengerName: 'Lucas Moreau', passengerPhone: '(917) 555-0136', passengerEmail: 'lucas@example.com' }, { createdMin: -60 * 26 }), 'passenger');
        delete pp.card;
      }
      // Sample text conversations in Carina's inbox.
      {
        const live = db.trips.filter((t) => t.companyId === cap.id && t.passengerPhone && LIVE_STATUS.includes(t.status)).sort((x, y) => x.pickupAt.localeCompare(y.pickupAt));
        const [t1, t2] = [...new Map(live.map((t) => [phoneKey(t.passengerPhone), t])).values()];
        if (t2) {
          takeInbound({ from: t2.passengerPhone, body: 'Hi, could we bring one more suitcase? We have 3 now.', at: at(-185) }); inboxOf()[0].read = true;
          const body = `Carina Ride: No problem, ${String(t2.passengerName).split(' ')[0]}. The car has room for 3 suitcases. See you then!`, msgId = id('msg');
          db.messages.unshift({ id: msgId, companyId: cap.id, tripId: t2.id, ref: t2.ref, at: at(-178), recipient: t2.passengerPhone, channel: 'sms', body, kind: 'chat', reply: true });
          inboxOf().unshift({ id: id('sms'), companyId: cap.id, key: phoneKey(t2.passengerPhone), phone: t2.passengerPhone, dir: 'out', body, at: at(-178), by: 'Nadia Hassan', tripId: t2.id, ref: t2.ref, msgId });
          takeInbound({ from: t2.passengerPhone, body: 'Perfect, thank you!', at: at(-176) }); inboxOf()[0].read = true;
        }
        if (t1) takeInbound({ from: t1.passengerPhone, body: 'Hello, is it ok if the driver picks us up at the side entrance instead? The front is under construction.', at: new Date(now().getTime() + 1000).toISOString() });
      }
      // Sample messages are history, never sent out.
      for (const m of db.messages) { m.delivery = { status: 'logged' }; m.metered = true; }
      // Sample text usage: Carina is close to its monthly allowance.
      const prevMonth = monthKey(new Date(now().getFullYear(), now().getMonth() - 1, 15));
      for (const [c, used, past] of [[cap, 412, 468], [pot, 96, 121], [sum, 37, 52]]) Object.assign(texts(c), { used, past: [{ month: prevMonth, used: past, held: 0 }], warned: c === cap ? ' low' : '' });
      db.sample = true;
      return db;
    }

    // ---- Server-only hooks ------------------------------------------------------
    // Not reachable through call(): the server uses these to deliver messages,
    // take Stripe payments and keep maps and flight data warm.
    function sessionUser(token) {
      const s = token && db.sessions[token];
      const u = s && findUser(s.userId);
      if (!u || u.active === false) fail('Please sign in again.', 401);
      return u;
    }
    const cents = (n) => Math.round(round2(n) * 100);
    const pay = {
      // Checks a payment can be taken and says what to charge.
      async prepare(token, a) {
        await ensure();
        if (payMode !== 'stripe') fail('Card payments are not switched on.');
        // The company admin's LimoRelay membership: on the platform's own Stripe account.
        if (a.kind === 'plancard' || a.kind === 'invoice') {
          const u = sessionUser(token);
          if (u.role !== 'admin') fail('Only the company admin can manage the membership.', 403);
          payGate(u, token);
          const c = findCompany(u.companyId);
          if (a.kind === 'plancard') return { mode: 'setup', account: 'platform', description: `LimoRelay membership, ${c.name}`, email: u.email, name: c.name, meta: { kind: 'plancard', company: c.id }, back: '#account' };
          const inv = db.invoices.find((i) => i.id === a.id && i.companyId === c.id);
          if (!inv) fail('Invoice not found.', 404);
          if (inv.status === 'paid') fail('This invoice is already paid.');
          return { account: 'platform', amount: cents(inv.total), description: `LimoRelay ${inv.number}, ${c.name}`, email: u.email, meta: { kind: 'invoice', id: inv.id, ref: inv.number }, back: '#account' };
        }
        if (a.kind === 'trip') {
          const u = sessionUser(token);
          const t = db.trips.find((x) => x.id === a.id && x.customerId === u.id);
          if (!t) fail('Trip not found.', 404);
          if (t.status === 'cancelled') fail('This trip was cancelled.');
          if (t.payment.status === 'paid') fail('This trip is already paid.');
          if (t.accountId) fail('This trip is billed to your company account.');
          if (onFile(t)) fail('This trip goes on your saved card automatically.');
          const c = findCompany(t.companyId);
          if (!cardsOn(c)) fail(`Online card payment isn't set up yet. Call ${c.name} to pay.`);
          const due = round2(t.price.total - (t.payment.deposit || 0));
          return { account: c.stripe.accountId, amount: cents(due), description: `${c.name}, ride ${t.ref}${t.payment.deposit ? ' (balance)' : ''}`, email: u.email, meta: { kind: 'trip', id: t.id, ref: t.ref }, back: '' };
        }
        // Saving a card for a ride: from the booking form, the card link, or after a decline.
        if (a.kind === 'card') {
          const t = str(a.token, 40) && db.trips.find((x) => x.cardToken === str(a.token, 40));
          if (!t || !onFile(t)) fail('This card link is not valid.', 404);
          if (t.status === 'cancelled' || (t.status === 'completed' && t.payment.status === 'paid')) fail('This ride is closed.');
          const c = findCompany(t.companyId);
          if (!cardsOn(c)) fail("Card payments aren't set up yet.");
          return { mode: 'setup', account: c.stripe.accountId, description: `${c.name}, card for ride ${t.ref}`, email: t.passengerEmail || '', name: t.passengerName || '', meta: { kind: 'card', token: t.cardToken, ref: t.ref }, back: `#card.${t.cardToken}` };
        }
        if (a.kind === 'quote') {
          const q = quoteByToken(a.token);
          const c = findCompany(q.companyId);
          const qs = qStatus(q, c);
          if (qs !== 'sent' && !(qs === 'accepted' && !q.card)) fail(qs === 'accepted' ? 'This quote is already booked.' : 'This quote is not open for booking.');
          if (!cardsOn(c)) fail("Card payments aren't set up yet.");
          const base = { mode: 'setup', account: c.stripe.accountId, description: `${c.name}, card for quote ${q.number}`, email: q.contact.email || '', name: q.contact.name, back: `#quote.${q.token}` };
          if (qStatus(q, c) === 'accepted') return { ...base, meta: { kind: 'quotecard', token: q.token, ref: q.number } };
          const { name, phone } = bookingContact(a);
          const agreed = agreeTerms(c, a, name);
          return { ...base, name, meta: { kind: 'quote', token: q.token, name, phone, ref: q.number, ...(agreed ? { terms: agreed.version } : {}) } };
        }
        fail('Unknown payment.');
      },
      // Records a payment Stripe confirmed. Safe to call twice for one session.
      async complete(p) {
        await ensure();
        const m = p.meta || {};
        let out = null;
        if (p.setup) {
          // A card saved on Stripe's page (setup mode): nothing was charged.
          const k = p.setup;
          const card = (by) => ({ brand: str(k.brand, 20) || 'Card', last4: str(k.last4, 4), exp: str(k.exp, 7), savedAt: now().toISOString(), by: str(by, 80), stripe: { customer: str(k.customer, 80), pm: str(k.pm, 80), session: str(p.sessionId, 120) } });
          const same = (x) => x && x.stripe && x.stripe.session === p.sessionId;
          if (m.kind === 'plancard') {
            if (p.account !== 'platform') fail('Payment account does not match.', 403);
            const c = findCompany(m.company);
            if (!c) fail('Company not found.', 404);
            if (!same(c.billingCard)) {
              c.billingCard = card('Company admin');
              for (const inv of db.invoices.filter((i) => i.companyId === c.id && i.status === 'open')) { if (!(inv.charge && inv.charge.status === 'pending')) delete inv.charge; chargeInvoice(inv, c); }
            }
            meterTexts(); save(db);
            return { back: '#account', ref: 'your LimoRelay membership' };
          }
          if (m.kind === 'card') {
            const t = db.trips.find((x) => x.cardToken === m.token);
            if (!t) fail('Trip not found.', 404);
            const c = findCompany(t.companyId);
            if (!c.stripe || c.stripe.accountId !== p.account) fail('Payment account does not match.', 403);
            if (!same(t.card)) {
              const cu = t.customerId && findUser(t.customerId);
              const k2 = card(cu ? cu.name : t.passengerName);
              if (cu) saveCustomerCard(cu, k2);
              if (!same(t.card)) attachCard(t, k2);
            }
            out = { back: `#card.${t.cardToken}`, ref: t.ref };
          } else if (m.kind === 'quote' || m.kind === 'quotecard') {
            const q = db.quotes.find((x) => x.token === m.token);
            if (!q) fail('Quote not found.', 404);
            const c = findCompany(q.companyId);
            if (!c.stripe || c.stripe.accountId !== p.account) fail('Payment account does not match.', 403);
            if (!same(q.card)) {
              const st = qStatus(q, c);
              if (m.kind === 'quote' && (st === 'sent' || st === 'expired')) {
                if (str(m.name, 80)) q.contact.name = str(m.name, 80);
                if (str(m.phone, 30)) q.contact.phone = str(m.phone, 30);
                if (m.terms) q.termsAgreed = { version: str(m.terms, 20), at: now().toISOString(), by: str(m.name, 80) };
                bookQuote(q, str(m.name, 80), card(m.name));
                qlog(q, `Accepted online by ${str(m.name, 80)}, card ending ${str(k.last4, 4)} saved`, str(m.name, 80));
              } else if (st === 'accepted') quoteCard(q, card(m.name || q.contact.name));
              else qlog(q, `A card was saved after the quote was ${st}. Nothing was charged.`, 'Stripe');
            }
            out = { back: `#quote.${q.token}`, ref: q.number };
          } else fail('Unknown card.');
          syncFarmouts(); meterTexts(); save(db);
          return out;
        }
        if (m.kind === 'invoice') {
          if (p.account !== 'platform') fail('Payment account does not match.', 403);
          const inv = db.invoices.find((i) => i.id === m.id);
          if (!inv) fail('Invoice not found.', 404);
          if (inv.status !== 'paid') Object.assign(inv, { status: 'paid', paidAt: now().toISOString(), paidBy: `Card ending ${str(p.last4, 4) || '••••'}`, stripeSession: p.sessionId });
          meterTexts(); save(db);
          return { back: '#account', ref: inv.number };
        }
        if (m.kind === 'trip') {
          const t = db.trips.find((x) => x.id === m.id);
          if (!t) fail('Trip not found.', 404);
          const c = findCompany(t.companyId);
          if (!c.stripe || c.stripe.accountId !== p.account) fail('Payment account does not match.', 403);
          if (t.payment.stripeSession === p.sessionId) return { back: '', ref: t.ref };
          if (t.payment.status !== 'paid') {
            t.payment = { ...t.payment, status: 'paid', method: 'card', paidAt: now().toISOString(), last4: str(p.last4, 4), amount: round2(p.amount / 100), stripeSession: p.sessionId };
            log(t, 'paid', 'Stripe', `Card payment $${money(p.amount / 100)}`);
          }
          out = { back: '', ref: t.ref };
        } else if (m.kind === 'quote') {
          const q = db.quotes.find((x) => x.token === m.token);
          if (!q) fail('Quote not found.', 404);
          const c = findCompany(q.companyId);
          if (!c.stripe || c.stripe.accountId !== p.account) fail('Payment account does not match.', 403);
          if (q.depositPaid && q.depositPaid.stripeSession === p.sessionId) return { back: `#quote.${q.token}`, ref: q.number };
          const st = qStatus(q, c);
          if (st === 'sent' || st === 'expired') {
            if (str(m.name, 80)) q.contact.name = str(m.name, 80);
            if (str(m.phone, 30)) q.contact.phone = str(m.phone, 30);
            if (m.terms) q.termsAgreed = { version: str(m.terms, 20), at: now().toISOString(), by: str(m.name, 80) };
            bookQuote(q, str(m.name, 80), { method: 'card', last4: str(p.last4, 4) });
            q.depositPaid.stripeSession = p.sessionId; q.depositPaid.amount = round2(p.amount / 100);
            qlog(q, `Accepted online by ${str(m.name, 80)}, deposit $${money(p.amount / 100)} paid by card`, str(m.name, 80));
          } else {
            // Paid after the quote closed: keep a record so the office refunds it.
            qlog(q, `Deposit of $${money(p.amount / 100)} came in after the quote was ${st}. Refund it in Stripe if the event is off.`, 'Stripe');
          }
          out = { back: `#quote.${q.token}`, ref: q.number };
        } else fail('Unknown payment.');
        syncFarmouts(); meterTexts(); save(db);
        return out;
      },
      // Saved-card charges and refunds waiting for Stripe. The server runs each
      // one and reports back through chargeResult.
      async pendingCharges() {
        await ensure();
        const out = [];
        let dirty = false;
        for (const t of db.trips) {
          for (const x of (t.payment && t.payment.charges) || []) {
            if (x.status !== 'pending') continue;
            const c = findCompany(t.companyId), k = t.card && t.card.stripe;
            const orig = x.kind === 'refund' && t.payment.charges.find((y) => y.id === x.of);
            if (!c.stripe || !c.stripe.accountId || (x.kind === 'refund' ? !(orig && orig.ref) : !(k && k.customer && k.pm))) { finishCharge(t, x, { ok: false, error: x.kind === 'refund' ? 'Refund it in Stripe' : 'No card saved with Stripe' }); dirty = true; continue; }
            out.push({ tripId: t.id, id: x.id, kind: x.kind, amount: cents(x.amount), account: c.stripe.accountId, customer: k && k.customer, pm: k && k.pm, refundOf: orig ? orig.ref : '',
              description: `${c.name}, ${x.kind === 'refund' ? 'refund for' : x.kind === 'extra' ? 'extras on' : x.kind === 'fee' ? 'fee for' : 'ride'} ${t.ref}`, meta: { kind: x.kind, trip: t.ref } });
          }
        }
        for (const inv of db.invoices) {
          if (!inv.charge || inv.charge.status !== 'pending') continue;
          const c = findCompany(inv.companyId), k = c && c.billingCard && c.billingCard.stripe;
          if (inv.status === 'paid') { inv.charge.status = 'paid'; dirty = true; continue; }
          if (!k || !k.customer || !k.pm) { inv.charge = { ...inv.charge, status: 'failed', error: 'No card saved with Stripe' }; dirty = true; continue; }
          out.push({ invoiceId: inv.id, id: inv.charge.id, kind: 'invoice', amount: cents(inv.total), account: null, customer: k.customer, pm: k.pm, description: `LimoRelay ${inv.number}, ${c.name}`, meta: { kind: 'invoice', invoice: inv.number } });
        }
        if (dirty) { syncFarmouts(); meterTexts(); save(db); }
        return out;
      },
      async chargeResult(r) {
        await ensure();
        if (r.invoiceId) {
          const inv = db.invoices.find((i) => i.id === r.invoiceId);
          if (!inv || !inv.charge || inv.charge.id !== r.id || inv.charge.status !== 'pending' || r.retry) return false;
          const c = findCompany(inv.companyId);
          if (r.ok) Object.assign(inv, { status: 'paid', paidAt: now().toISOString(), paidBy: `Card ending ${inv.charge.last4}`, charge: { ...inv.charge, status: 'paid', ref: str(r.ref, 80) } });
          else {
            inv.charge = { ...inv.charge, status: 'failed', error: str(r.error, 200) || 'Card declined' };
            billingMail(c, 'billing', `we couldn't charge your card ending ${inv.charge.last4} for LimoRelay invoice ${inv.number} ($${money(inv.total)}): ${inv.charge.error}. Please add another card under My account, Membership, at ${siteUrl()}#account.`);
          }
          meterTexts(); save(db);
          return true;
        }
        const t = db.trips.find((x) => x.id === r.tripId);
        const x = t && (t.payment.charges || []).find((y) => y.id === r.id);
        if (!x || x.status !== 'pending' || r.retry) return false;
        finishCharge(t, x, { ok: !!r.ok, ref: r.ref, error: r.error });
        syncFarmouts(); meterTexts(); save(db);
        return true;
      },
      // The company admin connecting their Stripe account.
      async company(token) {
        await ensure();
        const u = sessionUser(token);
        if (u.role !== 'admin') fail('Only the company admin can connect card payments.', 403);
        payGate(u, token);
        const c = findCompany(u.companyId);
        return { id: c.id, name: c.name, email: c.email || u.email, stripe: c.stripe ? clone(c.stripe) : null };
      },
      async setStripe(companyId, patch) {
        await ensure();
        const c = findCompany(companyId);
        if (!c) fail('Company not found.', 404);
        c.stripe = { ...(c.stripe || {}), ...patch };
        if (patch.ready && !c.stripe.connectedAt) c.stripe.connectedAt = now().toISOString();
        save(db);
        return clone(c.stripe);
      },
    };

    return {
      call,
      pay,
      // A text someone sent to the platform's Twilio number.
      async inboundSms(msg) {
        await ensure();
        const r = takeInbound(msg || {});
        if (r.ok && !r.duplicate) save(db);
        return r;
      },
      // Texts and emails waiting to go out, marked as sending. Anything older
      // than olderThanMin is only logged (old data, or a restart mid-send).
      async outbox(olderThanMin) {
        await ensure();
        const out = [];
        const cutoff = now().getTime() - (olderThanMin || 15) * 60e3;
        let changed = db.messages.some((m) => !m.metered);
        meterTexts();
        for (const m of db.messages) {
          if (m.delivery) continue;
          changed = true;
          if (new Date(m.at).getTime() < cutoff) { m.delivery = { status: 'logged' }; continue; }
          m.delivery = { status: 'sending' };
          const c = m.companyId ? findCompany(m.companyId) || {} : { name: 'LimoRelay', email: PLATFORM_EMAIL };
          out.push({ id: m.id, channel: m.channel, recipient: m.recipient, body: m.body, kind: m.kind || '', ref: m.ref || '', replyTo: m.replyTo || '', company: { name: c.name || '', email: c.email || '', phone: c.phone || '' } });
        }
        if (changed) save(db);
        return out;
      },
      async delivered(results) {
        await ensure();
        for (const r of results) {
          const m = db.messages.find((x) => x.id === r.id);
          if (m) m.delivery = { status: r.status, at: now().toISOString(), ...(r.via ? { via: r.via } : {}), ...(r.error ? { error: str(r.error, 200) } : {}) };
        }
        if (results.length) save(db);
      },
      // Web Push messages to send: anything new in each subscribed person's feed.
      async pushOutbox() {
        await ensure();
        const subs = db.pushSubs || [], out = [];
        if (!subs.length) return out;
        let changed = false;
        for (const userId of [...new Set(subs.map((x) => x.userId))]) {
          const u = findUser(userId), c = u && u.companyId ? findCompany(u.companyId) : null;
          if (!u || u.active === false || (c && c.status !== 'active')) {
            if (!u || u.active === false) { db.pushSubs = db.pushSubs.filter((x) => x.userId !== userId); changed = true; }
            continue;
          }
          const feed = feedFor(u), seen = new Set(u.pushSeen || []);
          const fresh = feed.filter((n) => !seen.has(n.key));
          if (!fresh.length) continue;
          for (const n of fresh) seen.add(n.key);
          u.pushSeen = [...seen].slice(-80); changed = true;
          const mine = db.pushSubs.filter((x) => x.userId === userId);
          for (const n of fresh.slice(0, 3).reverse()) for (const sub of mine) out.push({ endpoint: sub.endpoint, keys: sub.keys ? clone(sub.keys) : null, payload: { title: n.title, body: n.body, hash: n.hash, tag: n.key } });
        }
        if (changed) save(db);
        return out;
      },
      // Subscriptions the push service says are gone (app removed, permission revoked).
      async pushGone(endpoints) {
        await ensure();
        const before = (db.pushSubs || []).length;
        db.pushSubs = (db.pushSubs || []).filter((x) => !endpoints.includes(x.endpoint));
        if (db.pushSubs.length !== before) save(db);
      },
      // Upcoming trips, for warming the maps and flight caches.
      async upcoming(hours) {
        await ensure();
        const n = now().getTime();
        return db.trips.filter((t) => !['completed', 'cancelled'].includes(t.status) && Math.abs(new Date(t.pickupAt).getTime() - n) < (hours || 36) * 3600e3).map((t) => {
          const kind = flightKind(t);
          return { pickup: t.pickup, dropoff: t.dropoff || '', stops: t.stopList || [], flight: t.flight ? normFlight(t.flight) : '', kind, sched: t.flight ? flightSched(t, kind) : null, airport: airportCode(kind === 'arrival' ? t.pickup : t.dropoff) };
        });
      },
      async reset() { db = null; save(null); seeding = seed().then((d) => { db = d; save(db); seeding = null; return d; }); await seeding; },
      reload() { if (!reloadEachCall) db = null; },
      // Runs the dispatch timers (accept deadlines, reminders) without a request.
      async tick() {
        await ensure();
        let changed = false;
        for (const c of db.companies) if (c.status === 'active' && sweepDispatch(c, true)) changed = true;
        if (billingTick()) changed = true;
        if (changed) { syncFarmouts(); syncCredits(); meterTexts(); save(db); }
        return changed;
      },
    };
  }

  return { createCore, MSG_TEMPLATES, INCIDENT_KINDS, setProviders, routeVia, TEMPS, MUSIC, MAX_STOPS, STOP_WAITS, DEFAULT_POLICY, quote, estimateRoute, suggestPlaces, isAirport, flightStatus, normFlight, ApiError, VEHICLE_TYPES, SERVICES, EVENT_TYPES, STATUS_LABELS, DRIVER_FLOW, PLANS, PLATFORM_EMAIL, DEFAULT_AUTOFARM, DEFAULT_DISPATCH, DEFAULT_RATES, DEFAULT_PRICING, VEHICLE_STATUS, MAINT_KINDS, PAY_TYPES, DAYS, AIRLINES };
});
