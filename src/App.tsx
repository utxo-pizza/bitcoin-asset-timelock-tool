import {
  DisconnectOutlined,
  LinkOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { Alert, Button, Descriptions, Modal, Space, Spin, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AddressBalance,
  OpenApiUtxo,
  RuneIndexerBalance,
  RuneIndexerEntry,
  RuneIndexerUtxo,
  TimeLockRecord,
  TimeLockCondition,
  Version2TimeLockRecord,
} from "./types";
import {
  buildRuneTimeLockDeposit,
  buildSingleUtxoTimeLockDeposit,
  buildTimeLockUnlockTx,
  deriveTimeLockAddress,
} from "./lib/timelock";
import {
  getAddressBalance,
  getAddressBrc20Balances,
  getAddressRuneBalances,
  getAddressRuneUtxos,
  getAvailableUtxos,
  getBrc20AvailableBalance,
  getRuneMetadata,
  getBlockchainInfo,
  isCltvMature,
  CHAIN_SNAPSHOT_TTL_MS,
} from "./lib/openapi";
import type { Brc20Balance, BlockchainInfo } from "./lib/openapi";
import { getRecommendedFeeRate } from "./lib/mempool";
import { copyText, shortAddress } from "./lib/format";
import { pushSignedPsbt, signPsbtCompat, signPsbtsCompat, createOperationGate, freezeOperationIdentity, watchOperationIdentity } from "./lib/wallet";
import type { OperationIdentity } from "./lib/wallet";
import { assertRecordsWritable, createStoredRecord, getCurrentRecord, readRecords, recordLock, RECORDS_KEYS, updateStoredRecord as persistRecordUpdate } from "./lib/records";
import { describeLock, formatUtc, formatUtcDateInput, parseUtcLockDate, requireFutureDate } from "./lib/lock-date";
import { normalizeNewTimeLockCondition } from "./lib/lock-condition";
import { getErrorMessage } from "./lib/errors";
import { normalizeSignedPsbtToHex, toUniSatSignInputs } from "./lib/psbt";
import { useOpenApiKey } from "./hooks/useOpenApiKey";
import { useWalletUtxos } from "./hooks/useWalletUtxos";
import { useWalletConnection } from "./hooks/useWalletConnection";
import { WalletInfoCard } from "./components/WalletInfoCard";
import { OperationPanel } from "./components/OperationPanel";
import { LockWorkspaceNavigation } from "./components/LockWorkspaceNavigation";
import { useLockWorkspaces, workspaceLockKind } from "./hooks/useLockWorkspaces";
import { isSelectableUtxo } from "./lib/utxo";
import { useRecovery } from "./hooks/useRecovery";
import { RecoveryPanel } from "./components/RecoveryPanel";

const BUILD_COMMIT_HASH = __BUILD_COMMIT_HASH__;
// Defer the localStorage getter so storage-denied errors reach the record reader.
const recordStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};

function isSupportedWalletAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  return (
    value.startsWith("bc1q") ||
    value.startsWith("bc1p") ||
    value.startsWith("tb1q") ||
    value.startsWith("tb1p")
  );
}

function isBip68NotFinalError(error: unknown): boolean {
  return getErrorMessage(error).toLowerCase().includes("non-bip68-final");
}

function isAlreadyBroadcastError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return /already.*(mempool|known|block chain|exists)|txn-already-known/.test(message);
}

function compareDecimalAmounts(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/)
    if (!match) throw new Error(`Invalid decimal amount: ${value}`)
    return { whole: match[1], fraction: match[2] || "" }
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length)
  const toInteger = ({ whole, fraction }: { whole: string; fraction: string }) =>
    BigInt(`${whole}${fraction.padEnd(scale, "0")}`)
  const leftInteger = toInteger(leftParts)
  const rightInteger = toInteger(rightParts)
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0
}

function selectRuneUtxo(
  runeUtxos: RuneIndexerUtxo[],
  metadata: RuneIndexerEntry,
  amount: string,
): { utxos: OpenApiUtxo[]; balance: string; hasUnallocatedRunes: boolean } {
  if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n)
    throw new Error("Rune amount must be a positive integer in base units.");
  const required = BigInt(amount.trim());
  const candidates = runeUtxos
    .map((item) => ({
      item,
      balance: item.runes.find((rune) => rune.runeid === metadata.runeid)
        ?.amount,
    }))
    .filter(
      (
        item,
      ): item is { item: RuneIndexerUtxo; balance: string } =>
        typeof item.balance === "string" &&
        /^\d+$/.test(item.balance) &&
        BigInt(item.balance) > 0n,
    );
  const total = candidates.reduce(
    (sum, candidate) => sum + BigInt(candidate.balance),
    0n,
  );
  if (total < required)
    throw new Error(
      `Transferable ${metadata.rune} balance is ${total.toString()} base units, which is less than the requested ${amount.trim()}.`,
    );

  const compareCandidates = (
    left: (typeof candidates)[number],
    right: (typeof candidates)[number],
  ) => {
    const byBalance = BigInt(left.balance) < BigInt(right.balance) ? -1 : BigInt(left.balance) > BigInt(right.balance) ? 1 : 0;
    return byBalance || left.item.txid.localeCompare(right.item.txid) || left.item.vout - right.item.vout;
  };
  // Preserve the previous low-input behavior when one source is enough. When
  // it is not, the largest sources first give the smallest possible input count.
  const single = [...candidates]
    .filter((candidate) => BigInt(candidate.balance) >= required)
    .sort(compareCandidates)[0];
  const selected = single ? [single] : [];
  let selectedBalance = single ? BigInt(single.balance) : 0n;
  if (!single) {
    for (const candidate of [...candidates].sort((left, right) => -compareCandidates(left, right))) {
      if (selectedBalance >= required) break;
      selected.push(candidate);
      selectedBalance += BigInt(candidate.balance);
    }
  }
  return {
    balance: selectedBalance.toString(),
    hasUnallocatedRunes: selected.some((candidate) => candidate.item.runes.some(
      (rune) =>
        rune.runeid !== metadata.runeid &&
        /^\d+$/.test(rune.amount) &&
        BigInt(rune.amount) > 0n,
    )),
    utxos: selected.map(({ item }) => ({
      address: item.address,
      satoshi: item.satoshi,
      scriptPk: item.scriptPk,
      txid: item.txid,
      vout: item.vout,
      scriptType: item.scriptPk.startsWith("5120") ? "P2TR" : undefined,
    })),
  };
}

