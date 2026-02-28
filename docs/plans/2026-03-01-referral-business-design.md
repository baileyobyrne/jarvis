# Referral Business Design
Date: 2026-03-01

## Overview

Build a referral lead pipeline on top of the existing Jarvis prospecting system. When prospecting surfaces a motivated vendor, active buyer, or finance-ready contact, instead of (or alongside) working them directly, the agent can refer them to a partner in exchange for a referral fee.

This operates as a separate ABN side business alongside the McGrath role.

## Business Model

**Entity:** Sole trader ABN — "Bailey O'Byrne Referrals" or similar.

**Three revenue streams:**

| Stream | Partner Type | Fee Structure | Example |
|---|---|---|---|
| Vendor referrals | Selling agents | 20% of gross commission | $3M sale @ 2% = $60k gross → $12,000 |
| Buyer referrals | Buyers agents | $2,000–$5,000 flat per settlement | ~$3,500 avg |
| Finance referrals | Mortgage brokers | $500–$1,500 upfront + trail | ~$800 upfront |

**Target partner network:** 3–5 McGrath selling agents (adjacent suburbs), 3–4 buyers agents active on the lower north shore, 1–2 mortgage brokers.

**Priority order:** Buyers agent referrals are the highest-volume opportunity — 53,360 buyer/prospective buyer contacts in the McGrath Love Local CRM. Volume × $3,500 avg fee. Vendor referrals have the highest per-deal value ($10k+). Finance referrals are lowest friction to start.

**Referral scope:** Within McGrath network only (no agency conflict). Outside agents only once a direct relationship is established.

## Compliance Requirements

### 1. Disclosure to client (before referral is made)
SMS/email is sufficient. Example:
> "Hi [Name], just to let you know — if I introduce you to [Partner Name], I may receive a small referral fee for making that introduction. There's no cost to you and it doesn't affect the service you receive."

Screenshot/record kept. Captured via disclosure checkbox in Jarvis.

### 2. Referral fee agreement with partner
One standing agreement per partner (not per referral). Covers:
- Fee amount (% or flat)
- Trigger event (settlement of sale / loan approval)
- Payment timeline (within 14 days of trigger)

## Database Changes

### New table: `partners`
```sql
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- selling_agent | buyers_agent | mortgage_broker
  suburb_focus TEXT,
  fee_type TEXT NOT NULL, -- percentage | flat
  fee_value REAL NOT NULL, -- 20 for 20%, or 2000 for flat $2000
  mobile TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### New table: `referrals`
```sql
CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  partner_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- vendor | buyer | finance
  status TEXT NOT NULL DEFAULT 'referred', -- referred | introduced | active | settled | paid
  expected_fee REAL,
  actual_fee REAL,
  disclosure_sent INTEGER DEFAULT 0,
  buyer_brief TEXT, -- JSON: { budget_min, budget_max, suburbs, property_type, timeframe, pre_approved }
  notes TEXT,
  referred_at TEXT DEFAULT (datetime('now')),
  settled_at TEXT,
  paid_at TEXT
);
```

`buyer_brief` is populated only when `type = 'buyer'`. It captures the information buyers agents need to evaluate the lead quality before committing to a fee.

## API Endpoints

- `GET /api/partners` — list all partners
- `POST /api/partners` — create partner
- `PUT /api/partners/:id` — update partner
- `GET /api/referrals` — list referrals (with contact + partner details joined)
- `POST /api/referrals` — create referral
- `PUT /api/referrals/:id` — update status, actual_fee, settled_at, paid_at

## Dashboard Changes

### 1. "Refer" button on ContactCard
Added alongside existing call outcome actions. Opens a modal with:
- Partner selector (dropdown of partners)
- Referral type (vendor / buyer / finance) — pre-suggested based on contact_class
- Expected fee (auto-calculated from partner fee_type and fee_value; vendor shows `~$X (20%)`, buyer shows `$2,000–$5,000 flat`, finance shows `$800 flat`)
- **Buyer Brief section** (shown only when type = buyer): budget min/max, target suburbs (comma-separated), property type, timeframe, pre-approved Y/N. Auto-populated from existing `buyer_profiles` record if one exists for this contact.
- Disclosure checkbox (required — cannot submit without ticking)
- Optional note

On submit: POST /api/referrals, card shows "Referred to [Partner]" badge.

### 2. REFERRALS page (new nav item)
Pipeline view showing all referrals grouped by status:

```
REFERRED    INTRODUCED    ACTIVE    SETTLED    PAID
   3             2           1         1         0

Expected pipeline: $28,500
Received to date:  $0
```

Each card shows: contact name, address, partner name, type, expected fee, days since referred.
**Buyer referral cards** additionally show the brief summary: budget range, target suburbs, pre-approval status — making lead quality immediately visible.
Status can be updated inline (dropdown).

### 3. Partner management (within REFERRALS page)
Collapsible section or tab to view/add/edit partners.

## Navigation
- Add REFERRALS as 7th sidebar item and BottomTabBar item
- Badge showing count of active referrals (referred + introduced + active)

## Additional Tasks (appended post-design)

### Task 8: Import 124k AgentBox contacts to SQLite
Import `willoughby-contacts.json` (124,000 contacts from McGrath Love Local CRM) into an `agentbox_contacts` table. This is the referral prospecting engine — covers the full lower north shore including Mosman, Lane Cove, Hunters Hill, Roseville, Cremorne, Neutral Bay, Ryde etc.

Fields: id, name, mobile, email, address, suburb, state, postcode, contact_class, do_not_call, last_modified.

Script: `scripts/import-agentbox-contacts.js` — safe to re-run (INSERT OR REPLACE).

### Task 9: Referral Prospecting page
Search `agentbox_contacts` by suburb + contact_class to surface referral prospects. Default view shows Buyer/Prospective Buyer contacts from suburbs outside the Willoughby patch. Each result has a "Refer" action that opens the ReferModal pre-populated with buyer brief fields.

Buyer-first emphasis: filter presets for "Active Buyers" (contact_class contains Buyer, sorted by last_modified DESC) and "Prospective Vendors" (outside patch) as the two primary use cases.
