import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  LogIn, 
  Calendar, 
  Plus, 
  Trash2, 
  ArrowRight, 
  CheckCircle2, 
  Sparkles, 
  AlertCircle,
  Clock,
  BookOpen
} from 'lucide-react';
import client from '../api/client';

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const DEFAULT_TIMETABLE_ROWS = [
  { day_of_week: 'Monday', subject: 'Data Structures & Algorithms', start_time: '9:00 AM', end_time: '11:00 AM' },
  { day_of_week: 'Monday', subject: 'Web Development Lab', start_time: '1:30 PM', end_time: '3:30 PM' },
  { day_of_week: 'Tuesday', subject: 'Database Management Systems', start_time: '10:00 AM', end_time: '12:00 PM' },
  { day_of_week: 'Wednesday', subject: 'Operating Systems Lecture', start_time: '9:00 AM', end_time: '11:00 AM' },
  { day_of_week: 'Thursday', subject: 'Software Engineering', start_time: '2:00 PM', end_time: '4:00 PM' },
  { day_of_week: 'Friday', subject: 'Project Lab & Seminar', start_time: '10:00 AM', end_time: '1:00 PM' },
];

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();

  // States: 'loading' | 'first_time' | 'returning' | 'setup_timetable' | 'error'
  const [appState, setAppState] = useState('loading');
  const [timetableRows, setTimetableRows] = useState(DEFAULT_TIMETABLE_ROWS);
  const [errorMsg, setErrorMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Check if user was sent from Dashboard guard OR refreshed mid-setup
    const isSetupStep = location.state?.step === 'timetable' || sessionStorage.getItem('sevaSetupInProgress') === 'true';

    if (isSetupStep) {
      sessionStorage.setItem('sevaSetupInProgress', 'true');
      setAppState('setup_timetable');
      return;
    }

    // Check existing timetable to decide between returning user & first time user
    client.get('/timetable')
      .then(res => {
        if (res.data.count > 0) {
          setAppState('returning');
        } else {
          setAppState('first_time');
        }
      })
      .catch(err => {
        console.error('[SEVA] Login state detection error:', err);
        setErrorMsg('Failed to connect to SEVA backend server. Make sure node server.js is running on port 3001.');
        setAppState('error');
      });
  }, [location.state]);

  const handleGoogleConnect = () => {
    window.location.href = 'http://localhost:3001/api/auth/gmail';
  };

  const handleAddRow = () => {
    setTimetableRows([
      ...timetableRows,
      { day_of_week: 'Monday', subject: '', start_time: '9:00 AM', end_time: '10:00 AM' }
    ]);
  };

  const handleRemoveRow = (index) => {
    if (timetableRows.length === 1) {
      setErrorMsg('Your schedule must have at least 1 entry.');
      return;
    }
    setErrorMsg('');
    setTimetableRows(timetableRows.filter((_, i) => i !== index));
  };

  const handleRowChange = (index, field, value) => {
    const updated = [...timetableRows];
    updated[index][field] = value;
    setTimetableRows(updated);
  };

  const handleSaveTimetable = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    // Client-side validation
    for (let i = 0; i < timetableRows.length; i++) {
      const row = timetableRows[i];
      if (!row.subject.trim() || !row.start_time.trim() || !row.end_time.trim()) {
        setErrorMsg(`Row #${i + 1} has incomplete fields. Please fill in Subject, Start Time, and End Time.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await client.post('/timetable', timetableRows);
      if (res.data.success) {
        sessionStorage.removeItem('sevaSetupInProgress');
        navigate('/dashboard', { replace: true });
      } else {
        setErrorMsg(res.data.error || 'Failed to save timetable.');
      }
    } catch (err) {
      console.error('[SEVA] Timetable save failed:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Error saving timetable.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-main-gradient flex items-center justify-center p-4 sm:p-6 font-sans">
      <div className="w-full max-w-2xl bg-card-bg border border-gray-800/80 rounded-2xl shadow-2xl p-6 sm:p-10 backdrop-blur-md">
        
        {/* Header Branding */}
        <div className="text-center space-y-2 mb-8">
          <div className="flex items-center justify-center gap-3">
            <LogIn size={36} className="text-accent" style={{ filter: 'drop-shadow(0 0 10px rgba(0,217,255,0.7))' }} />
            <h1 className="font-heading font-bold text-4xl text-accent text-glow tracking-wider">SEVA</h1>
          </div>
          <p className="text-sm font-medium text-text-secondary uppercase tracking-widest">Personal Life Orchestrator</p>
        </div>

        {/* Global Error Banner */}
        {errorMsg && (
          <div className="mb-6 p-4 bg-red-950/40 border border-red-500/50 rounded-xl flex items-start gap-3 text-red-400 text-sm">
            <AlertCircle size={20} className="shrink-0 mt-0.5" />
            <div className="flex-1">{errorMsg}</div>
          </div>
        )}

        {/* ── STATE 1: LOADING ── */}
        {appState === 'loading' && (
          <div className="py-12 flex flex-col items-center justify-center space-y-4">
            <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
            <p className="text-text-secondary text-sm">Initializing SEVA session...</p>
          </div>
        )}

        {/* ── STATE 2: ERROR ── */}
        {appState === 'error' && (
          <div className="text-center py-8 space-y-4">
            <p className="text-text-secondary text-sm">Unable to verify SEVA backend state.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2.5 bg-accent/20 hover:bg-accent/30 text-accent font-medium rounded-xl border border-accent/40 transition-all"
            >
              Retry Connection
            </button>
          </div>
        )}

        {/* ── STATE 3: FIRST TIME USER - STEP 1 (GOOGLE OAUTH) ── */}
        {appState === 'first_time' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-gray-800 pb-4">
              <span className="text-xs uppercase font-semibold text-accent tracking-wider bg-accent/10 px-3 py-1 rounded-full border border-accent/30">
                Step 1 of 2 — Authentication
              </span>
              <span className="text-xs text-text-secondary">First-time Setup</span>
            </div>

            <div className="space-y-3">
              <h2 className="font-heading font-semibold text-2xl text-text-primary">Connect Your Google Account</h2>
              <p className="text-text-secondary text-sm leading-relaxed">
                SEVA integrates seamlessly with your Gmail account to scan for urgent academic notifications, exam schedules, and assignment deadlines.
              </p>
            </div>

            <div className="bg-dark-bg/60 border border-gray-800/80 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-3 text-sm text-text-primary">
                <CheckCircle2 size={18} className="text-accent shrink-0" />
                <span>Automated email fetching & AI workload analysis</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-text-primary">
                <CheckCircle2 size={18} className="text-accent shrink-0" />
                <span>Smart dynamic replanning for incoming surprise events</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-text-primary">
                <CheckCircle2 size={18} className="text-accent shrink-0" />
                <span>Secure local SQLite storage (tokens saved to token.json)</span>
              </div>
            </div>

            <button
              onClick={handleGoogleConnect}
              className="w-full py-3.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-base rounded-xl transition-all flex items-center justify-center gap-3 shadow-lg shadow-accent/20 cursor-pointer"
            >
              <span>Continue with Google</span>
              <ArrowRight size={20} />
            </button>
          </div>
        )}

        {/* ── STATE 4: RETURNING USER VIEW ── */}
        {appState === 'returning' && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-block text-xs uppercase font-semibold text-emerald-400 tracking-wider bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/30">
                Session Active
              </span>
              <h2 className="font-heading font-semibold text-2xl text-text-primary">Welcome Back</h2>
              <p className="text-text-secondary text-sm">
                Your schedule & Gmail setup are active in SEVA.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                onClick={() => navigate('/dashboard')}
                className="py-3.5 px-4 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-sm rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-accent/20"
              >
                <span>Launch Dashboard</span>
                <ArrowRight size={18} />
              </button>
              
              <button
                onClick={handleGoogleConnect}
                className="py-3.5 px-4 bg-dark-bg hover:bg-gray-800/80 text-text-primary border border-gray-700 font-medium text-sm rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>Re-authenticate Google</span>
              </button>
            </div>

            <div className="text-center pt-2">
              <button
                onClick={() => {
                  sessionStorage.setItem('sevaSetupInProgress', 'true');
                  setAppState('setup_timetable');
                }}
                className="text-xs text-accent/80 hover:text-accent underline cursor-pointer"
              >
                Edit Weekly Timetable Schedule
              </button>
            </div>
          </div>
        )}

        {/* ── STATE 5: FIRST TIME USER - STEP 2 (TIMETABLE WIZARD) ── */}
        {appState === 'setup_timetable' && (
          <form onSubmit={handleSaveTimetable} className="space-y-6">
            <div className="flex items-center justify-between border-b border-gray-800 pb-4">
              <span className="text-xs uppercase font-semibold text-accent tracking-wider bg-accent/10 px-3 py-1 rounded-full border border-accent/30 flex items-center gap-1.5">
                <Sparkles size={14} />
                Step 2 of 2 — Weekly Schedule
              </span>
              <span className="text-xs text-text-secondary">Timetable Setup</span>
            </div>

            <div className="space-y-2">
              <h2 className="font-heading font-semibold text-2xl text-text-primary flex items-center gap-2">
                <Calendar className="text-accent" size={24} />
                Set Up Your Weekly Timetable
              </h2>
              <p className="text-text-secondary text-sm leading-relaxed">
                Add your fixed recurring lectures, labs, and commitments. SEVA will automatically construct your daily plan around these fixed slots.
              </p>
            </div>

            {/* Rows List */}
            <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
              {timetableRows.map((row, idx) => (
                <div 
                  key={idx} 
                  className="bg-dark-bg/80 border border-gray-800 rounded-xl p-3.5 space-y-3 sm:space-y-0 sm:flex sm:items-center sm:gap-3"
                >
                  {/* Day Dropdown */}
                  <div className="w-full sm:w-36">
                    <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1 font-semibold">Day</label>
                    <select
                      value={row.day_of_week}
                      onChange={(e) => handleRowChange(idx, 'day_of_week', e.target.value)}
                      className="w-full bg-card-bg border border-gray-700/80 rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
                    >
                      {DAYS_OF_WEEK.map((day) => (
                        <option key={day} value={day} className="bg-dark-bg text-text-primary">
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Subject Input */}
                  <div className="flex-1">
                    <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1 font-semibold">Subject / Activity</label>
                    <div className="relative">
                      <BookOpen size={14} className="absolute left-2.5 top-2 text-text-secondary" />
                      <input
                        type="text"
                        placeholder="e.g. Data Structures"
                        value={row.subject}
                        onChange={(e) => handleRowChange(idx, 'subject', e.target.value)}
                        className="w-full bg-card-bg border border-gray-700/80 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  {/* Start Time */}
                  <div className="w-full sm:w-28">
                    <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1 font-semibold">Start Time</label>
                    <div className="relative">
                      <Clock size={14} className="absolute left-2.5 top-2 text-text-secondary" />
                      <input
                        type="text"
                        placeholder="9:00 AM"
                        value={row.start_time}
                        onChange={(e) => handleRowChange(idx, 'start_time', e.target.value)}
                        className="w-full bg-card-bg border border-gray-700/80 rounded-lg pl-8 pr-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  {/* End Time */}
                  <div className="w-full sm:w-28">
                    <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1 font-semibold">End Time</label>
                    <div className="relative">
                      <Clock size={14} className="absolute left-2.5 top-2 text-text-secondary" />
                      <input
                        type="text"
                        placeholder="11:00 AM"
                        value={row.end_time}
                        onChange={(e) => handleRowChange(idx, 'end_time', e.target.value)}
                        className="w-full bg-card-bg border border-gray-700/80 rounded-lg pl-8 pr-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  {/* Delete Button */}
                  <div className="pt-2 sm:pt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleRemoveRow(idx)}
                      className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded-lg transition-all"
                      title="Remove row"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Controls */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-gray-800 pt-4">
              <button
                type="button"
                onClick={handleAddRow}
                className="w-full sm:w-auto px-4 py-2 bg-dark-bg hover:bg-gray-800 text-text-primary border border-gray-700 rounded-xl text-xs font-medium flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Plus size={16} className="text-accent" />
                <span>Add Class / Slot</span>
              </button>

              <button
                type="submit"
                disabled={submitting}
                className="w-full sm:w-auto px-6 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-sm rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-accent/20 disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-dark-bg border-t-transparent rounded-full animate-spin"></div>
                    <span>Saving Timetable...</span>
                  </>
                ) : (
                  <>
                    <span>Complete Setup & Launch Dashboard</span>
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
}
