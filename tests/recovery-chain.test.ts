import assert from 'node:assert/strict'
import test from 'node:test'
import { bitcoin, toPsbtNetwork } from '@unisat/wallet-bitcoin'
import { NetworkType } from '@unisat/wallet-types'
import { ChainType, OwnerAddressType, type OpenApiUtxo } from '../src/types'
import { assertRecoveryFresh, assertRecoveryOwner, getVerifiedRecoveryFunding, inspectRecoveryOutpoint, verifyRecoveryFunding } from '../src/lib/recovery-chain'
import { loadRecoveryManifestInscription } from '../src/lib/recovery-api'
import { RECOVERED_RECORDS_KEY, getCurrentRecoveredReference, readRecoveredSnapshot, recoveryKey, saveRecoveredReference, updateRecoveredReference, type RecoveryReference } from '../src/lib/recovered-records'
import { buildTimeLockMetadataScript, deriveOwnerAddress, getMetadataLockCondition, type TimeLockMetadata } from '../src/lib/recovery'
import { deriveTimeLockAddress } from '../src/lib/timelock'
import { buildRuneTransferRunestone } from '../src/lib/runestone'
import { PUBLIC_RECOVERY_FORMAT, serializePublicRecoveryManifest } from '../src/lib/recovery-manifest'
import { LEGACY_RECORDS_KEY, RECORDS_V2_KEY } from '../src/lib/records'
import { pubKey, userAddress, scriptPk, runestoneValues } from './core/fixtures'

const chain = ChainType.BITCOIN_MAINNET
const snapshot = { blocks: 120, headers: 120, bestBlockHash: 'ab'.repeat(32), prevBlockHash: 'cd'.repeat(32), medianTime: 1_900_000_000 }
type Routes = Record<string, unknown | (() => Response)>
const balance = { runeid: '100:1', amount: '123', rune: 'SYNTHETIC', spacedRune: 'SYNTHETIC', symbol: 'S', divisibility: 0 }

function fixture(kind: 'brc20' | 'runes' = 'brc20', version: 1 | 2 = 1, ownerAddressType = OwnerAddressType.P2WPKH_EVEN, selectedChain = chain) {
  const metadata: TimeLockMetadata = version === 1
    ? { version, xOnlyPubKey: pubKey.slice(2), lockBlocks: 3, ownerAddressType }
    : { version, xOnlyPubKey: pubKey.slice(2), lockTime: 1_800_000_000, ownerAddressType }
  const address = deriveTimeLockAddress(metadata.xOnlyPubKey, getMetadataLockCondition(metadata), selectedChain)
  const ownerAddress = deriveOwnerAddress(metadata, selectedChain)!
  const network = toPsbtNetwork(selectedChain === ChainType.BITCOIN_MAINNET || selectedChain === ChainType.FRACTAL_BITCOIN_MAINNET ? NetworkType.MAINNET : NetworkType.TESTNET)
  const tx = new bitcoin.Transaction()
  tx.version = 2
  tx.addInput(Buffer.alloc(32, 1), 0)
  const script = Buffer.from(bitcoin.address.toOutputScript(address, network))
  if (kind === 'brc20') {
    tx.addOutput(script, 546)
    tx.addOutput(buildTimeLockMetadataScript(metadata), 0)
  } else {
    tx.addOutput(buildRuneTransferRunestone({ runeId: '100:1', amount: '123', destinationOutput: 1, pointerOutput: 2, recoveryMetadata: metadata }), 0)
    tx.addOutput(script, 330)
    tx.addOutput(Buffer.from(bitcoin.address.toOutputScript(ownerAddress, network)), 330)
  }
  const vout = kind === 'brc20' ? 0 : 1
  return { tx, metadata, address, ownerAddress, chain: selectedChain, txid: tx.getId(), vout, satoshi: tx.outs[vout].value, scriptPk: script.toString('hex') }
}

