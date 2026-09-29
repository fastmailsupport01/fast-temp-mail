/**
 * Fast Temp Mail — public landing page + authenticated workspace.
 *
 * The landing page follows the user's approved static design:
 * navbar → hero → live generator → features → dashboard preview →
 * pricing → footer, with login/signup shown as a modal.
 * The generator calls the real backend actions (no prototype JS).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import logo from "./assets/fast-temp-mail-logo.png";
import heroImg from "./assets/hero-3d.png";

type Api = typeof api;
type Plans = ApiResponse<Api, "getPlans">;
type PublicConfig = ApiResponse<Api, "getPublicConfig">;
type Dashboard = ApiResponse<Api, "getDashboard">;
type AdminData = ApiResponse<Api, "getAdminDashboard">;
type GeneratedEmail = ApiResponse<Api, "generateTempEmail">;
type InboxPayload = ApiResponse<Api, "getTempInbox">;
type InboxMessage = InboxPayload["messages"][number];
type PendingTx = AdminData["pendingTransactions"][number];
type PaidPlan = "gmail" | "pro";

type CurrentEmail = { id: number; address: string; expiresAt: string };

/* ================= Small helpers ================= */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** HH:MM:SS countdown (24-hour expiry needs hours, not just minutes). */
function formatCountdown(expiresAt: string, nowMs: number): string {
  const ms = Math.max(0, new Date(expiresAt).getTime() - nowMs);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function isExpired(expiresAt: string, nowMs: number): boolean {
  return new Date(expiresAt).getTime() <= nowMs;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function txLabel(type: string): string {
  if (type === "deposit") return "Deposit";
  if (type === "plan_upgrade") return "Plan upgrade";
  if (type === "credit") return "Credit";
  if (type === "debit") return "Debit";
  return type;
}

function planName(plan: string): string {
  if (plan === "gmail") return "Gmail";
  if (plan === "pro") return "Pro";
  return "Free";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ================= Storage ================= */

const themeKey = "fasttempmail-theme";
const sessionKey = "fasttempmail-session";
const anonKey = "fasttempmail-anon-v2";

type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(themeKey) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function readSavedSession(): string {
  try {
    return window.sessionStorage.getItem(sessionKey) ?? "";
  } catch {
    return "";
  }
}

function saveSession(token: string): void {
  try {
    window.sessionStorage.setItem(sessionKey, token);
  } catch {
    /* in-memory state remains the source of truth */
  }
}

function clearSession(): void {
  try {
    window.sessionStorage.removeItem(sessionKey);
  } catch {
    /* ignore */
  }
}

function readAnon(): CurrentEmail | null {
  const parse = (raw: string | null): CurrentEmail | null => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as CurrentEmail;
      if (!v || typeof v.id !== "number" || !v.address || !v.expiresAt) return null;
      if (isExpired(v.expiresAt, Date.now())) return null;
      return v;
    } catch {
      return null;
    }
  };
  try {
    // Current key first, then the pre-redesign key (same shape) as a fallback.
    const v = parse(window.localStorage.getItem(anonKey)) ?? parse(window.localStorage.getItem("fasttempmail-anon"));
    if (!v) {
      try {
        window.localStorage.removeItem(anonKey);
      } catch {
        /* ignore */
      }
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

function saveAnon(v: CurrentEmail): void {
  try {
    window.localStorage.setItem(anonKey, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function clearAnon(): void {
  try {
    window.localStorage.removeItem(anonKey);
  } catch {
    /* ignore */
  }
}

/* ================= Icons ================= */

const ICON_PATHS: Record<string, React.ReactNode> = {
  sun: (
    <g>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </g>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  copy: (
    <g>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </g>
  ),
  refresh: <path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />,
  trash: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  inbox: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" />,
  wallet: <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16V7M18 14h.01" />,
  phone: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2z" />
  ),
  user: (
    <g>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </g>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  clock: (
    <g>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </g>
  ),
  mail: (
    <g>
      <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path d="m22 6-10 7L2 6" />
    </g>
  ),
  lock: (
    <g>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </g>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  globe: (
    <g>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </g>
  ),
  card: (
    <g>
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
    </g>
  ),
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {ICON_PATHS[name] ?? null}
    </svg>
  );
}

/* ================= Theme toggle + toast ================= */

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = readTheme();
    document.documentElement.dataset.theme = t;
    return t;
  });
  useEffect(() => {
    const handler = () => {
      const t = readTheme();
      document.documentElement.dataset.theme = t;
      setTheme(t);
    };
    window.addEventListener("fasttempmail-theme", handler);
    return () => window.removeEventListener("fasttempmail-theme", handler);
  }, []);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(themeKey, next);
    } catch {
      /* storage may be unavailable */
    }
    document.documentElement.dataset.theme = next;
    setTheme(next);
    window.dispatchEvent(new Event("fasttempmail-theme"));
  };
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
    </button>
  );
}

type ToastMsg = { id: number; text: string };

function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const show = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return { toasts, show };
}

function Toasts({ toasts }: { toasts: ToastMsg[] }) {
  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status">
          {t.text}
        </div>
      ))}
    </>
  );
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/* ================= Live generator (real backend) ================= */

