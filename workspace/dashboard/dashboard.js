// JARVIS Intelligence Terminal — Dashboard SPA
// React 18 + Babel Standalone (no build step)
// All icons via lucide global, all styles via dashboard.css

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Lucide icon destructuring (lucide-react UMD → window.LucideReact) ─────
const {
  Phone, ChevronDown, ChevronUp, Bell, TrendingUp, Users, Clock,
  MapPin, Calendar, Check, X, AlertCircle, Home, Activity,
  MessageSquare, PhoneCall, PhoneOff, PhoneMissed, Star, RefreshCw,
  History, Menu, Building2, CheckCircle
} = LucideReact;

// ── Constants ──────────────────────────────────────────────────────────────
const OUTCOME_LABELS = {
  connected:          'Connected',
  left_message:       'Left Message',
  no_answer:          'No Answer',
  not_interested:     'Not Interested',
  callback_requested: 'Callback',
  appraisal_booked:   'Appraisal Booked',
};

function getScore(d) { return d.propensity_score || d.contact_score || 0; }

// ── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function fmtScore(s) {
  return String(s || 0).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

function computePills(dp) {
  const tenureYears = dp.tenure_years || dp.contact_tenure_years || 0;
  const occupancy = dp.occupancy || dp.contact_occupancy || '';
  const propensity = getScore(dp);
  const tenureSignal = tenureYears > 7 ? 20 : 0;
  const investorSignal = /rent/i.test(occupancy) ? 15 : 0;
  const appraisalSignal = (propensity - tenureSignal - investorSignal) >= 30 ? 30 : 0;
  return { tenureSignal, investorSignal, appraisalSignal, tenureYears, occupancy };
}

// ── API Fetch ──────────────────────────────────────────────────────────────
async function apiFetch(path, token, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  return res;
}

// ── Score Pills ────────────────────────────────────────────────────────────
function ScorePills({ score, tenureYears, occupancy, propensityScore, pfEstimate, contactClass }) {
  const dp = {
    tenure_years: tenureYears,
    occupancy,
    propensity_score: propensityScore || score,
    contact_score: score
  };
  const { tenureSignal, investorSignal, appraisalSignal } = computePills(dp);
  const isPastVendor = contactClass && contactClass.includes('Past Vendor');
  const isProspVendor = contactClass && contactClass.includes('Prospective Vendor') && !isPastVendor;

  return (
    <div className="score-pills">
      {tenureSignal > 0 && (
        <span className="pill pill-tenure">Tenure {tenureYears}+ yrs</span>
      )}
      {investorSignal > 0 && (
        <span className="pill pill-investor">Investor</span>
      )}
      {appraisalSignal > 0 && (
        <span className="pill pill-appraisal">Appraisal</span>
      )}
      {isPastVendor && (
        <span className="pill pill-appraisal" style={{ borderColor: 'rgba(200,169,110,0.35)', color: 'var(--gold)', background: 'rgba(200,169,110,0.1)' }}>Past Vendor</span>
      )}
      {isProspVendor && (
        <span className="pill pill-source">Prosp. Vendor</span>
      )}
      {pfEstimate && (
        <span className="pill" style={{ background: 'rgba(200,169,110,0.08)', border: '1px solid rgba(200,169,110,0.25)', color: 'var(--gold-bright)', fontWeight: 500 }}>{pfEstimate}</span>
      )}
    </div>
  );
}

