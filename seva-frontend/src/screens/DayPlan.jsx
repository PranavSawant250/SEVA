import React, { useEffect, useState, useCallback } from 'react';
import { 
  Calendar, 
  Sparkles, 
  Clock, 
  Plus, 
  CheckCircle2, 
  Circle, 
  AlertCircle, 
  Zap, 
  CheckSquare,
  Sliders,
  Info,
  AlertTriangle
} from 'lucide-react';
import client from '../api/client';
import AddTaskModal from '../components/AddTaskModal';
import { getPriorityBadgeClass } from '../utils/themeUtils';

function getLocalTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DayPlan() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Data States
  const [planItems, setPlanItems] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [hasPlan, setHasPlan] = useState(false);
  const [todayDate, setTodayDate] = useState('');
  const [deferredItems, setDeferredItems] = useState([]);
  const [shrunkItems, setShrunkItems] = useState([]);
  const [floorSessions, setFloorSessions] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [planNote, setPlanNote] = useState('');

  // Window States
  const [windowState, setWindowState] = useState(null);
  const [needsWindow, setNeedsWindow] = useState(false);
  const [windowPromptMsg, setWindowPromptMsg] = useState('');
  const [windowHint, setWindowHint] = useState('');
  const [windowInput, setWindowInput] = useState('');
  const [savingWindow, setSavingWindow] = useState(false);

  // UI Action States
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [isAddTaskOpen, setIsAddTaskOpen] = useState(false);
  const [replanText, setReplanText] = useState('');
  const [replanning, setReplanning] = useState(false);
  const [replanMsg, setReplanMsg] = useState('');

  // Fetch Day Plan, Real Tasks & Window Settings
  const fetchPlanAndTasks = useCallback(async () => {
    setErrorMsg('');
    try {
      const [tasksRes, planRes, winRes] = await Promise.all([
        client.get('/tasks'),
        client.get('/plan/today'),
        client.get('/settings/today').catch(() => ({ data: null }))
      ]);

      const realTasks = tasksRes.data.tasks || [];
      setTasks(realTasks);

      if (winRes && winRes.data && winRes.data.success) {
        setWindowState(winRes.data);
        setNeedsWindow(!winRes.data.window_set);
        if (!winRes.data.window_set && winRes.data.tonight_budget_hint) {
          const hrs = +(winRes.data.tonight_budget_hint / 60).toFixed(1);
          setWindowHint(`Last night you planned about ${hrs} hours (${winRes.data.tonight_budget_hint} min).`);
        }
      }

      if (planRes.data.success && Array.isArray(planRes.data.plan) && planRes.data.plan.length > 0) {
        setHasPlan(true);
        setPlanItems(planRes.data.plan);
        if (planRes.data.date) {
          setTodayDate(planRes.data.date);
        }
      } else {
        setHasPlan(false);
        setPlanItems([]);
      }
    } catch (err) {
      console.error('[SEVA] Day plan fetch error:', err);
      setErrorMsg('Unable to fetch your day plan from backend server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlanAndTasks();
  }, [fetchPlanAndTasks]);

  // Helper: Find matching task row for a plan item (task_id first, then name fallback)
  const findMatchingTask = (planItem) => {
    if (!planItem) return null;
    if (typeof planItem === 'object' && planItem.task_id != null) {
      const byId = tasks.find(t => Number(t.id) === Number(planItem.task_id));
      if (byId) return byId;
      return {
        id: planItem.task_id,
        name: planItem.task,
        completed: planItem.completed ? 1 : 0,
        goal_id: planItem.goal_id || null
      };
    }

    const planTaskName = typeof planItem === 'string' ? planItem : planItem.task;
    if (!planTaskName) return null;
    const cleanPlanName = planTaskName.trim().toLowerCase();
    const targetDate = todayDate || getLocalTodayStr();

    const todayTasks = tasks.filter(t => t.date === targetDate);
    let match = todayTasks.find(t => {
      if (!t.name) return false;
      const tClean = t.name.trim().toLowerCase();
      return tClean === cleanPlanName || tClean.includes(cleanPlanName) || cleanPlanName.includes(tClean);
    });

    if (!match) {
      const activeIncompleteTasks = tasks.filter(t => t.completed === 0 && t.date <= targetDate);
      match = activeIncompleteTasks.find(t => {
        if (!t.name) return false;
        const tClean = t.name.trim().toLowerCase();
        return tClean === cleanPlanName || tClean.includes(cleanPlanName) || cleanPlanName.includes(tClean);
      });
    }

    return match || null;
  };

  // Action: Toggle Task Completion (uses task_id first, name fallback second)
  const handleToggleComplete = async (planItem) => {
    if (planItem.source === 'fixed' && !planItem.task_id) {
      return;
    }

    let matchedTask = findMatchingTask(planItem);

    if (!matchedTask) {
      try {
        const createRes = await client.post('/tasks', {
          name: planItem.task,
          priority: planItem.priority || 'high',
          time_slot: planItem.time || null,
          date: 'today'
        });
        if (createRes.data.success && createRes.data.task) {
          matchedTask = createRes.data.task;
        }
      } catch (err) {
        console.error('[SEVA] Error auto-creating task for plan event:', err);
      }
    }

    if (!matchedTask || matchedTask.id == null) {
      alert(`Unable to update completion for "${planItem.task}".`);
      return;
    }

    const newCompletedStatus = Number(matchedTask.completed) === 1 ? 0 : 1;

    // Optimistic UI update
    setTasks(prev => {
      const exists = prev.some(t => Number(t.id) === Number(matchedTask.id));
      if (exists) {
        return prev.map(t => Number(t.id) === Number(matchedTask.id) ? { ...t, completed: newCompletedStatus } : t);
      }
      return [...prev, { ...matchedTask, completed: newCompletedStatus }];
    });
    setPlanItems(prev =>
      prev.map(item =>
        (item.task_id != null && Number(item.task_id) === Number(matchedTask.id))
          ? { ...item, completed: newCompletedStatus }
          : item
      )
    );

    try {
      await client.patch(`/tasks/${matchedTask.id}/complete`, { completed: newCompletedStatus });
      await fetchPlanAndTasks();
    } catch (err) {
      console.error('[SEVA] Toggle completion error:', err);
      alert('Failed to update task completion status.');
      await fetchPlanAndTasks();
    }
  };

  const applyScheduleResponse = async (data) => {
    if (data.plan) {
      setPlanItems(data.plan);
      setHasPlan(data.plan.length > 0);
    }
    if (data.date) setTodayDate(data.date);
    setDeferredItems(Array.isArray(data.deferred) ? data.deferred : []);
    setShrunkItems(Array.isArray(data.shrunk) ? data.shrunk : []);
    setFloorSessions(Array.isArray(data.floorSessions) ? data.floorSessions : []);
    setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    setPlanNote(data.plan_note || '');
    setNeedsWindow(false);
    setWindowPromptMsg('');
    await fetchPlanAndTasks();
  };

  // Action: Generate / Regenerate Plan
  const handleGeneratePlan = async () => {
    setGeneratingPlan(true);
    setErrorMsg('');
    try {
      const res = await client.get('/plan/generate');
      if (res.data.success) {
        await applyScheduleResponse(res.data);
      } else if (res.data.needs_window) {
        setNeedsWindow(true);
        setWindowPromptMsg(res.data.message || 'No daily window is set. Tell SEVA your free window first.');
        setWindowHint(res.data.hint || '');
      } else {
        setErrorMsg(res.data.message || res.data.error || 'Failed to generate plan.');
      }
    } catch (err) {
      console.error('[SEVA] Generate plan error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Error generating plan.');
    } finally {
      setGeneratingPlan(false);
    }
  };

  // Action: Set Window from Quick Input or Preset Button
  const handleSetWindow = async (payload) => {
    setSavingWindow(true);
    setErrorMsg('');
    try {
      const putRes = await client.put('/settings/today', payload);
      if (putRes.data.success) {
        setWindowInput('');
        setNeedsWindow(false);
        setWindowPromptMsg('');
        await handleGeneratePlan();
      } else {
        setErrorMsg(putRes.data.error || 'Could not update window.');
      }
    } catch (err) {
      setErrorMsg(err.response?.data?.error || err.message || 'Failed to update today window.');
    } finally {
      setSavingWindow(false);
    }
  };

  const handleQuickWindowSubmit = async (e) => {
    e.preventDefault();
    const raw = windowInput.trim();
    if (!raw) return;

    // Parse "4 hours", "90 minutes", or "9:00 PM" / "9 PM"
    const durMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)$/i);
    if (durMatch) {
      const val = parseFloat(durMatch[1]);
      const unit = durMatch[2].toLowerCase();
      const mins = unit.startsWith('h') ? Math.round(val * 60) : Math.round(val);
      await handleSetWindow({ available_minutes: mins, done_for_day: false });
      return;
    }

    let timeStr = raw;
    if (/^\d{1,2}\s*(AM|PM)$/i.test(timeStr)) {
      timeStr = timeStr.replace(/^(\d{1,2})\s*(AM|PM)$/i, '$1:00 $2');
    }
    await handleSetWindow({ window_end_time: timeStr.toUpperCase(), done_for_day: false });
  };

  // Action: Replan Surprise Event
  const handleReplan = async (e) => {
    e.preventDefault();
    if (!replanText.trim()) return;

    setReplanning(true);
    setReplanMsg('');
    try {
      const res = await client.post('/plan/replan', { surpriseEvent: replanText.trim() });
      if (res.data.success) {
        setReplanText('');
        setReplanMsg('Plan updated around your surprise event!');
        await applyScheduleResponse(res.data);
      } else {
        setErrorMsg(res.data.error || 'Replan failed.');
      }
    } catch (err) {
      console.error('[SEVA] Replan error:', err);
      setErrorMsg('Replan failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setReplanning(false);
    }
  };

  // Progress Bar Calculation
  const totalItems = planItems.length;
  const completedCount = planItems.filter(item => {
    const matched = findMatchingTask(item);
    return matched && Number(matched.completed) === 1;
  }).length;
  const progressPercent = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;

  // Source Badge Color
  const getSourceBadgeClass = (source) => {
    const s = (source || 'manual').toLowerCase();
    switch (s) {
      case 'goal':
        return 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30';
      case 'habit':
        return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
      case 'urgent':
        return 'bg-red-500/15 text-red-400 border border-red-500/30';
      case 'forced':
        return 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30';
      case 'fixed':
        return 'bg-slate-700/40 text-slate-300 border border-slate-600/50';
      case 'email':
        return 'bg-purple-500/15 text-purple-400 border border-purple-500/30';
      case 'carry_forward':
        return 'bg-amber-500/15 text-amber-400 border border-amber-500/30';
      case 'surprise_event':
        return 'bg-rose-500/15 text-rose-400 border border-rose-500/30';
      default:
        return 'bg-gray-800 text-gray-300 border border-gray-700';
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Building your hour-by-hour day plan timeline...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl pb-10">
      
      {/* ── Page Header & Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <Calendar size={26} style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.5))' }} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-3xl text-text-primary">Day Plan Timeline</h1>
            <p className="text-text-secondary text-xs mt-0.5">Deterministic goal-aware schedule for today</p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setIsAddTaskOpen(true)}
            className="px-3.5 py-2 bg-card-bg hover:bg-gray-800 text-text-primary border border-gray-700/80 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Plus size={16} className="text-accent" />
            <span>Add Task</span>
          </button>

          <button
            onClick={() => handleGeneratePlan()}
            disabled={generatingPlan}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50"
          >
            <Sparkles size={16} className={generatingPlan ? 'animate-spin' : ''} />
            <span>{generatingPlan ? 'Generating Plan...' : hasPlan ? 'Regenerate Plan' : 'Generate Plan'}</span>
          </button>
        </div>
      </div>

      {/* ── Today's Window Control / Window Not Set Prompt ── */}
      <div className={`rounded-2xl p-5 border space-y-3 ${
        needsWindow
          ? 'bg-amber-950/30 border-amber-500/50'
          : 'bg-card-bg border-gray-800'
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
            <Sliders size={16} className={needsWindow ? 'text-amber-400' : 'text-accent'} />
            <span>
              {needsWindow
                ? 'Daily Window Not Set'
                : windowState?.done_for_day
                  ? 'Marked as Done for Today'
                  : `Today's Window: until ${windowState?.window_end_time || 'set time'}`}
            </span>
          </div>
          {windowState?.window_set && !windowState?.done_for_day && (
            <span className="text-[11px] font-mono text-accent">
              {windowState.remaining_minutes} min remaining ({windowState.source})
            </span>
          )}
        </div>

        {(needsWindow || windowPromptMsg) && (
          <p className="text-xs text-amber-300">
            {windowPromptMsg || 'Tell SEVA when your free window ends today (e.g. "9:00 PM" or "4 hours") so your schedule can be built without assuming a bedtime.'}
            {windowHint ? ` ${windowHint}` : ''}
          </p>
        )}

        <form onSubmit={handleQuickWindowSubmit} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder='e.g. "9:00 PM" or "4 hours" or "90 minutes"'
            value={windowInput}
            onChange={(e) => setWindowInput(e.target.value)}
            className="flex-1 min-w-[200px] bg-dark-bg border border-gray-700/80 rounded-xl px-3.5 py-2 text-xs text-text-primary focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={savingWindow || !windowInput.trim()}
            className="px-3.5 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50"
          >
            {savingWindow ? 'Saving...' : 'Set Window & Plan'}
          </button>
          <button
            type="button"
            disabled={savingWindow}
            onClick={() => handleSetWindow({ available_minutes: 120, done_for_day: false })}
            className="px-2.5 py-2 bg-dark-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-700 rounded-xl text-xs cursor-pointer"
          >
            +2h
          </button>
          <button
            type="button"
            disabled={savingWindow}
            onClick={() => handleSetWindow({ available_minutes: 240, done_for_day: false })}
            className="px-2.5 py-2 bg-dark-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-700 rounded-xl text-xs cursor-pointer"
          >
            +4h
          </button>
          <button
            type="button"
            disabled={savingWindow}
            onClick={() => handleSetWindow({ window_end_time: '9:00 PM', done_for_day: false })}
            className="px-2.5 py-2 bg-dark-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-700 rounded-xl text-xs cursor-pointer"
          >
            Till 9 PM
          </button>
          <button
            type="button"
            disabled={savingWindow}
            onClick={() => handleSetWindow({ done_for_day: true })}
            className="px-2.5 py-2 bg-rose-950/40 hover:bg-rose-900/40 text-rose-300 border border-rose-500/30 rounded-xl text-xs cursor-pointer"
          >
            Done for today
          </button>
        </form>
      </div>

      {/* ── ERROR ALERT ── */}
      {errorMsg && (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={fetchPlanAndTasks}
            className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/40 text-[11px]"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Plan Note & Warnings ── */}
      {planNote && (
        <div className="p-4 bg-accent/10 border border-accent/30 rounded-2xl flex items-start gap-3 text-xs text-text-primary">
          <Info size={16} className="text-accent shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium leading-relaxed">{planNote}</p>
            {floorSessions.length > 0 && (
              <p className="text-cyan-300 text-[11px]">
                Neglect Floor: {floorSessions.map(f => `${f.item} (${f.duration} min)`).join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="p-4 bg-amber-950/30 border border-amber-500/40 rounded-2xl space-y-1.5 text-xs text-amber-300">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-400" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Progress Bar & Completion Header (if plan exists) ── */}
      {hasPlan && planItems.length > 0 && (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-semibold text-text-primary">
              <CheckSquare size={16} className="text-accent" />
              <span>Daily Progress ({completedCount} of {totalItems} completed)</span>
            </div>
            <span className="font-mono text-accent font-bold">{progressPercent}%</span>
          </div>
          
          <div className="w-full bg-dark-bg rounded-full h-2.5 overflow-hidden border border-gray-800">
            <div 
              className="bg-accent h-full transition-all duration-500 ease-out shadow-[0_0_10px_rgba(0,217,255,0.7)]"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      {/* ── Replan Surprise Event Form ── */}
      <form onSubmit={handleReplan} className="bg-card-bg/60 border border-gray-800/80 rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-accent">
          <Zap size={16} />
          <span>Surprise Event Replan</span>
        </div>
        <p className="text-text-secondary text-xs">
          Got an unexpected meeting, viva, or urgent event? Enter it below to insert it as a fixed block and recalculate the rest of your window.
        </p>

        {replanMsg && (
          <div className="text-xs text-emerald-400 font-medium bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/30">
            {replanMsg}
          </div>
        )}

        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="e.g., Surprise viva with Professor Rathod at 3:30 PM"
            value={replanText}
            onChange={(e) => setReplanText(e.target.value)}
            className="flex-1 bg-dark-bg border border-gray-700/80 rounded-xl px-3.5 py-2 text-xs text-text-primary focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={replanning || !replanText.trim()}
            className="px-4 py-2 bg-accent/20 hover:bg-accent/30 text-accent border border-accent/40 font-heading font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
          >
            <Zap size={14} className={replanning ? 'animate-spin' : ''} />
            <span>{replanning ? 'Replanning...' : 'Replan Day'}</span>
          </button>
        </div>
      </form>

      {/* ── EMPTY STATE OR TIMELINE ── */}
      {!hasPlan || planItems.length === 0 ? (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-12 text-center space-y-4">
          <Calendar className="mx-auto text-text-secondary opacity-40" size={48} />
          <div className="space-y-1">
            <h3 className="font-heading font-semibold text-lg text-text-primary">No Day Plan Generated Yet</h3>
            <p className="text-text-secondary text-xs max-w-md mx-auto">
              Set your free window above or click below to build your deterministic schedule around classes, goals, and tasks.
            </p>
          </div>
          <button
            onClick={() => handleGeneratePlan()}
            disabled={generatingPlan}
            className="px-6 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl inline-flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50"
          >
            <Sparkles size={16} className={generatingPlan ? 'animate-spin' : ''} />
            <span>{generatingPlan ? 'Generating Plan...' : 'Generate Day Plan'}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3 relative before:absolute before:left-4 before:top-4 before:bottom-4 before:w-0.5 before:bg-gray-800">
          {planItems.map((item, index) => {
            const matchedTask = findMatchingTask(item);
            const isCompleted = Boolean((matchedTask && Number(matchedTask.completed) === 1) || Number(item.completed) === 1);
            const isFixedClass = item.source === 'fixed' && !item.task_id;

            return (
              <div 
                key={item.task_id ? `task-${item.task_id}-${index}` : index}
                className={`bg-card-bg border rounded-2xl p-4 ml-8 relative transition-all ${
                  isCompleted 
                    ? 'border-gray-800/60 bg-dark-bg/60 opacity-60' 
                    : 'border-gray-800 hover:border-accent/40'
                }`}
              >
                <div className={`absolute -left-[25px] top-5 w-3.5 h-3.5 rounded-full border-2 ${
                  isCompleted 
                    ? 'bg-emerald-500 border-emerald-400' 
                    : 'bg-accent border-dark-bg shadow-[0_0_8px_rgba(0,217,255,0.7)]'
                }`} />

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      disabled={isFixedClass}
                      onClick={() => handleToggleComplete(item)}
                      title={isFixedClass ? 'Fixed class' : (isCompleted ? 'Mark incomplete' : 'Mark complete')}
                      className={`mt-0.5 shrink-0 transition-colors ${
                        !isFixedClass ? 'cursor-pointer text-accent hover:text-accent/80' : 'cursor-default opacity-30 text-gray-600'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle2 size={20} className="text-emerald-400 fill-emerald-500/20" />
                      ) : (
                        <Circle size={20} />
                      )}
                    </button>

                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-accent bg-accent/10 px-2 py-0.5 rounded border border-accent/20 shrink-0">
                          {item.time || 'Anytime'}
                        </span>
                        {item.duration && (
                          <span className="text-[11px] text-text-secondary flex items-center gap-1 shrink-0">
                            <Clock size={12} />
                            {item.duration} mins
                          </span>
                        )}
                        {item.floor && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            Neglect Floor (30m)
                          </span>
                        )}
                      </div>

                      <h4 className={`font-heading font-semibold text-sm leading-snug text-text-primary ${
                        isCompleted ? 'line-through text-text-secondary' : ''
                      }`}>
                        {item.task}
                      </h4>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${getSourceBadgeClass(item.source)}`}>
                      {item.source || 'manual'}
                    </span>
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full ${getPriorityBadgeClass(item.priority)}`}>
                      {item.priority || 'medium'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Not Scheduled Today (Deferred Goals & Tasks) ── */}
      {deferredItems.length > 0 && (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-heading font-semibold text-sm text-text-primary">
              Not Scheduled Today ({deferredItems.length})
            </h3>
            <span className="text-[11px] text-text-secondary">
              Will rise in priority or appear in tonight&apos;s &ldquo;plan tomorrow&rdquo; check-in
            </span>
          </div>
          <div className="space-y-2">
            {deferredItems.map((d, idx) => (
              <div
                key={idx}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 p-3 rounded-xl bg-dark-bg/70 border border-gray-800/80 text-xs"
              >
                <span className="font-semibold text-text-primary">{d.item}</span>
                <span className="text-text-secondary font-mono text-[11px]">{d.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <AddTaskModal
        isOpen={isAddTaskOpen}
        onClose={() => setIsAddTaskOpen(false)}
        onTaskAdded={() => fetchPlanAndTasks()}
      />

    </div>
  );
}
