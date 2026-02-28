# Referral Business Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a referral pipeline to Jarvis — track partner agents/brokers, log referrals from the call board, and monitor expected vs received revenue. Strong emphasis on buyers agent referrals (53k buyer contacts in CRM, $2k–$5k per settled referral).

**Architecture:** New `partners`, `referrals`, and `agentbox_contacts` tables in SQLite via `lib/db.js`. CRUD API endpoints in `snapshot-server.js`. Dashboard gains a "Refer" action on ContactCard (with buyer brief capture for buyer-type referrals), a new REFERRALS pipeline page, a Partners management section, and a Referral Prospecting page querying the full 124k McGrath CRM.

**Tech Stack:** better-sqlite3, Express, React (Babel JSX, no build), CSS tokens from dashboard.css. All IDs: `INTEGER PRIMARY KEY AUTOINCREMENT`. Auth: Bearer token (`DASHBOARD_PASSWORD`).

---

### Task 1: DB Migrations — partners + referrals tables

**Files:**
- Modify: `/root/.openclaw/lib/db.js` (append before final `})();` close)

**Step 1: Add the migrations**

Append the following block inside the IIFE in `lib/db.js`, just before the final `})();`:

```js
// Schema migrations — partners table
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partners'").get()) {
  db.prepare(`CREATE TABLE IF NOT EXISTS partners (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    suburb_focus TEXT,
    fee_type     TEXT NOT NULL DEFAULT 'percentage',
    fee_value    REAL NOT NULL DEFAULT 20,
    mobile       TEXT,
    email        TEXT,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  )`).run();
  console.log('[db] partners table created');
}

// Schema migrations — referrals table
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'").get()) {
  db.prepare(`CREATE TABLE IF NOT EXISTS referrals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id       TEXT NOT NULL,
    partner_id       INTEGER NOT NULL,
    type             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'referred',
    expected_fee     REAL,
    actual_fee       REAL,
    disclosure_sent  INTEGER DEFAULT 0,
    notes            TEXT,
    referred_at      TEXT DEFAULT (datetime('now')),
    settled_at       TEXT,
    paid_at          TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status, referred_at DESC)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_referrals_contact ON referrals(contact_id)').run();
  console.log('[db] referrals table created');
}
```

**Step 2: Verify tables were created**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 3
sqlite3 /root/.openclaw/workspace/jarvis.db ".tables" | grep -E "partners|referrals"
```

Expected output:
```
partners   referrals
```

**Step 3: Commit**

```bash
cd /root/.openclaw
git add lib/db.js
git commit -m "feat: add partners and referrals tables to db.js"
```

---

### Task 2: Partners API Endpoints

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js` (add after buyer-profiles routes, before the catch-all)

**Step 1: Verify the endpoint doesn't exist yet**

```bash
source /root/.openclaw/.env
curl -sk https://localhost:4242/api/partners \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD" | head -c 100
```

Expected: `Cannot GET /api/partners` or 404.

**Step 2: Add the routes**

Find the section near buyer-profiles routes and add after them:

```js
// ── Partners ──────────────────────────────────────────────────────────────
app.get('/api/partners', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM partners ORDER BY type, name').all();
  res.json(rows);
});