// ── Login Page ─────────────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/plan/today', password);
      if (res.ok) {
        onLogin(password);
      } else {
        setError('Incorrect password');
      }
    } catch (err) {
      setError('Connection error — check network');
    } finally {
      setLoading(false);
    }
  }, [password, onLogin]);

  return (
    <div className="login-page">
      <form className="login-box" onSubmit={handleSubmit}>
        <div className="login-brand">JARVIS</div>
        <div className="login-tagline">McGrath Willoughby — Intelligence Terminal</div>
        <input
          className="login-input"
          type="password"
          placeholder="Access code"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus
          disabled={loading}
        />
        <button className="login-btn" type="submit" disabled={loading}>
          {loading ? 'Authenticating...' : 'Access System'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}

// ── Status Strip ───────────────────────────────────────────────────────────
function StatusStrip({ status, planCount, calledCount }) {
  const remaining = Math.max(0, planCount - calledCount);
  const pct = planCount > 0 ? Math.round((calledCount / planCount) * 100) : 0;

  return (
    <div className="status-strip">
      <div className="stat-chip">
        <span className="stat-value">{planCount}<span style={{ fontSize: 13, opacity: 0.5 }}>/80</span></span>
        <span className="stat-label">Planned</span>
      </div>
      <div className="stat-divider" />
      <div className="stat-chip">
        <span className="stat-value">{calledCount}</span>
        <span className="stat-label">Called</span>
      </div>
      <div className="stat-divider" />
      <div className="stat-chip">
        <span className="stat-value">{remaining}</span>
        <span className="stat-label">Remaining</span>
      </div>
      <div className="stat-divider" />
      <div className="stat-chip">
        <span className="stat-value" style={{ fontSize: 13 }}>{status ? timeAgo(status.lastRun) : '—'}</span>
        <span className="stat-label">Last Run</span>
      </div>
      <div className="progress-bar-wrap">
        <div className="progress-label">{pct}% complete</div>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: pct + '%' }} />
        </div>
      </div>
    </div>
  );
}

