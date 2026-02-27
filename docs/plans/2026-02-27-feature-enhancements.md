# Feature Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify the two contact card components into one, add contact add/edit everywhere, add a call stats header, add a daily agenda widget, and smart-prefix all call log notes with context.

**Architecture:** Single `ContactCard` replaces `ContactCard` (circle) and `ProspectCard` (sold/listed) — context prop drives API routing and note prefix. Four new server endpoints (`POST /api/contacts`, `GET /api/stats/today`, `GET /api/agenda/today`). iCloud CalDAV read added to `lib/ical-calendar.js`.

**Tech Stack:** React 18 Babel SPA (no build), Express/SQLite, iCloud CalDAV via axios.

---

## Current State Reference

- `dashboard.js:307–479` — `ContactCard` (circle only, no edit/notes buttons)
- `dashboard.js:742–938` — `ProspectCard` (sold/listed only, has edit/notes buttons)
- `dashboard.js:2007–2265` — `SearchCard` (no edit/notes buttons)
- `dashboard.js:2676–2761` — `App` component + page header (no stats widget)
- `lib/ical-calendar.js:74–113` — `createCalendarEvent` only, no read
- `snapshot-server.js:1115–1143` — `PATCH /api/contacts/:id` (edit only, no POST)
- `snapshot-server.js:1722–1738` — `POST /api/log-call`

---

## Task 1: Unified ContactCard

Replace the two separate card components with one unified `ContactCard`.
All actions (edit, notes, follow-up, outcome log) available in every context.
Smart note prefix auto-built from context + address + outcome.

**Files:**
- Modify: `workspace/dashboard/dashboard.js:307–938`

### Step 1: Delete ProspectCard, write the unified ContactCard

Replace lines 306–938 (the old `ContactCard` comment through the closing `}` of `ProspectCard`) with this single unified component.

Key behavioural rules:
- `context` prop: `'circle' | 'sold' | 'listed' | 'search'`
- Circle uses `PATCH /api/plan/${contactId}/outcome`; all others use `POST /api/log-call`
- Notes are auto-prefixed: `"{contextLabel} — {address} | {outcomeLabel}"`
- Edit + notes buttons present in all contexts
- Follow-up prompt appears for `connected`, `left_message`, `callback_requested`
- `watching` toggle only shown when `context === 'listed'` and `contact.id` exists

