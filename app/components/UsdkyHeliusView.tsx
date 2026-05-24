'use client';

import { useEffect, useState } from 'react';

const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com/';
const USDKY_MINT = 'usdkyPPxgV7sfNyKb8eDz66ogPrkRXG3wS2FVb6LLUf';
const USDKY_DECIMALS = 6;
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SESSION_KEY = 'helius_api_key';
const MAX_WALLETS = 5;
const RPC_SLEEP_MS = 120;
const SIG_PAGE = 1000;

interface MultiplierUpdate {
  block_time: number;
  multiplier: number;
  signature: string;
}

type EventKind = 'mint' | 'burn' | 'transfer-in' | 'transfer-out';

interface WalletEvent {
  wallet: string;
  signature: string;
  block_time: number;
  kind: EventKind;
  delta_principal: number;
  multiplier_at: number | null;
  delta_usd: number | null;
}

interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err?: unknown;
}

interface ParsedInstruction {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

interface TransactionResponse {
  blockTime: number | null;
  meta?: {
    innerInstructions?: Array<{ instructions?: ParsedInstruction[] }>;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatUtc(blockTimeSec: number): string {
  const d = new Date(blockTimeSec * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

async function heliusRpc<T>(apiKey: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(
    `${HELIUS_RPC_BASE}?api-key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
  );
  if (!res.ok) {
    throw new Error(`Helius HTTP ${res.status}`);
  }
  const json = (await res.json()) as { error?: { message?: string }; result?: T };
  if (json.error) {
    throw new Error(`Helius RPC error: ${json.error.message ?? 'unknown'}`);
  }
  return json.result as T;
}

async function getSignaturesInRange(
  apiKey: string,
  address: string,
  startMs: number,
  endMs: number,
  onProgress?: (collected: number) => void,
): Promise<SignatureInfo[]> {
  const collected: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const opts: Record<string, unknown> = { limit: SIG_PAGE };
    if (before) opts.before = before;
    const sigs =
      (await heliusRpc<SignatureInfo[] | null>(apiKey, 'getSignaturesForAddress', [
        address,
        opts,
      ])) ?? [];
    if (sigs.length === 0) break;
    for (const s of sigs) {
      const tMs = (s.blockTime ?? 0) * 1000;
      if (tMs >= startMs && tMs <= endMs) collected.push(s);
    }
    onProgress?.(collected.length);
    const lastT = (sigs[sigs.length - 1].blockTime ?? 0) * 1000;
    if (lastT > 0 && lastT < startMs) break;
    if (sigs.length < SIG_PAGE) break;
    before = sigs[sigs.length - 1].signature;
    await sleep(RPC_SLEEP_MS);
  }
  return collected;
}

async function fetchTx(apiKey: string, signature: string): Promise<TransactionResponse | null> {
  return await heliusRpc<TransactionResponse | null>(apiKey, 'getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
}

function extractMultiplierUpdate(tx: TransactionResponse | null, signature: string): MultiplierUpdate | null {
  if (!tx || tx.blockTime == null) return null;
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const inst of group.instructions ?? []) {
      if (inst.programId !== TOKEN_2022_PROGRAM_ID) continue;
      if (inst.parsed?.type !== 'updateMultiplier') continue;
      const raw = inst.parsed.info?.newMultiplier;
      const num = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      if (Number.isFinite(num)) {
        return { block_time: tx.blockTime, multiplier: num, signature };
      }
    }
  }
  return null;
}

function extractWalletDelta(tx: TransactionResponse | null, wallet: string, signature: string): WalletEvent | null {
  if (!tx || tx.blockTime == null) return null;
  const pre = (tx.meta?.preTokenBalances ?? []).filter(
    (b) => b.owner === wallet && b.mint === USDKY_MINT,
  );
  const post = (tx.meta?.postTokenBalances ?? []).filter(
    (b) => b.owner === wallet && b.mint === USDKY_MINT,
  );
  if (pre.length === 0 && post.length === 0) return null;
  const sumAmount = (arr: TokenBalance[]): number =>
    arr.reduce((s, b) => s + Number(b.uiTokenAmount?.amount ?? '0'), 0);
  const deltaBase = sumAmount(post) - sumAmount(pre);
  if (deltaBase === 0) return null;
  const delta = deltaBase / Math.pow(10, USDKY_DECIMALS);

  let kind: EventKind = delta > 0 ? 'transfer-in' : 'transfer-out';
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const inst of group.instructions ?? []) {
      if (inst.programId !== TOKEN_2022_PROGRAM_ID) continue;
      const t = inst.parsed?.type;
      if (delta > 0 && (t === 'mintTo' || t === 'mintToChecked')) kind = 'mint';
      if (delta < 0 && (t === 'burn' || t === 'burnChecked')) kind = 'burn';
    }
  }

  return {
    wallet,
    signature,
    block_time: tx.blockTime,
    kind,
    delta_principal: delta,
    multiplier_at: null,
    delta_usd: null,
  };
}

function lookupMultiplier(
  blockTime: number,
  history: MultiplierUpdate[],
  baseline: number | null,
): number | null {
  let best: number | null = baseline;
  for (const u of history) {
    if (u.block_time <= blockTime) best = u.multiplier;
    else break;
  }
  return best;
}

function kindBadge(kind: EventKind): { label: string; cls: string } {
  switch (kind) {
    case 'mint':
      return { label: 'mint', cls: 'text-[#A3BE8C]' };
    case 'burn':
      return { label: 'burn', cls: 'text-[#BF616A]' };
    case 'transfer-in':
      return { label: 'transfer-in', cls: 'text-[#A3BE8C]' };
    case 'transfer-out':
      return { label: 'transfer-out', cls: 'text-[#BF616A]' };
  }
}

function formatDelta(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  return `${sign}${abs}`;
}

function formatDeltaUsd(n: number | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

export default function UsdkyHeliusView() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [walletsInput, setWalletsInput] = useState('');
  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(todayISO());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [events, setEvents] = useState<WalletEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const k = window.sessionStorage.getItem(SESSION_KEY);
    if (k) setApiKey(k);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (apiKey) window.sessionStorage.setItem(SESSION_KEY, apiKey);
  }, [apiKey]);

  const handleClearKey = () => {
    setApiKey('');
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  };

  const handleFetch = async () => {
    setErr(null);
    setEvents(null);
    setRunning(true);
    setProgress('Starting…');

    try {
      const key = apiKey.trim();
      if (!key) throw new Error('Helius API key is required');

      const wallets = walletsInput
        .split(/[\s,]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);
      if (wallets.length === 0) throw new Error('At least one wallet is required');
      if (wallets.length > MAX_WALLETS) {
        throw new Error(`Up to ${MAX_WALLETS} wallets per query`);
      }

      const startMs = Date.parse(`${startDate}T00:00:00Z`);
      const endMs = Date.parse(`${endDate}T23:59:59Z`);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        throw new Error('Invalid date range');
      }

      setProgress('Fetching multiplier-update signatures…');
      const mintSigs = await getSignaturesInRange(key, USDKY_MINT, startMs, endMs);

      const multHistory: MultiplierUpdate[] = [];
      for (let i = 0; i < mintSigs.length; i++) {
        setProgress(`Parsing multiplier update tx ${i + 1}/${mintSigs.length}`);
        const tx = await fetchTx(key, mintSigs[i].signature);
        const upd = extractMultiplierUpdate(tx, mintSigs[i].signature);
        if (upd) multHistory.push(upd);
        await sleep(RPC_SLEEP_MS);
      }
      multHistory.sort((a, b) => a.block_time - b.block_time);

      let baselineMult: number | null = null;
      setProgress('Resolving baseline multiplier before range…');
      const anchorBefore =
        mintSigs.length > 0 ? mintSigs[mintSigs.length - 1].signature : undefined;
      const baselinePage =
        (await heliusRpc<SignatureInfo[] | null>(apiKey, 'getSignaturesForAddress', [
          USDKY_MINT,
          anchorBefore ? { limit: 50, before: anchorBefore } : { limit: 50 },
        ])) ?? [];
      for (const s of baselinePage) {
        const tx = await fetchTx(key, s.signature);
        const upd = extractMultiplierUpdate(tx, s.signature);
        if (upd) {
          baselineMult = upd.multiplier;
          break;
        }
        await sleep(RPC_SLEEP_MS);
      }

      const all: WalletEvent[] = [];
      for (const wallet of wallets) {
        setProgress(`Listing USDKY token accounts for ${wallet.slice(0, 8)}…`);
        const ataRes = await heliusRpc<{ value: Array<{ pubkey: string }> } | null>(
          key,
          'getTokenAccountsByOwner',
          [wallet, { mint: USDKY_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        );
        const atas = (ataRes?.value ?? []).map((a) => a.pubkey);
        if (atas.length === 0) continue;

        for (const ata of atas) {
          const sigs = await getSignaturesInRange(key, ata, startMs, endMs, (n) => {
            setProgress(`Collecting signatures for ${wallet.slice(0, 8)}… (${n})`);
          });
          for (let i = 0; i < sigs.length; i++) {
            setProgress(
              `Parsing ${wallet.slice(0, 8)}… tx ${i + 1}/${sigs.length} (${ata.slice(0, 6)}…)`,
            );
            const tx = await fetchTx(key, sigs[i].signature);
            const evt = extractWalletDelta(tx, wallet, sigs[i].signature);
            if (evt) all.push(evt);
            await sleep(RPC_SLEEP_MS);
          }
        }
      }

      for (const evt of all) {
        evt.multiplier_at = lookupMultiplier(evt.block_time, multHistory, baselineMult);
        evt.delta_usd =
          evt.multiplier_at != null ? evt.delta_principal * evt.multiplier_at : null;
      }
      all.sort((a, b) => b.block_time - a.block_time);
      setEvents(all);
      setProgress(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <p className="text-sm text-[#4C566A] dark:text-[#D8DEE9]">
        Pull USDKY mint/burn/transfer events for one or more wallets directly from Helius RPC.
        The key is kept only in <code>sessionStorage</code> and sent straight to{' '}
        <code>mainnet.helius-rpc.com</code> — it never reaches this site&apos;s backend.
      </p>

      <div className="mt-4 space-y-3 rounded-md border border-[#D8DEE9] bg-[#E5E9F0] p-3 shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex flex-1 min-w-[260px] items-center gap-2">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">Helius API key</span>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 font-mono text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4]"
            />
          </label>
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] hover:bg-[#D8DEE9] dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:hover:bg-[#4C566A]"
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={handleClearKey}
            className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] hover:bg-[#D8DEE9] dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] dark:hover:bg-[#4C566A]"
          >
            Clear
          </button>
        </div>

        <label className="block">
          <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">
            Wallets (one address per line, up to {MAX_WALLETS})
          </span>
          <textarea
            value={walletsInput}
            onChange={(e) => setWalletsInput(e.target.value)}
            rows={3}
            placeholder="Solana wallet addresses, one per line"
            spellCheck={false}
            className="mt-1 w-full rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 font-mono text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4]"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">From</span>
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] [color-scheme:light] dark:[color-scheme:dark]"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">To</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded border border-[#D8DEE9] bg-[#ECEFF4] px-2 py-1 text-xs text-[#2E3440] focus:border-[#5E81AC] focus:outline-none dark:border-[#4C566A] dark:bg-[#434C5E] dark:text-[#ECEFF4] [color-scheme:light] dark:[color-scheme:dark]"
            />
          </label>
          <button
            type="button"
            onClick={handleFetch}
            disabled={running}
            className="rounded bg-[#5E81AC] px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-[#81A1C1] disabled:opacity-50 dark:bg-[#5E81AC] dark:hover:bg-[#81A1C1]"
          >
            {running ? 'Fetching…' : 'Fetch on-chain history'}
          </button>
          {progress && (
            <span className="text-xs text-[#4C566A] dark:text-[#D8DEE9]">{progress}</span>
          )}
        </div>
      </div>

      {err && (
        <p className="mt-4 rounded border border-[#BF616A] bg-[#BF616A]/10 p-3 text-sm text-[#BF616A]">
          {err}
        </p>
      )}

      {events && (
        <div className="mt-4 overflow-hidden rounded-md border border-[#D8DEE9] bg-[#ECEFF4] shadow-sm dark:border-[#434C5E] dark:bg-[#3B4252]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[#D8DEE9] bg-[#E5E9F0] px-3 py-1.5 text-xs text-[#4C566A] dark:border-[#434C5E] dark:bg-[#434C5E] dark:text-[#D8DEE9]">
            <span>
              Events: <strong>{events.length.toLocaleString()}</strong>
            </span>
            <span>
              Range: <strong>{startDate}</strong> → <strong>{endDate}</strong>
            </span>
          </div>
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#E5E9F0] text-[#2E3440] dark:bg-[#434C5E] dark:text-[#ECEFF4]">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                    Block time (UTC)
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">Wallet</th>
                  <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">Signature</th>
                  <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">Type</th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">
                    Δ Principal
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">
                    Multiplier@time
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">Δ USD</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-2 py-3 text-center text-[#4C566A] dark:text-[#D8DEE9]"
                    >
                      No USDKY events for these wallets in the selected range.
                    </td>
                  </tr>
                )}
                {events.map((e) => {
                  const badge = kindBadge(e.kind);
                  return (
                    <tr
                      key={`${e.signature}-${e.wallet}`}
                      className="border-t border-[#D8DEE9]/60 hover:bg-[#E5E9F0] dark:border-[#434C5E] dark:hover:bg-[#434C5E]"
                    >
                      <td className="px-2 py-1 font-mono whitespace-nowrap">
                        {formatUtc(e.block_time)}
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">
                        <a
                          href={`https://solscan.io/account/${e.wallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#5E81AC] hover:underline dark:text-[#88C0D0]"
                        >
                          {e.wallet.slice(0, 6)}…{e.wallet.slice(-4)}
                        </a>
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">
                        <a
                          href={`https://solscan.io/tx/${e.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#5E81AC] hover:underline dark:text-[#88C0D0]"
                        >
                          {e.signature.slice(0, 6)}…{e.signature.slice(-4)}
                        </a>
                      </td>
                      <td className={`px-2 py-1 font-mono whitespace-nowrap ${badge.cls}`}>
                        {badge.label}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono whitespace-nowrap ${
                          e.delta_principal > 0 ? 'text-[#A3BE8C]' : 'text-[#BF616A]'
                        }`}
                      >
                        {formatDelta(e.delta_principal)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-[#4C566A] dark:text-[#D8DEE9]">
                        {e.multiplier_at == null ? '—' : e.multiplier_at.toFixed(6)}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono whitespace-nowrap ${
                          e.delta_usd == null
                            ? 'text-[#4C566A] dark:text-[#D8DEE9]'
                            : e.delta_usd > 0
                              ? 'text-[#A3BE8C]'
                              : 'text-[#BF616A]'
                        }`}
                      >
                        {formatDeltaUsd(e.delta_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
