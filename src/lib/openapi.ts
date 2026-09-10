import { ChainType } from '../types'
import type { AddressBalance, OpenApiUtxo, RuneIndexerBalance, RuneIndexerEntry, RuneIndexerUtxo } from '../types'
import { CLTV_MAX_CREATABLE_TIMESTAMP } from './lock-condition'

export const CHAIN_SNAPSHOT_TTL_MS = 60_000
export type BlockchainInfo = {
  requestedChain: ChainType
  chain?: string
  blocks: number
  headers: number
  bestBlockHash: string
  prevBlockHash: string
  medianTime: number
  chainwork?: string
  checkedAt: number
}

export function requireKnownChain(chain?: ChainType | string): ChainType {
  if (!Object.values(ChainType).includes(chain as ChainType)) throw new Error('Select a known wallet network before checking chain time.')
  return chain as ChainType
}

/** Official chain is an unspecified string, not a documented ChainType enum.
 * Network binding is the explicitly selected endpoint + requestedChain, not that string.
 */
export function parseBlockchainInfo(data: unknown, chain: ChainType | string, checkedAt = Date.now()): BlockchainInfo {
  const requestedChain = requireKnownChain(chain)
  if (!data || typeof data !== 'object') throw new Error('OpenAPI returned no blockchain information.')
  const value = data as Record<string, unknown>
  for (const field of ['blocks', 'headers']) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new Error(`OpenAPI returned invalid ${field}.`)
  }
  if (typeof value.medianTime !== 'number' || !Number.isInteger(value.medianTime) || value.medianTime < 500_000_000 || value.medianTime > 0xffff_ffff) throw new Error('OpenAPI returned invalid medianTime (Unix seconds required).')
  for (const field of ['bestBlockHash', 'prevBlockHash']) {
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{64}$/i.test(value[field] as string)) throw new Error(`OpenAPI returned invalid ${field}.`)
  }
  // The API declares these ancillary fields as optional strings, without a format.
  // Neither is a network proof or part of the CLTV maturity decision.
  for (const field of ['chain', 'chainwork']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`OpenAPI returned invalid ${field} (string required when present).`)
  }
  return { requestedChain, chain: value.chain as string | undefined, blocks: value.blocks as number, headers: value.headers as number, bestBlockHash: value.bestBlockHash as string, prevBlockHash: value.prevBlockHash as string, medianTime: value.medianTime, chainwork: value.chainwork as string | undefined, checkedAt }
}

export function isCltvMature(info: BlockchainInfo, timestamp: number, chain: ChainType | string, now = Date.now()): boolean {
  if (info.requestedChain !== requireKnownChain(chain) || !Number.isFinite(info.checkedAt) || now < info.checkedAt || now - info.checkedAt > CHAIN_SNAPSHOT_TTL_MS) throw new Error('Chain-time check is stale or belongs to another network. Refresh chain time.')
  if (!Number.isInteger(timestamp) || timestamp < 500_000_000 || timestamp > 0xffff_ffff) throw new Error('Invalid fixed lock date.')
  if (timestamp > CLTV_MAX_CREATABLE_TIMESTAMP) throw new Error('This fixed date cannot confirm an unlock under current timestamp rules. The saved condition has not been changed.')
  return info.medianTime > timestamp
}

const DEFAULT_OPENAPI_BASES: Record<ChainType, string> = {
  BITCOIN_MAINNET: 'https://open-api.unisat.io/v1/indexer',
  BITCOIN_TESTNET4: 'https://open-api-testnet4.unisat.io/v1/indexer',
  BITCOIN_SIGNET: 'https://open-api-signet.unisat.io/v1/indexer',
  FRACTAL_BITCOIN_MAINNET: 'https://open-api-fractal.unisat.io/v1/indexer',
  FRACTAL_BITCOIN_TESTNET: 'https://open-api-fractal-testnet.unisat.io/v1/indexer',
}

