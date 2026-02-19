// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PoolFactory} from "../src/PoolFactory.sol";

/// @title  DeployBlacklightPool
/// @notice Deploys PoolFactory only. Pool creation is done via the UI or E2E tests.
///
///         Usage (single-line so copy-paste works; paste as one line in the terminal):
///           source .env 2>/dev/null || true
///           forge script script/Deploy.s.sol:DeployBlacklightPool --rpc-url http://127.0.0.1:8545 --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
///
///         Required .env:
///           NIL_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS, REWARD_POLICY_ADDRESS,
///           PLATFORM_FEE_RECIPIENT (address to receive 1%% platform fee; required),
///           DEPLOYER_PRIVATE_KEY (pass same key via --private-key when broadcasting)
contract DeployBlacklightPool is Script {
    function run() external returns (bytes memory) {
        address nilToken = vm.envAddress("NIL_TOKEN_ADDRESS");
        address stakingContract = vm.envAddress("STAKING_CONTRACT_ADDRESS");
        address rewardPolicy = vm.envAddress("REWARD_POLICY_ADDRESS");
        address platformFeeRecipient = vm.envAddress("PLATFORM_FEE_RECIPIENT");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("Deploying PoolFactory...");
        console2.log("  NIL token:             ", nilToken);
        console2.log("  Staking contract:      ", stakingContract);
        console2.log("  Reward policy:         ", rewardPolicy);
        console2.log("  Platform fee recipient:", platformFeeRecipient);

        vm.startBroadcast(deployerKey);
        PoolFactory factory = new PoolFactory(nilToken, stakingContract, rewardPolicy, platformFeeRecipient);
        vm.stopBroadcast();

        address factoryAddr = address(factory);
        console2.log("PoolFactory deployed at:", factoryAddr);
        console2.log("Implementation at:     ", address(factory.implementation()));
        console2.log("");
        console2.log("NEXT STEPS:");
        console2.log("  1. Create pools via UI or factory.createPool(operator, owner, commissionBps, minStake)");
        console2.log("  2. Node operator calls approveStaker(poolAddress) on the staking contract.");

        return abi.encode(factoryAddr);
    }
}
