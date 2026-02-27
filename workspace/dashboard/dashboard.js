// JARVIS Intelligence Terminal — Dashboard SPA
// React 18 + Babel Standalone (no build step)
// All icons via lucide global, all styles via dashboard.css

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Lucide icon destructuring (lucide-react UMD → window.LucideReact) ─────
const {
  Phone, ChevronDown, ChevronUp, Bell, TrendingUp, Users, Clock,
  MapPin, Calendar, Check, X, AlertCircle, Home, Activity,
  MessageSquare, PhoneCall, PhoneOff, PhoneMissed, Star, RefreshCw,
  History, Menu, Building2, CheckCircle, Bed, Bath, Car, Plus, Mail,
  Search, Pencil, Trash2, Copy, SortAsc, Send, ClipboardList, FileEdit
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
              placeholder="Additional note (optional)\u2026"
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
            placeholder="Follow-up note (optional)\u2026"
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

  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}`, token, {
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
  }, [contact.id, name, mobile, address, suburb, dnc, token, onSaved, onClose]);

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
            {saving ? 'Saving\u2026' : 'Save'}
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
            {saving ? 'Saving\u2026' : 'Add Contact'}
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

  useEffect(() => {
    if (!contact.id) { setLoading(false); return; }
    Promise.all([
      apiFetch(`/api/contacts/${contact.id}/notes`, token).then(r => r.json()),
      apiFetch(`/api/contacts/${contact.id}/history`, token).then(r => r.json()),
    ]).then(([n, h]) => {
      setNotes(Array.isArray(n) ? n : []);
      setHistory(Array.isArray(h) ? h : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [contact.id, token]);

  const handleSaveNote = useCallback(async () => {
    if (!noteText.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/contacts/${contact.id}/notes`, token, {
        method: 'POST', body: JSON.stringify({ note: noteText.trim() })
      });
      const data = await res.json();
      if (data.note) setNotes(prev => [data.note, ...prev]);
      setNoteText('');
    } catch (_) {}
    finally { setSaving(false); }
  }, [contact.id, noteText, token]);

  const handleSaveReminder = useCallback(async () => {
    setSavingRem(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + remDays);
      d.setHours(9, 0, 0, 0);
      await apiFetch('/api/reminders', token, {
        method: 'POST',
        body: JSON.stringify({
          contact_id:       contact.id,
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
            <textarea className="notes-textarea" placeholder="Add a note\u2026"
              value={noteText} onChange={e => setNoteText(e.target.value)} rows={3} />
            <div className="notes-add-actions">
              <button className="notes-btn-reminder-toggle"
                onClick={() => setShowReminder(v => !v)}>
                <Bell size={12} /> {showReminder ? 'Hide Reminder' : 'Set Reminder'}
              </button>
              <button className="modal-btn modal-btn--save"
                onClick={handleSaveNote} disabled={saving || !noteText.trim()}>
                {saving ? 'Saving\u2026' : 'Save Note'}
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
                placeholder="Reminder note (optional)\u2026"
                value={remNote} onChange={e => setRemNote(e.target.value)} />
              <div className="followup-actions">
                <button className="followup-skip" onClick={() => setShowReminder(false)}>Cancel</button>
                <button className="followup-save" onClick={handleSaveReminder} disabled={savingRem}>
                  {savingRem ? 'Saving\u2026' : 'Save Reminder'}
                </button>
              </div>
            </div>
          )}

          {remSaved && <div className="notes-reminder-saved"><Check size={11} /> Reminder saved</div>}

          <div className="notes-timeline">
            {loading && <div className="notes-loading">Loading\u2026</div>}
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

// ── Event Group (collapsible group within Just Sold / Just Listed) ──────────
function EventGroup({ alert, token, accentColor, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showMore, setShowMore] = useState(false);
  const [calledMap, setCalledMap] = useState({});

  const contacts = alert.topContacts || [];
  const watchers = alert.type === 'sold' ? (alert.watchers || []) : [];
  const initialCount = Math.min(10, contacts.length);
  const visibleContacts = showMore ? contacts : contacts.slice(0, initialCount);
  const calledCount = Object.keys(calledMap).length;

  const handleLogged = useCallback((id, outcome) => {
    setCalledMap(prev => ({ ...prev, [id]: outcome }));
  }, []);

  const ageDays = Math.floor((Date.now() - new Date(alert.detectedAt)) / 86400000);
  const ageLabel = ageDays === 0 ? 'TODAY' : ageDays === 1 ? '1 DAY AGO' : `${ageDays} DAYS AGO`;

  const propParts = [
    alert.beds && `${alert.beds}bed`,
    alert.propertyType
  ].filter(Boolean).join(' · ');

  return (
    <div className="event-group" style={{ '--group-accent': accentColor }}>
      <div className="event-group-header" onClick={() => setExpanded(e => !e)}>
        <div className="event-group-meta-row">
          <span className="event-group-age" style={{ color: accentColor }}>{ageLabel}</span>
          {calledCount > 0 && (
            <span className="event-group-progress">{calledCount}/{contacts.length} called</span>
          )}
          <ChevronDown size={13} style={{ marginLeft: 'auto', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--text-muted)', flexShrink: 0 }} />
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
        fetch('/api/alerts'),
        fetch('/api/status'),
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
        if (onReminderCountChange) onReminderCountChange(Array.isArray(rems) ? rems.length : 0);
      }
    } catch (err) { console.error('Load failed', err); }
    finally { setLoading(false); }
  }, [token, onReminderCountChange]);

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

  const loadEvents = useCallback(() => {
    setLoading(true);
    apiFetch(`/api/market?days=${daysFilter}&status=${statusFilter}`, token)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setEvents(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token, daysFilter, statusFilter]);

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
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
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
                    {[ev.beds && `${ev.beds}bd`, ev.baths && `${ev.baths}ba`, ev.cars && `${ev.cars}car`,
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

// ── Buyers Page ────────────────────────────────────────────────────────────
function BuyersPage({ token }) {
  const [data, setData] = useState({ active: {}, archived: {} });
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('newest');
  const [group, setGroup] = useState('listing');
  const [expandedListings, setExpandedListings] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [outcomeTarget, setOutcomeTarget] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const syncPollRef = useRef(null);

  const loadBuyers = useCallback(async () => {
    const res = await apiFetch(`/api/buyers/calllist?sort=${sort}&group=${group}`, token);
    if (res.ok) setData(await res.json());
  }, [token, sort, group]);

  useEffect(() => {
    setLoading(true);
    loadBuyers().finally(() => setLoading(false));
  }, [sort, group, token]);

  // Poll sync status while running
  useEffect(() => {
    if (!syncing) return;
    syncPollRef.current = setInterval(async () => {
      const res = await apiFetch('/api/buyers/sync/status', token);
      if (!res.ok) return;
      const s = await res.json();
      if (!s.running) {
        clearInterval(syncPollRef.current);
        setSyncing(false);
        const last = s.log[s.log.length - 1] || '';
        setSyncMsg(s.exitCode === 0 ? '✅ Sync complete' : `⚠️ Sync ended: ${last}`);
        await loadBuyers();
        setTimeout(() => setSyncMsg(''), 5000);
      }
    }, 3000);
    return () => clearInterval(syncPollRef.current);
  }, [syncing, token, loadBuyers]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('Syncing with AgentBox…');
    await apiFetch('/api/buyers/sync', token, { method: 'POST' });
  };

  const toggleExpand = (addr) => setExpandedListings(prev => ({ ...prev, [addr]: !prev[addr] }));

  const logBuyerOutcome = async (buyerId, outcome) => {
    try {
      await apiFetch(`/api/buyers/${buyerId}/outcome`, token, {
        method: 'PATCH',
        body: JSON.stringify({ outcome, notes: '' })
      });
      setOutcomeTarget(null);
      await loadBuyers();
    } catch (err) { console.error(err); }
  };

  const markDone = async (buyerId, address) => {
    try {
      await apiFetch(`/api/buyers/${buyerId}/done`, token, { method: 'PATCH' });
      await loadBuyers();
    } catch (err) { console.error(err); }
  };

  if (loading) return <div className="loading-state"><div className="spinner" /></div>;

  const activeEntries = Object.entries(data.active || {});

  return (
    <div className="page-body">
      <div className="buyers-toolbar">
        <div className="buyers-control-group">
          <span className="buyers-control-label">SORT</span>
          <div className="buyers-toggle">
            <button className={`buyers-toggle-btn ${sort === 'newest' ? 'active' : ''}`} onClick={() => setSort('newest')}>Newest</button>
            <button className={`buyers-toggle-btn ${sort === 'oldest' ? 'active' : ''}`} onClick={() => setSort('oldest')}>Oldest</button>
          </div>
        </div>
        <div className="buyers-control-group">
          <span className="buyers-control-label">GROUP BY</span>
          <div className="buyers-toggle">
            <button className={`buyers-toggle-btn ${group === 'listing' ? 'active' : ''}`} onClick={() => setGroup('listing')}>Listing</button>
            <button className={`buyers-toggle-btn ${group === 'type' ? 'active' : ''}`} onClick={() => setGroup('type')}>Type</button>
          </div>
        </div>
        <button className="topup-btn" onClick={handleSync} disabled={syncing} style={{ marginLeft: 'auto' }}>
          {syncing ? 'Syncing…' : '↻ Sync from AgentBox'}
        </button>
        {syncMsg && <span className="sync-msg">{syncMsg}</span>}
      </div>

      {group === 'listing' ? (
        activeEntries.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Users size={32} /></div>
            <div className="empty-state-title">No active buyer enquiries</div>
            <div className="empty-state-sub">Press "Sync from AgentBox" to pull the latest enquiries</div>
          </div>
        ) : (
          activeEntries.map(([addr, groupData]) => {
            const buyers = groupData.buyers || [];
            const listing = groupData.listing || {};
            return (
              <div className="listing-group" key={addr}>
                <div className="listing-group-header" onClick={() => toggleExpand(addr)}>
                  <MapPin size={13} style={{ color: 'var(--gold)', flexShrink: 0 }} />
                  <span className="listing-group-addr">{addr}</span>
                  <span className="listing-group-count">{buyers.length} buyer{buyers.length !== 1 ? 's' : ''}</span>
                  <div className="listing-group-meta">
                    {listing.beds && <span className="listing-meta-chip"><Bed size={10}/> {listing.beds}</span>}
                    {listing.baths && <span className="listing-meta-chip"><Bath size={10}/> {listing.baths}</span>}
                    {listing.cars && <span className="listing-meta-chip"><Car size={10}/> {listing.cars}</span>}
                    {listing.price_guide && <span className="listing-price-chip">{listing.price_guide}</span>}
                  </div>
                  {expandedListings[addr] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </div>
                {expandedListings[addr] && (
                  <div className="listing-detail-panel">
                    {listing.headline && <div className="listing-detail-headline">{listing.headline}</div>}
                    <div className="listing-detail-stats">
                      {listing.land_area && <div className="listing-stat"><span className="listing-stat-label">LAND</span><span>{listing.land_area}</span></div>}
                      {listing.building_area && <div className="listing-stat"><span className="listing-stat-label">BUILDING</span><span>{listing.building_area}</span></div>}
                      {listing.method && <div className="listing-stat"><span className="listing-stat-label">METHOD</span><span>{listing.method}</span></div>}
                      {listing.auction_date && <div className="listing-stat"><span className="listing-stat-label">AUCTION</span><span>{new Date(listing.auction_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>}
                      {listing.council_rates && <div className="listing-stat"><span className="listing-stat-label">COUNCIL</span><span>${listing.council_rates}</span></div>}
                      {listing.water_rates && <div className="listing-stat"><span className="listing-stat-label">WATER</span><span>${listing.water_rates}</span></div>}
                      {listing.strata_total && listing.strata_total !== '0 / quarter' && <div className="listing-stat"><span className="listing-stat-label">STRATA</span><span>${listing.strata_total}</span></div>}
                    </div>
                    {listing.description && (
                      <div className="listing-detail-desc">{listing.description}</div>
                    )}
                    {listing.web_link && (
                      <a className="listing-detail-link" href={listing.web_link} target="_blank" rel="noopener noreferrer">View on McGrath →</a>
                    )}
                  </div>
                )}
                {buyers.map(buyer => (
                  <div className="buyer-row" key={buyer.id}>
                    <div className="buyer-row-main">
                      <div className="buyer-name">{buyer.buyer_name || 'Unknown'}</div>
                      <div className="buyer-row-meta">
                        {buyer.enquiry_date && (
                          <span className="buyer-date">
                            <Calendar size={9} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                            {new Date(buyer.enquiry_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                        {buyer.enquiry_type && (
                          <span className={`buyer-type-badge buyer-type-${buyer.enquiry_type}`}>{buyer.enquiry_type.replace(/_/g, ' ')}</span>
                        )}
                      </div>
                    </div>
                    {(buyer.buyer_mobile || buyer.mobile) && (
                      <a className="buyer-mobile" href={`tel:${buyer.buyer_mobile || buyer.mobile}`}>
                        <Phone size={11} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                        {buyer.buyer_mobile || buyer.mobile}
                      </a>
                    )}
                    {outcomeTarget === buyer.id ? (
                      <div className="buyer-actions">
                        {['interested', 'not_interested', 'no_answer', 'left_message', 'appointment_booked'].map(o => (
                          <button key={o} className="icon-btn" style={{ fontSize: 9, padding: '2px 6px' }} onClick={() => logBuyerOutcome(buyer.id, o)}>
                            {o.replace(/_/g, ' ')}
                          </button>
                        ))}
                        <button className="icon-btn danger" onClick={() => setOutcomeTarget(null)}><X size={12} /></button>
                      </div>
                    ) : (
                      <div className="buyer-actions">
                        <button className="icon-btn" title="Log outcome" onClick={() => setOutcomeTarget(buyer.id)}><PhoneCall size={13} /></button>
                        <button className="icon-btn danger" title="Mark done" onClick={() => markDone(buyer.id, addr)}><Check size={13} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })
        )
      ) : (
        /* group === 'type' view */
        ['inspection', 'online_enquiry', 'callback', 'other'].map(type => {
          const buyers = data.active[type] || [];
          if (!buyers.length) return null;
          return (
            <div className="type-group" key={type}>
              <div className="type-group-header">
                <span className={`type-group-badge buyer-type-badge buyer-type-${type}`}>{type.replace(/_/g, ' ')}</span>
                <span className="listing-group-count">{buyers.length} buyer{buyers.length !== 1 ? 's' : ''}</span>
              </div>
              {buyers.map(buyer => (
                <div className="buyer-row" key={buyer.id}>
                  <div className="buyer-row-main">
                    <div className="buyer-name">{buyer.buyer_name || 'Unknown'}</div>
                    <div className="buyer-row-meta">
                      <span className="buyer-listing-ref">{buyer.listing_address}</span>
                      {buyer.enquiry_date && <span className="buyer-date"><Calendar size={9}/> {new Date(buyer.enquiry_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                  {(buyer.buyer_mobile || buyer.mobile) && (
                    <a className="buyer-mobile" href={`tel:${buyer.buyer_mobile || buyer.mobile}`}><Phone size={11}/> {buyer.buyer_mobile || buyer.mobile}</a>
                  )}
                  <div className="buyer-actions">
                    <button className="icon-btn" title="Log outcome" onClick={() => setOutcomeTarget(buyer.id)}><PhoneCall size={13} /></button>
                    <button className="icon-btn danger" title="Mark done" onClick={() => markDone(buyer.id, buyer.listing_address || '')}><Check size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          );
        })
      )}

      {Object.keys(data.archived || {}).length > 0 && (
        <div className="archived-section">
          <button className="archived-toggle" onClick={() => setShowArchived(v => !v)}>
            {showArchived ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
            <span>Archived Listings</span>
            <span className="listing-group-count">{Object.values(data.archived).reduce((n, g) => n + (g.buyers || g).length, 0)} buyer{Object.values(data.archived).reduce((n, g) => n + (g.buyers || g).length, 0) !== 1 ? 's' : ''} across {Object.keys(data.archived).length} listing{Object.keys(data.archived).length !== 1 ? 's' : ''}</span>
          </button>
          {showArchived && (
            <div className="archived-content">
              {Object.entries(data.archived).map(([addr, groupData]) => {
                const buyers = group === 'listing' ? groupData.buyers || [] : [];
                const listing = group === 'listing' ? groupData.listing || {} : {};
                return (
                  <div className="listing-group archived-listing" key={addr}>
                    <div className="listing-group-header" onClick={() => toggleExpand('archived_' + addr)}>
                      <MapPin size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span className="listing-group-addr" style={{ color: 'var(--text-muted)' }}>{addr}</span>
                      <span className="listing-group-count">{buyers.length} buyer{buyers.length !== 1 ? 's' : ''}</span>
                      <span className="archived-status-badge">WITHDRAWN</span>
                    </div>
                    {expandedListings['archived_' + addr] && listing.headline && (
                      <div className="listing-detail-panel" style={{ opacity: 0.7 }}>
                        <div className="listing-detail-headline">{listing.headline}</div>
                      </div>
                    )}
                    {buyers.map(buyer => (
                      <div className="buyer-row" key={buyer.id} style={{ opacity: 0.6 }}>
                        <div className="buyer-row-main">
                          <div className="buyer-name">{buyer.buyer_name || 'Unknown'}</div>
                          <div className="buyer-row-meta">
                            {buyer.enquiry_date && <span className="buyer-date"><Calendar size={9}/> {new Date(buyer.enquiry_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                            {buyer.enquiry_type && <span className={`buyer-type-badge buyer-type-${buyer.enquiry_type}`}>{buyer.enquiry_type.replace(/_/g, ' ')}</span>}
                          </div>
                        </div>
                        {(buyer.buyer_mobile || buyer.mobile) && (
                          <a className="buyer-mobile" href={`tel:${buyer.buyer_mobile || buyer.mobile}`}><Phone size={11}/> {buyer.buyer_mobile || buyer.mobile}</a>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
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

// ── Search Card ────────────────────────────────────────────────────────────
function SearchCard({ prop, token, onAddedToPlan }) {
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
        <EditContactModal
          contact={{ id: contactId, name: prop.crm_name || prop.owner_name || '', mobile: prop.contact_mobile || '', address: prop.address || '', suburb: prop.suburb || '', do_not_call: prop.do_not_call ? 1 : 0 }}
          token={token}
          onSaved={() => setShowEdit(false)}
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
              <option value="willoughby east">Willoughby East</option>
              <option value="north willoughby">North Willoughby</option>
              <option value="willoughby">Willoughby</option>
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
        </div>
      </div>

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
            <SearchCard key={prop.property_id || i} prop={prop} token={token} />
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
    { id: 'reminders', label: 'Reminders', Icon: Bell, badge: reminderCount > 0 ? reminderCount : null },
    { id: 'search', label: 'Search', Icon: Search },
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
    search: 'Search',
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
    { id: 'search', label: 'Search', Icon: Search },
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
function JarvisChat({ token }) {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [thinking, setThinking] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const bottomRef     = useRef(null);
  const inputRef      = useRef(null);
  const actionTimerRef = useRef(null);

  useEffect(() => {
    if (open && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => () => clearTimeout(actionTimerRef.current), []);

  const send = useCallback(async () => {
    const text = input.trim();
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
        if (data.action?.type === 'price_updated') {
          setActionMsg(`✅ Price recorded for event #${data.action.event_id}: ${data.action.price}`);
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
  }, [input, messages, thinking, token]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className="jarvis-chat-fab"
        title="Chat with Jarvis"
      >
        {open ? <X size={20} /> : <MessageSquare size={20} />}
      </button>

      {open && (
        <div className="jarvis-chat-panel">
          <div className="jarvis-chat-header">
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
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '24px 12px', lineHeight: 1.6 }}>
                Ask me about recent sales, comparable prices, or talking points for prospecting calls.<br/>
                <span style={{ fontSize: 10, opacity: 0.6 }}>You can also say "49 Penshurst sold for $1.2M" to record a price.</span>
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
              onClick={send}
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

// ── App ────────────────────────────────────────────────────────────────────
function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('jarvis_token') || '');
  const [page, setPage] = useState('calls');
  const [remainingCount, setRemainingCount] = useState(0);
  const [reminderCount, setReminderCount] = useState(0);
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
    search: { title: 'Property Search', subtitle: 'CRM + PRICEFINDER — CONTACTS & PROPERTIES' },
    history: { title: 'Call History', subtitle: 'TODAY\'S LOGGED OUTCOMES' }
  };
  const pt = pageTitles[page] || pageTitles.calls;

  const renderPage = () => {
    switch (page) {
      case 'calls':     return <CallsPage token={token} onReminderCountChange={setReminderCount} />;
      case 'market':    return <MarketPage token={token} />;
      case 'buyers':    return <BuyersPage token={token} />;
      case 'reminders': return <RemindersPage token={token} />;
      case 'search':    return <SearchPage token={token} />;
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
