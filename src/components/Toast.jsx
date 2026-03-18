import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */
const ToastContext = createContext(null);

/* ------------------------------------------------------------------ */
/*  Reducer                                                            */
/* ------------------------------------------------------------------ */
let nextId = 0;

function toastReducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return [...state, action.toast];
    case 'DISMISS':
      return state.map((t) =>
        t.id === action.id ? { ...t, dismissing: true } : t,
      );
    case 'REMOVE':
      return state.filter((t) => t.id !== action.id);
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/*  Icons (inline SVG, no external deps)                               */
/* ------------------------------------------------------------------ */
const icons = {
  success: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="10" fill="var(--color-oracle-green)" fillOpacity="0.18" />
      <path
        d="M6 10.5l2.5 2.5L14 7"
        stroke="var(--color-oracle-green)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  error: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="10" fill="var(--color-oracle-red)" fillOpacity="0.18" />
      <path
        d="M7 7l6 6M13 7l-6 6"
        stroke="var(--color-oracle-red)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  info: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="10" fill="var(--color-oracle-accent)" fillOpacity="0.18" />
      <circle cx="10" cy="7" r="1.2" fill="var(--color-oracle-accent)" />
      <rect x="9" y="9.5" width="2" height="5" rx="1" fill="var(--color-oracle-accent)" />
    </svg>
  ),
  warning: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1.5l9 17H1l9-17z"
        fill="var(--color-oracle-yellow)"
        fillOpacity="0.18"
        stroke="var(--color-oracle-yellow)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <rect x="9.2" y="8" width="1.6" height="5" rx="0.8" fill="var(--color-oracle-yellow)" />
      <circle cx="10" cy="15" r="0.9" fill="var(--color-oracle-yellow)" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Accent colour per type (left border highlight)                     */
/* ------------------------------------------------------------------ */
const accentVar = {
  success: 'var(--color-oracle-green)',
  error: 'var(--color-oracle-red)',
  info: 'var(--color-oracle-accent)',
  warning: 'var(--color-oracle-yellow)',
};

/* ------------------------------------------------------------------ */
/*  Keyframes (injected once)                                          */
/* ------------------------------------------------------------------ */
const STYLE_ID = '__toast_keyframes__';

function ensureKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes toast-slide-in {
      from { opacity: 0; transform: translateY(-16px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes toast-fade-out {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to   { opacity: 0; transform: translateY(-12px) scale(0.95); }
    }
  `;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/*  Single toast                                                       */
/* ------------------------------------------------------------------ */
function ToastItem({ toast, dispatch }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef(null);

  const startDismiss = useCallback(() => {
    setExiting(true);
    dispatch({ type: 'DISMISS', id: toast.id });
    setTimeout(() => dispatch({ type: 'REMOVE', id: toast.id }), 300);
  }, [dispatch, toast.id]);

  useEffect(() => {
    const duration = toast.duration ?? 3000;
    timerRef.current = setTimeout(startDismiss, duration);
    return () => clearTimeout(timerRef.current);
  }, [startDismiss, toast.duration]);

  const accent = accentVar[toast.variant] || accentVar.info;

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.625rem',
        width: '100%',
        maxWidth: 400,
        padding: '0.75rem 1rem',
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(148,163,184,0.12)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: '0.75rem',
        color: 'var(--color-oracle-text)',
        fontSize: '0.875rem',
        lineHeight: 1.45,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        pointerEvents: 'auto',
        animation: exiting
          ? 'toast-fade-out 0.3s ease forwards'
          : 'toast-slide-in 0.3s ease forwards',
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 2 }}>
        {icons[toast.variant] || icons.info}
      </span>

      <span style={{ flex: 1, wordBreak: 'break-word' }}>{toast.message}</span>

      <button
        onClick={startDismiss}
        aria-label="Dismiss"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-oracle-muted)',
          cursor: 'pointer',
          padding: 2,
          flexShrink: 0,
          lineHeight: 1,
          fontSize: '1rem',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 3l8 8M11 3l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Container (portal-free, renders at top-center)                     */
/* ------------------------------------------------------------------ */
function ToastContainer() {
  const { toasts } = useContext(ToastContext);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
        width: 'calc(100% - 2rem)',
        maxWidth: 400,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dispatch={toasts.__dispatch} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */
function ToastProvider({ children }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);

  useEffect(ensureKeyframes, []);

  // Attach dispatch so ToastContainer can forward it to items
  toasts.__dispatch = dispatch;

  const toast = useCallback(
    (message, variant = 'info', duration = 3000) => {
      const id = ++nextId;
      dispatch({ type: 'ADD', toast: { id, message, variant, duration } });
    },
    [],
  );

  const success = useCallback((msg, dur) => toast(msg, 'success', dur), [toast]);
  const error = useCallback((msg, dur) => toast(msg, 'error', dur), [toast]);
  const info = useCallback((msg, dur) => toast(msg, 'info', dur), [toast]);
  const warning = useCallback((msg, dur) => toast(msg, 'warning', dur), [toast]);

  const value = { toasts, dispatch, toast, success, error, info, warning };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */
function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() must be used inside <ToastProvider>');
  }
  const { toast, success, error, info, warning } = ctx;
  return { toast, success, error, info, warning };
}

export { ToastProvider, ToastContainer, useToast };
