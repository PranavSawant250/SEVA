/**
 * seva-frontend/src/utils/syncEvents.js
 *
 * Lightweight global data synchronization bus for SEVA frontend.
 *
 * Capabilities:
 * 1. Intra-tab synchronization via window CustomEvent('seva:data-mutated').
 * 2. Cross-tab synchronization via window BroadcastChannel('seva_sync_channel').
 * 3. Focus and visibility re-synchronization on tab switch / window focus.
 *
 * Invariant: Never stores duplicate data caches. Subscribers always refetch authoritative
 * backend data directly from standard endpoints.
 */

import { useEffect, useRef } from 'react';

const CHANNEL_NAME = 'seva_sync_channel';
let broadcastChannel = null;

if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
  } catch (err) {
    console.warn('[SEVA Sync] BroadcastChannel initialization failed:', err);
  }
}

/**
 * Emits a mutation event across the current tab and other open browser tabs.
 *
 * @param {string|string[]} domains - e.g. ['tasks', 'plan', 'goals']
 */
export function emitDataMutated(domains = []) {
  if (typeof window === 'undefined') return;

  const domainList = Array.isArray(domains) ? domains : [domains];
  const payload = {
    domains: domainList,
    timestamp: Date.now()
  };

  // 1. Current window event
  window.dispatchEvent(new CustomEvent('seva:data-mutated', { detail: payload }));

  // 2. Cross-tab event
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(payload);
    } catch (err) {
      console.warn('[SEVA Sync] BroadcastChannel postMessage failed:', err);
    }
  }
}

/**
 * React hook to subscribe a component to data mutation events, window focus,
 * and visibility changes.
 *
 * @param {string|string[]} domains - e.g. ['tasks', 'plan']
 * @param {Function} refetchCallback - Callback function to invoke when data mutates
 */
export function useDataSync(domains = [], refetchCallback) {
  const callbackRef = useRef(refetchCallback);
  callbackRef.current = refetchCallback;
  const timerRef = useRef(null);

  // Normalize domains into a stable primitive key to prevent re-subscribing on every render
  const domainKey = Array.isArray(domains) ? [...domains].sort().join(',') : String(domains || '');

  useEffect(() => {
    const domainList = domainKey ? domainKey.split(',') : [];

    const scheduleRefetch = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      // 50ms trailing debounce to coalesce rapid mutations or simultaneous focus+visibility triggers
      timerRef.current = setTimeout(() => {
        if (callbackRef.current) {
          callbackRef.current();
        }
      }, 50);
    };

    const shouldHandle = (mutatedDomains) => {
      if (domainList.length === 0) return true; // wildcard
      if (!Array.isArray(mutatedDomains)) return true;
      return domainList.some(d => mutatedDomains.includes(d));
    };

    const handleCustomEvent = (e) => {
      const mutated = (e && e.detail && e.detail.domains) || [];
      if (shouldHandle(mutated)) {
        scheduleRefetch();
      }
    };

    const handleBroadcastMessage = (e) => {
      const mutated = (e && e.data && e.data.domains) || [];
      if (shouldHandle(mutated)) {
        scheduleRefetch();
      }
    };

    const handleFocus = () => {
      // Re-fetch authoritative data when returning to tab
      scheduleRefetch();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefetch();
      }
    };

    // Register event listeners
    window.addEventListener('seva:data-mutated', handleCustomEvent);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (broadcastChannel) {
      broadcastChannel.addEventListener('message', handleBroadcastMessage);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      window.removeEventListener('seva:data-mutated', handleCustomEvent);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (broadcastChannel) {
        broadcastChannel.removeEventListener('message', handleBroadcastMessage);
      }
    };
  }, [domainKey]);
}