function routesFor(f: ReturnType<typeof fixture>, ticker = 'test'): Routes {
  const output = { txid: f.txid, vout: f.vout, satoshi: f.satoshi, scriptPk: f.scriptPk, address: f.address, height: 100, isSpent: false, inscriptionsCount: f.vout === 0 ? 1 : 0, inscriptions: f.vout === 0 ? [{ inscriptionId: `${f.txid}i0`, offset: 0, isBRC20: true, moved: false }] : [] }
  return {
    [`/rawtx/${f.txid}`]: f.tx.toHex(),
    '/blockchain/info': { ...snapshot },
    [`/utxo/${f.txid}/${f.vout}`]: output,
    [`/tx/${f.txid}`]: { txid: f.txid, height: 100, confirmations: 21 },
    // Asset indexes may trail the 120 tip while still covering this height-100 output.
    '/runes/status': { bestHeight: 100 },
    [`/runes/utxo/${f.txid}/${f.vout}/balance`]: f.vout === 0 ? [] : [{ ...balance }, { ...balance, runeid: '99:2', amount: '12' }],
    '/brc20/status?start=0&limit=1': { height: 100 },
    [`/inscription/info/${f.txid}i0`]: { inscriptionId: `${f.txid}i0`, offset: 0, height: 100, address: f.address, contentType: 'text/plain;charset=utf-8', contentLength: 64, brc20: { op: 'transfer', tick: ticker, amt: '12.3', decimal: '1' }, utxo: { ...output } },
    [`/brc20/${encodeURIComponent(ticker)}/tx/${f.txid}/history?type=inscribe-transfer&start=0&limit=16`]: { start: 0, total: 1, detail: [{ inscriptionId: `${f.txid}i0`, txid: f.txid, height: 100, valid: true, type: 'inscribe-transfer', amount: '12.3' }] },
  }
}