app.post('/api/partners', auth, (req, res) => {
  const { name, type, suburb_focus, fee_type, fee_value, mobile, email, notes } = req.body;
  if (!name || !type || fee_value == null) return res.status(400).json({ error: 'name, type, fee_value required' });
  const VALID_TYPES = ['selling_agent', 'buyers_agent', 'mortgage_broker'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });
  const VALID_FEE_TYPES = ['percentage', 'flat'];
  const feeType = VALID_FEE_TYPES.includes(fee_type) ? fee_type : 'percentage';
  const result = db.prepare(
    'INSERT INTO partners (name, type, suburb_focus, fee_type, fee_value, mobile, email, notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(name, type, suburb_focus || null, feeType, fee_value, mobile || null, email || null, notes || null);
  res.json(db.prepare('SELECT * FROM partners WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/partners/:id', auth, (req, res) => {
  const { name, type, suburb_focus, fee_type, fee_value, mobile, email, notes } = req.body;
  const VALID_TYPES = ['selling_agent', 'buyers_agent', 'mortgage_broker'];
  const VALID_FEE_TYPES = ['percentage', 'flat'];
  const fields = [];
  const params = [];
  if (name) { fields.push('name = ?'); params.push(name); }
  if (type && VALID_TYPES.includes(type)) { fields.push('type = ?'); params.push(type); }
  if (suburb_focus !== undefined) { fields.push('suburb_focus = ?'); params.push(suburb_focus); }
  if (fee_type && VALID_FEE_TYPES.includes(fee_type)) { fields.push('fee_type = ?'); params.push(fee_type); }
  if (fee_value != null) { fields.push('fee_value = ?'); params.push(fee_value); }
  if (mobile !== undefined) { fields.push('mobile = ?'); params.push(mobile); }
  if (email !== undefined) { fields.push('email = ?'); params.push(email); }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE partners SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id));
});

app.delete('/api/partners/:id', auth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM referrals WHERE partner_id = ?').get(req.params.id).n;
  if (count > 0) return res.status(409).json({ error: `Cannot delete — partner has ${count} referral(s)` });
  db.prepare('DELETE FROM partners WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
```

**Step 3: Restart and test**

```bash
pm2 restart jarvis-snapshot && sleep 3
source /root/.openclaw/.env

# Create a partner
curl -sk -X POST https://localhost:4242/api/partners \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Broker","type":"mortgage_broker","fee_type":"flat","fee_value":800}'

# List partners
curl -sk https://localhost:4242/api/partners \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD"
```

Expected: partner created with id=1, then listed.

**Step 4: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add partners CRUD API endpoints"
```

---

### Task 3: Referrals API Endpoints

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js` (add after partners routes)

**Step 1: Add the routes**

```js
// ── Referrals ─────────────────────────────────────────────────────────────
app.get('/api/referrals', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name as contact_name, c.mobile as contact_mobile, c.address as contact_address,
           p.name as partner_name, p.type as partner_type
    FROM referrals r
    LEFT JOIN contacts c ON c.id = r.contact_id
    LEFT JOIN partners p ON p.id = r.partner_id
    ORDER BY r.referred_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/referrals', auth, (req, res) => {
  const { contact_id, partner_id, type, expected_fee, disclosure_sent, notes } = req.body;
  if (!contact_id || !partner_id || !type) return res.status(400).json({ error: 'contact_id, partner_id, type required' });
  const VALID_TYPES = ['vendor', 'buyer', 'finance'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });
  const result = db.prepare(
    'INSERT INTO referrals (contact_id, partner_id, type, expected_fee, disclosure_sent, notes) VALUES (?,?,?,?,?,?)'
  ).run(contact_id, partner_id, type, expected_fee || null, disclosure_sent ? 1 : 0, notes || null);
  const row = db.prepare(`
    SELECT r.*, c.name as contact_name, p.name as partner_name, p.type as partner_type
    FROM referrals r
    LEFT JOIN contacts c ON c.id = r.contact_id
    LEFT JOIN partners p ON p.id = r.partner_id
    WHERE r.id = ?
  `).get(result.lastInsertRowid);
  res.json(row);
});

app.put('/api/referrals/:id', auth, (req, res) => {
  const VALID_STATUSES = ['referred', 'introduced', 'active', 'settled', 'paid'];
  const { status, actual_fee, notes, settled_at, paid_at } = req.body;
  const fields = [];
  const params = [];
  if (status && VALID_STATUSES.includes(status)) {
    fields.push('status = ?'); params.push(status);
    if (status === 'settled' && !settled_at) { fields.push('settled_at = ?'); params.push(new Date().toISOString()); }
    if (status === 'paid' && !paid_at) { fields.push('paid_at = ?'); params.push(new Date().toISOString()); }
  }
  if (actual_fee != null) { fields.push('actual_fee = ?'); params.push(actual_fee); }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (settled_at !== undefined) { fields.push('settled_at = ?'); params.push(settled_at); }
  if (paid_at !== undefined) { fields.push('paid_at = ?'); params.push(paid_at); }
  if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE referrals SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare(`
    SELECT r.*, c.name as contact_name, p.name as partner_name, p.type as partner_type
    FROM referrals r LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN partners p ON p.id = r.partner_id
    WHERE r.id = ?
  `).get(req.params.id));
});
```

**Step 2: Test**

```bash
pm2 restart jarvis-snapshot && sleep 3
source /root/.openclaw/.env

# Get a real contact_id to test with
sqlite3 /root/.openclaw/workspace/jarvis.db "SELECT id FROM contacts LIMIT 1;"

# Create a referral (replace CONTACT_ID with result above)
curl -sk -X POST https://localhost:4242/api/referrals \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"contact_id":"CONTACT_ID","partner_id":1,"type":"finance","expected_fee":800,"disclosure_sent":true}'

# Update status to introduced
curl -sk -X PUT https://localhost:4242/api/referrals/1 \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"status":"introduced"}'

# List all
curl -sk https://localhost:4242/api/referrals \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD"
```

Expected: referral created, status updated, listed with contact_name and partner_name joined.

**Step 3: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js
git commit -m "feat: add referrals CRUD API endpoints"
```

---

### Task 4: Dashboard — Refer Modal + ContactCard Button

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

**Step 1: Add ReferModal component**

Find the `ContactNotesModal` component and add the following new component after it:

```jsx
function ReferModal({ contact, onClose, onSuccess }) {
  const [partners, setPartners] = React.useState([]);
  const [partnerId, setPartnerId] = React.useState('');
  const [type, setType] = React.useState('');
  const [disclosureSent, setDisclosureSent] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    apiFetch('/api/partners').then(r => r.json()).then(data => {
      setPartners(data);
      if (data.length) setPartnerId(String(data[0].id));
    });
    // Pre-suggest type from contact_class
    const cc = (contact.contact_class || '').toLowerCase();
    if (cc.includes('vendor')) setType('vendor');
    else if (cc.includes('buyer')) setType('buyer');
    else setType('finance');
  }, []);

  const partner = partners.find(p => String(p.id) === partnerId);
  const expectedFee = partner ? (
    partner.fee_type === 'percentage'
      ? `~${partner.fee_value}% of commission`
      : `$${partner.fee_value.toLocaleString()} flat`
  ) : '';

  async function handleSubmit(e) {
    e.preventDefault();
    if (!disclosureSent) { setError('You must confirm disclosure was sent.'); return; }
    setSaving(true);
    const feeVal = partner?.fee_type === 'flat' ? partner.fee_value : null;
    await apiFetch('/api/referrals', {
      method: 'POST',
      body: JSON.stringify({
        contact_id: contact.id,
        partner_id: parseInt(partnerId),
        type,
        expected_fee: feeVal,
        disclosure_sent: true,
        notes
      })
    });
    setSaving(false);
    onSuccess();
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{maxWidth:'440px'}}>
        <div className="modal-header">
          <h3 style={{color:'var(--gold)'}}>Refer Contact</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div style={{padding:'16px',color:'var(--text-primary)',fontSize:'13px',marginBottom:'4px'}}>
          <strong>{contact.name}</strong><br/>
          <span style={{color:'var(--text-muted)',fontSize:'12px'}}>{contact.address}</span>
        </div>
        <form onSubmit={handleSubmit} style={{padding:'0 16px 16px'}}>
          <div style={{marginBottom:'12px'}}>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>PARTNER</label>
            {partners.length === 0
              ? <p style={{color:'var(--text-muted)',fontSize:'12px'}}>No partners yet — add them in the Referrals page.</p>
              : <select value={partnerId} onChange={e => setPartnerId(e.target.value)}
                  style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'8px',borderRadius:'4px'}}>
                  {partners.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.type.replace('_',' ')})</option>
                  ))}
                </select>
            }
          </div>
          {partner && <div style={{marginBottom:'12px',padding:'8px',background:'var(--bg-raised)',borderRadius:'4px',fontSize:'12px',color:'var(--gold)'}}>
            Fee: {expectedFee}
          </div>}
          <div style={{marginBottom:'12px'}}>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>REFERRAL TYPE</label>
            <select value={type} onChange={e => setType(e.target.value)}
              style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'8px',borderRadius:'4px'}}>
              <option value="vendor">Vendor</option>
              <option value="buyer">Buyer</option>
              <option value="finance">Finance / Mortgage</option>
            </select>
          </div>
          <div style={{marginBottom:'12px'}}>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>NOTES (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'8px',borderRadius:'4px',resize:'vertical',boxSizing:'border-box'}} />
          </div>
          <div style={{marginBottom:'16px',padding:'10px',background:'rgba(200,169,110,0.08)',border:'1px solid var(--border-gold)',borderRadius:'4px'}}>
            <label style={{display:'flex',alignItems:'flex-start',gap:'8px',cursor:'pointer',fontSize:'12px',color:'var(--text-primary)'}}>
              <input type="checkbox" checked={disclosureSent} onChange={e => setDisclosureSent(e.target.checked)} style={{marginTop:'2px'}} />
              <span>I have sent a disclosure SMS/email to <strong>{contact.name}</strong> advising that I may receive a referral fee for this introduction.</span>
            </label>
          </div>
          {error && <p style={{color:'#ef4444',fontSize:'12px',marginBottom:'8px'}}>{error}</p>}
          <button type="submit" disabled={saving || partners.length === 0}
            style={{width:'100%',padding:'10px',background:'var(--gold)',color:'#000',border:'none',borderRadius:'4px',fontWeight:'600',cursor:'pointer',opacity: saving ? 0.6 : 1}}>
            {saving ? 'Referring...' : 'Confirm Referral'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

**Step 2: Add "Refer" button to ContactCard**

Find the actions row inside `ContactCard` (near the Call button / Log Outcome section). Add a "Refer" button alongside the existing actions, and wire up the modal state:

Inside the `ContactCard` function, add to the state declarations:
```jsx
const [showReferModal, setShowReferModal] = React.useState(false);
```

Add the button in the actions area (after the existing Call button, before or after Log Outcome):
```jsx
<button onClick={() => setShowReferModal(true)}
  style={{padding:'6px 12px',background:'transparent',border:'1px solid var(--border-subtle)',color:'var(--text-muted)',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}}>
  Refer
</button>
```

Add the modal render at the end of the ContactCard return (before closing div):
```jsx
{showReferModal && (
  <ReferModal
    contact={contact}
    onClose={() => setShowReferModal(false)}
    onSuccess={() => {/* optional: show toast */}}
  />
)}
```

**Step 3: Visual check**

Open https://72.62.74.105:4242 in browser. Open a prospect card on the call board — verify "Refer" button appears. Click it — modal should open showing partner dropdown (empty if no partners yet) and disclosure checkbox. Close it.

**Step 4: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add ReferModal and Refer button to ContactCard"
```

---

### Task 5: Dashboard — Referrals Pipeline Page

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

**Step 1: Add ReferralsPage component**

Add this component before the main `App` function:

