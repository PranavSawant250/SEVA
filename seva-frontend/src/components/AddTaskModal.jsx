import React, { useState } from 'react';
import { X, Plus, AlertCircle, Clock, Tag } from 'lucide-react';
import client from '../api/client';

export default function AddTaskModal({ isOpen, onClose, onTaskAdded }) {
  const [name, setName] = useState('');
  const [priority, setPriority] = useState('medium');
  const [timeSlot, setTimeSlot] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Task name is required.');
      return;
    }

    setErrorMsg('');
    setLoading(true);

    try {
      const res = await client.post('/tasks', {
        name: name.trim(),
        priority,
        time_slot: timeSlot.trim() || 'Anytime',
        date: 'today'
      });

      if (res.data.success) {
        setName('');
        setPriority('medium');
        setTimeSlot('');
        onTaskAdded && onTaskAdded(res.data.task);
        onClose();
      } else {
        setErrorMsg(res.data.error || 'Failed to add task.');
      }
    } catch (err) {
      console.error('[SEVA] Add task error:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Failed to add task.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-card-bg border border-gray-800 rounded-2xl shadow-2xl p-6 space-y-6 relative animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 pb-4">
          <div className="flex items-center gap-2">
            <Plus className="text-accent" size={22} />
            <h3 className="font-heading font-semibold text-xl text-text-primary">Add New Task</h3>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-gray-800 rounded-lg transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center gap-2 text-red-400 text-xs">
            <AlertCircle size={16} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Task Name */}
          <div>
            <label className="block text-xs uppercase font-semibold tracking-wider text-text-secondary mb-1.5">
              Task Description *
            </label>
            <input
              type="text"
              placeholder="e.g., Complete DBMS Lab Assignment"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-dark-bg border border-gray-700/80 rounded-xl px-3.5 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
              autoFocus
            />
          </div>

          {/* Priority Select */}
          <div>
            <label className="block text-xs uppercase font-semibold tracking-wider text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Tag size={14} className="text-accent" />
              Priority Level
            </label>
            <div className="grid grid-cols-3 gap-2">
              {['high', 'medium', 'low'].map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold uppercase tracking-wider border transition-all ${
                    priority === p 
                      ? p === 'high'
                        ? 'bg-red-500/20 text-red-400 border-red-500'
                        : p === 'medium'
                        ? 'bg-amber-500/20 text-amber-400 border-amber-500'
                        : 'bg-cyan-500/20 text-cyan-400 border-cyan-500'
                      : 'bg-dark-bg border-gray-800 text-text-secondary hover:border-gray-700'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Time Slot Input */}
          <div>
            <label className="block text-xs uppercase font-semibold tracking-wider text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Clock size={14} className="text-accent" />
              Time Slot (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g., 4:00 PM or Anytime"
              value={timeSlot}
              onChange={(e) => setTimeSlot(e.target.value)}
              className="w-full bg-dark-bg border border-gray-700/80 rounded-xl px-3.5 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
            />
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-dark-bg hover:bg-gray-800 text-text-secondary hover:text-text-primary border border-gray-700 rounded-xl text-xs font-medium transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-accent hover:bg-accent/90 text-dark-bg font-heading font-semibold text-xs rounded-xl transition-all shadow-lg shadow-accent/20 cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Task'}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
