import type { Network } from "@blend-capital/blend-sdk";
import { Networks } from "@stellar/stellar-sdk";

type SupportedNetwork = "testnet" | "mainnet";

const DEFAULT_RPC_ENDPOINTS: Record<SupportedNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

/**
 * Get the Blend network configuration
 * Uses mainnet (public) by default
 */
export function getBlendNetwork(): Network {
  const networkType = (process.env.STELLAR_NETWORK || "mainnet").toLowerCase();

  let networkKey: SupportedNetwork;
  if (
    networkType === "public" ||
    networkType === "mainnet" ||
    networkType.includes("public global stellar network")
  ) {
    networkKey = "mainnet";
  } else if (
    networkType === "testnet" ||
    networkType.includes("test network") ||
    networkType.includes("test sdf network")
  ) {
    networkKey = "testnet";
  } else {
    console.warn(
      `Unknown network type: ${networkType}, defaulting to mainnet`
    );
    networkKey = "mainnet";
  }

  const rpc =
    process.env.STELLAR_RPC_URL ||
    process.env.RPC_URL ||
    DEFAULT_RPC_ENDPOINTS[networkKey];

  console.info(
    `[blend] network configuration -> network=${networkKey}, rpc=${rpc}`
  );

  return {
    rpc,
    passphrase: networkKey === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  };
}