```jsx
const REFERRAL_STATUSES = ['referred','introduced','active','settled','paid'];
const STATUS_LABELS = { referred:'Referred', introduced:'Introduced', active:'Active', settled:'Settled', paid:'Paid' };
const STATUS_COLORS = { referred:'var(--text-muted)', introduced:'var(--gold)', active:'#3b82f6', settled:'#22c55e', paid:'#a855f7' };
const TYPE_LABELS = { vendor:'Vendor', buyer:'Buyer', finance:'Finance' };

function ReferralsPage() {
  const [referrals, setReferrals] = React.useState([]);
  const [partners, setPartners] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showPartners, setShowPartners] = React.useState(false);
  const [newPartner, setNewPartner] = React.useState({ name:'', type:'selling_agent', fee_type:'percentage', fee_value:'20', suburb_focus:'', mobile:'' });
  const [savingPartner, setSavingPartner] = React.useState(false);

  function load() {
    Promise.all([
      apiFetch('/api/referrals').then(r => r.json()),
      apiFetch('/api/partners').then(r => r.json())
    ]).then(([refs, parts]) => {
      setReferrals(refs);
      setPartners(parts);
      setLoading(false);
    });
  }

  React.useEffect(load, []);

  async function updateStatus(id, status) {
    await apiFetch(`/api/referrals/${id}`, { method:'PUT', body: JSON.stringify({ status }) });
    load();
  }

  async function addPartner(e) {
    e.preventDefault();
    setSavingPartner(true);
    await apiFetch('/api/partners', { method:'POST', body: JSON.stringify({ ...newPartner, fee_value: parseFloat(newPartner.fee_value) }) });
    setNewPartner({ name:'', type:'selling_agent', fee_type:'percentage', fee_value:'20', suburb_focus:'', mobile:'' });
    setSavingPartner(false);
    load();
  }

  const expectedTotal = referrals.filter(r => r.status !== 'paid').reduce((s, r) => s + (r.expected_fee || 0), 0);
  const receivedTotal = referrals.filter(r => r.status === 'paid').reduce((s, r) => s + (r.actual_fee || r.expected_fee || 0), 0);

  const byStatus = REFERRAL_STATUSES.reduce((acc, s) => {
    acc[s] = referrals.filter(r => r.status === s);
    return acc;
  }, {});

  if (loading) return <div style={{padding:'40px',color:'var(--text-muted)',textAlign:'center'}}>Loading referrals...</div>;

  return (
    <div style={{padding:'20px',maxWidth:'1200px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'20px'}}>
        <h2 style={{color:'var(--gold)',margin:0,fontSize:'18px',letterSpacing:'0.1em'}}>REFERRAL PIPELINE</h2>
        <button onClick={() => setShowPartners(!showPartners)}
          style={{padding:'8px 16px',background:'transparent',border:'1px solid var(--border-gold)',color:'var(--gold)',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}}>
          {showPartners ? 'Hide Partners' : 'Manage Partners'}
        </button>
      </div>

      {/* Revenue summary */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'12px',marginBottom:'24px'}}>
        <div style={{padding:'16px',background:'var(--bg-surface)',border:'1px solid var(--border-subtle)',borderRadius:'6px'}}>
          <div style={{color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>ACTIVE PIPELINE</div>
          <div style={{color:'var(--gold)',fontSize:'22px',fontWeight:'600'}}>${expectedTotal.toLocaleString()}</div>
        </div>
        <div style={{padding:'16px',background:'var(--bg-surface)',border:'1px solid var(--border-subtle)',borderRadius:'6px'}}>
          <div style={{color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>RECEIVED</div>
          <div style={{color:'#22c55e',fontSize:'22px',fontWeight:'600'}}>${receivedTotal.toLocaleString()}</div>
        </div>
        <div style={{padding:'16px',background:'var(--bg-surface)',border:'1px solid var(--border-subtle)',borderRadius:'6px'}}>
          <div style={{color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>TOTAL REFERRALS</div>
          <div style={{color:'var(--text-primary)',fontSize:'22px',fontWeight:'600'}}>{referrals.length}</div>
        </div>
      </div>

      {/* Partners panel */}
      {showPartners && (
        <div style={{marginBottom:'24px',padding:'16px',background:'var(--bg-surface)',border:'1px solid var(--border-gold)',borderRadius:'6px'}}>
          <h3 style={{color:'var(--gold)',margin:'0 0 12px',fontSize:'13px',letterSpacing:'0.08em'}}>PARTNERS</h3>
          <div style={{display:'grid',gap:'8px',marginBottom:'16px'}}>
            {partners.length === 0 && <p style={{color:'var(--text-muted)',fontSize:'12px',margin:0}}>No partners yet.</p>}
            {partners.map(p => (
              <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:'var(--bg-raised)',borderRadius:'4px',fontSize:'12px'}}>
                <div>
                  <span style={{color:'var(--text-primary)',fontWeight:'500'}}>{p.name}</span>
                  <span style={{color:'var(--text-muted)',marginLeft:'8px'}}>{p.type.replace(/_/g,' ')}</span>
                  {p.suburb_focus && <span style={{color:'var(--text-muted)',marginLeft:'8px'}}>· {p.suburb_focus}</span>}
                </div>
                <span style={{color:'var(--gold)'}}>
                  {p.fee_type === 'percentage' ? `${p.fee_value}%` : `$${p.fee_value.toLocaleString()} flat`}
                </span>
              </div>
            ))}
          </div>
          <form onSubmit={addPartner} style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr auto',gap:'8px',alignItems:'end'}}>
            <div>
              <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>NAME</label>
              <input value={newPartner.name} onChange={e => setNewPartner({...newPartner,name:e.target.value})} required
                placeholder="Partner name"
                style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
            </div>
            <div>
              <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>TYPE</label>
              <select value={newPartner.type} onChange={e => setNewPartner({...newPartner,type:e.target.value})}
                style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}}>
                <option value="selling_agent">Selling Agent</option>
                <option value="buyers_agent">Buyers Agent</option>
                <option value="mortgage_broker">Mortgage Broker</option>
              </select>
            </div>
            <div>
              <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>FEE</label>
              <div style={{display:'flex',gap:'4px'}}>
                <select value={newPartner.fee_type} onChange={e => setNewPartner({...newPartner,fee_type:e.target.value})}
                  style={{background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}}>
                  <option value="percentage">%</option>
                  <option value="flat">$</option>
                </select>
                <input value={newPartner.fee_value} onChange={e => setNewPartner({...newPartner,fee_value:e.target.value})} type="number" required
                  style={{width:'60px',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
              </div>
            </div>
            <div>
              <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>SUBURB FOCUS</label>
              <input value={newPartner.suburb_focus} onChange={e => setNewPartner({...newPartner,suburb_focus:e.target.value})}
                placeholder="Optional"
                style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
            </div>
            <button type="submit" disabled={savingPartner}
              style={{padding:'7px 16px',background:'var(--gold)',color:'#000',border:'none',borderRadius:'4px',fontWeight:'600',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap'}}>
              Add Partner
            </button>
          </form>
        </div>
      )}

      {/* Pipeline columns */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:'12px'}}>
        {REFERRAL_STATUSES.map(status => (
          <div key={status}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
              <span style={{color:STATUS_COLORS[status],fontSize:'11px',fontWeight:'600',letterSpacing:'0.08em'}}>{STATUS_LABELS[status].toUpperCase()}</span>
              <span style={{color:'var(--text-muted)',fontSize:'11px'}}>{byStatus[status].length}</span>
            </div>
            <div style={{display:'grid',gap:'8px'}}>
              {byStatus[status].length === 0 && (
                <div style={{padding:'12px',background:'var(--bg-surface)',borderRadius:'4px',fontSize:'11px',color:'var(--text-muted)',textAlign:'center'}}>—</div>
              )}
              {byStatus[status].map(r => (
                <div key={r.id} style={{padding:'10px',background:'var(--bg-surface)',border:'1px solid var(--border-subtle)',borderRadius:'4px'}}>
                  <div style={{color:'var(--text-primary)',fontSize:'12px',fontWeight:'500',marginBottom:'2px'}}>{r.contact_name || 'Unknown'}</div>
                  <div style={{color:'var(--text-muted)',fontSize:'11px',marginBottom:'4px'}}>{r.contact_address}</div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'6px'}}>
                    <span style={{fontSize:'10px',color:'var(--text-muted)',textTransform:'uppercase'}}>{TYPE_LABELS[r.type]} → {r.partner_name}</span>
                  </div>
                  {r.expected_fee && <div style={{color:'var(--gold)',fontSize:'11px',marginBottom:'6px'}}>${r.expected_fee.toLocaleString()}</div>}
                  <select value={r.status} onChange={e => updateStatus(r.id, e.target.value)}
                    style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:STATUS_COLORS[r.status],padding:'4px',borderRadius:'3px',fontSize:'10px',cursor:'pointer'}}>
                    {REFERRAL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Wire up routing**

Find the `App` function's page routing (the section that renders `SearchPage`, `RemindersPage` etc.). Add the REFERRALS case:

```jsx
// In the page render switch/if-else, add:
if (page === 'referrals') return <ReferralsPage />;
```

**Step 3: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add ReferralsPage component with pipeline and partners management"
```