async function mockApi<T>(routes: Routes, run: (calls: string[], init: RequestInit[]) => Promise<T>): Promise<T> {
  const previous = globalThis.fetch
  const calls: string[] = []
  const inits: RequestInit[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace('/v1/indexer', '') + parsed.search
    calls.push(path); inits.push(init || {})
    assert.ok(Object.prototype.hasOwnProperty.call(routes, path), `Unexpected synthetic request: ${path}`)
    const entry = routes[path]
    return typeof entry === 'function' ? entry() : new Response(JSON.stringify({ code: 0, data: entry }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try { return await run(calls, inits) } finally { globalThis.fetch = previous }
}

test('recovery rederives CSV/CLTV BRC/Rune locks and all owner descriptors from raw tx', async () => {
  for (const kind of ['brc20', 'runes'] as const) for (const version of [1, 2] as const) for (const descriptor of [OwnerAddressType.P2WPKH_EVEN, OwnerAddressType.P2WPKH_ODD, OwnerAddressType.P2TR]) {
    const f = fixture(kind, version, descriptor)
    await mockApi(routesFor(f), async (_calls, inits) => {
      const result = await inspectRecoveryOutpoint({ chain, txid: f.txid })
      assert.equal(result.verification, 'verified', result.reason)
      assert.equal(result.ownerAddress, f.ownerAddress)
      assert.equal(result.timeLockAddress, f.address)
      assert.deepEqual(result.metadata, f.metadata)
      assert.equal(result.confirmations, 21)
      assertRecoveryFresh(result)
      assertRecoveryOwner(result, f.ownerAddress, (descriptor === OwnerAddressType.P2WPKH_ODD ? '03' : '02') + pubKey.slice(2), chain)
      if (descriptor === OwnerAddressType.P2TR) assertRecoveryOwner(result, f.ownerAddress, '03' + pubKey.slice(2), chain)
      if (result.assets?.kind === 'runes') assert.equal(result.assets.balances.length, 2)
      assert.ok(inits.every((init) => init.cache === 'no-store' && init.redirect === 'error' && !!init.signal))
      assert.throws(() => assertRecoveryOwner(result, f.ownerAddress, pubKey.slice(2), chain), /compressed/)
      assert.throws(() => assertRecoveryOwner(result, f.ownerAddress, pubKey, ChainType.BITCOIN_SIGNET), /network/)
      assert.throws(() => assertRecoveryFresh({ ...result, checkedAt: Date.now() - 60_001 }), /stale/)
    })
  }
})

test('raw-only import performs just one request and grants no asset verification', async () => {
  const f = fixture()
  await mockApi(routesFor(f), async (calls) => {
    const result = await inspectRecoveryOutpoint({ chain, txid: f.txid, vout: 0, verifyAssets: false })
    assert.equal(result.verification, 'unknown')
    assert.equal(result.assets, undefined)
    assert.deepEqual(calls, [`/rawtx/${f.txid}`])
    assert.throws(() => assertRecoveryFresh(result), /not verified/)
    assert.throws(() => assertRecoveryOwner(result, userAddress, '03' + pubKey.slice(2), chain), /match|owner/)
  })
})

test('raw identity, known chain and actual output positions/scripts are mandatory', async () => {
  const f = fixture()
  await mockApi(routesFor(f), async (calls) => {
    await assert.rejects(inspectRecoveryOutpoint({ chain: 'unknown', txid: f.txid }), /known/)
    await assert.rejects(inspectRecoveryOutpoint({ chain, txid: '../wrong' }), /transaction ID/)
    assert.equal(calls.length, 0)
    await assert.rejects(inspectRecoveryOutpoint({ chain, txid: f.txid, vout: 1 }), /positions/)
  })
  for (const mutate of [
    (tx: bitcoin.Transaction) => { tx.outs[0].script = Buffer.from(scriptPk, 'hex') },
    (tx: bitcoin.Transaction) => { tx.addOutput(tx.outs[0].script, 546) },
    (tx: bitcoin.Transaction) => { tx.addOutput(tx.outs[1].script, 0) },
    (tx: bitcoin.Transaction) => { tx.outs[1].script = Buffer.from('6a', 'hex') },
    (tx: bitcoin.Transaction) => { tx.outs[1].value = 1 },
    (tx: bitcoin.Transaction) => { tx.outs[0].value = 545 },
  ]) {
    const changed = fixture(); mutate(changed.tx)
    await mockApi({ [`/rawtx/${changed.tx.getId()}`]: changed.tx.toHex() }, async () => {
      await assert.rejects(inspectRecoveryOutpoint({ chain, txid: changed.tx.getId() }), /BATL|output/)
    })
  }
  await mockApi({ [`/rawtx/${f.txid}`]: fixture('runes').tx.toHex() }, async () => {
    await assert.rejects(inspectRecoveryOutpoint({ chain, txid: f.txid }), /ID does not match/)
  })
  await mockApi({ [`/rawtx/${f.txid}`]: 'bad-hex' }, async () => {
    await assert.rejects(inspectRecoveryOutpoint({ chain, txid: f.txid }), /malformed/)
  })
})

function encodeRuneValues(values: bigint[]): Buffer {
  const bytes: number[] = []
  for (let value of values) {
    do { let byte = Number(value & 127n); value >>= 7n; if (value) byte |= 128; bytes.push(byte) } while (value)
  }
  return Buffer.from(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, bitcoin.opcodes.OP_13, Buffer.from(bytes)]))
}

test('duplicate Runestone metadata and corrupt or unsupported layouts are rejected', async () => {
  for (const mutate of [
    (values: bigint[]) => [...values.slice(0, 12), ...values],
    (values: bigint[]) => { values[3] = 3n; return values },
    (values: bigint[]) => { values[values.length - 1] = 2n; return values },
    (values: bigint[]) => values.slice(0, -1),
  ]) {
    const f = fixture('runes')
    f.tx.outs[0].script = encodeRuneValues(mutate(runestoneValues(Buffer.from(f.tx.outs[0].script))))
    const txid = f.tx.getId()
    await mockApi({ [`/rawtx/${txid}`]: f.tx.toHex() }, async () => {
      await assert.rejects(inspectRecoveryOutpoint({ chain, txid }), /BATL|Runestone/)
    })
  }
})

test('spent/null and incomplete/stale/mixed asset evidence cannot unlock', async () => {
  const f = fixture()
  const outputPath = `/utxo/${f.txid}/0`
  const base = routesFor(f)
  const output = base[outputPath] as Record<string, unknown>
  const changes: Array<[string, unknown, 'unknown' | 'spent']> = [
    [outputPath, null, 'spent'],
    [outputPath, { ...output, isSpent: true }, 'spent'],
    [outputPath, { ...output, isSpending: true }, 'spent'],
    [outputPath, { ...output, isSpent: undefined }, 'unknown'],
    [outputPath, { ...output, scriptPk }, 'unknown'],
    [outputPath, { ...output, satoshi: 547 }, 'unknown'],
    [outputPath, { ...output, inscriptions: undefined }, 'unknown'],
    [outputPath, { ...output, inscriptions: [] }, 'unknown'],
    ['/runes/status', { bestHeight: 99 }, 'unknown'],
    [`/runes/utxo/${f.txid}/0/balance`, null, 'unknown'],
    [`/runes/utxo/${f.txid}/0/balance`, [balance], 'unknown'],
    ['/brc20/status?start=0&limit=1', { height: 99 }, 'unknown'],
  ]
  for (const [path, value, status] of changes) await mockApi({ ...base, [path]: value }, async () => {
    const result = await inspectRecoveryOutpoint({ chain, txid: f.txid })
    assert.equal(result.verification, status, String(result.reason))
    assert.equal(result.assets, undefined)
    assert.throws(() => assertRecoveryFresh(result))
  })
  await mockApi({ ...base, '/runes/status': () => new Response(JSON.stringify({ code: 0, data: { bestHeight: 120 } }), { headers: { age: '61' } }) }, async () => {
    assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown')
  })
})

test('confirmation count is not required to equal a separately fetched chain-tip formula', async () => {
  const f = fixture()
  const base = routesFor(f)
  const path = `/tx/${f.txid}`
  for (const confirmations of [1, 20, 21, 22]) {
    await mockApi({ ...base, [path]: { txid: f.txid, height: 100, confirmations } }, async () => {
      const result = await inspectRecoveryOutpoint({ chain, txid: f.txid })
      assert.equal(result.verification, 'verified', result.reason)
      assert.equal(result.confirmations, 21, 'displayed confirmations come from the one validated chain snapshot')
    })
  }
  for (const summary of [
    { txid: f.txid, height: 100, confirmations: 0 },
    { txid: f.txid, height: 100, confirmations: -1 },
    { txid: f.txid, height: 100, confirmations: 1.5 },
    { txid: f.txid, height: 100, confirmations: '21' },
    { txid: f.txid, height: 99, confirmations: 22 },
  ]) {
    await mockApi({ ...base, [path]: summary }, async () => {
      assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown')
    })
  }
})

test('Rune state requires every positive balance and no inscriptions', async () => {
  const f = fixture('runes')
  const base = routesFor(f)
  for (const invalid of [[], null, [{ ...balance, amount: '0' }], [{ ...balance, divisibility: undefined }], [balance, balance]]) {
    await mockApi({ ...base, [`/runes/utxo/${f.txid}/1/balance`]: invalid }, async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
  }
  const row = base[`/utxo/${f.txid}/1`] as Record<string, unknown>
  await mockApi({ ...base, [`/utxo/${f.txid}/1`]: { ...row, inscriptionsCount: 1, inscriptions: [{ inscriptionId: `${f.txid}i0` }] } }, async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
  await mockApi({ ...base, '/runes/status': { bestHeight: 99 } }, async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
})

test('BRC verification binds current outpoint, genesis ID, operation and history', async () => {
  const f = fixture()
  const base = routesFor(f)
  const infoPath = `/inscription/info/${f.txid}i0`
  const info = base[infoPath] as Record<string, unknown>
  for (const patch of [
    { inscriptionId: 'ff'.repeat(32) + 'i0' }, { offset: 1 }, { utxo: { ...(info.utxo as object), vout: 1 } },
    { hasDeligate: true }, { hasContentEncoding: true }, { contentType: 'text/html' },
    { brc20: { op: 'mint', tick: 'test', amt: '12.3', decimal: '1' } },
    { brc20: { op: 'transfer', tick: 'test', amt: '0', decimal: '1' } },
  ]) await mockApi({ ...base, [infoPath]: { ...info, ...patch } }, async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
  const historyPath = `/brc20/test/tx/${f.txid}/history?type=inscribe-transfer&start=0&limit=16`
  const history = base[historyPath] as { detail: Array<Record<string, unknown>> }
  for (const patch of [{ valid: false }, { inscriptionId: 'ff'.repeat(32) + 'i0' }, { txid: 'ff'.repeat(32) }, { amount: '12.4' }, { height: 99 }]) await mockApi({ ...base, [historyPath]: { start: 0, total: 1, detail: [{ ...history.detail[0], ...patch }] } }, async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
})

test('Fractal 6/12-character Classic tickers work; Bitcoin 6-byte Prog does not', async () => {
  for (const ticker of ['foobar', 'abcdefghijkl']) {
    const f = fixture('brc20', 2, OwnerAddressType.P2TR, ChainType.FRACTAL_BITCOIN_MAINNET)
    await mockApi(routesFor(f, ticker), async () => {
      const result = await inspectRecoveryOutpoint({ chain: f.chain, txid: f.txid })
      assert.equal(result.verification, 'verified', result.reason)
      assert.equal(result.assets?.kind === 'brc20' && result.assets.ticker, ticker)
    })
  }
  const f = fixture()
  await mockApi(routesFor(f, 'foobar'), async () => assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown'))
})

function fundingFixture(seed: number): OpenApiUtxo & { raw: string } {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, seed), 0)
  tx.addOutput(Buffer.from(scriptPk, 'hex'), 100_000)
  return { txid: tx.getId(), vout: 0, satoshi: 100_000, scriptPk, address: userAddress, raw: tx.toHex(), isSpent: false }
}
function fundingRoutes(candidates: ReturnType<typeof fundingFixture>[]): Routes {
  const routes: Routes = {
    [`/address/${userAddress}/available-utxo-data?cursor=0&size=6`]: { utxo: candidates.map(({ raw: _raw, ...candidate }) => candidate) },
    '/blockchain/info': snapshot, '/runes/status': { bestHeight: 100 },
  }
  for (const candidate of candidates) {
    routes[`/rawtx/${candidate.txid}`] = candidate.raw
    routes[`/utxo/${candidate.txid}/0`] = { ...candidate, height: 100, isSpent: false, inscriptionsCount: 0, inscriptions: [] }
    routes[`/tx/${candidate.txid}`] = { txid: candidate.txid, height: 100, confirmations: 21 }
    routes[`/runes/utxo/${candidate.txid}/0/balance`] = []
  }
  return routes
}

test('funding is bounded, exact, confirmed and excludes the lock input', async () => {
  const candidates = Array.from({ length: 7 }, (_, index) => fundingFixture(index + 1))
  await mockApi(fundingRoutes(candidates), async (calls) => {
    const result = await getVerifiedRecoveryFunding(userAddress, pubKey, chain, undefined, candidates[0])
    assert.equal(result.length, 5)
    assert.ok(!calls.includes(`/rawtx/${candidates[0].txid}`))
    assert.ok(!calls.includes(`/rawtx/${candidates[6].txid}`))
    assert.ok(result.every((row) => row.isSpent === false && row.isSpending === false && row.height === 100))
    assert.equal((await verifyRecoveryFunding(result, userAddress, pubKey, chain)).length, 5)
    await assert.rejects(verifyRecoveryFunding([result[0], result[0]], userAddress, pubKey, chain), /duplicate/)
    await assert.rejects(verifyRecoveryFunding(result, userAddress, pubKey, chain, undefined, result[0]), /locked/)
  })
})

test('funding rejects unknown Rune/inscription state and stops on HTTP limits', async () => {
  const first = fundingFixture(1), second = fundingFixture(2)
  const routes = fundingRoutes([first, second])
  await mockApi({ ...routes, [`/runes/utxo/${first.txid}/0/balance`]: null }, async () => {
    const result = await getVerifiedRecoveryFunding(userAddress, pubKey, chain)
    assert.deepEqual(result.map((row) => row.txid), [second.txid])
    await assert.rejects(verifyRecoveryFunding([first], userAddress, pubKey, chain), /unknown/)
  })
  await mockApi({ ...routes, '/runes/status': { bestHeight: 99 } }, async () => {
    await assert.rejects(verifyRecoveryFunding([first], userAddress, pubKey, chain), /height|indexer/i)
  })
  for (const patch of [{ inscriptions: undefined }, { inscriptions: [{ inscriptionId: 'synthetic' }] }, { isSpent: undefined }, { isSpending: true }, { scriptPk: '00' }, { height: 0 }]) {
    const row = routes[`/utxo/${first.txid}/0`] as Record<string, unknown>
    await mockApi({ ...routes, [`/utxo/${first.txid}/0`]: { ...row, ...patch } }, async () => await assert.rejects(verifyRecoveryFunding([first], userAddress, pubKey, chain)))
  }
  await mockApi({ ...routes, [`/rawtx/${first.txid}`]: () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) }, async (calls) => {
    await assert.rejects(getVerifiedRecoveryFunding(userAddress, pubKey, chain), /HTTP 429/)
    assert.ok(!calls.includes(`/rawtx/${second.txid}`))
  })
})

const manifestId = 'ef'.repeat(32) + 'i0'
function manifestFixture(): { text: string; routes: Routes } {
  const text = serializePublicRecoveryManifest({ format: PUBLIC_RECOVERY_FORMAT, version: 1, chain, outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }] })
  return { text, routes: {
    [`/inscription/info/${manifestId}`]: { inscriptionId: manifestId, contentType: 'application/json', contentLength: Buffer.byteLength(text), address: 'another-owner-is-allowed' },
    [`/inscription/content/${manifestId}`]: () => new Response(text),
  } }
}
test('public inscription reads bounded raw text, not envelope, and ignores directory NFT owner', async () => {
  const f = manifestFixture()
  await mockApi(f.routes, async (calls, inits) => {
    const result = await loadRecoveryManifestInscription(manifestId, chain)
    assert.equal(result.outpoints.length, 1)
    assert.equal(calls.length, 2)
    assert.ok(inits.every((init) => init.cache === 'no-store' && init.redirect === 'error'))
  })
})
test('public inscription rejects oversized, encoded, delegated, mismatched and malformed content', async () => {
  const f = manifestFixture()
  const infoPath = `/inscription/info/${manifestId}`
  const info = f.routes[infoPath] as Record<string, unknown>
  for (const patch of [{ contentType: 'text/html' }, { hasDeligate: true }, { deligate: 'other-id' }, { hasContentEncoding: true }, { contentLength: 4097 }, { inscriptionId: 'different' }]) {
    await mockApi({ ...f.routes, [infoPath]: { ...info, ...patch } }, async (calls) => {
      await assert.rejects(loadRecoveryManifestInscription(manifestId, chain))
      assert.equal(calls.length, 1)
    })
  }
  for (const content of [new Response('x'.repeat(4097)), new Response(f.text, { headers: { 'content-length': '4097' } }), new Response('{bad'), new Response(f.text.replace(chain, ChainType.BITCOIN_SIGNET)), new Response(f.text.replace('"version":1', '"version":2'))]) {
    await mockApi({ ...f.routes, [`/inscription/content/${manifestId}`]: () => content }, async () => await assert.rejects(loadRecoveryManifestInscription(manifestId, chain)))
  }
  await mockApi(f.routes, async (calls) => {
    await assert.rejects(loadRecoveryManifestInscription('http://untrusted.example', chain), /inscription ID/)
    await assert.rejects(loadRecoveryManifestInscription(manifestId, 'unknown'), /known/)
    assert.equal(calls.length, 0)
  })
})

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}
const reference: RecoveryReference = { schemaVersion: 1, chain, txid: 'ab'.repeat(32), vout: 0, lockKind: 'csv_blocks', source: 'manifest', restoredAt: 1_000 }

test('recovered references persist only public whitelist in separate namespace', () => {
  const storage = new MemoryStorage()
  storage.setItem(LEGACY_RECORDS_KEY, 'unchanged legacy bytes')
  storage.setItem(RECORDS_V2_KEY, 'unchanged v2 bytes')
  const [saved] = saveRecoveredReference({ ...reference, txid: reference.txid.toUpperCase() }, storage)
  assert.deepEqual(saved, reference)
  assert.equal(recoveryKey(chain, reference.txid.toUpperCase(), 0), `${chain}:${reference.txid}:0`)
  assert.deepEqual(readRecoveredSnapshot(storage), { records: [reference], errors: [] })
  assert.equal(saveRecoveredReference({ ...reference, restoredAt: 2_000 }, storage).length, 1)
  assert.deepEqual(getCurrentRecoveredReference(reference, storage), reference)
  const [updated] = updateRecoveredReference(reference, { unlockTxid: 'CD'.repeat(32) }, storage)
  assert.equal(updated.unlockTxid, 'cd'.repeat(32))
  assert.throws(() => updateRecoveredReference(reference, { unlockTxid: 'ef'.repeat(32) }, storage), /changed/)
  assert.equal(storage.getItem(LEGACY_RECORDS_KEY), 'unchanged legacy bytes')
  assert.equal(storage.getItem(RECORDS_V2_KEY), 'unchanged v2 bytes')
})

test('strict reference validation preserves malformed namespace and rejects non-public fields', () => {
  const storage = new MemoryStorage()
  for (const invalid of [{ ...reference, privateData: 'not-allowed' }, { ...reference, chain: 'unknown' }, { ...reference, vout: -1 }, { ...reference, source: 'wallet' }, { ...reference, schemaVersion: 2 }, { ...reference, unlockTxid: undefined }, { ...reference, restoredAt: NaN }]) assert.throws(() => saveRecoveredReference(invalid as RecoveryReference, storage))
  for (const raw of ['{bad', '{}', JSON.stringify([reference, reference]), JSON.stringify([{ ...reference, unexpected: true }])]) {
    storage.setItem(RECOVERED_RECORDS_KEY, raw)
    assert.equal(readRecoveredSnapshot(storage).errors.length, 1)
    assert.throws(() => saveRecoveredReference(reference, storage))
    assert.equal(storage.getItem(RECOVERED_RECORDS_KEY), raw)
  }
})

test('recovered namespace compare-before-write blocks stale tab overwrite', () => {
  const storage = new MemoryStorage()
  let reads = 0
  const concurrent = { getItem(key: string) { reads += 1; if (reads === 2) storage.setItem(key, JSON.stringify([{ ...reference, txid: 'ef'.repeat(32) }])); return storage.getItem(key) }, setItem: storage.setItem.bind(storage) }
  assert.throws(() => saveRecoveredReference(reference, concurrent), /changed in another tab/)
  assert.equal(readRecoveredSnapshot(storage).records[0].txid, 'ef'.repeat(32))
})

test('denied default browser storage returns an error snapshot without evaluating outside try', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied') } })
  try { assert.equal(readRecoveredSnapshot().errors.length, 1) }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('public content streaming enforces UTF-8 and byte cap before JSON parsing', async () => {
  const f = manifestFixture()
  let cancelled = false
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(1)) },
    cancel() { cancelled = true },
  })
  await mockApi({ ...f.routes, [`/inscription/content/${manifestId}`]: () => new Response(oversized) }, async () => {
    await assert.rejects(loadRecoveryManifestInscription(manifestId, chain), /size/)
    assert.equal(cancelled, true)
  })
  await mockApi({ ...f.routes, [`/inscription/content/${manifestId}`]: () => new Response(new Uint8Array([0xff])) }, async () => {
    await assert.rejects(loadRecoveryManifestInscription(manifestId, chain), /failed/)
  })
})

