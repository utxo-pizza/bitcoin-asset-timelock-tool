import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUtcLockDate, formatUtc, formatUtcDateInput, requireFutureDate } from '../src/lib/lock-date'
import { createStoredRecord, getCurrentRecord, readRecords, updateStoredRecord, LEGACY_RECORDS_KEY, RECORDS_V2_KEY } from '../src/lib/records'
import { CHAIN_SNAPSHOT_TTL_MS, getBlockchainInfo, isCltvMature, parseBlockchainInfo } from '../src/lib/openapi'
import { createOperationGate, freezeOperationIdentity, signPsbtCompat, signPsbtsCompat, watchOperationIdentity } from '../src/lib/wallet'
import { ChainType, type LegacyTimeLockRecord, type UnisatWallet, type Version2TimeLockRecord } from '../src/types'
import { pubKey, userAddress, csvGolden } from './core/fixtures'

const chain = ChainType.BITCOIN_MAINNET
const timestamp = 2_208_988_800
const lock = { kind: 'cltv_time' as const, timestamp }
const legacy: LegacyTimeLockRecord = { id: 'old', ownerAddress: userAddress, chain, ticker: 'test', amount: '1', lockBlocks: 3, timeLockAddress: csvGolden.addresses[3], createdAt: '2026-09-11T00:00:00Z', commitTxid: '11'.repeat(32), revealTxid: '22'.repeat(32), inscriptionTxid: '22'.repeat(32), inscriptionVout: 0, inscriptionSatoshi: 546, status: 'locked' }
const modern: Version2TimeLockRecord = (() => { const { lockBlocks: _, ...fields } = legacy; return { ...fields, id: 'new', chain, recordVersion: 2, ownerPubKey: pubKey, lock } })()
class MemoryStorage {
  values = new Map<string, string>()
  failWrites = false
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('quota'); this.values.set(key, value) }
}
const chainData = { chain: 'documented-as-string-only', blocks: 900_000, headers: 900_000, bestBlockHash: '11'.repeat(32), prevBlockHash: '22'.repeat(32), medianTime: timestamp, chainwork: '00ff' }