```jsx
// ── Context → label map ────────────────────────────────────────────────────
const CONTEXT_LABELS = {
  circle:  'Prospecting',
  sold:    'Just Sold',
  listed:  'Just Listed',
  search:  'Search',
};

// ── Unified Contact Card ───────────────────────────────────────────────────
function ContactCard({ contact, token, onLogged, context, eventAddress, autoExpand, index }) {
  const [expanded,       setExpanded]       = useState(!!autoExpand);
  const [userNote,       setUserNote]       = useState('');
  const [showNote,       setShowNote]       = useState(false);
  const [logging,        setLogging]        = useState(false);
  const [localOutcome,   setLocalOutcome]   = useState(contact.outcome || null);
  const [localCalledAt,  setLocalCalledAt]  = useState(contact.called_at || null);
  const [showFollowUp,   setShowFollowUp]   = useState(false);
  const [followUpDays,   setFollowUpDays]   = useState(1);
  const [followUpNote,   setFollowUpNote]   = useState('');
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [remDuration,    setRemDuration]    = useState(30);
  const [watching,       setWatching]       = useState(!!contact.watching);
  const [watchPending,   setWatchPending]   = useState(false);
  const [copied,         setCopied]         = useState(false);
  const [showEdit,       setShowEdit]       = useState(false);
  const [showNotes,      setShowNotes]      = useState(false);
  const [localContact,   setLocalContact]   = useState(contact);

  useEffect(() => { if (autoExpand) setExpanded(true); }, [autoExpand]);

  const contactId     = localContact.contact_id || localContact.id;
  const score         = getScore(localContact);
  const address       = localContact.address
    ? `${localContact.address}${localContact.suburb ? ', ' + localContact.suburb : ''}`
    : (localContact.suburb || '');
  const contextLabel  = CONTEXT_LABELS[context] || 'Call';
  const isCircle      = context === 'circle';

  const buildNotePrefix = useCallback((outcomeFn) => {
    const outcomeLabel = OUTCOME_LABELS[outcomeFn] || outcomeFn;
    const addr = localContact.address || '';
    return `${contextLabel}${addr ? ' \u2014 ' + addr : ''} | ${outcomeLabel}`;
  }, [contextLabel, localContact.address]);

  const logOutcome = useCallback(async (outcome) => {
    setLogging(true);
    try {
      const prefix   = buildNotePrefix(outcome);
      const fullNote = userNote.trim() ? `${prefix} \u2014 ${userNote.trim()}` : prefix;

      if (isCircle) {
        const res = await apiFetch(`/api/plan/${contactId}/outcome`, token, {
          method: 'PATCH',
          body: JSON.stringify({ outcome, notes: fullNote })
        });
        if (res.ok) {
          setLocalOutcome(outcome);
          setLocalCalledAt(new Date().toISOString());
          setShowNote(false);
          if (onLogged) onLogged();
        }
      } else {
        if (contactId) {
          await apiFetch('/api/log-call', token, {
            method: 'POST',
            body: JSON.stringify({ contact_id: contactId, outcome, notes: fullNote })
          });
        }
        setLocalOutcome(outcome);
        setLocalCalledAt(new Date().toISOString());
        if (onLogged) onLogged(contactId, outcome);
      }

      if (outcome === 'connected' || outcome === 'left_message' || outcome === 'callback_requested') {
        setShowFollowUp(true);
        setFollowUpDays(outcome === 'left_message' ? 2 : 1);
      }
    } catch (err) { console.error('log outcome failed', err); }
    finally { setLogging(false); }
  }, [contactId, token, userNote, isCircle, buildNotePrefix, onLogged]);

  const saveFollowUp = useCallback(async () => {
    setSavingFollowUp(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + followUpDays);
      d.setHours(9, 0, 0, 0);
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id:       contactId,
          contact_name:     localContact.name,
          contact_mobile:   localContact.mobile,
          note:             followUpNote || `Follow up \u2014 ${OUTCOME_LABELS[localOutcome] || localOutcome}`,
          fire_at:          d.toISOString(),
          duration_minutes: remDuration,
        })
      });
      setShowFollowUp(false);
    } catch (err) { console.error('save follow-up failed', err); }
    finally { setSavingFollowUp(false); }
  }, [contactId, localContact, token, followUpDays, followUpNote, localOutcome, remDuration]);

  const toggleWatch = useCallback(async () => {
    if (!contactId || !eventAddress) return;
    setWatchPending(true);
    try {
      const method = watching ? 'DELETE' : 'POST';
      const res = await apiFetch('/api/listing-watchers', token, {
        method, body: JSON.stringify({ contact_id: contactId, address: eventAddress })
      });
      if (res.ok) setWatching(w => !w);
    } catch (err) { console.error('toggleWatch', err); }
    finally { setWatchPending(false); }
  }, [contactId, eventAddress, watching, token]);

  const notePreFill = showNotes
    ? `${contextLabel}${localContact.address ? ' \u2014 ' + localContact.address : ''} | `
    : '';

  const isCalled = !!localCalledAt;

  return (
    <div
      className={`prospect-card${isCalled ? ' prospect-card--called' : ''}`}
      style={{ animationDelay: `${(index || 0) * 0.04}s` }}
    >
      {/* Header row */}
      <div className="prospect-card-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isCircle && score > 0 && (
            <div className="card-score-badge" style={{ flexShrink: 0 }}>
              <span className="score-number">{fmtScore(score)}</span>
            </div>
          )}
          <div>
            <div className="prospect-card-name">{localContact.name || 'Unknown'}</div>
            {localContact.address && (
              <div className="prospect-addr">{localContact.address}</div>
            )}
          </div>
        </div>
        <div className="prospect-card-right">
          {localContact.distance != null && (
            <span className="prospect-dist">{localContact.distance}m</span>
          )}
          {localContact.mobile && (
            <>
              <a className="prospect-tel" href={`tel:${localContact.mobile}`}>
                <Phone size={11} />{localContact.mobile}
              </a>
              <a className="prospect-sms" href={smsHref(localContact.mobile)} title="Send iMessage/SMS">
                <MessageSquare size={12} />
              </a>
              <button
                className="prospect-copy"
                onClick={() => { navigator.clipboard.writeText(localContact.mobile); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                title={copied ? 'Copied!' : 'Copy number'}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </>
          )}
          <button
            className="prospect-edit-btn"
            onClick={e => { e.stopPropagation(); setShowEdit(true); }}
            title="Edit contact"
          ><FileEdit size={11} /></button>
          <button
            className="prospect-notes-btn"
            onClick={e => { e.stopPropagation(); setShowNotes(true); }}
            title="Notes &amp; history"
          ><ClipboardList size={11} /></button>
          {context === 'listed' && contactId && (
            <button
              className={`watcher-toggle${watching ? ' watcher-toggle--active' : ''}`}
              onClick={e => { e.stopPropagation(); toggleWatch(); }}
              disabled={watchPending}
              title={watching ? 'Remove result watcher' : 'Mark as wants result update'}
            ><Bell size={11} /></button>
          )}
          {isCircle && (
            <button className="expand-btn" onClick={() => setExpanded(e => !e)}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      </div>

      {/* Score pills (circle only) */}
      {isCircle && (
        <ScorePills
          score={score}
          tenureYears={localContact.tenure_years || localContact.contact_tenure_years}
          occupancy={localContact.occupancy || localContact.contact_occupancy}
          propensityScore={localContact.propensity_score}
          pfEstimate={localContact.pricefinder_estimate}
          contactClass={localContact.contact_class}
        />
      )}

      {/* Intel / talking points (circle only, expandable) */}
      {isCircle && expanded && (
        <div className="card-body">
          {localContact.intel && (
            <div className="intel-section">
              <div className="intel-label">Intel</div>
              <div className="intel-bullets">{localContact.intel}</div>
            </div>
          )}
          {localContact.angle && (
            <div className="angle-box">
              <div className="angle-box-label">Talking Points</div>
              <div className="angle-box-text">{localContact.angle}</div>
            </div>
          )}
        </div>
      )}

      {/* Snoozed label */}
      {localContact.status === 'snoozed' && localContact.snooze_until && (
        <div className="prospect-snoozed">
          Retry {new Date(localContact.snooze_until).toLocaleDateString('en-AU', {
            weekday: 'short', day: 'numeric', month: 'short'
          })}
        </div>
      )}

      {/* Outcome section */}
      {isCalled ? (
        <div className="prospect-logged">
          <Check size={10} />
          {localOutcome && <span>{OUTCOME_LABELS[localOutcome] || localOutcome}</span>}
          <span className="prospect-called-time">{timeAgo(localCalledAt)}</span>
          <button className="prospect-relog" onClick={() => { setLocalOutcome(null); setLocalCalledAt(null); setShowFollowUp(false); }}>Re-log</button>
        </div>
      ) : (
        <div className="outcome-section">
          <div className="outcome-label">Log Outcome</div>
          <div className="prospect-quick-btns">
            <button className="pq-btn pq-connected"  onClick={() => logOutcome('connected')}          disabled={logging}>Connected</button>
            <button className="pq-btn pq-message"    onClick={() => logOutcome('left_message')}       disabled={logging}>Left Message</button>
            <button className="pq-btn pq-noanswer"   onClick={() => logOutcome('no_answer')}          disabled={logging}>No Answer</button>
            <button className="pq-btn pq-notint"     onClick={() => logOutcome('not_interested')}     disabled={logging}>Not Interested</button>
            <button className="pq-btn pq-callback"   onClick={() => logOutcome('callback_requested')} disabled={logging}>Callback</button>
            <button className="pq-btn pq-appraisal"  onClick={() => logOutcome('appraisal_booked')}   disabled={logging}>Appraisal</button>
          </div>
          <button
            className="icon-btn"
            style={{ marginTop: 4, fontSize: 10, padding: '3px 8px', gap: 4, display: 'flex', alignItems: 'center' }}
            onClick={() => setShowNote(n => !n)}
          >
            <MessageSquare size={10} /> {showNote ? 'Hide note' : 'Add note'}
          </button>
          {showNote && (
            <textarea
              className="outcome-note-input"
              rows={2}
              placeholder="Additional note (optional)…"
              value={userNote}
              onChange={e => setUserNote(e.target.value)}
            />
          )}
        </div>
      )}

      {/* Follow-up prompt */}
      {showFollowUp && (
        <div className="followup-prompt">
          <div className="followup-label">Follow up in:</div>
          <div className="followup-row">
            {[[1,'Tomorrow'],[2,'2 Days'],[7,'1 Week']].map(([days, label]) => (
              <button key={days}
                className={`followup-quick${followUpDays === days ? ' active' : ''}`}
                onClick={() => setFollowUpDays(days)}>{label}</button>
            ))}
          </div>
          <div className="reminder-duration-row">
            <span className="reminder-duration-label">Duration:</span>
            {DURATION_OPTIONS.map(opt => (
              <button key={opt.value}
                className={`duration-quick${remDuration === opt.value ? ' active' : ''}`}
                onClick={() => setRemDuration(opt.value)}>{opt.label}</button>
            ))}
          </div>
          <input className="followup-note-input" type="text"
            placeholder="Follow-up note (optional)…"
            value={followUpNote} onChange={e => setFollowUpNote(e.target.value)} />
          <div className="followup-actions">
            <button className="followup-skip" onClick={() => setShowFollowUp(false)}>Skip</button>
            <button className="followup-save" onClick={saveFollowUp} disabled={savingFollowUp}>
              {savingFollowUp ? 'Saving\u2026' : 'Save Follow-up'}
            </button>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {showEdit && localContact.id && (
        <EditContactModal
          contact={localContact}
          token={token}
          onSaved={updated => setLocalContact(prev => ({ ...prev, ...updated }))}
          onClose={() => setShowEdit(false)}
        />
      )}

      {/* Notes modal — pre-filled with context label */}
      {showNotes && (
        <ContactNotesModal
          contact={localContact}
          token={token}
          prefilledNote={notePreFill}
          onClose={() => setShowNotes(false)}
        />
      )}
    </div>
  );
}
```

