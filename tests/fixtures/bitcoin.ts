// Signed Bitcoin transactions as WalletAccountBtc.signTransaction returns them (raw hex), each with
// one dummy input and one output to `DEPOSIT_ADDRESS` (fixtures/gateway.ts). Hardcoded rather
// than built at test time, so no test needs an ECC library of its own.

/** Pays the deposit address exactly the 50,000 sats `onrampQuote` asks for. */
export const SIGNED_TX_HEX =
  '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff' +
  '0150c3000000000000225120b3ca4128b32c21f60bab796f393690cc7910b4d852ff1ce3dddeb98d03d758da00000000'
export const SIGNED_TXID = 'e6273662cf9e5eb6afcc1cfe9526d8a73e26cd60293c72263a04264704d7a4d2'

/** Pays the deposit address one sat short: 49,999 sats. */
export const UNDERPAYING_TX_HEX =
  '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff' +
  '014fc3000000000000225120b3ca4128b32c21f60bab796f393690cc7910b4d852ff1ce3dddeb98d03d758da00000000'
export const UNDERPAYING_TXID = '1218c2f8f19797831dddb52811457e778bbecb9b4b9b04f0b91d45607cd2bc0b'

/** Pays the deposit address one sat over: 50,001 sats. */
export const OVERPAYING_TX_HEX =
  '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff' +
  '0151c3000000000000225120b3ca4128b32c21f60bab796f393690cc7910b4d852ff1ce3dddeb98d03d758da00000000'
export const OVERPAYING_TXID = '9982239a393040fdbcfb9acc7abce8114c801e22f602308f64756de39710938d'

/** Pays the deposit address the 100,000 sats the `examples/` scripts swidge. */
export const EXAMPLE_TX_HEX =
  '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff' +
  '01a086010000000000225120b3ca4128b32c21f60bab796f393690cc7910b4d852ff1ce3dddeb98d03d758da00000000'
export const EXAMPLE_TXID = '410b24406afd9e2831ecb2058610dd10606ddb795ebf1d7c779f2fda4d9ae602'
