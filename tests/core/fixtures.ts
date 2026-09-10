import { bitcoin } from '@unisat/wallet-bitcoin'
import type { OpenApiUtxo } from '../../src/types'

// Captured from unmodified business source at 53698ae102a97890960d7cff0b106b4393e2722c.
// Public generator key and synthetic outpoints only; no wallet or chain is used.
export const pubKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
export const userAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
export const scriptPk = '0014751e76e8199196d454941c45d1b3a323f1433bd6'
export const csvGolden = {
  addresses: {
    1: 'bc1pj63ggp6petle7scemc2up3nq47jqkykm3vuw8trzpp625g96hdtq4xk7yg',
    3: 'bc1p8qge5jcvc4p89e0dm3ppyfftr94tq05er67hd46yuxdmfy8lf9rqyf3630',
    16: 'bc1pqv5509x8d8j645pmcmhyf8qc04u5gnr66rlau7plhwy0ug9nfjjs0rz09z',
    17: 'bc1pjfyqd39kpternrt9slzajn2lyqrcm4jkkjm66eygx36kcx4dqnsq0fk3ee',
    144: 'bc1pl7fn6687ydrqz22m8g9h3tgaatvnwxwmu8ckg5prqvq4u0mcghgqkmr5wu',
    65535: 'bc1pts8t89zkpyphkenphrfhkl3jl9ksmgsydtcnegl6mzh2g77gzu9smet42f',
  },
  leaf: '029000b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
  controlBlock: 'c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  metadataScript: '6a044241544c510200902079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817980152',
  runestoneValues: ['127', '1111577676', '127', '1', '127', '144', '127', '161825202758953104525843685720298294023', '127', '3468390537006497937951914270391801752', '127', '82'],
  runestoneScript: '6a5d3d7fcca88592047f017f90017f87969cf4dcd298d0d5d8eee59ddf9fb3bef3017f98afe0b7b1aba0f9d9b2a3f1dce5b6fe9b057f52160200c0a233017b01',
  unlockPsbt: '70736274ff01009a0200000002111111111111111111111111111111111111111111111111111111111111111100000000009000000022222222222222222222222222222222222222222222222222222222222222220000000000ffffffff022202000000000000160014751e76e8199196d454941c45d1b3a323f1433bd6c785010000000000160014751e76e8199196d454941c45d1b3a323f1433bd6000000000001012b2202000000000000225120ff933d68fe234601295b3a0b78ad1dead93719dbe1f164502303015e3f7845d02215c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac028029000b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798acc001172050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac00001011fa086010000000000160014751e76e8199196d454941c45d1b3a323f1433bd6000000',
}

export function utxo(byte: string, satoshi = 100000, vout = 0): OpenApiUtxo {
  return { txid: byte.repeat(32), vout, satoshi, scriptPk }
}

export function readPsbt(hex: string) { return bitcoin.Psbt.fromHex(hex) }

// Decode only the serialization produced by the encoder, not Rune allocation or consensus.
export function runestoneValues(script: Buffer): bigint[] {
  const chunks = bitcoin.script.decompile(script)!
  const bytes = Buffer.concat(chunks.slice(2) as Buffer[])
  const values: bigint[] = []
  let value = 0n
  let shift = 0n
  for (const byte of bytes) {
    value |= BigInt(byte & 0x7f) << shift
    if (byte & 0x80) shift += 7n
    else { values.push(value); value = 0n; shift = 0n }
  }
  return values
}