// ── Alert Banner ───────────────────────────────────────────────────────────
function AlertBanner({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  const last5 = alerts.slice(0, 5);

  return (
    <div className="alert-banner">
      <Activity size={13} style={{ color: 'var(--tier-med)', flexShrink: 0 }} />
      {last5.map((a, i) => (
        <div className="alert-pill" key={i}>
          <span className="alert-pill-type">{a.event_type || a.type || 'alert'}</span>
          <span className="alert-pill-addr">{a.address || a.suburb || ''}</span>
          {(a.price || a.listing_price) && (
            <span className="alert-pill-price">{a.price || a.listing_price}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Reminder Modal ─────────────────────────────────────────────────────────
function ReminderModal({ contact, token, onClose }) {
  const [note, setNote] = useState('');
  const [fireAt, setFireAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Default fire_at to tomorrow 9am
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
    setFireAt(local);
  }, []);

  const handleSave = async () => {
    if (!fireAt) return;
    setSaving(true);
    setSaveError('');
    try {
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id: contact.contact_id || contact.id,
          contact_name: contact.name,
          contact_mobile: contact.mobile,
          note,
          fire_at: new Date(fireAt).toISOString()
        })
      });
      onClose();
    } catch (err) {
      console.error('Reminder save failed', err);
      setSaveError('Failed to save — check connection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-title">Set Reminder — {contact.name}</div>
        <label className="form-label">Reminder Date & Time</label>
        <input
          className="form-input"
          type="datetime-local"
          value={fireAt}
          onChange={e => setFireAt(e.target.value)}
        />
        <label className="form-label">Note</label>
        <input
          className="form-input"
          type="text"
          placeholder="Optional note..."
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        {saveError && (
          <div style={{ color: '#F87171', fontSize: 11, fontFamily: 'var(--font-mono)', marginTop: 8 }}>{saveError}</div>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Set Reminder'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Contact Card ───────────────────────────────────────────────────────────
function ContactCard({ contact: dp, token, onLogged, autoExpand, index }) {
  const [expanded, setExpanded] = useState(!!autoExpand);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [logging, setLogging] = useState(false);
  const [localOutcome, setLocalOutcome] = useState(dp.outcome || null);
  const [localCalledAt, setLocalCalledAt] = useState(dp.called_at || null);
  const [showReminder, setShowReminder] = useState(false);

  // Auto-expand when autoExpand prop changes
  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  const isCalled = !!(localCalledAt);
  const score = getScore(dp);
  const address = dp.address ? `${dp.address}${dp.suburb ? ', ' + dp.suburb : ''}` : (dp.suburb || '');
  const contactId = dp.contact_id || dp.id;

  const logOutcome = useCallback(async (outcome) => {
    setLogging(true);
    try {
      const res = await apiFetch(`/api/plan/${contactId}/outcome`, token, {
        method: 'PATCH',
        body: JSON.stringify({ outcome, notes: note })
      });
      if (res.ok) {
        setLocalOutcome(outcome);
        setLocalCalledAt(new Date().toISOString());
        setShowNote(false);
        if (onLogged) onLogged();
      }
    } catch (err) {
      console.error('Log outcome failed', err);
    } finally {
      setLogging(false);
    }
  }, [contactId, token, note, onLogged]);

  return (
    <div
        className={`contact-card${isCalled ? ' called' : ''}`}
        style={{ animationDelay: `${(index || 0) * 0.04}s` }}
      >
        {/* Header */}
        <div className="card-header">
          <div className="card-score-badge">
            <span className="score-number">{fmtScore(score)}</span>
            <span className="score-label">score</span>
          </div>
          <div className="card-meta">
            <div className="card-name">{dp.name || 'Unknown'}</div>
            <div className="card-address">{address}</div>
          </div>
          <div className="card-actions-header">
            {dp.mobile && (
              <a className="call-btn" href={`tel:${dp.mobile}`}>
                <Phone size={12} />
                {dp.mobile}
              </a>
            )}
            <button className="expand-btn" onClick={() => setShowReminder(true)} title="Set Reminder">
              <Bell size={14} />
            </button>
            <button className="expand-btn" onClick={() => setExpanded(e => !e)}>
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {/* Score Pills */}
        <ScorePills
          score={score}
          tenureYears={dp.tenure_years || dp.contact_tenure_years}
          occupancy={dp.occupancy || dp.contact_occupancy}
          propensityScore={dp.propensity_score}
          pfEstimate={dp.pricefinder_estimate}
          contactClass={dp.contact_class}
        />

        {/* Expandable Body */}
        {expanded && (
          <div className="card-body">
            {dp.intel && (
              <div className="intel-section">
                <div className="intel-label">Intel</div>
                <div className="intel-bullets">{dp.intel}</div>
              </div>
            )}
            {dp.angle && (
              <div className="angle-box">
                <div className="angle-box-label">Talking Points</div>
                <div className="angle-box-text">{dp.angle}</div>
              </div>
            )}
          </div>
        )}

        {/* Outcome Section */}
        <div className="outcome-section">
          {isCalled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="called-badge">
                <Check size={10} />
                Called {timeAgo(localCalledAt)}
              </div>
              {localOutcome && (
                <span className={`outcome-chip chip-${localOutcome.replace(/\s/g, '_')}`}>
                  {OUTCOME_LABELS[localOutcome] || localOutcome}
                </span>
              )}
              <button
                className="icon-btn"
                style={{ marginLeft: 'auto', fontSize: 10, padding: '3px 8px', gap: 4, display: 'flex', alignItems: 'center' }}
                onClick={() => { setLocalCalledAt(null); setLocalOutcome(null); setExpanded(true); }}
                title="Re-log"
              >
                <RefreshCw size={10} /> Re-log
              </button>
            </div>
          ) : (
            <>
              <div className="outcome-label">Log Outcome</div>
              <div className="quick-log-grid">
                <button className="quick-btn connected" onClick={() => logOutcome('connected')} disabled={logging}>Connected</button>
                <button className="quick-btn message" onClick={() => { setShowNote(true); logOutcome('left_message'); }} disabled={logging}>Left Message</button>
                <button className="quick-btn noanswer" onClick={() => logOutcome('no_answer')} disabled={logging}>No Answer</button>
                <button className="quick-btn notint" onClick={() => logOutcome('not_interested')} disabled={logging}>Not Interested</button>
                <button className="quick-btn callback" onClick={() => logOutcome('callback_requested')} disabled={logging}>Callback</button>
                <button className="quick-btn appraisal" onClick={() => logOutcome('appraisal_booked')} disabled={logging}>
                  Appraisal Booked
                </button>
              </div>
              {showNote && (
                <textarea
                  className="outcome-note-input"
                  rows={2}
                  placeholder="Add a note (optional)..."
                  value={note}
                  onChange={e => setNote(e.target.value)}
                />
              )}
              <button
                className="icon-btn"
                style={{ marginTop: 4, fontSize: 10, padding: '3px 8px', gap: 4, display: 'flex', alignItems: 'center' }}
                onClick={() => setShowNote(n => !n)}
              >
                <MessageSquare size={10} /> {showNote ? 'Hide note' : 'Add note'}
              </button>
            </>
          )}
        </div>

      {showReminder && (
        <ReminderModal contact={dp} token={token} onClose={() => setShowReminder(false)} />
      )}
    </div>
  );
}

// ── Tier Section ───────────────────────────────────────────────────────────
function TierSection({ tier, contacts, token, onLogged, activeContactId, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen !== undefined ? defaultOpen : (tier === 'low' ? false : true));

  const tierConfig = {
    high: { label: 'Prime Targets', className: 'tier-high' },
    med: { label: 'Warm Leads', className: 'tier-med' },
    low: { label: 'Cold Calls', className: 'tier-low' }
  };
  const cfg = tierConfig[tier];

  if (!contacts || contacts.length === 0) return null;

  return (
    <div className="tier-section">
      <div className={`tier-header ${cfg.className}`} onClick={() => setOpen(o => !o)}>
        <div className="tier-dot" />
        <span className="tier-label">{cfg.label}</span>
        <span className="tier-count">({contacts.length})</span>
        <span className={`tier-chevron${open ? ' open' : ''}`}>
          <ChevronDown size={14} />
        </span>
      </div>
      {open && (
        <div className="tier-cards">
          {contacts.map((c, i) => (
            <ContactCard
              key={c.id || c.contact_id || i}
              contact={c}
              token={token}
              onLogged={onLogged}
              autoExpand={activeContactId && (c.contact_id === activeContactId || c.id === activeContactId)}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Calls Page ─────────────────────────────────────────────────────────────
function CallsPage({ token }) {
  const [plan, setPlan] = useState([]);
  const planRef = useRef([]);
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeContactId, setActiveContactId] = useState(null);
  const [calledOpen, setCalledOpen] = useState(false);

  // Keep ref in sync so handleLogged always reads current plan without stale closure
  useEffect(() => { planRef.current = plan; }, [plan]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [planRes, alertsRes, statusRes] = await Promise.all([
        apiFetch('/api/plan/today', token),
        fetch('/api/alerts'),
        fetch('/api/status')
      ]);
      if (planRes.ok) {
        const data = await planRes.json();
        setPlan(data);
        // Set first uncalled as active
        const firstUncalled = data.find(d => !d.called_at);
        if (firstUncalled) {
          setActiveContactId(firstUncalled.contact_id || firstUncalled.id);
        }
      }
      if (alertsRes.ok) setAlerts(await alertsRes.json());
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (err) {
      console.error('Load failed', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleLogged = useCallback(() => {
    // Read current plan from ref to avoid stale closure
    const currentPlan = planRef.current;
    const uncalled = currentPlan.filter(d => !d.called_at);
    const currentIdx = uncalled.findIndex(d => (d.contact_id || d.id) === activeContactId);
    const nextUncalled = uncalled.filter((_, i) => i !== currentIdx);
    // Mark current as called
    setPlan(prev => prev.map(d =>
      (d.contact_id || d.id) === activeContactId
        ? { ...d, called_at: new Date().toISOString() }
        : d
    ));
    // Advance to next uncalled
    if (nextUncalled.length > 0) {
      const next = nextUncalled[Math.min(currentIdx, nextUncalled.length - 1)];
      setActiveContactId(next.contact_id || next.id);
    } else {
      setActiveContactId(null);
    }
  }, [activeContactId]);

  const uncalled = plan.filter(d => !d.called_at);
  const called = plan.filter(d => !!d.called_at);
  const high = uncalled.filter(d => getScore(d) >= 45);
  const med  = uncalled.filter(d => { const s = getScore(d); return s >= 20 && s < 45; });
  const low  = uncalled.filter(d => getScore(d) < 20);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em' }}>Loading intelligence...</span>
      </div>
    );
  }

  return (
    <>
      <StatusStrip status={status} planCount={plan.length} calledCount={called.length} />
      <AlertBanner alerts={alerts} />
      <div className="page-body">
        <TierSection tier="high" contacts={high} token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={true} />
        <TierSection tier="med" contacts={med} token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={true} />
        <TierSection tier="low" contacts={low} token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={false} />

        {/* Called Today Section */}
        {called.length > 0 && (
          <div className="tier-section">
            <div className="tier-header tier-low" onClick={() => setCalledOpen(o => !o)}>
              <CheckCircle size={8} style={{ color: 'var(--tier-high)', flexShrink: 0 }} />
              <span className="tier-label" style={{ color: 'var(--text-muted)' }}>Called Today</span>
              <span className="tier-count">({called.length})</span>
              <span className={`tier-chevron${calledOpen ? ' open' : ''}`}>
                <ChevronDown size={14} />
              </span>
            </div>
            {calledOpen && (
              <div className="tier-cards">
                {called.map((c, i) => (
                  <ContactCard
                    key={c.id || c.contact_id || i}
                    contact={c}
                    token={token}
                    onLogged={handleLogged}
                    autoExpand={false}
                    index={i}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {plan.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon"><Calendar size={32} /></div>
            <div className="empty-state-title">No contacts planned today</div>
            <div className="empty-state-sub">Run daily-planner.js to generate today's list</div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Market Page ────────────────────────────────────────────────────────────
function MarketPage({ token }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/market?days=14', token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setEvents(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const typeClass = {
    listing: 'type-listing',
    sold: 'type-sold',
    rental: 'type-rental',
    price_change: 'type-price_change'
  };

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  return (
    <div className="page-body">
      {events.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><TrendingUp size={32} /></div>
          <div className="empty-state-title">No market events</div>
          <div className="empty-state-sub">Check back after the next pipeline run</div>
        </div>
      ) : (
        <div className="event-list">
          {events.map((ev, i) => (
            <div className="event-card" key={ev.id || i} style={{ animationDelay: `${i * 0.03}s` }}>
              <span className={`event-type-badge ${typeClass[ev.event_type] || typeClass[ev.type] || 'type-listing'}`}>
                {ev.event_type || ev.type || 'event'}
              </span>
              <div className="event-body">
                <div className="event-addr">{ev.address || '—'}</div>
                <div className="event-detail">
                  {[ev.suburb, ev.beds && `${ev.beds}bd`, ev.baths && `${ev.baths}ba`, ev.price || ev.listing_price]
                    .filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="event-meta">{timeAgo(ev.created_at || ev.event_date)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Buyers Page ────────────────────────────────────────────────────────────
function BuyersPage({ token }) {
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [outcomeTarget, setOutcomeTarget] = useState(null); // buyer id

  useEffect(() => {
    apiFetch('/api/buyers/calllist', token)
      .then(r => r.ok ? r.json() : {})
      .then(data => { setGrouped(data || {}); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const logBuyerOutcome = async (buyerId, outcome) => {
    try {
      await apiFetch(`/api/buyers/${buyerId}/outcome`, token, {
        method: 'PATCH',
        body: JSON.stringify({ outcome, notes: '' })
      });
      setOutcomeTarget(null);
      // Refresh
      const res = await apiFetch('/api/buyers/calllist', token);
      if (res.ok) setGrouped(await res.json());
    } catch (err) { console.error(err); }
  };

  const markDone = async (buyerId, address) => {
    try {
      await apiFetch(`/api/buyers/${buyerId}/done`, token, { method: 'PATCH' });
      setGrouped(prev => {
        const updated = { ...prev };
        if (updated[address]) {
          updated[address] = updated[address].filter(b => b.id !== buyerId);
          if (updated[address].length === 0) delete updated[address];
        }
        return updated;
      });
    } catch (err) { console.error(err); }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  const addresses = Object.keys(grouped);

  return (
    <div className="page-body">
      {addresses.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Users size={32} /></div>
          <div className="empty-state-title">No active buyer enquiries</div>
          <div className="empty-state-sub">Buyers will appear when enquiries are logged</div>
        </div>
      ) : (
        addresses.map(addr => (
          <div className="listing-group" key={addr}>
            <div className="listing-group-header">
              <MapPin size={13} style={{ color: 'var(--gold)', flexShrink: 0 }} />
              <span className="listing-group-addr">{addr}</span>
              <span className="listing-group-count">{grouped[addr].length} buyer{grouped[addr].length !== 1 ? 's' : ''}</span>
            </div>
            {grouped[addr].map(buyer => (
              <div className="buyer-row" key={buyer.id}>
                <div className="buyer-name">{buyer.name || buyer.buyer_name || 'Unknown'}</div>
                {buyer.mobile && (
                  <a className="buyer-mobile" href={`tel:${buyer.mobile}`}>
                    <Phone size={11} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                    {buyer.mobile}
                  </a>
                )}
                {buyer.enquiry_type && (
                  <span className="buyer-type-badge">{buyer.enquiry_type}</span>
                )}
                {outcomeTarget === buyer.id ? (
                  <div className="buyer-actions">
                    {['interested', 'not_interested', 'no_answer', 'left_message', 'appointment_booked'].map(o => (
                      <button
                        key={o}
                        className="icon-btn"
                        style={{ fontSize: 9, padding: '2px 6px' }}
                        onClick={() => logBuyerOutcome(buyer.id, o)}
                      >
                        {o.replace(/_/g, ' ')}
                      </button>
                    ))}
                    <button className="icon-btn danger" onClick={() => setOutcomeTarget(null)}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="buyer-actions">
                    <button className="icon-btn" title="Log outcome" onClick={() => setOutcomeTarget(buyer.id)}>
                      <PhoneCall size={13} />
                    </button>
                    <button className="icon-btn danger" title="Mark done" onClick={() => markDone(buyer.id, addr)}>
                      <Check size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ── Reminders Page ─────────────────────────────────────────────────────────
function RemindersPage({ token }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/reminders/upcoming', token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setReminders(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  return (
    <div className="page-body">
      {reminders.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Bell size={32} /></div>
          <div className="empty-state-title">No upcoming reminders</div>
          <div className="empty-state-sub">Set reminders from contact cards on the Calls page</div>
        </div>
      ) : (
        <div className="event-list">
          {reminders.map((r, i) => (
            <div className="event-card" key={r.id || i} style={{ animationDelay: `${i * 0.03}s` }}>
              <div style={{ flexShrink: 0 }}>
                <Bell size={16} style={{ color: 'var(--gold)', marginTop: 2 }} />
              </div>
              <div className="event-body">
                <div className="event-addr">{r.contact_name || '—'}</div>
                <div className="event-detail">{r.note || 'No note'}</div>
                {r.contact_mobile && (
                  <div className="event-detail" style={{ marginTop: 2 }}>
                    <a href={`tel:${r.contact_mobile}`} style={{ color: 'var(--text-secondary)' }}>
                      {r.contact_mobile}
                    </a>
                  </div>
                )}
              </div>
              <div className="event-meta">
                <div>{fmtDate(r.fire_at)}</div>
                <div style={{ marginTop: 2 }}>{fmtTime(r.fire_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── History Page ───────────────────────────────────────────────────────────
function HistoryPage({ token }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/history', token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setHistory(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  return (
    <div className="page-body">
      {history.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><History size={32} /></div>
          <div className="empty-state-title">No calls logged today</div>
          <div className="empty-state-sub">Completed calls will appear here</div>
        </div>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Score</th>
              <th>Outcome</th>
              <th>Called</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={h.id || h.contact_id || i}>
                <td style={{ fontWeight: 600 }}>{h.name || '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  {h.address ? `${h.address}${h.suburb ? ', ' + h.suburb : ''}` : h.suburb || '—'}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--gold)' }}>
                  {fmtScore(getScore(h))}
                </td>
                <td>
                  {h.outcome ? (
                    <span className={`outcome-chip chip-${h.outcome}`}>
                      {OUTCOME_LABELS[h.outcome] || h.outcome}
                    </span>
                  ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  {timeAgo(h.called_at)}
                </td>
                <td style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.notes || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ page, onNav, remainingCount, mobileOpen }) {
  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const navItems = [
    { id: 'calls', label: 'Calls', Icon: Phone, badge: remainingCount > 0 ? remainingCount : null },
    { id: 'market', label: 'Market', Icon: TrendingUp },
    { id: 'buyers', label: 'Buyers', Icon: Users },
    { id: 'reminders', label: 'Reminders', Icon: Bell },
    { id: 'history', label: 'History', Icon: History }
  ];

  return (
    <aside className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-wordmark">JARVIS</div>
        <div className="brand-subtitle">McGrath Willoughby</div>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-section-label">Intelligence</div>
        {navItems.map(({ id, label, Icon, badge }) => (
          <div
            key={id}
            className={`nav-item${page === id ? ' active' : ''}`}
            onClick={() => onNav(id)}
          >
            <span className="nav-icon"><Icon size={15} /></span>
            {label}
            {badge != null && <span className="nav-badge">{badge}</span>}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-date">{today}</div>
      </div>
    </aside>
  );
}

// ── Mobile Header ──────────────────────────────────────────────────────────
function MobileHeader({ page, onMenuClick }) {
  const labels = {
    calls: 'Calls',
    market: 'Market',
    buyers: 'Buyers',
    reminders: 'Reminders',
    history: 'History'
  };
  return (
    <div className="mobile-header">
      <span className="mobile-brand">JARVIS</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
        {labels[page] || page}
      </span>
      <button
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}
        onClick={onMenuClick}
      >
        <Menu size={18} />
      </button>
    </div>
  );
}

// ── Bottom Tab Bar ─────────────────────────────────────────────────────────
function BottomTabBar({ page, onNav }) {
  const tabs = [
    { id: 'calls', label: 'Calls', Icon: Phone },
    { id: 'market', label: 'Market', Icon: TrendingUp },
    { id: 'buyers', label: 'Buyers', Icon: Users },
    { id: 'reminders', label: 'Remind', Icon: Bell },
    { id: 'history', label: 'History', Icon: History }
  ];

  return (
    <nav className="bottom-tab-bar">
      <div className="bottom-tabs">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`bottom-tab${page === id ? ' active' : ''}`}
            onClick={() => onNav(id)}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('jarvis_token') || '');
  const [page, setPage] = useState('calls');
  const [remainingCount, setRemainingCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogin = useCallback((t) => {
    sessionStorage.setItem('jarvis_token', t);
    setToken(t);
  }, []);

  const handleNav = useCallback((p) => {
    setPage(p);
  }, []);

  // Poll remaining count for badge
  useEffect(() => {
    if (!token) return;
    const refresh = async () => {
      try {
        const res = await apiFetch('/api/plan/today', token);
        if (res.ok) {
          const data = await res.json();
          const remaining = Array.isArray(data) ? data.filter(d => !d.called_at).length : 0;
          setRemainingCount(remaining);
        }
      } catch (_) {}
    };
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [token]);

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const pageTitles = {
    calls: { title: 'Today\'s Calls', subtitle: 'DAILY INTELLIGENCE BRIEF' },
    market: { title: 'Market Events', subtitle: 'RECENT ACTIVITY — 14 DAYS' },
    buyers: { title: 'Buyer Enquiries', subtitle: 'ACTIVE CALL LIST' },
    reminders: { title: 'Reminders', subtitle: 'UPCOMING FOLLOW-UPS' },
    history: { title: 'Call History', subtitle: 'TODAY\'S LOGGED OUTCOMES' }
  };
  const pt = pageTitles[page] || pageTitles.calls;

  const renderPage = () => {
    switch (page) {
      case 'calls':     return <CallsPage token={token} />;
      case 'market':    return <MarketPage token={token} />;
      case 'buyers':    return <BuyersPage token={token} />;
      case 'reminders': return <RemindersPage token={token} />;
      case 'history':   return <HistoryPage token={token} />;
      default:          return <CallsPage token={token} />;
    }
  };

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        page={page}
        onNav={p => { handleNav(p); setSidebarOpen(false); }}
        remainingCount={remainingCount}
        mobileOpen={sidebarOpen}
      />
      <main className="main-content">
        <MobileHeader page={page} onMenuClick={() => setSidebarOpen(o => !o)} />
        <div className="page-header">
          <h1 className="page-title">{pt.title}</h1>
          <span className="page-subtitle">{pt.subtitle}</span>
        </div>
        {renderPage()}
      </main>
      <BottomTabBar page={page} onNav={handleNav} />
    </div>
  );
}

// ── Error Boundary ─────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 40, color: '#C8A96E', fontFamily: 'DM Mono, monospace', fontSize: 13, background: '#080C0F', minHeight: '100vh' }}>
          <div style={{ marginBottom: 8, fontSize: 10, letterSpacing: '0.1em', opacity: 0.5 }}>JARVIS — RENDER ERROR</div>
          <div style={{ color: '#F87171', marginBottom: 12 }}>{this.state.err.message}</div>
          <pre style={{ color: '#64748B', fontSize: 11, whiteSpace: 'pre-wrap' }}>{this.state.err.stack}</pre>
          <button onClick={() => { sessionStorage.clear(); this.setState({ err: null }); }}
            style={{ marginTop: 20, padding: '8px 16px', background: 'transparent', border: '1px solid rgba(200,169,110,0.3)', color: '#C8A96E', cursor: 'pointer', borderRadius: 5, fontFamily: 'DM Mono, monospace' }}>
            Clear session &amp; reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Mount ──────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