function normalizeChain(chain?: ChainType | string): ChainType {
  const value = String(chain || '') as ChainType
  return value in DEFAULT_OPENAPI_BASES ? value : ChainType.BITCOIN_MAINNET
}

export function getOpenApiBase(chain?: ChainType | string): string {
  const selected = normalizeChain(chain)
  const configuredByChain: Partial<Record<ChainType, string | undefined>> = {
    BITCOIN_MAINNET: (import.meta.env?.VITE_BITCOIN_OPENAPI_BASE as string | undefined)?.trim(),
    BITCOIN_TESTNET4: (import.meta.env?.VITE_BITCOIN_TESTNET4_OPENAPI_BASE as string | undefined)?.trim(),
    BITCOIN_SIGNET: (import.meta.env?.VITE_BITCOIN_SIGNET_OPENAPI_BASE as string | undefined)?.trim(),
    FRACTAL_BITCOIN_MAINNET: (import.meta.env?.VITE_FRACTAL_OPENAPI_BASE as string | undefined)?.trim() || (import.meta.env?.VITE_OPENAPI_BASE as string | undefined)?.trim(),
    FRACTAL_BITCOIN_TESTNET: (import.meta.env?.VITE_FRACTAL_TESTNET_OPENAPI_BASE as string | undefined)?.trim(),
  }
  return (configuredByChain[selected] || DEFAULT_OPENAPI_BASES[selected]).replace(/\/+$/, '')
}

type Envelope<T> = {
  code: number
  msg?: string
  data: T
}

function buildHeaders(apiKey?: string): HeadersInit {
  const headers: Record<string, string> = { accept: 'application/json' }
  const token = apiKey?.trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function requestOpenApi<T>(path: string, apiKey?: string, chain?: ChainType | string, fresh = false): Promise<T> {
  const startedAt = Date.now()
  const response = await fetch(`${getOpenApiBase(chain)}${path}`, {
    headers: buildHeaders(apiKey),
    ...(fresh ? { cache: 'no-store' as const, signal: AbortSignal.timeout(15_000) } : {}),
  })
  if (fresh && (Date.now() - startedAt > CHAIN_SNAPSHOT_TTL_MS || Number(response.headers.get('age') || 0) > CHAIN_SNAPSHOT_TTL_MS / 1000)) throw new Error('OpenAPI chain-time response is stale. Refresh and retry.')
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`OpenAPI HTTP ${response.status}: ${text || response.statusText}`)
  }

  let json: Envelope<T>
  try {
    json = JSON.parse(text) as Envelope<T>
  } catch {
    throw new Error(`OpenAPI returned non-JSON data: ${text.slice(0, 160)}`)
  }

  if (json.code !== 0) {
    throw new Error(json.msg || `OpenAPI error code=${json.code}`)
  }
  return json.data
}

export async function getAddressBalance(address: string, apiKey?: string, chain?: ChainType | string): Promise<AddressBalance> {
  return requestOpenApi<AddressBalance>(`/address/${encodeURIComponent(address)}/balance`, apiKey, chain)
}

export type Brc20Balance = {
  ticker: string
  availableBalance: string
}

type Brc20Summary = {
  total?: number
  detail?: Brc20Balance[]
}

type RuneBalanceList = {
  total?: number
  detail?: RuneIndexerBalance[]
}

export async function getAddressBrc20Balances(address: string, apiKey?: string, chain?: ChainType | string): Promise<Brc20Balance[]> {
  const limit = 100
  const balances: Brc20Balance[] = []
  for (let start = 0; ; start += limit) {
    const data = await requestOpenApi<Brc20Summary>(
      `/address/${encodeURIComponent(address)}/brc20/summary?start=${start}&limit=${limit}&tick_filter=24&exclude_zero=true`,
      apiKey,
      chain,
    )
    const page = Array.isArray(data.detail) ? data.detail : []
    balances.push(...page)
    if (page.length < limit || start + page.length >= (data.total || 0)) return balances
  }
}