---

### Task 6: Navigation — Add REFERRALS to Sidebar + BottomTabBar

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

**Step 1: Find the sidebar nav items**

Search for where `SEARCH` or `REMINDERS` nav items are defined in the sidebar. Add REFERRALS as the next item:

```jsx
{ id: 'referrals', label: 'REFERRALS', icon: 'GitBranch' }
```

**Step 2: Add to BottomTabBar**

Find the mobile `BottomTabBar` array and add the same item.

**Step 3: Bump PWA cache**

In `/root/.openclaw/workspace/dashboard/sw.js`, change:
```js
const CACHE = 'jarvis-v3';
```
to:
```js
const CACHE = 'jarvis-v4';
```

**Step 4: Restart and verify**

```bash
pm2 restart jarvis-snapshot && sleep 2
```

Open https://72.62.74.105:4242 — verify:
- REFERRALS appears in sidebar
- Clicking it loads the pipeline page
- Revenue summary shows $0/$0/0
- "Manage Partners" button shows add-partner form
- Add a test partner → verify it appears in list
- Navigate to call board → open a contact → "Refer" button visible → modal opens with partner in dropdown

**Step 5: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js workspace/dashboard/sw.js
git commit -m "feat: add Referrals nav item, wire routing, bump PWA cache to v4"
```

---

### Task 7: Buyer Brief in ReferModal + Pipeline Card

**Files:**
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js`

**Step 1: Expand ReferModal with buyer brief fields**

Inside `ReferModal`, after the referral type selector, add a conditional section that appears when `type === 'buyer'`:

```jsx
{type === 'buyer' && (
  <div style={{padding:'10px',background:'rgba(59,130,246,0.08)',border:'1px solid rgba(59,130,246,0.3)',borderRadius:'4px',marginBottom:'12px'}}>
    <div style={{color:'#3b82f6',fontSize:'11px',fontWeight:'600',letterSpacing:'0.08em',marginBottom:'10px'}}>BUYER BRIEF — required for buyers agent referral</div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px',marginBottom:'8px'}}>
      <div>
        <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>BUDGET MIN</label>
        <input type="number" value={buyerBrief.budget_min} onChange={e => setBuyerBrief({...buyerBrief,budget_min:e.target.value})}
          placeholder="e.g. 1500000"
          style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
      </div>
      <div>
        <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>BUDGET MAX</label>
        <input type="number" value={buyerBrief.budget_max} onChange={e => setBuyerBrief({...buyerBrief,budget_max:e.target.value})}
          placeholder="e.g. 2200000"
          style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
      </div>
    </div>
    <div style={{marginBottom:'8px'}}>
      <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>TARGET SUBURBS</label>
      <input value={buyerBrief.suburbs} onChange={e => setBuyerBrief({...buyerBrief,suburbs:e.target.value})}
        placeholder="e.g. Mosman, Cremorne, Neutral Bay"
        style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}} />
    </div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px'}}>
      <div>
        <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>PROPERTY TYPE</label>
        <select value={buyerBrief.property_type} onChange={e => setBuyerBrief({...buyerBrief,property_type:e.target.value})}
          style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}}>
          <option value="">Any</option>
          <option value="house">House</option>
          <option value="unit">Unit</option>
          <option value="townhouse">Townhouse</option>
        </select>
      </div>
      <div>
        <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>TIMEFRAME</label>
        <select value={buyerBrief.timeframe} onChange={e => setBuyerBrief({...buyerBrief,timeframe:e.target.value})}
          style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}}>
          <option value="">Unknown</option>
          <option value="asap">ASAP</option>
          <option value="1-3 months">1–3 months</option>
          <option value="3-6 months">3–6 months</option>
          <option value="6+ months">6+ months</option>
        </select>
      </div>
      <div>
        <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>PRE-APPROVED?</label>
        <select value={buyerBrief.pre_approved} onChange={e => setBuyerBrief({...buyerBrief,pre_approved:e.target.value})}
          style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'12px'}}>
          <option value="">Unknown</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
    </div>
  </div>
)}
```

