/**
 * Public app config — contract addresses and feature flags.
 * These values are not secrets; they identify which contracts this UI talks to,
 * so validators and users can verify the deployment.
 */

/** PoolFactory contract on Blacklight L2. All pools are created via this factory. */
export const POOL_FACTORY_ADDRESS =
  "0xF25d29a72Ce9Af2dA8E50530C50C49387F4a2820" as const;
