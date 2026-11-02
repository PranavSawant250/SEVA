import React, { useEffect, useState, useCallback } from 'react';
import {
  Moon,
  Sparkles,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Flame,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  Calendar
} from 'lucide-react';
import client from '../api/client';
import { getPriorityBadgeClass } from '../utils/themeUtils';

function getTodayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function NightSummary() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [allSummaries, setAllSummaries] = useState([]);
  const [selectedSummary, setSelectedSummary] = useState(null);
  const [generating, setGenerating] = useState(false);

  // Fetch all summaries — check if today's already exists
  const fetchSummaries = useCallback(async () => {
    setErrorMsg('');
    try {
      const res = await client.get('/summary/history');
      if (res.data.success) {
        const summaries = res.data.summaries || [];
        setAllSummaries(summaries);

        // Auto-select today's summary if it exists
        const today = getTodayDate();
        const todaySummary = summaries.find(s => s.date === today);
        setSelectedSummary(todaySummary || null);
      } else {
        setErrorMsg('Failed to load summary history.');
      }
    } catch (err) {
      console.error('[SEVA] Summary history fetch error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Unable to reach SEVA backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummaries();
  }, [fetchSummaries]);

  const handleGenerate = async () => {
    setGenerating(true);
    setErrorMsg('');
    try {
      const res = await client.get('/summary/generate');
      if (res.data.success && res.data.summary) {
        // Re-fetch history so the new summary is included in the dropdown
        await fetchSummaries();
      } else {
        setErrorMsg(res.data.error || 'Summary generation returned no data.');
      }
    } catch (err) {
      console.error('[SEVA] Summary generate error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Failed to generate tonight\'s summary.');
    } finally {
      setGenerating(false);
    }
  };

  // ── STATE 1: LOADING ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Loading your night review...</p>
      </div>
    );
  }

  const today = getTodayDate();
  const todaySummaryExists = allSummaries.some(s => s.date === today);

  return (
    <div className="space-y-8 max-w-4xl pb-10">

      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-muted pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <Moon size={26} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-3xl text-text-primary">Night Summary</h1>
            <p className="text-text-secondary text-sm mt-0.5">Your daily progress report & carry-forward digest</p>
          </div>
        </div>

        {/* Past Summaries Dropdown */}
        {allSummaries.length > 0 && (
          <div className="relative">
            <div className="flex items-center gap-2 text-sm text-text-secondary bg-navy border border-muted px-3.5 py-2 rounded-xl">
              <Calendar size={16} className="text-accent" />
              <select
                value={selectedSummary?.date || ''}
                onChange={e => {
                  const found = allSummaries.find(s => s.date === e.target.value);
                  setSelectedSummary(found || null);
                }}
                className="bg-transparent text-text-primary focus:outline-none cursor-pointer pr-6 appearance-none font-medium"
              >
                {allSummaries.map(s => (
                  <option key={s.id} value={s.date} className="bg-navy text-text-primary">
                    {s.date}{s.date === today ? ' (Today)' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="text-text-secondary absolute right-3 pointer-events-none" />
            </div>
          </div>
        )}
      </div>

      {/* ── STATE 2: ERROR ── */}
      {errorMsg && (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-sm">
          <div className="flex items-center gap-2">
            <AlertCircle size={20} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={fetchSummaries}
            className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/40 text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── STATE 3: NO SUMMARY EXISTS FOR TODAY ── */}
      {!selectedSummary && !todaySummaryExists && (
        <div className="bg-card-bg border border-muted rounded-2xl p-12 text-center space-y-5">
          <div className="p-4 bg-accent/10 border border-accent/30 rounded-2xl text-accent w-fit mx-auto">
            <Moon size={44} />
          </div>
          <div className="space-y-2">
            <h3 className="font-heading font-semibold text-2xl text-text-primary">
              No Summary Yet Tonight
            </h3>
            <p className="text-text-secondary text-base max-w-md mx-auto leading-relaxed">
              When your day is winding down, generate your personal summary — SEVA will review what you completed, missed, and carry forward for tomorrow.
            </p>
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-6 py-3 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-base rounded-xl inline-flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
          >
            {generating ? (
              <>
                <div className="w-4 h-4 border-2 border-dark-bg border-t-transparent rounded-full animate-spin"></div>
                <span>Generating your summary with AI...</span>
              </>
            ) : (
              <>
                <Sparkles size={18} />
                <span>Generate Tonight's Summary</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* ── SUMMARY DISPLAY ── */}
      {selectedSummary && (
        <div className="space-y-6">

          {/* Viewing older date notice */}
          {selectedSummary.date !== today && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 text-sm font-medium flex items-center gap-2">
              <Calendar size={16} />
              <span>Viewing past summary for {selectedSummary.date}</span>
            </div>
          )}

          {/* ── SEVA Personal Message — CENTERPIECE ── */}
          <div className="relative bg-card-bg border border-accent/40 rounded-2xl p-8 text-center space-y-4">
            <div className="p-3 bg-accent/10 border border-accent/30 rounded-xl text-accent w-fit mx-auto">
              <Moon size={28} />
            </div>
            <p className="font-heading text-xl sm:text-2xl text-text-primary leading-relaxed font-semibold italic max-w-2xl mx-auto">
              "{selectedSummary.seva_message}"
            </p>
            <div className="text-sm text-text-secondary">— SEVA, your personal life orchestrator</div>
          </div>

          {/* ── Streak Counter ── */}
          <div className="flex justify-center">
            <div className="flex items-center gap-3 bg-card-bg border border-amber-500/40 rounded-2xl px-8 py-4">
              <Flame size={32} className="text-amber-400" />
              <div className="text-center">
                <div className="font-heading font-bold text-4xl text-amber-400">
                  {selectedSummary.streak}
                </div>
                <div className="text-sm text-amber-300/90 font-semibold uppercase tracking-wider">
                  Day Streak
                </div>
              </div>
            </div>
          </div>

          {/* ── Stats Row ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-card-bg border border-muted rounded-2xl p-5 text-center space-y-1">
              <div className="font-heading font-bold text-4xl text-emerald-400">
                {selectedSummary.completed_tasks?.length || 0}
              </div>
              <div className="text-sm text-text-secondary uppercase font-semibold tracking-wider">Completed</div>
            </div>
            <div className="bg-card-bg border border-muted rounded-2xl p-5 text-center space-y-1">
              <div className="font-heading font-bold text-4xl text-red-400">
                {selectedSummary.missed_tasks?.length || 0}
              </div>
              <div className="text-sm text-text-secondary uppercase font-semibold tracking-wider">Missed</div>
            </div>
            <div className="bg-card-bg border border-muted rounded-2xl p-5 text-center space-y-1 col-span-2 sm:col-span-1">
              <div className="font-heading font-bold text-4xl text-amber-400">
                {selectedSummary.carry_forward?.length || 0}
              </div>
              <div className="text-sm text-text-secondary uppercase font-semibold tracking-wider">Carrying Forward</div>
            </div>
          </div>

          {/* ── Completed Tasks List ── */}
          {selectedSummary.completed_tasks?.length > 0 && (
            <div className="bg-card-bg border border-muted rounded-2xl p-6 space-y-4">
              <h3 className="font-heading font-semibold text-lg text-text-primary flex items-center gap-2">
                <CheckCircle2 size={20} className="text-emerald-400" />
                Completed Today ({selectedSummary.completed_tasks.length})
              </h3>
              <div className="space-y-2">
                {selectedSummary.completed_tasks.map((task, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 p-3 bg-navy border border-muted rounded-xl">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <CheckCircle2 size={18} className="text-emerald-400 shrink-0" />
                      <span className="text-base font-medium text-text-primary truncate line-through opacity-80">{task.name}</span>
                    </div>
                    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${getPriorityBadgeClass(task.priority)}`}>
                      {task.priority}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Missed Tasks List ── */}
          {selectedSummary.missed_tasks?.length > 0 && (
            <div className="bg-card-bg border border-muted rounded-2xl p-6 space-y-4">
              <h3 className="font-heading font-semibold text-lg text-text-primary flex items-center gap-2">
                <XCircle size={20} className="text-red-400" />
                Missed Today ({selectedSummary.missed_tasks.length})
              </h3>
              <div className="space-y-2">
                {selectedSummary.missed_tasks.map((task, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 p-3 bg-navy border border-muted rounded-xl">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <XCircle size={18} className="text-red-400 shrink-0" />
                      <span className="text-base font-medium text-text-primary truncate">{task.name}</span>
                    </div>
                    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${getPriorityBadgeClass(task.priority)}`}>
                      {task.priority}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Carry Forward Section ── */}
          {selectedSummary.carry_forward?.length > 0 && (
            <div className="bg-card-bg border border-amber-500/30 rounded-2xl p-6 space-y-4">
              <h3 className="font-heading font-semibold text-lg text-text-primary flex items-center gap-2">
                <ArrowRight size={20} className="text-amber-400" />
                Carrying Forward to Tomorrow ({selectedSummary.carry_forward.length})
              </h3>
              <div className="space-y-2">
                {selectedSummary.carry_forward.map((task, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 p-3 bg-navy border border-muted rounded-xl">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <ArrowRight size={18} className="text-amber-400 shrink-0" />
                      <span className="text-base font-medium text-text-primary truncate">{task.name}</span>
                    </div>
                    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${getPriorityBadgeClass(task.priority)}`}>
                      {task.priority}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Behind Pace Goals Section (Deterministic, no AI) ── */}
          {selectedSummary.behind_pace_goals?.length > 0 && (
            <div className="bg-card-bg border border-red-500/30 rounded-2xl p-6 space-y-4">
              <h3 className="font-heading font-semibold text-lg text-text-primary flex items-center gap-2">
                <AlertCircle size={20} className="text-red-400" />
                Goals Behind Pace ({selectedSummary.behind_pace_goals.length})
              </h3>
              <div className="space-y-2">
                {selectedSummary.behind_pace_goals.map((g, idx) => (
                  <div key={g.goal_id || idx} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-navy border border-muted rounded-xl">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${getPriorityBadgeClass(g.priority)}`}>
                        {g.priority}
                      </span>
                      <span className="text-base font-medium text-text-primary truncate">{g.title}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-text-secondary shrink-0">
                      <span>Actual: <strong className="text-text-primary">{g.progress}%</strong></span>
                      <span>Expected: <strong className="text-amber-300">{g.expected_progress}%</strong></span>
                      <span className={g.is_overdue ? 'text-red-400 font-bold' : 'text-text-secondary'}>
                        {g.is_overdue ? 'OVERDUE' : `${g.days_left}d left`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Regenerate button for today's summary ── */}
          {selectedSummary.date === today && (
            <div className="text-center pt-2">
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="px-4 py-2 text-xs text-text-secondary hover:text-accent border border-gray-800 hover:border-accent/40 rounded-xl inline-flex items-center gap-2 transition-all cursor-pointer"
              >
                <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
                <span>{generating ? 'Regenerating...' : 'Regenerate Today\'s Summary'}</span>
              </button>
            </div>
          )}

        </div>
      )}

    </div>
  );
}
