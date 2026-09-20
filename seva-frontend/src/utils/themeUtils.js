// Shared theme & priority styling utilities for SEVA Frontend

export function getPriorityBadgeClass(priority) {
  const p = (priority || 'medium').toLowerCase();
  switch (p) {
    case 'high':
      return 'bg-red-500/15 text-red-400 border border-red-500/30';
    case 'medium':
      return 'bg-amber-500/15 text-amber-400 border border-amber-500/30';
    case 'low':
      return 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30';
    default:
      return 'bg-gray-500/15 text-gray-400 border border-gray-500/30';
  }
}

export function getEventTypeBadgeClass(eventType) {
  const type = (eventType || 'general').toLowerCase();
  switch (type) {
    case 'meeting':
      return 'bg-purple-500/15 text-purple-400 border border-purple-500/30';
    case 'deadline':
      return 'bg-rose-500/15 text-rose-400 border border-rose-500/30';
    case 'opportunity':
      return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
    default:
      return 'bg-blue-500/15 text-blue-400 border border-blue-500/30';
  }
}