/** Returns the address's confirmed BRC-20 available balance for a ticker. */
export async function getBrc20AvailableBalance(address: string, ticker: string, apiKey?: string, chain?: ChainType | string): Promise<string> {
  const balance = (await getAddressBrc20Balances(address, apiKey, chain))
    .find((item) => item.ticker === ticker)
  return balance?.availableBalance || "0"
}

/** Returns every Rune with a positive indexed balance at an address. */
export async function getAddressRuneBalances(address: string, apiKey?: string, chain?: ChainType | string): Promise<RuneIndexerBalance[]> {
  const limit = 100
  const balances: RuneIndexerBalance[] = []
  for (let start = 0; ; start += limit) {
    const data = await requestOpenApi<RuneBalanceList>(
      `/address/${encodeURIComponent(address)}/runes/balance-list?start=${start}&limit=${limit}`,
      apiKey,
      chain,
    )
    const page = Array.isArray(data.detail) ? data.detail : []
    balances.push(...page)
    if (page.length < limit || start + page.length >= (data.total || 0)) return balances
  }
}

export async function getAvailableUtxos(address: string, apiKey?: string, size = 500, chain?: ChainType | string): Promise<OpenApiUtxo[]> {
  const data = await requestOpenApi<{ utxo?: OpenApiUtxo[] }>(
    `/address/${encodeURIComponent(address)}/available-utxo-data?cursor=0&size=${size}`,
    apiKey, chain,
  )
  return Array.isArray(data.utxo) ? data.utxo : []
}

export async function getBlockchainHeight(apiKey?: string, chain?: ChainType | string): Promise<number> {
  const data = await requestOpenApi<{ blocks?: number; height?: number }>('/blockchain/info', apiKey, chain)
  const height = data.blocks ?? data.height
  if (!Number.isInteger(height) || (height as number) < 0) {
    throw new Error('OpenAPI returned an invalid blockchain height.')
  }
  return height as number
}

export async function getBlockchainInfo(apiKey: string | undefined, chain: ChainType | string): Promise<BlockchainInfo> {
  const requestedChain = requireKnownChain(chain)
  const data = await requestOpenApi<unknown>('/blockchain/info', apiKey, requestedChain, true)
  return parseBlockchainInfo(data, requestedChain)
}

export async function getRuneMetadata(reference: string, apiKey?: string, chain?: ChainType | string): Promise<RuneIndexerEntry> {
  const query = reference.trim()
  if (!query) throw new Error('Enter a Rune name or Rune ID.')
  if (/^\d+:\d+$/.test(query)) {
    return requestOpenApi<RuneIndexerEntry>(`/runes/${encodeURIComponent(query)}/info`, apiKey, chain)
  }
  const data = await requestOpenApi<{ detail?: RuneIndexerEntry[] }>(`/runes/info-list?rune=${encodeURIComponent(query)}&start=0&limit=20`, apiKey, chain)
  const entry = data.detail?.find((item) => item.rune === query || item.spacedRune === query)
  if (!entry) throw new Error(`No exact Rune named “${query}” was found on the connected network.`)
  return entry
}

export async function getAddressRuneUtxos(address: string, runeId: string, apiKey?: string, chain?: ChainType | string): Promise<RuneIndexerUtxo[]> {
  const data = await requestOpenApi<{ utxo?: RuneIndexerUtxo[] }>(
    `/address/${encodeURIComponent(address)}/runes/${encodeURIComponent(runeId)}/utxo?start=0&limit=500`,
    apiKey,
    chain,
  )
  return Array.isArray(data.utxo) ? data.utxo : []
}

export async function getRuneUtxoBalances(txid: string, vout: number, apiKey?: string, chain?: ChainType | string): Promise<RuneIndexerBalance[]> {
  return requestOpenApi<RuneIndexerBalance[]>(`/runes/utxo/${encodeURIComponent(txid)}/${vout}/balance`, apiKey, chain)
}