Add state in ReferModal:
```jsx
const [buyerBrief, setBuyerBrief] = React.useState({ budget_min:'', budget_max:'', suburbs:'', property_type:'', timeframe:'', pre_approved:'' });
```

In `useEffect`, if the contact has a `buyer_profile`, pre-populate:
```jsx
// After fetching partners, check for existing buyer profile
apiFetch(`/api/buyer-profiles?contact_id=${contact.id}`).then(r => r.json()).then(profiles => {
  if (profiles && profiles.length) {
    const p = profiles[0];
    setBuyerBrief({
      budget_min: p.price_min || '',
      budget_max: p.price_max || '',
      suburbs: p.suburbs_wanted || '',
      property_type: p.property_type || '',
      timeframe: p.timeframe || '',
      pre_approved: ''
    });
  }
});
```

In `handleSubmit`, include buyer_brief when type === 'buyer':
```jsx
const payload = {
  contact_id: contact.id,
  partner_id: parseInt(partnerId),
  type,
  expected_fee: feeVal,
  disclosure_sent: true,
  notes,
  buyer_brief: type === 'buyer' ? JSON.stringify(buyerBrief) : null
};
```

**Step 2: Show buyer brief on pipeline cards**

In `ReferralsPage`, for buyer referral cards, parse and show the brief under the contact address:

```jsx
{r.type === 'buyer' && r.buyer_brief && (() => {
  try {
    const b = JSON.parse(r.buyer_brief);
    const budget = b.budget_min && b.budget_max
      ? `$${(b.budget_min/1e6).toFixed(1)}M–$${(b.budget_max/1e6).toFixed(1)}M`
      : '';
    return (
      <div style={{fontSize:'10px',color:'#3b82f6',marginBottom:'4px',lineHeight:'1.4'}}>
        {budget && <span>{budget} · </span>}
        {b.suburbs && <span>{b.suburbs} · </span>}
        {b.pre_approved === 'yes' && <span style={{color:'#22c55e'}}>Pre-approved ✓</span>}
        {b.timeframe && <span> · {b.timeframe}</span>}
      </div>
    );
  } catch { return null; }
})()}
```

**Step 3: Test buyer referral flow**

1. Add a buyers agent partner (e.g. "Sydney Buyer's Agency", buyers_agent, flat $3500)
2. Open a contact with "Buyer" in their contact_class
3. Click Refer → type auto-suggests "buyer" → blue brief section appears
4. Fill in budget, suburbs, tick pre-approved, set timeframe
5. Tick disclosure → submit
6. Go to REFERRALS page → card shows budget range + suburbs + pre-approved ✓ in blue

**Step 4: Commit**

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: add buyer brief capture to ReferModal and pipeline card display"
```

---

### Task 8: Import 124k AgentBox Contacts to SQLite

**Files:**
- Create: `/root/.openclaw/scripts/import-agentbox-contacts.js`
- Modify: `/root/.openclaw/lib/db.js` (add `agentbox_contacts` table migration)

**Step 1: Add table migration to db.js**

Add after the referrals migration block:

```js
// Schema migrations — agentbox_contacts table (full McGrath Love Local CRM)
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agentbox_contacts'").get()) {
  db.prepare(`CREATE TABLE IF NOT EXISTS agentbox_contacts (
    id           TEXT PRIMARY KEY,
    name         TEXT,
    mobile       TEXT,
    email        TEXT,
    address      TEXT,
    suburb       TEXT,
    state        TEXT,
    postcode     TEXT,
    contact_class TEXT,
    do_not_call  TEXT,
    last_modified TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agentbox_suburb ON agentbox_contacts(suburb)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agentbox_class ON agentbox_contacts(contact_class)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agentbox_mobile ON agentbox_contacts(mobile)').run();
  console.log('[db] agentbox_contacts table created');
}
```

**Step 2: Write the import script**

```js
// scripts/import-agentbox-contacts.js
require('/root/.openclaw/skills/agentbox-willoughby/node_modules/dotenv').config({ path: '/root/.openclaw/.env' });
const fs = require('fs');
const Database = require('/root/.openclaw/node_modules/better-sqlite3');

const db = new Database('/root/.openclaw/workspace/jarvis.db');
const raw = fs.readFileSync('/root/.openclaw/workspace/willoughby-contacts.json', 'utf8');
const data = JSON.parse(raw);
const contacts = data.contacts;
const total = Object.keys(contacts).length;

console.log(`Importing ${total} contacts...`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO agentbox_contacts
  (id, name, mobile, email, address, suburb, state, postcode, contact_class, do_not_call, last_modified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const importAll = db.transaction(() => {
  let count = 0;
  for (let i = 0; i < total; i++) {
    const c = contacts[String(i)];
    if (!c || !c.id) continue;
    insert.run(
      String(c.id),
      c.name || null,
      c.mobile || null,
      c.email || null,
      c.address || null,
      c.suburb || null,
      c.state || null,
      c.postcode || null,
      c.contactClass || null,
      c.doNotCall || null,
      c.lastModified || null
    );
    count++;
    if (count % 10000 === 0) console.log(`  ${count}/${total}...`);
  }
  return count;
});

const count = importAll();
console.log(`Done — ${count} contacts imported.`);

// Verify
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(mobile) as with_mobile,
    COUNT(CASE WHEN do_not_call != 'YES' OR do_not_call IS NULL THEN 1 END) as callable
  FROM agentbox_contacts
`).get();
console.log('Stats:', stats);
db.close();
```

**Step 3: Run the import**

```bash
pm2 restart jarvis-snapshot --update-env && sleep 2
node /root/.openclaw/scripts/import-agentbox-contacts.js
```

Expected:
```
Importing 124000 contacts...
  10000/124000...
  20000/124000...
  ...
