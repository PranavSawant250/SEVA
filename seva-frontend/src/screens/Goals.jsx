import React, { useEffect, useState, useCallback } from 'react';
import {
  Target,
  CheckCircle2,
  Circle,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  AlertCircle,
  RefreshCw,
  Sliders,
  Eye,
  EyeOff
} from 'lucide-react';
import client from '../api/client';
import { getPriorityBadgeClass } from '../utils/themeUtils';

export default function Goals() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [goals, setGoals] = useState([]);
  const [showRemoved, setShowRemoved] = useState(false);

  // Import JSON box state
  const [showImportBox, setShowImportBox] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importFeedback, setImportFeedback] = useState(null);

  // Manual override inline state: { [goalId]: string }
  const [manualInputs, setManualInputs] = useState({});
  const [busyGoalId, setBusyGoalId] = useState(null);

  const fetchGoals = useCallback(async () => {
    setErrorMsg('');
    try {
      const res = await client.get('/goals');
      if (res.data.success) {
        setGoals(res.data.goals || []);
      } else {
        setErrorMsg(res.data.error || 'Failed to load goals.');
      }
    } catch (err) {
      console.error('[SEVA] Goals fetch error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Unable to connect to SEVA backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  // Import JSON handler
  const handleImportJson = async (e) => {
    e.preventDefault();
    setImportFeedback(null);
    let parsed;
    try {
      parsed = JSON.parse(jsonInput.trim());
    } catch (parseErr) {
      setImportFeedback({ type: 'error', text: `Invalid JSON: ${parseErr.message}` });
      return;
    }

    setImporting(true);
    try {
      const res = await client.post('/goals/import', parsed);
      if (res.data.success) {
        const overdueText = res.data.overdue?.length
          ? ` Overdue flagged: ${res.data.overdue.join(', ')}.`
          : '';
        setImportFeedback({
          type: 'success',
          text: `Imported (${res.data.created} created, ${res.data.updated} updated).${overdueText}`
        });
        setJsonInput('');
        await fetchGoals();
      } else {
        setImportFeedback({ type: 'error', text: res.data.error || 'Import failed.' });
      }
    } catch (err) {
      const details = err.response?.data?.details
        ? `: ${err.response.data.details.join('; ')}`
        : '';
      setImportFeedback({
        type: 'error',
        text: (err.response?.data?.error || err.message || 'Import failed') + details
      });
    } finally {
      setImporting(false);
    }
  };

  // Log progress (+1 count or Done today frequency)
  const handleLogProgress = async (goalId, amount = 1) => {
    setBusyGoalId(goalId);
    try {
      await client.post(`/goals/${goalId}/log`, { amount });
      await fetchGoals();
    } catch (err) {
      alert(err.response?.data?.error || err.message || 'Failed to log progress');
    } finally {
      setBusyGoalId(null);
    }
  };

  // Toggle milestone step
  const handleToggleStep = async (goalId, stepId, currentDone) => {
    setBusyGoalId(goalId);
    try {
      await client.patch(`/goals/${goalId}/steps/${stepId}`, {
        done: currentDone === 1 ? 0 : 1
      });
      await fetchGoals();
    } catch (err) {
      alert(err.response?.data?.error || err.message || 'Failed to toggle step');
    } finally {
      setBusyGoalId(null);
    }
  };

  // Set or clear manual override
  const handleManualOverride = async (goalId, valueOrNull) => {
    setBusyGoalId(goalId);
    try {
      await client.patch(`/goals/${goalId}`, {
        manual_progress: valueOrNull
      });
      await fetchGoals();
    } catch (err) {
      alert(err.response?.data?.error || err.message || 'Failed to update manual progress');
    } finally {
      setBusyGoalId(null);
    }
  };

  // Update status (Mark complete, Restore, Soft remove)
  const handleStatusChange = async (goalId, status) => {
    setBusyGoalId(goalId);
    try {
      if (status === 'removed') {
        await client.delete(`/goals/${goalId}`);
      } else {
        await client.patch(`/goals/${goalId}`, { status });
      }
      await fetchGoals();
    } catch (err) {
      alert(err.response?.data?.error || err.message || 'Failed to update goal status');
    } finally {
      setBusyGoalId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Loading your monthly goals...</p>
      </div>
    );
  }

  const visibleGoals = goals.filter(g => (showRemoved ? true : g.status !== 'removed'));
  const removedCount = goals.filter(g => g.status === 'removed').length;

  // Group visible goals by category
  const groupedByCategory = visibleGoals.reduce((acc, g) => {
    const cat = g.category || 'General';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(g);
    return acc;
  }, {});

  return (
    <div className="space-y-8 max-w-6xl pb-12">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <Target size={26} style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.5))' }} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-3xl text-text-primary">Monthly Goals</h1>
            <p className="text-text-secondary text-xs mt-0.5">
              Deterministic progress tracking, milestone checklists & daily scheduling targets
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {removedCount > 0 && (
            <button
              onClick={() => setShowRemoved(v => !v)}
              className="px-3.5 py-2 bg-card-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-800 rounded-xl text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all"
            >
              {showRemoved ? <EyeOff size={14} /> : <Eye size={14} />}
              <span>{showRemoved ? 'Hide removed' : `Show removed (${removedCount})`}</span>
            </button>
          )}
          <button
            onClick={() => setShowImportBox(v => !v)}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-lg shadow-accent/20"
          >
            <Upload size={14} />
            <span>{showImportBox ? 'Close Import Box' : 'Paste Goals JSON'}</span>
          </button>
        </div>
      </div>

      {/* ── Error Banner ── */}
      {errorMsg && (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={fetchGoals}
            className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/40 flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw size={12} />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* ── Paste Goals JSON Box ── */}
      {(showImportBox || visibleGoals.length === 0) && (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-heading font-semibold text-base text-text-primary">
                Import Monthly Goals JSON
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                Paste a JSON object with <code className="text-accent">month</code> and a <code className="text-accent">goals</code> array (up to 30 goals).
              </p>
            </div>
          </div>

          <form onSubmit={handleImportJson} className="space-y-3">
            <textarea
              rows={7}
              value={jsonInput}
              onChange={e => setJsonInput(e.target.value)}
              placeholder={`{\n  "month": "October 2026",\n  "goals": [\n    {"category":"Technical","title":"Spring Boot Basics","target":"Controllers, Services, Repositories done","deadline":"2026-10-15","priority":"high"}\n  ]\n}`}
              className="w-full bg-dark-bg border border-gray-800 rounded-xl p-3.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            {importFeedback && (
              <div
                className={`p-3 rounded-xl text-xs ${
                  importFeedback.type === 'success'
                    ? 'bg-emerald-950/40 border border-emerald-500/40 text-emerald-300'
                    : 'bg-red-950/40 border border-red-500/40 text-red-300'
                }`}
              >
                {importFeedback.text}
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={importing || !jsonInput.trim()}
                className="px-5 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl cursor-pointer disabled:opacity-50"
              >
                {importing ? 'Importing...' : 'Import Goals'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Empty State ── */}
      {visibleGoals.length === 0 && (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-10 text-center space-y-3">
          <Target size={40} className="text-accent mx-auto opacity-70" />
          <h3 className="font-heading font-semibold text-lg text-text-primary">No Active Goals Yet</h3>
          <p className="text-xs text-text-secondary max-w-md mx-auto">
            Paste your monthly goals JSON above or in Chat to start scheduling daily work blocks automatically.
          </p>
        </div>
      )}

      {/* ── Grouped Goal Cards ── */}
      {Object.entries(groupedByCategory).map(([category, catGoals]) => (
        <div key={category} className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="font-heading font-bold text-lg text-text-primary tracking-wide">
              {category}
            </h2>
            <span className="text-xs text-text-secondary bg-card-bg border border-gray-800 px-2.5 py-0.5 rounded-full">
              {catGoals.length}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {catGoals.map(goal => {
              const isManual = goal.manual_progress !== null && goal.manual_progress !== undefined;
              const isRemoved = goal.status === 'removed';
              const isCompleted = goal.status === 'completed';
              const isBusy = busyGoalId === goal.id;

              return (
                <div
                  key={goal.id}
                  className={`bg-card-bg border rounded-2xl p-5 space-y-4 transition-all ${
                    isRemoved
                      ? 'border-gray-800/50 opacity-60'
                      : isCompleted
                      ? 'border-emerald-500/40'
                      : goal.is_overdue
                      ? 'border-red-500/40'
                      : 'border-gray-800/90 hover:border-gray-700'
                  }`}
                >
                  {/* Card Top: Title + Priority + Deadline/Overdue */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-heading font-semibold text-base text-text-primary">
                          {goal.title}
                        </h3>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${getPriorityBadgeClass(goal.priority)}`}>
                          {goal.priority}
                        </span>
                        {isRemoved && (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                            Removed
                          </span>
                        )}
                        {isCompleted && (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                            Completed
                          </span>
                        )}
                      </div>
                      {goal.target_text && (
                        <p className="text-xs text-text-secondary">{goal.target_text}</p>
                      )}
                    </div>

                    {/* Deadline / Days Left Badge */}
                    <div className="text-right shrink-0">
                      {goal.is_overdue && !isCompleted ? (
                        <span className="text-[11px] font-bold uppercase px-2.5 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/40">
                          OVERDUE
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-text-secondary bg-dark-bg px-2.5 py-1 rounded-lg border border-gray-800">
                          {goal.days_left !== null ? `${goal.days_left}d left` : goal.deadline}
                        </span>
                      )}
                      <div className="text-[10px] text-text-secondary mt-1">
                        Due {goal.deadline}
                      </div>
                    </div>
                  </div>

                  {/* Progress Bar + Auto/Manual Badge + Expected Marker */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-heading font-bold text-text-primary">
                          {goal.progress}%
                        </span>
                        <span
                          className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${
                            isManual
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                              : 'bg-accent/10 text-accent border border-accent/25'
                          }`}
                        >
                          {isManual ? 'Manual' : 'Auto'}
                        </span>
                        {goal.goal_type === 'count' && (
                          <span className="text-xs text-text-secondary font-mono">
                            {goal.current_count}/{goal.target_count}
                          </span>
                        )}
                        {goal.goal_type === 'frequency' && (
                          <span className="text-xs text-text-secondary font-mono">
                            {goal.days_this_week || 0}/{goal.per_week} this week
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] text-text-secondary">
                        Expected: <span className="text-text-primary font-medium">{goal.expected_progress}%</span>
                        {goal.behind_by > 0 && goal.progress_source !== 'no_progress_data' && (
                          <span className="text-amber-400 ml-1.5">(-{goal.behind_by}%)</span>
                        )}
                      </div>
                    </div>

                    {/* Progress Track with Expected Marker */}
                    <div className="relative h-2.5 w-full bg-dark-bg rounded-full overflow-hidden border border-gray-800">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          isCompleted
                            ? 'bg-emerald-400'
                            : goal.is_overdue
                            ? 'bg-red-400'
                            : 'bg-accent'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, goal.progress))}%` }}
                      />
                      {goal.expected_progress > 0 && goal.expected_progress < 100 && (
                        <div
                          title={`Expected pace: ${goal.expected_progress}%`}
                          className="absolute top-0 bottom-0 w-0.5 bg-amber-400"
                          style={{ left: `${goal.expected_progress}%` }}
                        />
                      )}
                    </div>
                  </div>

                  {/* Milestone Steps Checklist */}
                  {goal.goal_type === 'milestone' && (
                    <div className="space-y-2 pt-1">
                      {goal.steps && goal.steps.length > 0 ? (
                        <div className="space-y-1.5">
                          {goal.steps.map(step => (
                            <button
                              key={step.id}
                              type="button"
                              disabled={isBusy || isRemoved}
                              onClick={() => handleToggleStep(goal.id, step.id, step.done)}
                              className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-dark-bg/70 hover:bg-dark-bg border border-gray-800/80 text-left text-xs transition-all cursor-pointer"
                            >
                              {step.done === 1 ? (
                                <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
                              ) : (
                                <Circle size={15} className="text-text-secondary shrink-0" />
                              )}
                              <span
                                className={
                                  step.done === 1
                                    ? 'line-through text-text-secondary'
                                    : 'text-text-primary'
                                }
                              >
                                {step.step_text}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="p-2.5 rounded-xl bg-dark-bg/50 border border-gray-800 text-[11px] text-text-secondary">
                          No steps defined yet. Set manual progress below or say{' '}
                          <code className="text-accent">steps for {goal.title}: step 1; step 2</code> in Chat.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Quick Actions Row */}
                  <div className="pt-2 border-t border-gray-800/80 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {!isRemoved && !isCompleted && goal.goal_type === 'count' && (
                        <button
                          onClick={() => handleLogProgress(goal.id, 1)}
                          disabled={isBusy}
                          className="px-3 py-1.5 bg-accent/15 hover:bg-accent/25 text-accent border border-accent/30 rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer transition-all"
                        >
                          <Plus size={13} />
                          <span>+1 Problem</span>
                        </button>
                      )}

                      {!isRemoved && !isCompleted && goal.goal_type === 'frequency' && (
                        <button
                          onClick={() => handleLogProgress(goal.id, 1)}
                          disabled={isBusy || goal.last_logged_today}
                          className="px-3 py-1.5 bg-accent/15 hover:bg-accent/25 text-accent border border-accent/30 rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer transition-all disabled:opacity-50"
                        >
                          <CheckCircle2 size={13} />
                          <span>{goal.last_logged_today ? 'Logged Today' : 'Done today'}</span>
                        </button>
                      )}

                      {/* Manual Override Input */}
                      {!isRemoved && !isCompleted && (
                        <div className="flex items-center gap-1.5">
                          <Sliders size={13} className="text-text-secondary" />
                          <input
                            type="number"
                            min="0"
                            max="100"
                            placeholder="%"
                            value={manualInputs[goal.id] ?? ''}
                            onChange={e =>
                              setManualInputs(prev => ({ ...prev, [goal.id]: e.target.value }))
                            }
                            className="w-14 bg-dark-bg border border-gray-800 rounded-lg px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            disabled={isBusy || manualInputs[goal.id] === undefined || manualInputs[goal.id] === ''}
                            onClick={() => {
                              const val = parseInt(manualInputs[goal.id], 10);
                              if (!isNaN(val) && val >= 0 && val <= 100) {
                                handleManualOverride(goal.id, val);
                              }
                            }}
                            className="px-2.5 py-1 bg-dark-bg hover:bg-gray-800 text-text-primary border border-gray-700 rounded-lg text-[11px] cursor-pointer disabled:opacity-40"
                          >
                            Set
                          </button>
                          {isManual && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleManualOverride(goal.id, null)}
                              className="px-2.5 py-1 bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 rounded-lg text-[11px] cursor-pointer"
                            >
                              Clear override
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right actions: Mark complete / Restore / Remove */}
                    <div className="flex items-center gap-2">
                      {isRemoved ? (
                        <button
                          onClick={() => handleStatusChange(goal.id, 'active')}
                          disabled={isBusy}
                          className="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer"
                        >
                          <RotateCcw size={13} />
                          <span>Restore</span>
                        </button>
                      ) : (
                        <>
                          {!isCompleted ? (
                            <button
                              onClick={() => handleStatusChange(goal.id, 'completed')}
                              disabled={isBusy}
                              className="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer"
                            >
                              <CheckCircle2 size={13} />
                              <span>Mark complete</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => handleStatusChange(goal.id, 'active')}
                              disabled={isBusy}
                              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-text-secondary rounded-lg text-xs font-medium flex items-center gap-1 cursor-pointer"
                            >
                              <RotateCcw size={13} />
                              <span>Reopen</span>
                            </button>
                          )}
                          <button
                            onClick={() => handleStatusChange(goal.id, 'removed')}
                            disabled={isBusy}
                            title="Soft-remove goal"
                            className="p-1.5 text-text-secondary hover:text-red-400 bg-dark-bg hover:bg-red-950/30 border border-gray-800 rounded-lg cursor-pointer transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
