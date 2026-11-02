import React, { useEffect, useState, useRef, useCallback } from 'react';
import { 
  MessageSquare, 
  Send, 
  Bot, 
  User, 
  Sparkles, 
  AlertCircle, 
  RefreshCw, 
  Clock 
} from 'lucide-react';
import client from '../api/client';
import './Chat.css';

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Chat Messages State
  const [messages, setMessages] = useState([]);
  const [inputMsg, setInputMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendErrorId, setSendErrorId] = useState(null);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom of conversation
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending]);

  // Fetch Chat History (GET /api/chat/history)
  const fetchChatHistory = useCallback(async () => {
    setErrorMsg('');
    try {
      const res = await client.get('/chat/history');
      if (res.data.success) {
        setMessages(res.data.messages || []);
      } else {
        setErrorMsg('Failed to load chat history.');
      }
    } catch (err) {
      console.error('[SEVA] Error fetching chat history:', err);
      setErrorMsg(err.response?.data?.error || err.message || 'Unable to connect to SEVA chat backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChatHistory();
  }, [fetchChatHistory]);

  // Send Message Handler
  const handleSendMessage = async (textToSend = inputMsg, existingRequestId = null) => {
    const text = textToSend.trim();
    if (!text || isSending) return;

    // Deterministic Client Request ID: reuse on retry, generate new per fresh send
    const clientRequestId = existingRequestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Clear input & error state
    setInputMsg('');
    setSendErrorId(null);
    setIsSending(true);

    // Temp Optimistic User Message
    const tempUserMsgId = clientRequestId;
    const tempUserMsg = {
      id: tempUserMsgId,
      client_request_id: clientRequestId,
      role: 'user',
      message: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isPending: false
    };

    setMessages(prev => [...prev, tempUserMsg]);

    try {
      const res = await client.post('/chat/message', {
        message: text,
        client_request_id: clientRequestId
      });
      
      if (res.data.success && res.data.reply) {
        // Re-fetch chat history from server to get persistent DB row IDs
        const historyRes = await client.get('/chat/history');
        if (historyRes.data.success) {
          const fetchedMessages = historyRes.data.messages || [];
          if (fetchedMessages.length > 0 && fetchedMessages[fetchedMessages.length - 1].role === 'assistant') {
            fetchedMessages[fetchedMessages.length - 1].provider = res.data.provider;
            fetchedMessages[fetchedMessages.length - 1].badge = res.data.badge;
          }
          setMessages(fetchedMessages);
        } else {
          // Fallback append AI response
          setMessages(prev => [
            ...prev,
            {
              id: 'assistant-' + Date.now(),
              role: 'assistant',
              message: res.data.reply,
              provider: res.data.provider,
              badge: res.data.badge,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
          ]);
        }
      } else {
        setSendErrorId(tempUserMsgId);
        if (res.data?.reply) {
          setMessages(prev => [
            ...prev,
            {
              id: 'assistant-err-' + Date.now(),
              role: 'assistant',
              message: res.data.reply,
              provider: res.data.provider || 'Offline / Error',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
          ]);
        }
      }

    } catch (err) {
      console.error('[SEVA] Chat send error:', err);
      setSendErrorId(tempUserMsgId);
      const errMsg = err.response?.data?.reply || err.response?.data?.error || err.message || 'Unable to reach backend';
      setMessages(prev => [
        ...prev,
        {
          id: 'assistant-err-' + Date.now(),
          role: 'assistant',
          message: `⚠️ ${errMsg}`,
          provider: 'Error',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="seva-chat-screen flex flex-col h-[calc(100vh-5rem)] max-w-5xl mx-auto bg-navy border border-muted rounded-2xl shadow-xl overflow-hidden">
      {/* ── Foreground Chat Interface ── */}
      <div className="seva-chat-content px-4 sm:px-6 pt-4 pb-4 flex flex-col h-full">
        {/* ── STATE 1: LOADING ── */}
        {loading ? (
          <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] space-y-4">
            <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
            <p className="font-sans text-sm text-text-secondary">Connecting to SEVA AI assistant...</p>
          </div>
        ) : (
          <>
      {/* ── Chat Header ── */}
      <div className="seva-chat-header flex items-center justify-between border-b border-muted pb-4 px-2 pt-1 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <MessageSquare size={24} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-2xl text-text-primary flex items-center gap-2.5">
              SEVA Conversational Assistant
              <span className="text-xs uppercase font-bold tracking-wider text-accent bg-accent/10 px-2.5 py-0.5 rounded border border-accent/30">
                AI Assistant
              </span>
            </h1>
            <p className="text-text-secondary text-sm mt-0.5">Ask anything about your schedule, deadlines, or daily plan</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSendMessage('plan tomorrow')}
            disabled={isSending}
            className="px-3.5 py-1.5 bg-accent/15 hover:bg-accent/25 text-accent border border-accent/30 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            title="Start nightly check-in for tomorrow"
          >
            <Sparkles size={14} />
            <span>Plan tomorrow</span>
          </button>

          <button
            onClick={fetchChatHistory}
            className="p-2 text-text-secondary hover:text-accent hover:bg-gray-800 rounded-xl transition-all"
            title="Refresh history"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* ── STATE 2: ERROR BANNER ── */}
      {errorMsg && (
        <div className="mt-4 p-3 bg-red-950/40 border border-red-500/50 rounded-xl flex items-center justify-between gap-3 text-red-400 text-xs shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            onClick={fetchChatHistory}
            className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg text-[11px]"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Messages Scroll Area ── */}
      <div className="flex-1 overflow-y-auto py-6 space-y-4 pr-2 scrollbar-thin scrollbar-thumb-gray-800">
        
        {/* ── STATE 3: EMPTY STATE ── */}
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-4 py-12">
            <div className="p-4 bg-accent/10 border border-accent/30 rounded-2xl text-accent">
              <Bot size={40} />
            </div>
            <div className="space-y-1 max-w-sm">
              <h3 className="font-heading font-semibold text-lg text-text-primary">Chat with SEVA</h3>
              <p className="text-text-secondary text-xs leading-relaxed">
                SEVA has complete context of today's timetable, emails, and tasks. Ask questions like:
              </p>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md w-full pt-2">
              {[
                "plan tomorrow",
                "how am I doing on my goals?",
                "free till 9 PM",
                "what should I focus on today?"
              ].map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(suggestion)}
                  className="p-3 bg-panel hover:bg-muted/80 border border-muted hover:border-accent/40 rounded-xl text-sm font-medium text-text-primary text-left transition-all cursor-pointer"
                >
                  "{suggestion}"
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Message Bubbles */
          messages.map((msg, idx) => {
            const isUser = msg.role === 'user';
            const hasFailed = sendErrorId === msg.id;

            return (
              <div 
                key={msg.id || idx}
                className={`flex gap-3 max-w-3xl ${isUser ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}
              >
                {/* Avatar Icon */}
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                  isUser 
                    ? 'bg-accent/20 border-accent/40 text-accent' 
                    : 'bg-panel border-muted text-accent'
                }`}>
                  {isUser ? <User size={18} /> : <Bot size={18} />}
                </div>

                {/* Message Container */}
                <div className="space-y-1.5 min-w-0 max-w-[85%] sm:max-w-[75%]">
                  <div className={`p-4 rounded-2xl text-sm sm:text-base leading-relaxed whitespace-pre-wrap ${
                    isUser 
                      ? 'bg-accent text-dark-bg font-medium rounded-tr-none' 
                      : 'bg-panel border border-muted text-text-primary rounded-tl-none'
                  }`}>
                    {msg.message}
                  </div>

                  {/* Timestamp, Provider & Error indicator */}
                  <div className={`flex items-center gap-2 text-xs text-text-secondary px-1 ${
                    isUser ? 'justify-end' : 'justify-start'
                  }`}>
                    <Clock size={12} />
                    <span>{msg.timestamp || 'Today'}</span>

                    {!isUser && msg.provider && (
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        msg.provider.includes('Cloud') 
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' 
                          : msg.provider.includes('Ollama')
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                          : 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                      }`}>
                        {msg.provider}
                      </span>
                    )}
                    
                    {hasFailed && (
                      <span 
                        onClick={() => handleSendMessage(msg.message, msg.client_request_id || msg.id)}
                        className="text-red-400 font-semibold cursor-pointer hover:underline flex items-center gap-1"
                      >
                        <AlertCircle size={12} /> Failed — Tap to retry
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* ── Typing Indicator (when AI is thinking) ── */}
        {isSending && (
          <div className="flex gap-3 max-w-3xl mr-auto animate-in fade-in duration-200">
            <div className="w-9 h-9 rounded-xl bg-panel border border-muted text-accent flex items-center justify-center shrink-0">
              <Bot size={18} />
            </div>
            <div className="p-4 bg-panel border border-muted rounded-2xl rounded-tl-none flex items-center gap-3 text-sm text-text-secondary">
              <Sparkles size={16} className="text-accent animate-spin" />
              <span>SEVA is thinking...</span>
              <div className="flex items-center gap-1 ml-1">
                <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"></div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Fixed Bottom Input Bar ── */}
      <div className="pt-2 shrink-0">
        <div className="bg-panel border border-muted rounded-2xl p-2.5 sm:p-3 flex items-end gap-2.5 focus-within:border-accent/60 transition-all">
          <textarea
            ref={inputRef}
            rows={1}
            value={inputMsg}
            onChange={(e) => setInputMsg(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask SEVA about your schedule, deadlines, or tasks..."
            disabled={isSending}
            className="flex-1 bg-transparent text-sm sm:text-base text-text-primary placeholder:text-text-secondary px-3 py-2 focus:outline-none resize-none max-h-28 min-h-[42px]"
          />

          <button
            onClick={() => handleSendMessage()}
            disabled={isSending || !inputMsg.trim()}
            className="p-3 bg-accent hover:bg-accent/90 text-dark-bg rounded-xl transition-all cursor-pointer disabled:opacity-40 shrink-0"
            title="Send message"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-xs text-text-secondary text-center mt-2.5">
          SEVA AI reads your active day plan and emails to assist you.
        </p>
      </div>
          </>
        )}
      </div>

    </div>
  );
}
