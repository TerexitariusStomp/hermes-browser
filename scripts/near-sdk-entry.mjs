// near-sdk-entry.mjs — esbuild entry for dist/vendor/near-sdk.mjs.
// Re-exports exactly the audited-SDK surface near-bridge.js consumes; the
// bundle keeps every protocol byte inside published libraries (the <5%
// custom-code rule — near-bridge is glue, never serialization/crypto).
export * from 'near-api-js'
export {
  createNearX402Client,
  createNearPaymentFetch,
  createFastNearWalletSigner,
  x402Client,
} from '@fastnear/x402'
export {
  createOneClickClient,
  buildIntentMessage,
  toSignedIntent,
  encodeIntentSignature,
  randomNonce,
  INTENTS_CONTRACT_ID,
  SOLVER_RELAY_URL,
  ONE_CLICK_BASE_URL,
} from '@fastnear/intents'
export { ClientFactory } from '@a2a-js/sdk/client'
