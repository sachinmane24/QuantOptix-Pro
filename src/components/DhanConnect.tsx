import { useEffect, useState, type CSSProperties } from 'react';

/**
 * DhanConnect — self-contained manual login panel for Dhan.
 *
 * Two ways to connect:
 *   1) Manual access token (recommended to start). Generate at
 *      web.dhan.co -> My Profile -> Access DhanHQ APIs. Valid 24 hours.
 *   2) Auto-login via TOTP (requires 2FA/TOTP enabled on the Dhan account).
 *
 * Styling is inline so it can be dropped into any layout. Render it anywhere,
 * e.g. <DhanConnect /> inside a settings modal or the header.
 */

type Status = {
  isConnected: boolean;
  clientId?: string;
  tokenPresent?: boolean;
  scripLoaded?: boolean;
  scripCount?: number;
};

const wrap: CSSProperties = { background: '#0e0f13', border: '1px solid #23262e', borderRadius: 12, padding: 20, color: '#e6e6e6', maxWidth: 460, fontFamily: 'Inter, system-ui, sans-serif' };
const label: CSSProperties = { fontSize: 12, color: '#8a909c', marginBottom: 4, display: 'block' };
const input: CSSProperties = { width: '100%', padding: '10px 12px', background: '#16181d', border: '1px solid #2a2e37', borderRadius: 8, color: '#fff', marginBottom: 12, fontSize: 14, boxSizing: 'border-box' };
const btn = (bg: string): CSSProperties => ({ width: '100%', padding: '11px 14px', background: bg, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 14 });
const tabBtn = (active: boolean): CSSProperties => ({ flex: 1, padding: '8px', background: active ? '#2563eb' : 'transparent', color: active ? '#fff' : '#8a909c', border: '1px solid #2a2e37', cursor: 'pointer', fontSize: 13 });

export default function DhanConnect() {
  const [tab, setTab] = useState<'token' | 'totp'>('token');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Manual token fields
  const [clientId, setClientId] = useState('');
  const [token, setToken] = useState('');

  // TOTP fields
  const [totpKey, setTotpKey] = useState('');
  const [userPin, setUserPin] = useState('');
  const [save, setSave] = useState(true);

  const refresh = async () => {
    try {
      const r = await fetch('/api/auth/dhan/status');
      setStatus(await r.json());
    } catch { /* ignore */ }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const connectToken = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/auth/dhan/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), clientId: clientId.trim() })
      });
      const d = await r.json();
      setMsg({ ok: !!d.success, text: d.message + (d.details ? ` — ${d.details}` : '') });
      if (d.success) { setToken(''); refresh(); }
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const connectTotp = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/auth/dhan/automate-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), totpKey: totpKey.trim(), userPin: userPin.trim(), saveCredentials: save })
      });
      const d = await r.json();
      setMsg({ ok: !!d.success, text: d.message });
      if (d.success) refresh();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const connected = status?.isConnected;

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect to Dhan</h3>
        <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 20, background: connected ? '#0c3a22' : '#3a1a1a', color: connected ? '#4ade80' : '#f87171' }}>
          {connected ? `● Connected${status?.clientId ? ` (${status.clientId})` : ''}` : '● Disconnected'}
        </span>
      </div>

      {connected && (
        <p style={{ fontSize: 12, color: '#8a909c', marginTop: -6, marginBottom: 14 }}>
          Scrip master: {status?.scripLoaded ? `${status?.scripCount} symbols` : 'loading…'}. Tokens are valid 24h — reconnect daily.
        </p>
      )}

      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 8, overflow: 'hidden' }}>
        <button style={tabBtn(tab === 'token')} onClick={() => setTab('token')}>Manual Token</button>
        <button style={tabBtn(tab === 'totp')} onClick={() => setTab('totp')}>Auto (TOTP)</button>
      </div>

      <label style={label}>Dhan Client ID</label>
      <input style={input} value={clientId} onChange={e => setClientId(e.target.value)} placeholder="e.g. 1100xxxxxx" />

      {tab === 'token' ? (
        <>
          <label style={label}>Access Token (web.dhan.co → My Profile → Access DhanHQ APIs)</label>
          <input style={input} value={token} onChange={e => setToken(e.target.value)} placeholder="eyJ0eXAiOiJKV1Qi…" />
          <button style={btn('#2563eb')} disabled={busy || !token || !clientId} onClick={connectToken}>
            {busy ? 'Connecting…' : 'Connect with Token'}
          </button>
        </>
      ) : (
        <>
          <label style={label}>TOTP Secret (base32, from 2FA setup)</label>
          <input style={input} value={totpKey} onChange={e => setTotpKey(e.target.value)} placeholder="XXXXXXXXXXXXXXXX" />
          <label style={label}>Dhan PIN (6 digits)</label>
          <input style={input} value={userPin} onChange={e => setUserPin(e.target.value)} placeholder="••••••" type="password" maxLength={6} />
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} /> Cache for daily auto-login (stored locally, git-ignored)
          </label>
          <button style={btn('#7c3aed')} disabled={busy || !totpKey || !userPin || !clientId} onClick={connectTotp}>
            {busy ? 'Logging in…' : 'Generate Token & Connect'}
          </button>
        </>
      )}

      {msg && (
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? '#0c3a22' : '#3a1a1a', color: msg.ok ? '#86efac' : '#fca5a5' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
