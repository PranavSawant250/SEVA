import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Mail,
  Calendar,
  MessageCircle,
  Moon,
  ChevronLeft,
  ChevronRight,
  Zap,
} from 'lucide-react';

const NAV_LINKS = [
  { to: '/dashboard',    label: 'Dashboard',      Icon: LayoutDashboard },
  { to: '/emails',       label: 'Email Insights',  Icon: Mail            },
  { to: '/dayplan',      label: 'Day Plan',        Icon: Calendar        },
  { to: '/chat',         label: 'Chat',            Icon: MessageCircle   },
  { to: '/nightsummary', label: 'Night Summary',   Icon: Moon            },
];

export default function Shell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">

      {/* ── Sidebar ───────────────────────────────────────────────── */}
      <aside
        className={`
          relative flex flex-col flex-shrink-0
          bg-navy border-r border-muted
          transition-all duration-300 ease-in-out
          ${collapsed ? 'w-16' : 'w-60'}
        `}
        style={{ boxShadow: '4px 0 24px rgba(0,0,0,0.4)' }}
      >
        {/* Brand */}
        <div className={`flex items-center gap-2 px-4 py-5 border-b border-muted ${collapsed ? 'justify-center' : ''}`}>
          <div className="relative flex-shrink-0">
            <Zap
              size={22}
              className="text-accent"
              style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.7))' }}
            />
          </div>
          {!collapsed && (
            <span
              className="font-heading font-bold text-xl tracking-wider text-accent text-glow"
              style={{ letterSpacing: '0.1em' }}
            >
              SEVA
            </span>
          )}
        </div>

        {/* Nav Links */}
        <nav className="flex flex-col gap-1 px-2 py-4 flex-1">
          {NAV_LINKS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `
                flex items-center gap-3 px-3 py-2.5 rounded-lg
                font-sans text-sm font-medium
                transition-all duration-200 ease-in-out
                group relative
                ${isActive
                  ? 'bg-accent/10 text-accent border-r-2 border-accent shadow-accent-glow-sm'
                  : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                }
                ${collapsed ? 'justify-center' : ''}
              `}
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    className={`flex-shrink-0 transition-all duration-200 ${isActive ? 'drop-shadow-[0_0_6px_rgba(0,217,255,0.6)]' : 'group-hover:text-accent'}`}
                    style={isActive ? { filter: 'drop-shadow(0 0 5px rgba(0,217,255,0.5))' } : {}}
                  />
                  {!collapsed && (
                    <span>{label}</span>
                  )}
                  {/* Tooltip on collapsed */}
                  {collapsed && (
                    <div className="
                      absolute left-full ml-3 px-2 py-1 rounded
                      bg-panel border border-muted text-text-primary text-xs whitespace-nowrap
                      opacity-0 group-hover:opacity-100 pointer-events-none
                      transition-opacity duration-150 z-50
                    ">
                      {label}
                    </div>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Collapse Toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="
            flex items-center justify-center mx-auto mb-4
            w-8 h-8 rounded-full
            bg-muted hover:bg-accent/20 text-text-secondary hover:text-accent
            border border-muted hover:border-accent/40
            transition-all duration-200
          "
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </aside>

      {/* ── Main Content Area ─────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto min-w-0">
        {/* Subtle top accent bar */}
        <div className="h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
        <div className="p-6 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
