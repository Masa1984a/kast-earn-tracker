import { env } from 'node:process';

export const USDKY_MINT = 'usdkyPPxgV7sfNyKb8eDz66ogPrkRXG3wS2FVb6LLUf';
export const USDKY_DECIMALS = 6;
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function rpcUrl(): string {
  const key = env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

interface RpcError {
  code: number;
  message: string;
}
interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: RpcError;
}

export async function rpc<T>(method: string, params: unknown = []): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Helius RPC ${method} HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as RpcResponse<T>;
  if (body.error) {
    throw new Error(`Helius RPC ${method} error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`Helius RPC ${method} returned no result`);
  }
  return body.result;
}

// ─── Multiplier ──────────────────────────────────────────────────────────────

// The ScaledUI extension stores a string-encoded fixed-point multiplier in the
// parsed Mint account. Field name confirmed in Phase 3.1 — keep this defensive
// so we surface a clear error if the on-chain shape changes.
interface ParsedMintAccount {
  data: {
    parsed: {
      info: {
        extensions?: Array<{
          extension: string;
          state: Record<string, unknown>;
        }>;
      };
    };
  };
}

export async function getMultiplier(): Promise<number> {
  const info = await rpc<{ value: ParsedMintAccount | null }>('getAccountInfo', [
    USDKY_MINT,
    { encoding: 'jsonParsed' },
  ]);
  if (!info.value) throw new Error('USDKY mint account not found');

  const extensions = info.value.data.parsed.info.extensions ?? [];
  const scaled = extensions.find((e) => e.extension === 'scaledUiAmountConfig');
  if (!scaled) {
    throw new Error(
      'scaledUiAmountConfig extension not found on USDKY mint — Phase 3.1 needs to verify the on-chain shape',
    );
  }
  const raw = scaled.state.multiplier;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`unexpected multiplier value type: ${typeof raw}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid multiplier value: ${raw}`);
  }
  return n;
}

// ─── Token accounts (Helius DAS) ─────────────────────────────────────────────

interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: number | string;
  delegated_amount?: number;
  frozen?: boolean;
}

interface DasTokenAccountsResponse {
  total: number;
  limit: number;
  page: number;
  token_accounts: DasTokenAccount[];
}

export async function getAllTokenAccounts(): Promise<DasTokenAccount[]> {
  const all: DasTokenAccount[] = [];
  let page = 1;
  const limit = 1000;
  while (true) {
    const res = await rpc<DasTokenAccountsResponse>('getTokenAccounts', {
      mint: USDKY_MINT,
      page,
      limit,
    });
    all.push(...res.token_accounts);
    if (res.token_accounts.length < limit) break;
    page += 1;
    await sleep(150);
  }
  return all;
}

// ─── Signatures for the mint ─────────────────────────────────────────────────

interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  memo: string | null;
}

export async function getAllSignaturesForMint(opts: {
  until?: string;
  pageSize?: number;
  onProgress?: (count: number) => void;
} = {}): Promise<SignatureEntry[]> {
  const pageSize = opts.pageSize ?? 1000;
  const all: SignatureEntry[] = [];
  let before: string | undefined;
  while (true) {
    const params: [string, Record<string, unknown>] = [
      USDKY_MINT,
      { limit: pageSize, ...(before ? { before } : {}), ...(opts.until ? { until: opts.until } : {}) },
    ];
    const batch = await rpc<SignatureEntry[]>('getSignaturesForAddress', params);
    if (batch.length === 0) break;
    all.push(...batch);
    opts.onProgress?.(all.length);
    if (batch.length < pageSize) break;
    before = batch[batch.length - 1].signature;
    await sleep(150);
  }
  return all;
}

// ─── parseTransaction ────────────────────────────────────────────────────────

export interface ParsedDelta {
  owner: string;
  delta: bigint; // principal delta (base units, i.e. 10^-6 USDKY)
  kind: 'mint' | 'burn' | 'transfer';
}
export interface ParsedTxResult {
  signature: string;
  blockTime: Date | null;
  deltas: ParsedDelta[];
  multiplierUpdate?: {
    multiplier: number;
    blockTime: Date;
  };
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface InnerInstructionEntry {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface GetTransactionResult {
  blockTime: number | null;
  meta?: {
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
    innerInstructions?: Array<{ instructions: InnerInstructionEntry[] }>;
  } | null;
}

export async function parseTransaction(signature: string): Promise<ParsedTxResult> {
  const tx = await rpc<GetTransactionResult | null>('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
  if (!tx) return { signature, blockTime: null, deltas: [] };

  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

  // Aggregate principal deltas by owner across USDKY token balances.
  const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === USDKY_MINT);
  const post = (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === USDKY_MINT);

  type Slot = { owner: string; preAmount: bigint; postAmount: bigint };
  const byIndex = new Map<number, Slot>();
  for (const b of pre) {
    if (!b.owner) continue;
    byIndex.set(b.accountIndex, {
      owner: b.owner,
      preAmount: BigInt(b.uiTokenAmount.amount),
      postAmount: 0n,
    });
  }
  for (const b of post) {
    if (!b.owner) continue;
    const existing = byIndex.get(b.accountIndex);
    if (existing) {
      existing.postAmount = BigInt(b.uiTokenAmount.amount);
    } else {
      byIndex.set(b.accountIndex, {
        owner: b.owner,
        preAmount: 0n,
        postAmount: BigInt(b.uiTokenAmount.amount),
      });
    }
  }

  const byOwner = new Map<string, bigint>();
  for (const slot of byIndex.values()) {
    const delta = slot.postAmount - slot.preAmount;
    byOwner.set(slot.owner, (byOwner.get(slot.owner) ?? 0n) + delta);
  }

  // Classify by sign distribution. Mints have only positive deltas, burns
  // only negative; everything else is a transfer.
  const values = [...byOwner.values()];
  const hasPositive = values.some((d) => d > 0n);
  const hasNegative = values.some((d) => d < 0n);
  let kind: 'mint' | 'burn' | 'transfer';
  if (hasPositive && !hasNegative) kind = 'mint';
  else if (hasNegative && !hasPositive) kind = 'burn';
  else kind = 'transfer';

  const deltas: ParsedDelta[] = [];
  for (const [owner, delta] of byOwner) {
    if (delta === 0n) continue;
    deltas.push({ owner, delta, kind });
  }

  // Multiplier update: inner Token2022 CPI with parsed.type === 'updateMultiplier'.
  let multiplierUpdate: ParsedTxResult['multiplierUpdate'];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (
        ix.programId === TOKEN_2022_PROGRAM_ID &&
        ix.parsed?.type === 'updateMultiplier' &&
        ix.parsed.info
      ) {
        const raw = ix.parsed.info.newMultiplier;
        const m = Number(raw);
        if (Number.isFinite(m) && m > 0 && blockTime) {
          multiplierUpdate = { multiplier: m, blockTime };
        }
      }
    }
  }

  return { signature, blockTime, deltas, multiplierUpdate };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
