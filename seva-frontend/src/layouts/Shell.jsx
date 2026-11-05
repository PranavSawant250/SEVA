import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Target,
  Mail,
  Calendar,
  MessageCircle,
  Moon,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Zap,
  User,
  Settings,
  LogOut,
  X,
  Menu,
  Shield,
  Clock,
  CheckCircle2,
  BookOpen
} from 'lucide-react';
import client from '../api/client';

const NAV_LINKS = [
  { to: '/dashboard',    label: 'Dashboard',      Icon: LayoutDashboard },
  { to: '/goals',        label: 'Goals',          Icon: Target          },
  { to: '/emails',       label: 'Email Insights',  Icon: Mail            },
  { to: '/dayplan',      label: 'Day Plan',        Icon: Calendar        },
  { to: '/chat',         label: 'Chat',            Icon: MessageCircle   },
  { to: '/nightsummary', label: 'Night Summary',   Icon: Moon            },
];

export default function Shell() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const [user, setUser] = useState({
    name: 'Pranav',
    email: 'pranav@seva.local',
    role: 'Student / Engineering',
    avatar: null
  });

  const menuRef = useRef(null);
  const profileBtnRef = useRef(null);

  // ── Authentication Guard & Initial Profile Fetch ───────────────
  useEffect(() => {
    if (localStorage.getItem('seva_logged_out') === 'true') {
      navigate('/login', { replace: true });
      return;
    }

    let isMounted = true;
    client.get('/auth/status')
      .then(res => {
        if (!isMounted) return;
        if (!res.data?.authenticated) {
          localStorage.setItem('seva_logged_out', 'true');
          navigate('/login', { replace: true });
        } else if (res.data?.user) {
          setUser(prev => ({
            ...prev,
            ...res.data.user
          }));
        }
      })
      .catch(() => {
        if (isMounted) {
          localStorage.setItem('seva_logged_out', 'true');
          navigate('/login', { replace: true });
        }
      });

    return () => { isMounted = false; };
  }, [navigate]);

  // ── Outside Click & Escape Listener for Profile Dropdown ────────
  useEffect(() => {
    function handleClickOutside(event) {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target) &&
        profileBtnRef.current &&
        !profileBtnRef.current.contains(event.target)
      ) {
        setShowProfileMenu(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setShowProfileMenu(false);
        setIsProfileModalOpen(false);
        setIsSettingsModalOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // ── Logout Action Handler ──────────────────────────────────────
  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await client.post('/auth/logout').catch(() => {});
    } finally {
      // 1. Mark session as logged out
      localStorage.setItem('seva_logged_out', 'true');
      localStorage.removeItem('seva_auth');
      sessionStorage.clear();

      // 2. Broadcast logout across any open tabs via BroadcastChannel
      try {
        const bc = new BroadcastChannel('seva_sync_channel');
        bc.postMessage({ domains: ['auth_logout'], timestamp: Date.now() });
        bc.close();
      } catch (_) {}

      // 3. Reset state & redirect
      setShowProfileMenu(false);
      setLoggingOut(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-deep text-text-primary">

      {/* ── Mobile Backdrop Overlay ───────────────────────────────── */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 bg-black/60 z-30 md:hidden backdrop-blur-sm transition-opacity"
        />
      )}

      {/* ── Sidebar ───────────────────────────────────────────────── */}
      <aside
        className={`
          fixed md:relative z-40 md:z-20 flex flex-col flex-shrink-0 h-full
          bg-navy border-r border-muted
          transition-all duration-300 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          ${collapsed ? 'w-16' : 'w-64'}
        `}
      >
        {/* Brand */}
        <div className={`flex items-center justify-between px-5 py-5 border-b border-muted ${collapsed ? 'justify-center px-2' : ''}`}>
          <div className="flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <Zap size={22} className="text-accent" />
            </div>
            {!collapsed && (
              <span
                className="font-heading font-bold text-2xl tracking-wider text-accent"
                style={{ letterSpacing: '0.08em' }}
              >
                SEVA
              </span>
            )}
          </div>
          {/* Mobile close button */}
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden text-text-secondary hover:text-text-primary p-1 rounded-lg"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav Links */}
        <nav className="flex flex-col gap-1.5 px-3 py-4 flex-1 overflow-y-auto min-h-0">
          {NAV_LINKS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => `
                flex items-center gap-3.5 px-3.5 py-3 rounded-xl
                font-sans text-[15px] font-medium
                transition-all duration-150 ease-in-out
                group relative
                ${isActive
                  ? 'bg-accent/15 text-accent border border-accent/30 font-semibold'
                  : 'text-text-secondary hover:bg-muted/60 hover:text-text-primary'
                }
                ${collapsed ? 'justify-center px-2' : ''}
              `}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={20}
                    className={`flex-shrink-0 ${isActive ? 'text-accent' : 'text-text-secondary group-hover:text-text-primary'}`}
                  />
                  {!collapsed && (
                    <span>{label}</span>
                  )}
                  {/* Tooltip on collapsed */}
                  {collapsed && (
                    <div className="
                      absolute left-full ml-3 px-2.5 py-1.5 rounded-lg
                      bg-panel border border-muted text-text-primary text-sm whitespace-nowrap
                      opacity-0 group-hover:opacity-100 pointer-events-none
                      transition-opacity duration-150 z-50 shadow-lg
                    ">
                      {label}
                    </div>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Desktop Collapse Toggle */}
        <div className="hidden md:flex justify-center pb-2">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="
              flex items-center justify-center
              w-8 h-8 rounded-full
              bg-muted hover:bg-accent/20 text-text-secondary hover:text-accent
              border border-muted hover:border-accent/40
              transition-all duration-200 cursor-pointer
            "
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {/* ── Fixed User Profile Section at Bottom ────────────────── */}
        <div className="relative border-t border-muted p-2.5 bg-navy flex-shrink-0">
          
          {/* Profile Dropdown Menu (Anchored upwards to prevent overflow) */}
          {showProfileMenu && (
            <div
              ref={menuRef}
              className={`
                absolute bottom-full mb-2 z-50
                ${collapsed ? 'left-full ml-3 bottom-0 w-60' : 'left-2.5 right-2.5'}
                bg-panel/95 backdrop-blur-xl border border-muted/80 rounded-2xl shadow-2xl p-1.5
                animate-in fade-in slide-in-from-bottom-2 duration-150
              `}
            >
              {/* Dropdown User Header */}
              <div className="px-3 py-2.5 border-b border-muted/60 mb-1">
                <div className="text-[11px] uppercase font-semibold text-text-secondary tracking-wider">Signed in as</div>
                <div className="text-sm font-semibold text-text-primary truncate">{user.name}</div>
                <div className="text-xs text-text-secondary truncate">{user.email}</div>
              </div>

              {/* 1. My Profile */}
              <button
                onClick={() => {
                  setShowProfileMenu(false);
                  setIsProfileModalOpen(true);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-muted/60 rounded-xl transition-all cursor-pointer text-left"
              >
                <User size={16} className="text-accent" />
                <span>My Profile</span>
              </button>

              {/* 2. Settings */}
              <button
                onClick={() => {
                  setShowProfileMenu(false);
                  setIsSettingsModalOpen(true);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-muted/60 rounded-xl transition-all cursor-pointer text-left"
              >
                <Settings size={16} className="text-accent" />
                <span>Settings</span>
              </button>

              <div className="border-t border-muted/60 my-1" />

              {/* 3. Logout */}
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/15 rounded-xl transition-all cursor-pointer text-left"
              >
                <LogOut size={16} className="text-red-400" />
                <span>{loggingOut ? 'Logging out...' : 'Logout'}</span>
              </button>
            </div>
          )}

          {/* Profile Trigger Button */}
          <button
            ref={profileBtnRef}
            onClick={() => setShowProfileMenu(prev => !prev)}
            className={`
              w-full flex items-center gap-3 p-2 rounded-xl
              hover:bg-muted/60 transition-all cursor-pointer text-left
              ${collapsed ? 'justify-center p-1.5' : ''}
              ${showProfileMenu ? 'bg-muted/50 ring-1 ring-accent/30' : ''}
            `}
            title={collapsed ? `${user.name} (${user.email})` : undefined}
          >
            {/* User Avatar */}
            <div className="relative flex-shrink-0">
              <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-accent/80 to-accent text-dark-bg font-heading font-bold text-sm flex items-center justify-center shadow-md shadow-accent/20">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-full h-full rounded-full object-cover" />
                ) : (
                  <span>{(user.name || 'P').charAt(0).toUpperCase()}</span>
                )}
              </div>
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 border-2 border-navy rounded-full" />
            </div>

            {/* User Details */}
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text-primary truncate">
                  {user.name}
                </div>
                <div className="text-xs text-text-secondary truncate">
                  {user.email}
                </div>
              </div>
            )}

            {/* Chevron toggle */}
            {!collapsed && (
              <div className="text-text-secondary hover:text-text-primary shrink-0 transition-transform duration-200">
                {showProfileMenu ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </div>
            )}
          </button>
        </div>
      </aside>

      {/* ── Main Content Area ─────────────────────────────────────── */}
      <div className="relative flex-1 flex flex-col h-screen overflow-hidden min-w-0 bg-deep">
        
        {/* Mobile Header Bar */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-navy border-b border-muted z-10 flex-shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 text-text-secondary hover:text-text-primary hover:bg-muted/60 rounded-xl"
            title="Open navigation menu"
          >
            <Menu size={22} />
          </button>
          
          <div className="flex items-center gap-2">
            <Zap size={20} className="text-accent" />
            <span className="font-heading font-bold text-xl tracking-wider text-accent">SEVA</span>
          </div>

          <button
            onClick={() => setIsProfileModalOpen(true)}
            className="w-8 h-8 rounded-full bg-accent/20 text-accent font-heading font-bold text-xs flex items-center justify-center border border-accent/40"
            title="View Profile"
          >
            {(user.name || 'P').charAt(0).toUpperCase()}
          </button>
        </header>

        <main className="relative z-10 flex-1 overflow-y-auto min-w-0">
          <div className="p-4 sm:p-6 md:p-8 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>

      {/* ── My Profile Modal ──────────────────────────────────────── */}
      {isProfileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-navy border border-muted rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-6">
            
            <div className="flex items-center justify-between border-b border-muted pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-accent/15 rounded-xl text-accent">
                  <User size={20} />
                </div>
                <div>
                  <h3 className="font-heading font-semibold text-lg text-text-primary">User Profile</h3>
                  <p className="text-xs text-text-secondary">Connected SEVA Account Details</p>
                </div>
              </div>
              <button
                onClick={() => setIsProfileModalOpen(false)}
                className="text-text-secondary hover:text-text-primary p-1 rounded-lg"
              >
                <X size={18} />
              </button>
            </div>

            {/* Profile Avatar Card */}
            <div className="flex items-center gap-4 p-4 bg-dark-bg/60 border border-muted rounded-xl">
              <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-accent to-accent/70 text-dark-bg font-heading font-bold text-xl flex items-center justify-center shadow-lg shadow-accent/20">
                {(user.name || 'P').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-heading font-bold text-lg text-text-primary truncate">{user.name}</div>
                <div className="text-sm text-accent truncate">{user.email}</div>
                <div className="text-xs text-text-secondary mt-0.5">{user.role}</div>
              </div>
            </div>

            {/* Profile Information List */}
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between p-3 bg-muted/20 border border-muted/50 rounded-xl">
                <span className="text-text-secondary">Institution:</span>
                <span className="font-medium text-text-primary text-right truncate">Walchand College of Engineering</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/20 border border-muted/50 rounded-xl">
                <span className="text-text-secondary">Department:</span>
                <span className="font-medium text-text-primary">Information Technology</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/20 border border-muted/50 rounded-xl">
                <span className="text-text-secondary">Timezone:</span>
                <span className="font-medium text-accent">Asia/Kolkata (IST)</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/20 border border-muted/50 rounded-xl">
                <span className="text-text-secondary">Gmail Auto-Sync:</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-400">
                  <CheckCircle2 size={14} />
                  <span>Every 5 minutes</span>
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setIsProfileModalOpen(false)}
                className="px-5 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-sm rounded-xl transition-all cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings Modal ────────────────────────────────────────── */}
      {isSettingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-navy border border-muted rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-6">
            
            <div className="flex items-center justify-between border-b border-muted pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-accent/15 rounded-xl text-accent">
                  <Settings size={20} />
                </div>
                <div>
                  <h3 className="font-heading font-semibold text-lg text-text-primary">SEVA Settings</h3>
                  <p className="text-xs text-text-secondary">Active Engine Configuration</p>
                </div>
              </div>
              <button
                onClick={() => setIsSettingsModalOpen(false)}
                className="text-text-secondary hover:text-text-primary p-1 rounded-lg"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 text-sm">
              <div className="p-4 bg-dark-bg/60 border border-muted rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary flex items-center gap-2">
                    <Clock size={16} className="text-accent" />
                    <span>Gmail Auto-Sync Schedule</span>
                  </span>
                  <span className="text-xs bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 rounded-full font-semibold">
                    Every 5 minutes
                  </span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Automated background scanner pulls urgent emails, academic submissions, and meeting notices every 5 minutes with concurrency protection.
                </p>
              </div>

              <div className="p-4 bg-dark-bg/60 border border-muted rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary flex items-center gap-2">
                    <Shield size={16} className="text-accent" />
                    <span>AI Reasoning Orchestrator</span>
                  </span>
                  <span className="text-xs bg-accent/15 text-accent border border-accent/30 px-2.5 py-1 rounded-full font-semibold">
                    Groq 120B / Gemini
                  </span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Multi-tier LLM engine with Groq (openai/gpt-oss-120b) primary, multimodal Gemini 2.5/flash-lite vision, and deterministic scheduler safeguards.
                </p>
              </div>

              <div className="p-4 bg-dark-bg/60 border border-muted rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary flex items-center gap-2">
                    <BookOpen size={16} className="text-accent" />
                    <span>Persistent Timetable</span>
                  </span>
                  <span className="text-xs bg-accent/15 text-accent border border-accent/30 px-2.5 py-1 rounded-full font-semibold">
                    Active
                  </span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Recurring weekly classes and laboratory blocks are permanently stored in SQLite and protected as fixed blocks in daily plans.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setIsSettingsModalOpen(false)}
                className="px-5 py-2.5 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-sm rounded-xl transition-all cursor-pointer"
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
