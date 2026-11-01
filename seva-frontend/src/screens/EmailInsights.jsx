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
  ShieldAlert,
  ThumbsUp,
  ThumbsDown,
  Eye,
  Calendar,
  Trash2
} from 'lucide-react';
import client from '../api/client';
import { getPriorityBadgeClass } from '../utils/themeUtils';

export default function EmailInsights() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [emails, setEmails] = useState([]);
  const [activeTab, setActiveTab] = useState('pending'); // 'pending' | 'processed'
  const [filterMode, setFilterMode] = useState('important'); // 'important' | 'all' | 'defaulter' | 'personal'
  
  // Action Loading States
  const [actionLoading, setActionLoading] = useState({}); // { [emailId]: 'action_name' }
  const [fetchingEmails, setFetchingEmails] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState('');
  const [selectedEmailDetail, setSelectedEmailDetail] = useState(null);

  // Fetch emails from GET /api/emails/today with filter
  const fetchEmails = useCallback(async (currentFilter = filterMode) => {
    setErrorMsg('');
    try {
      const res = await client.get(`/emails/today?filter=${currentFilter}`);
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
  }, [filterMode]);

  useEffect(() => {
    fetchEmails(filterMode);
  }, [fetchEmails, filterMode]);

  // Action: Trigger Sync & AI Analysis
  const handleFetchAndAnalyze = async () => {
    setFetchingEmails(true);
    setSyncStatusMsg('Syncing Gmail & running personalized AI analysis...');
    setErrorMsg('');

    try {
      await client.get('/emails/fetch');
      setSyncStatusMsg('Sync complete! Refreshing email insights...');
      await fetchEmails(filterMode);
    } catch (err) {
      console.error('[SEVA] Email fetch/analyze error:', err);
      setErrorMsg(err.response?.data?.error || err.response?.data?.message || err.message || 'Email fetch & analysis failed.');
    } finally {
      setFetchingEmails(false);
      setSyncStatusMsg('');
    }
  };

  // Action: Accept Email (for genuine invitations only)
  const handleAccept = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'accepting' }));
    try {
      const res = await client.post(`/emails/accept/${id}`);
      if (res.data.success) {
        setEmails(prev => prev.map(e => e.id === id ? { ...e, accepted: 1 } : e));
      } else {
        alert(res.data.message || res.data.error || 'Failed to accept email.');
      }
    } catch (err) {
      console.error('[SEVA] Email accept error:', err);
      alert('Failed to accept email: ' + (err.response?.data?.message || err.response?.data?.error || err.message));
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Action: Dismiss Email from SEVA
  const handleDismiss = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'dismissing' }));
    try {
      const res = await client.post(`/emails/dismiss/${id}`);
      if (res.data.success) {
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

  // Action: Permanently Delete Email
  const handleDeleteEmail = async (id) => {
    if (!window.confirm('Are you sure you want to remove this email?')) return;
    setActionLoading(prev => ({ ...prev, [id]: 'deleting' }));
    try {
      const res = await client.delete(`/emails/${id}`);
      if (res.data.success) {
        setEmails(prev => prev.filter(e => e.id !== id));
      } else {
        alert(res.data.error || 'Failed to remove email.');
      }
    } catch (err) {
      console.error('[SEVA] Error removing email:', err);
      alert('Failed to remove email: ' + (err.response?.data?.error || err.message));
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Action: Mark as Reviewed (for attendance & academic notices)
  const handleMarkReviewed = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'reviewing' }));
    try {
      const res = await client.post(`/emails/${id}/review`);
      if (res.data.success) {
        setEmails(prev => prev.map(e => e.id === id ? { ...e, reviewed: 1 } : e));
      }
    } catch (err) {
      console.error('[SEVA] Error marking reviewed:', err);
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Action: Dismiss Alert (from active alerts list)
  const handleDismissAlert = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'dismissing_alert' }));
    try {
      const res = await client.post(`/emails/${id}/dismiss-alert`);
      if (res.data.success) {
        setEmails(prev => prev.map(e => e.id === id ? { ...e, dismissed: 1 } : e));
      }
    } catch (err) {
      console.error('[SEVA] Error dismissing alert:', err);
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // Action: User Feedback (Important / Not Important)
  const handleFeedback = async (id, feedbackType) => {
    try {
      const res = await client.post(`/emails/${id}/feedback`, { feedback_type: feedbackType });
      if (res.data.success) {
        setEmails(prev => prev.map(e => e.id === id ? { ...e, user_feedback: feedbackType } : e));
      }
    } catch (err) {
      console.error('[SEVA] Feedback error:', err);
    }
  };

  // Filtered views
  const pendingEmails = emails.filter(e => e.accepted === 0 && e.dismissed === 0);
  const processedEmails = emails.filter(e => e.accepted !== 0 || e.dismissed === 1 || e.reviewed === 1);
  const displayedEmails = activeTab === 'pending' ? pendingEmails : processedEmails;

  const formatCategory = (cat) => {
    if (!cat) return 'General';
    return cat.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Scanning & analyzing personalized email insights...</p>
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
            <p className="text-text-secondary text-xs mt-0.5">Personalized academic and task alerts for Pranav Sawant (PRN: 246100104)</p>
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

      {/* Error Message */}
      {errorMsg && (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={() => fetchEmails(filterMode)}
            className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/40 text-[11px] font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Filter Bar & Tabs Navigation ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-2">
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
            <span>Active Alerts ({pendingEmails.length})</span>
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
            <span>Reviewed / Archived ({processedEmails.length})</span>
          </button>
        </div>

        {/* Filter Mode Pills */}
        <div className="flex items-center gap-1.5 bg-dark-bg p-1 rounded-xl border border-gray-800 text-xs self-start sm:self-auto">
          <button
            onClick={() => setFilterMode('important')}
            className={`px-3 py-1 rounded-lg font-medium transition-all cursor-pointer ${
              filterMode === 'important' ? 'bg-accent text-dark-bg font-semibold' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Important (Default)
          </button>
          <button
            onClick={() => setFilterMode('personal')}
            className={`px-3 py-1 rounded-lg font-medium transition-all cursor-pointer ${
              filterMode === 'personal' ? 'bg-accent text-dark-bg font-semibold' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Personal Only
          </button>
          <button
            onClick={() => setFilterMode('all')}
            className={`px-3 py-1 rounded-lg font-medium transition-all cursor-pointer ${
              filterMode === 'all' ? 'bg-accent text-dark-bg font-semibold' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            All Emails
          </button>
        </div>
      </div>

      {/* ── Empty State ── */}
      {displayedEmails.length === 0 ? (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-12 text-center space-y-4">
          <Inbox className="mx-auto text-text-secondary opacity-40" size={48} />
          <div className="space-y-1">
            <h3 className="font-heading font-semibold text-lg text-text-primary">
              {activeTab === 'pending' ? 'No Pending Important Alerts' : 'No Processed Emails'}
            </h3>
            <p className="text-text-secondary text-xs max-w-sm mx-auto">
              {activeTab === 'pending'
                ? 'All important emails and academic alerts have been reviewed or resolved.'
                : 'Emails you accept, review, or dismiss will be stored here.'}
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
        /* ── Email Cards ── */
        <div className="space-y-4">
          {displayedEmails.map((email) => {
            const isPersonal = Boolean(email.is_personal);
            const isInvitation = Boolean(email.is_invitation);

            return (
              <div 
                key={email.id}
                className={`bg-card-bg border rounded-2xl p-5 space-y-4 transition-all relative ${
                  isPersonal
                    ? 'border-amber-500/50 bg-gradient-to-br from-card-bg via-amber-950/10 to-card-bg shadow-amber-500/10 shadow-lg'
                    : email.accepted === 1 
                    ? 'border-emerald-500/30 bg-emerald-950/10' 
                    : email.dismissed === 1
                    ? 'border-gray-800/80 opacity-60'
                    : 'border-gray-800 hover:border-accent/40 shadow-lg'
                }`}
              >
                {/* Personal Relevance Ribbon */}
                {isPersonal && (
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-xl w-fit">
                    <ShieldAlert size={14} className="text-amber-400 shrink-0" />
                    <span>Personally Relevant: {email.matched_identity || 'Student ID Match'}</span>
                  </div>
                )}

                {/* Header: Sender & Badges */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-800/60 pb-3">
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <User size={14} className="text-accent" />
                    <span className="font-medium text-text-primary">{email.sender || 'Unknown Sender'}</span>
                    {email.date && <span className="text-gray-600">• {email.date}</span>}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Importance Category Badge */}
                    <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
                      {formatCategory(email.importance_category)}
                    </span>

                    {/* Priority Badge */}
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full ${getPriorityBadgeClass(email.priority)}`}>
                      {email.priority || 'medium'}
                    </span>
                  </div>
                </div>

                {/* Email Subject & Summary */}
                <div className="space-y-2">
                  <h3 className="font-heading font-semibold text-base text-text-primary leading-snug">
                    {email.subject}
                  </h3>
                  {email.summary && (
                    <div className="text-text-secondary text-xs leading-relaxed bg-dark-bg/60 p-3 rounded-xl border border-gray-800/80">
                      <span className="font-semibold text-accent/90">SEVA Insight: </span>
                      {email.summary}
                    </div>
                  )}
                </div>

                {/* Footer Controls */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-gray-800/50">
                  {/* User Feedback controls */}
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <span className="text-[11px]">Relevance feedback:</span>
                    <button
                      onClick={() => handleFeedback(email.id, 'important')}
                      title="Mark as Important"
                      className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                        email.user_feedback === 'important'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                          : 'border-gray-800 hover:border-gray-700 hover:text-emerald-400'
                      }`}
                    >
                      <ThumbsUp size={13} />
                    </button>
                    <button
                      onClick={() => handleFeedback(email.id, 'not_important')}
                      title="Mark as Not Important"
                      className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                        email.user_feedback === 'not_important'
                          ? 'bg-red-500/20 text-red-400 border-red-500/40'
                          : 'border-gray-800 hover:border-gray-700 hover:text-red-400'
                      }`}
                    >
                      <ThumbsDown size={13} />
                    </button>
                    {email.user_feedback && (
                      <span className="text-[10px] text-gray-500 capitalize">({email.user_feedback})</span>
                    )}
                  </div>

                  {/* Context-aware Actions */}
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    {/* View Details modal toggle */}
                    <button
                      onClick={() => setSelectedEmailDetail(email)}
                      className="px-3 py-1.5 bg-dark-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-800 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
                    >
                      <Eye size={13} />
                      <span>View Details</span>
                    </button>

                    {/* Controls based on email type */}
                    {isInvitation ? (
                      /* Genuine Calendar/Meeting Invitation: Show Accept & Dismiss */
                      <>
                        <button
                          onClick={() => handleDismiss(email.id)}
                          disabled={actionLoading[email.id] === 'dismissing'}
                          className="px-3 py-1.5 bg-dark-bg hover:bg-red-950/40 text-red-400 border border-gray-800 hover:border-red-500/40 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                        >
                          <X size={13} />
                          <span>Dismiss</span>
                        </button>
                        <button
                          onClick={() => handleAccept(email.id)}
                          disabled={actionLoading[email.id] === 'accepting'}
                          className="px-3 py-1.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-md shadow-accent/20 cursor-pointer disabled:opacity-50"
                        >
                          <Calendar size={13} />
                          <span>Accept Invite</span>
                        </button>
                      </>
                    ) : (
                      /* Academic Warning, Defaulter Notice, or College Notice: Show Mark Reviewed & Dismiss Alert */
                      <>
                        {email.reviewed ? (
                          <span className="text-xs text-emerald-400 flex items-center gap-1 bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/30">
                            <CheckCircle2 size={13} /> Reviewed
                          </span>
                        ) : (
                          <button
                            onClick={() => handleMarkReviewed(email.id)}
                            disabled={actionLoading[email.id] === 'reviewing'}
                            className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <Check size={13} />
                            <span>Mark Reviewed</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDismissAlert(email.id)}
                          disabled={actionLoading[email.id] === 'dismissing_alert'}
                          className="px-3 py-1.5 bg-dark-bg hover:bg-gray-800 text-text-secondary border border-gray-800 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
                        >
                          <X size={13} />
                          <span>Dismiss Alert</span>
                        </button>
                      </>
                    )}

                    {/* Remove / Delete Email button */}
                    <button
                      onClick={() => handleDeleteEmail(email.id)}
                      disabled={actionLoading[email.id] === 'deleting'}
                      title="Remove from Email Insights"
                      className="p-1.5 bg-dark-bg hover:bg-red-950/40 text-text-secondary hover:text-red-400 border border-gray-800 hover:border-red-500/40 rounded-xl text-xs transition-all cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── View Details Modal ── */}
      {selectedEmailDetail && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card-bg border border-gray-800 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 pb-3">
              <h3 className="font-heading font-bold text-lg text-text-primary">Email Record Details</h3>
              <button 
                onClick={() => setSelectedEmailDetail(null)}
                className="text-text-secondary hover:text-text-primary p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="space-y-3 text-xs">
              <div>
                <span className="text-text-secondary block font-semibold mb-1">Subject:</span>
                <p className="text-text-primary bg-dark-bg p-2.5 rounded-lg border border-gray-800">{selectedEmailDetail.subject}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-text-secondary block font-semibold mb-1">Sender:</span>
                  <p className="text-text-primary bg-dark-bg p-2 rounded-lg border border-gray-800 truncate">{selectedEmailDetail.sender}</p>
                </div>
                <div>
                  <span className="text-text-secondary block font-semibold mb-1">Date:</span>
                  <p className="text-text-primary bg-dark-bg p-2 rounded-lg border border-gray-800">{selectedEmailDetail.date || 'Today'}</p>
                </div>
              </div>
              <div>
                <span className="text-text-secondary block font-semibold mb-1">Extracted Preview:</span>
                <p className="text-text-primary bg-dark-bg p-3 rounded-lg border border-gray-800 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                  {selectedEmailDetail.body_preview || '(No body preview available)'}
                </p>
              </div>
              {selectedEmailDetail.matched_identity && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-300">
                  <span className="font-semibold block mb-0.5">Personal Identity Match:</span>
                  <span>{selectedEmailDetail.matched_identity}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-gray-800">
              <button
                onClick={() => setSelectedEmailDetail(null)}
                className="px-4 py-2 bg-dark-bg hover:bg-gray-800 text-text-primary border border-gray-700 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