test('UTC parsing is independent of TZ and DST, including leap day, 2038 and the creatable limit', () => {
  const previous = process.env.TZ
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = tz
      assert.equal(parseUtcLockDate('2040-01-01T00:00'), timestamp)
      assert.equal(formatUtcDateInput(timestamp), '2040-01-01 00:00:00')
      assert.equal(parseUtcLockDate(formatUtcDateInput(timestamp)), timestamp)
      assert.equal(parseUtcLockDate('2038-01-19T03:14:08'), 0x8000_0000)
      assert.equal(parseUtcLockDate('2106-02-07T06:28:13'), 0xffff_fffd)
      assert.throws(() => parseUtcLockDate('2106-02-07T06:28:14'), /cannot confirm/)
      assert.throws(() => parseUtcLockDate('2106-02-07T06:28:15'), /cannot confirm/)
      assert.equal(formatUtc(parseUtcLockDate('2040-02-29T12:30:45')), '2040-02-29 12:30:45 UTC')
      assert.equal(formatUtc(parseUtcLockDate('2040-03-11T02:30:00')), '2040-03-11 02:30:00 UTC')
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('UTC parser rejects invalid dates without normalization and future test is strict', () => {
  for (const value of ['', '2041-02-29T00:00', '2040-02-30T00:00', '2040-13-01T00:00', '2040-00-01T00:00', '2040-01-00T00:00', '2040-01-01T24:00', '2040-01-01T12:60', '2040-01-01T12:00:60', '2040-01-01T00:00Z', '2040-01-01T00:00+08:00', '2106-02-07T06:28:16', '1980-01-01T00:00']) assert.throws(() => parseUtcLockDate(value), value)
  assert.throws(() => requireFutureDate(timestamp, timestamp))
  assert.throws(() => requireFutureDate(timestamp, timestamp + 1))
  assert.doesNotThrow(() => requireFutureDate(timestamp, timestamp - 1))
  assert.throws(() => requireFutureDate(0xffff_fffe, timestamp), /cannot confirm/)
  assert.throws(() => requireFutureDate(0xffff_ffff, timestamp), /cannot confirm/)
})

test('new CLTV dates use explicit chain MTP seconds instead of the device clock', () => {
  const originalNow = Date.now
  try {
    for (const deviceYear of [2000, 2090]) {
      Date.now = () => Date.UTC(deviceYear, 0, 1)
      assert.doesNotThrow(() => requireFutureDate(timestamp, timestamp - 1))
      assert.throws(() => requireFutureDate(timestamp, timestamp), /chain MTP/)
      assert.throws(() => requireFutureDate(timestamp, timestamp + 1), /chain MTP/)
    }
    for (const medianTime of [undefined, null, timestamp * 1000, 499_999_999, 0x1_0000_0000, Infinity, 1.5]) {
      assert.throws(() => requireFutureDate(timestamp, medianTime as number), /chain MTP/)
    }
  } finally { Date.now = originalNow }
})

test('new records never rewrite legacy bytes; legacy updates keep shape and extension fields', () => {
  const storage = new MemoryStorage()
  const extended = { ...legacy, extension: { preserved: ['opaque', 5] } }
  const raw = JSON.stringify([extended], null, 2)
  storage.setItem(LEGACY_RECORDS_KEY, raw)
  createStoredRecord(storage, modern)
  assert.equal(storage.getItem(LEGACY_RECORDS_KEY), raw)
  const newRaw = storage.getItem(RECORDS_V2_KEY)
  const updated = updateStoredRecord(storage, extended, { status: 'unlocked', unlockTxid: '33'.repeat(32) })
  assert.deepEqual((updated as typeof extended).extension, extended.extension)
  assert.ok(!('recordVersion' in updated) && !('lock' in updated))
  assert.equal(storage.getItem(RECORDS_V2_KEY), newRaw)
  assert.equal(readRecords(storage).records.length, 2)
})

test('damaged JSON, unknown versions and ambiguous locks block all writes without replacing originals', () => {
  for (const raw of ['{', '{}', JSON.stringify([{ ...legacy, lock }]), JSON.stringify([{ ...modern, recordVersion: 3 }]), JSON.stringify([{ ...modern, lockBlocks: 3 }])]) {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_RECORDS_KEY, raw)
    assert.ok(readRecords(storage).errors.length)
    assert.throws(() => createStoredRecord(storage, modern))
    assert.equal(storage.getItem(LEGACY_RECORDS_KEY), raw)
    assert.equal(storage.getItem(RECORDS_V2_KEY), null)
  }
  const storage = new MemoryStorage()
  storage.setItem(LEGACY_RECORDS_KEY, JSON.stringify([legacy]))
  storage.setItem(RECORDS_V2_KEY, JSON.stringify([{ ...modern, recordVersion: 8 }]))
  assert.deepEqual(readRecords(storage).records, [legacy])
  assert.throws(() => updateStoredRecord(storage, legacy, { status: 'unlocked' }))
})

test('duplicate IDs, stale or missing updates and quota failures never update another item', () => {
  const storage = new MemoryStorage()
  storage.setItem(LEGACY_RECORDS_KEY, JSON.stringify([legacy]))
  assert.throws(() => createStoredRecord(storage, { ...modern, id: legacy.id }))
  createStoredRecord(storage, modern)
  const before = new Map(storage.values)
  assert.throws(() => updateStoredRecord(storage, { ...modern, id: 'missing' }, { status: 'unlocked' }))
  assert.throws(() => getCurrentRecord(storage, { ...modern, status: 'pending' }))
  storage.failWrites = true
  assert.throws(() => updateStoredRecord(storage, modern, { status: 'unlocked' }), /Cannot save/)
  assert.deepEqual(storage.values, before)
  storage.failWrites = false
  storage.setItem(RECORDS_V2_KEY, JSON.stringify([{ ...modern, id: legacy.id }]))
  assert.ok(readRecords(storage).errors.some((error) => error.includes('Conflicting')))
  assert.throws(() => updateStoredRecord(storage, legacy, { status: 'unlocked' }))
})

test('malformed optional record strings are isolated in both namespaces without overwriting data', () => {
  const fields = ['runeId', 'runeName', 'initialCommitTxid', 'initialRevealTxid', 'transferToLockTxid', 'lockCommitTxid', 'lockRevealTxid', 'unlockTxid']
  for (const [key, record, otherKey, healthy] of [
    [LEGACY_RECORDS_KEY, legacy, RECORDS_V2_KEY, modern],
    [RECORDS_V2_KEY, modern, LEGACY_RECORDS_KEY, legacy],
  ] as const) {
    for (const field of fields) {
      for (const value of [{}, [], 123, true, null]) {
        const storage = new MemoryStorage()
        storage.setItem(key, JSON.stringify([{ ...record, [field]: value }], null, 2))
        storage.setItem(otherKey, JSON.stringify([healthy], null, 2))
        const before = new Map(storage.values)
        const snapshot = readRecords(storage)
        assert.equal(snapshot.errors.length, 1, `${key}: ${field}`)
        assert.ok(snapshot.errors[0].includes(`Invalid record ${field}`))
        assert.deepEqual(snapshot.records, [healthy])
        assert.throws(() => createStoredRecord(storage, { ...modern, id: 'another-record' }))
        assert.throws(() => updateStoredRecord(storage, healthy, { status: 'unlocked' }))
        assert.deepEqual(storage.values, before)
      }
    }
  }
})

test('pending signed chain and fixed timestamp survive each progress update and final cleanup', () => {
  const storage = new MemoryStorage()
  let pending = createStoredRecord(storage, { ...modern, status: 'pending', pendingPsbts: ['one', 'two', 'three', 'four', 'five'], broadcastStep: 0 })
  const signed = pending.pendingPsbts
  for (let step = 1; step <= 5; step++) {
    pending = updateStoredRecord(storage, pending, { broadcastStep: step }) as Version2TimeLockRecord
    assert.deepEqual(pending.lock, lock)
    assert.deepEqual(pending.pendingPsbts, signed)
  }
  const done = updateStoredRecord(storage, pending, { status: 'locked', pendingPsbts: undefined, broadcastStep: undefined })
  assert.ok(!('pendingPsbts' in done))
  assert.deepEqual(done.recordVersion === 2 && done.lock, lock)
})

test('blockchain info validates critical fields and supplied metadata types; no guessed chain mapping', () => {
  const info = parseBlockchainInfo(chainData, chain, 10_000)
  assert.equal(info.requestedChain, chain)
  assert.equal(info.chain, chainData.chain)
  for (const patch of [{ medianTime: undefined }, { medianTime: String(timestamp) }, { medianTime: timestamp * 1000 }, { medianTime: Infinity }, { medianTime: -1 }, { blocks: 1.5 }, { headers: -1 }, { chain: null }, { chain: {} }, { bestBlockHash: 'invalid' }, { chainwork: 0 }, { chainwork: [] }]) assert.throws(() => parseBlockchainInfo({ ...chainData, ...patch }, chain))
  assert.throws(() => parseBlockchainInfo(chainData, 'unknown'))
})

test('optional metadata strings never gate a valid MTP snapshot', () => {
  const checkedAt = 10_000
  for (const metadata of [
    { chain: '', chainwork: '' },
    { chain: 'main', chainwork: '0x00ff' },
    { chain: undefined, chainwork: undefined },
  ]) {
    // JSON round-trip also covers properties omitted by the API.
    const data = JSON.parse(JSON.stringify({ ...chainData, ...metadata }))
    const info = parseBlockchainInfo(data, chain, checkedAt)
    assert.equal(info.chain, metadata.chain)
    assert.equal(info.chainwork, metadata.chainwork)
    assert.equal(info.requestedChain, chain)
    assert.equal(isCltvMature(info, timestamp - 1, chain, checkedAt), true)
    assert.equal(isCltvMature(info, timestamp, chain, checkedAt), false)
    assert.equal(isCltvMature(info, timestamp + 1, chain, checkedAt), false)
    assert.throws(() => isCltvMature(info, timestamp - 1, ChainType.FRACTAL_BITCOIN_MAINNET, checkedAt), /another network/)
    assert.throws(() => isCltvMature(info, timestamp - 1, chain, checkedAt + CHAIN_SNAPSHOT_TTL_MS + 1), /stale/)
  }
})

test('missing ancillary metadata never relaxes critical chain-time validation', () => {
  const data = { ...chainData, chain: undefined, chainwork: undefined }
  for (const field of ['blocks', 'headers', 'bestBlockHash', 'prevBlockHash', 'medianTime']) {
    assert.throws(() => parseBlockchainInfo({ ...data, [field]: undefined }, chain), new RegExp(field))
  }
  for (const medianTime of [null, String(timestamp), timestamp * 1000, 499_999_999, 0x1_0000_0000, Infinity, 1.5]) {
    assert.throws(() => parseBlockchainInfo({ ...data, medianTime }, chain), /medianTime/)
  }
})

test('CLTV maturity is strictly MTP > target, bound to requested chain and finite TTL', () => {
  const now = 10_000
  const info = parseBlockchainInfo(chainData, chain, now)
  assert.equal(isCltvMature(info, timestamp - 1, chain, now), true)
  assert.equal(isCltvMature(info, timestamp, chain, now), false)
  assert.equal(isCltvMature(info, timestamp + 1, chain, now), false)
  assert.throws(() => isCltvMature(info, timestamp - 1, ChainType.FRACTAL_BITCOIN_MAINNET, now))
  assert.throws(() => isCltvMature(info, timestamp - 1, chain, now + CHAIN_SNAPSHOT_TTL_MS + 1))
  assert.throws(() => isCltvMature(info, timestamp - 1, chain, now - 1))
})

test('wire-only final timestamps remain recoverable but cannot be declared mature', () => {
  for (const target of [0xffff_fffe, 0xffff_ffff]) {
    const storage = new MemoryStorage()
    const record: Version2TimeLockRecord = { ...modern, lock: { kind: 'cltv_time', timestamp: target } }
    createStoredRecord(storage, record)
    assert.deepEqual(readRecords(storage), { records: [record], errors: [] })
    const info = parseBlockchainInfo({ ...chainData, medianTime: 0xffff_ffff }, chain, 10_000)
    assert.throws(() => isCltvMature(info, target, chain, 10_000), /cannot confirm/)
  }
})

test('chain request uses the exact configured network route, no-store, and rejects HTTP/error/stale replies', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async (url, options) => {
      calls++
      assert.equal(String(url), 'https://open-api-fractal-testnet.unisat.io/v1/indexer/blockchain/info')
      assert.equal(options?.cache, 'no-store')
      return new Response(JSON.stringify({ code: 0, data: { ...chainData, chain: '', chainwork: '' } }))
    }
    const info = await getBlockchainInfo('synthetic-test-key', ChainType.FRACTAL_BITCOIN_TESTNET)
    assert.equal(info.requestedChain, ChainType.FRACTAL_BITCOIN_TESTNET)
    await assert.rejects(getBlockchainInfo('', ''), /known/)
    assert.equal(calls, 1)
    globalThis.fetch = async () => new Response('throttled', { status: 429 })
    await assert.rejects(getBlockchainInfo('', chain), /429/)
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: chainData }), { headers: { age: '61' } })
    await assert.rejects(getBlockchainInfo('', chain), /stale/)
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: {} }))
    await assert.rejects(getBlockchainInfo('', chain), /invalid/)
  } finally { globalThis.fetch = original }
})

