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
  const handleSendMessage = async (textToSend = inputMsg) => {
    const text = textToSend.trim();
    if (!text || isSending) return;

    // Clear input & error state
    setInputMsg('');
    setSendErrorId(null);
    setIsSending(true);

    // Temp Optimistic User Message
    const tempUserMsgId = 'temp-' + Date.now();
    const tempUserMsg = {
      id: tempUserMsgId,
      role: 'user',
      message: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isPending: false
    };

    setMessages(prev => [...prev, tempUserMsg]);

    try {
      const res = await client.post('/chat/message', { message: text });
      
      if (res.data.success && res.data.reply) {
        // Re-fetch chat history from server to get persistent DB row IDs
        const historyRes = await client.get('/chat/history');
        if (historyRes.data.success) {
          setMessages(historyRes.data.messages || []);
        } else {
          // Fallback append AI response
          setMessages(prev => [
            ...prev,
            {
              id: 'assistant-' + Date.now(),
              role: 'assistant',
              message: res.data.reply,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
          ]);
        }
      } else {
        setSendErrorId(tempUserMsgId);
      }

    } catch (err) {
      console.error('[SEVA] Chat send error:', err);
      setSendErrorId(tempUserMsgId);
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

  // ── STATE 1: LOADING ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
        <p className="font-sans text-sm text-text-secondary">Connecting to SEVA AI assistant...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] max-w-5xl mx-auto pb-4">
      
      {/* ── Chat Header ── */}
      <div className="flex items-center justify-between border-b border-gray-800 pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent/10 border border-accent/30 rounded-xl text-accent">
            <MessageSquare size={24} style={{ filter: 'drop-shadow(0 0 6px rgba(0,217,255,0.5))' }} />
          </div>
          <div>
            <h1 className="font-heading font-bold text-2xl text-text-primary flex items-center gap-2">
              SEVA Conversational Assistant
              <span className="text-[10px] uppercase font-bold tracking-wider text-accent bg-accent/10 px-2 py-0.5 rounded border border-accent/30">
                Phi-3.5 Local AI
              </span>
            </h1>
            <p className="text-text-secondary text-xs">Ask anything about your schedule, deadlines, or daily plan</p>
          </div>
        </div>

        <button
          onClick={fetchChatHistory}
          className="p-2 text-text-secondary hover:text-accent hover:bg-gray-800 rounded-xl transition-all"
          title="Refresh history"
        >
          <RefreshCw size={16} />
        </button>
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
                "What is my schedule for today?",
                "Do I have any high priority tasks?",
                "What's my 5 PM meeting about?",
                "Summarize my email deadlines"
              ].map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(suggestion)}
                  className="p-3 bg-card-bg hover:bg-gray-800/80 border border-gray-800 hover:border-accent/40 rounded-xl text-xs text-text-primary text-left transition-all cursor-pointer"
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
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                  isUser 
                    ? 'bg-accent/20 border-accent/40 text-accent' 
                    : 'bg-card-bg border-gray-800 text-accent'
                }`}>
                  {isUser ? <User size={16} /> : <Bot size={16} />}
                </div>

                {/* Message Container */}
                <div className="space-y-1 min-w-0 max-w-[85%] sm:max-w-[75%]">
                  <div className={`p-4 rounded-2xl text-xs sm:text-sm leading-relaxed whitespace-pre-wrap shadow-lg ${
                    isUser 
                      ? 'bg-accent text-dark-bg font-medium rounded-tr-none' 
                      : 'bg-card-bg border border-gray-800 text-text-primary rounded-tl-none'
                  }`}>
                    {msg.message}
                  </div>

                  {/* Timestamp & Error indicator */}
                  <div className={`flex items-center gap-2 text-[10px] text-text-secondary px-1 ${
                    isUser ? 'justify-end' : 'justify-start'
                  }`}>
                    <Clock size={10} />
                    <span>{msg.timestamp || 'Today'}</span>
                    
                    {hasFailed && (
                      <span 
                        onClick={() => handleSendMessage(msg.message)}
                        className="text-red-400 font-semibold cursor-pointer hover:underline flex items-center gap-1"
                      >
                        <AlertCircle size={10} /> Failed — Tap to retry
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
            <div className="w-8 h-8 rounded-xl bg-card-bg border border-gray-800 text-accent flex items-center justify-center shrink-0">
              <Bot size={16} />
            </div>
            <div className="p-3.5 bg-card-bg border border-gray-800 rounded-2xl rounded-tl-none flex items-center gap-2.5 text-xs text-text-secondary">
              <Sparkles size={14} className="text-accent animate-spin" />
              <span>SEVA is thinking with Phi-3.5...</span>
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
        <div className="bg-card-bg border border-gray-800 rounded-2xl p-2 sm:p-2.5 flex items-end gap-2 focus-within:border-accent/60 transition-all shadow-xl">
          <textarea
            ref={inputRef}
            rows={1}
            value={inputMsg}
            onChange={(e) => setInputMsg(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask SEVA about your schedule, deadlines, or tasks... (Press Enter to send)"
            disabled={isSending}
            className="flex-1 bg-transparent text-xs sm:text-sm text-text-primary placeholder:text-text-secondary px-3 py-2 focus:outline-none resize-none max-h-24 min-h-[38px]"
          />

          <button
            onClick={() => handleSendMessage()}
            disabled={isSending || !inputMsg.trim()}
            className="p-2.5 bg-accent hover:bg-accent/90 text-dark-bg rounded-xl transition-all cursor-pointer disabled:opacity-40 shrink-0 shadow-md shadow-accent/20"
            title="Send message"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-[10px] text-text-secondary text-center mt-2">
          SEVA AI reads your active day plan and emails to assist you. Responses take ~30–60s depending on local Ollama hardware.
        </p>
      </div>

    </div>
  );
}