test('funding verifies P2TR wallet script with the supplied full key and rejects low-fee/spending candidates', async () => {
  const owner = deriveOwnerAddress({ version: 1, lockBlocks: 3, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2TR }, chain)!
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 4), 0)
  const script = Buffer.from(bitcoin.address.toOutputScript(owner)).toString('hex')
  tx.addOutput(Buffer.from(script, 'hex'), 100_000)
  const candidate = { txid: tx.getId(), vout: 0, satoshi: 100_000, scriptPk: script, address: owner, isSpent: false }
  const routes: Routes = {
    '/blockchain/info': snapshot, '/runes/status': { bestHeight: 120 },
    [`/rawtx/${candidate.txid}`]: tx.toHex(),
    [`/tx/${candidate.txid}`]: { txid: candidate.txid, height: 100, confirmations: 21 },
    [`/utxo/${candidate.txid}/0`]: { ...candidate, height: 100, inscriptionsCount: 0, inscriptions: [] },
    [`/runes/utxo/${candidate.txid}/0/balance`]: [],
  }
  await mockApi(routes, async () => {
    assert.equal((await verifyRecoveryFunding([candidate], owner, '03' + pubKey.slice(2), chain)).length, 1)
    for (const patch of [{ isLowFee: true }, { isSpending: true }]) await assert.rejects(verifyRecoveryFunding([{ ...candidate, ...patch }], owner, pubKey, chain), /candidate/)
  })
})