test('operation gate synchronously rejects duplicate create/resume/unlock and can release', () => {
  const gate = createOperationGate()
  assert.equal(gate.enter(), true)
  assert.equal(gate.enter(), false)
  assert.equal(gate.enter(), false)
  gate.leave()
  assert.equal(gate.enter(), true)
})

test('wallet snapshot rejects account, key, chain or event changes before continuing', async () => {
  const identity = freezeOperationIdentity(userAddress, pubKey, chain, lock)
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.lock))
  assert.throws(() => freezeOperationIdentity(userAddress, pubKey, '', lock))
  let address = userAddress, publicKey = pubKey, network = chain
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const provider: UnisatWallet = { getAccounts: async () => [address], requestAccounts: async () => [address], getPublicKey: async () => publicKey, getChain: async () => ({ enum: network, name: '', network: '' }), signPsbt: async (psbt) => psbt, on: (event, handler) => { listeners.set(event, handler) }, removeListener: (event) => { listeners.delete(event) } }
  const guard = watchOperationIdentity(identity, provider)
  await guard.assertCurrent()
  address = 'other'; await assert.rejects(guard.assertCurrent(), /changed/); address = userAddress
  publicKey = `03${pubKey.slice(2)}`; await assert.rejects(guard.assertCurrent(), /changed/); publicKey = pubKey
  network = ChainType.FRACTAL_BITCOIN_MAINNET; await assert.rejects(guard.assertCurrent(), /changed/); network = chain
  listeners.get('chainChanged')?.()
  await assert.rejects(guard.assertCurrent(), /changed/)
  guard.dispose()
  assert.equal(listeners.size, 0)
})

