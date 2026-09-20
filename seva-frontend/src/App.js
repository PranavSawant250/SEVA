import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Layout
import Shell from './layouts/Shell';

// Screens
import Login        from './screens/Login';
import Dashboard    from './screens/Dashboard';
import EmailInsights from './screens/EmailInsights';
import DayPlan      from './screens/DayPlan';
import Chat         from './screens/Chat';
import NightSummary from './screens/NightSummary';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ── Standalone screens (no Shell wrapper) ── */}
        <Route path="/login" element={<Login />} />

        {/* ── Shell-wrapped screens ────────────────── */}
        <Route element={<Shell />}>
          <Route path="/dashboard"    element={<Dashboard />} />
          <Route path="/emails"       element={<EmailInsights />} />
          <Route path="/dayplan"      element={<DayPlan />} />
          <Route path="/chat"         element={<Chat />} />
          <Route path="/nightsummary" element={<NightSummary />} />
        </Route>

        {/* ── Root redirect ────────────────────────── */}
        <Route path="/" element={<Navigate to="/login" replace />} />
        {/* Catch-all fallback */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