test('filtered or missing inscription counts never establish a complete asset inventory', async () => {
  for (const kind of ['brc20', 'runes'] as const) {
    const f = fixture(kind)
    const base = routesFor(f)
    const path = `/utxo/${f.txid}/${f.vout}`
    const row = base[path] as Record<string, unknown>
    const count = kind === 'brc20' ? 1 : 0
    for (const inscriptionsCount of [undefined, null, -1, 0.5, String(count), count + 1, Number.MAX_SAFE_INTEGER + 1]) {
      await mockApi({ ...base, [path]: { ...row, inscriptionsCount } }, async () => {
        const result = await inspectRecoveryOutpoint({ chain, txid: f.txid })
        assert.equal(result.verification, 'unknown')
        assert.match(result.reason!, /inscription/i)
      })
    }
    await mockApi({ ...base, [path]: { ...row, inscriptionsCount: 1, inscriptions: [] } }, async () => {
      assert.equal((await inspectRecoveryOutpoint({ chain, txid: f.txid })).verification, 'unknown')
    })
  }
  const candidate = fundingFixture(1)
  const base = fundingRoutes([candidate])
  const path = `/utxo/${candidate.txid}/0`
  for (const inscriptionsCount of [undefined, null, -1, 0.5, '0', 1]) {
    await mockApi({ ...base, [path]: { ...(base[path] as object), inscriptionsCount } }, async () => {
      await assert.rejects(verifyRecoveryFunding([candidate], userAddress, pubKey, chain), /inscription/i)
    })
  }
})