test('sequential signing rechecks identity before each wallet prompt and preserves completed batch', async () => {
  const global = globalThis as unknown as { window?: { unisat: UnisatWallet } }
  const original = global.window
  let signs = 0, checks = 0, changed = false
  const provider: UnisatWallet = { getAccounts: async () => [userAddress], requestAccounts: async () => [userAddress], getPublicKey: async () => pubKey, signPsbt: async (psbt) => { signs++; changed = true; return psbt } }
  global.window = { unisat: provider }
  try {
    await assert.rejects(signPsbtsCompat(['first', 'second'], [{}, {}], async () => { checks++; if (changed) throw new Error('identity changed') }), /changed/)
    assert.equal(signs, 1)
    assert.equal(checks, 2)
    changed = false
    const final = await signPsbtsCompat(['last'], [{}], async () => { if (changed) throw new Error('identity changed') })
    assert.deepEqual(final, ['last'], 'caller can save the completed signed chain before final identity check')
  } finally { if (original === undefined) delete global.window; else global.window = original }
})

test('provider replacement during asynchronous identity inspection cancels the operation', async () => {
  const global = globalThis as unknown as { window?: { unisat: UnisatWallet } }
  const original = global.window
  const identity = freezeOperationIdentity(userAddress, pubKey, chain, lock)
  const provider: UnisatWallet = { getAccounts: async () => [userAddress], requestAccounts: async () => [userAddress], getPublicKey: async () => { global.window = { unisat: { ...provider } }; return pubKey }, getChain: async () => ({ enum: chain, name: '', network: '' }), signPsbt: async (psbt) => psbt }
  global.window = { unisat: provider }
  try { await assert.rejects(watchOperationIdentity(identity, provider).assertCurrent(), /changed/) }
  finally { if (original === undefined) delete global.window; else global.window = original }
})

test('compatibility signing retry revalidates identity before another wallet call', async () => {
  const global = globalThis as unknown as { window?: { unisat: UnisatWallet } }
  const original = global.window
  let signs = 0, changed = false
  const provider: UnisatWallet = { getAccounts: async () => [userAddress], requestAccounts: async () => [userAddress], getPublicKey: async () => pubKey, signPsbt: async () => { signs++; changed = true; throw new Error('psbtHex required') } }
  global.window = { unisat: provider }
  try {
    await assert.rejects(signPsbtCompat('synthetic', {}, async () => { if (changed) throw new Error('identity changed') }), /changed/)
    assert.equal(signs, 1)
  } finally { if (original === undefined) delete global.window; else global.window = original }
})
