// JARVIS Intelligence Terminal — Dashboard SPA
// React 18 + Babel Standalone (no build step)
// All icons via lucide global, all styles via dashboard.css

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Lucide icon destructuring (lucide-react UMD → window.LucideReact) ─────
const {
  Phone, ChevronDown, ChevronUp, Bell, TrendingUp, Users, Clock,
  MapPin, Calendar, Check, X, AlertCircle, Home, Activity,
  MessageSquare, PhoneCall, PhoneOff, Star, RefreshCw,
  History, Menu, Building2, CheckCircle, Plus, Mail,
  Search, Pencil, Trash2, Copy, Send, ClipboardList, FileEdit, Wand2
} = LucideReact;

// SMS link helper — opens iMessages on macOS
function smsHref(phone) { return 'sms:' + (phone || '').replace(/\s/g, ''); }

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
  const target    = status?.target || 30;
  const remaining = Math.max(0, planCount - calledCount);
  const pct = planCount > 0 ? Math.round((calledCount / planCount) * 100) : 0;

  // Email scan freshness pill
  let emailColor = 'var(--text-muted)';
  let emailLabel = '—';
  if (status?.lastEmailScan) {
    const minAgo = Math.floor((Date.now() - new Date(status.lastEmailScan)) / 60000);
    emailLabel = minAgo < 2 ? 'just now' : minAgo < 60 ? `${minAgo}m ago` : `${Math.floor(minAgo/60)}h ago`;
    emailColor = minAgo < 20 ? '#22c55e' : minAgo < 60 ? '#f59e0b' : '#f87171';
  }

  return (
    <div className="status-strip">
      <div className="stat-chip">
        <span className="stat-value">{planCount}<span style={{ fontSize: 13, opacity: 0.5 }}>/{target}</span></span>
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
      <div className="stat-divider" />
      <div className="stat-chip" title="Last email scan">
        <span className="stat-value" style={{ fontSize: 12, color: emailColor, display: 'flex', alignItems: 'center', gap: 3 }}>
          <Mail size={10} style={{ color: emailColor }} />
          {emailLabel}
        </span>
        <span className="stat-label">Email Scan</span>
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
          <span className="agenda-next">{nextItem.time && `${nextItem.time} \u00b7 `}{nextItem.label}</span>
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
  const [showReferModal, setShowReferModal] = useState(false);
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
      if (typeof CallStatsBar.refresh === 'function') CallStatsBar.refresh();
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
          <button
            onClick={e => { e.stopPropagation(); setShowReferModal(true); }}
            title="Refer contact to a partner"
            style={{padding:'5px 10px',background:'transparent',
              border:'1px solid var(--border-gold)',color:'var(--gold)',
              borderRadius:'4px',cursor:'pointer',fontSize:'11px',fontWeight:'500',
              letterSpacing:'0.05em'}}>
            Refer
          </button>
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
              {savingFollowUp ? 'Saving…' : 'Save Follow-up'}
            </button>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {showEdit && (localContact.id || localContact.contact_id) && (
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

      {/* Refer modal */}
      {showReferModal && (
        <ReferModal
          contact={localContact}
          token={token}
          onClose={() => setShowReferModal(false)}
          onSuccess={() => setShowReferModal(false)}
        />
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
              context="circle"
              autoExpand={activeContactId && (c.contact_id === activeContactId || c.id === activeContactId)}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Edit Contact Modal ──────────────────────────────────────────────────────
function EditContactModal({ contact, token, onSaved, onClose }) {
  const [name,    setName]    = useState(contact.name || '');
  const [mobile,  setMobile]  = useState(contact.mobile || '');
  const [address, setAddress] = useState(contact.address || '');
  const [suburb,  setSuburb]  = useState(contact.suburb || '');
  const [dnc,     setDnc]     = useState(!!contact.do_not_call);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);

  const editContactId = contact.id || contact.contact_id;

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`/api/contacts/${editContactId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(), mobile: mobile.trim(),
          address: address.trim(), suburb: suburb.trim(),
          do_not_call: dnc ? 1 : 0
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onSaved(data.contact);
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }, [editContactId, name, mobile, address, suburb, dnc, token, onSaved, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Edit Contact</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {[['Name', name, setName, 'text', ''],
            ['Mobile', mobile, setMobile, 'text', '04xx xxx xxx'],
            ['Address', address, setAddress, 'text', ''],
            ['Suburb', suburb, setSuburb, 'text', '']
          ].map(([label, val, setter, type, ph]) => (
            <div className="edit-field" key={label}>
              <label className="edit-label">{label}</label>
              <input className="edit-input" type={type} value={val}
                placeholder={ph} onChange={e => setter(e.target.value)} />
            </div>
          ))}
          <div className="edit-field edit-field--inline">
            <label className="edit-label">Do Not Call</label>
            <input type="checkbox" className="edit-checkbox" checked={dnc}
              onChange={e => setDnc(e.target.checked)} />
          </div>
          {error && <div className="edit-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
            {saving ? 'Saving…' : 'Add Contact'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Contact Notes Modal ─────────────────────────────────────────────────────
const DURATION_OPTIONS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
];

function ContactNotesModal({ contact, token, onClose, prefilledNote = '' }) {
  const [notes,        setNotes]        = useState([]);
  const [history,      setHistory]      = useState([]);
  const [noteText,     setNoteText]     = useState(prefilledNote);
  const [saving,       setSaving]       = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [showReminder, setShowReminder] = useState(false);
  const [remDays,      setRemDays]      = useState(1);
  const [remNote,      setRemNote]      = useState('');
  const [remDuration,  setRemDuration]  = useState(30);
  const [savingRem,    setSavingRem]    = useState(false);
  const [remSaved,     setRemSaved]     = useState(false);

  const cid = contact.id || contact.contact_id;

  useEffect(() => {
    if (!contact.id && !contact.contact_id) { setLoading(false); return; }
    Promise.all([
      apiFetch(`/api/contacts/${cid}/notes`, token).then(r => r.json()),
      apiFetch(`/api/contacts/${cid}/history`, token).then(r => r.json()),
    ]).then(([n, h]) => {
      setNotes(Array.isArray(n) ? n : []);
      setHistory(Array.isArray(h) ? h : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [cid, token]);

  const handleSaveNote = useCallback(async () => {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/contacts/${cid}/notes`, token, {
        method: 'POST', body: JSON.stringify({ note: noteText.trim() })
      });
      const data = await res.json();
      if (data.note) setNotes(prev => [data.note, ...prev]);
      setNoteText('');
    } catch (_) {}
    finally { setSaving(false); }
  }, [cid, noteText, token]);

  const handleSaveReminder = useCallback(async () => {
    setSavingRem(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + remDays);
      d.setHours(9, 0, 0, 0);
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id:       cid,
          contact_name:     contact.name,
          contact_mobile:   contact.mobile,
          note:             remNote || `Follow up \u2014 ${contact.name}`,
          fire_at:          d.toISOString(),
          duration_minutes: remDuration,
        })
      });
      setRemSaved(true);
      setShowReminder(false);
    } catch (_) {}
    finally { setSavingRem(false); }
  }, [contact, token, remDays, remNote, remDuration]);

  const timeline = [
    ...notes.map(n   => ({ type: 'note', text: n.note, ts: n.created_at })),
    ...history.map(h => ({ type: 'call', text: `${OUTCOME_LABELS[h.outcome] || h.outcome}${h.notes ? ' \u2014 ' + h.notes : ''}`, ts: h.called_at })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--notes" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Notes \u2014 {contact.name}</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">

          <div className="notes-add-section">
            <textarea className="notes-textarea" placeholder="Add a note…"
              value={noteText} onChange={e => setNoteText(e.target.value)} rows={3} />
            <div className="notes-add-actions">
              <button className="notes-btn-reminder-toggle"
                onClick={() => setShowReminder(v => !v)}>
                <Bell size={12} /> {showReminder ? 'Hide Reminder' : 'Set Reminder'}
              </button>
              <button className="modal-btn modal-btn--save"
                onClick={handleSaveNote} disabled={saving || !noteText.trim()}>
                {saving ? 'Saving…' : 'Save Note'}
              </button>
            </div>
          </div>

          {showReminder && (
            <div className="notes-reminder-section">
              <div className="followup-label">Follow up in:</div>
              <div className="followup-row">
                {[[1,'Tomorrow'],[2,'2 Days'],[7,'1 Week']].map(([days, label]) => (
                  <button key={days}
                    className={`followup-quick${remDays === days ? ' active' : ''}`}
                    onClick={() => setRemDays(days)}>{label}</button>
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
                placeholder="Reminder note (optional)…"
                value={remNote} onChange={e => setRemNote(e.target.value)} />
              <div className="followup-actions">
                <button className="followup-skip" onClick={() => setShowReminder(false)}>Cancel</button>
                <button className="followup-save" onClick={handleSaveReminder} disabled={savingRem}>
                  {savingRem ? 'Saving…' : 'Save Reminder'}
                </button>
              </div>
            </div>
          )}

          {remSaved && <div className="notes-reminder-saved"><Check size={11} /> Reminder saved</div>}

          <div className="notes-timeline">
            {loading && <div className="notes-loading">Loading…</div>}
            {!loading && timeline.length === 0 && (
              <div className="notes-empty">No notes or calls yet.</div>
            )}
            {timeline.map((item, i) => (
              <div key={i} className={`notes-entry notes-entry--${item.type}`}>
                <div className="notes-entry-meta">
                  <span className="notes-entry-type">{item.type === 'note' ? '\uD83D\uDCDD Note' : '\uD83D\uDCDE Call'}</span>
                  <span className="notes-entry-ts">{fmtDate(item.ts)} {fmtTime(item.ts)}</span>
                </div>
                <div className="notes-entry-text">{item.text}</div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
}

// ProspectCard removed — unified ContactCard above handles all contexts

// ── Refer Modal ─────────────────────────────────────────────────────────────
function ReferModal({ contact, token, onClose, onSuccess }) {
  const contactId = contact.contact_id || contact.id;
  const [partners, setPartners] = React.useState([]);
  const [partnerId, setPartnerId] = React.useState('');
  const [type, setType] = React.useState('');
  const [disclosureSent, setDisclosureSent] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [buyerBrief, setBuyerBrief] = React.useState({
    budget_min: '', budget_max: '', suburbs: '',
    property_type: '', timeframe: '', pre_approved: ''
  });
  const [polishingBrief, setPolishingBrief] = React.useState(false);
  const [polishedBrief, setPolishedBrief] = React.useState('');

  React.useEffect(() => {
    apiFetch('/api/partners', token).then(r => r.json()).then(data => {
      const list = data.partners || data || [];
      setPartners(list);
      if (list.length) setPartnerId(String(list[0].id));
    }).catch(() => {});
    const cc = (contact.contact_class || contact.contactClass || '').toLowerCase();
    if (cc.includes('vendor')) setType('vendor');
    else if (cc.includes('buyer')) setType('buyer');
    else setType('finance');
    apiFetch(`/api/buyer-profiles?contact_id=${contactId}`, token).then(r => r.json()).then(profiles => {
      if (Array.isArray(profiles) && profiles.length) {
        const p = profiles[0];
        setBuyerBrief(prev => ({
          ...prev,
          budget_min: p.price_min || '',
          budget_max: p.price_max || '',
          suburbs: p.suburbs_wanted || '',
          property_type: p.property_type || '',
          timeframe: p.timeframe || '',
          pre_approved: p.pre_approved || ''
        }));
      }
    }).catch(() => {});
  }, [contactId, token]);

  const partner = partners.find(p => String(p.id) === partnerId);

  const feeDisplay = partner ? (
    partner.fee_type === 'percentage'
      ? `~${partner.fee_value}% of commission`
      : `$${Number(partner.fee_value).toLocaleString()} flat`
  ) : '';

  const typeColor = { vendor: 'var(--gold)', buyer: '#3b82f6', finance: '#22c55e' };
  const typeLabel = { vendor: 'Vendor Lead', buyer: 'Buyer Lead', finance: 'Finance Lead' };

  async function handlePolishBrief() {
    setPolishingBrief(true);
    try {
      const res = await apiFetch('/api/referrals/polish-brief', token, {
        method: 'POST',
        body: JSON.stringify({ ...buyerBrief, raw_notes: notes })
      });
      const data = await res.json();
      if (data.brief) setPolishedBrief(data.brief);
    } catch(e) {}
    setPolishingBrief(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!disclosureSent) { setError('Confirm disclosure was sent before referring.'); return; }
    if (!partnerId) { setError('Select a partner.'); return; }
    setSaving(true);
    setError('');
    const feeVal = partner && partner.fee_type === 'flat' ? partner.fee_value : null;
    const briefPayload = type === 'buyer' ? { ...buyerBrief, ai_brief: polishedBrief || undefined } : null;
    const res = await apiFetch('/api/referrals', token, {
      method: 'POST',
      body: JSON.stringify({
        contact_id: contactId,
        partner_id: parseInt(partnerId),
        type, expected_fee: feeVal,
        disclosure_sent: true,
        buyer_brief: briefPayload,
        notes
      })
    });
    setSaving(false);
    if (res.ok) { onSuccess && onSuccess(); onClose(); }
    else { const d = await res.json(); setError(d.error || 'Failed to save referral'); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}
        style={{maxWidth:'480px',background:'var(--bg-surface)',border:'1px solid var(--border-gold)'}}>
        {/* Header */}
        <div style={{padding:'16px 20px',borderBottom:'1px solid var(--border-subtle)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{color:'var(--gold)',fontSize:'13px',fontWeight:'600',letterSpacing:'0.1em'}}>REFER CONTACT</div>
            <div style={{color:'var(--text-primary)',fontSize:'15px',fontWeight:'500',marginTop:'2px'}}>{contact.name}</div>
            <div style={{color:'var(--text-muted)',fontSize:'11px'}}>{contact.address || contact.contact_address}</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:'20px',lineHeight:1}}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{padding:'16px 20px',display:'flex',flexDirection:'column',gap:'14px'}}>
          {/* Type selector */}
          <div>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',letterSpacing:'0.08em',marginBottom:'6px'}}>LEAD TYPE</label>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px'}}>
              {['vendor','buyer','finance'].map(t => (
                <button type="button" key={t} onClick={() => setType(t)}
                  style={{padding:'8px 4px',border:`1px solid ${type===t ? typeColor[t] : 'var(--border-subtle)'}`,
                    background: type===t ? `${typeColor[t]}15` : 'var(--bg-raised)',
                    color: type===t ? typeColor[t] : 'var(--text-muted)',
                    borderRadius:'4px',cursor:'pointer',fontSize:'11px',fontWeight: type===t ? '600' : '400',
                    transition:'all 0.15s'}}>
                  {typeLabel[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Partner selector */}
          <div>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',letterSpacing:'0.08em',marginBottom:'6px'}}>PARTNER</label>
            {partners.length === 0
              ? <div style={{padding:'10px',background:'var(--bg-raised)',borderRadius:'4px',color:'var(--text-muted)',fontSize:'12px'}}>
                  No partners yet — add them in the Referrals page first.
                </div>
              : <select value={partnerId} onChange={e => setPartnerId(e.target.value)}
                  style={{width:'100%',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',
                    color:'var(--text-primary)',padding:'9px 12px',borderRadius:'4px',fontSize:'13px'}}>
                  {partners.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.type.replace(/_/g,' ')} {p.suburb_focus ? `(${p.suburb_focus})` : ''}
                    </option>
                  ))}
                </select>
            }
            {partner && (
              <div style={{marginTop:'6px',padding:'8px 12px',background:'rgba(200,169,110,0.08)',
                border:'1px solid var(--border-gold)',borderRadius:'4px',display:'flex',justifyContent:'space-between',
                alignItems:'center',fontSize:'12px'}}>
                <span style={{color:'var(--text-muted)'}}>Referral fee</span>
                <span style={{color:'var(--gold)',fontWeight:'600'}}>{feeDisplay}</span>
              </div>
            )}
          </div>

          {/* Buyer brief section — only when type = buyer */}
          {type === 'buyer' && (
            <div style={{border:'1px solid rgba(59,130,246,0.35)',borderRadius:'6px',overflow:'hidden'}}>
              <div style={{padding:'10px 14px',background:'rgba(59,130,246,0.08)',
                display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:'#3b82f6',fontSize:'11px',fontWeight:'600',letterSpacing:'0.08em'}}>BUYER BRIEF</span>
                <span style={{color:'#3b82f6',fontSize:'10px',opacity:0.7}}>Increases referral value to $3–5k</span>
              </div>
              <div style={{padding:'12px 14px',display:'flex',flexDirection:'column',gap:'10px'}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px'}}>
                  <div>
                    <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>BUDGET MIN</label>
                    <input type="number" value={buyerBrief.budget_min}
                      onChange={e => setBuyerBrief({...buyerBrief,budget_min:e.target.value})}
                      placeholder="1500000"
                      style={{width:'100%',boxSizing:'border-box',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                        color:'var(--text-primary)',padding:'7px 10px',borderRadius:'4px',fontSize:'12px'}} />
                  </div>
                  <div>
                    <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>BUDGET MAX</label>
                    <input type="number" value={buyerBrief.budget_max}
                      onChange={e => setBuyerBrief({...buyerBrief,budget_max:e.target.value})}
                      placeholder="2200000"
                      style={{width:'100%',boxSizing:'border-box',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                        color:'var(--text-primary)',padding:'7px 10px',borderRadius:'4px',fontSize:'12px'}} />
                  </div>
                </div>
                <div>
                  <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>TARGET SUBURBS</label>
                  <input value={buyerBrief.suburbs}
                    onChange={e => setBuyerBrief({...buyerBrief,suburbs:e.target.value})}
                    placeholder="e.g. Mosman, Cremorne, Neutral Bay"
                    style={{width:'100%',boxSizing:'border-box',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                      color:'var(--text-primary)',padding:'7px 10px',borderRadius:'4px',fontSize:'12px'}} />
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px'}}>
                  <div>
                    <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>PROPERTY TYPE</label>
                    <select value={buyerBrief.property_type}
                      onChange={e => setBuyerBrief({...buyerBrief,property_type:e.target.value})}
                      style={{width:'100%',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                        color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'11px'}}>
                      <option value="">Any</option>
                      <option value="house">House</option>
                      <option value="unit">Unit</option>
                      <option value="townhouse">Townhouse</option>
                    </select>
                  </div>
                  <div>
                    <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>TIMEFRAME</label>
                    <select value={buyerBrief.timeframe}
                      onChange={e => setBuyerBrief({...buyerBrief,timeframe:e.target.value})}
                      style={{width:'100%',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                        color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'11px'}}>
                      <option value="">Unknown</option>
                      <option value="asap">ASAP</option>
                      <option value="1-3 months">1–3 months</option>
                      <option value="3-6 months">3–6 months</option>
                      <option value="6+ months">6+ months</option>
                    </select>
                  </div>
                  <div>
                    <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',marginBottom:'3px'}}>PRE-APPROVED?</label>
                    <select value={buyerBrief.pre_approved}
                      onChange={e => setBuyerBrief({...buyerBrief,pre_approved:e.target.value})}
                      style={{width:'100%',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',
                        color:'var(--text-primary)',padding:'7px',borderRadius:'4px',fontSize:'11px'}}>
                      <option value="">Unknown</option>
                      <option value="yes">Yes ✓</option>
                      <option value="no">No</option>
                    </select>
                  </div>
                </div>

                {/* AI Polish Brief */}
                <div>
                  <button type="button" onClick={handlePolishBrief} disabled={polishingBrief}
                    style={{padding:'7px 14px',background:'rgba(168,85,247,0.15)',
                      border:'1px solid rgba(168,85,247,0.4)',color:'#a855f7',borderRadius:'4px',
                      cursor:'pointer',fontSize:'11px',fontWeight:'600',display:'flex',
                      alignItems:'center',gap:'6px',opacity: polishingBrief ? 0.6 : 1}}>
                    ✦ {polishingBrief ? 'Generating...' : 'Polish Brief with AI'}
                  </button>
                  {polishedBrief && (
                    <div style={{marginTop:'8px',padding:'10px 12px',background:'rgba(168,85,247,0.08)',
                      border:'1px solid rgba(168,85,247,0.3)',borderRadius:'4px',
                      fontSize:'12px',color:'var(--text-primary)',lineHeight:'1.5',
                      fontStyle:'italic'}}>
                      "{polishedBrief}"
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label style={{display:'block',color:'var(--text-muted)',fontSize:'10px',letterSpacing:'0.08em',marginBottom:'6px'}}>NOTES (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{width:'100%',boxSizing:'border-box',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',
                color:'var(--text-primary)',padding:'9px 12px',borderRadius:'4px',fontSize:'12px',
                resize:'vertical',fontFamily:'inherit'}} />
          </div>

          {/* Disclosure checkbox */}
          <div style={{padding:'10px 14px',background:'rgba(200,169,110,0.05)',border:'1px solid var(--border-gold)',borderRadius:'4px'}}>
            <label style={{display:'flex',alignItems:'flex-start',gap:'10px',cursor:'pointer',fontSize:'12px',color:'var(--text-primary)'}}>
              <input type="checkbox" checked={disclosureSent} onChange={e => setDisclosureSent(e.target.checked)}
                style={{marginTop:'2px',accentColor:'var(--gold)'}} />
              <span>I have sent a disclosure SMS/email to <strong>{contact.name}</strong> advising I may receive a referral fee for this introduction.</span>
            </label>
          </div>

          {error && <div style={{color:'#ef4444',fontSize:'12px',padding:'8px 12px',background:'rgba(239,68,68,0.08)',borderRadius:'4px'}}>{error}</div>}

          <button type="submit" disabled={saving || partners.length === 0}
            style={{padding:'11px',background: saving ? 'var(--bg-raised)' : 'var(--gold)',
              color: saving ? 'var(--text-muted)' : '#000',border:'none',borderRadius:'4px',
              fontWeight:'700',fontSize:'13px',letterSpacing:'0.05em',cursor: saving ? 'default' : 'pointer',
              transition:'all 0.15s'}}>
            {saving ? 'Saving...' : 'CONFIRM REFERRAL'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Event Group (collapsible group within Just Sold / Just Listed) ──────────
function EventGroup({ alert, token, accentColor, defaultExpanded, onDismiss }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showMore, setShowMore] = useState(false);
  const [calledMap, setCalledMap] = useState({});
  const [dismissing, setDismissing] = useState(false);

  const contacts = alert.topContacts || [];
  const watchers = alert.type === 'sold' ? (alert.watchers || []) : [];
  const initialCount = Math.min(10, contacts.length);
  const visibleContacts = showMore ? contacts : contacts.slice(0, initialCount);
  const calledCount = Object.keys(calledMap).length;

  const handleLogged = useCallback((id, outcome) => {
    setCalledMap(prev => ({ ...prev, [id]: outcome }));
  }, []);

  const handleDismiss = useCallback(async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Dismiss "${alert.address}" from the board?`)) return;
    setDismissing(true);
    try {
      const res = await apiFetch('/api/alerts', token, {
        method: 'DELETE',
        body: JSON.stringify({ address: alert.address }),
      });
      if (res.ok && onDismiss) onDismiss(alert.address);
    } catch (err) { console.error('Dismiss failed', err); }
    finally { setDismissing(false); }
  }, [alert.address, token, onDismiss]);

  const ageDays = Math.floor((Date.now() - new Date(alert.detectedAt)) / 86400000);
  const ageLabel = ageDays === 0 ? 'TODAY' : ageDays === 1 ? '1 DAY AGO' : `${ageDays} DAYS AGO`;
  const daysLeft = 14 - ageDays;
  const daysLeftLabel = daysLeft <= 0 ? 'Expires today' : `${daysLeft}d left`;
  const daysLeftColor = daysLeft > 7 ? '#22c55e' : daysLeft >= 3 ? 'var(--gold)' : '#ef4444';

  const propParts = [
    alert.beds && `${alert.beds}bed`,
    alert.propertyType
  ].filter(Boolean).join(' · ');

  return (
    <div className="event-group" style={{ '--group-accent': accentColor }}>
      <div className="event-group-header" onClick={() => setExpanded(e => !e)}>
        <div className="event-group-meta-row">
          <span className="event-group-age" style={{ color: accentColor }}>{ageLabel}</span>
          <span style={{ fontSize: 10, color: daysLeftColor, fontFamily: 'var(--font-mono)', marginLeft: 6 }}>{daysLeftLabel}</span>
          {calledCount > 0 && (
            <span className="event-group-progress">{calledCount}/{contacts.length} called</span>
          )}
          <button
            onClick={handleDismiss}
            disabled={dismissing}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', padding: '2px 6px', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 3, opacity: dismissing ? 0.5 : 1 }}
            title="Dismiss from board"
          >✕ Dismiss</button>
          <ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--text-muted)', flexShrink: 0 }} />
        </div>
        <div className="event-group-addr">{alert.address}</div>
        <div className="event-group-detail">
          {propParts && <span>{propParts}</span>}
          {alert.price && <span style={{ color: accentColor, marginLeft: 6 }}>{alert.price}</span>}
        </div>
      </div>
      {expanded && (
        <div className="event-group-cards">
          {watchers.length > 0 && (
            <div className="watchers-section">
              <div className="watchers-header">
                <Bell size={10} />
                <span>WANTS RESULT ({watchers.length})</span>
              </div>
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
            </div>
          )}
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
          {!showMore && contacts.length > initialCount && (
            <button className="show-more-btn" onClick={e => { e.stopPropagation(); setShowMore(true); }}>
              Show {contacts.length - initialCount} more ↓
            </button>
          )}
          {contacts.length === 0 && (
            <div className="prospect-empty">No contacts logged for this event</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Calls Page ─────────────────────────────────────────────────────────────
function CallsPage({ token, onReminderCountChange }) {
  const [plan, setPlan] = useState([]);
  const planRef = useRef([]);
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeContactId, setActiveContactId] = useState(null);
  const [calledOpen, setCalledOpen] = useState(false);
  const [topping, setTopping] = useState(false);
  const [mobileCol, setMobileCol] = useState('circle'); // 'circle' | 'sold' | 'listed'
  const [reminders, setReminders] = useState([]);
  const [showNewContact, setShowNewContact] = useState(false);

  useEffect(() => { planRef.current = plan; }, [plan]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [planRes, alertsRes, statusRes, remindersRes] = await Promise.all([
        apiFetch('/api/plan/today', token),
        apiFetch('/api/alerts', token),
        apiFetch('/api/status', token),
        apiFetch('/api/reminders/upcoming', token)
      ]);
      if (planRes.ok) {
        const data = await planRes.json();
        setPlan(data);
        const firstUncalled = data.find(d => !d.called_at);
        if (firstUncalled) setActiveContactId(firstUncalled.contact_id || firstUncalled.id);
      }
      if (alertsRes.ok) setAlerts(await alertsRes.json());
      if (statusRes.ok) setStatus(await statusRes.json());
      if (remindersRes.ok) {
        const rems = await remindersRes.json();
        setReminders(Array.isArray(rems) ? rems : []);
        if (onReminderCountChange) onReminderCountChange(Array.isArray(rems) ? rems.filter(r => r.fire_at && !r.is_task).length : 0);
      }
    } catch (err) { console.error('Load failed', err); }
    finally { setLoading(false); }
  }, [token, onReminderCountChange]);

  const handleDismissAlert = useCallback((address) => {
    setAlerts(prev => prev.filter(a => (a.address || '').trim().toLowerCase() !== address.trim().toLowerCase()));
  }, []);

  const handleTopUp = useCallback(async (n = 10) => {
    setTopping(true);
    try {
      const res = await apiFetch(`/api/plan/topup?n=${n}`, token, { method: 'POST' });
      if (res.ok) await loadData();
    } catch (err) { console.error('Top up failed', err); }
    finally { setTopping(false); }
  }, [token, loadData]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleLogged = useCallback(() => {
    const currentPlan = planRef.current;
    const uncalled = currentPlan.filter(d => !d.called_at);
    const currentIdx = uncalled.findIndex(d => (d.contact_id || d.id) === activeContactId);
    const nextUncalled = uncalled.filter((_, i) => i !== currentIdx);
    setPlan(prev => prev.map(d =>
      (d.contact_id || d.id) === activeContactId
        ? { ...d, called_at: new Date().toISOString() } : d
    ));
    if (nextUncalled.length > 0) {
      const next = nextUncalled[Math.min(currentIdx, nextUncalled.length - 1)];
      setActiveContactId(next.contact_id || next.id);
    } else { setActiveContactId(null); }
  }, [activeContactId]);

  const uncalled = plan.filter(d => !d.called_at);
  const called   = plan.filter(d => !!d.called_at);
  const high     = uncalled.filter(d => getScore(d) >= 45);
  const med      = uncalled.filter(d => { const s = getScore(d); return s >= 20 && s < 45; });
  const low      = uncalled.filter(d => getScore(d) < 20);

  const now = Date.now();
  const CUTOFF_DAYS = 14;
  const soldAlerts   = alerts.filter(a => a.type === 'sold'    && (now - new Date(a.detectedAt)) / 86400000 <= CUTOFF_DAYS).sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
  const listedAlerts = alerts.filter(a => a.type === 'listing' && (now - new Date(a.detectedAt)) / 86400000 <= CUTOFF_DAYS).sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));

  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const dueToday = reminders.filter(r => r.fire_at && new Date(r.fire_at) <= endOfToday);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.1em' }}>Loading intelligence...</span>
      </div>
    );
  }

  // ── Column 1: Circle Prospecting ─────────────────────────────────────────
  const circleColumn = (
    <div className="call-col">
      <div className="call-col-header call-col-header--gold" style={{ display: 'flex', alignItems: 'center' }}>
        <span className="call-col-title">CIRCLE PROSPECTING</span>
        <span className="call-col-badge">{uncalled.length}</span>
        <button
          className="topup-btn topup-btn--sm"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowNewContact(true)}
          title="Add new contact"
        ><Plus size={11} /> New</button>
        <button
          onClick={loadData}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px', borderRadius: '4px', display: 'flex', alignItems: 'center' }}
          title="Refresh"
        ><RefreshCw size={14} /></button>
      </div>
      <div className="call-col-body">
        {dueToday.length > 0 && (
          <div className="due-today-section">
            <div className="due-today-header">
              <Bell size={11} style={{ color: 'var(--gold)' }} />
              <span>Due Today ({dueToday.length})</span>
            </div>
            {dueToday.map(r => (
              <div className="due-today-card" key={r.id}>
                <div className="due-today-name">{r.contact_name}</div>
                <div className="due-today-note">{r.note}</div>
                {r.contact_mobile && (
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <a className="prospect-tel" href={`tel:${r.contact_mobile}`} style={{ display: 'inline-flex' }}>
                      <Phone size={10} />{r.contact_mobile}
                    </a>
                    <a className="prospect-sms" href={smsHref(r.contact_mobile)} title="Send iMessage/SMS">
                      <MessageSquare size={12} />
                    </a>
                    <button
                      className="prospect-copy"
                      onClick={() => navigator.clipboard.writeText(r.contact_mobile)}
                      title="Copy number"
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <TierSection tier="high" contacts={high} token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={true} />
        <TierSection tier="med"  contacts={med}  token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={true} />
        <TierSection tier="low"  contacts={low}  token={token} onLogged={handleLogged} activeContactId={activeContactId} defaultOpen={false} />
        {called.length > 0 && (
          <div className="tier-section">
            <div className="tier-header tier-low" onClick={() => setCalledOpen(o => !o)}>
              <CheckCircle size={8} style={{ color: 'var(--tier-high)', flexShrink: 0 }} />
              <span className="tier-label" style={{ color: 'var(--text-muted)' }}>Called Today</span>
              <span className="tier-count">({called.length})</span>
              <span className={`tier-chevron${calledOpen ? ' open' : ''}`}><ChevronDown size={14} /></span>
            </div>
            {calledOpen && (
              <div className="tier-cards">
                {called.map((c, i) => (
                  <ContactCard key={c.id || c.contact_id || i} contact={c} token={token} onLogged={handleLogged} context="circle" autoExpand={false} index={i} />
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 20px', gap: 6 }}>
          <button className="topup-btn" onClick={() => handleTopUp(10)} disabled={topping}>
            {topping ? 'Fetching…' : '+ Top Up 10'}
          </button>
          <button className="topup-btn topup-btn--sm" onClick={() => handleTopUp(5)} disabled={topping}>+5</button>
        </div>
        {plan.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon"><Calendar size={28} /></div>
            <div className="empty-state-title">No contacts planned</div>
            <div className="empty-state-sub">Run daily-planner.js or tap Top Up</div>
          </div>
        )}
      </div>
    </div>
  );

  // ── Column 2: Just Sold ───────────────────────────────────────────────────
  const soldColumn = (
    <div className="call-col">
      <div className="call-col-header call-col-header--green">
        <span className="call-col-title">JUST SOLD</span>
        <span className="call-col-badge call-col-badge--green">{soldAlerts.length}</span>
      </div>
      <div className="call-col-body">
        {soldAlerts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" style={{ color: '#22c55e' }}><Activity size={28} /></div>
            <div className="empty-state-title">No recent sales detected</div>
            <div className="empty-state-sub">Sales within 14 days will appear here</div>
          </div>
        ) : (
          soldAlerts.map((alert, i) => (
            <EventGroup
              key={alert.address + alert.detectedAt}
              alert={alert}
              token={token}
              accentColor="#22c55e"
              defaultExpanded={i === 0}
              onDismiss={handleDismissAlert}
            />
          ))
        )}
      </div>
    </div>
  );

  // ── Column 3: Just Listed ─────────────────────────────────────────────────
  const listedColumn = (
    <div className="call-col">
      <div className="call-col-header call-col-header--blue">
        <span className="call-col-title">JUST LISTED</span>
        <span className="call-col-badge call-col-badge--blue">{listedAlerts.length}</span>
      </div>
      <div className="call-col-body">
        {listedAlerts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" style={{ color: '#3b82f6' }}><Home size={28} /></div>
            <div className="empty-state-title">No new listings in area</div>
            <div className="empty-state-sub">New listings within 14 days appear here</div>
          </div>
        ) : (
          listedAlerts.map((alert, i) => (
            <EventGroup
              key={alert.address + alert.detectedAt}
              alert={alert}
              token={token}
              accentColor="#3b82f6"
              defaultExpanded={i === 0}
              onDismiss={handleDismissAlert}
            />
          ))
        )}
      </div>
    </div>
  );

  return (
    <>
      <StatusStrip status={status} planCount={plan.length} calledCount={called.length} />

      {/* Mobile column tabs */}
      <div className="call-col-tabs">
        <button className={`call-col-tab${mobileCol === 'circle' ? ' active' : ''}`} onClick={() => setMobileCol('circle')}>
          CIRCLE <span className="call-col-tab-badge">{uncalled.length}</span>
        </button>
        <button className={`call-col-tab call-col-tab--green${mobileCol === 'sold' ? ' active' : ''}`} onClick={() => setMobileCol('sold')}>
          SOLD <span className="call-col-tab-badge">{soldAlerts.length}</span>
        </button>
        <button className={`call-col-tab call-col-tab--blue${mobileCol === 'listed' ? ' active' : ''}`} onClick={() => setMobileCol('listed')}>
          LISTED <span className="call-col-tab-badge">{listedAlerts.length}</span>
        </button>
      </div>

      {/* Desktop: three columns. Mobile: one column based on tab */}
      <div className="call-board">
        <div className={`call-col-wrap${mobileCol === 'circle' ? ' mobile-visible' : ' mobile-hidden'}`}>
          {circleColumn}
        </div>
        <div className={`call-col-wrap${mobileCol === 'sold' ? ' mobile-visible' : ' mobile-hidden'}`}>
          {soldColumn}
        </div>
        <div className={`call-col-wrap${mobileCol === 'listed' ? ' mobile-visible' : ' mobile-hidden'}`}>
          {listedColumn}
        </div>
      </div>
      {showNewContact && (
        <NewContactModal
          token={token}
          onCreated={() => { setShowNewContact(false); loadData(); }}
          onClose={() => setShowNewContact(false)}
        />
      )}
    </>
  );
}

// ── Add Market Event Modal ──────────────────────────────────────────────────
function AddEventModal({ token, onClose, onAdded, editEvent }) {
  const isEdit = !!editEvent;
  const [form, setForm] = useState({
    address:         editEvent?.address         || '',
    type:            editEvent?.type            || 'sold',
    beds:            editEvent?.beds            || '',
    baths:           editEvent?.baths           || '',
    cars:            editEvent?.cars            || '',
    property_type:   editEvent?.property_type   || 'House',
    price:           editEvent?.price           || '',
    confirmed_price: editEvent?.confirmed_price || '',
    sold_date:       editEvent?.sold_date        || '',
    status:          editEvent?.status           || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.address) { setError('Address is required'); return; }
    setSaving(true);
    setError('');
    try {
      const url    = isEdit ? `/api/market-events/${editEvent.id}` : '/api/market-events/manual';
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(url, token, { method, body: JSON.stringify(form) });
      if (res.ok) {
        const data = await res.json();
        onAdded(data.contactCount);
        onClose();
      } else {
        const err = await res.json();
        setError(err.error || 'Failed to save event');
      }
    } catch (e) { setError('Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-title">{isEdit ? 'Edit Market Event' : 'Add Market Event'}</div>

        <label className="form-label">Address *</label>
        <input className="form-input" type="text" placeholder="3/89 Penshurst Street, North Willoughby" value={form.address} onChange={e => set('address', e.target.value)} />

        <label className="form-label">Type</label>
        <select className="form-input" value={form.type} onChange={e => set('type', e.target.value)}>
          <option value="sold">Sold</option>
          <option value="listing">Listing</option>
          <option value="price_change">Price Change</option>
        </select>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <div>
            <label className="form-label">Beds</label>
            <input className="form-input" type="number" min="0" max="10" placeholder="2" value={form.beds} onChange={e => set('beds', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Baths</label>
            <input className="form-input" type="number" min="0" max="10" placeholder="1" value={form.baths} onChange={e => set('baths', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Cars</label>
            <input className="form-input" type="number" min="0" max="10" placeholder="1" value={form.cars} onChange={e => set('cars', e.target.value)} />
          </div>
        </div>

        <label className="form-label">Property Type</label>
        <select className="form-input" value={form.property_type} onChange={e => set('property_type', e.target.value)}>
          <option value="House">House</option>
          <option value="Unit">Unit</option>
          <option value="Townhouse">Townhouse</option>
          <option value="Apartment">Apartment</option>
        </select>

        <label className="form-label">Price</label>
        <input className="form-input" type="text" placeholder="$1,250,000 or Undisclosed" value={form.price} onChange={e => set('price', e.target.value)} />

        {(form.type === 'sold' || isEdit) && (
          <>
            <label className="form-label">Confirmed Sale Price <span style={{ color: '#22c55e', fontSize: 10 }}>(verified — overrides scraped)</span></label>
            <input className="form-input" type="text" placeholder="$1,250,000" value={form.confirmed_price} onChange={e => set('confirmed_price', e.target.value)} />
            <label className="form-label">Sold Date</label>
            <input className="form-input" type="date" value={form.sold_date} onChange={e => set('sold_date', e.target.value)} />
          </>
        )}

        {isEdit && form.type !== 'sold' && (
          <>
            <label className="form-label">Status</label>
            <select className="form-input" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="sold">Sold</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </>
        )}

        {error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? (isEdit ? 'Saving…' : 'Adding…') : (isEdit ? 'Save Changes' : 'Add Event')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Market Page ────────────────────────────────────────────────────────────
function MarketPage({ token }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editEvent, setEditEvent] = useState(null);
  const [actionMsg, setActionMsg] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [daysFilter, setDaysFilter] = useState(30);
  const [propertyTypeFilter, setPropertyTypeFilter] = useState('all');
  const [sortOrder, setSortOrder] = useState('newest');

  const loadEvents = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      days: daysFilter,
      status: statusFilter,
      sort: sortOrder,
    });
    if (propertyTypeFilter && propertyTypeFilter !== 'all') {
      params.set('property_type', propertyTypeFilter);
    }
    apiFetch(`/api/market?${params.toString()}`, token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setEvents(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token, daysFilter, statusFilter, propertyTypeFilter, sortOrder]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const handleAdded = (contactCount) => {
    const verb = editEvent ? 'updated' : 'added';
    setActionMsg(`✅ Event ${verb} — ${contactCount} contacts flagged`);
    setEditEvent(null);
    loadEvents();
    setTimeout(() => setActionMsg(''), 5000);
  };

  const handleDelete = async (id) => {
    try {
      const res = await apiFetch(`/api/market-events/${id}`, token, { method: 'DELETE' });
      if (res.ok) {
        setEvents(prev => prev.filter(e => e.id !== id));
        setActionMsg('Event removed');
        setTimeout(() => setActionMsg(''), 3000);
      }
    } catch (_) {}
    setConfirmDeleteId(null);
  };

  const handleRefresh = async (ev) => {
    if (!ev.id || refreshingId) return;
    setRefreshingId(ev.id);
    try {
      const res = await apiFetch(`/api/market-events/${ev.id}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: ev.address, type: ev.type,
          beds: ev.beds, baths: ev.baths, cars: ev.cars,
          property_type: ev.property_type, price: ev.price,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setActionMsg(`✅ Contacts rebuilt — ${data.contactCount} contacts`);
        loadEvents();
        setTimeout(() => setActionMsg(''), 5000);
      }
    } catch (_) {}
    setRefreshingId(null);
  };

  const typeClass = {
    listing: 'type-listing',
    sold: 'type-sold',
    rental: 'type-rental',
    price_change: 'type-price_change'
  };

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  return (
    <div className="page-body">
      {/* Header row with Add Event button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        {actionMsg && (
          <span style={{ marginRight: 'auto', color: '#22c55e', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{actionMsg}</span>
        )}
        <button
          className="topup-btn"
          style={{ fontSize: 11, padding: '6px 14px', gap: 5, display: 'flex', alignItems: 'center' }}
          onClick={() => { setEditEvent(null); setShowAddModal(true); }}
        >
          <Plus size={12} /> Add Event
        </button>
      </div>

      {/* Status + time filter bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {['all', 'active', 'sold', 'withdrawn'].map(s => (
          <button key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: '4px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              fontFamily: 'var(--font-mono)', letterSpacing: 1, textTransform: 'uppercase',
              background: statusFilter === s ? 'var(--accent)' : 'var(--bg-card)',
              color:      statusFilter === s ? '#000' : 'var(--text-muted)',
              border:     `1px solid ${statusFilter === s ? 'var(--accent)' : 'var(--border)'}`,
              transition: 'all 0.15s',
            }}
          >{s}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {[14, 30, 90].map(d => (
            <button key={d}
              onClick={() => setDaysFilter(d)}
              style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                background: daysFilter === d ? 'var(--bg-raised)' : 'var(--bg-card)',
                color:      daysFilter === d ? 'var(--text)' : 'var(--text-muted)',
                border:     `1px solid ${daysFilter === d ? 'var(--border-light, var(--border))' : 'var(--border)'}`,
                transition: 'all 0.15s',
              }}
            >{d}d</button>
          ))}
        </div>
      </div>

      {/* Property type filter + sort bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['all','All'],['house','House'],['unit','Unit'],['townhouse','Townhouse']].map(([val, label]) => (
          <button key={val}
            onClick={() => setPropertyTypeFilter(val)}
            style={{
              padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              fontFamily: 'var(--font-mono)', letterSpacing: 0.5,
              background: propertyTypeFilter === val ? 'var(--bg-raised)' : 'var(--bg-card)',
              color:      propertyTypeFilter === val ? 'var(--gold, var(--accent))' : 'var(--text-muted)',
              border:     `1px solid ${propertyTypeFilter === val ? 'var(--gold, var(--accent))' : 'var(--border)'}`,
              transition: 'all 0.15s',
            }}
          >{label}</button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <select
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value)}
            style={{
              padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              background: 'var(--bg-card)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              outline: 'none',
            }}
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="price_high">Price High→Low</option>
            <option value="price_low">Price Low→High</option>
          </select>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><TrendingUp size={32} /></div>
          <div className="empty-state-title">No market events</div>
          <div className="empty-state-sub">Check back after the next pipeline run, or add one manually above</div>
        </div>
      ) : (
        <div className="event-list">
          {events.map((ev, i) => {
            const isManual     = true; // all events are editable
            const isDeleting   = confirmDeleteId === ev.id;
            const evDate       = ev.event_date || ev.detected_at;
            const fmtEvDate    = evDate ? new Date(evDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
            const evType       = ev.event_type || ev.type;
            const statusBadge  = ev.status && ev.status !== 'active' && ev.status !== evType ? ev.status.toUpperCase() : null;
            const displayPrice = ev.confirmed_price
              ? `${ev.confirmed_price} ✓`
              : (ev.price && ev.price !== 'Price Withheld' ? ev.price : ev.pf_estimate ? `Est. ${ev.pf_estimate}` : null);
            const isPriceWithheld = !ev.confirmed_price && (ev.price === 'Price Withheld' || ev.price_withheld);
            return (
              <div className="event-card" key={ev.id || i} style={{ animationDelay: `${i * 0.03}s` }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className={`event-type-badge ${typeClass[ev.event_type] || typeClass[ev.type] || 'type-listing'}`}>
                    {ev.event_type || ev.type || 'event'}
                  </span>
                  {statusBadge && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: statusBadge === 'WITHDRAWN' ? '#6b728022' : '#22c55e22', color: statusBadge === 'WITHDRAWN' ? '#9ca3af' : '#22c55e', border: `1px solid ${statusBadge === 'WITHDRAWN' ? '#6b7280' : '#22c55e'}`, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: 1 }}>
                      {statusBadge}
                    </span>
                  )}
                  {isPriceWithheld && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b', fontFamily: 'var(--font-mono)' }}>
                      PRICE WITHHELD
                    </span>
                  )}
                </div>
                <div className="event-body">
                  <div className="event-addr">{ev.address || '—'}</div>
                  <div className="event-detail">
                    {[(ev.beds && ev.beds !== '0' && ev.beds !== 0) && `${ev.beds}bd`,
                      (ev.baths && ev.baths !== '0' && ev.baths !== 0) && `${ev.baths}ba`,
                      (ev.cars && ev.cars !== '0' && ev.cars !== 0) && `${ev.cars}car`,
                      ev.property_type, displayPrice,
                      ev.days_on_market && `${ev.days_on_market}d on mkt`]
                      .filter(Boolean).join(' · ')}
                  </div>
                  {(ev.agent_name || ev.agency) && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                      {[ev.agent_name, ev.agency].filter(Boolean).join(' — ')}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                  <div className="event-meta" style={{ textAlign: 'right' }}>
                    <div>{timeAgo(ev.detected_at || ev.event_date)}</div>
                    {fmtEvDate && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{fmtEvDate}</div>}
                  </div>
                  {isManual && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {isDeleting ? (
                        <>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>Delete?</span>
                          <button onClick={() => handleDelete(ev.id)} style={{ background: '#ef4444', border: 'none', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}>Yes</button>
                          <button onClick={() => setConfirmDeleteId(null)} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}>No</button>
                        </>
                      ) : (
                        <>
                          {isPriceWithheld && ev.type === 'sold' && (
                            <button
                              onClick={() => { setEditEvent({ ...ev, status: ev.status || 'sold' }); setShowAddModal(true); }}
                              title="Record sale price"
                              style={{ background: '#f59e0b22', border: '1px solid #f59e0b', color: '#f59e0b', borderRadius: 4, padding: '2px 6px', fontSize: 9, cursor: 'pointer', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}
                            >$ Price</button>
                          )}
                          {refreshingId === ev.id ? (
                            <span style={{ background: 'none', border: 'none', color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center' }}>
                              <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                            </span>
                          ) : (
                            <button onClick={() => handleRefresh(ev)} title="Rebuild contact list" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><RefreshCw size={12} /></button>
                          )}
                          <button onClick={() => { setEditEvent(ev); setShowAddModal(true); }} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Pencil size={12} /></button>
                          <button onClick={() => setConfirmDeleteId(ev.id)} title="Delete" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Trash2 size={12} /></button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAddModal && (
        <AddEventModal
          token={token}
          onClose={() => { setShowAddModal(false); setEditEvent(null); }}
          onAdded={handleAdded}
          editEvent={editEvent}
        />
      )}
    </div>
  );
}

// ── Buyers CRM ─────────────────────────────────────────────────────────────
function BuyerModal({ token, buyer, onSaved, onClose }) {
  const isEdit = !!buyer;
  const [name, setName] = React.useState(buyer?.name || '');
  const [mobile, setMobile] = React.useState(buyer?.mobile || '');
  const [email, setEmail] = React.useState(buyer?.email || '');
  const [priceMin, setPriceMin] = React.useState(buyer?.price_min ? String(buyer.price_min) : '');
  const [priceMax, setPriceMax] = React.useState(buyer?.price_max ? String(buyer.price_max) : '');
  const [bedsMin, setBedsMin] = React.useState(buyer?.beds_min ? String(buyer.beds_min) : '');
  const [bedsMax, setBedsMax] = React.useState(buyer?.beds_max ? String(buyer.beds_max) : '');
  const [propertyType, setPropertyType] = React.useState(buyer?.property_type || 'any');
  const [suburbsInput, setSuburbsInput] = React.useState(
    Array.isArray(buyer?.suburbs_wanted) ? buyer.suburbs_wanted.join(', ') : ''
  );
  const [timeframe, setTimeframe] = React.useState(buyer?.timeframe || '');
  const [features, setFeatures] = React.useState(buyer?.features || '');
  const [notes, setNotes] = React.useState(buyer?.notes || '');
  const [status, setStatus] = React.useState(buyer?.status || 'active');
  const [source, setSource] = React.useState(buyer?.source || '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    const suburbs_wanted = suburbsInput.split(',').map(s => s.trim()).filter(Boolean);
    const body = {
      name: name.trim(),
      mobile: mobile.trim() || null,
      email: email.trim() || null,
      price_min: priceMin ? parseInt(priceMin.replace(/[^0-9]/g,'')) : null,
      price_max: priceMax ? parseInt(priceMax.replace(/[^0-9]/g,'')) : null,
      beds_min: bedsMin ? parseInt(bedsMin) : null,
      beds_max: bedsMax ? parseInt(bedsMax) : null,
      property_type: propertyType,
      suburbs_wanted,
      timeframe: timeframe || null,
      features: features.trim() || null,
      notes: notes.trim() || null,
      status,
      source: source || null,
    };
    const path = isEdit ? `/api/buyer-profiles/${buyer.id}` : '/api/buyer-profiles';
    const method = isEdit ? 'PATCH' : 'POST';
    try {
      const res = await apiFetch(path, token, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }));
        setError(err.error || 'Save failed');
        setSaving(false);
        return;
      }
      const data = await res.json();
      setSaving(false);
      onSaved(isEdit ? data.buyer : data.buyer);
    } catch (e) {
      setError('Network error');
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{isEdit ? 'Edit Buyer' : 'Add New Buyer'}</span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="modal-grid-2">
            <div className="modal-field">
              <label>Name *</label>
              <input className="modal-input" value={name} onChange={e => setName(e.target.value)} placeholder="Tom & Sarah Chen" />
            </div>
            <div className="modal-field">
              <label>Mobile</label>
              <input className="modal-input" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="0400 000 000" />
            </div>
          </div>
          <div className="modal-grid-2">
            <div className="modal-field">
              <label>Price Min ($)</label>
              <input className="modal-input" value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="1800000" />
            </div>
            <div className="modal-field">
              <label>Price Max ($)</label>
              <input className="modal-input" value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="2100000" />
            </div>
          </div>
          <div className="modal-grid-3">
            <div className="modal-field">
              <label>Beds Min</label>
              <select className="modal-input" value={bedsMin} onChange={e => setBedsMin(e.target.value)}>
                <option value="">Any</option>
                {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="modal-field">
              <label>Beds Max</label>
              <select className="modal-input" value={bedsMax} onChange={e => setBedsMax(e.target.value)}>
                <option value="">Any</option>
                {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="modal-field">
              <label>Property Type</label>
              <select className="modal-input" value={propertyType} onChange={e => setPropertyType(e.target.value)}>
                <option value="any">Any</option>
                <option value="house">House</option>
                <option value="unit">Unit</option>
                <option value="townhouse">Townhouse</option>
              </select>
            </div>
          </div>
          <div className="modal-field">
            <label>Suburbs (comma-separated)</label>
            <input className="modal-input" value={suburbsInput} onChange={e => setSuburbsInput(e.target.value)}
              placeholder="Willoughby, North Willoughby, Naremburn" />
          </div>
          <div className="modal-grid-2">
            <div className="modal-field">
              <label>Timeframe</label>
              <select className="modal-input" value={timeframe} onChange={e => setTimeframe(e.target.value)}>
                <option value="">Not set</option>
                <option value="3months">3 months</option>
                <option value="6months">6 months</option>
                <option value="12months">12 months</option>
                <option value="flexible">Flexible</option>
              </select>
            </div>
            <div className="modal-field">
              <label>Status</label>
              <select className="modal-input" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="purchased">Purchased</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>
          <div className="modal-field">
            <label>Must-Have Features</label>
            <input className="modal-input" value={features} onChange={e => setFeatures(e.target.value)}
              placeholder="Garage, quiet street, pool, land size..." />
          </div>
          <div className="modal-field">
            <label>Notes</label>
            <textarea className="modal-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Any additional notes about this buyer..." />
          </div>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Add Buyer')}
          </button>
        </div>
      </div>
    </div>
  );
}

function BuyerCard({ buyer, token, onEdited, onDelete }) {
  const [showOutcome, setShowOutcome] = React.useState(false);
  const [showEdit, setShowEdit] = React.useState(false);
  const [logging, setLogging] = React.useState(false);
  const [lastOutcome, setLastOutcome] = React.useState(buyer.last_outcome);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const suburbsWanted = Array.isArray(buyer.suburbs_wanted) ? buyer.suburbs_wanted : [];
  const budgetStr = (buyer.price_min || buyer.price_max)
    ? `$${buyer.price_min ? (buyer.price_min/1e6).toFixed(1) + 'M' : '?'} – $${buyer.price_max ? (buyer.price_max/1e6).toFixed(1) + 'M' : '?'}`
    : null;
  const bedsStr = buyer.beds_min ? `${buyer.beds_min}${buyer.beds_max ? '–' + buyer.beds_max : '+'}BR` : null;

  const statusColors = { active: '#22c55e', paused: 'var(--gold)', purchased: '#3b82f6', archived: 'var(--text-muted)' };

  const logOutcome = async (outcome) => {
    setLogging(true);
    try {
      const res = await apiFetch(`/api/buyer-profiles/${buyer.id}/log-call`, token, {
        method: 'POST', body: JSON.stringify({ outcome })
      });
      if (res.ok) {
        setLastOutcome(outcome);
        setShowOutcome(false);
      }
    } catch (err) {
      console.error('log outcome failed', err);
    } finally {
      setLogging(false);
    }
  };

  return (
    <div className="buyer-card">
      <div className="buyer-card-header">
        <div className="buyer-card-info">
          <div className="buyer-card-name">{buyer.name}</div>
          <div className="buyer-card-meta">
            {budgetStr && <span className="buyer-meta-chip">{budgetStr}</span>}
            {bedsStr && <span className="buyer-meta-chip">{bedsStr}</span>}
            {buyer.property_type && buyer.property_type !== 'any' && (
              <span className="buyer-meta-chip">{buyer.property_type}</span>
            )}
            {suburbsWanted.length > 0 && (
              <span className="buyer-meta-chip buyer-meta-chip--suburbs">{suburbsWanted.join(', ')}</span>
            )}
          </div>
        </div>
        <span className="buyer-status-badge" style={{ color: statusColors[buyer.status] || 'var(--muted)' }}>
          {buyer.status}
        </span>
      </div>

      {buyer.timeframe && (
        <div className="buyer-timeframe">Timeframe: {buyer.timeframe}</div>
      )}
      {buyer.features && (
        <div className="buyer-features">{buyer.features}</div>
      )}
      {buyer.notes && (
        <div className="buyer-notes">{buyer.notes}</div>
      )}

      <div className="buyer-card-footer">
        {lastOutcome && (
          <span className={`outcome-chip chip-${lastOutcome}`}>
            {OUTCOME_LABELS[lastOutcome] || lastOutcome}
          </span>
        )}
        {buyer.recent_match_count > 0 && (
          <span className="buyer-match-badge">{buyer.recent_match_count} match{buyer.recent_match_count > 1 ? 'es' : ''}</span>
        )}
        {buyer.last_contacted_at && (
          <span className="buyer-last-contact">Last: {timeAgo(buyer.last_contacted_at)}</span>
        )}
        <div className="buyer-card-actions">
          {buyer.mobile && (
            <a className="icon-btn" href={`tel:${buyer.mobile}`} title="Call"><Phone size={13} /></a>
          )}
          <button className="icon-btn" onClick={() => setShowOutcome(o => !o)} disabled={logging} title="Log call">
            <PhoneCall size={13} />
          </button>
          <button className="icon-btn" onClick={() => setShowEdit(true)} title="Edit"><Pencil size={13} /></button>
          {deleteConfirm ? (
            <>
              <button className="icon-btn icon-btn--danger" onClick={() => { onDelete(); setDeleteConfirm(false); }}>Yes</button>
              <button className="icon-btn" onClick={() => setDeleteConfirm(false)}>No</button>
            </>
          ) : (
            <button className="icon-btn icon-btn--danger" onClick={() => setDeleteConfirm(true)} title="Archive buyer">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {showOutcome && (
        <div className="buyer-outcome-row">
          {['connected','left_message','no_answer','not_interested','callback_requested'].map(o => (
            <button key={o} className={`outcome-btn outcome-btn--${o}`} onClick={() => logOutcome(o)} disabled={logging}>
              {OUTCOME_LABELS[o] || o}
            </button>
          ))}
        </div>
      )}

      {showEdit && (
        <BuyerModal
          token={token}
          buyer={buyer}
          onSaved={(updated) => { onEdited(updated); setShowEdit(false); }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  );
}

function BuyersPage({ token }) {
  const [view, setView] = React.useState('directory');
  const [buyers, setBuyers] = React.useState([]);
  const [matches, setMatches] = React.useState([]);
  const [statusFilter, setStatusFilter] = React.useState('active');
  const [loading, setLoading] = React.useState(true);
  const [showAddModal, setShowAddModal] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState(null);

  const loadBuyers = React.useCallback(() => {
    setLoading(true);
    apiFetch(`/api/buyer-profiles?status=${statusFilter}`, token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setBuyers(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token, statusFilter]);

  const loadMatches = React.useCallback(() => {
    apiFetch('/api/buyer-profiles/matches/recent', token)
      .then(r => r.ok ? r.json() : [])
      .then(data => setMatches(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [token]);

  React.useEffect(() => {
    if (view === 'directory') loadBuyers();
    else loadMatches();
  }, [view, loadBuyers, loadMatches]);

  const handleDelete = React.useCallback(async (id) => {
    const res = await apiFetch(`/api/buyer-profiles/${id}`, token, { method: 'DELETE' });
    if (res.ok) setBuyers(prev => prev.filter(b => b.id !== id));
  }, [token]);

  return (
    <div className="buyers-crm-page">
      {/* Toolbar */}
      <div className="buyers-toolbar">
        <div className="buyers-view-toggle">
          <button className={`view-tab${view === 'directory' ? ' view-tab--active' : ''}`} onClick={() => setView('directory')}>
            Buyer Directory
            {buyers.length > 0 && <span className="view-tab-count">{buyers.length}</span>}
          </button>
          <button className={`view-tab${view === 'matches' ? ' view-tab--active' : ''}`} onClick={() => setView('matches')}>
            Recent Matches
            {matches.length > 0 && <span className="view-tab-count match-count">{matches.length}</span>}
          </button>
        </div>
        {view === 'directory' && (
          <>
            <div className="buyers-status-filter">
              {['active','paused','purchased','all'].map(s => (
                <button key={s} className={`status-filter-btn${statusFilter === s ? ' active' : ''}`}
                  onClick={() => setStatusFilter(s)}>
                  {s}
                </button>
              ))}
            </div>
            <button className="buyers-add-btn" onClick={() => { setEditTarget(null); setShowAddModal(true); }}>
              <Plus size={13} /> Add Buyer
            </button>
          </>
        )}
      </div>

      {/* Directory view */}
      {view === 'directory' && (
        <div className="buyers-directory">
          {loading && <div className="loading-state">Loading buyers...</div>}
          {!loading && buyers.length === 0 && (
            <div className="empty-state">
              No {statusFilter !== 'all' ? statusFilter : ''} buyers yet.{' '}
              <button className="link-btn" onClick={() => setShowAddModal(true)}>Add the first one.</button>
            </div>
          )}
          {buyers.map(buyer => (
            <BuyerCard
              key={buyer.id}
              buyer={buyer}
              token={token}
              onEdited={(updated) => setBuyers(prev => prev.map(b => b.id === updated.id ? updated : b))}
              onDelete={() => handleDelete(buyer.id)}
            />
          ))}
        </div>
      )}

      {/* Matches view */}
      {view === 'matches' && (
        <div className="buyers-matches">
          {matches.length === 0 && (
            <div className="empty-state">No recent buyer matches (last 30 days).</div>
          )}
          {matches.map(m => (
            <div key={m.id} className="match-card">
              <div className="match-card-header">
                <span className="match-card-buyer">{m.buyer_name}</span>
                {m.buyer_mobile && (
                  <a href={`tel:${m.buyer_mobile}`} className="icon-btn match-phone-btn">
                    <Phone size={12} />
                  </a>
                )}
              </div>
              <div className="match-card-addr">{m.event_address}</div>
              <div className="match-card-meta">
                <span>{timeAgo(m.matched_at)}</span>
                {m.notified_telegram === 1 && <span className="match-notified-tag">Telegram sent</span>}
                {m.reminder_created === 1 && <span className="match-reminder-tag">Reminder created</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit modal */}
      {(showAddModal || editTarget) && (
        <BuyerModal
          token={token}
          buyer={editTarget}
          onSaved={(saved) => {
            setShowAddModal(false);
            setEditTarget(null);
            loadBuyers();
          }}
          onClose={() => { setShowAddModal(false); setEditTarget(null); }}
        />
      )}
    </div>
  );
}

// ── Reminders Page ─────────────────────────────────────────────────────────
function WeekStrip({ reminders }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const start = d.getTime();
    const end = start + 86400000;
    const count = reminders.filter(r => {
      if (!r.fire_at) return false;
      const t = new Date(r.fire_at).getTime();
      return t >= start && t < end;
    }).length;
    return { date: d, count, isToday: d.getTime() === today.getTime() };
  });

  const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function scrollToGroup(date) {
    const now = new Date();
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const tomorrowEnd = new Date(todayEnd); tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
    const weekEnd = new Date(todayEnd); weekEnd.setDate(weekEnd.getDate() + 7);
    let groupId;
    if (date < now)               groupId = 'rem-group-overdue';
    else if (date <= todayEnd)    groupId = 'rem-group-today';
    else if (date <= tomorrowEnd) groupId = 'rem-group-tomorrow';
    else if (date <= weekEnd)     groupId = 'rem-group-this-week';
    else                          groupId = 'rem-group-later';
    const el = document.getElementById(groupId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="week-strip">
      {days.map((d, i) => (
        <div
          key={i}
          className={`week-day${d.isToday ? ' week-day--today' : ''}`}
          onClick={() => scrollToGroup(d.date)}
        >
          <div className="week-day-name">{DAY_ABBR[i]}</div>
          <div className="week-day-num">{d.date.getDate()}</div>
          <div className="week-day-dots">
            {Array.from({ length: Math.min(d.count, 3) }, (_, j) => (
              <div key={j} className="week-dot" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function urgencyClass(r) {
  if (!r.fire_at) return 'task';
  const t = new Date(r.fire_at);
  if (t < new Date()) return 'overdue';
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  if (t <= todayEnd) return 'today';
  return 'later';
}

function QuickAddBar({ token, onParsed }) {
  const [text, setText]       = React.useState('');
  const [parsing, setParsing] = React.useState(false);
  const [error, setError]     = React.useState('');

  const handle = async () => {
    const trimmed = text.trim();
    if (!trimmed || parsing) return;
    setParsing(true);
    setError('');
    try {
      const res = await apiFetch('/api/reminders/parse-nl', token, {
        method: 'POST',
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || 'Parse failed — try again');
        return;
      }
      const parsed = await res.json();
      setText('');
      onParsed(parsed);
    } catch (_) {
      setError('Network error — try again');
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="quick-add-bar">
      <div className="quick-add-inner">
        <input
          className="quick-add-input"
          placeholder='Quick add... "call John next Tuesday 10am re appraisal"'
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handle()}
          disabled={parsing}
        />
        <button
          className={`quick-add-btn${parsing ? ' quick-add-btn--loading' : ''}`}
          onClick={handle}
          disabled={parsing || !text.trim()}
          title="Parse with AI"
        >
          {parsing
            ? <RefreshCw size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
            : <Wand2 size={14} />
          }
        </button>
      </div>
      {error && <div className="quick-add-error">{error}</div>}
    </div>
  );
}

// ── Reminder Detail Modal ─────────────────────────────────────────────────────
function ReminderDetailModal({ reminder, token, onClose }) {
  const [contact, setContact] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error,   setError]   = React.useState(null);

  React.useEffect(() => {
    if (!reminder.contact_id) return;
    setLoading(true);
    apiFetch(`/api/contacts/${reminder.contact_id}`, token)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Not found')))
      .then(data => { setContact(data.contact); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [reminder.contact_id, token]);

  const fmtFireAt = (ts) => {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--wide rem-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="rem-detail-header">
          <div className="rem-detail-meta">
            {reminder.priority === 'high' && <span className="priority-badge">HIGH</span>}
            {reminder.fire_at && (
              <span className="rem-detail-date">{fmtFireAt(reminder.fire_at)}</span>
            )}
            {!reminder.fire_at && <span className="rem-detail-date" style={{ color: 'var(--text-muted)' }}>Task — no due date</span>}
          </div>
          <button className="icon-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>
            <X size={16} />
          </button>
        </div>

        <div className="rem-detail-note">{reminder.note}</div>

        <div className="rem-detail-contact-section">
          {!reminder.contact_id && (
            <div className="rem-detail-no-contact">No linked contact</div>
          )}
          {reminder.contact_id && loading && (
            <div className="rem-detail-no-contact">Loading contact...</div>
          )}
          {reminder.contact_id && error && !contact && (
            <div className="rem-detail-no-contact" style={{ color: 'var(--outcome-notint)' }}>
              Could not load contact details
            </div>
          )}
          {reminder.contact_id && !loading && contact && (
            <ContactCard
              contact={contact}
              token={token}
              context="search"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RemindersPage({ token, onReminderCountChange }) {
  const [reminders, setReminders] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showAddModal, setShowAddModal] = React.useState(false);
  const [addIsTask, setAddIsTask] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState(null);
  const [quickValues, setQuickValues] = React.useState(null);
  const [detailTarget, setDetailTarget] = React.useState(null);

  const load = React.useCallback(() => {
    setLoading(true);
    apiFetch('/api/reminders/upcoming', token)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setReminders(Array.isArray(data) ? data : []);
        setLoading(false);
        if (onReminderCountChange) onReminderCountChange(
          (Array.isArray(data) ? data : []).filter(r => r.fire_at && !r.is_task).length
        );
      })
      .catch(() => setLoading(false));
  }, [token]);

  React.useEffect(() => { load(); }, [load]);

  const handleComplete = React.useCallback((id) => {
    apiFetch(`/api/reminders/${id}/complete`, token, { method: 'POST' })
      .then(r => {
        if (r.ok) {
          setReminders(prev => {
            const next = prev.filter(r => r.id !== id);
            if (onReminderCountChange) onReminderCountChange(next.filter(r => r.fire_at && !r.is_task).length);
            return next;
          });
          setDetailTarget(null);
        }
      });
  }, [token, onReminderCountChange]);

  const handleDelete = React.useCallback((id) => {
    apiFetch(`/api/reminders/${id}`, token, { method: 'DELETE' })
      .then(r => {
        if (r.ok) {
          setReminders(prev => {
            const next = prev.filter(r => r.id !== id);
            if (onReminderCountChange) onReminderCountChange(next.filter(r => r.fire_at && !r.is_task).length);
            return next;
          });
          setDeleteConfirmId(null);
          setDetailTarget(null);
        }
      });
  }, [token, onReminderCountChange]);

  const handleSaved = React.useCallback((savedReminder, isEdit) => {
    setShowAddModal(false);
    setEditTarget(null);
    setQuickValues(null);
    load();
  }, [load]);

  const handleQuickParsed = React.useCallback((parsed) => {
    setQuickValues(parsed);
    setAddIsTask(!!parsed.is_task);
    setShowAddModal(true);
  }, []);

  // Group reminders by time bucket
  function groupReminders(items) {
    const now = new Date();
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const tomorrowEnd = new Date(todayEnd); tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
    const weekEnd = new Date(todayEnd); weekEnd.setDate(weekEnd.getDate() + 7);

    const groups = { overdue: [], today: [], tomorrow: [], this_week: [], later: [], no_date: [] };
    for (const r of items) {
      if (!r.fire_at) { groups.no_date.push(r); continue; }
      const t = new Date(r.fire_at);
      if (t < now) groups.overdue.push(r);
      else if (t <= todayEnd) groups.today.push(r);
      else if (t <= tomorrowEnd) groups.tomorrow.push(r);
      else if (t <= weekEnd) groups.this_week.push(r);
      else groups.later.push(r);
    }
    return groups;
  }

  const groups = groupReminders(reminders);
  const totalCount = reminders.length;

  const GROUP_CONFIG = [
    { key: 'overdue',   label: 'OVERDUE',   color: 'var(--outcome-notint)' },
    { key: 'today',     label: 'TODAY',     color: 'var(--gold)' },
    { key: 'tomorrow',  label: 'TOMORROW',  color: 'var(--text-primary)' },
    { key: 'this_week', label: 'THIS WEEK', color: 'var(--text-primary)' },
    { key: 'later',     label: 'LATER',     color: 'var(--text-muted)' },
    { key: 'no_date',   label: 'TASKS',     color: 'var(--text-muted)' },
  ];

  return (
    <div className="reminders-page">
      <div className="reminders-toolbar">
        <button className="rem-add-btn rem-add-task" onClick={() => { setEditTarget(null); setAddIsTask(true); setShowAddModal(true); }}>
          <Plus size={13} /> Add Task
        </button>
        <button className="rem-add-btn rem-add-reminder" onClick={() => { setEditTarget(null); setAddIsTask(false); setShowAddModal(true); }}>
          <Bell size={13} /> Add Reminder
        </button>
        <button className="rem-refresh-btn" onClick={load} title="Refresh">
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
        <span className="rem-count">{totalCount} pending</span>
      </div>

      <WeekStrip reminders={reminders} />

      <QuickAddBar token={token} onParsed={handleQuickParsed} />

      {loading && <div className="loading-msg">Loading...</div>}

      {!loading && totalCount === 0 && (
        <div className="empty-state">No pending reminders or tasks.</div>
      )}

      {GROUP_CONFIG.map(({ key, label, color }) => {
        const items = groups[key];
        if (items.length === 0) return null;
        return (
          <div key={key} id={`rem-group-${key.replace('_', '-')}`} className="rem-group">
            <div className="rem-group-header" style={{ color }}>
              {label} <span className="rem-group-count">{items.length}</span>
            </div>
            {items.map(r => (
              <div key={r.id} className={`rem-item rem-item--${urgencyClass(r)}${r.is_task ? ' rem-item--task' : ''}${r.priority === 'high' ? ' rem-item--high' : ''}`} onClick={() => setDetailTarget(r)} style={{ cursor: 'pointer' }}>
                <button className="rem-check-btn" onClick={e => { e.stopPropagation(); handleComplete(r.id); }} title="Mark complete">
                  <div className="rem-check-circle" />
                </button>
                <div className="rem-item-body">
                  {r.contact_name && r.contact_name !== 'Manual Task' && r.contact_name !== 'Task' && (
                    <div className="rem-item-contact">{r.contact_name}</div>
                  )}
                  <div className="rem-item-note">{r.note}</div>
                  {r.contact_mobile && (
                    <a href={`tel:${r.contact_mobile}`} className="rem-item-mobile" onClick={e => e.stopPropagation()}>
                      <Phone size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> {r.contact_mobile}
                    </a>
                  )}
                  <div className="rem-item-footer">
                    {r.priority === 'high' && <span className="priority-badge">HIGH</span>}
                    {r.fire_at && (
                      <span className="rem-item-time">{fmtDate(r.fire_at)} {fmtTime(r.fire_at)}</span>
                    )}
                    <div className="rem-item-actions">
                      <button className="icon-btn" onClick={e => { e.stopPropagation(); setEditTarget(r); }} title="Edit">
                        <Pencil size={12} />
                      </button>
                      {deleteConfirmId === r.id ? (
                        <>
                          <button className="icon-btn icon-btn--danger" onClick={e => { e.stopPropagation(); handleDelete(r.id); }}>Yes</button>
                          <button className="icon-btn" onClick={e => { e.stopPropagation(); setDeleteConfirmId(null); }}>No</button>
                        </>
                      ) : (
                        <button className="icon-btn icon-btn--danger" onClick={e => { e.stopPropagation(); setDeleteConfirmId(r.id); }} title="Delete">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {detailTarget && (
        <ReminderDetailModal
          reminder={detailTarget}
          token={token}
          onClose={() => setDetailTarget(null)}
        />
      )}

      {(showAddModal || editTarget) && (
        <AddEditReminderModal
          token={token}
          reminder={editTarget}
          initialValues={!editTarget ? quickValues : null}
          defaultIsTask={addIsTask}
          onSaved={handleSaved}
          onClose={() => {
            setShowAddModal(false);
            setEditTarget(null);
            setQuickValues(null);
          }}
        />
      )}
    </div>
  );
}

// ── AddEditReminderModal ────────────────────────────────────────────────────
function AddEditReminderModal({ token, reminder, initialValues = null, defaultIsTask, onSaved, onClose }) {
  const isEdit = !!reminder;
  const init   = isEdit ? reminder : (initialValues || {});
  const [isTask,        setIsTask]        = React.useState(isEdit ? (reminder.is_task === 1) : (init.is_task || defaultIsTask || false));
  const [note,          setNote]          = React.useState(init.note || '');
  const [contactName,   setContactName]   = React.useState(init.contact_name || '');
  const [contactMobile, setContactMobile] = React.useState(init.contact_mobile || '');
  const [fireAt,        setFireAt]        = React.useState(() => {
    if (init.fire_at) return init.fire_at.slice(0, 16);
    const pad = n => String(n).padStart(2, '0');
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T09:00`;
  });
  const [duration,      setDuration]      = React.useState(init.duration_minutes || 30);
  const [priority,      setPriority]      = React.useState(init.priority || 'normal');
  const [icalTitle,     setIcalTitle]     = React.useState(init.ical_title || null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const handleSave = async () => {
    if (!note.trim()) { setError('Note is required'); return; }
    if (!isTask && !fireAt) { setError('Date/time is required for reminders'); return; }
    setSaving(true);
    setError('');
    const body = {
      note: note.trim(),
      contact_name: contactName.trim() || 'Manual Task',
      contact_mobile: contactMobile.trim() || null,
      fire_at: isTask ? (fireAt || undefined) : fireAt,
      is_task: isTask ? 1 : 0,
      duration_minutes: isTask ? undefined : duration,
      priority,
      ical_title: icalTitle || null,
      ...(init.contact_id ? { contact_id: init.contact_id } : {}),
    };
    const path = isEdit ? `/api/reminders/${reminder.id}` : '/api/reminders';
    const method = isEdit ? 'PATCH' : 'POST';
    try {
      const res = await apiFetch(path, token, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || 'Save failed');
        setSaving(false);
        return;
      }
      const data = await res.json();
      onSaved(isEdit ? data.reminder : data, isEdit);
    } catch (e) {
      setError('Network error');
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{isEdit ? 'Edit' : (isTask ? 'New Task' : 'New Reminder')}</span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="modal-field">
            <label>Type</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`topup-btn${!isTask ? ' topup-btn--active' : ''}`}
                onClick={() => setIsTask(false)}
              >Reminder</button>
              <button
                className={`topup-btn${isTask ? ' topup-btn--active' : ''}`}
                onClick={() => setIsTask(true)}
              >Task</button>
            </div>
          </div>
          <div className="modal-field">
            <label>Note *</label>
            <textarea
              className="modal-input"
              rows={2}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What needs to happen..."
            />
          </div>
          <div className="modal-field">
            <label>Contact Name</label>
            <input
              className="modal-input"
              value={contactName}
              onChange={e => setContactName(e.target.value)}
              placeholder="Who is this for? (optional)"
            />
          </div>
          <div className="modal-field">
            <label>Mobile</label>
            <input
              className="modal-input"
              value={contactMobile}
              onChange={e => setContactMobile(e.target.value)}
              placeholder="0400 000 000"
            />
          </div>
          <div className="modal-field">
            <label>{isTask ? 'Due Date (optional)' : 'Date & Time *'}</label>
            <input
              className="modal-input"
              type="datetime-local"
              value={fireAt}
              onChange={e => setFireAt(e.target.value)}
            />
          </div>
          {!isTask && (
            <div className="modal-field">
              <label>Duration</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[15, 30, 60, 120].map(m => (
                  <button
                    key={m}
                    className={`topup-btn${duration === m ? ' topup-btn--active' : ''}`}
                    style={{ flex: 1 }}
                    onClick={() => setDuration(m)}
                  >
                    {m < 60 ? `${m}m` : `${m / 60}hr`}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="modal-field">
            <label>Priority</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {['low', 'normal', 'high'].map(p => (
                <button
                  key={p}
                  className={`topup-btn${priority === p ? ' topup-btn--active' : ''}`}
                  style={{ flex: 1, textTransform: 'capitalize' }}
                  onClick={() => setPriority(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Add')}
          </button>
        </div>
      </div>
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

// ── Search Card ────────────────────────────────────────────────────────────
function SearchCard({ prop, token, onAddedToPlan, onDeleted, onEdited }) {
  const [addState, setAddState]         = useState(null); // null | 'adding' | 'added' | 'already'
  const [showOutcome, setShowOutcome]   = useState(false);
  const [logging, setLogging]           = useState(false);
  const [loggedOutcome, setLoggedOutcome] = useState(prop.last_outcome || null);
  const [copied, setCopied]             = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [reminderDays, setReminderDays] = useState(1);
  const [reminderNote, setReminderNote] = useState('');
  const [savingReminder, setSavingReminder] = useState(false);
  const [showHistory, setShowHistory]   = useState(false);
  const [history, setHistory]           = useState(null); // null = not yet loaded
  const [showEdit,  setShowEdit]        = useState(false);
  const [showNotes, setShowNotes]       = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const contactId   = prop.crm_contact_id;
  const displayName = prop.crm_name || prop.owner_name || 'Unknown Owner';
  const phone       = prop.contact_mobile;

  const handleAddToPlan = useCallback(async () => {
    if (!contactId) return;
    setAddState('adding');
    try {
      const res = await apiFetch('/api/plan/add', token, {
        method: 'POST',
        body: JSON.stringify({ contact_id: contactId })
      });
      if (res.ok) {
        const data = await res.json();
        setAddState(data.added ? 'added' : 'already');
        if (onAddedToPlan) onAddedToPlan(prop.property_id);
      }
    } catch (err) { setAddState(null); }
  }, [contactId, token, prop.property_id, onAddedToPlan]);

  const logOutcome = useCallback(async (outcome) => {
    if (!contactId) return;
    setLogging(true);
    try {
      await apiFetch('/api/log-call', token, {
        method: 'POST',
        body: JSON.stringify({ contact_id: contactId, outcome })
      });
      setLoggedOutcome(outcome);
      setShowOutcome(false);
    } catch (err) { console.error('Log failed', err); }
    finally { setLogging(false); }
  }, [contactId, token]);

  const handleDelete = useCallback(async () => {
    if (!contactId) return;
    const res = await apiFetch(`/api/contacts/${contactId}`, token, { method: 'DELETE' });
    if (res.ok) { onDeleted && onDeleted(prop); }
  }, [contactId, token, onDeleted, prop]);

  const copyPhone = useCallback(() => {
    if (!phone) return;
    navigator.clipboard.writeText(phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [phone]);

  const saveReminder = useCallback(async () => {
    if (!contactId) return;
    setSavingReminder(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + reminderDays);
      d.setHours(9, 0, 0, 0);
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id:     contactId,
          contact_name:   prop.crm_name || prop.owner_name,
          contact_mobile: phone,
          note:           reminderNote || 'Follow up',
          fire_at:        d.toISOString()
        })
      });
      setShowReminder(false);
      setReminderNote('');
    } catch (err) { console.error('save reminder failed', err); }
    finally { setSavingReminder(false); }
  }, [contactId, token, reminderDays, reminderNote, phone, prop.crm_name, prop.owner_name]);

  const loadHistory = useCallback(async () => {
    if (!contactId || history !== null) return;
    try {
      const res = await apiFetch(`/api/contacts/${contactId}/history`, token);
      if (res.ok) setHistory(await res.json());
      else setHistory([]);
    } catch { setHistory([]); }
  }, [contactId, token, history]);

  const toggleHistory = useCallback(() => {
    setShowHistory(h => !h);
    loadHistory();
  }, [loadHistory]);

  const scoreColor = prop.propensity_score >= 45 ? 'var(--tier-high)' : prop.propensity_score >= 20 ? 'var(--tier-med)' : 'var(--text-muted)';

  return (
    <div className={`search-card${prop.do_not_call ? ' search-card--dnc' : ''}`}>
      {/* Property line */}
      <div className="search-card-prop-row">
        <span className="search-card-address">{prop.address}</span>
        <div className="search-card-chips">
          {(prop.beds || prop.baths) && (
            <span className="search-chip search-chip--prop">
              {[prop.beds && `${prop.beds}bd`, prop.baths && `${prop.baths}ba`].filter(Boolean).join(' ')}
            </span>
          )}
          {prop.property_type && (
            <span className={`search-chip search-chip--type search-chip--${(prop.property_type || '').toLowerCase()}`}>
              {prop.property_type}
            </span>
          )}
        </div>
      </div>

      {/* Owner + phone line */}
      <div className="search-card-owner-row">
        <span className="search-card-owner">{displayName}</span>
        {prop.do_not_call && <span className="search-chip search-chip--dnc">DNCR</span>}
        {phone && (
          <a className="search-card-phone" href={`tel:${phone}`}>
            <Phone size={10} />{phone}
          </a>
        )}
        {prop.propensity_score > 0 && (
          <span className="search-chip search-chip--score" style={{ color: scoreColor, borderColor: scoreColor }}>
            {fmtScore(prop.propensity_score)}
          </span>
        )}
      </div>

      {/* Last interaction preview */}
      {prop.last_called_at && (
        <div className="search-card-last-row">
          <span className="search-last-label">Last:</span>
          <span className={`search-last-outcome chip-${prop.last_outcome}`}>{OUTCOME_LABELS[prop.last_outcome] || prop.last_outcome}</span>
          <span className="search-last-date">{timeAgo(prop.last_called_at)}</span>
          {prop.last_note && <span className="search-last-note">{prop.last_note}</span>}
          {contactId && (
            <button className="search-last-history" onClick={toggleHistory}>
              {showHistory ? 'Hide' : 'History'}
            </button>
          )}
        </div>
      )}
      {!prop.last_called_at && contactId && (
        <div className="search-card-last-row search-card-last-row--never">
          <span className="search-last-label">Never contacted</span>
        </div>
      )}

      {/* Call history (expandable) */}
      {showHistory && (
        <div className="search-card-history">
          {history === null && <span className="search-history-loading">Loading…</span>}
          {history && history.length === 0 && <span className="search-history-empty">No call history</span>}
          {history && history.map((h, i) => (
            <div key={i} className="search-history-row">
              <span className={`search-last-outcome chip-${h.outcome}`}>{OUTCOME_LABELS[h.outcome] || h.outcome}</span>
              <span className="search-last-date">{fmtDate(h.called_at)}</span>
              {h.notes && <span className="search-last-note">{h.notes}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Action row */}
      <div className="search-card-actions">
        {phone && !prop.do_not_call && (
          <a className="search-action-btn search-action--call" href={`tel:${phone}`}>
            <Phone size={10} /> Call
          </a>
        )}
        {phone && (
          <a className="search-action-btn search-action--sms" href={smsHref(phone)} title="Open iMessage">
            <MessageSquare size={10} /> SMS
          </a>
        )}
        {phone && (
          <button className="search-action-btn search-action--copy" onClick={copyPhone} title="Copy number">
            <Copy size={10} /> {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
        {contactId && (
          <button
            className={`search-action-btn search-action--plan${addState === 'added' ? ' added' : addState === 'already' ? ' already' : ''}`}
            onClick={handleAddToPlan}
            disabled={addState === 'adding' || addState === 'added' || addState === 'already'}
          >
            <Plus size={10} />
            {addState === 'added' ? 'Added!' : addState === 'already' ? 'In Plan' : addState === 'adding' ? '…' : 'Add to Plan'}
          </button>
        )}
        {contactId && (
          loggedOutcome ? (
            <span className={`outcome-chip chip-${loggedOutcome}`} style={{ fontSize: 9 }}>
              {OUTCOME_LABELS[loggedOutcome] || loggedOutcome}
            </span>
          ) : (
            <button className="search-action-btn search-action--outcome" onClick={() => setShowOutcome(o => !o)}>
              <PhoneCall size={10} /> Log Outcome
            </button>
          )
        )}
        {contactId && (
          <button
            className={`search-action-btn search-action--reminder${showReminder ? ' active' : ''}`}
            onClick={() => setShowReminder(r => !r)}
            title="Set reminder"
          >
            <Bell size={10} /> Reminder
          </button>
        )}
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
        {contactId && (
          deleteConfirmId ? (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delete?</span>
              <button className="search-action-btn search-action-btn--danger" onClick={handleDelete}>Yes</button>
              <button className="search-action-btn" onClick={() => setDeleteConfirmId(null)}>No</button>
            </>
          ) : (
            <button className="search-action-btn search-action-btn--danger" onClick={() => setDeleteConfirmId(contactId)} title="Delete contact">
              <Trash2 size={12} />
            </button>
          )
        )}
      </div>

      {/* Inline outcome quick-log */}
      {showOutcome && (
        <div className="search-card-outcome-grid">
          {['connected', 'left_message', 'no_answer', 'not_interested', 'callback_requested', 'appraisal_booked'].map(o => (
            <button
              key={o}
              className={`quick-btn ${o.replace(/_/g, '')}`}
              style={{ fontSize: 9, padding: '3px 6px' }}
              onClick={() => logOutcome(o)}
              disabled={logging}
            >
              {OUTCOME_LABELS[o] || o}
            </button>
          ))}
        </div>
      )}

      {/* Inline reminder picker */}
      {showReminder && (
        <div className="followup-prompt" style={{ marginTop: 6 }}>
          <div className="followup-label">Remind me in:</div>
          <div className="followup-row">
            {[[1,'Tomorrow'], [2,'2 Days'], [7,'1 Week']].map(([days, label]) => (
              <button
                key={days}
                className={`followup-quick${reminderDays === days ? ' active' : ''}`}
                onClick={() => setReminderDays(days)}
              >{label}</button>
            ))}
          </div>
          <input
            className="followup-note-input"
            type="text"
            placeholder="Note (optional)..."
            value={reminderNote}
            onChange={e => setReminderNote(e.target.value)}
          />
          <div className="followup-actions">
            <button className="followup-skip" onClick={() => setShowReminder(false)}>Cancel</button>
            <button className="followup-save" onClick={saveReminder} disabled={savingReminder}>
              {savingReminder ? 'Saving…' : 'Save Reminder'}
            </button>
          </div>
        </div>
      )}
      {showEdit && contactId && (
        <AddEditContactModal
          contact={{ id: contactId, name: prop.crm_name || prop.owner_name || '', mobile: prop.contact_mobile || '', address: prop.address || '', suburb: prop.suburb || '', do_not_call: prop.do_not_call ? 1 : 0 }}
          token={token}
          onSaved={updated => { if (onEdited) onEdited(updated); }}
          onClose={() => setShowEdit(false)}
        />
      )}
      {showNotes && contactId && (
        <ContactNotesModal
          contact={{ id: contactId, name: prop.crm_name || prop.owner_name || '', mobile: prop.contact_mobile || '', address: prop.address || '', suburb: prop.suburb || '' }}
          token={token}
          prefilledNote={`Search \u2014 ${prop.address || ''} | `}
          onClose={() => setShowNotes(false)}
        />
      )}
    </div>
  );
}

// ── AddEditContactModal ──────────────────────────────────────────────────────
function AddEditContactModal({ token, contact, onClose, onSaved }) {
  const isEdit = !!contact;
  const [name,    setName]    = useState(isEdit ? (contact.name || '')    : '');
  const [mobile,  setMobile]  = useState(isEdit ? (contact.mobile || '')  : '');
  const [address, setAddress] = useState(isEdit ? (contact.address || '') : '');
  const [suburb,  setSuburb]  = useState(isEdit ? (contact.suburb || '')  : '');
  const [dnc,     setDnc]     = useState(isEdit ? !!contact.do_not_call   : false);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const path   = isEdit ? `/api/contacts/${contact.id}` : '/api/contacts';
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(path, token, {
        method,
        body: JSON.stringify({
          name: name.trim(), mobile: mobile.trim(),
          address: address.trim(), suburb: suburb.trim(),
          do_not_call: dnc ? 1 : 0
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      const saved = data.contact || data;
      onSaved(saved);
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }, [isEdit, contact, name, mobile, address, suburb, dnc, token, onSaved, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{isEdit ? 'Edit Contact' : 'Add Contact'}</span>
          <button className="modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="edit-field">
            <label className="edit-label">Name *</label>
            <input className="edit-input" type="text" value={name}
              placeholder="Full name" onChange={e => setName(e.target.value)} />
          </div>
          <div className="edit-field">
            <label className="edit-label">Mobile</label>
            <input className="edit-input" type="text" value={mobile}
              placeholder="04xx xxx xxx" onChange={e => setMobile(e.target.value)} />
          </div>
          <div className="edit-field">
            <label className="edit-label">Address</label>
            <input className="edit-input" type="text" value={address}
              placeholder="Street address" onChange={e => setAddress(e.target.value)} />
          </div>
          <div className="edit-field">
            <label className="edit-label">Suburb</label>
            <select className="edit-input" value={suburb} onChange={e => setSuburb(e.target.value)}>
              <option value="">Select suburb…</option>
              <option value="artarmon">Artarmon</option>
              <option value="castle cove">Castle Cove</option>
              <option value="castlecrag">Castlecrag</option>
              <option value="chatswood">Chatswood</option>
              <option value="crows nest">Crows Nest</option>
              <option value="lane cove">Lane Cove</option>
              <option value="middle cove">Middle Cove</option>
              <option value="naremburn">Naremburn</option>
              <option value="north willoughby">North Willoughby</option>
              <option value="northbridge">Northbridge</option>
              <option value="st leonards">St Leonards</option>
              <option value="willoughby">Willoughby</option>
              <option value="willoughby east">Willoughby East</option>
            </select>
          </div>
          <div className="edit-field edit-field--inline">
            <label className="edit-label">Do Not Call</label>
            <input type="checkbox" className="edit-checkbox" checked={dnc}
              onChange={e => setDnc(e.target.checked)} />
          </div>
          {error && <div className="edit-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : (isEdit ? 'Save' : 'Add Contact')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Search Page ─────────────────────────────────────────────────────────────
function SearchPage({ token }) {
  const [form, setForm] = useState({
    street: '', suburb: 'all', type: 'all',
    beds_min: '', beds_max: '', owner: '', show_dnc: false, sort_by: 'score'
  });
  const [results, setResults] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);

  const set = useCallback((k, v) => setForm(f => ({ ...f, [k]: v })), []);

  const search = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (form.street)                     params.set('street',   form.street);
    if (form.suburb && form.suburb !== 'all') params.set('suburb', form.suburb);
    if (form.type   && form.type   !== 'all') params.set('type',   form.type);
    if (form.beds_min) params.set('beds_min', form.beds_min);
    if (form.beds_max) params.set('beds_max', form.beds_max);
    if (form.owner)    params.set('owner',    form.owner);
    if (form.show_dnc) params.set('show_dnc', '1');
    if (form.sort_by && form.sort_by !== 'score') params.set('sort_by', form.sort_by);
    params.set('page', p);
    try {
      const res = await apiFetch(`/api/search?${params}`, token);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results || []);
        setTotalCount(data.total_count || 0);
        setTotalPages(data.total_pages || 0);
        setPage(p);
        setSearched(true);
      }
    } catch (err) { console.error('Search failed', err); }
    finally { setLoading(false); }
  }, [form, token]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') search(1);
  }, [search]);

  const pageStart = (page - 1) * 50 + 1;
  const pageEnd   = Math.min(page * 50, totalCount);

  return (
    <div className="page-body search-page">
      {/* Search form */}
      <div className="search-form">
        <div className="search-form-row">
          <div className="search-field">
            <label className="search-field-label">Street</label>
            <input
              className="search-input"
              type="text"
              placeholder="e.g. penshurst"
              value={form.street}
              onChange={e => set('street', e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="search-field">
            <label className="search-field-label">Suburb</label>
            <select className="search-input" value={form.suburb} onChange={e => set('suburb', e.target.value)}>
              <option value="all">All Suburbs</option>
              <option value="artarmon">Artarmon</option>
              <option value="castle cove">Castle Cove</option>
              <option value="castlecrag">Castlecrag</option>
              <option value="chatswood">Chatswood</option>
              <option value="middle cove">Middle Cove</option>
              <option value="naremburn">Naremburn</option>
              <option value="north willoughby">North Willoughby</option>
              <option value="willoughby">Willoughby</option>
              <option value="willoughby east">Willoughby East</option>
            </select>
          </div>
          <div className="search-field">
            <label className="search-field-label">Type</label>
            <select className="search-input" value={form.type} onChange={e => set('type', e.target.value)}>
              <option value="all">All Types</option>
              <option value="house">House</option>
              <option value="unit">Unit</option>
              <option value="townhouse">Townhouse</option>
            </select>
          </div>
        </div>
        <div className="search-form-row">
          <div className="search-field search-field--narrow">
            <label className="search-field-label">Beds Min</label>
            <select className="search-input" value={form.beds_min} onChange={e => set('beds_min', e.target.value)}>
              <option value="">Any</option>
              {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="search-field search-field--narrow">
            <label className="search-field-label">Beds Max</label>
            <select className="search-input" value={form.beds_max} onChange={e => set('beds_max', e.target.value)}>
              <option value="">Any</option>
              {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="search-field">
            <label className="search-field-label">Owner</label>
            <input
              className="search-input"
              type="text"
              placeholder="Surname..."
              value={form.owner}
              onChange={e => set('owner', e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="search-field">
            <label className="search-field-label">Sort By</label>
            <select className="search-input" value={form.sort_by} onChange={e => set('sort_by', e.target.value)}>
              <option value="score">Propensity Score</option>
              <option value="address_asc">Address (Low → High)</option>
              <option value="last_contacted">Recently Contacted</option>
            </select>
          </div>
          <div className="search-field search-field--check">
            <label className="search-check-label">
              <input type="checkbox" checked={form.show_dnc} onChange={e => set('show_dnc', e.target.checked)} />
              Show DNCR
            </label>
          </div>
          <button className="search-btn" onClick={() => search(1)} disabled={loading}>
            <Search size={13} />
            {loading ? 'Searching…' : 'Search'}
          </button>
          <button className="search-btn contacts-add-btn" onClick={() => setShowContactModal(true)}>
            <Plus size={13} /> Add Contact
          </button>
        </div>
      </div>

      {/* Add Contact Modal */}
      {showContactModal && (
        <AddEditContactModal
          token={token}
          contact={null}
          onClose={() => setShowContactModal(false)}
          onSaved={newContact => {
            setResults(prev => [{ crm_contact_id: newContact.id, crm_name: newContact.name, contact_mobile: newContact.mobile, address: newContact.address, suburb: newContact.suburb, do_not_call: newContact.do_not_call, propensity_score: 0 }, ...prev]);
            setTotalCount(prev => prev + 1);
            setSearched(true);
          }}
        />
      )}

      {/* Results header */}
      {searched && !loading && (
        <div className="search-results-header">
          {totalCount === 0 ? (
            <span>No results found</span>
          ) : (
            <>
              <span>Found <strong>{totalCount}</strong> contacts & properties</span>
              {totalCount > 50 && <span> · Showing {pageStart}–{pageEnd}</span>}
            </>
          )}
          {totalPages > 1 && (
            <div className="search-pagination">
              <button className="search-page-btn" disabled={page <= 1} onClick={() => search(page - 1)}>‹</button>
              <span>{page} / {totalPages}</span>
              <button className="search-page-btn" disabled={page >= totalPages} onClick={() => search(page + 1)}>›</button>
            </div>
          )}
        </div>
      )}

      {/* Loading state */}
      {loading && <div className="loading-state"><div className="spinner" /></div>}

      {/* Results */}
      {!loading && results.length > 0 && (
        <div className="search-results">
          {results.map((prop, i) => (
            <SearchCard
              key={prop.property_id || i}
              prop={prop}
              token={token}
              onDeleted={(deleted) => {
                setResults(prev => prev.filter(r => (r.crm_contact_id || r.property_id) !== (deleted.crm_contact_id || deleted.property_id)));
                setTotalCount(prev => prev - 1);
              }}
              onEdited={(updated) => {
                setResults(prev => prev.map(r =>
                  r.crm_contact_id === updated.id
                    ? { ...r, crm_name: updated.name, contact_mobile: updated.mobile, address: updated.address, suburb: updated.suburb, do_not_call: updated.do_not_call }
                    : r
                ));
              }}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {searched && !loading && results.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon"><Search size={32} /></div>
          <div className="empty-state-title">No properties found</div>
          <div className="empty-state-sub">Try a different street name or filters</div>
        </div>
      )}

      {/* Initial prompt */}
      {!searched && !loading && (
        <div className="empty-state" style={{ marginTop: 40 }}>
          <div className="empty-state-icon" style={{ color: '#3b82f6' }}><Search size={32} /></div>
          <div className="empty-state-title">Search contacts & properties</div>
          <div className="empty-state-sub">Filter by street, type, beds, or owner name</div>
        </div>
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ page, onNav, remainingCount, reminderCount, mobileOpen }) {
  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const navItems = [
    { id: 'calls', label: 'Calls', Icon: Phone, badge: remainingCount > 0 ? remainingCount : null },
    { id: 'market', label: 'Market', Icon: TrendingUp },
    { id: 'buyers', label: 'Buyers', Icon: Users },
    { id: 'referrals', label: 'Referrals', Icon: Star },
    { id: 'prospects', label: 'Prospects', Icon: Search },
    { id: 'reminders', label: 'Reminders', Icon: Bell, badge: reminderCount > 0 ? reminderCount : null },
    { id: 'contacts', label: 'Contacts', Icon: Users },
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
    referrals: 'Referrals',
    prospects: 'Prospects',
    reminders: 'Reminders',
    contacts: 'Contacts',
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
    { id: 'referrals', label: 'Referrals', Icon: Star },
    { id: 'prospects', label: 'Prospects', Icon: Search },
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

// ── Jarvis Chat Panel ────────────────────────────────────────────────────────
const JARVIS_WELCOME = "G'day Bailey. I have access to your recent market data, farm contacts, and call history. Ask me about recent sales, comparable prices, or talking points for specific properties.";
const JARVIS_CHIPS = ['Recent Willoughby sales', 'Best contacts to call today', 'Market summary'];

function JarvisChat({ token }) {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [thinking, setThinking] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [hasUnread, setHasUnread] = useState(false);
  const bottomRef     = useRef(null);
  const inputRef      = useRef(null);
  const actionTimerRef = useRef(null);

  useEffect(() => {
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (open) {
      setHasUnread(false);
      if (inputRef.current) inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => () => clearTimeout(actionTimerRef.current), []);

  const send = useCallback(async (overrideText) => {
    const text = (overrideText !== undefined ? overrideText : input).trim();
    if (!text || thinking) return;
    const newMessages = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setThinking(true);
    try {
      const res = await apiFetch('/api/chat', token, {
        method: 'POST',
        body: JSON.stringify({ messages: newMessages }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
        if (!open) setHasUnread(true);
        if (data.action?.type === 'price_updated') {
          setActionMsg(`Price recorded for event #${data.action.event_id}: ${data.action.price}`);
          clearTimeout(actionTimerRef.current);
          actionTimerRef.current = setTimeout(() => setActionMsg(''), 6000);
        }
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I hit an error. Please try again.' }]);
      }
    } catch (_) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Network error. Please try again.' }]);
    } finally {
      setThinking(false);
    }
  }, [input, messages, thinking, token, open]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleChip = (chip) => {
    setInput(chip);
    send(chip);
  };

  return (
    <>
      <div className="jarvis-chat-fab-wrapper">
        <button
          onClick={() => setOpen(o => !o)}
          className="jarvis-chat-fab"
          title="Chat with Jarvis"
        >
          {open ? <X size={20} /> : <MessageSquare size={20} />}
          {hasUnread && !open && <span className="jarvis-fab-unread" />}
        </button>
        <span className="jarvis-chat-fab-label">JARVIS</span>
      </div>

      {open && (
        <div className="jarvis-chat-panel">
          <div className="jarvis-chat-header">
            <span className={`jarvis-status-dot ${thinking ? 'jarvis-status-dot--thinking' : 'jarvis-status-dot--ready'}`} />
            <span className="jarvis-chat-title">JARVIS</span>
            <span className="jarvis-chat-subtitle">AI ASSISTANT</span>
            {actionMsg && <span style={{ marginLeft: 8, color: '#22c55e', fontSize: 10 }}>{actionMsg}</span>}
            <button
              onClick={() => setMessages([])}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, padding: '0 4px' }}
            >Clear</button>
            <button
              onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0 2px' }}
            ><X size={14} /></button>
          </div>

          <div className="jarvis-chat-messages">
            {messages.length === 0 && (
              <div className="jarvis-msg jarvis-msg--assistant">
                <div className="jarvis-msg-bubble">{JARVIS_WELCOME}</div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`jarvis-msg jarvis-msg--${m.role}`}>
                <div className="jarvis-msg-bubble">{m.content}</div>
              </div>
            ))}
            {thinking && (
              <div className="jarvis-msg jarvis-msg--assistant">
                <div className="jarvis-msg-bubble jarvis-msg-thinking">
                  <span className="jarvis-dot" /><span className="jarvis-dot" /><span className="jarvis-dot" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="jarvis-chat-chips">
            {JARVIS_CHIPS.map(chip => (
              <button key={chip} className="jarvis-chat-chip" onClick={() => handleChip(chip)}>{chip}</button>
            ))}
          </div>

          <div className="jarvis-chat-input-row">
            <textarea
              ref={inputRef}
              className="jarvis-chat-input"
              placeholder="Ask Jarvis…  (Enter to send)"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={2}
            />
            <button
              className="jarvis-chat-send"
              onClick={() => send()}
              disabled={!input.trim() || thinking}
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Referrals Pipeline Page ────────────────────────────────────────────────
const REFERRAL_STATUSES = ['referred', 'introduced', 'active', 'settled', 'paid'];
const REFERRAL_STATUS_COLORS = {
  referred:   'var(--text-muted)',
  introduced: 'var(--gold)',
  active:     '#3b82f6',
  settled:    '#22c55e',
  paid:       '#a855f7',
};
const PARTNER_TYPE_LABELS = {
  selling_agent:   'Selling Agent',
  buyers_agent:    'Buyers Agent',
  mortgage_broker: 'Mortgage Broker',
};
const PARTNER_TYPE_COLORS = {
  selling_agent:   'var(--gold)',
  buyers_agent:    '#3b82f6',
  mortgage_broker: '#22c55e',
};

function parseBuyerBrief(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function formatFee(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-AU', { maximumFractionDigits: 0 });
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

// ── Revenue Summary Cards ───────────────────────────────────────────────────
function ReferralMetricCard({ label, value, color, sub }) {
  return (
    <div style={{
      background: 'var(--bg-raised)',
      border: '1px solid var(--border-subtle)',
      borderTop: `3px solid ${color}`,
      borderRadius: 10,
      padding: '20px 24px',
      flex: 1,
      minWidth: 0,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: `radial-gradient(ellipse at top left, ${color}08 0%, transparent 60%)`,
        pointerEvents: 'none',
      }} />
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color, fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{sub}</div>}
    </div>
  );
}

// ── Partner Row ─────────────────────────────────────────────────────────────
function PartnerRow({ partner }) {
  const color = PARTNER_TYPE_COLORS[partner.type] || 'var(--text-muted)';
  const feeStr = partner.fee_value
    ? (partner.fee_type === 'percentage' ? `${partner.fee_value}%` : formatFee(partner.fee_value))
    : '—';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%', background: `${color}20`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Building2 size={14} style={{ color }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{partner.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          <span style={{ color, marginRight: 8 }}>{PARTNER_TYPE_LABELS[partner.type] || partner.type}</span>
          {partner.suburb_focus && <span style={{ marginRight: 8 }}>{partner.suburb_focus}</span>}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)' }}>{feeStr}</div>
        {partner.mobile && (
          <a href={`tel:${partner.mobile}`} style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'none', fontFamily: 'var(--font-mono)' }}>{partner.mobile}</a>
        )}
      </div>
    </div>
  );
}

// ── Referral Card ───────────────────────────────────────────────────────────
function ReferralCard({ referral, onStatusChange }) {
  const [updating, setUpdating] = useState(false);
  const days = daysSince(referral.referred_at);
  const brief = parseBuyerBrief(referral.buyer_brief);
  const partnerColor = PARTNER_TYPE_COLORS[referral.partner_type] || 'var(--text-muted)';

  const handleStatus = async (e) => {
    const newStatus = e.target.value;
    if (newStatus === referral.status) return;
    setUpdating(true);
    try {
      // token not accessible here — use parent callback pattern
      await onStatusChange(referral.id, newStatus);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 8,
      transition: 'border-color 0.15s',
      opacity: updating ? 0.6 : 1,
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(200,169,110,0.25)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.3 }}>
            {referral.contact_name || 'Unknown Contact'}
          </div>
          {referral.contact_address && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {referral.contact_address}
            </div>
          )}
        </div>
        {days !== null && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8, paddingTop: 2 }}>
            {days}d ago
          </div>
        )}
      </div>

      {/* Partner badge */}
      {referral.partner_name && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
            background: `${partnerColor}18`, color: partnerColor,
            border: `1px solid ${partnerColor}40`,
            borderRadius: 4, padding: '2px 7px',
          }}>
            {PARTNER_TYPE_LABELS[referral.partner_type] || referral.partner_type}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{referral.partner_name}</span>
        </div>
      )}

      {/* Buyer brief info row */}
      {brief && (referral.type === 'buyer' || brief.budget_min || brief.budget_max || brief.suburbs) && (
        <div style={{
          background: '#3b82f610',
          border: '1px solid #3b82f630',
          borderRadius: 5,
          padding: '6px 10px',
          marginBottom: 8,
          fontSize: 11,
          color: '#93c5fd',
          fontFamily: 'var(--font-mono)',
        }}>
          {(brief.budget_min || brief.budget_max) && (
            <span style={{ marginRight: 10 }}>
              {brief.budget_min ? formatFee(brief.budget_min) : '?'}
              {' – '}
              {brief.budget_max ? formatFee(brief.budget_max) : '?'}
            </span>
          )}
          {brief.suburbs && (
            <span style={{ marginRight: 10, color: '#bfdbfe' }}>
              {Array.isArray(brief.suburbs) ? brief.suburbs.join(', ') : brief.suburbs}
            </span>
          )}
          {brief.pre_approved && (
            <span style={{ color: '#22c55e', marginRight: 10 }}>Pre-approved ✓</span>
          )}
          {brief.ai_brief && (
            <span style={{
              background: '#a855f720', color: '#d8b4fe',
              border: '1px solid #a855f740',
              borderRadius: 3, padding: '1px 5px', fontSize: 10,
              verticalAlign: 'middle',
            }}>AI Brief ✓</span>
          )}
        </div>
      )}

      {/* Fee + status */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {referral.expected_fee ? (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)', fontWeight: 600 }}>
            {formatFee(referral.expected_fee)}
          </div>
        ) : <div />}

        <select
          value={referral.status}
          onChange={handleStatus}
          disabled={updating}
          style={{
            background: 'var(--bg-base)',
            color: REFERRAL_STATUS_COLORS[referral.status] || 'var(--text-primary)',
            border: `1px solid ${REFERRAL_STATUS_COLORS[referral.status] || 'var(--border-subtle)'}50`,
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.08em',
            padding: '3px 8px',
            cursor: 'pointer',
            textTransform: 'uppercase',
            outline: 'none',
          }}
        >
          {REFERRAL_STATUSES.map(s => (
            <option key={s} value={s}>{s.toUpperCase()}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── Kanban Column ───────────────────────────────────────────────────────────
function KanbanColumn({ status, referrals, onStatusChange }) {
  const color = REFERRAL_STATUS_COLORS[status];
  const isMobile = window.innerWidth < 768;

  return (
    <div style={{
      flex: isMobile ? 'none' : 1,
      minWidth: isMobile ? 'none' : 0,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Column header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: isMobile ? '16px 0 8px' : '0 0 10px',
        borderBottom: `2px solid ${color}40`,
        marginBottom: 12,
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.12em', color, textTransform: 'uppercase',
        }}>
          {status}
        </span>
        <span style={{
          marginLeft: 'auto',
          background: `${color}20`, color,
          borderRadius: 10, fontSize: 10,
          fontFamily: 'var(--font-mono)',
          padding: '2px 8px', fontWeight: 700,
        }}>
          {referrals.length}
        </span>
      </div>

      {/* Cards */}
      <div style={{ flex: 1 }}>
        {referrals.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '24px 12px',
            color: 'var(--text-muted)', fontSize: 11,
            fontFamily: 'var(--font-mono)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 8,
          }}>
            No {status} referrals
          </div>
        ) : (
          referrals.map(r => (
            <ReferralCard key={r.id} referral={r} onStatusChange={onStatusChange} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Add Partner Form ────────────────────────────────────────────────────────
function AddPartnerForm({ token, onAdded }) {
  const [form, setForm] = useState({ name: '', type: 'selling_agent', fee_type: 'percentage', fee_value: '', suburb_focus: '', mobile: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) { setErr('Name is required'); return; }
    setSaving(true); setErr('');
    try {
      const res = await apiFetch('/api/partners', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          fee_type: form.fee_type,
          fee_value: form.fee_value ? parseFloat(form.fee_value) : null,
          suburb_focus: form.suburb_focus.trim() || null,
          mobile: form.mobile.trim() || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); setErr(d.error || 'Failed'); return; }
      setForm({ name: '', type: 'selling_agent', fee_type: 'percentage', fee_value: '', suburb_focus: '', mobile: '' });
      onAdded();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const inputStyle = {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 5,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: '7px 10px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4, display: 'block' };

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-subtle)', marginTop: 8 }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--gold)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 14 }}>Add Partner</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>Name *</label>
          <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="Partner name" />
        </div>
        <div>
          <label style={labelStyle}>Type</label>
          <select style={inputStyle} value={form.type} onChange={e => set('type', e.target.value)}>
            <option value="selling_agent">Selling Agent</option>
            <option value="buyers_agent">Buyers Agent</option>
            <option value="mortgage_broker">Mortgage Broker</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Fee</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={{ ...inputStyle, width: 54, flexShrink: 0 }} value={form.fee_type} onChange={e => set('fee_type', e.target.value)}>
              <option value="percentage">%</option>
              <option value="flat">$</option>
            </select>
            <input style={{ ...inputStyle, flex: 1 }} type="number" value={form.fee_value} onChange={e => set('fee_value', e.target.value)} placeholder="0" min="0" />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Suburb Focus</label>
          <input style={inputStyle} value={form.suburb_focus} onChange={e => set('suburb_focus', e.target.value)} placeholder="e.g. Willoughby" />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>Mobile</label>
          <input style={inputStyle} value={form.mobile} onChange={e => set('mobile', e.target.value)} placeholder="04XX XXX XXX" />
        </div>
      </div>
      {err && <div style={{ color: '#F87171', fontSize: 11, fontFamily: 'var(--font-mono)', marginBottom: 8 }}>{err}</div>}
      <button
        onClick={submit}
        disabled={saving}
        style={{
          background: 'transparent',
          border: '1px solid var(--border-gold)',
          color: 'var(--gold)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '8px 20px',
          borderRadius: 5,
          cursor: 'pointer',
          opacity: saving ? 0.5 : 1,
        }}
      >
        {saving ? 'Adding…' : 'Add Partner'}
      </button>
    </div>
  );
}

// ── Partners Panel ──────────────────────────────────────────────────────────
function PartnersPanel({ token, partners, onRefresh }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{
      background: 'var(--bg-raised)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
      marginBottom: 24,
    }}>
      {/* Toggle header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Building2 size={14} style={{ color: 'var(--gold)' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-primary)', textTransform: 'uppercase' }}>
            Manage Partners
          </span>
          <span style={{
            background: 'var(--gold-glow, rgba(200,169,110,0.12))', color: 'var(--gold)',
            fontSize: 10, fontFamily: 'var(--font-mono)',
            borderRadius: 8, padding: '2px 8px',
          }}>
            {partners.length}
          </span>
        </div>
        {open ? <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />}
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '0 18px 18px' }}>
          {/* Partner list */}
          {partners.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
              No partners yet. Add one below.
            </div>
          ) : (
            <div style={{ marginTop: 4 }}>
              {partners.map(p => <PartnerRow key={p.id} partner={p} />)}
            </div>
          )}
          <AddPartnerForm token={token} onAdded={onRefresh} />
        </div>
      )}
    </div>
  );
}

// ── Main ReferralsPage ──────────────────────────────────────────────────────
function ReferralsPage({ token }) {
  const [referrals, setReferrals] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, pRes] = await Promise.all([
        apiFetch('/api/referrals', token),
        apiFetch('/api/partners', token),
      ]);
      if (rRes.ok) { const d = await rRes.json(); setReferrals(d.referrals || []); }
      if (pRes.ok) { const d = await pRes.json(); setPartners(d.partners || []); }
    } catch (_) {}
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = useCallback(async (id, newStatus) => {
    try {
      const res = await apiFetch(`/api/referrals/${id}`, token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) { await load(); }
    } catch (_) {}
  }, [token, load]);

  // Revenue metrics
  const paidReferrals   = referrals.filter(r => r.status === 'paid');
  const activePipeline  = referrals.filter(r => r.status !== 'paid');
  const pipelineValue   = activePipeline.reduce((s, r) => s + (parseFloat(r.expected_fee) || 0), 0);
  const receivedValue   = paidReferrals.reduce((s, r) => s + (parseFloat(r.actual_fee) || parseFloat(r.expected_fee) || 0), 0);

  // Kanban buckets
  const byStatus = {};
  for (const s of REFERRAL_STATUSES) {
    byStatus[s] = referrals.filter(r => r.status === s);
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading pipeline…
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? '0 0 80px' : '0 0 40px' }}>

      {/* ── Section 1: Revenue Summary ─────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
        <ReferralMetricCard
          label="Active Pipeline"
          value={pipelineValue > 0 ? '$' + pipelineValue.toLocaleString('en-AU', { maximumFractionDigits: 0 }) : '$0'}
          color="var(--gold)"
          sub={`${activePipeline.length} active referral${activePipeline.length !== 1 ? 's' : ''}`}
        />
        <ReferralMetricCard
          label="Received"
          value={receivedValue > 0 ? '$' + receivedValue.toLocaleString('en-AU', { maximumFractionDigits: 0 }) : '$0'}
          color="#22c55e"
          sub={`${paidReferrals.length} settled & paid`}
        />
        <ReferralMetricCard
          label="Total Referrals"
          value={referrals.length}
          color="var(--text-primary)"
          sub={partners.length + ` partner${partners.length !== 1 ? 's' : ''}`}
        />
      </div>

      {/* ── Section 2: Partners Panel ──────────────────────────────────── */}
      <PartnersPanel token={token} partners={partners} onRefresh={load} />

      {/* ── Section 3: Kanban Pipeline ─────────────────────────────────── */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? 0 : 14,
        alignItems: 'flex-start',
      }}>
        {REFERRAL_STATUSES.map(status => (
          <KanbanColumn
            key={status}
            status={status}
            referrals={byStatus[status]}
            onStatusChange={handleStatusChange}
          />
        ))}
      </div>
    </div>
  );
}

// ── ReferralProspectsPage ───────────────────────────────────────────────────
function ReferralProspectsPage({ token }) {
  const [results, setResults] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [pages, setPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [type, setType] = React.useState('buyer');
  const [suburb, setSuburb] = React.useState('');
  const [suburbInput, setSuburbInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [referContact, setReferContact] = React.useState(null);
  const [scripts, setScripts] = React.useState({}); // contactId -> {text, loading, copied}

  // Load results
  function load(p = 1, t = type, s = suburb) {
    setLoading(true);
    const params = new URLSearchParams({ type: t, page: p });
    if (s.trim()) params.set('suburb', s.trim());
    apiFetch(`/api/referral-prospects?${params}`, token)
      .then(r => r.json())
      .then(data => {
        setResults(data.rows || []);
        setTotal(data.total || 0);
        setPages(data.pages || 1);
        setPage(p);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  React.useEffect(() => { load(1, type, suburb); }, [type]);

  function handleSearch(e) {
    e.preventDefault();
    setSuburb(suburbInput);
    load(1, type, suburbInput);
  }

  async function generateScript(contact) {
    setScripts(prev => ({ ...prev, [contact.id]: { loading: true, text: '', copied: false } }));
    try {
      const res = await apiFetch('/api/referral-prospects/outreach-script', token, {
        method: 'POST',
        body: JSON.stringify({
          name: contact.name,
          suburb: contact.suburb,
          address: contact.address,
          contact_class: contact.contact_class,
          last_modified: contact.last_modified
        })
      });
      const data = await res.json();
      setScripts(prev => ({ ...prev, [contact.id]: { loading: false, text: data.script || '', copied: false } }));
    } catch (e) {
      setScripts(prev => ({ ...prev, [contact.id]: { loading: false, text: '', error: true, copied: false } }));
    }
  }

  function copyScript(id, text) {
    navigator.clipboard.writeText(text).then(() => {
      setScripts(prev => ({ ...prev, [id]: { ...prev[id], copied: true } }));
      setTimeout(() => setScripts(prev => ({ ...prev, [id]: { ...prev[id], copied: false } })), 2000);
    });
  }

  const typeOptions = [
    { value: 'buyer', label: 'Active Buyers', color: '#3b82f6' },
    { value: 'vendor', label: 'Prospective Vendors', color: 'var(--gold)' },
    { value: 'all', label: 'All Contacts', color: 'var(--text-muted)' }
  ];
  const activeColor = typeOptions.find(t => t.value === type)?.color || 'var(--gold)';

  return (
    <div style={{ padding: '20px', maxWidth: '900px' }}>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ color: 'var(--gold)', margin: '0 0 4px', fontSize: '18px', letterSpacing: '0.1em' }}>
              REFERRAL PROSPECTS
            </h2>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
              {loading ? 'Loading...' : `${total.toLocaleString()} contacts available`}
            </div>
          </div>
        </div>
        {type === 'buyer' && (
          <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.25)', borderRadius: '6px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#3b82f6', fontSize: '12px' }}>
              Each qualified buyer referral = <strong>$2,000-$5,000</strong> per settlement
            </span>
            <span style={{ color: '#3b82f6', fontSize: '11px', opacity: 0.7 }}>
              {total.toLocaleString()} potential leads
            </span>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Type segmented control */}
        <div style={{ display: 'flex', background: 'var(--bg-raised)', borderRadius: '6px',
          border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
          {typeOptions.map(opt => (
            <button key={opt.value} type="button"
              onClick={() => { setType(opt.value); setPage(1); }}
              style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontSize: '11px',
                fontWeight: type === opt.value ? '600' : '400',
                background: type === opt.value ? `${opt.color}20` : 'transparent',
                color: type === opt.value ? opt.color : 'var(--text-muted)',
                transition: 'all 0.15s', borderRight: '1px solid var(--border-subtle)' }}>
              {opt.label}
            </button>
          ))}
        </div>

        {/* Suburb search */}
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '6px', flex: 1, minWidth: '200px' }}>
          <input value={suburbInput} onChange={e => setSuburbInput(e.target.value)}
            placeholder="Filter by suburb (e.g. Mosman)"
            style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)', padding: '7px 12px', borderRadius: '4px', fontSize: '12px' }} />
          <button type="submit"
            style={{ padding: '7px 16px', background: 'var(--gold)', color: '#000',
              border: 'none', borderRadius: '4px', fontWeight: '600', cursor: 'pointer', fontSize: '12px' }}>
            Search
          </button>
        </form>
      </div>

      {/* Results */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>&#x27F3;</div>
          Loading prospects...
        </div>
      )}

      {!loading && results.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)',
          background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
          No contacts found for this filter.
        </div>
      )}

      {!loading && results.map(contact => {
        const scriptState = scripts[contact.id];
        const isBuyer = (contact.contact_class || '').includes('Buyer');
        const isVendor = (contact.contact_class || '').includes('Vendor') || (contact.contact_class || '').includes('Owner');
        const badgeColor = isBuyer ? '#3b82f6' : isVendor ? 'var(--gold)' : 'var(--text-muted)';

        return (
          <div key={contact.id} style={{ marginBottom: '6px', border: '1px solid var(--border-subtle)',
            borderRadius: '6px', overflow: 'hidden', background: 'var(--bg-surface)' }}>
            <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              {/* Left: contact info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                  <span style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: '600' }}>
                    {contact.name || 'Unknown'}
                  </span>
                  <span style={{ padding: '1px 6px', background: `${badgeColor}18`,
                    color: badgeColor, borderRadius: '3px', fontSize: '9px', fontWeight: '600',
                    letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {isBuyer ? 'BUYER' : isVendor ? 'VENDOR' : 'CONTACT'}
                  </span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                  {contact.address ? `${contact.address}, ` : ''}{contact.suburb || ''}
                </div>
              </div>

              {/* Right: mobile + actions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                {contact.mobile && (
                  <a href={`tel:${contact.mobile}`}
                    style={{ color: 'var(--gold)', fontSize: '12px', textDecoration: 'none',
                      fontFamily: 'monospace' }}>
                    {contact.mobile}
                  </a>
                )}
                <button onClick={() => generateScript(contact)}
                  disabled={scriptState?.loading}
                  style={{ padding: '5px 10px', background: 'rgba(168,85,247,0.12)',
                    border: '1px solid rgba(168,85,247,0.35)', color: '#a855f7',
                    borderRadius: '4px', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
                    opacity: scriptState?.loading ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                  {scriptState?.loading ? '...' : '\u2726 Script'}
                </button>
                <button onClick={() => setReferContact(contact)}
                  style={{ padding: '5px 10px', background: 'transparent',
                    border: '1px solid var(--border-gold)', color: 'var(--gold)',
                    borderRadius: '4px', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
                    whiteSpace: 'nowrap' }}>
                  Refer &#x2192;
                </button>
              </div>
            </div>

            {/* AI Script output */}
            {scriptState && !scriptState.loading && scriptState.text && (
              <div style={{ padding: '10px 14px', background: 'rgba(168,85,247,0.06)',
                borderTop: '1px solid rgba(168,85,247,0.2)', display: 'flex',
                justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                <p style={{ margin: 0, color: 'var(--text-primary)', fontSize: '12px',
                  lineHeight: '1.5', flex: 1, fontStyle: 'italic' }}>
                  "{scriptState.text}"
                </p>
                <button onClick={() => copyScript(contact.id, scriptState.text)}
                  style={{ padding: '4px 10px', background: scriptState.copied ? '#22c55e20' : 'var(--bg-raised)',
                    border: `1px solid ${scriptState.copied ? '#22c55e' : 'var(--border-subtle)'}`,
                    color: scriptState.copied ? '#22c55e' : 'var(--text-muted)',
                    borderRadius: '3px', cursor: 'pointer', fontSize: '10px', flexShrink: 0,
                    transition: 'all 0.2s' }}>
                  {scriptState.copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Pagination */}
      {pages > 1 && !loading && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'center', alignItems: 'center' }}>
          <button onClick={() => load(page - 1, type, suburb)} disabled={page <= 1}
            style={{ padding: '6px 14px', background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)', color: page <= 1 ? 'var(--text-muted)' : 'var(--text-primary)',
              borderRadius: '4px', cursor: page <= 1 ? 'default' : 'pointer', fontSize: '12px' }}>
            &#x2190; Prev
          </button>
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            Page {page} of {pages} &middot; {total.toLocaleString()} contacts
          </span>
          <button onClick={() => load(page + 1, type, suburb)} disabled={page >= pages}
            style={{ padding: '6px 14px', background: 'var(--bg-raised)',
              border: '1px solid var(--border-subtle)', color: page >= pages ? 'var(--text-muted)' : 'var(--text-primary)',
              borderRadius: '4px', cursor: page >= pages ? 'default' : 'pointer', fontSize: '12px' }}>
            Next &#x2192;
          </button>
        </div>
      )}

      {/* ReferModal */}
      {referContact && (
        <ReferModal
          contact={referContact}
          token={token}
          onClose={() => setReferContact(null)}
          onSuccess={() => setReferContact(null)}
        />
      )}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
function App() {
  const [token, setToken] = useState(() => localStorage.getItem('jarvis_token') || '');
  const [page, setPage] = useState('calls');
  const [remainingCount, setRemainingCount] = useState(0);
  const [reminderCount, setReminderCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogin = useCallback((t) => {
    localStorage.setItem('jarvis_token', t);
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
    buyers: { title: 'Buyer Profiles', subtitle: 'BUYER CRM — ACTIVE ENQUIRIES & MATCHES' },
    referrals: { title: 'Referrals Pipeline', subtitle: 'PARTNER REFERRALS — REVENUE TRACKER' },
    prospects: { title: 'Referral Prospects', subtitle: 'CRM BUYER & VENDOR LEADS — 124K CONTACTS' },
    reminders: { title: 'Reminders', subtitle: 'UPCOMING FOLLOW-UPS' },
    contacts: { title: 'Contacts', subtitle: 'CRM + PRICEFINDER — CONTACTS & PROPERTIES' },
    history: { title: 'Call History', subtitle: 'TODAY\'S LOGGED OUTCOMES' }
  };
  const pt = pageTitles[page] || pageTitles.calls;

  const renderPage = () => {
    switch (page) {
      case 'calls':     return <CallsPage token={token} onReminderCountChange={setReminderCount} />;
      case 'market':    return <MarketPage token={token} />;
      case 'buyers':    return <BuyersPage token={token} />;
      case 'referrals': return <ReferralsPage token={token} />;
      case 'prospects': return <ReferralProspectsPage token={token} />;
      case 'reminders': return <RemindersPage token={token} onReminderCountChange={setReminderCount} />;
      case 'contacts':  return <SearchPage token={token} />;
      case 'history':   return <HistoryPage token={token} />;
      default:          return <CallsPage token={token} onReminderCountChange={setReminderCount} />;
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
        reminderCount={reminderCount}
        mobileOpen={sidebarOpen}
      />
      <main className="main-content">
        <MobileHeader page={page} onMenuClick={() => setSidebarOpen(o => !o)} />
        <CallStatsBar token={token} />
        <div className="page-header">
          <h1 className="page-title">{pt.title}</h1>
          <span className="page-subtitle">{pt.subtitle}</span>
        </div>
        {renderPage()}
      </main>
      <BottomTabBar page={page} onNav={handleNav} />
      <JarvisChat token={token} />
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
