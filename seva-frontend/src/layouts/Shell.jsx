import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Target,
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
  { to: '/goals',        label: 'Goals',          Icon: Target          },
  { to: '/emails',       label: 'Email Insights',  Icon: Mail            },
  { to: '/dayplan',      label: 'Day Plan',        Icon: Calendar        },
  { to: '/chat',         label: 'Chat',            Icon: MessageCircle   },
  { to: '/nightsummary', label: 'Night Summary',   Icon: Moon            },
];

export default function Shell() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-deep text-text-primary">

      {/* ── Sidebar ───────────────────────────────────────────────── */}
      <aside
        className={`
          relative z-20 flex flex-col flex-shrink-0
          bg-navy border-r border-muted
          transition-all duration-300 ease-in-out
          ${collapsed ? 'w-16' : 'w-64'}
        `}
      >
        {/* Brand */}
        <div className={`flex items-center gap-2.5 px-5 py-5 border-b border-muted ${collapsed ? 'justify-center' : ''}`}>
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

        {/* Nav Links */}
        <nav className="flex flex-col gap-1.5 px-3 py-4 flex-1">
          {NAV_LINKS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
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

        {/* Collapse Toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="
            flex items-center justify-center mx-auto mb-4
            w-8 h-8 rounded-full
            bg-muted hover:bg-accent/20 text-text-secondary hover:text-accent
            border border-muted hover:border-accent/40
            transition-all duration-200 cursor-pointer
          "
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </aside>

      {/* ── Main Content Area ─────────────────────────────────────── */}
      <div className="relative flex-1 flex flex-col h-screen overflow-hidden min-w-0 bg-deep">
        <main className="relative z-10 flex-1 overflow-y-auto min-w-0">
          <div className="p-6 md:p-8 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
