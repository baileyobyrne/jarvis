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

**Target partner network:** 3–5 selling agents (different suburbs), 2–3 buyers agents active on the lower north shore, 1–2 mortgage brokers.

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
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  type TEXT NOT NULL, -- vendor | buyer | finance
  status TEXT NOT NULL DEFAULT 'referred', -- referred | introduced | active | settled | paid
  expected_fee REAL,
  actual_fee REAL,
  disclosure_sent INTEGER DEFAULT 0,
  notes TEXT,
  referred_at TEXT DEFAULT (datetime('now')),
  settled_at TEXT,
  paid_at TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);
```

## API Endpoints

- `GET /api/partners` — list all partners
- `POST /api/partners` — create partner
- `PUT /api/partners/:id` — update partner
- `GET /api/referrals` — list referrals (with contact + partner details joined)
- `POST /api/referrals` — create referral
- `PUT /api/referrals/:id` — update status, actual_fee, settled_at, paid_at

## Dashboard Changes

### 1. "Refer" button on ProspectCard
Added alongside existing call outcome actions. Opens a modal with:
- Partner selector (dropdown of partners)
- Referral type (vendor / buyer / finance) — pre-suggested based on contact_class
- Expected fee (auto-calculated from partner fee_type and fee_value)
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
Status can be updated inline (drag or dropdown).

### 3. Partner management (within REFERRALS page)
Collapsible section or tab to view/add/edit partners.

## Navigation
- Add REFERRALS as 7th sidebar item and BottomTabBar item
- Badge showing count of active referrals (referred + introduced + active)
