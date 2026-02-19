// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";
import {IRewardPolicy} from "../../src/interfaces/IRewardPolicy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title E2EBlacklightForkTest
/// @notice End-to-end tests against a fork of the real Blacklight L2.
/// @dev    Requires a fork: run `anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz`
///         then `forge test --match-path "test/e2e/E2EBlacklightFork.t.sol" -vvv`
///
///         Set in .env (or environment):
///           NIL_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS, REWARD_POLICY_ADDRESS (or use defaults)
///           OPERATOR_NODE_WALLET, POOL_OWNER_ADDRESS, WHALE_ADDRESS (address with NIL)
///           DEPLOYER_PRIVATE_KEY
contract E2EBlacklightForkTest is Test {
    address constant NIL_ADDR = 0x32DEAe728473cb948B4D8661ac0f2755133D4173;
    address constant STAKING_ADDR = 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69;
    address constant REWARD_POLICY_ADDR = 0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B;

    IERC20 nil;
    IStakingOperators staking;
    IRewardPolicy rewardPolicy;
    BlacklightPool pool;
    PoolFactory factory;

    address operatorNode;
    address poolOwner;
    address whale;
    uint256 deployerKey;

    uint256 constant COMMISSION_BPS = 500;
    uint256 constant MIN_STAKE = 500 * 1e6; // 500 NIL (6 decimals)

    function setUp() public {
        // Requires anvil: `anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz`
        // Or use direct RPC: vm.createSelectFork("blacklight")
        vm.createSelectFork("anvil");

        nil = IERC20(NIL_ADDR);
        address stakingAddr = STAKING_ADDR;
        address rewardAddr = REWARD_POLICY_ADDR;

        staking = IStakingOperators(stakingAddr);
        rewardPolicy = IRewardPolicy(rewardAddr);

        operatorNode = makeAddr("e2eForkOperator"); // Fresh operator (no prior stake) so createPool succeeds
        poolOwner = vm.envAddress("POOL_OWNER_ADDRESS");
        whale = vm.envAddress("WHALE_ADDRESS");
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address platformFeeRecipient = vm.envOr("PLATFORM_FEE_RECIPIENT", address(0x0000000000000000000000000000000000000001));

        vm.startBroadcast(deployerKey);
        factory = new PoolFactory(address(nil), stakingAddr, rewardAddr, platformFeeRecipient);
        address poolAddr = factory.createPool(operatorNode, poolOwner, COMMISSION_BPS, MIN_STAKE);
        vm.stopBroadcast();

        pool = BlacklightPool(payable(poolAddr));
    }

    function test_operatorApprovesPoolAsStaker() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));

        assertEq(staking.approvedStaker(operatorNode), address(pool));
    }

    function test_whaleStakesIntoPool_idlePhase() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));

        uint256 amount = 10_000 * 1e6; // 10,000 NIL (6 decimals)
        vm.prank(whale);
        nil.approve(address(pool), amount);

        vm.prank(whale);
        pool.stake(amount);

        (uint256 proc, uint256 staked,,) = pool.stakers(whale);
        assertEq(proc + staked, amount);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Idle));
    }

    function test_activateOperator_transitionsToActive() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));

        uint256 activateAmount = 70_000 * 1e6; // 70,000 NIL (6 decimals)
        vm.prank(whale);
        nil.approve(address(pool), activateAmount);
        vm.prank(whale);
        pool.stake(activateAmount);

        vm.prank(poolOwner);
        pool.activateOperator(activateAmount);

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));
        assertTrue(pool.operatorInitialized());
        assertGe(staking.stakeOf(operatorNode), 70_000 * 1e6); // staking.stakeOf returns 6 decimals
    }

    function test_fullWithdrawFlow_onFork() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));

        // Stake 75k so we can withdraw 5k and still be above 70k minimum
        uint256 stakeAmount = 75_000 * 1e6; // 75,000 NIL (6 decimals)
        vm.prank(whale);
        nil.approve(address(pool), stakeAmount);
        vm.prank(whale);
        pool.stake(stakeAmount);

        // Activate with 70k (minimum required), then forward remaining 5k so 75k at node (70k + 5k withdrawal)
        uint256 activateAmount = 70_000 * 1e6; // 70,000 NIL (6 decimals)
        vm.prank(poolOwner);
        pool.activateOperator(activateAmount);
        pool.forwardStakeToNode();

        uint256 withdrawAmount = 5_000 * 1e6; // 5,000 NIL (6 decimals)
        vm.prank(whale);
        pool.requestWithdraw(withdrawAmount);

        vm.prank(poolOwner);
        pool.processWithdrawalBatch(10);

        uint256 delay = staking.unstakeDelay();
        vm.warp(block.timestamp + delay + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        uint256 balBefore = nil.balanceOf(whale);
        vm.prank(whale);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(whale), balBefore + withdrawAmount);
    }

    /// @notice E2E: UI workflow - pool calls stakeTo (activateOperator), then pool calls stakeTo again (forwardStakeToNode).
    ///         Verifies operatorStaker binding and that additional stakeTo works.
    function test_poolStakeTo_thenForwardStakeToNode_operatorStaker() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6; // 75k NIL
        vm.prank(whale);
        nil.approve(address(pool), stakeAmount);
        vm.prank(whale);
        pool.stake(stakeAmount);

        // Verify approvedStaker before activation
        assertEq(staking.approvedStaker(operatorNode), address(pool), "approvedStaker should be pool before activate");

        // Step 1: activateOperator - pool calls stakeTo (first time)
        uint256 activateAmount = 70_000 * 1e6;
        vm.prank(poolOwner);
        pool.activateOperator(activateAmount);

        // Verify operatorStaker and approvedStaker after first stakeTo
        address opStaker = _operatorStaker(operatorNode);
        assertEq(opStaker, address(pool), "operatorStaker(operator) should be pool after activate");
        assertEq(staking.approvedStaker(operatorNode), address(0), "approvedStaker should be 0 after activate");
        assertGe(staking.stakeOf(operatorNode), 70_000 * 1e6, "stake on node >= 70k");

        // Pool has 5k NIL left (75k - 70k). Forward it - pool calls stakeTo again (second time)
        uint256 poolBalance = nil.balanceOf(address(pool));
        assertEq(poolBalance, 5_000 * 1e6, "pool should have 5k NIL");
        vm.prank(poolOwner);
        pool.forwardStakeToNode();

        // Verify second stakeTo succeeded
        assertGe(staking.stakeOf(operatorNode), 75_000 * 1e6, "stake on node should be 75k after forward");
        assertEq(nil.balanceOf(address(pool)), 0, "pool NIL should be 0 after forward");
        assertEq(_operatorStaker(operatorNode), address(pool), "operatorStaker should still be pool");
    }

    function _operatorStaker(address operator) internal view returns (address) {
        (bool ok, bytes memory data) = address(staking).staticcall(
            abi.encodeWithSignature("operatorStaker(address)", operator)
        );
        require(ok, "operatorStaker call failed");
        return abi.decode(data, (address));
    }
}