### Step 2: Add `prefilledNote` prop to ContactNotesModal

In `ContactNotesModal` (currently `dashboard.js:597`), change the `noteText` initial state:

Old (`dashboard.js:600`):
```javascript
const [noteText, setNoteText] = useState('');
```

New:
```javascript
function ContactNotesModal({ contact, token, onClose, prefilledNote = '' }) {
  // ...
  const [noteText, setNoteText] = useState(prefilledNote);
```

(Also update the function signature on `dashboard.js:597` to accept `prefilledNote`.)

### Step 3: Update TierSection to pass context="circle"

`dashboard.js:506–515` — change `<ContactCard` to pass `context="circle"`:
```jsx
<ContactCard
  key={c.id || c.contact_id || i}
  contact={c}
  token={token}
  onLogged={onLogged}
  context="circle"
  autoExpand={activeContactId && (c.contact_id === activeContactId || c.id === activeContactId)}
  index={i}
/>
```

Also update the "Called Today" section at `dashboard.js:1167`:
```jsx
<ContactCard key={c.id || c.contact_id || i} contact={c} token={token} onLogged={handleLogged} context="circle" autoExpand={false} index={i} />
```

### Step 4: Update EventGroup to pass context to cards

`dashboard.js:1000–1008` — replace `<ProspectCard` with `<ContactCard context={alert.type === 'sold' ? 'sold' : 'listed'}`:

```jsx
{visibleContacts.map((c, i) => (
  <ContactCard
    key={c.id || c.name || i}
    contact={c}
    token={token}
    onLogged={handleLogged}
    context={alert.type === 'sold' ? 'sold' : 'listed'}
    eventAddress={alert.address}
  />
))}
```

Also update the watchers section (`dashboard.js:988–997`):
```jsx
{watchers.map((w, i) => (
  <ContactCard
    key={`watcher-${w.id || i}`}
    contact={w}
    token={token}
    onLogged={handleLogged}
    context="sold"
    eventAddress={alert.address}
  />
))}
```

### Step 5: Verify in browser

Load https://72.62.74.105:4242 and confirm:
- All three columns render contact cards without JS errors
- Outcome buttons work in Circle Prospecting column
- Outcome buttons work in Just Sold / Just Listed
- Edit (FileEdit) and Notes (ClipboardList) icons appear on cards in all columns
- Clicking Connected on a Just Sold card shows the follow-up prompt
- Notes modal pre-fills with e.g. "Just Sold — 20 Smith St | "

### Step 6: Commit

```bash
cd /root/.openclaw
git add workspace/dashboard/dashboard.js
git commit -m "feat: unify ContactCard — single component across all columns with smart note prefix"
```

---

## Task 2: Add New Contact

### Step 1: Add POST /api/contacts to snapshot-server.js

Find the `PATCH /api/contacts/:id` route (around line 1115). Add the new POST route immediately before it:

```javascript
// ── POST /api/contacts — create new contact ─────────────────────────────────
app.post('/api/contacts', auth, (req, res) => {
  const { name, mobile, address, suburb, beds, baths, property_type, do_not_call } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  db.prepare(`
    INSERT INTO contacts (id, name, mobile, address, suburb, beds, baths, property_type, do_not_call, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now','localtime'), datetime('now','localtime'))
  `).run(
    id,
    name.trim(),
    (mobile || '').trim(),
    (address || '').trim(),
    (suburb || '').trim(),
    (beds || '').toString().trim(),
    (baths || '').toString().trim(),
    (property_type || '').trim(),
    do_not_call ? 1 : 0
  );

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  res.json({ ok: true, contact });
});
```

### Step 2: Test the endpoint

```bash
source /root/.openclaw/.env 2>/dev/null; TOKEN=$(node -e "require('dotenv').config({path:'/root/.openclaw/.env'}); console.log(process.env.DASHBOARD_PASSWORD)")
curl -sk -X POST https://localhost:4242/api/contacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Contact","mobile":"0412 345 678","address":"1 Test St","suburb":"Willoughby"}'
```

Expected: `{"ok":true,"contact":{"id":"local_...","name":"Test Contact",...}}`

### Step 3: Add NewContactModal to dashboard.js

Add this component after `EditContactModal` (after line 587):

```jsx
// ── New Contact Modal ────────────────────────────────────────────────────────
function NewContactModal({ token, onCreated, onClose }) {
  const [form, setForm]   = useState({ name:'', mobile:'', address:'', suburb:'', beds:'', baths:'', property_type:'House', do_not_call: false });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const res = await apiFetch('/api/contacts', token, {
        method: 'POST',
        body: JSON.stringify({ ...form, do_not_call: form.do_not_call ? 1 : 0 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onCreated(data.contact);
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }, [form, token, onCreated, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">New Contact</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {[['Name *', 'name', 'text', ''], ['Mobile', 'mobile', 'text', '04xx xxx xxx'],
            ['Address', 'address', 'text', ''], ['Suburb', 'suburb', 'text', '']
          ].map(([label, key, type, ph]) => (
            <div className="edit-field" key={key}>
              <label className="edit-label">{label}</label>
              <input className="edit-input" type={type} value={form[key]}
                placeholder={ph} onChange={e => set(key, e.target.value)} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[['Beds', 'beds'], ['Baths', 'baths']].map(([label, key]) => (
              <div className="edit-field" key={key}>
                <label className="edit-label">{label}</label>
                <input className="edit-input" type="number" min="0" max="10"
                  value={form[key]} onChange={e => set(key, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="edit-field">
            <label className="edit-label">Property Type</label>
            <select className="edit-input" value={form.property_type} onChange={e => set('property_type', e.target.value)}>
              {['House','Unit','Townhouse','Apartment','Land'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="edit-field edit-field--inline">
            <label className="edit-label">Do Not Call</label>
            <input type="checkbox" className="edit-checkbox" checked={form.do_not_call}
              onChange={e => set('do_not_call', e.target.checked)} />
          </div>
          {error && <div className="edit-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving\u2026' : 'Add Contact'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Step 4: Add "New Contact" button to the Call Board header

In `CallsPage`, add a `showNewContact` state and a "+" button in the column area. Add this to the Circle Prospecting column header in `dashboard.js` (just after the `call-col-badge` span, around line 1119):

```jsx
<div className="call-col-header call-col-header--gold" style={{ display: 'flex', alignItems: 'center' }}>
  <span className="call-col-title">CIRCLE PROSPECTING</span>
  <span className="call-col-badge">{uncalled.length}</span>
  <button
    className="topup-btn topup-btn--sm"
    style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
    onClick={() => setShowNewContact(true)}
    title="Add new contact"
  ><Plus size={11} /> New</button>
</div>
```

Add `const [showNewContact, setShowNewContact] = useState(false);` to `CallsPage` state.

Add the modal at the bottom of the `CallsPage` return (before the closing `</>`):
```jsx
{showNewContact && (
  <NewContactModal
    token={token}
    onCreated={() => { setShowNewContact(false); loadData(); }}
    onClose={() => setShowNewContact(false)}
  />
)}
```

### Step 5: Add edit + notes to SearchCard

`SearchCard` (`dashboard.js:2007`) needs `showEdit` + `showNotes` state and buttons.

Add to SearchCard state block (after line 2018):
```javascript
const [showEdit,  setShowEdit]  = useState(false);
const [showNotes, setShowNotes] = useState(false);
```

The contact object for the modals needs to be built from the prop shape:
```javascript
const contactForModal = {
  id:         prop.crm_contact_id,
  name:       prop.crm_name || prop.owner_name || '',
  mobile:     prop.contact_mobile || '',
  address:    prop.address || '',
  suburb:     prop.suburb || '',
  do_not_call: prop.do_not_call ? 1 : 0,
};
```

Add edit + notes buttons to the `search-card-actions` div (after the Reminder button, around line 2215):
```jsx
{contactId && (
  <>
    <button className="search-action-btn" onClick={() => setShowEdit(true)} title="Edit contact">
      <FileEdit size={10} /> Edit
    </button>
    <button className="search-action-btn" onClick={() => setShowNotes(true)} title="Notes & history">
      <ClipboardList size={10} /> Notes
    </button>
  </>
)}
```

Add modals before the closing `</div>` of SearchCard (after line 2264):
```jsx
{showEdit && contactId && (
  <EditContactModal
    contact={contactForModal}
    token={token}
    onSaved={() => setShowEdit(false)}
    onClose={() => setShowEdit(false)}
  />
)}
{showNotes && contactId && (
  <ContactNotesModal
    contact={contactForModal}
    token={token}
    prefilledNote={`Search \u2014 ${prop.address || ''} | `}
    onClose={() => setShowNotes(false)}
  />
)}
```

### Step 6: Commit

```bash
cd /root/.openclaw
git add snapshot-server.js workspace/dashboard/dashboard.js
git commit -m "feat: add new contact modal and edit/notes buttons in all contexts"
```

---

## Task 3: Call Stats Header Widget

### Step 1: Add GET /api/stats/today to snapshot-server.js

Add near the other stats endpoints (after `GET /api/status`, around line 1059):

```javascript
// ── GET /api/stats/today — call counts for today ─────────────────────────────
app.get('/api/stats/today', auth, (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rows = db.prepare(`
    SELECT outcome, COUNT(*) as n
    FROM call_log
    WHERE called_at >= datetime(?, 'localtime')
    GROUP BY outcome
  `).all(todayStart.toISOString());

  const counts = { calls: 0, connected: 0, left_message: 0, no_answer: 0, not_interested: 0, callback_requested: 0, appraisal_booked: 0 };
  rows.forEach(r => {
    counts.calls += r.n;
    if (counts[r.outcome] !== undefined) counts[r.outcome] = r.n;
  });
  res.json(counts);
});
```

### Step 2: Test the endpoint

```bash
curl -sk "https://localhost:4242/api/stats/today" -H "Authorization: Bearer $TOKEN"
```

Expected: `{"calls":N,"connected":N,"left_message":N,...}`

### Step 3: Add CallStatsBar component to dashboard.js

Add after `StatusStrip` component (after line 209):

```jsx
// ── Call Stats Bar ─────────────────────────────────────────────────────────
function CallStatsBar({ token }) {
  const [stats, setStats] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/stats/today', token);
      if (res.ok) setStats(await res.json());
    } catch (_) {}
  }, [token]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  // Expose refresh so ContactCard can call it after logging
  CallStatsBar.refresh = load;

  if (!stats) return null;

  return (
    <div className="call-stats-bar">
      <span className="call-stats-item">
        <Phone size={10} style={{ color: 'var(--gold)' }} />
        <strong>{stats.calls}</strong>
        <span>Calls</span>
      </span>
      <span className="call-stats-divider" />
      <span className="call-stats-item call-stats-item--green">
        <Check size={10} />
        <strong>{stats.connected}</strong>
        <span>Connects</span>
      </span>
      <span className="call-stats-divider" />
      <span className="call-stats-item">
        <MessageSquare size={10} />
        <strong>{stats.left_message}</strong>
        <span>Messages</span>
      </span>
      <span className="call-stats-divider" />
      <span className="call-stats-item call-stats-item--muted">
        <PhoneOff size={10} />
        <strong>{stats.no_answer}</strong>
        <span>No Answer</span>
      </span>
    </div>
  );
}
```

### Step 4: Add CSS for .call-stats-bar to dashboard.css

Append to `workspace/dashboard/dashboard.css`:

```css
/* ── Call Stats Bar ─────────────────────────────────────────── */
.call-stats-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 5px 20px;
  background: var(--bg-surface);
  border-bottom: 1px solid rgba(200,169,110,0.08);
  flex-wrap: wrap;
}
.call-stats-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
}
.call-stats-item strong {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
}
.call-stats-item--green strong { color: #22c55e; }
.call-stats-item--muted { opacity: 0.65; }
.call-stats-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
}
```

### Step 5: Mount CallStatsBar in App

In the `App` return, add `<CallStatsBar token={token} />` immediately after `<MobileHeader>` and before the `page-header` div:

`dashboard.js:2750–2755`:
```jsx
<main className="main-content">
  <MobileHeader page={page} onMenuClick={() => setSidebarOpen(o => !o)} />
  <CallStatsBar token={token} />
  <div className="page-header">
    <h1 className="page-title">{pt.title}</h1>
    <span className="page-subtitle">{pt.subtitle}</span>
  </div>
  {renderPage()}
