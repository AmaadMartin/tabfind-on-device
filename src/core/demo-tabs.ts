/**
 * A synthetic set of open tabs for the harness, the tests, and the eval.
 *
 * This set is curated, and the curation is the point. Several entries are
 * deliberately written so that the natural way a person would describe them
 * shares *no words at all* with the tab's title:
 *
 *   "that thing about the refund"   -> "Order #48213 - Return authorization"
 *   "the flight thing"              -> "Itinerary confirmation - LHR to SFO"
 *   "what do I need to sign"        -> "DocuSign - Awaiting your signature"
 *   "the doctor thing"              -> "Lab results are ready to view"
 *   "where I said I'd take the job" -> "Offer acceptance - please confirm by Friday"
 *
 * Those are the cases where ctrl-F provably cannot help, so they are the cases
 * worth demoing. The rest is realistic filler: enough volume and enough
 * near-miss topical overlap that retrieval is not trivially easy.
 */

import type { IndexedTab } from './types.js';

interface Seed {
  title: string;
  url: string;
  text: string;
}

const SEEDS: Seed[] = [
  // --- the planted zero-overlap hits ---------------------------------------
  {
    title: 'Order #48213 - Return authorization',
    url: 'https://shop.example.com/orders/48213/rma',
    text:
      'Your return has been authorized. Print the prepaid label and drop the package '
      + 'at any carrier location within 14 days. Once we receive the item, the amount '
      + 'of $148.00 will be credited back to the original payment method within 5-7 '
      + 'business days. RMA number 48213-R.',
  },
  {
    title: 'Itinerary confirmation - LHR to SFO',
    url: 'https://travel.example.com/booking/8823/itinerary',
    text:
      'Departure London Heathrow Terminal 5 at 10:40, arriving San Francisco '
      + 'International at 13:55. Booking reference QK8823. Seat 24A, one checked bag '
      + 'included. Online check-in opens 24 hours before departure.',
  },
  {
    title: 'DocuSign - Awaiting your signature',
    url: 'https://docusign.example.com/envelope/9f2a',
    text:
      'You have one document awaiting completion: Mutual non-disclosure agreement. '
      + 'The sender has requested this be completed by the end of the week. Review all '
      + 'pages before adopting your electronic initials.',
  },
  {
    title: 'Lab results are ready to view',
    url: 'https://patient.example.org/results/latest',
    text:
      'Your recent bloodwork has been reviewed by the clinic. Cholesterol and vitamin D '
      + 'panels are within the normal reference range. Your physician has left a comment '
      + 'about the follow-up appointment scheduled for next month.',
  },
  {
    title: 'Offer acceptance - please confirm by Friday',
    url: 'https://careers.example.com/candidate/offer/771',
    text:
      'We are delighted to extend this offer for the Staff Engineer position. Base '
      + 'compensation, equity grant and start date are detailed below. Please indicate '
      + 'your acceptance using the button at the bottom of this page.',
  },

  // --- near misses: same topics, wrong tab ---------------------------------
  {
    title: 'Shipping and delivery FAQ',
    url: 'https://shop.example.com/help/shipping',
    text:
      'Standard delivery takes 3-5 business days. Express options are available at '
      + 'checkout. Tracking numbers are emailed once the package leaves our warehouse.',
  },
  {
    title: 'Your cart (3 items)',
    url: 'https://shop.example.com/cart',
    text:
      'Desk lamp, USB-C cable, notebook. Subtotal $84.50. Apply a promotion code at '
      + 'checkout. Items in your cart are not reserved.',
  },
  {
    title: 'Cheap flights to Lisbon - search results',
    url: 'https://flights.example.com/search?to=LIS',
    text:
      'We found 214 fares departing over the next three months. Filter by number of '
      + 'stops, airline alliance, departure window and cabin class.',
  },
  {
    title: 'Hotel Verde - reservation details',
    url: 'https://hotels.example.com/res/55120',
    text:
      'Two nights, king room, breakfast included. Check-in from 15:00, check-out by '
      + '11:00. Free cancellation until 48 hours before arrival.',
  },
  {
    title: 'Contract templates library',
    url: 'https://legal.example.com/templates',
    text:
      'Standard agreements for vendors, contractors and mutual confidentiality. Each '
      + 'template has been reviewed by counsel and should not be modified without approval.',
  },

  // --- work ----------------------------------------------------------------
  {
    title: 'Pricing page redesign - proposed tiers',
    url: 'https://docs.example.com/d/pricing-redesign',
    text:
      'Proposal to move from four plans to three. The Team plan absorbs most Starter '
      + 'accounts. Per-seat cost increases by $4 while the annual discount widens to 20%. '
      + 'Migration messaging for existing customers is still open.',
  },
  {
    title: 'PR #4821: fix retry backoff in ingest worker',
    url: 'https://git.example.com/core/pull/4821',
    text:
      'Exponential backoff was resetting on every partial failure, causing the worker to '
      + 'hammer the queue. Adds jitter and a maximum attempt count. Two approvals required.',
  },
  {
    title: 'Incident 2291 postmortem - elevated 5xx on checkout',
    url: 'https://incidents.example.com/2291',
    text:
      'A configuration push reduced the connection pool size, exhausting capacity during '
      + 'peak traffic. Duration 42 minutes. Action items assigned to the platform team.',
  },
  {
    title: 'Q3 planning doc',
    url: 'https://docs.example.com/d/q3-planning',
    text:
      'Objectives, key results and staffing for the next quarter. Two headcount requests '
      + 'remain unapproved. Roadmap slips if the migration is not finished by August.',
  },
  {
    title: 'Weekly sync - agenda and notes',
    url: 'https://docs.example.com/d/weekly-sync',
    text:
      'Standing agenda: metrics review, blockers, on-call handover. Notes from the last '
      + 'four weeks are collapsed at the bottom.',
  },
  {
    title: 'Bug 10233: dropdown closes on scroll in Safari',
    url: 'https://bugs.example.com/10233',
    text:
      'Reproduces only on iOS Safari 17. The listbox unmounts when the virtual keyboard '
      + 'dismisses. Suspected interaction with the scroll containment polyfill.',
  },
  {
    title: 'Deploy dashboard - production',
    url: 'https://deploy.example.com/prod',
    text:
      'Current release 2026.7.14. Rollout paused at 25% pending error-rate check. '
      + 'Previous release remains available for rollback for 24 hours.',
  },
  {
    title: 'Design review: onboarding flow v3',
    url: 'https://figma.example.com/file/onboarding-v3',
    text:
      'Three-step flow replacing the current five-step wizard. Open question on whether '
      + 'the workspace naming step can be deferred until after first login.',
  },
  {
    title: 'API reference - authentication',
    url: 'https://developers.example.com/docs/auth',
    text:
      'All requests must include a bearer token. Tokens expire after one hour and can be '
      + 'refreshed using the refresh grant. Rate limits apply per project.',
  },
  {
    title: 'Team capacity spreadsheet',
    url: 'https://sheets.example.com/s/capacity',
    text:
      'Engineer-weeks available per squad through the end of the quarter, adjusted for '
      + 'planned leave and on-call rotation.',
  },

  // --- personal / financial -------------------------------------------------
  {
    title: 'Statement ending 3391 - July',
    url: 'https://bank.example.com/statements/july',
    text:
      'Opening balance, transactions and closing balance for the period. Two direct '
      + 'debits were returned unpaid. Interest applied on the average daily balance.',
  },
  {
    title: 'Invoice INV-2026-0412 is due',
    url: 'https://billing.example.com/invoices/2026-0412',
    text:
      'Amount due $2,400.00, payable within 30 days of issue. Late payments accrue '
      + 'interest at 1.5% per month. Remittance details are at the foot of the invoice.',
  },
  {
    title: 'Claim #7781 - status update',
    url: 'https://insurance.example.com/claims/7781',
    text:
      'Your claim is under assessment. The adjuster has requested two additional photos '
      + 'of the damage. Your policy excess is $250.',
  },
  {
    title: 'Filing deadline reminders',
    url: 'https://tax.example.gov/deadlines',
    text:
      'Self-assessment submissions close in January. Payments on account are due in two '
      + 'instalments. Penalties apply from the day after the deadline.',
  },
  {
    title: 'Renew your vehicle registration',
    url: 'https://dmv.example.gov/renew',
    text:
      'Registration expires at the end of next month. Renew online with your plate '
      + 'number and the last four digits of the VIN. Emissions certificate required.',
  },

  // --- reading / research ---------------------------------------------------
  {
    title: 'Attention Is All You Need',
    url: 'https://arxiv.example.org/abs/1706.03762',
    text:
      'We propose a new simple network architecture, the Transformer, based solely on '
      + 'attention mechanisms, dispensing with recurrence and convolutions entirely.',
  },
  {
    title: 'On-device inference: a practical survey',
    url: 'https://arxiv.example.org/abs/2504.11122',
    text:
      'Quantization, distillation and speculative decoding as applied to models running '
      + 'under tight memory budgets on consumer hardware.',
  },
  {
    title: 'How BM25 actually works',
    url: 'https://blog.example.com/bm25-explained',
    text:
      'Term frequency saturation, inverse document frequency and length normalisation, '
      + 'explained without the usual wall of notation.',
  },
  {
    title: 'The case against microservices',
    url: 'https://blog.example.com/against-microservices',
    text:
      'Distributed systems impose a coordination tax that most teams underestimate. A '
      + 'well-factored monolith is easier to reason about at small scale.',
  },
  {
    title: 'Hacker News',
    url: 'https://news.example.com/',
    text: 'Top stories, new, show, ask, jobs. Comments sorted by default ranking.',
  },

  // --- home / life ----------------------------------------------------------
  {
    title: 'Slow-roast tomato pasta',
    url: 'https://recipes.example.com/tomato-pasta',
    text:
      'Halve the tomatoes, roast at 140C for two hours with garlic and olive oil, then '
      + 'toss through pasta with torn basil. Serves four. Total time two hours 20 minutes.',
  },
  {
    title: 'Sourdough starter troubleshooting',
    url: 'https://recipes.example.com/sourdough-help',
    text:
      'If your starter is sluggish, check hydration and ambient temperature. A layer of '
      + 'dark liquid on top means it is hungry, not dead.',
  },
  {
    title: '2 bed flat, Bermondsey - £2,100 pcm',
    url: 'https://property.example.com/listing/33412',
    text:
      'Second floor, no lift, wooden floors throughout. Available from the first of next '
      + 'month. Deposit equivalent to five weeks rent. Council tax band C.',
  },
  {
    title: 'Bike service booking',
    url: 'https://bikeshop.example.com/service',
    text:
      'Full service includes drivetrain clean, brake bleed and gear index. Two week '
      + 'lead time. Drop off between 08:00 and 10:00.',
  },
  {
    title: 'Gift ideas - saved list',
    url: 'https://shop.example.com/lists/gifts',
    text: 'Twelve saved items across four stores. Three are currently out of stock.',
  },

  // --- accounts / admin -----------------------------------------------------
  {
    title: 'Security checkup - 2 recommendations',
    url: 'https://account.example.com/security',
    text:
      'Two devices have not been used in over a year. Review and remove any you no '
      + 'longer recognise. Two-factor authentication is enabled.',
  },
  {
    title: 'Reset your password',
    url: 'https://account.example.com/reset',
    text:
      'This link expires in 30 minutes. Choose a password you have not used elsewhere. '
      + 'You will be signed out of all other sessions.',
  },
  {
    title: 'Subscription and billing settings',
    url: 'https://account.example.com/billing',
    text:
      'Plan renews annually on 3 March. Payment method ending 4412. Download past '
      + 'receipts from the history table below.',
  },
  {
    title: 'Calendar - week of 27 July',
    url: 'https://calendar.example.com/week/2026-07-27',
    text:
      'Eleven events this week including two all-day items. Thursday afternoon is '
      + 'currently unbooked.',
  },
  {
    title: 'New tab',
    url: 'chrome://newtab/',
    text: '',
  },
];

/** The demo corpus, with ids and timestamps filled in. */
export const DEMO_TABS: IndexedTab[] = SEEDS.map((s, i) => ({
  tabId: i + 1,
  windowId: 1,
  url: s.url,
  title: s.title,
  text: s.text,
  indexedAt: Date.now() - (SEEDS.length - i) * 60_000,
  extractionBlocked: s.url.startsWith('chrome://'),
}));