function selectAutomaticBrc20FundingUtxo(
  utxos: OpenApiUtxo[],
): OpenApiUtxo {
  const fundingUtxo = [...utxos]
    .filter(isSelectableUtxo)
    .sort((left, right) => right.satoshi - left.satoshi)[0];
  if (!fundingUtxo)
    throw new Error("Load wallet UTXOs before creating a BRC-20 time lock.");
  return fundingUtxo;
}

function automaticFeeUtxoCandidates(utxos: OpenApiUtxo[]): OpenApiUtxo[] {
  // Larger UTXOs first minimizes the number of fee inputs the transaction uses.
  return [...utxos]
    .filter(isSelectableUtxo)
    .sort((left, right) => right.satoshi - left.satoshi);
}

function App() {
  const [messageApi, contextHolder] = message.useMessage();
  const [busy, updateBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => { busyRef.current = value; updateBusy(value); };
  const { workspace, draft, updateDraft, setResult, clearResults, applyRecommendedFee, resetFeeOverrides } = useLockWorkspaces(busyRef);
  const { ticker, amount, assetKind, runeReference, lockBlocks, lockDate, feeRate, result } = draft;
  const lockMode = workspaceLockKind(workspace);
  const [brc20Balances, setBrc20Balances] = useState<Brc20Balance[]>([]);
  const [brc20BalancesLoading, setBrc20BalancesLoading] = useState(false);
  const [runeBalances, setRuneBalances] = useState<RuneIndexerBalance[]>([]);
  const [runeBalancesLoading, setRuneBalancesLoading] = useState(false);
  const [walletBalance, setWalletBalance] = useState<AddressBalance | null>(
    null,
  );
  const [loadingText, setLoadingText] = useState("");
  const [recordState, setRecordState] = useState(() => readRecords(recordStorage));
  const records = recordState.records.filter((record) => recordLock(record).kind === lockMode);
  const operationGate = useRef(createOperationGate());
  const [chainInfo, setChainInfo] = useState<BlockchainInfo | null>(null);
  const [chainTimeError, setChainTimeError] = useState('');
  const [chainTimeLoading, setChainTimeLoading] = useState(false);
  const chainRequest = useRef(0);
  const cltvDateInitialized = useRef(false);
  const previousAutoChainContext = useRef('');

  const resetBuiltState = useCallback(() => {
    setResult({ status: "idle" });
  }, [setResult]);
  const wallet = useWalletConnection((msg) => messageApi.error(msg));
  const walletUtxos = useWalletUtxos();
  const clearLoadedData = useCallback(() => {
    setWalletBalance(null);
    walletUtxos.clear();
    clearResults();
  }, [clearResults, walletUtxos]);
  const {
    openApiKey,
    openApiKeyForRequests,
    hasOpenApiKey,
    handleOpenApiKeyChange,
  } = useOpenApiKey(clearLoadedData);
  const activeApiKey = useRef(openApiKeyForRequests);
  activeApiKey.current = openApiKeyForRequests;
  const chainContext = useMemo(() => ({ address: wallet.address, pubKey: wallet.pubKey, chain: String(wallet.chain), connected: wallet.connected, apiKey: openApiKeyForRequests }), [wallet.address, wallet.pubKey, wallet.chain, wallet.connected, openApiKeyForRequests]);
  const activeChainContext = useRef(chainContext);
  activeChainContext.current = chainContext;
  const watchIdentity = (identity: OperationIdentity) => {
    const guard = watchOperationIdentity(identity);
    const expectedKey = openApiKeyForRequests;
    return {
      dispose: guard.dispose,
      assertCurrent: async () => {
        if (activeApiKey.current !== expectedKey) throw new Error('OpenAPI configuration changed. Operation stopped; saved progress was retained.');
        await guard.assertCurrent();
        if (activeApiKey.current !== expectedKey) throw new Error('OpenAPI configuration changed. Operation stopped; saved progress was retained.');
      },
    };
  };
  const recovery = useRecovery({ workspace, busy, feeRate, wallet,
    apiKey: openApiKeyForRequests, hasApiKey: hasOpenApiKey,
    legacyRecords: recordState.records, legacyErrors: recordState.errors,
    storage: recordStorage, operationGate: operationGate.current,
    setBusy, setLoadingText, watchIdentity });

  useEffect(() => { messageApi.destroy(); }, [workspace, messageApi]);

  const refreshRecords = useCallback(() => setRecordState(readRecords(recordStorage)), []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || RECORDS_KEYS.some((key) => key === event.key)) refreshRecords();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refreshRecords]);

  useEffect(() => {
    chainRequest.current += 1;
    setChainInfo(null);
    setChainTimeError('');
    setChainTimeLoading(false);
  }, [wallet.address, wallet.pubKey, wallet.chain, wallet.connected, openApiKeyForRequests]);

  useEffect(() => {
    if (!chainInfo) return;
    const request = chainRequest.current;
    const timer = window.setTimeout(() => {
      if (request !== chainRequest.current) return;
      setChainInfo(null);
      setChainTimeError('Previous chain-time check expired. Refresh before relying on it.');
    }, Math.max(0, chainInfo.checkedAt + CHAIN_SNAPSHOT_TTL_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [chainInfo]);

  const checkChainTime = useCallback(async (chain: string) => {
    const context = activeChainContext.current;
    if (context.chain !== chain || context.apiKey !== openApiKeyForRequests) throw new Error('Wallet or API configuration changed before the chain-time check. Retry.');
    const request = ++chainRequest.current;
    setChainInfo(null);
    setChainTimeError('');
    setChainTimeLoading(true);
    try {
      const info = await getBlockchainInfo(openApiKeyForRequests, chain);
      if (request !== chainRequest.current || context !== activeChainContext.current) throw new Error('Wallet or API configuration changed during the chain-time check. Retry.');
      setChainInfo(info);
      return info;
    } catch (error) {
      if (request === chainRequest.current && context === activeChainContext.current) setChainTimeError(getErrorMessage(error));
      throw error;
    } finally {
      if (request === chainRequest.current && context === activeChainContext.current) setChainTimeLoading(false);
    }
  }, [openApiKeyForRequests]);

  const canRefreshChainTime = wallet.connected && !!wallet.address && !!wallet.pubKey && !!wallet.chain && hasOpenApiKey;
  const refreshChainTime = useCallback(async () => {
    if (busyRef.current || !canRefreshChainTime) return;
    // This is a read-only preview. Transaction paths keep their separate wallet guards.
    try { await checkChainTime(String(wallet.chain)); }
    catch { /* Only the request owner updates the visible error state. */ }
  }, [canRefreshChainTime, wallet.chain, checkChainTime]);

  useEffect(() => {
    const context = [workspace, wallet.connected, wallet.address, wallet.pubKey, wallet.chain].join('|');
    if (context === previousAutoChainContext.current) return;
    previousAutoChainContext.current = context;
    // Load on CLTV entry / wallet changes, not on every API-key keystroke.
    // Editing the key invalidates the old snapshot and requires an explicit refresh.
    if (workspace === 'cltv') void refreshChainTime();
  }, [workspace, wallet.connected, wallet.address, wallet.pubKey, wallet.chain, refreshChainTime]);

  useEffect(() => {
    if (busy || workspace !== 'cltv' || cltvDateInitialized.current || lockDate || !chainInfo || chainInfo.requestedChain !== wallet.chain) return;
    cltvDateInitialized.current = true;
    updateDraft({ lockDate: formatUtcDateInput(chainInfo.medianTime) });
  }, [busy, workspace, lockDate, chainInfo, wallet.chain, updateDraft]);

  useEffect(() => {
    if (!hasOpenApiKey || !wallet.connected || !wallet.chain) return;
    let cancelled = false;
    void getRecommendedFeeRate(String(wallet.chain), openApiKeyForRequests)
      .then((recommendedFeeRate) => {
        if (!cancelled) applyRecommendedFee(recommendedFeeRate);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasOpenApiKey, openApiKeyForRequests, wallet.chain, wallet.connected, applyRecommendedFee]);

  useEffect(() => {
    if (assetKind !== "brc20" || !hasOpenApiKey || !wallet.connected || !wallet.address || !wallet.chain) {
      setBrc20Balances([]);
      setBrc20BalancesLoading(false);
      return;
    }
    let cancelled = false;
    setBrc20BalancesLoading(true);
    void getAddressBrc20Balances(
      wallet.address,
      openApiKeyForRequests,
      wallet.chain,
    )
      .then((balances) => {
        if (!cancelled) {
          setBrc20Balances(balances.filter((balance) =>
            compareDecimalAmounts(balance.availableBalance, "0") > 0,
          ));
        }
      })
      .catch(() => {
        if (!cancelled) setBrc20Balances([]);
      })
      .finally(() => {
        if (!cancelled) setBrc20BalancesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetKind, hasOpenApiKey, openApiKeyForRequests, wallet.address, wallet.chain, wallet.connected]);

  useEffect(() => {
    if (assetKind !== "runes" || !hasOpenApiKey || !wallet.connected || !wallet.address || !wallet.chain) {
      setRuneBalances([]);
      setRuneBalancesLoading(false);
      return;
    }
    let cancelled = false;
    setRuneBalancesLoading(true);
    void getAddressRuneBalances(
      wallet.address,
      openApiKeyForRequests,
      wallet.chain,
    )
      .then((balances) => {
        if (!cancelled) {
          setRuneBalances(balances.filter((balance) =>
            /^\d+$/.test(balance.amount) && BigInt(balance.amount) > 0n,
          ));
        }
      })
      .catch(() => {
        if (!cancelled) setRuneBalances([]);
      })
      .finally(() => {
        if (!cancelled) setRuneBalancesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetKind, hasOpenApiKey, openApiKeyForRequests, wallet.address, wallet.chain, wallet.connected]);

  const parsedLock = useMemo<{ lock?: TimeLockCondition; error: string }>(() => {
    try {
      if (lockMode === 'csv_blocks') return { lock: { kind: 'csv_blocks', blocks: lockBlocks }, error: '' };
      const timestamp = parseUtcLockDate(lockDate);
      return { lock: { kind: 'cltv_time', timestamp }, error: '' };
    } catch (error) { return { error: getErrorMessage(error) }; }
  }, [lockMode, lockBlocks, lockDate]);

  const lockDateError = useMemo(() => {
    if (parsedLock.error || parsedLock.lock?.kind !== 'cltv_time') return parsedLock.error;
    if (!chainInfo) return 'Load fresh chain MTP for the current network before creating a lock.';
    try {
      isCltvMature(chainInfo, parsedLock.lock.timestamp, String(wallet.chain));
      requireFutureDate(parsedLock.lock.timestamp, chainInfo.medianTime);
      return '';
    } catch (error) { return getErrorMessage(error); }
  }, [parsedLock, chainInfo, wallet.chain]);

  const timeLockAddress = useMemo(() => {
    if (!wallet.pubKey) return "";
    try {
      return parsedLock.lock ? deriveTimeLockAddress(wallet.pubKey, parsedLock.lock, wallet.chain) : '';
    } catch {
      return "";
    }
  }, [parsedLock, wallet.pubKey, wallet.chain]);
  const canFetchUtxos =
    wallet.connected &&
    !!wallet.address &&
    !!wallet.pubKey &&
    isSupportedWalletAddress(wallet.address);
  const canCreate =
    assetKind === "brc20"
      ? canFetchUtxos &&
        !!ticker &&
        !!amount.trim()
      : canFetchUtxos && !!runeReference.trim() && !!amount.trim();
  const loading = !!loadingText;

  const handleConnect = async () => {
    if (busy) return;
    setLoadingText("Connecting UniSat Wallet...");
    try {
      await wallet.connect();
    } catch (error) {
      messageApi.error(getErrorMessage(error));
    } finally {
      setLoadingText("");
    }
  };

  const handleDisconnect = async () => {
    if (busy) return;
    await wallet.disconnect();
    clearLoadedData();
  };

  const handleSwitchChain = async (chain: import("./types").ChainType) => {
    if (busy) return;
    setLoadingText(`Switching UniSat to ${chain}...`);
    try {
      resetFeeOverrides();
      await wallet.switchChain(chain);
      clearLoadedData();
      messageApi.success(
        `Switched to ${chain}. UTXOs will be refreshed when you create a deposit.`,
      );
    } catch (error) {
      messageApi.error(getErrorMessage(error));
    } finally {
      setLoadingText("");
    }
  };

  const handleCopy = async (value: string, label = "Copied") => {
    try {
      await copyText(value);
      messageApi.success(label);
    } catch (error) {
      messageApi.error(getErrorMessage(error));
    }
  };

  const fetchWalletUtxos = async () => {
    if (!canFetchUtxos) {
      messageApi.warning("Connect your wallet first.");
      return;
    }
    if (!hasOpenApiKey) {
      messageApi.warning("Enter your UniSat OpenAPI key first.");
      return;
    }
    setLoadingText("Loading wallet UTXOs...");
    resetBuiltState();
    try {
      const [balance, utxos] = await Promise.all([
        getAddressBalance(wallet.address, openApiKeyForRequests, wallet.chain),
        getAvailableUtxos(
          wallet.address,
          openApiKeyForRequests,
          500,
          wallet.chain,
        ),
      ]);
      setWalletBalance(balance);
      walletUtxos.setFetchedUtxos(utxos);
      if (!utxos.length)
        messageApi.warning("No available UTXOs were found for this wallet.");
    } catch (error) {
      messageApi.error(getErrorMessage(error));
    } finally {
      setLoadingText("");
    }
  };

  const createRecord = (
    params: Omit<Version2TimeLockRecord, "id" | "createdAt" | "status" | "recordVersion">,
    status: TimeLockRecord["status"] = "locked",
  ) => {
    const id =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const record: Version2TimeLockRecord = {
      ...params,
      recordVersion: 2,
      id,
      createdAt: new Date().toISOString(),
      status,
    };
    try { return createStoredRecord(recordStorage, record); }
    finally { refreshRecords(); }
  };

  const updateStoredRecord = (
    record: TimeLockRecord,
    patch: Pick<Partial<TimeLockRecord>, 'status' | 'broadcastStep' | 'pendingPsbts' | 'unlockTxid'>,
  ) => {
    try { return persistRecordUpdate(recordStorage, record, patch); }
    finally { refreshRecords(); }
  };

  const broadcastPendingBrc20 = async (record: TimeLockRecord, assertCurrent: () => Promise<void>) => {
    let current = getCurrentRecord(recordStorage, record);
    const signedPsbts = record.pendingPsbts;
    const expectedTxids = [
      record.initialCommitTxid,
      record.initialRevealTxid,
      record.transferToLockTxid,
      record.lockCommitTxid,
      record.lockRevealTxid,
    ];
    if (!signedPsbts || signedPsbts.length !== 5 || expectedTxids.some((txid) => !txid)) {
      throw new Error("This pending BRC-20 record is missing its signed transaction chain and cannot be resumed.");
    }
    const startStep = record.broadcastStep || 0;
    for (let index = startStep; index < 5; index += 1) {
      setLoadingText(`Broadcasting ${index + 1}/5...`);
      await assertCurrent();
      getCurrentRecord(recordStorage, current);
      let txid: string | undefined;
      try {
        txid = await pushSignedPsbt(signedPsbts[index]);
      } catch (error) {
        // A timeout can occur after the wallet has accepted the transaction.
        // Re-submitting a known tx is safe and counts as progress.
        if (!isAlreadyBroadcastError(error)) throw error;
      }
      if (txid && txid !== expectedTxids[index]) {
        throw new Error(
          `Broadcast txid differs from the saved transaction at step ${index + 1}: ${txid}`,
        );
      }
      // Persist a completed broadcast before checking whether the wallet changed
      // while its promise was pending. Never discard submitted progress.
      current = updateStoredRecord(current, { broadcastStep: index + 1 });
      await assertCurrent();
    }
    updateStoredRecord(current, {
      status: "locked",
      broadcastStep: undefined,
      pendingPsbts: undefined,
    });
    setResult({
      status: "timelock_success",
      commitTxid: record.lockCommitTxid!,
      revealTxid: record.lockRevealTxid!,
      timeLockAddress: record.timeLockAddress,
    });
    messageApi.success("All five deposit transactions were broadcast. The final transfer inscription is locked.");
  };

  const confirmLock = (params: {
    asset: string;
    timeLockAddress: string;
    estimatedCost: number;
    identity: OperationIdentity;
  }) =>
    new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "Confirm Asset Lock",
        width: 640,
        content: (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Current Network">
              {params.identity.chain}
            </Descriptions.Item>
            <Descriptions.Item label="Current Address">
              {params.identity.ownerAddress}
            </Descriptions.Item>
            <Descriptions.Item label="Time-lock Address">
              {params.timeLockAddress}
            </Descriptions.Item>
            <Descriptions.Item label="Lock Period">
              {describeLock(params.identity.lock)}
              {params.identity.lock.kind === 'cltv_time' && <div>Fixed date, not a duration after confirmation. It can pass before the deposit confirms. Spending requires chain MTP strictly after this date; no automatic transfer.</div>}
            </Descriptions.Item>
            <Descriptions.Item label="Locked Asset">
              {params.asset}
            </Descriptions.Item>
            <Descriptions.Item label="Estimated Cost">
              {params.estimatedCost} sats
            </Descriptions.Item>
          </Descriptions>
        ),
        okText: "Confirm Lock",
        cancelText: "Cancel",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

  const handleCreate = async () => {
    if (!canCreate || !hasOpenApiKey) {
      messageApi.warning(
        "Enter the token and amount, then configure an OpenAPI key.",
      );
      return;
    }
    if (!operationGate.current.enter()) return;
    setBusy(true);
    let guard: ReturnType<typeof watchOperationIdentity> | undefined;
    setResult({ status: "idle" });
    try {
      if (!parsedLock.lock) throw new Error(parsedLock.error);
      if (parsedLock.lock.kind === 'cltv_time' && lockDateError) throw new Error(lockDateError);
      const identity = freezeOperationIdentity(wallet.address, wallet.pubKey, String(wallet.chain), parsedLock.lock);
      guard = watchIdentity(identity);
      const assertCurrent = guard.assertCurrent;
      await assertCurrent();
      assertRecordsWritable(recordStorage);
      const checkFutureChainTime = async () => {
        if (identity.lock.kind !== 'cltv_time') return;
        const info = await checkChainTime(identity.chain);
        await assertCurrent();
        // Creation needs a future target; equality is not future either.
        isCltvMature(info, identity.lock.timestamp, identity.chain);
        requireFutureDate(identity.lock.timestamp, info.medianTime);
      };
      if (!isSupportedWalletAddress(wallet.address)) {
        throw new Error(
          "Only native SegWit (bc1q / tb1q) and Taproot (bc1p / tb1p) wallet addresses are supported. P2PKH and P2SH are not supported.",
        );
      }
      const pendingBrc20 = assetKind === "brc20" && readRecords(recordStorage).records.find(
        (record) =>
          record.status === "pending" &&
          record.ownerAddress === identity.ownerAddress &&
          (!record.chain || record.chain === identity.chain),
      );
      if (pendingBrc20) {
        const pendingWorkspace = recordLock(pendingBrc20).kind === 'csv_blocks' ? 'CSV (#/csv)' : 'CLTV (#/cltv)';
        throw new Error(`A BRC-20 deposit is still pending. Open the ${pendingWorkspace} workspace and continue its saved broadcast before creating another BRC-20 lock.`);
      }
      if (assetKind === "brc20") {
        setLoadingText("Checking BRC-20 available balance...");
        const availableBalance = await getBrc20AvailableBalance(
          identity.ownerAddress,
          ticker,
          openApiKeyForRequests,
          identity.chain,
        );
        await assertCurrent();
        if (compareDecimalAmounts(availableBalance, amount) < 0) {
          throw new Error(
            `BRC-20 available balance for ${ticker} is ${availableBalance}, which is less than the requested lock amount of ${amount.trim()}.`,
          );
        }
      }
      setLoadingText("Loading current wallet UTXOs...");
      const currentWalletUtxos = await getAvailableUtxos(
        identity.ownerAddress,
        openApiKeyForRequests,
        500,
        identity.chain,
      );
      await assertCurrent();
      walletUtxos.setFetchedUtxos(currentWalletUtxos);
      if (assetKind === "runes") {
        setLoadingText("Looking up Rune metadata and transferable UTXOs...");
        const metadata = await getRuneMetadata(
          runeReference,
          openApiKeyForRequests,
          identity.chain,
        );
        await assertCurrent();
        const runeUtxos = await getAddressRuneUtxos(
          identity.ownerAddress,
          metadata.runeid,
          openApiKeyForRequests,
          identity.chain,
        );
        await assertCurrent();
        const source = selectRuneUtxo(runeUtxos, metadata, amount);
        setLoadingText("Building the Runestone time-lock transaction...");
        const deposit = buildRuneTimeLockDeposit({
          userAddress: identity.ownerAddress,
          pubKey: identity.pubKey,
          lock: identity.lock,
          runeId: metadata.runeid,
          runeName: metadata.rune,
          runeAmount: amount,
          runeBalance: source.balance,
          // Fee inputs are chosen automatically. Always retain a Rune-change
          // output so any Runes on an automatically chosen fee UTXO return to
          // the wallet rather than being assigned to the lock output.
          hasUnallocatedRunes: true,
          runeUtxos: source.utxos,
          feeUtxos: automaticFeeUtxoCandidates(currentWalletUtxos),
          feeRate,
          chain: identity.chain,
        });
        setLoadingText("");
        if (!(await confirmLock({
          asset: `${amount.trim()} ${metadata.rune}`,
          timeLockAddress: deposit.timeLockAddress,
          estimatedCost: deposit.estimatedFee,
          identity,
        }))) return;
        await assertCurrent();
        assertRecordsWritable(recordStorage);
        setLoadingText(
          "Review and sign the Runestone time-lock transaction in UniSat...",
        );
        const signed = await signPsbtCompat(deposit.psbtHex, {
          autoFinalized: true,
          toSignInputs: toUniSatSignInputs(deposit.toSignInputs),
        }, async () => { await assertCurrent(); await checkFutureChainTime(); });
        await assertCurrent();
        assertRecordsWritable(recordStorage);
        setLoadingText("Broadcasting the Runestone time-lock transaction...");
        const txid = await pushSignedPsbt(normalizeSignedPsbtToHex(signed));
        try { createRecord({
          ownerAddress: identity.ownerAddress,
          ownerPubKey: identity.pubKey,
          chain: identity.chain,
          assetKind: "runes",
          ticker: metadata.rune,
          amount: amount.trim(),
          runeId: metadata.runeid,
          runeName: metadata.rune,
          lock: identity.lock,
          timeLockAddress: deposit.timeLockAddress,
          commitTxid: txid,
          revealTxid: txid,
          inscriptionTxid: txid,
          inscriptionVout: 1,
          inscriptionSatoshi: deposit.outputs[1].satoshi,
        }); } catch (error) { throw new Error(`${getErrorMessage(error)} Broadcast transaction: ${txid}; lock address: ${deposit.timeLockAddress}; ${describeLock(identity.lock)}.`); }
        await assertCurrent();
        setResult({
          status: "timelock_success",
          commitTxid: txid,
          revealTxid: txid,
          timeLockAddress: deposit.timeLockAddress,
        });
        messageApi.success(
          "The Rune transfer was broadcast to the time-lock address.",
        );
        return;
      }
      setLoadingText(
        "Building the five-transaction BRC-20 deposit from one UTXO...",
      );
      const fundingUtxo = selectAutomaticBrc20FundingUtxo(
        currentWalletUtxos,
      );
      const deposit = buildSingleUtxoTimeLockDeposit({
        userAddress: identity.ownerAddress,
        pubKey: identity.pubKey,
        ticker,
        amount,
        lock: identity.lock,
        feeRate,
        fundingUtxo,
        chain: identity.chain,
      });
      setLoadingText("");
      if (!(await confirmLock({
        asset: `${amount.trim()} ${ticker}`,
        timeLockAddress: deposit.timeLockAddress,
        estimatedCost: deposit.totalEstimatedFee,
        identity,
      }))) return;
      await assertCurrent();
      assertRecordsWritable(recordStorage);
      setLoadingText("Review and sign all five transactions in UniSat...");
      const signedPsbts = await signPsbtsCompat(
        deposit.steps.map((step) => step.psbtHex),
        deposit.steps.map((step) => ({
          autoFinalized: true,
          toSignInputs: toUniSatSignInputs(step.toSignInputs),
        })),
        async () => { await assertCurrent(); await checkFutureChainTime(); },
      );
      const pendingRecord = createRecord({
        ownerAddress: identity.ownerAddress,
        ownerPubKey: identity.pubKey,
        chain: identity.chain,
        assetKind: "brc20",
        ticker,
        amount: amount.trim(),
        lock: identity.lock,
        timeLockAddress: deposit.timeLockAddress,
        commitTxid: deposit.steps[3].txid,
        revealTxid: deposit.steps[4].txid,
        initialCommitTxid: deposit.steps[0].txid,
        initialRevealTxid: deposit.steps[1].txid,
        transferToLockTxid: deposit.steps[2].txid,
        lockCommitTxid: deposit.steps[3].txid,
        lockRevealTxid: deposit.steps[4].txid,
        inscriptionTxid: deposit.steps[4].txid,
        inscriptionVout: 0,
        inscriptionSatoshi: deposit.inscriptionSatoshi,
        broadcastStep: 0,
        pendingPsbts: signedPsbts.map(normalizeSignedPsbtToHex),
      }, "pending");
      await assertCurrent();
      await broadcastPendingBrc20(pendingRecord, assertCurrent);
    } catch (error) {
      const msg = getErrorMessage(error);
      setResult({ status: "error", message: msg });
      messageApi.error(msg);
    } finally {
      guard?.dispose();
      operationGate.current.leave();
      setBusy(false);
      setLoadingText("");
    }
  };

  const handleResumeBrc20 = async (record: TimeLockRecord) => {
    if (!wallet.connected || !wallet.address || !wallet.pubKey) {
      messageApi.warning("Connect the wallet that created this time lock first.");
      return;
    }
    if (record.ownerAddress !== wallet.address || record.chain !== wallet.chain) {
      messageApi.error("Switch UniSat to the wallet and network that created this pending deposit before continuing.");
      return;
    }
    if (!operationGate.current.enter()) return;
    setBusy(true);
    let guard: ReturnType<typeof watchOperationIdentity> | undefined;
    setResult({ status: "idle" });
    try {
      getCurrentRecord(recordStorage, record);
      const lock = recordLock(record);
      const identity = freezeOperationIdentity(record.ownerAddress, wallet.pubKey, String(record.chain), lock);
      guard = watchIdentity(identity);
      await guard.assertCurrent();
      if (deriveTimeLockAddress(identity.pubKey, lock, identity.chain) !== record.timeLockAddress || (record.recordVersion === 2 && record.ownerPubKey.toLowerCase() !== identity.pubKey.toLowerCase())) throw new Error('Saved lock address or public key does not match this wallet and lock condition.');
      if (lock.kind === 'cltv_time') {
        // This is a saved signed chain, not a new lock. Never rebuild its date.
        // Do not continue funding a condition that cannot confirm a spend.
        normalizeNewTimeLockCondition(lock);
        const info = await checkChainTime(identity.chain);
        await guard.assertCurrent();
        if (info.medianTime >= lock.timestamp) {
          setLoadingText('');
          const proceed = await new Promise<boolean>((resolve) => Modal.confirm({
            title: 'Fixed date has passed — continue saved transactions?',
            content: `The original date is ${formatUtc(lock.timestamp)} on ${identity.chain}. Continue only the already-signed transaction chain; the date will not change and funds may have no remaining time delay.`,
            okText: 'Continue Original Chain', cancelText: 'Cancel', onOk: () => resolve(true), onCancel: () => resolve(false),
          }));
          if (!proceed) return;
        }
      }
      await broadcastPendingBrc20(record, guard.assertCurrent);
    } catch (error) {
      const msg = getErrorMessage(error);
      setResult({ status: "error", message: msg });
      messageApi.error(msg);
    } finally {
      guard?.dispose();
      operationGate.current.leave();
      setBusy(false);
      setLoadingText("");
    }
  };

  const handleUnlock = async (record: TimeLockRecord, skipMaturityCheck = false) => {
    if (!wallet.connected || !wallet.address || !wallet.pubKey) {
      messageApi.warning(
        "Connect the wallet that created this time lock first.",
      );
      return;
    }
    if (wallet.address !== record.ownerAddress) {
      messageApi.error(
        "The connected wallet differs from the wallet that created this record, so it cannot unlock it.",
      );
      return;
    }
    if (record.chain && wallet.chain !== record.chain) {
      messageApi.error(
        `This lock was created on ${record.chain}. Switch UniSat back to that network before unlocking.`,
      );
      return;
    }
    if (!isSupportedWalletAddress(wallet.address)) {
      messageApi.error(
        "Only native SegWit (bc1q / tb1q) and Taproot (bc1p / tb1p) wallet addresses are supported. P2PKH and P2SH are not supported.",
      );
      return;
    }
    if (!hasOpenApiKey) {
      messageApi.warning("Enter your UniSat OpenAPI key first.");
      return;
    }
    if (!operationGate.current.enter()) return;
    setBusy(true);
    let guard: ReturnType<typeof watchOperationIdentity> | undefined;
    let testStage = 'preparation';
    setResult({ status: "idle" });
    const lockInscriptionUtxo: OpenApiUtxo = {
      txid: record.inscriptionTxid,
      vout: record.inscriptionVout,
      satoshi: record.inscriptionSatoshi,
      // The time-lock script is deterministically reconstructed from the
      // connected owner's public key and the saved lock condition in
      // buildTimeLockUnlockTx.
      scriptPk: "",
    };
    try {
      getCurrentRecord(recordStorage, record);
      const lock = recordLock(record);
      if (skipMaturityCheck && lock.kind !== 'cltv_time') throw new Error('The maturity-check test is only available for CLTV records.');
      const identity = freezeOperationIdentity(record.ownerAddress, wallet.pubKey, String(record.chain || wallet.chain), lock);
      guard = watchIdentity(identity);
      await guard.assertCurrent();
      if (deriveTimeLockAddress(identity.pubKey, lock, identity.chain) !== record.timeLockAddress || (record.recordVersion === 2 && record.ownerPubKey.toLowerCase() !== identity.pubKey.toLowerCase())) throw new Error('Saved lock address or public key does not match this wallet and lock condition. Unlock stopped.');
      if (skipMaturityCheck) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: 'Test CLTV unlock without the web MTP check?',
            width: 640,
            autoFocusButton: 'cancel',
            content: (
              <Space direction="vertical" className="full cltv-unlock-test-confirm">
                <Alert type="warning" showIcon message="This is a real signing and broadcast attempt, not a simulation."
                  description="Only the website's maturity precheck is skipped for this attempt. The original CLTV script, target, nLockTime and sequence remain unchanged. If mature, this may actually unlock the asset and spend the transaction fee. Your wallet or its broadcast service may still reject it." />
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="Network">{identity.chain}</Descriptions.Item>
                  <Descriptions.Item label="Asset">{record.amount} {record.runeName || record.ticker}</Descriptions.Item>
                  <Descriptions.Item label="Return address">{identity.ownerAddress}</Descriptions.Item>
                  <Descriptions.Item label="Locked outpoint">{record.inscriptionTxid}:{record.inscriptionVout}</Descriptions.Item>
                  <Descriptions.Item label="Original target">{describeLock(lock)}</Descriptions.Item>
                  <Descriptions.Item label="Last displayed MTP (not rechecked)">{chainInfo?.requestedChain === identity.chain ? formatUtc(chainInfo.medianTime) : 'Unknown'}</Descriptions.Item>
                </Descriptions>
                <span>A wallet/API rejection alone is not proof of a consensus rejection. Save the exact error and its reported stage. Normal Check &amp; Unlock remains protected.</span>
              </Space>
            ),
            okText: 'Sign & Try Broadcast',
            okButtonProps: { danger: true },
            cancelText: 'Cancel',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!confirmed) return;
        await guard.assertCurrent();
        getCurrentRecord(recordStorage, record);
      }
      setLoadingText("Loading wallet UTXOs for the unlock fee...");
      const feeUtxos = await getAvailableUtxos(
        identity.ownerAddress,
        openApiKeyForRequests,
        500,
        identity.chain,
      );
      await guard.assertCurrent();
      setLoadingText("Building the time-lock unlock transaction...");
      const tx = buildTimeLockUnlockTx({
        userAddress: identity.ownerAddress,
        pubKey: identity.pubKey,
        lock,
        inscriptionUtxo: lockInscriptionUtxo,
        feeUtxos,
        feeRate,
        chain: identity.chain,
      });
      const assertBeforeUnlockSign = async () => {
        testStage = 'pre-sign checks';
        await guard!.assertCurrent();
        if (lock.kind === 'cltv_time' && !skipMaturityCheck) {
          setLoadingText('Checking chain MTP before unlock signing...');
          const info = await checkChainTime(identity.chain);
          await guard!.assertCurrent();
          if (!isCltvMature(info, lock.timestamp, identity.chain)) throw new Error(`Fixed date not yet mature. Chain MTP (${formatUtc(info.medianTime)}) must be strictly after ${formatUtc(lock.timestamp)}.`);
        }
        getCurrentRecord(recordStorage, record);
        testStage = 'wallet signing';
      };
      getCurrentRecord(recordStorage, record);
      setLoadingText(
        `Sign the ${describeLock(lock)} unlock transaction in your wallet...`,
      );
      const signed = await signPsbtCompat(tx.psbtHex, {
        autoFinalized: true,
        toSignInputs: toUniSatSignInputs(tx.toSignInputs),
      }, assertBeforeUnlockSign);
      testStage = 'post-sign checks';
      await guard.assertCurrent();
      getCurrentRecord(recordStorage, record);
      const signedHex = normalizeSignedPsbtToHex(signed);
      setLoadingText("Broadcasting the unlock transaction...");
      testStage = 'wallet broadcast';
      const unlockTxid = await pushSignedPsbt(signedHex);
      testStage = 'after broadcast';
      try { updateStoredRecord(record, { status: 'unlocked', unlockTxid }); }
      catch (error) { throw new Error(`${getErrorMessage(error)} Unlock transaction was broadcast: ${unlockTxid}.`); }
      await guard.assertCurrent();
      setResult({ status: "success", txid: unlockTxid, label: skipMaturityCheck ? "CLTV test unlock (confirmation not checked)" : "Unlock" });
      messageApi.success(
        skipMaturityCheck
          ? 'The wallet reported an unlock broadcast. Verify confirmation and asset balances on the original network; this is not proof of early unlocking.'
          : `The time lock was released. The ${record.assetKind === "runes" ? "Rune" : "BRC-20 transfer inscription"} is returning to your wallet.`,
      );
    } catch (error) {
      let msg = getErrorMessage(error);
      const lock = recordLock(record);
      if (lock.kind === 'csv_blocks' && isBip68NotFinalError(error)) {
        msg = `Time lock not yet mature (non-BIP68-final). Wait for ${lock.blocks} confirmations before trying again.`;
      }
      if (skipMaturityCheck) msg = `CLTV test — ${testStage}: ${msg} | ${record.chain || wallet.chain} | Outpoint ${record.inscriptionTxid}:${record.inscriptionVout} | ${describeLock(lock)}. The web MTP precheck was not used. This result alone does not establish a consensus rejection or successful early unlock.`;
      setResult({ status: "error", message: msg });
      messageApi.error(msg);
    } finally {
      guard?.dispose();
      operationGate.current.leave();
      setBusy(false);
      setLoadingText("");
    }
  };

  const walletStatus = wallet.connected ? (
    <Space wrap>
      <Button
        icon={<WalletOutlined />}
        onClick={() => handleCopy(wallet.address, "Wallet address copied")}
      >
        {shortAddress(wallet.address)}
      </Button>
      <Button icon={<DisconnectOutlined />} onClick={handleDisconnect}>
        Disconnect
      </Button>
    </Space>
  ) : (
    <Button type="primary" icon={<WalletOutlined />} onClick={handleConnect}>
      Connect UniSat Wallet
    </Button>
  );

  return (
    <main className="app-shell">
      {contextHolder}
      <Spin spinning={loading} tip={loadingText || undefined} fullscreen />
      <section className="tool-panel">
        <div className="topbar">
          <div>
            <Typography.Title level={2}>
              Bitcoin Asset Time Lock
            </Typography.Title>
            <Typography.Paragraph type="secondary">
              {workspace === 'csv' ? 'Lock BRC-20 transfer inscriptions or Runes for a relative number of blocks after confirmation.' : 'Lock BRC-20 transfer inscriptions or Runes until a fixed UTC date.'}
            </Typography.Paragraph>
          </div>
          {walletStatus}
        </div>
        <Alert
          type="warning"
          showIcon
          message="Review every parameter before signing"
          description={`This tool supports native SegWit (bc1q / tb1q) and Taproot (bc1p / tb1p) addresses only; P2PKH and P2SH are not supported. Switch UniSat to the intended network before loading UTXOs. ${workspace === 'csv' ? 'The relative block delay starts after confirmation.' : 'The fixed UTC date can pass before the deposit confirms.'} LocalStorage records are not a backup.`}
        />
        {!wallet.walletDetected && (
          <Alert
            className="mt-16"
            type="info"
            showIcon
            message="UniSat Wallet was not detected"
            description="Install and unlock UniSat, then refresh this page."
            action={
              <Button
                href="https://unisat.io"
                target="_blank"
                icon={<LinkOutlined />}
              >
                Open UniSat
              </Button>
            }
          />
        )}
        <WalletInfoCard
          address={wallet.address}
          chain={wallet.chain}
          openApiKey={openApiKey}
          onOpenApiKeyChange={handleOpenApiKeyChange}
          onSwitchChain={handleSwitchChain}
        />
        <LockWorkspaceNavigation workspace={workspace} busy={busy} />
        <section className="lock-workspace" aria-label={`${workspace.toUpperCase()} workspace`}>
        <OperationPanel
          ticker={ticker}
          brc20Balances={brc20Balances}
          brc20BalancesLoading={brc20BalancesLoading}
          runeBalances={runeBalances}
          runeBalancesLoading={runeBalancesLoading}
          amount={amount}
          assetKind={assetKind}
          runeReference={runeReference}
          lockBlocks={lockBlocks}
          workspace={workspace}
          lockDate={lockDate}
          lockDateError={lockDateError}
          lockCondition={parsedLock.lock}
          busy={busy}
          recordErrors={recordState.errors}
          chainInfo={chainInfo?.requestedChain === wallet.chain ? chainInfo : null}
          chainTimeError={chainTimeError}
          chainTimeLoading={chainTimeLoading}
          canRefreshChainTime={canRefreshChainTime}
          feeRate={feeRate}
          timeLockAddress={timeLockAddress}
          hasOpenApiKey={hasOpenApiKey}
          canCreate={canCreate}
          result={result}
          records={records}
          onTickerChange={(value) => {
            updateDraft({ ticker: value, amount: '' });
            resetBuiltState();
          }}
          onAmountChange={(value) => {
            updateDraft({ amount: value });
            resetBuiltState();
          }}
          onAssetKindChange={(value) => {
            updateDraft({ assetKind: value });
            resetBuiltState();
          }}
          onRuneReferenceChange={(value) => {
            updateDraft({ runeReference: value, amount: '' });
            resetBuiltState();
          }}
          onLockBlocksChange={(value) => {
            updateDraft({ lockBlocks: value });
            resetBuiltState();
          }}
          onLockDateChange={(value) => { cltvDateInitialized.current = true; updateDraft({ lockDate: value }); resetBuiltState(); }}
          onRefreshChainTime={refreshChainTime}
          onFeeRateChange={(value) => {
            updateDraft({ feeRate: value, feeRateManuallySet: true });
            resetBuiltState();
          }}
          onCreate={handleCreate}
          onResume={handleResumeBrc20}
          onUnlock={handleUnlock}
          onCopy={handleCopy}
        />
        <RecoveryPanel controller={recovery} />
        </section>
      </section>
      <footer className="build-footer">
        Source revision: <code>{BUILD_COMMIT_HASH}</code>
      </footer>
    </main>
  );
}

export default App;