Done — 124000 contacts imported.
Stats: { total: 124000, with_mobile: 93063, callable: ... }
```

**Step 4: Verify via sqlite3**

```bash
sqlite3 /root/.openclaw/workspace/jarvis.db "
  SELECT suburb, COUNT(*) as n
  FROM agentbox_contacts
  WHERE (contact_class LIKE '%Buyer%' OR contact_class LIKE '%Vendor%')
    AND mobile IS NOT NULL
  GROUP BY suburb
  ORDER BY n DESC
  LIMIT 15;
"
```

**Step 5: Commit**

```bash
cd /root/.openclaw
git add lib/db.js scripts/import-agentbox-contacts.js
git commit -m "feat: import 124k agentbox contacts to SQLite for referral prospecting"
```

---

### Task 9: Referral Prospecting Page

**Files:**
- Modify: `/root/.openclaw/snapshot-server.js` (new search endpoint)
- Modify: `/root/.openclaw/workspace/dashboard/dashboard.js` (new page component)

**Step 1: Add API endpoint**

```js
// GET /api/referral-prospects?suburb=Mosman&type=buyer&page=1
app.get('/api/referral-prospects', auth, (req, res) => {
  const VALID_TYPES = ['buyer', 'vendor', 'all'];
  const type = VALID_TYPES.includes(req.query.type) ? req.query.type : 'buyer';
  const suburb = req.query.suburb ? req.query.suburb.trim() : null;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  // Exclude contacts already in our local patch
  const PATCH_SUBURBS = ['Willoughby','North Willoughby','Willoughby East','Castlecrag','Middle Cove'];

  const conditions = [`suburb NOT IN (${PATCH_SUBURBS.map(() => '?').join(',')})`, '(do_not_call IS NULL OR do_not_call != ?)'];
  const params = [...PATCH_SUBURBS, 'YES'];

  if (suburb) { conditions.push('suburb = ?'); params.push(suburb); }

  if (type === 'buyer') {
    conditions.push("(contact_class LIKE '%Buyer%' OR contact_class LIKE '%Prospective Buyer%')");
  } else if (type === 'vendor') {
    conditions.push("(contact_class LIKE '%Vendor%' OR contact_class LIKE '%Prospective Vendor%')");
  }

  conditions.push('mobile IS NOT NULL');

  const where = 'WHERE ' + conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as n FROM agentbox_contacts ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM agentbox_contacts ${where} ORDER BY last_modified DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  res.json({ rows, total, page, pages: Math.ceil(total / limit) });
});
```

**Step 2: Add ReferralProspectsPage component**

```jsx
function ReferralProspectsPage() {
  const [results, setResults] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [suburb, setSuburb] = React.useState('');
  const [type, setType] = React.useState('buyer');
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [referContact, setReferContact] = React.useState(null);

  function search(p = 1) {
    setLoading(true);
    const params = new URLSearchParams({ type, page: p });
    if (suburb.trim()) params.set('suburb', suburb.trim());
    apiFetch(`/api/referral-prospects?${params}`).then(r => r.json()).then(data => {
      setResults(data.rows || []);
      setTotal(data.total || 0);
      setPage(p);
      setLoading(false);
    });
  }

  React.useEffect(() => { search(1); }, [type]);

  return (
    <div style={{padding:'20px',maxWidth:'900px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'16px'}}>
        <h2 style={{color:'var(--gold)',margin:0,fontSize:'18px',letterSpacing:'0.1em'}}>REFERRAL PROSPECTS</h2>
        <span style={{color:'var(--text-muted)',fontSize:'12px'}}>{total.toLocaleString()} contacts</span>
      </div>

      {/* Filters */}
      <div style={{display:'flex',gap:'8px',marginBottom:'16px',flexWrap:'wrap'}}>
        <select value={type} onChange={e => { setType(e.target.value); setPage(1); }}
          style={{background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'8px 12px',borderRadius:'4px',fontSize:'12px'}}>
          <option value="buyer">Active Buyers</option>
          <option value="vendor">Prospective Vendors</option>
          <option value="all">All</option>
        </select>
        <input value={suburb} onChange={e => setSuburb(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search(1)}
          placeholder="Filter by suburb (e.g. Mosman)"
          style={{flex:1,minWidth:'180px',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-primary)',padding:'8px 12px',borderRadius:'4px',fontSize:'12px'}} />
        <button onClick={() => search(1)}
          style={{padding:'8px 20px',background:'var(--gold)',color:'#000',border:'none',borderRadius:'4px',fontWeight:'600',cursor:'pointer',fontSize:'12px'}}>
          Search
        </button>
      </div>

      {/* Type emphasis banner for buyers */}
      {type === 'buyer' && (
        <div style={{padding:'10px 14px',background:'rgba(59,130,246,0.08)',border:'1px solid rgba(59,130,246,0.3)',borderRadius:'4px',marginBottom:'16px',fontSize:'12px',color:'#3b82f6'}}>
          Buyers agent referrals pay <strong>$2,000–$5,000</strong> per settled purchase. Capture their brief to maximise referral value.
        </div>
      )}

      {loading && <div style={{color:'var(--text-muted)',textAlign:'center',padding:'40px'}}>Loading...</div>}

      {!loading && results.map(c => (
        <div key={c.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',background:'var(--bg-surface)',border:'1px solid var(--border-subtle)',borderRadius:'4px',marginBottom:'6px'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{color:'var(--text-primary)',fontSize:'13px',fontWeight:'500'}}>{c.name}</div>
            <div style={{color:'var(--text-muted)',fontSize:'11px'}}>{c.address}{c.suburb ? ` · ${c.suburb}` : ''}</div>
            <div style={{color:'var(--text-muted)',fontSize:'10px',marginTop:'2px'}}>{c.contact_class}</div>
          </div>
          <div style={{display:'flex',gap:'8px',alignItems:'center',flexShrink:0,marginLeft:'12px'}}>
            {c.mobile && <a href={`tel:${c.mobile}`} style={{color:'var(--gold)',fontSize:'12px',textDecoration:'none'}}>{c.mobile}</a>}
            <button onClick={() => setReferContact(c)}
              style={{padding:'5px 12px',background:'transparent',border:'1px solid var(--border-gold)',color:'var(--gold)',borderRadius:'4px',cursor:'pointer',fontSize:'11px',fontWeight:'600'}}>
              Refer
            </button>
          </div>
        </div>
      ))}

      {/* Pagination */}
      {total > 50 && (
        <div style={{display:'flex',gap:'8px',marginTop:'16px',justifyContent:'center'}}>
          <button onClick={() => search(page - 1)} disabled={page <= 1}
            style={{padding:'6px 16px',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-muted)',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}}>
            Prev
          </button>
          <span style={{color:'var(--text-muted)',fontSize:'12px',lineHeight:'30px'}}>Page {page}</span>
          <button onClick={() => search(page + 1)} disabled={results.length < 50}
            style={{padding:'6px 16px',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',color:'var(--text-muted)',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}}>
            Next
          </button>
        </div>
      )}

      {referContact && (
        <ReferModal
          contact={{...referContact, contact_class: referContact.contact_class}}
          onClose={() => setReferContact(null)}
          onSuccess={() => setReferContact(null)}
        />
      )}
    </div>
  );
}
```

**Step 3: Wire routing**

Add to App routing:
```jsx
if (page === 'prospects') return <ReferralProspectsPage />;
```

Add to sidebar and BottomTabBar under REFERRALS:
```jsx
{ id: 'prospects', label: 'PROSPECTS', icon: 'Users' }
```

**Step 4: Test**

```bash
source /root/.openclaw/.env
curl -sk "https://localhost:4242/api/referral-prospects?type=buyer&suburb=Mosman" \
  -H "Authorization: Bearer $DASHBOARD_PASSWORD" | python3 -m json.tool | head -40
```

Expected: 50 buyer contacts from Mosman with name/mobile/contact_class.

Open dashboard → PROSPECTS nav item → "Active Buyers" filter default → Mosman buyers visible → click "Refer" → ReferModal opens with buyer brief fields.

**Step 5: Commit**

```bash
cd /root/.openclaw
git add snapshot-server.js workspace/dashboard/dashboard.js
git commit -m "feat: add referral prospects page with buyers-first filter and 124k CRM search"
```

---

### Task 10: End-to-End Smoke Test

**Full vendor referral flow:**
1. REFERRALS → Manage Partners → add "McGrath Mosman Agent", selling_agent, 20%, suburb: Mosman
2. Call board → open contact → Refer → type: vendor → fee shows `~$X (20%)` → tick disclosure → submit
3. REFERRALS page → card in "Referred" column → advance to "Introduced"

**Full buyer referral flow:**
1. Add "Sydney Buyers Agency", buyers_agent, flat $3500
2. PROSPECTS page → type: Active Buyers → filter suburb: Mosman → click Refer on a result
3. Modal shows blue buyer brief section → fill budget $1.8M–$2.2M, suburbs: Mosman/Cremorne, pre-approved: yes, timeframe: 1–3 months
4. Tick disclosure → submit
5. REFERRALS page → buyer card shows brief summary in blue: `$1.8M–$2.2M · Mosman/Cremorne · Pre-approved ✓ · 1–3 months`
6. Mark as "Introduced" → Active Pipeline total updates

**Full finance referral flow:**
1. Add "Shore Finance", mortgage_broker, flat $800
2. Refer any buyer contact → type: finance → fee shows $800 flat → submit
3. Pipeline card shows correctly

**Final commit**

```bash
cd /root/.openclaw && git push origin main
```
