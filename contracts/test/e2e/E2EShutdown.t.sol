// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title E2EShutdownTest
/// @notice E2E tests for the shutdown workflow against Blacklight fork.
///         Initiate shutdown → cooling-off → confirm → requestWithdraw bypasses 70k floor.
/// @dev    Run: anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz
///         Then: forge test --match-path "test/e2e/E2EShutdown.t.sol" -vvv
///         Requires .env: DEPLOYER_PRIVATE_KEY
contract E2EShutdownTest is Test {
    address constant NIL_ADDR = 0x32DEAe728473cb948B4D8661ac0f2755133D4173;
    address constant STAKING_ADDR = 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69;
    address constant REWARD_POLICY_ADDR = 0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B;

    address NODE_WALLET; // Fresh operator (set in setUp)
    address poolOwner;   // Pool owner (deployer); must differ from operator
    address constant PLATFORM_FEE_RECIPIENT = 0x0000000000000000000000000000000000000001;
    address stakerUser;

    IERC20 nil;
    BlacklightPool pool;
    PoolFactory factory;

    uint256 deployerKey;
    uint256 constant COMMISSION_BPS = 500;
    uint256 constant MIN_STAKE = 500 * 1e6;
    uint256 constant ACTIVATE_AMOUNT = 70_000 * 1e6;

    function setUp() public {
        vm.createSelectFork("anvil");

        nil = IERC20(NIL_ADDR);
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        stakerUser = makeAddr("stakerUser");
        NODE_WALLET = makeAddr("e2eShutdownNodeWallet");

        deal(address(nil), NODE_WALLET, 10 * 1e6);
        deal(address(nil), stakerUser, 200_000 * 1e6);

        poolOwner = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);
        factory = new PoolFactory(address(nil), STAKING_ADDR, REWARD_POLICY_ADDR, PLATFORM_FEE_RECIPIENT);
        address poolAddr = factory.createPool(NODE_WALLET, poolOwner, COMMISSION_BPS, MIN_STAKE);
        vm.stopBroadcast();

        pool = BlacklightPool(payable(poolAddr));
    }

    /// @notice Owner initiates shutdown; pool enters cooling-off; owner can cancel.
    function test_e2e_shutdown_initiateAndCancelByOwner() public {
        vm.prank(NODE_WALLET);
        IStakingOperators(STAKING_ADDR).approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        vm.prank(poolOwner);
        pool.initiateShutdown();

        assertEq(pool.shutdownInitiatedAt(), block.timestamp);
        assertEq(pool.shutdownInitiatedBy(), poolOwner);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));

        vm.prank(poolOwner);
        pool.cancelShutdown();

        assertEq(pool.shutdownInitiatedAt(), 0);
        assertEq(pool.shutdownInitiatedBy(), address(0));
    }

    /// @notice Keeper initiates shutdown; only keeper can cancel during cooling-off.
    function test_e2e_shutdown_initiateByKeeper_onlyKeeperCanCancel() public {
        vm.prank(NODE_WALLET);
        IStakingOperators(STAKING_ADDR).approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        vm.prank(PLATFORM_FEE_RECIPIENT);
        pool.initiateShutdownByKeeper();

        vm.prank(poolOwner);
        vm.expectRevert(BlacklightPool.NotAuthorizedToCancelShutdown.selector);
        pool.cancelShutdown();

        vm.prank(PLATFORM_FEE_RECIPIENT);
        pool.cancelShutdown();

        assertEq(pool.shutdownInitiatedAt(), 0);
    }

    /// @notice Full shutdown: initiate → confirm after cooling-off → stake blocked; 70k floor bypassed.
    function test_e2e_shutdown_fullWorkflow_stakeBlocked_and70kFloorBypassed() public {
        vm.prank(NODE_WALLET);
        IStakingOperators(STAKING_ADDR).approveStaker(address(pool));

        uint256 stakeAmount = 80_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        vm.prank(poolOwner);
        pool.initiateShutdown();

        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);

        vm.prank(stakerUser);
        pool.confirmShutdown();

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.ShuttingDown));

        address newStaker = makeAddr("newStaker");
        deal(address(nil), newStaker, 10_000 * 1e6);
        vm.startPrank(newStaker);
        nil.approve(address(pool), 10_000 * 1e6);
        vm.expectRevert(BlacklightPool.OperatorNotInitialized.selector);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();

        // stakerUser has 80k total (70k at node + 10k processing after activate); request full staked amount - allowed in ShuttingDown (70k floor bypassed)
        (, uint256 staked,,) = pool.stakers(stakerUser);
        vm.prank(stakerUser);
        pool.requestWithdraw(staked);
        pool.processWithdrawalBatch(10); // reduce totalUserStakes so assertion holds

        assertLt(pool.totalUserStakes(), 70_000 * 1e6, "total dropped below 70k after full exit");
    }
}
