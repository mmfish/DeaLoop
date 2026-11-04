// Shared product limits. Issued grants retain their recorded expiry and allowance.
export const maxImageBytes = 10_000_000;
export const maxImageSide = 12_000;
export const maxImagePixels = 64_000_000;
export const manualTokenSeconds = 72 * 60 * 60;
export const pendingConnectionSeconds = 6 * 60 * 60;
export const authorizationCodeSeconds = 10 * 60;
export const agentPostAllowance = 200;
export const offerItemCharacters = 5_000;
export const negotiationListLimit = 1_000;
// Accommodate multi-byte/JSON-escaped 5,000-character offer descriptions.
export const marketplaceJsonBytes = 64_000;