test('the first funding-list request is bounded and never echoes remote error content', async () => {
  const candidate = fundingFixture(1)
  await mockApi(fundingRoutes([candidate]), async (_calls, inits) => {
    assert.equal((await getVerifiedRecoveryFunding(userAddress, pubKey, chain)).length, 1)
    assert.ok(inits.every((init) => init.cache === 'no-store' && init.redirect === 'error' && !!init.signal))
  })
  const path = `/address/${userAddress}/available-utxo-data?cursor=0&size=6`
  const syntheticPrivateError = 'SYNTHETIC_DO_NOT_ECHO_RESPONSE'
  for (const response of [
    () => new Response(syntheticPrivateError, { status: 403 }),
    () => new Response(syntheticPrivateError),
    () => new Response(JSON.stringify({ code: -1, msg: syntheticPrivateError, data: null })),
    () => new Response('', { status: 302, headers: { location: 'https://example.invalid/never-followed' } }),
    () => new Response('{}', { headers: { 'content-length': '262145' } }),
  ]) {
    await mockApi({ [path]: response }, async (calls, inits) => {
      await assert.rejects(getVerifiedRecoveryFunding(userAddress, pubKey, chain), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes(syntheticPrivateError))
        return true
      })
      assert.deepEqual(calls, [path], 'a failed first request must stop the whole operation')
      assert.equal(inits[0].redirect, 'error')
      assert.equal(inits[0].cache, 'no-store')
      assert.ok(inits[0].signal)
    })
  }
})