</main>
```

### Step 6: Refresh stats after every call log

In the unified `ContactCard` logOutcome function, after successfully logging, add:
```javascript
if (typeof CallStatsBar.refresh === 'function') CallStatsBar.refresh();
```

### Step 7: Verify in browser

- Stats bar should appear below the mobile header on every page
- Log a call from any column — stats bar should update within 1–2 seconds

### Step 8: Commit

```bash
cd /root/.openclaw
git add snapshot-server.js workspace/dashboard/dashboard.js workspace/dashboard/dashboard.css
git commit -m "feat: call stats header bar — live daily Calls/Connects/Messages/No-Answer count"
```

---

## Task 4: Daily Agenda Widget

### Step 1: Add fetchTodayEvents to lib/ical-calendar.js

`lib/ical-calendar.js:115` — append before `module.exports`:

```javascript
/**
 * Fetch today's calendar events from iCloud via CalDAV REPORT.
 * Returns [] if iCloud is not configured or on any error.
 * @returns {Promise<Array<{title:string, startTime:string, endTime:string, allDay:boolean}>>}
 */
async function fetchTodayEvents() {
  const appleId = process.env.ICLOUD_APPLE_ID;
  const appPass = process.env.ICLOUD_APP_PASSWORD;
  const calUrl  = process.env.ICLOUD_CALENDAR_URL;

  if (!appleId || !appPass || !calUrl) return [];

  // Build today's date range in UTC (iCloud uses UTC for time-range filter)
  const todayLocal = new Date();
  const start = new Date(todayLocal); start.setHours(0, 0, 0, 0);
  const end   = new Date(todayLocal); end.setHours(23, 59, 59, 999);

  const startStr = toIcalUtc(start);
  const endStr   = toIcalUtc(end);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag /><c:calendar-data /></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  try {
    const response = await axios({
      method: 'REPORT',
      url: calUrl,
      auth: { username: appleId, password: appPass },
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
      },
      data: body,
    });

    return parseVEvents(response.data, todayLocal);
  } catch (e) {
    console.warn('[icloud] fetchTodayEvents failed:', e.response?.status, e.message);
    return [];
  }
}

/**
 * Parse VEVENT blocks from a CalDAV REPORT XML response.
 */
function parseVEvents(xml, todayDate) {
  const events = [];
  // Extract calendar-data text blocks
  const dataMatches = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi) || [];

  for (const block of dataMatches) {
    // Strip XML tags to get raw ICS content
    const ics = block.replace(/<[^>]+>/g, '').trim();

    const summary = (ics.match(/^SUMMARY:(.+)$/m) || [])[1]?.trim();
    if (!summary) continue;

    const dtstart = (ics.match(/^DTSTART[^:]*:(.+)$/m) || [])[1]?.trim();
    const dtend   = (ics.match(/^DTEND[^:]*:(.+)$/m)   || [])[1]?.trim();

    const allDay = dtstart && !dtstart.includes('T');

    let startTime = null, endTime = null;
    if (dtstart && !allDay) {
      // Format: 20260227T090000Z or 20260227T090000 (local)
      const d = parseIcalDate(dtstart);
      startTime = d ? d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' }) : null;
    }
    if (dtend && !allDay) {
      const d = parseIcalDate(dtend);
      endTime = d ? d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' }) : null;
    }

    events.push({ title: summary, startTime, endTime, allDay });
  }

  // Sort timed events before all-day
  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return 1;
    if (!a.allDay && b.allDay) return -1;
    return (a.startTime || '').localeCompare(b.startTime || '');
  });

  return events;
}

