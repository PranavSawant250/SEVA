import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  LayoutDashboard, 
  Mail, 
  CheckSquare, 
  Calendar, 
  Plus, 
  MessageSquare, 
  Sparkles, 
  Clock, 
  AlertCircle,
  RefreshCw,
  ArrowRight
} from 'lucide-react';
import client from '../api/client';
import AddTaskModal from '../components/AddTaskModal';
import { getPriorityBadgeClass } from '../utils/themeUtils';

export default function Dashboard() {
  const navigate = useNavigate();

  // Page States
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Data States
  const [emailCount, setEmailCount] = useState(0);
  const [latestEmailDate, setLatestEmailDate] = useState(null);
  const [pendingTaskCount, setPendingTaskCount] = useState(0);
  const [meetingsCount, setMeetingsCount] = useState(0);
  const [topPriorities, setTopPriorities] = useState([]);
  const [hasPlan, setHasPlan] = useState(false);

  // UI Action States
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [isAddTaskOpen, setIsAddTaskOpen] = useState(false);
  const [lastDashboardSync, setLastDashboardSync] = useState('');

  // 1. Compute Greeting Client-Side Based on Hour
  const currentHour = new Date().getHours();
  let greeting = 'Good morning';
  if (currentHour >= 12 && currentHour < 17) {
    greeting = 'Good afternoon';
  } else if (currentHour >= 17) {
    greeting = 'Good evening';
  }

  // Today's Formatted Date String
  const todayFormatted = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  // Fetch Dashboard Summary Data
  const fetchDashboardData = useCallback(async () => {
    setErrorMsg('');
    try {
      // 1. Check Timetable Guard First
      const ttRes = await client.get('/timetable');
      if (ttRes.data.count === 0) {
        navigate('/login', { state: { step: 'timetable' }, replace: true });
        return;
      }

      // 2. Fetch Emails Today
      const emailsRes = await client.get('/emails/today');
      const emailList = emailsRes.data.emails || [];
      setEmailCount(emailList.length);

      /*
        Honest Data Choice for Gmail Sync Time:
        The SEVA database does not maintain a dedicated 'sync_logs' table.
        We check if emails exist for today: if so, we extract the latest email's date.
        Otherwise, we fall back to displaying the timestamp when Dashboard fetched data.
      */
      if (emailList.length > 0 && emailList[0].date) {
        setLatestEmailDate(emailList[0].date);
      } else {
        setLatestEmailDate(null);
      }

      // 3. Fetch Tasks Pending
      const tasksRes = await client.get('/tasks');
      const taskList = tasksRes.data.tasks || [];
      const pending = taskList.filter(t => t.completed === 0).length;
      setPendingTaskCount(pending);

      // 4. Fetch Day Plan Today
      const planRes = await client.get('/plan/today');
      if (planRes.data.success && Array.isArray(planRes.data.plan) && planRes.data.plan.length > 0) {
        setHasPlan(true);
        const planItems = planRes.data.plan;

        /*
          Heuristic for Meetings Scheduled Count:
          The database doesn't have a strict 'is_meeting' column in plan_json.
          We count items where source !== 'manual' OR the item description contains meeting/viva/class/lecture/lab/discussion.
        */
        const meetingItems = planItems.filter(item => {
          const text = (item.task || '').toLowerCase();
          const isNonManual = item.source && item.source !== 'manual';
          const matchesKeyword = /meeting|viva|class|lecture|lab|discussion|exam/i.test(text);
          return isNonManual || matchesKeyword;
        });
        setMeetingsCount(meetingItems.length);

        // Top 3 Priorities: Sort high -> medium -> low
        const priorityOrder = { high: 1, medium: 2, low: 3 };
        const sorted = [...planItems].sort((a, b) => {
          const pA = priorityOrder[(a.priority || '').toLowerCase()] || 4;
          const pB = priorityOrder[(b.priority || '').toLowerCase()] || 4;
          return pA - pB;
        });
        setTopPriorities(sorted.slice(0, 3));
      } else {
        setHasPlan(false);
        setMeetingsCount(0);
        setTopPriorities([]);
      }

      setLastDashboardSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    } catch (err) {
      console.error('[SEVA] Dashboard data fetch failed:', err);
      setErrorMsg('Unable to connect to SEVA backend services. Please confirm server is running.');
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  // Action: Generate Day Plan
  const handleGeneratePlan = async () => {
    setGeneratingPlan(true);
    try {
      const res = await client.get('/plan/generate');
      if (res.data.success) {
        await fetchDashboardData(); // Refresh top priorities and stats
      } else {
        alert('Plan generation failed: ' + (res.data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[SEVA] Plan generation failed:', err);
      alert('Error generating plan with AI: ' + (err.response?.data?.error || err.message));
    } finally {
      setGeneratingPlan(false);
    }
  };

  // ── STATE 1: LOADING ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Loading your daily SEVA summary...</p>
      </div>
    );
  }

  // ── STATE 2: ERROR ──
  if (errorMsg) {
    return (
      <div className="p-6 bg-red-950/30 border border-red-500/40 rounded-2xl space-y-4 max-w-xl">
        <div className="flex items-center gap-3 text-red-400">
          <AlertCircle size={24} />
          <h3 className="font-heading font-semibold text-lg">Backend Connection Failed</h3>
        </div>
        <p className="text-text-secondary text-sm">{errorMsg}</p>
        <button
          onClick={fetchDashboardData}
          className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 font-medium text-xs rounded-xl border border-red-500/40 flex items-center gap-2 cursor-pointer transition-all"
        >
          <RefreshCw size={14} />
          <span>Retry Loading Dashboard</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-6xl pb-10">
      
      {/* ── Greeting & Date Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800/80 pb-6">
        <div>
          <h1 className="font-heading font-bold text-3xl sm:text-4xl text-text-primary tracking-tight">
            {greeting}
          </h1>
          <p className="text-text-secondary text-sm mt-1">{todayFormatted}</p>
        </div>

        {/* Sync Time Indicator */}
        <div className="flex items-center gap-2 text-xs text-text-secondary bg-dark-bg/80 border border-gray-800 px-3.5 py-2 rounded-xl self-start sm:self-auto">
          <Clock size={14} className="text-accent" />
          <span>
            {latestEmailDate ? `Gmail sync: ${latestEmailDate}` : `Dashboard updated: ${lastDashboardSync}`}
          </span>
        </div>
      </div>

      {/* ── Quick Action Buttons Row ── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleGeneratePlan}
          disabled={generatingPlan}
          className="px-5 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-sm rounded-xl transition-all flex items-center gap-2 shadow-lg shadow-accent/20 cursor-pointer disabled:opacity-50"
        >
          {generatingPlan ? (
            <>
              <div className="w-4 h-4 border-2 border-dark-bg border-t-transparent rounded-full animate-spin"></div>
              <span>Generating Plan with Phi-3.5...</span>
            </>
          ) : (
            <>
              <Sparkles size={18} />
              <span>Generate Day Plan</span>
            </>
          )}
        </button>

        <button
          onClick={() => setIsAddTaskOpen(true)}
          className="px-4 py-2.5 bg-card-bg hover:bg-gray-800/80 text-text-primary border border-gray-700/80 font-medium text-sm rounded-xl transition-all flex items-center gap-2 cursor-pointer"
        >
          <Plus size={18} className="text-accent" />
          <span>Add Task</span>
        </button>

        <button
          onClick={() => navigate('/chat')}
          className="px-4 py-2.5 bg-card-bg hover:bg-gray-800/80 text-text-primary border border-gray-700/80 font-medium text-sm rounded-xl transition-all flex items-center gap-2 cursor-pointer"
        >
          <MessageSquare size={18} className="text-accent" />
          <span>Open Chat</span>
        </button>
      </div>

      {/* ── Quick Stats Row (3 Cards) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        
        {/* Card 1: Emails Today */}
        <div 
          onClick={() => navigate('/emails')}
          className="bg-card-bg border border-gray-800/90 hover:border-accent/40 rounded-2xl p-5 space-y-3 transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase font-semibold text-text-secondary tracking-wider">Emails Today</span>
            <div className="p-2 bg-accent/10 rounded-xl text-accent group-hover:scale-110 transition-transform">
              <Mail size={20} />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-heading font-bold text-4xl text-text-primary">{emailCount}</span>
            <span className="text-xs text-text-secondary">fetched</span>
          </div>
        </div>

        {/* Card 2: Tasks Pending */}
        <div 
          onClick={() => navigate('/dayplan')}
          className="bg-card-bg border border-gray-800/90 hover:border-accent/40 rounded-2xl p-5 space-y-3 transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase font-semibold text-text-secondary tracking-wider">Tasks Pending</span>
            <div className="p-2 bg-amber-500/10 rounded-xl text-amber-400 group-hover:scale-110 transition-transform">
              <CheckSquare size={20} />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-heading font-bold text-4xl text-text-primary">{pendingTaskCount}</span>
            <span className="text-xs text-text-secondary">remaining</span>
          </div>
        </div>

        {/* Card 3: Meetings & Commitments */}
        <div 
          onClick={() => navigate('/dayplan')}
          className="bg-card-bg border border-gray-800/90 hover:border-accent/40 rounded-2xl p-5 space-y-3 transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase font-semibold text-text-secondary tracking-wider">Meetings / Commitments</span>
            <div className="p-2 bg-purple-500/10 rounded-xl text-purple-400 group-hover:scale-110 transition-transform">
              <Calendar size={20} />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-heading font-bold text-4xl text-text-primary">{meetingsCount}</span>
            <span className="text-xs text-text-secondary">scheduled</span>
          </div>
        </div>

      </div>

      {/* ── Top 3 Priorities Section ── */}
      <div className="bg-card-bg border border-gray-800/90 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="font-heading font-semibold text-xl text-text-primary flex items-center gap-2">
              <Sparkles size={20} className="text-accent" />
              Top Priorities Today
            </h3>
            <p className="text-text-secondary text-xs">Derived from your AI generated Day Plan schedule</p>
          </div>

          <button
            onClick={() => navigate('/dayplan')}
            className="text-xs text-accent hover:underline flex items-center gap-1 cursor-pointer font-medium"
          >
            <span>View Full Day Plan</span>
            <ArrowRight size={14} />
          </button>
        </div>

        {/* Priorities List or Empty State */}
        {!hasPlan || topPriorities.length === 0 ? (
          <div className="bg-dark-bg/60 border border-gray-800 rounded-xl p-8 text-center space-y-3">
            <Calendar className="mx-auto text-text-secondary opacity-50" size={36} />
            <p className="text-text-primary font-medium text-sm">No active day plan generated yet</p>
            <p className="text-text-secondary text-xs max-w-md mx-auto">
              Click "Generate Day Plan" above to create an AI-optimized schedule combining your emails, commitments, and task deadlines.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {topPriorities.map((item, index) => (
              <div 
                key={index}
                className="bg-dark-bg/80 border border-gray-800/80 hover:border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4 transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-accent bg-accent/10 px-2.5 py-1 rounded-md border border-accent/20 shrink-0">
                    {item.time || 'Anytime'}
                  </span>
                  <span className="text-sm font-medium text-text-primary truncate">
                    {item.task}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.source && (
                    <span className="text-[10px] uppercase font-semibold text-text-secondary bg-gray-800 px-2 py-0.5 rounded">
                      {item.source}
                    </span>
                  )}
                  <span className={`text-[11px] font-semibold uppercase px-2.5 py-0.5 rounded-full ${getPriorityBadgeClass(item.priority)}`}>
                    {item.priority || 'medium'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reusable Add Task Modal */}
      <AddTaskModal
        isOpen={isAddTaskOpen}
        onClose={() => setIsAddTaskOpen(false)}
        onTaskAdded={() => fetchDashboardData()}
      />

    </div>
  );
}
