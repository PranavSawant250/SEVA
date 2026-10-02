import React, { useEffect, useState, useCallback } from 'react';
import { 
  Calendar, 
  Sparkles, 
  Clock, 
  Plus, 
  CheckCircle2, 
  Circle, 
  AlertCircle, 
  RefreshCw, 
  Zap, 
  Tag, 
  CheckSquare
} from 'lucide-react';
import client from '../api/client';
import AddTaskModal from '../components/AddTaskModal';
import { getPriorityBadgeClass } from '../utils/themeUtils';

export default function DayPlan() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Data States
  const [planItems, setPlanItems] = useState([]);
  const [tasks, setTasks] = useState([]); // Real tasks table items for cross-referencing IDs
  const [hasPlan, setHasPlan] = useState(false);
  const [todayDate, setTodayDate] = useState('');

  // UI Action States
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [isAddTaskOpen, setIsAddTaskOpen] = useState(false);
  const [replanText, setReplanText] = useState('');
  const [replanning, setReplanning] = useState(false);
  const [replanMsg, setReplanMsg] = useState('');

  // Fetch Day Plan & Real Tasks
  const fetchPlanAndTasks = useCallback(async () => {
    setErrorMsg('');
    try {
      // 1. Fetch real tasks table to map task names -> task IDs
      const tasksRes = await client.get('/tasks');
      const realTasks = tasksRes.data.tasks || [];
      setTasks(realTasks);

      // 2. Fetch Day Plan
      const planRes = await client.get('/plan/today');
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

  // Helper: Find matching task row ID for a plan item name scoped to TODAY's date
  const findMatchingTask = (planTaskName) => {
    if (!planTaskName) return null;
    const cleanPlanName = planTaskName.trim().toLowerCase();
    const targetDate = todayDate || new Date().toISOString().split('T')[0];

    // 1. Candidate tasks scoped to TODAY's date
    const todayTasks = tasks.filter(t => t.date === targetDate);
    let match = todayTasks.find(t => {
      if (!t.name) return false;
      const tClean = t.name.trim().toLowerCase();
      return tClean === cleanPlanName || tClean.includes(cleanPlanName) || cleanPlanName.includes(tClean);
    });

    // 2. Fallback: candidate active incomplete tasks (completed = 0) with date <= today
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

  // Action: Toggle Task Completion
  const handleToggleComplete = async (planItem) => {
    let matchedTask = findMatchingTask(planItem.task);
    
    // If no task row exists for this plan item (e.g. surprise event), create one dynamically
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

    if (!matchedTask) {
      alert(`Unable to update completion for "${planItem.task}".`);
      return;
    }

    const newCompletedStatus = matchedTask.completed === 1 ? 0 : 1;
    
    // Optimistic UI update
    setTasks(prev => {
      const exists = prev.some(t => t.id === matchedTask.id);
      if (exists) {
        return prev.map(t => t.id === matchedTask.id ? { ...t, completed: newCompletedStatus } : t);
      } else {
        return [...prev, { ...matchedTask, completed: newCompletedStatus }];
      }
    });

    try {
      await client.patch(`/tasks/${matchedTask.id}/complete`, { completed: newCompletedStatus });
      await fetchPlanAndTasks(); // Re-sync state
    } catch (err) {
      console.error('[SEVA] Toggle completion error:', err);
      alert('Failed to update task completion status.');
      await fetchPlanAndTasks(); // Revert on failure
    }
  };

  // Action: Generate / Regenerate Plan
  const handleGeneratePlan = async (isRegenerate = false) => {
    if (isRegenerate) {
      const confirmRegen = window.confirm('This will replace your existing day plan with a fresh AI-generated schedule. Continue?');
      if (!confirmRegen) return;
    }

    setGeneratingPlan(true);
    setErrorMsg('');
    try {
      const res = await client.get('/plan/generate');
      if (res.data.success) {
        await fetchPlanAndTasks();
      } else {
        setErrorMsg(res.data.error || 'Failed to generate plan.');
      }
    } catch (err) {
      console.error('[SEVA] Generate plan error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Error generating plan.');
    } finally {
      setGeneratingPlan(false);
    }
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
        setReplanMsg('Plan successfully updated with your surprise event!');
        await fetchPlanAndTasks();
      } else {
        alert(res.data.error || 'Replan failed.');
      }
    } catch (err) {
      console.error('[SEVA] Replan error:', err);
      alert('Replan failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setReplanning(false);
    }
  };

  // Progress Bar Calculation
  const totalItems = planItems.length;
  const completedCount = planItems.filter(item => {
    const matched = findMatchingTask(item.task);
    return matched && matched.completed === 1;
  }).length;
  const progressPercent = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;

  // Source Badge Color
  const getSourceBadgeClass = (source) => {
    const s = (source || 'manual').toLowerCase();
    switch (s) {
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

  // ── STATE 1: LOADING ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Building your hour-by-hour day plan timeline...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl pb-10">
      
      {/* ── Page Header & Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <Calendar size={26} style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.5))' }} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-3xl text-text-primary">Day Plan Timeline</h1>
            <p className="text-text-secondary text-xs mt-0.5">Hour-by-hour structured schedule for today</p>
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
            onClick={() => handleGeneratePlan(hasPlan)}
            disabled={generatingPlan}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50"
          >
            <Sparkles size={16} className={generatingPlan ? 'animate-spin' : ''} />
            <span>{generatingPlan ? 'Generating Plan...' : hasPlan ? 'Regenerate Plan' : 'Generate Plan'}</span>
          </button>
        </div>
      </div>

      {/* ── STATE 2: ERROR ── */}
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
      {hasPlan && (
        <form onSubmit={handleReplan} className="bg-card-bg/60 border border-gray-800/80 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-accent">
            <Zap size={16} />
            <span>Surprise Event Replan</span>
          </div>
          <p className="text-text-secondary text-xs">
            Got an unexpected meeting, urgent call, or substitute class right now? Type it below to instantly recalculate your day plan around it.
          </p>

          {replanMsg && (
            <div className="text-xs text-emerald-400 font-medium bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/30">
              {replanMsg}
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="e.g., Surprise meeting with HOD right now at 3:30 PM"
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
      )}

      {/* ── STATE 3: EMPTY STATE ── */}
      {!hasPlan || planItems.length === 0 ? (
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-12 text-center space-y-4">
          <Calendar className="mx-auto text-text-secondary opacity-40" size={48} />
          <div className="space-y-1">
            <h3 className="font-heading font-semibold text-lg text-text-primary">No Day Plan Generated Yet</h3>
            <p className="text-text-secondary text-xs max-w-md mx-auto">
              You haven't generated a schedule for today. Click below to combine your timetable, email deadlines, and manual tasks into an optimized timeline.
            </p>
          </div>
          <button
            onClick={() => handleGeneratePlan(false)}
            disabled={generatingPlan}
            className="px-6 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl inline-flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50"
          >
            <Sparkles size={16} className={generatingPlan ? 'animate-spin' : ''} />
            <span>{generatingPlan ? 'Generating Plan with Phi-3.5...' : 'Generate Day Plan'}</span>
          </button>
        </div>
      ) : (
        /* ── Hour-by-Hour Timeline List ── */
        <div className="space-y-3 relative before:absolute before:left-4 before:top-4 before:bottom-4 before:w-0.5 before:bg-gray-800">
          {planItems.map((item, index) => {
            const matchedTask = findMatchingTask(item.task);
            const isCompleted = matchedTask && matchedTask.completed === 1;

            return (
              <div 
                key={index}
                className={`bg-card-bg border rounded-2xl p-4 ml-8 relative transition-all ${
                  isCompleted 
                    ? 'border-gray-800/60 bg-dark-bg/60 opacity-60' 
                    : 'border-gray-800 hover:border-accent/40'
                }`}
              >
                {/* Timeline node dot */}
                <div className={`absolute -left-[25px] top-5 w-3.5 h-3.5 rounded-full border-2 ${
                  isCompleted 
                    ? 'bg-emerald-500 border-emerald-400' 
                    : 'bg-accent border-dark-bg shadow-[0_0_8px_rgba(0,217,255,0.7)]'
                }`} />

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  
                  {/* Left: Checkbox + Task Info */}
                  <div className="flex items-start gap-3 min-w-0">
                    
                    {/* Checkbox */}
                    <button
                      type="button"
                      onClick={() => handleToggleComplete(item)}
                      title={matchedTask ? (isCompleted ? 'Mark incomplete' : 'Mark complete') : 'Inline event (no separate task row)'}
                      className={`mt-0.5 shrink-0 transition-colors ${
                        matchedTask ? 'cursor-pointer text-accent hover:text-accent/80' : 'cursor-not-allowed opacity-40 text-gray-600'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle2 size={20} className="text-emerald-400 fill-emerald-500/20" />
                      ) : (
                        <Circle size={20} />
                      )}
                    </button>

                    {/* Task Title & Time */}
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-xs font-semibold text-accent bg-accent/10 px-2 py-0.5 rounded border border-accent/20 shrink-0">
                          {item.time || 'Anytime'}
                        </span>
                        {item.duration && (
                          <span className="text-[11px] text-text-secondary flex items-center gap-1 shrink-0">
                            <Clock size={12} />
                            {item.duration} mins
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

                  {/* Right Badges */}
                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    {/* Source Badge */}
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${getSourceBadgeClass(item.source)}`}>
                      {item.source || 'manual'}
                    </span>

                    {/* Priority Badge */}
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

      {/* Reusable Add Task Modal */}
      <AddTaskModal
        isOpen={isAddTaskOpen}
        onClose={() => setIsAddTaskOpen(false)}
        onTaskAdded={() => fetchPlanAndTasks()}
      />

    </div>
  );
}
