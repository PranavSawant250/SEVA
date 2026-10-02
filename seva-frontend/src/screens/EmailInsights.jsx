import React, { useEffect, useState, useCallback } from 'react';
import { 
  Mail, 
  RefreshCw, 
  Check, 
  X, 
  AlertCircle, 
  Inbox, 
  User, 
  CheckCircle2, 
  XCircle,
  Tag
} from 'lucide-react';
import client from '../api/client';
import { getPriorityBadgeClass, getEventTypeBadgeClass } from '../utils/themeUtils';

export default function EmailInsights() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [emails, setEmails] = useState([]);
  const [activeTab, setActiveTab] = useState('pending'); // 'pending' | 'processed'
  
  // Action Loading States
  const [actionLoading, setActionLoading] = useState({}); // { [emailId]: 'accepting' | 'dismissing' }
  const [fetchingEmails, setFetchingEmails] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState('');

  // Fetch emails from GET /api/emails/today
  const fetchEmails = useCallback(async () => {
    setErrorMsg('');
    try {
      const res = await client.get('/emails/today');
      if (res.data.success) {
        setEmails(res.data.emails || []);
      } else {
        setErrorMsg('Failed to load email insights.');
      }
    } catch (err) {
      console.error('[SEVA] Error fetching emails:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Unable to fetch email insights from backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  // Action: Trigger Sync & AI Analysis
  const handleFetchAndAnalyze = async () => {
    setFetchingEmails(true);
    setSyncStatusMsg('Syncing Gmail & running AI analysis with Ollama / Phi-3.5...');
    setErrorMsg('');

    try {
      // Step 1: Fetch recent emails from Gmail & automatically analyze via AI
      const fetchRes = await client.get('/emails/fetch');
      
      setSyncStatusMsg('Sync complete! Refreshing email insights...');
      await fetchEmails();
    } catch (err) {
      console.error('[SEVA] Email fetch/analyze error:', err);
      setErrorMsg(err.response?.data?.error || err.response?.data?.message || err.message || 'Email fetch & analysis failed.');
    } finally {
      setFetchingEmails(false);
      setSyncStatusMsg('');
    }
  };

  // Action: Accept Email (POST /api/emails/accept/:id)
  const handleAccept = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'accepting' }));
    try {
      const res = await client.post(`/emails/accept/${id}`);
      if (res.data.success) {
        // Update local stateoptimistically
        setEmails(prev => prev.map(e => e.id === id ? { ...e, accepted: 1 } : e));
      } else {
        alert(res.data.error || 'Failed to accept email.');
      }
    } catch (err) {
      console.error('[SEVA] Email accept error:', err);
      alert('Failed to accept email: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Action: Dismiss Email (POST /api/emails/dismiss/:id)
  const handleDismiss = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'dismissing' }));
    try {
      const res = await client.post(`/emails/dismiss/${id}`);
      if (res.data.success) {
        // Update local state
        setEmails(prev => prev.map(e => e.id === id ? { ...e, accepted: 2 } : e));
      } else {
        alert(res.data.error || 'Failed to dismiss email.');
      }
    } catch (err) {
      console.error('[SEVA] Email dismiss error:', err);
      alert('Failed to dismiss email: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Filtered views
  const pendingEmails = emails.filter(e => e.accepted === 0);
  const processedEmails = emails.filter(e => e.accepted !== 0);
  const displayedEmails = activeTab === 'pending' ? pendingEmails : processedEmails;

  // ── STATE 1: LOADING ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Scanning & analyzing email insights...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl pb-10">
      
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <Mail size={26} style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.5))' }} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-3xl text-text-primary">Email Insights</h1>
            <p className="text-text-secondary text-xs mt-0.5">AI workload extraction from your synced Gmail inbox</p>
          </div>
        </div>

        {/* Sync Button */}
        <button
          onClick={handleFetchAndAnalyze}
          disabled={fetchingEmails}
          className="px-4 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50 self-start sm:self-auto"
        >
          <RefreshCw size={16} className={fetchingEmails ? 'animate-spin' : ''} />
          <span>{fetchingEmails ? 'Syncing Gmail & AI...' : 'Fetch New Emails'}</span>
        </button>
      </div>

      {/* Sync Status Banner */}
      {syncStatusMsg && (
        <div className="p-4 bg-accent/10 border border-accent/40 rounded-xl flex items-center gap-3 text-accent text-xs animate-pulse">
          <RefreshCw size={16} className="animate-spin shrink-0" />
          <span>{syncStatusMsg}</span>
        </div>
      )}

      {/* ── STATE 2: ERROR ── */}
      {errorMsg && (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <div className="flex items-center gap-2">
            {(errorMsg.toLowerCase().includes('expired') || errorMsg.toLowerCase().includes('authenticated') || errorMsg.toLowerCase().includes('invalid_grant')) && (
              <a
                href="http://localhost:3001/api/auth/gmail"
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg border border-accent/40 text-[11px] font-medium transition-all"
              >
                Re-authenticate Google
              </a>
            )}
            <button
              onClick={fetchEmails}
              className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/40 text-[11px] font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Tabs Navigation ── */}
      <div className="flex items-center justify-between border-b border-gray-800 pb-1">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('pending')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 border-b-2 ${
              activeTab === 'pending'
                ? 'border-accent text-accent bg-accent/5'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            <Inbox size={14} />
            <span>Pending ({pendingEmails.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('processed')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 border-b-2 ${
              activeTab === 'processed'
                ? 'border-accent text-accent bg-accent/5'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            <CheckCircle2 size={14} />
            <span>Processed ({processedEmails.length})</span>
          </button>
        </div>
      </div>

      {/* ── STATE 3: EMPTY STATE ── */}
      {displayedEmails.length === 0 ? (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-12 text-center space-y-4">
          <Inbox className="mx-auto text-text-secondary opacity-40" size={48} />
          <div className="space-y-1">
            <h3 className="font-heading font-semibold text-lg text-text-primary">
              {activeTab === 'pending' ? 'No Pending Email Insights' : 'No Processed Emails'}
            </h3>
            <p className="text-text-secondary text-xs max-w-sm mx-auto">
              {activeTab === 'pending'
                ? 'All incoming emails have been accepted into your tasks or dismissed.'
                : 'Emails you accept or dismiss will be archived here.'}
            </p>
          </div>
          {activeTab === 'pending' && (
            <button
              onClick={handleFetchAndAnalyze}
              disabled={fetchingEmails}
              className="px-4 py-2 bg-dark-bg hover:bg-gray-800 text-accent border border-accent/40 rounded-xl text-xs font-medium inline-flex items-center gap-2 transition-all cursor-pointer"
            >
              <RefreshCw size={14} />
              <span>Fetch Recent Gmail Messages</span>
            </button>
          )}
        </div>
      ) : (
        /* ── Emails Card Grid / List ── */
        <div className="space-y-4">
          {displayedEmails.map((email) => (
            <div 
              key={email.id}
              className={`bg-card-bg border rounded-2xl p-5 space-y-4 transition-all ${
                email.accepted === 1 
                  ? 'border-emerald-500/30 bg-emerald-950/10' 
                  : email.accepted === 2 
                  ? 'border-gray-800/80 opacity-60' 
                  : 'border-gray-800 hover:border-accent/40 shadow-lg'
              }`}
            >
              {/* Header: Sender & Badges */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-800/60 pb-3">
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <User size={14} className="text-accent" />
                  <span className="font-medium text-text-primary">{email.sender || 'Unknown Sender'}</span>
                  {email.date && <span className="text-gray-600">• {email.date}</span>}
                </div>

                <div className="flex items-center gap-2">
                  {/* Event Type Badge */}
                  <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full ${getEventTypeBadgeClass(email.event_type)}`}>
                    {email.event_type || 'General'}
                  </span>
                  
                  {/* Priority Badge */}
                  <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full ${getPriorityBadgeClass(email.priority)}`}>
                    {email.priority || 'medium'}
                  </span>
                </div>
              </div>

              {/* Email Body & Summary */}
              <div className="space-y-2">
                <h3 className="font-heading font-semibold text-base text-text-primary leading-snug">
                  {email.subject}
                </h3>
                {email.summary && (
                  <p className="text-text-secondary text-xs leading-relaxed bg-dark-bg/60 p-3 rounded-xl border border-gray-800/80">
                    <span className="font-semibold text-accent/90">AI Summary: </span>
                    {email.summary}
                  </p>
                )}
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-between pt-1">
                {email.accepted === 0 ? (
                  <div className="flex items-center gap-3 w-full justify-end">
                    <button
                      onClick={() => handleDismiss(email.id)}
                      disabled={actionLoading[email.id] === 'dismissing'}
                      className="px-4 py-2 bg-dark-bg hover:bg-red-950/40 text-red-400 border border-gray-800 hover:border-red-500/40 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                    >
                      <X size={14} />
                      <span>{actionLoading[email.id] === 'dismissing' ? 'Dismissing...' : 'Dismiss'}</span>
                    </button>

                    <button
                      onClick={() => handleAccept(email.id)}
                      disabled={actionLoading[email.id] === 'accepting'}
                      className="px-4 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-md shadow-accent/20 cursor-pointer disabled:opacity-50"
                    >
                      <Check size={14} />
                      <span>{actionLoading[email.id] === 'accepting' ? 'Accepting...' : 'Accept Task'}</span>
                    </button>
                  </div>
                ) : email.accepted === 1 ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/30">
                    <CheckCircle2 size={14} />
                    <span>Accepted into Task Queue</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-gray-400 font-semibold bg-gray-800/60 px-3 py-1 rounded-full border border-gray-700">
                    <XCircle size={14} />
                    <span>Dismissed</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
