# Referral Business Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a referral pipeline to Jarvis — track partner agents/brokers, log referrals from the call board, and monitor expected vs received revenue.

**Architecture:** New `partners` and `referrals` tables in SQLite via `lib/db.js`. CRUD API endpoints in `snapshot-server.js`. Dashboard gains a "Refer" action on ContactCard, a new REFERRALS page with pipeline view, and a Partners management section.

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

### Task 7: End-to-End Smoke Test

**Full flow:**

1. Go to REFERRALS page → Manage Partners → add a selling agent partner (e.g. "Jane Smith", selling_agent, 20%, suburb: Chatswood)
2. Go to Circle Prospecting call board → open any contact → click "Refer"
3. Modal shows: Jane Smith selected, type pre-suggested, fee shown
4. Tick disclosure checkbox → click Confirm Referral
5. Go back to REFERRALS page → contact appears in "Referred" column with expected fee
6. Change status dropdown to "Introduced" → card moves column
7. Check Active Pipeline total updated

If all steps pass, the feature is complete.

**Final commit**

```bash
cd /root/.openclaw && git push origin main
```