function LandingGenerator({
  token,
  demoMode,
  showToast,
}: {
  token: string;
  demoMode: boolean;
  showToast: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const [current, setCurrent] = useState<CurrentEmail | null>(null);
  const [busy, setBusy] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const autoRef = useRef(false);

  const authed = token.length >= 20;

  const generate = useCallback(
    async (opts?: { silent?: boolean }) => {
      setBusy(true);
      try {
        const r: GeneratedEmail = await api.generateTempEmail(authed ? { token } : {});
        if (r.ok && r.id && r.address && r.expiresAt) {
          const next = { id: r.id, address: r.address, expiresAt: r.expiresAt };
          setCurrent(next);
          setInboxOpen(false);
          setExpandedId(null);
          if (!authed) saveAnon(next);
          void queryClient.invalidateQueries({ queryKey: ["my-emails"] });
        } else {
          showToast(r.message || "Could not generate an address. Please try again.");
        }
      } catch {
        if (!opts?.silent) showToast("Could not reach the server. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [authed, token, queryClient, showToast],
  );

  // Restore a saved anonymous address, otherwise auto-generate once.
  useEffect(() => {
    if (autoRef.current) return;
    autoRef.current = true;
    const saved = readAnon();
    if (saved) {
      setCurrent(saved);
    } else {
      void generate({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inboxQuery = useQuery({
    queryKey: ["inbox", current?.id, authed ? "u" : "a"],
    queryFn: () => api.getTempInbox(authed && current ? { id: current.id, token } : { id: current!.id }),
    enabled: inboxOpen && !!current,
    refetchInterval: inboxOpen ? 5000 : false,
  });

  const myEmailsQuery = useQuery({
    queryKey: ["my-emails", authed],
    queryFn: () => api.getMyTempEmails({ token }),
    enabled: authed,
  });

  const messages: InboxMessage[] = inboxQuery.data?.messages ?? [];
  const expired = current ? isExpired(current.expiresAt, now) : false;

  const onCopy = async () => {
    if (!current) return;
    const ok = await copyToClipboard(current.address);
    showToast(ok ? "Email copied!" : "Copy failed — please select the address manually.");
  };

  const onRefresh = () => {
    if (!current) {
      void generate();
      return;
    }
    setInboxOpen(true);
    void inboxQuery.refetch();
  };

  const onOpenInbox = () => {
    if (!current) return;
    setInboxOpen((v) => {
      if (!v) {
        // Opening the inbox marks messages read server-side — refresh badges.
        window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["my-emails"] }), 1500);
      }
      return !v;
    });
  };

  const onDelete = async () => {
    if (!current || busy) return;
    if (!window.confirm("Delete this temporary email address?")) return;
    setBusy(true);
    try {
      const r = await api.deleteTempEmail(authed ? { id: current.id, token } : { id: current.id });
      showToast(r.message);
      if (r.ok) {
        setCurrent(null);
        setInboxOpen(false);
        setExpandedId(null);
        if (!authed) clearAnon();
        void queryClient.invalidateQueries({ queryKey: ["my-emails"] });
      }
    } catch {
      showToast("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const onSimulate = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await api.simulateIncomingMail(authed ? { id: current.id, token } : { id: current.id });
      showToast(r.message);
      if (r.ok) {
        setInboxOpen(true);
        void inboxQuery.refetch();
      }
    } catch {
      showToast("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const selectAddress = (e: { id: number; address: string; expiresAt: string }) => {
    setCurrent(e);
    setInboxOpen(false);
    setExpandedId(null);
  };

  const myEmails = (myEmailsQuery.data?.emails ?? []).filter((e) => !e.expired);

  return (
    <div className="generator" id="generator-card">
      {!current ? (
        <div className="generator-empty">
          <h3>Create your temporary email</h3>
          <p>No signup needed. Your address is generated on our server and the inbox stays private to this browser.</p>
          <button className="btn btn-primary" onClick={() => generate()} disabled={busy}>
            {busy ? "Generating…" : "✨ Generate new email"}
          </button>
        </div>
      ) : (
        <>
          <div className="email-row">
            <div className="email-box">
              <span className="email" title={current.address}>
                {current.address}
              </span>
              <span className="status">{expired ? "Expired" : "● Active"}</span>
            </div>
            <button className="btn btn-primary" onClick={onCopy} disabled={expired}>
              <Icon name="copy" size={15} /> Copy
            </button>
          </div>

          <div className="controls">
            <button className="control" onClick={() => generate()} disabled={busy}>
              ✨ Generate new email
            </button>
            <button className="control" onClick={onCopy} disabled={expired || busy}>
              📋 Copy
            </button>
            <button className="control" onClick={onRefresh} disabled={busy}>
              🔄 Refresh
            </button>
            <button className="control" onClick={() => generate()} disabled={busy}>
              🔁 Change email
            </button>
            <button className="control" onClick={onOpenInbox}>
              📥 {inboxOpen ? "Close inbox" : "Open inbox"}
            </button>
            <button className="control" onClick={onDelete} disabled={busy}>
              🗑 Delete
            </button>
          </div>

          <div className="timer-row">
            <div className="timer">
              <small>Expires in</small>
              <strong>{formatCountdown(current.expiresAt, now)}</strong>
            </div>
            <div className="messages">💬 {messages.length} messages</div>
          </div>

          {expired && (
            <p className="demo-note">
              This address has expired. Generate a new one to keep receiving messages.
            </p>
          )}

          {inboxOpen && (
            <div className="gen-inbox">
              <div className="gen-inbox-head">
                <h4>Inbox — {current.address}</h4>
                <span>{messages.length} message{messages.length === 1 ? "" : "s"}</span>
              </div>
              {inboxQuery.isLoading ? (
                <p className="gen-empty-inbox">Loading messages…</p>
              ) : inboxQuery.data && !inboxQuery.data.ok ? (
                <p className="gen-empty-inbox">{inboxQuery.data.message}</p>
              ) : messages.length === 0 ? (
                <p className="gen-empty-inbox">
                  No messages yet. {demoMode ? "Use the demo simulator below to see how an incoming email looks." : "New messages will appear here automatically."}
                </p>
              ) : (
                messages.map((m) => (
                  <div key={m.id}>
                    <button
                      className={`gen-mail${m.isRead ? "" : " unread"}`}
                      onClick={() => setExpandedId((v) => (v === m.id ? null : m.id))}
                    >
                      <small>{formatTime(m.receivedAt)}</small>
                      <strong>{m.subject || "(no subject)"}</strong>
                      <span>
                        {m.sender} — {(m.body || "").slice(0, 90)}
                      </span>
                    </button>
                    {expandedId === m.id && (
                      <div className="gen-mail-body">
                        <strong>From:</strong> {m.sender}
                        <br />
                        <strong>Subject:</strong> {m.subject || "(no subject)"}
                        <br />
                        <br />
                        {m.body || "(empty message)"}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {demoMode && (
            <div className="demo-simulate">
              <button className="control" onClick={onSimulate} disabled={busy || expired}>
                🧪 Simulate incoming email (demo)
              </button>
              <p className="demo-note">
                <strong>Simulated inbox:</strong> this demo delivers sample messages instantly. Real inbound
                email arrives after a mail provider is connected — nothing here is a real email account.
              </p>
            </div>
          )}

          {authed && myEmails.length > 0 && (
            <div className="gen-my-list">
              <h4>My addresses</h4>
              <ul>
                {myEmails.map((e) => (
                  <li key={e.id}>
                    <button
                      className={current.id === e.id ? "active" : ""}
                      onClick={() => selectAddress(e)}
                    >
                      <span className="addr">{e.address}</span>
                      {e.unread > 0 && <span className="unread">{e.unread}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ================= Pricing (live backend) ================= */

function PlanGrid({
  plans,
  isAuthed,
  userPlan,
  onPickPaid,
}: {
  plans: Plans | undefined;
  isAuthed: boolean;
  userPlan: string;
  onPickPaid: (plan: PaidPlan) => void;
}) {
  if (!plans) {
    return (
      <div className="pricing">
        {[0, 1, 2].map((i) => (
          <div className="price-card" key={i}>
            <p style={{ color: "var(--muted)" }}>Loading plans…</p>
          </div>
        ))}
      </div>
    );
  }

  const cards: {
    id: "free" | PaidPlan;
    title: string;
    price: number;
    popular?: boolean;
    features: string[];
    note?: string;
  }[] = [
    { id: "free", title: plans.free.name, price: plans.free.price, features: plans.free.features },
    {
      id: "gmail",
      title: plans.gmail.name,
      price: plans.gmail.price,
      popular: plans.gmail.popular,
      features: plans.gmail.features,
      note: plans.gmail.activationNote,
    },
    {
      id: "pro",
      title: plans.pro.name,
      price: plans.pro.price,
      features: plans.pro.features,
      note: plans.pro.activationNote,
    },
  ];

  return (
    <div className="pricing">
      {cards.map((c) => {
        const active = isAuthed && userPlan === c.id;
        return (
          <div className={`price-card${c.popular ? " popular" : ""}`} key={c.id}>
            {c.popular && <span className="popular-tag">⭐ Most Popular</span>}
            <h3>{c.title}</h3>
            <div className="price">
              {formatMoney(c.price)}
              <small>/month</small>
            </div>
            <ul>
              {c.features.map((f) => (
                <li key={f}>✓ {f}</li>
              ))}
            </ul>
            {active ? (
              <button className="btn" disabled>
                Current plan
              </button>
            ) : c.id === "free" ? (
              <button className="btn" onClick={() => scrollToId("generator")}>
                Get Started
              </button>
            ) : (
              <button
                className={`btn${c.popular ? " btn-primary" : ""}`}
                onClick={() => onPickPaid(c.id as PaidPlan)}
                title={c.note}
              >
                Upgrade to {c.title}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Footer({ demoMode }: { demoMode: boolean }) {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <img src={logo} alt="Fast Temp Mail" className="logo" />
            <p>Secure temporary email addresses for protecting your privacy online.</p>
          </div>
          <div>
            <h4>Product</h4>
            <a href="#generator">Generator</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div>
            <h4>Company</h4>
            <a href="#preview">About</a>
            <a href="#pricing">Contact</a>
            <a href="/privacy">Privacy</a>
          </div>
          <div>
            <h4>Legal</h4>
            <a href="#pricing">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="#pricing">Security</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2026 Fast Temp Mail. All rights reserved.</p>
          {demoMode && (
            <p className="sim-label">Demo mode: the inbox is simulated and payments stay manual until providers are connected.</p>
          )}
        </div>
      </div>
    </footer>
  );
}

function Navbar({
  isAuthed,
  onLogin,
  onSignup,
  onDashboard,
  onLogout,
}: {
  isAuthed: boolean;
  onLogin: () => void;
  onSignup: () => void;
  onDashboard: () => void;
  onLogout: () => void;
}) {
  return (
    <>
      <nav className="navbar">
        <div className="container nav-inner">
          <button className="brand" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Fast Temp Mail home">
            <img src={logo} alt="Fast Temp Mail" className="logo" />
          </button>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#preview">Dashboard</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="nav-buttons">
            <ThemeToggle />
            {isAuthed ? (
              <>
                <button className="btn" onClick={onDashboard}>
                  Dashboard
                </button>
                <button className="btn" onClick={onLogout}>
                  Logout
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={onLogin}>
                  Login
                </button>
                <button className="btn btn-primary" onClick={onSignup}>
                  Sign Up
                </button>
              </>
            )}
          </div>
        </div>
      </nav>
      <div className="mobile-nav" aria-label="Section links">
        <a href="#generator">Generator</a>
        <a href="#features">Features</a>
        <a href="#preview">Dashboard</a>
        <a href="#pricing">Pricing</a>
      </div>
    </>
  );
}

/* ================= Public home page ================= */

function HomePage({
  token,
  demoMode,
  plans,
  userPlan,
  showToast,
  onOpenAuth,
  onPickPaid,
}: {
  token: string;
  demoMode: boolean;
  plans: Plans | undefined;
  userPlan: string;
  showToast: (text: string) => void;
  onOpenAuth: (mode: "login" | "signup") => void;
  onPickPaid: (plan: PaidPlan) => void;
}) {
  return (
    <main>
      <section className="hero container">
        <div>
          <span className="badge">⚡ New • Instant inbox access</span>
          <h1>
            Fast <span className="gradient">Temp Mail.</span>
          </h1>
          <p>
            Generate a temporary email instantly, keep your real inbox private, and receive messages
            without signing up. Built for speed, designed for privacy.
          </p>
          <div className="hero-buttons">
            <button className="btn btn-primary" onClick={() => scrollToId("generator")}>
              Generate Email
            </button>
            <button className="btn" onClick={() => scrollToId("features")}>
              View Features
            </button>
          </div>
        </div>
        <div className="hero-image">
          <img src={heroImg} alt="Fast Temp Mail — glowing 3D envelope" />
        </div>
      </section>

      <section className="section container" id="generator">
        <div className="section-title">
          <span>⚡ Live Generator</span>
          <h2>Create Your Email</h2>
          <p>No signup required. Create a temporary email and receive messages instantly.</p>
        </div>
        <LandingGenerator token={token} demoMode={demoMode} showToast={showToast} />
      </section>

      <section className="section container" id="features">
        <div className="section-title">
          <span>✨ Why Fast Temp Mail</span>
          <h2>Everything You Need</h2>
          <p>Fast, secure, and built for your privacy.</p>
        </div>
        <div className="features">
          <div className="feature">
            <div className="feature-icon">⚡</div>
            <h3>Instant Inbox</h3>
            <p>Generate an email in seconds. No signup, no waiting — start receiving messages immediately.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🔒</div>
            <h3>Privacy First</h3>
            <p>Your real email stays hidden. Temporary addresses expire automatically after 24 hours.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🚀</div>
            <h3>Developer Ready</h3>
            <p>Clean dashboard, instant copy, and a workflow built for testing and quick signups.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">📱</div>
            <h3>SMS Receiving</h3>
            <p>Rent a virtual number and receive real SMS verification codes — $2 for 30 days.</p>
          </div>
        </div>
      </section>

      <section className="section container" id="preview">
        <div className="section-title">
          <span>👀 Dashboard Preview</span>
          <h2>Experience the Fast Temp Mail Dashboard</h2>
          <p>Take a look at the clean, intuitive dashboard you'll get.</p>
        </div>
        <div className="dash-preview">
          <aside className="preview-side">
            <img src={logo} alt="Fast Temp Mail" className="logo" />
            <span className="preview-link active">📥 Inbox</span>
            <button type="button" className="preview-link" onClick={() => onOpenAuth("signup")}>💳 Wallet</button>
            <span className="preview-link">👤 Profile</span>
            <span className="preview-link">⚙️ Settings</span>
          </aside>
          <div className="preview-main">
            <div className="preview-header">
              <strong>Inbox</strong>
              <button className="btn btn-primary" onClick={() => onOpenAuth("signup")}>
                Dashboard
              </button>
            </div>
            <div className="preview-mail">
              <small>2 min ago</small>
              <strong>Welcome to Fast Temp Mail</strong>
              <span>Your temporary email is ready to use…</span>
            </div>
            <div className="preview-mail">
              <small>1 hr ago</small>
              <strong>Verify your account</strong>
              <span>Click the link below to verify…</span>
            </div>
            <div className="preview-mail">
              <small>3 hr ago</small>
              <strong>Newsletter signup</strong>
              <span>Thanks for subscribing to our…</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section container" id="pricing">
        <div className="section-title">
          <span>💎 Simple Pricing</span>
          <h2>Choose Your Plan</h2>
          <p>Start free. Upgrade when you need more.</p>
        </div>
        <PlanGrid plans={plans} isAuthed={token.length >= 20} userPlan={userPlan} onPickPaid={onPickPaid} />
      </section>
    </main>
  );
}

/* ================= Auth modal ================= */

type AuthStep = "login" | "signup" | "verify" | "forgot" | "reset";

function AuthModal({
  initial,
  googleEnabled,
  onClose,
  onAuthed,
  showToast,
}: {
  initial: "login" | "signup";
  googleEnabled: boolean;
  onClose: () => void;
  onAuthed: (token: string) => void;
  showToast: (text: string) => void;
}) {
  const [step, setStep] = useState<AuthStep>(initial);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    setStep(initial);
    setError(null);
    setInfo(null);
    setDemoCode(null);
  }, [initial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fail = (message: string) => {
    setError(message);
    setBusy(false);
  };

  const doLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.login({ email: email.trim(), password });
      if (r.ok && r.token) {
        onAuthed(r.token);
      } else {
        fail(r.message);
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const doSignup = async () => {
    setBusy(true);
    setError(null);
    setDemoCode(null);
    try {
      const r = await api.signUp({ name: name.trim(), email: email.trim(), password });
      if (r.ok && r.email) {
        setEmail(r.email);
        setDemoCode(r.demoCode);
        setStep("verify");
        setBusy(false);
      } else {
        fail(r.message);
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const doVerify = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifyEmail({ email: email.trim(), otp: otp.trim() });
      if (r.ok && r.token) {
        onAuthed(r.token);
      } else {
        fail(r.message);
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const doForgot = async () => {
    setBusy(true);
    setError(null);
    setDemoCode(null);
    try {
      const r = await api.requestPasswordReset({ email: email.trim() });
      if (r.ok) {
        setDemoCode(r.demoCode);
        setInfo(r.message);
        setStep("reset");
        setBusy(false);
      } else {
        fail(r.message);
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const doReset = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.resetPassword({ email: email.trim(), token: resetCode.trim(), newPassword });
      if (r.ok && r.token) {
        showToast("Password updated. You are signed in.");
        onAuthed(r.token);
      } else {
        fail(r.message);
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const doGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.beginGoogleOAuth({});
      if (r.ok && r.authorizationUrl) {
        window.location.href = r.authorizationUrl;
      } else {
        fail(r.message || "Google sign-in is not available right now.");
      }
    } catch {
      fail("Could not reach the server. Please try again.");
    }
  };

  const titles: Record<AuthStep, { h: string; p: string }> = {
    login: { h: "Welcome back", p: "Sign in to your Fast Temp Mail account." },
    signup: { h: "Create account", p: "Get your dashboard, wallet and saved addresses." },
    verify: { h: "Verify your email", p: "Enter the 6-digit code we sent you." },
    forgot: { h: "Reset password", p: "Enter your account email to get a reset code." },
    reset: { h: "Set new password", p: "Enter the reset code and choose a new password." },
  };

  const submitLabel =
    step === "login"
      ? "Sign In"
      : step === "signup"
        ? "Create Account"
        : step === "verify"
          ? "Verify & Continue"
          : step === "forgot"
            ? "Send Reset Code"
            : "Update Password";

  const canSubmit =
    !busy &&
    (step === "login"
      ? email.trim() !== "" && password !== ""
      : step === "signup"
        ? name.trim().length >= 2 && email.trim() !== "" && password.length >= 10
        : step === "verify"
          ? otp.trim().length === 6
          : step === "forgot"
            ? email.trim() !== ""
            : resetCode.trim().length >= 10 && newPassword.length >= 10);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (step === "login") void doLogin();
    else if (step === "signup") void doSignup();
    else if (step === "verify") void doVerify();
    else if (step === "forgot") void doForgot();
    else void doReset();
  };

  const googleButton = (
    <>
      <button className="google-button" onClick={() => void doGoogle()} disabled={!googleEnabled || busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.5h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.8-5 3.8-8.9z" />
          <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.7 2.9v.1C3.5 21.4 7.5 24 12 24z" />
          <path fill="#FBBC05" d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.7-2.9-.1.1C.5 8.3 0 10.1 0 12s.5 3.7 1.3 5.3l3.9-2.9z" />
          <path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.5 0 3.5 2.6 1.3 6.7l3.9 3c1-2.9 3.7-5 6.8-5z" />
        </svg>
        Continue with Google
      </button>
      {!googleEnabled && (
        <p className="provider-help">
          Google sign-in is not connected yet — the admin adds the OAuth client ID, secret and
          redirect URI in the dashboard before this button works.
        </p>
      )}
    </>
  );

  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label={titles[step].h}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
        <div className="modal-header">
          <img src={logo} alt="Fast Temp Mail" className="logo" />
          <h2>{titles[step].h}</h2>
          <p>{titles[step].p}</p>
        </div>

        {error && (
          <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {info && (
          <div className="notice info" style={{ marginBottom: 12 }}>
            {info}
          </div>
        )}

        {step === "signup" && (
          <>
            {googleButton}
            <div className="divider">or create with email &amp; password</div>
          </>
        )}

        <form onSubmit={onSubmit}>
          {step === "signup" && (
            <input
              className="input"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          )}
          {(step === "login" || step === "signup" || step === "forgot") && (
            <input
              className="input"
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          )}
          {(step === "login" || step === "signup") && (
            <input
              className="input"
              type="password"
              placeholder={step === "signup" ? "Password (min 10 characters)" : "Password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={step === "signup" ? "new-password" : "current-password"}
            />
          )}
          {step === "verify" && (
            <input
              className="input"
              inputMode="numeric"
              placeholder="6-digit code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              style={{ textAlign: "center", letterSpacing: ".3em", fontSize: 20 }}
            />
          )}
          {step === "reset" && (
            <>
              <input
                className="input"
                placeholder="Reset code"
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                autoComplete="off"
              />
              <input
                className="input"
                type="password"
                placeholder="New password (min 10 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </>
          )}

          <div className="modal-buttons">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {busy ? "Please wait…" : submitLabel}
            </button>
          </div>
        </form>

        {demoCode && (
          <div className="demo-code" role="status">
            <span className="badge" style={{ marginBottom: 6 }}>Demo mode</span>
            <br />
            Your code: <strong>{demoCode}</strong>
            <p className="help" style={{ marginTop: 6 }}>
              Email delivery is not configured, so the code is shown here instead of your inbox.
            </p>
          </div>
        )}

        {step === "login" && (
          <>
            <div className="divider">or</div>
            {googleButton}
          </>
        )}

        <div className="auth-links">
          {step === "login" && (
            <button className="link-button" onClick={() => { setStep("forgot"); setError(null); setInfo(null); }}>
              Forgot your password?
            </button>
          )}
          {(step === "forgot" || step === "reset" || step === "verify") && (
            <button className="link-button" onClick={() => { setStep("login"); setError(null); setInfo(null); setDemoCode(null); }}>
              ← Back to sign in
            </button>
          )}
        </div>

        {(step === "login" || step === "signup") && (
          <p className="mode-switch">
            {step === "login" ? (
              <>
                New to Fast Temp Mail?{" "}
                <button className="link-button" onClick={() => { setStep("signup"); setError(null); }}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button className="link-button" onClick={() => { setStep("login"); setError(null); }}>
                  Sign in
                </button>
              </>
            )}
          </p>
        )}

        <p className="fine-print">Temporary addresses are for lawful use only and expire automatically.</p>
      </div>
    </div>
  );
}

/* ================= Authenticated workspace ================= */

type WorkspaceView = "inbox" | "numbers" | "wallet" | "profile" | "admin";

function InboxView({ token, showToast, demoMode }: { token: string; showToast: (t: string) => void; demoMode: boolean }) {
  return (
    <div className="section-block">
      <h2>Inbox</h2>
      <p>Generate temporary addresses and read incoming messages. Addresses expire automatically after 24 hours.</p>
      <LandingGenerator token={token} demoMode={demoMode} showToast={showToast} />
    </div>
  );
}

function NumbersView({ token, showToast }: { token: string; showToast: (t: string) => void }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const configQuery = useQuery({
    queryKey: ["sms-config"],
    queryFn: () => api.getSmsConfig({}),
    retry: false,
  });
  const numbersQuery = useQuery({
    queryKey: ["virtual-numbers", token],
    queryFn: () => api.listVirtualNumbers({ token }),
    retry: false,
  });

  const config = configQuery.data;
  const numbers = numbersQuery.data?.numbers ?? [];
  const activeId = selectedId ?? numbers[0]?.id ?? null;
  const active = numbers.find((n) => n.id === activeId) ?? null;

  const inboxQuery = useQuery({
    queryKey: ["sms-inbox", token, activeId],
    queryFn: () => api.getSmsInbox({ token, numberId: activeId! }),
    enabled: activeId != null,
    refetchInterval: 15000,
    retry: false,
  });

  const rent = useMutation({
    mutationFn: () => api.rentVirtualNumber({ token }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        void queryClient.invalidateQueries({ queryKey: ["virtual-numbers"] });
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        if (r.number) setSelectedId(r.number.id);
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const release = useMutation({
    mutationFn: (id: number) => api.releaseVirtualNumber({ token, numberId: id }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        setSelectedId(null);
        void queryClient.invalidateQueries({ queryKey: ["virtual-numbers"] });
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const copyNumber = async (n: string) => {
    const ok = await copyToClipboard(n);
    showToast(ok ? "Number copied." : "Copy failed — please copy it manually.");
  };

  return (
    <div className="section-block">
      <h2>Virtual numbers</h2>
      <p>
        Rent a real phone number and receive SMS verification codes on it —{" "}
        {config ? `$${config.numberPriceUSD.toFixed(2)} for ${config.rentalDays} days, billed from your wallet.` : "billed from your wallet."}
      </p>

      {config && !config.twilioReady && (
        <div className="notice" style={{ marginTop: 12 }}>
          SMS receiving is not connected yet — the administrator needs to connect a Twilio account first.
          This feature is fully built; nothing here is simulated.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button
          className="button"
          disabled={rent.isPending || (config ? !config.twilioReady : true)}
          onClick={() => rent.mutate()}
        >
          <Icon name="plus" size={16} />
          <span>{rent.isPending ? "Renting…" : "Rent a number"}</span>
        </button>
      </div>

      {numbersQuery.isLoading ? (
        <div className="empty" style={{ marginTop: 14 }}>Loading your numbers…</div>
      ) : numbers.length === 0 ? (
        <div className="empty" style={{ marginTop: 14 }}>
          You have no virtual numbers yet. Rent one to start receiving SMS.
        </div>
      ) : (
        <div className="row-list" style={{ marginTop: 16 }}>
          {numbers.map((n) => (
            <div className="row-item" key={n.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button className="link-button" onClick={() => setSelectedId(n.id)} style={{ fontWeight: 700, fontSize: 16 }}>
                  {n.phoneNumber}
                </button>
                {n.unread > 0 && <span className="badge">{n.unread} new</span>}
                {n.status !== "active" && <span className="muted">released</span>}
                <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button className="link-button" title="Copy number" onClick={() => void copyNumber(n.phoneNumber)}>
                    <Icon name="copy" size={15} />
                    <span>Copy</span>
                  </button>
                  {n.status === "active" && (
                    <button
                      className="link-button"
                      title="Release number"
                      disabled={release.isPending}
                      onClick={() => {
                        if (window.confirm(`Release ${n.phoneNumber}? It will stop receiving SMS immediately.`)) {
                          release.mutate(n.id);
                        }
                      }}
                    >
                      <Icon name="trash" size={15} />
                      <span>Release</span>
                    </button>
                  )}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {n.status === "active" ? `Active until ${new Date(n.expiresAt).toLocaleDateString()}` : "Released"}
              </div>

              {active?.id === n.id && (
                <div style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong>SMS inbox</strong>
                    <button className="link-button" onClick={() => void inboxQuery.refetch()} title="Refresh">
                      <Icon name="refresh" size={14} />
                    </button>
                  </div>
                  {inboxQuery.isLoading ? (
                    <div className="empty">Loading messages…</div>
                  ) : (inboxQuery.data?.messages.length ?? 0) === 0 ? (
                    <div className="empty">No messages yet. Share this number anywhere — incoming SMS will appear here automatically.</div>
                  ) : (
                    <div className="row-list" style={{ marginTop: 8 }}>
                      {inboxQuery.data!.messages.map((m) => (
                        <div key={m.id} className="row-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <strong style={{ fontSize: 13 }}>{m.sender}</strong>
                            <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                              {new Date(m.receivedAt).toLocaleString()}
                            </span>
                          </div>
                          <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WalletView({
  token,
  dashboard,
  plans,
  minimumDeposit,
  showToast,
}: {
  token: string;
  dashboard: Dashboard;
  plans: Plans | undefined;
  minimumDeposit: number;
  showToast: (t: string) => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(minimumDeposit));
  const amountNum = Number(amount);

  const deposit = useMutation({
    mutationFn: (a: number) => api.requestDeposit({ token, amount: a, method: "crypto" }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const upgrade = useMutation({
    mutationFn: (plan: PaidPlan) => api.requestPlanUpgrade({ token, plan }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const txs = dashboard.transactions;
  const pendingUpgrades = txs.filter((t) => t.type === "plan_upgrade" && t.status === "pending");
  const currentPlan = dashboard.user.plan;

  const upgradePrice = (plan: PaidPlan) =>
    plans ? (plan === "gmail" ? plans.gmail.price : plans.pro.price) : plan === "gmail" ? 2.5 : 3;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="balance-card">
        <small>Available balance</small>
        <div className="amount">
          {formatMoney(dashboard.wallet.balance)} <span style={{ fontSize: 16 }}>{dashboard.wallet.currency}</span>
        </div>
        <span className={`plan-badge ${currentPlan}`}>{planName(currentPlan)} plan</span>
        {dashboard.user.planExpiresAt && currentPlan !== "free" && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#bcd7ee" }}>
            Active until {formatDate(dashboard.user.planExpiresAt)}
          </div>
        )}
      </div>

      <div className="section-block">
        <h2>Upgrade plan</h2>
        <p>
          Upgrades are activated manually by an admin after payment — no automatic billing is connected
          yet. A pending request appears below until it is activated.
        </p>
        {pendingUpgrades.length > 0 ? (
          <div className="notice info">
            You have a pending upgrade request ({pendingUpgrades.map((t) => t.id).join(", ")}). An admin
            will activate it after payment.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(["gmail", "pro"] as PaidPlan[]).map((p) =>
              currentPlan === p ? (
                <button className="button secondary" key={p} disabled>
                  {planName(p)} — current plan
                </button>
              ) : (
                <button className="button" key={p} onClick={() => upgrade.mutate(p)} disabled={upgrade.isPending}>
                  <Icon name="bolt" size={15} /> Upgrade to {planName(p)} — {formatMoney(upgradePrice(p))}/mo
                </button>
              ),
            )}
          </div>
        )}
      </div>

      <div className="wallet-layout">
        <div className="deposit-panel">
          <h3>Crypto deposit</h3>
          <p>
            Send crypto to the address the admin provides, then create a pending deposit request here.
            Minimum is {formatMoney(minimumDeposit)}. Your wallet is credited only after an admin verifies
            the payment.
          </p>
          <div className="amount-field">
            <input
              className="input"
              type="number"
              min={minimumDeposit}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Deposit amount in USD"
            />
            <button
              className="button"
              onClick={() => deposit.mutate(amountNum)}
              disabled={!(amountNum >= minimumDeposit) || deposit.isPending}
            >
              {deposit.isPending ? "Creating…" : "Create pending deposit"}
            </button>
          </div>
        </div>
        <div className="deposit-panel">
          <h3>How deposits work</h3>
          <p>
            1. Enter an amount of at least {formatMoney(minimumDeposit)} and create a pending deposit.
            <br />
            2. Complete the crypto transfer.
            <br />
            3. An admin verifies the payment manually and credits your wallet.
          </p>
        </div>
      </div>

      <div className="section-block">
        <h2>Transactions</h2>
        <p>Deposits, credits, debits and plan upgrades.</p>
        {txs.length === 0 ? (
          <div className="empty">No transactions yet. Your deposits and wallet activity will appear here.</div>
        ) : (
          <div className="row-list">
            {txs.map((t) => (
              <div className="row-item" key={t.id}>
                <div className="grow">
                  <strong>
                    {txLabel(t.type)} · <span className={t.type === "debit" ? "amount-neg" : "amount-pos"}>{formatMoney(t.amount)}</span>
                  </strong>
                  <small>
                    {t.id} · {t.provider} · {formatTime(t.createdAt)}
                  </small>
                </div>
                <span className={`tx-status ${t.status}`}>{t.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileView({
  token,
  dashboard,
  showToast,
}: {
  token: string;
  dashboard: Dashboard;
  showToast: (t: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dashboard.user.name);
  const save = useMutation({
    mutationFn: (n: string) => api.updateProfile({ token, name: n }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });
  const u = dashboard.user;

  return (
    <div className="section-block">
      <h2>Profile</h2>
      <p>Your account details.</p>
      <div className="profile-panel">
        <div className="field">
          <label htmlFor="profile-name">Display name</label>
          <input id="profile-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Email</label>
          <input className="input" value={u.email} disabled />
        </div>
        <div className="field">
          <label>Role</label>
          <input className="input" value={u.role} disabled />
        </div>
        <div className="field">
          <label>Plan</label>
          <input className="input" value={planName(u.plan)} disabled />
        </div>
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="button" onClick={() => save.mutate(name.trim())} disabled={save.isPending || name.trim().length < 2 || name.trim() === u.name}>
          {save.isPending ? "Saving…" : "Save name"}
        </button>
        <span className={`plan-badge ${u.plan}`}>{planName(u.plan)} plan</span>
        {u.planExpiresAt && u.plan !== "free" && <small style={{ color: "var(--muted)" }}>Active until {formatDate(u.planExpiresAt)}</small>}
      </div>
    </div>
  );
}

/* ================= Admin ================= */

function PlanConfigForm({
  initial,
  onSave,
  saving,
}: {
  initial: { gmailPriceCents: number; proPriceCents: number; freeTtlMinutes: number } | null;
  onSave: (v: { gmailPriceCents: number; proPriceCents: number; freeTtlMinutes: number }) => void;
  saving: boolean;
}) {
  const [gmail, setGmail] = useState(initial ? String(initial.gmailPriceCents / 100) : "2.50");
  const [pro, setPro] = useState(initial ? String(initial.proPriceCents / 100) : "3.00");
  const [ttl, setTtl] = useState(initial ? String(initial.freeTtlMinutes) : "1440");
  useEffect(() => {
    if (initial) {
      setGmail(String(initial.gmailPriceCents / 100));
      setPro(String(initial.proPriceCents / 100));
      setTtl(String(initial.freeTtlMinutes));
    }
  }, [initial]);
  const gmailCents = Math.round(Number(gmail) * 100);
  const proCents = Math.round(Number(pro) * 100);
  const ttlMin = Number(ttl);
  const valid = gmailCents >= 100 && gmailCents <= 10000 && proCents >= 100 && proCents <= 10000 && ttlMin >= 5 && ttlMin <= 1440;
  return (
    <div className="oauth-settings">
      <div className="field-row">
        <div className="field">
          <label htmlFor="cfg-gmail">Gmail price (USD/month)</label>
          <input id="cfg-gmail" className="input" type="number" min="1" max="100" step="0.01" value={gmail} onChange={(e) => setGmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cfg-pro">Pro price (USD/month)</label>
          <input id="cfg-pro" className="input" type="number" min="1" max="100" step="0.01" value={pro} onChange={(e) => setPro(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cfg-ttl">Free temp-email TTL (minutes, 5–1440)</label>
        <input id="cfg-ttl" className="input" type="number" min="5" max="1440" step="1" value={ttl} onChange={(e) => setTtl(e.target.value)} />
      </div>
      <button className="button" onClick={() => onSave({ gmailPriceCents: gmailCents, proPriceCents: proCents, freeTtlMinutes: ttlMin })} disabled={!valid || saving}>
        {saving ? "Saving…" : "Save plan settings"}
      </button>
    </div>
  );
}

function OAuthSettings({ token, showToast }: { token: string; showToast: (t: string) => void }) {
  const queryClient = useQueryClient();
  const defaultRedirectUri = typeof window !== "undefined" ? `${window.location.origin}/oauth/callback` : "";
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(defaultRedirectUri);
  const oauthConfig = useQuery({
    queryKey: ["google-oauth-admin", token],
    queryFn: () => api.getGoogleOAuthAdminConfig({ token }),
  });
  useEffect(() => {
    if (oauthConfig.data?.redirectUri) setRedirectUri(oauthConfig.data.redirectUri);
  }, [oauthConfig.data?.redirectUri]);
  const save = useMutation({
    mutationFn: () => api.saveGoogleOAuthConfig({ token, clientId: clientId.trim(), clientSecret, redirectUri: redirectUri.trim() }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        setClientSecret("");
        void oauthConfig.refetch();
        void queryClient.invalidateQueries({ queryKey: ["public-config"] });
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  return (
    <div className="section-block oauth-settings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Google sign-in</h2>
          <p style={{ margin: "4px 0 0" }}>Admin-only provider setup. The secret is never shown back.</p>
        </div>
        <span className={`oauth-badge ${oauthConfig.data?.configured ? "enabled" : "disabled"}`}>
          {oauthConfig.data?.configured ? "Live" : "Setup needed"}
        </span>
      </div>
      <div className="field">
        <label htmlFor="oauth-client-id">Google Client ID</label>
        <input
          id="oauth-client-id"
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxx.apps.googleusercontent.com"
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor="oauth-secret">Google Client Secret</label>
        <input
          id="oauth-secret"
          className="input"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={oauthConfig.data?.secretStored ? "Stored securely — leave blank to keep" : "Paste client secret"}
          autoComplete="new-password"
        />
      </div>
      <div className="field">
        <label htmlFor="oauth-redirect">Authorized redirect URI</label>
        <input
          id="oauth-redirect"
          className="input"
          type="url"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder="https://your-domain.example/oauth/callback"
          autoComplete="off"
        />
      </div>
      <div className="oauth-guidance">
        <strong>Setup steps:</strong>
        <ol>
          <li>Create a Google Cloud OAuth web client and add the redirect URI above as an authorized redirect URI.</li>
          <li>Paste the client ID and client secret here and save.</li>
          <li>Until then, the “Continue with Google” button stays disabled — this is honest, not broken.</li>
        </ol>
        {oauthConfig.data?.clientIdHint && <span>Saved client: {oauthConfig.data.clientIdHint}</span>}
      </div>
      <button className="button" onClick={() => save.mutate()} disabled={save.isPending || clientId.trim().length < 20}>
        {save.isPending ? "Saving…" : "Save Google settings"}
      </button>
    </div>
  );
}

function AdminView({ token, showToast }: { token: string; showToast: (t: string) => void }) {
  const queryClient = useQueryClient();
  const admin = useQuery({
    queryKey: ["admin", token],
    queryFn: () => api.getAdminDashboard({ token }),
  });

  const savePlans = useMutation({
    mutationFn: (v: { gmailPriceCents: number; proPriceCents: number; freeTtlMinutes: number }) =>
      api.savePlanConfig({ token, ...v }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        void admin.refetch();
        void queryClient.invalidateQueries({ queryKey: ["plans"] });
        void queryClient.invalidateQueries({ queryKey: ["public-config"] });
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const activate = useMutation({
    mutationFn: (t: PendingTx) =>
      api.completePlanUpgrade({ token, transactionId: t.id, plan: (t.plan === "gmail" ? "gmail" : "pro") as PaidPlan }),
    onSuccess: (r) => {
      showToast(r.message);
      if (r.ok) {
        void admin.refetch();
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
    onError: () => showToast("Could not reach the server. Please try again."),
  });

  const a = admin.data;
  const m = a?.metrics;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {!a || !m ? (
        <div className="section-block">
          <div className="empty">{admin.isLoading ? "Loading admin dashboard…" : (a?.message ?? "Could not load admin dashboard.")}</div>
        </div>
      ) : (
        <>
          <div className="section-block">
            <h2>Overview</h2>
            <p>Users, addresses, deposits and upgrades at a glance.</p>
            <div className="admin-metrics">
              {[
                ["Users", m.totalUsers],
                ["Verified", m.verifiedUsers],
                ["Active", m.activeUsers],
                ["Gmail users", m.gmailUsers],
                ["Pro users", m.proUsers],
                ["Active addresses", m.tempEmailsActive],
                ["Completed deposits", m.completedDeposits],
                ["Pending deposits", m.pendingDeposits],
                ["Failed deposits", m.failedDeposits],
                ["Pending upgrades", m.pendingUpgrades],
              ].map(([label, value]) => (
                <div className="stat" key={label as string}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="section-block">
            <h2>Pending transactions</h2>
            <p>
              Deposits are verified manually outside the app (credit the wallet after you confirm the
              crypto payment). Plan upgrades are activated with one click below.
            </p>
            {a.pendingTransactions.length === 0 ? (
              <div className="empty">Nothing pending. New deposit and upgrade requests will appear here.</div>
            ) : (
              <div className="row-list">
                {a.pendingTransactions.map((t) => (
                  <div className="row-item" key={t.id}>
                    <div className="grow">
                      <strong>
                        {txLabel(t.type)}
                        {t.type === "plan_upgrade" ? ` → ${planName(t.plan ?? "pro")}` : ""} · {formatMoney(t.amount)}
                      </strong>
                      <small>
                        {t.id} · {t.userEmail} · {formatTime(t.createdAt)}
                      </small>
                    </div>
                    {t.type === "plan_upgrade" ? (
                      <button className="button small" onClick={() => activate.mutate(t)} disabled={activate.isPending}>
                        Activate {planName(t.plan ?? "pro")}
                      </button>
                    ) : (
                      <span className="tx-status pending">manual verify</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-block">
            <h2>Plan settings</h2>
            <p>Prices shown on the landing page and the free address lifetime. Changes apply immediately.</p>
            <PlanConfigForm initial={a.planConfig} onSave={(v) => savePlans.mutate(v)} saving={savePlans.isPending} />
          </div>

          <div className="section-block">
            <h2>Recent users</h2>
            <p>Latest signups.</p>
            <div className="row-list">
              {a.recentUsers.map((u) => (
                <div className="row-item" key={u.id}>
                  <div className="grow">
                    <strong>{u.name}</strong>
                    <small>
                      {u.email} · {planName(u.plan)} · {formatDate(u.createdAt)}
                    </small>
                  </div>
                  {u.role === "admin" && <span className="tx-status completed">admin</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="section-block">
            <h2>Recent temp emails</h2>
            <p>Latest generated addresses.</p>
            <div className="row-list">
              {a.recentTempEmails.map((t) => (
                <div className="row-item" key={t.id}>
                  <div className="grow">
                    <strong>{t.address}</strong>
                    <small>
                      {t.userEmail ?? "anonymous"} · expires {formatTime(t.expiresAt)}
                    </small>
                  </div>
                  <span className={`tx-status ${t.expired ? "failed" : "completed"}`}>{t.expired ? "expired" : "active"}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="section-block">
            <h2>Recent audit log</h2>
            <p>Latest admin and account events.</p>
            <div className="row-list">
              {a.recentAudit.map((log) => (
                <div className="audit-row" key={log.id}>
                  <div className="grow">{log.action}</div>
                  <small style={{ color: "var(--muted)" }}>{formatTime(log.createdAt)}</small>
                </div>
              ))}
            </div>
          </div>

          <OAuthSettings token={token} showToast={showToast} />
        </>
      )}
    </div>
  );
}

/* ================= Workspace shell ================= */

function Workspace({
  token,
  showToast,
  onLogout,
}: {
  token: string;
  showToast: (t: string) => void;
  onLogout: () => void;
}) {
  const [view, setView] = useState<WorkspaceView>("inbox");
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", token],
    queryFn: () => api.getDashboard({ token }),
    retry: false,
  });
  const configQuery = useQuery({
    queryKey: ["public-config"],
    queryFn: () => api.getPublicConfig({}),
  });
  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.getPlans({}),
  });

  const dashboard = dashboardQuery.data;
  const isAdmin = dashboard?.user.role === "admin";

  const nav: { id: WorkspaceView; icon: string; label: string }[] = [
    { id: "inbox", icon: "inbox", label: "Inbox" },
    { id: "numbers", icon: "phone", label: "Numbers" },
    { id: "wallet", icon: "wallet", label: "Wallet" },
    { id: "profile", icon: "user", label: "Profile" },
  ];
  if (isAdmin) nav.push({ id: "admin", icon: "shield", label: "Admin" });

  const titles: Record<WorkspaceView, { h: string; p: string }> = {
    inbox: { h: "Inbox", p: "Your temporary addresses and messages." },
    numbers: { h: "Numbers", p: "Virtual phone numbers for receiving SMS." },
    wallet: { h: "Wallet", p: "Balance, deposits and plan upgrades." },
    profile: { h: "Profile", p: "Account settings." },
    admin: { h: "Administration", p: "Users, plans, payments and provider setup." },
  };

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <img src={logo} alt="Fast Temp Mail" className="logo" />
        {nav.map((n) => (
          <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)}>
            <Icon name={n.icon} size={17} />
            <span>{n.label}</span>
          </button>
        ))}
        <div className="admin-entry">
          <button onClick={onLogout}>
            <Icon name="logout" size={17} />
            <span>Logout</span>
          </button>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <h1>{titles[view].h}</h1>
            <p>{titles[view].p}</p>
          </div>
          <div className="header-actions">
            {dashboard && <span className={`plan-badge ${dashboard.user.plan}`}>{planName(dashboard.user.plan)}</span>}
            <ThemeToggle />
          </div>
        </header>

        {dashboardQuery.isLoading ? (
          <div className="section-block">
            <div className="empty">Loading your workspace…</div>
          </div>
        ) : !dashboard ? (
          <div className="section-block">
            <div className="notice error">Your session expired. Please sign in again.</div>
            <div style={{ marginTop: 12 }}>
              <button className="button" onClick={onLogout}>
                Sign in
              </button>
            </div>
          </div>
        ) : (
          <>
            {view === "inbox" && <InboxView token={token} showToast={showToast} demoMode={configQuery.data?.demoMode ?? true} />}
            {view === "numbers" && <NumbersView token={token} showToast={showToast} />}
            {view === "wallet" && (
              <WalletView
                token={token}
                dashboard={dashboard}
                plans={plansQuery.data}
                minimumDeposit={configQuery.data?.minimumDeposit ?? 3}
                showToast={showToast}
              />
            )}
            {view === "profile" && <ProfileView token={token} dashboard={dashboard} showToast={showToast} />}
            {view === "admin" && isAdmin && <AdminView token={token} showToast={showToast} />}
          </>
        )}
      </main>
    </div>
  );
}

function PrivacyPage() {
  return (
    <div className="landing">
      <nav className="navbar">
        <div className="container nav-inner">
          <a className="brand" href="/" aria-label="Fast Temp Mail home">
            <img src={logo} alt="Fast Temp Mail" className="logo" />
          </a>
          <div className="nav-links">
            <a href="/#features">Features</a>
            <a href="/#preview">Dashboard</a>
            <a href="/#pricing">Pricing</a>
          </div>
          <div className="nav-buttons">
            <a className="btn" href="/">
              Back to home
            </a>
          </div>
        </div>
      </nav>
      <main className="container" style={{ padding: "56px 20px 90px", maxWidth: 860 }}>
        <h1 style={{ fontSize: 36, marginBottom: 8 }}>Privacy Policy</h1>
        <p style={{ color: "var(--muted)", marginBottom: 32 }}>Last updated: September 29, 2026</p>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>1. Overview</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            Fast Temp Mail ("we", "our") provides temporary email addresses and related account features. This policy
            explains what information we collect, how we use it, and the choices you have. By using Fast Temp Mail you
            agree to this policy.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>2. Information we collect</h2>
          <ul style={{ color: "var(--muted)", lineHeight: 1.8, paddingLeft: 20 }}>
            <li>
              <strong style={{ color: "var(--text)" }}>Account information:</strong> when you sign up with email and
              password we store your name, email address, and a one-way hash of your password (we never store plain-text
              passwords).
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>Google sign-in:</strong> if you choose "Continue with Google" we
              receive your name, email address, and profile picture from Google using the openid, email, and profile
              scopes. We use this only to create and sign you into your account.
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>Temporary addresses and usage:</strong> the temporary addresses
              you generate, their creation time, and basic service logs needed to operate the service.
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>Wallet and plans:</strong> your wallet balance, plan type, and
              deposit/upgrade records.
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>Device data:</strong> a session token stored in your browser's
              local storage to keep you signed in, and your theme preference.
            </li>
          </ul>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>3. How we use your information</h2>
          <ul style={{ color: "var(--muted)", lineHeight: 1.8, paddingLeft: 20 }}>
            <li>To provide, maintain, and secure the temporary email service.</li>
            <li>To send verification and password-reset codes by email.</li>
            <li>To prevent fraud, abuse, and unauthorized access.</li>
            <li>To respond to your support requests.</li>
          </ul>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>4. Temporary addresses</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            Free temporary addresses automatically expire 24 hours after creation, along with their contents. Temporary
            addresses are designed for short-lived use — do not use them for accounts or services you need long-term
            access to, such as banking or primary email accounts.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>5. Data sharing</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            We do not sell your personal information. We share limited data only with service providers required to
            operate Fast Temp Mail — for example, our email delivery provider, which receives your email address solely
            to deliver verification and password-reset messages. We may disclose information if required by law.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>6. Data retention and deletion</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            We keep account data while your account is active. You may request deletion of your account and personal data
            at any time by contacting us at the address below; we will delete it unless we are required to retain it for
            legal or security reasons.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>7. Security</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            We use reasonable technical measures to protect your information, including hashed password storage and
            encrypted connections (HTTPS). No method of transmission over the internet is completely secure, so we
            cannot guarantee absolute security.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>8. Children's privacy</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            Fast Temp Mail is not directed at children under 13, and we do not knowingly collect their personal
            information.
          </p>
        </section>

        <section style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>9. Changes to this policy</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            We may update this policy from time to time. The "Last updated" date at the top will reflect the latest
            version.
          </p>
        </section>

        <section style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 22, marginBottom: 10 }}>10. Contact us</h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.7 }}>
            For privacy questions or data requests, contact us at{" "}
            <a href="mailto:fastmail.support01@gmail.com" style={{ color: "var(--cyan)" }}>
              fastmail.support01@gmail.com
            </a>
            .
          </p>
        </section>
      </main>
      <Footer demoMode={false} />
    </div>
  );
}

/* ================= App root ================= */

export function App() {
  const [token, setToken] = useState<string>(readSavedSession);
  const [auth, setAuth] = useState<{ mode: "login" | "signup"; plan?: PaidPlan } | null>(null);
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);
  const { toasts, show: showToast } = useToasts();
  const queryClient = useQueryClient();

  const publicConfig = useQuery({
    queryKey: ["public-config"],
    queryFn: () => api.getPublicConfig({}),
  });
  const plansQuery = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.getPlans({}),
  });

  const completeGoogle = useMutation({
    mutationFn: (args: { code: string; state: string }) => api.completeGoogleOAuth(args),
    onSuccess: (r) => {
      if (r.ok && r.token) {
        saveSession(r.token);
        setToken(r.token);
        setGlobalNotice(null);
        showToast("Signed in with Google.");
      } else {
        setGlobalNotice(r.message);
      }
    },
    onError: () => setGlobalNotice("Google sign-in could not be completed. Please try again."),
  });

  // Google OAuth redirect lands back here with ?code=&state=
  useEffect(() => {
    document.documentElement.dataset.theme = readTheme();
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    if (code || state || error) {
      window.history.replaceState({}, "", window.location.pathname);
      if (error) {
        setGlobalNotice(`Google sign-in was cancelled (${error}).`);
      } else if (code && state) {
        completeGoogle.mutate({ code, state });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setToken("");
    setAuth(null);
    void queryClient.clear();
  }, [queryClient]);

  const handleAuthed = useCallback(
    (t: string) => {
      saveSession(t);
      setToken(t);
      const pendingPlan = auth?.plan;
      setAuth(null);
      showToast("Signed in successfully.");
      if (pendingPlan) {
        // The user picked a paid plan before signing in — create the request now.
        api
          .requestPlanUpgrade({ token: t, plan: pendingPlan })
          .then((r) => showToast(r.message))
          .catch(() => showToast("Signed in. You can request the upgrade from the pricing section."));
      }
    },
    [auth, showToast],
  );

  const pickPaid = useCallback(
    (plan: PaidPlan) => {
      if (token.length >= 20) {
        api
          .requestPlanUpgrade({ token, plan })
          .then((r) => {
            showToast(r.message);
            void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          })
          .catch(() => showToast("Could not reach the server. Please try again."));
      } else {
        setAuth({ mode: "signup", plan });
      }
    },
    [token, queryClient, showToast],
  );

  const isAuthed = token.length >= 20;
  const config: PublicConfig | undefined = publicConfig.data;
  const googleEnabled = config?.providers.google ?? false;

  // If the stored session died server-side, drop it instead of looping.
  const dashboardProbe = useQuery({
    queryKey: ["dashboard", token],
    queryFn: () => api.getDashboard({ token }),
    enabled: isAuthed,
    retry: false,
  });
  useEffect(() => {
    if (dashboardProbe.isError) logout();
  }, [dashboardProbe.isError, logout]);

  const showPrivacy =
    typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/privacy";
  if (showPrivacy) {
    return <PrivacyPage />;
  }

  if (!isAuthed) {
    return (
      <div className="landing">
        {config?.demoMode && (
          <div className="global-notice">
            Demo mode is on: the inbox is simulated and deposits/upgrades are handled manually until providers are connected.
          </div>
        )}
        {globalNotice && (
          <div className="global-notice" role="alert">
            {globalNotice}
          </div>
        )}
        <Navbar
          isAuthed={false}
          onLogin={() => setAuth({ mode: "login" })}
          onSignup={() => setAuth({ mode: "signup" })}
          onDashboard={() => {}}
          onLogout={logout}
        />
        <HomePage
          token={token}
          demoMode={config?.demoMode ?? true}
          plans={plansQuery.data}
          userPlan="free"
          showToast={showToast}
          onOpenAuth={(mode) => setAuth({ mode })}
          onPickPaid={pickPaid}
        />
        <Footer demoMode={config?.demoMode ?? false} />
        {auth && (
          <AuthModal
            initial={auth.mode}
            googleEnabled={googleEnabled}
            onClose={() => setAuth(null)}
            onAuthed={handleAuthed}
            showToast={showToast}
          />
        )}
        <Toasts toasts={toasts} />
      </div>
    );
  }

  return (
    <div className="landing">
      <Workspace token={token} showToast={showToast} onLogout={logout} />
      <Toasts toasts={toasts} />
    </div>
  );
}