function parseIcalDate(str) {
  if (!str) return null;
  // Handles: 20260227T090000Z  20260227T090000  20260227T090000+1100
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mm, ss, utc] = m;
  if (utc) return new Date(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`);
  // Treat as Sydney local time
  return new Date(new Date(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}`).toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
}
```

Change `module.exports` line at the bottom:
```javascript
module.exports = { createCalendarEvent, fetchTodayEvents };
```

### Step 2: Add GET /api/agenda/today to snapshot-server.js

Add the require at the top where ical-calendar is imported:
```javascript
const { createCalendarEvent, fetchTodayEvents } = require('./lib/ical-calendar');
```

(If currently `const { createCalendarEvent } = require('./lib/ical-calendar')`, change to the above.)

Then add the endpoint (near other GET endpoints, around line 1080):

```javascript
// ── GET /api/agenda/today ─────────────────────────────────────────────────
app.get('/api/agenda/today', auth, async (req, res) => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const reminders = db.prepare(`
    SELECT id, contact_name, contact_mobile, note, fire_at
    FROM reminders
    WHERE sent = 0 AND fire_at >= ? AND fire_at <= ?
    ORDER BY fire_at ASC
  `).all(todayStart.toISOString(), todayEnd.toISOString());

  const planCount = db.prepare(`
    SELECT COUNT(*) as n FROM daily_plans WHERE date(created_at) = date('now','localtime')
  `).get().n;

  const calEvents = await fetchTodayEvents();

  res.json({ events: calEvents, reminders, planCount });
});
```

### Step 3: Test the endpoint

```bash
curl -sk "https://localhost:4242/api/agenda/today" -H "Authorization: Bearer $TOKEN" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log('events:', j.events.length, 'reminders:', j.reminders.length, 'plan:', j.planCount)"
```

Expected: `events: N  reminders: N  plan: N` (numbers, no crash)

### Step 4: Add AgendaWidget component to dashboard.js

Add after `StatusStrip` component (or after `CallStatsBar`):

```jsx
// ── Agenda Widget ─────────────────────────────────────────────────────────
function AgendaWidget({ token }) {
  const [agenda,    setAgenda]    = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [checked,   setChecked]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('jarvis_agenda_checked') || '{}'); }
    catch { return {}; }
  });
  const [manualItems, setManualItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('jarvis_agenda_manual') || '[]'); }
    catch { return []; }
  });
  const [newItem, setNewItem] = useState('');

  useEffect(() => {
    apiFetch('/api/agenda/today', token)
      .then(r => r.ok ? r.json() : null)
      .then(d => setAgenda(d))
      .catch(() => {});
  }, [token]);

  const toggleCheck = (key) => {
    setChecked(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('jarvis_agenda_checked', JSON.stringify(next));
      return next;
    });
  };

  const addManual = () => {
    if (!newItem.trim()) return;
    const items = [...manualItems, { id: Date.now(), text: newItem.trim() }];
    setManualItems(items);
    localStorage.setItem('jarvis_agenda_manual', JSON.stringify(items));
    setNewItem('');
  };

  const removeManual = (id) => {
    const items = manualItems.filter(i => i.id !== id);
    setManualItems(items);
    localStorage.setItem('jarvis_agenda_manual', JSON.stringify(items));
  };

  // Build unified item list: reminders first, then calendar events, then call plan, then manual
  const items = [];
  if (agenda) {
    agenda.reminders.forEach((r, i) => items.push({
      key: `rem_${r.id}`, type: 'reminder',
      label: r.contact_name,
      detail: r.note,
      time: r.fire_at ? fmtTime(r.fire_at) : null,
    }));
    agenda.events.forEach((e, i) => items.push({
      key: `ev_${i}`, type: 'event',
      label: e.title,
      detail: e.allDay ? 'All day' : null,
      time: e.startTime || null,
    }));
    if (agenda.planCount > 0) items.push({
      key: 'plan', type: 'plan',
      label: `${agenda.planCount} contacts in today's call plan`,
      detail: null, time: null,
    });
  }
  manualItems.forEach(m => items.push({ key: `manual_${m.id}`, type: 'manual', label: m.text, detail: null, time: null, manualId: m.id }));

  const typeIcon = { reminder: <Bell size={10} />, event: <Calendar size={10} />, plan: <Phone size={10} />, manual: <Check size={10} /> };
  const typeColor = { reminder: 'var(--gold)', event: '#3b82f6', plan: '#22c55e', manual: 'var(--text-muted)' };

  const nextItem = items.find(i => !checked[i.key]);

  return (
    <div className="agenda-widget">
      <div className="agenda-header" onClick={() => setCollapsed(c => !c)}>
        <Calendar size={11} style={{ color: 'var(--gold)' }} />
        <span className="agenda-title">Today's Agenda</span>
        {collapsed && nextItem && (
          <span className="agenda-next">{nextItem.time && `${nextItem.time} · `}{nextItem.label}</span>
        )}
        <span className="agenda-chevron">{collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</span>
      </div>
      {!collapsed && (
        <div className="agenda-body">
          {items.length === 0 && !agenda && <div className="agenda-empty">Loading…</div>}
          {items.length === 0 && agenda && <div className="agenda-empty">No agenda items today</div>}
          {items.map(item => (
            <div key={item.key} className={`agenda-item${checked[item.key] ? ' agenda-item--done' : ''}`}>
              <button className="agenda-check" onClick={() => toggleCheck(item.key)}>
                {checked[item.key] ? <Check size={11} style={{ color: '#22c55e' }} /> : <div className="agenda-check-circle" />}
              </button>
              <span className="agenda-item-icon" style={{ color: typeColor[item.type] }}>{typeIcon[item.type]}</span>
              <div className="agenda-item-body">
                <span className="agenda-item-label">{item.label}</span>
                {item.detail && <span className="agenda-item-detail">{item.detail}</span>}
              </div>
              {item.time && <span className="agenda-item-time">{item.time}</span>}
              {item.type === 'manual' && (
                <button className="agenda-remove" onClick={() => removeManual(item.manualId)}><X size={9} /></button>
              )}
            </div>
          ))}
          <div className="agenda-add-row">
            <input
              className="agenda-add-input"
              type="text"
              placeholder="Add task…"
              value={newItem}
              onChange={e => setNewItem(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addManual()}
            />
            <button className="agenda-add-btn" onClick={addManual}><Plus size={11} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### Step 5: Add CSS for agenda widget to dashboard.css

```css
/* ── Agenda Widget ──────────────────────────────────────────── */
.agenda-widget {
  margin: 0 20px 12px;
  background: var(--bg-surface);
  border: 1px solid rgba(200,169,110,0.12);
  border-radius: 6px;
  overflow: hidden;
}
.agenda-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid rgba(200,169,110,0.06);
}
.agenda-title {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gold);
}
.agenda-next {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.agenda-chevron { margin-left: auto; color: var(--text-muted); }
.agenda-body { padding: 4px 0 6px; }
.agenda-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  transition: opacity 0.2s;
}
.agenda-item--done { opacity: 0.38; }
.agenda-check {
  background: none;
  border: none;
  cursor: pointer;
  padding: 1px;
  display: flex;
  align-items: center;
  color: var(--text-muted);
  flex-shrink: 0;
}
.agenda-check-circle {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
}
.agenda-item-icon { flex-shrink: 0; }
.agenda-item-body { flex: 1; min-width: 0; }
.agenda-item-label {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
.agenda-item-detail {
  font-size: 10px;
  color: var(--text-muted);
  display: block;
}
.agenda-item-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.agenda-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 1px;
  opacity: 0.5;
  flex-shrink: 0;
}
.agenda-remove:hover { opacity: 1; }
.agenda-add-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 2px;
}
.agenda-add-input {
  flex: 1;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-primary);
  font-family: var(--font-sans);
}
.agenda-add-input::placeholder { color: var(--text-muted); }
.agenda-add-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 7px;
  cursor: pointer;
  color: var(--text-muted);
  display: flex;
  align-items: center;
}
.agenda-empty {
  padding: 10px 12px;
  font-size: 11px;
  color: var(--text-muted);
}
```

### Step 6: Mount AgendaWidget in CallsPage

In `CallsPage` return (`dashboard.js:1248–1250`), add `<AgendaWidget>` before `<StatusStrip>`:

```jsx
return (
  <>
    <AgendaWidget token={token} />
    <StatusStrip status={status} planCount={plan.length} calledCount={called.length} />
    {/* ... rest unchanged */}
  </>
);
```

### Step 7: Restart server

```bash
pm2 restart jarvis-snapshot --update-env
```

### Step 8: Verify in browser

- Agenda widget appears at top of Calls page, collapsed by default shows next item
- Expanding shows reminders + calendar events (if iCloud configured) + call plan count
- Ticking an item crosses it out; adding a manual item persists on refresh
- Console shows no errors for `/api/agenda/today`

### Step 9: Commit

```bash
cd /root/.openclaw
git add lib/ical-calendar.js snapshot-server.js workspace/dashboard/dashboard.js workspace/dashboard/dashboard.css
git commit -m "feat: daily agenda widget — iCloud calendar + reminders + call plan, with manual tasks"
```

---

## Summary of New Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/contacts` | ✓ | Create new contact |
| GET | `/api/stats/today` | ✓ | Today's call counts by outcome |
| GET | `/api/agenda/today` | ✓ | iCloud events + reminders + plan count |

## Summary of Changed Files

| File | Changes |
|------|---------|
| `workspace/dashboard/dashboard.js` | Unified ContactCard, NewContactModal, CallStatsBar, AgendaWidget, SearchCard edit/notes |
| `workspace/dashboard/dashboard.css` | CSS for CallStatsBar + AgendaWidget |
| `snapshot-server.js` | 3 new endpoints, updated ical-calendar import |
| `lib/ical-calendar.js` | fetchTodayEvents + helpers |
