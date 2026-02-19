// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../src/BlacklightPool.sol";
import {IStakingOperators} from "../src/interfaces/IStakingOperators.sol";
import {IRewardPolicy} from "../src/interfaces/IRewardPolicy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockToken {
    string public name = "Mock NIL";
    string public symbol = "mNIL";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

contract MockStakingOperators is IStakingOperators {
    mapping(address => uint256) public override stakeOf;
    mapping(address => address) public override approvedStaker;
    mapping(address => address) public override operatorStaker;
    uint256 public override unstakeDelay;

    address public token;
    address[] internal _activeOperators;

    constructor(address _token) {
        token = _token;
        unstakeDelay = 7 days;
    }

    function stakeTo(address operator, uint256 amount) external override {
        require(approvedStaker[operator] == msg.sender || operatorStaker[operator] == msg.sender, "not approved");
        MockToken(token).transferFrom(msg.sender, address(this), amount);
        stakeOf[operator] += amount;
        if (operatorStaker[operator] == address(0)) operatorStaker[operator] = msg.sender;
    }

    function requestUnstake(address operator, uint256) external view override {
        require(approvedStaker[operator] == msg.sender || operatorStaker[operator] == msg.sender, "not approved");
    }

    function withdrawUnstaked(address operator) external view override {
        require(approvedStaker[operator] == msg.sender || operatorStaker[operator] == msg.sender, "not approved");
    }

    function approveStaker(address staker) external override {
        approvedStaker[msg.sender] = staker;
    }

    function stakingToken() external view override returns (address) {
        return token;
    }

    function totalStaked() external view override returns (uint256) {
        uint256 total;
        for (uint256 i = 0; i < _activeOperators.length; i++) {
            total += stakeOf[_activeOperators[i]];
        }
        return total;
    }

    function isActiveOperator(address operator) external view override returns (bool) {
        return approvedStaker[operator] != address(0);
    }

    function getOperatorInfo(address operator) external view override returns (OperatorInfo memory) {
        return OperatorInfo({
            active: approvedStaker[operator] != address(0),
            metadataURI: ""
        });
    }

    function getUnbondingTranches(address) external pure override returns (Tranche[] memory) {
        return new Tranche[](0);
    }

    function stakeAt(address operator, uint64 snapshotId) external view override returns (uint256) {
        operator;
        snapshotId;
        return stakeOf[operator];
    }

    function getActiveOperators() external view override returns (address[] memory) {
        return _activeOperators;
    }

    // helper for tests
    function setApprovedStaker(address operator, address staker) external {
        approvedStaker[operator] = staker;
        if (staker != address(0)) {
            bool found;
            for (uint256 i = 0; i < _activeOperators.length; i++) {
                if (_activeOperators[i] == operator) {
                    found = true;
                    break;
                }
            }
            if (!found) _activeOperators.push(operator);
        }
    }
}

contract MockRewardPolicy is IRewardPolicy {
    IERC20 public override rewardToken;
    mapping(address => uint256) public override rewards;

    constructor(address _token) {
        rewardToken = IERC20(_token);
    }

    function claim() external override {}
}

contract BlacklightPoolLifecycleTest is Test {
    MockToken internal token;
    MockStakingOperators internal staking;
    MockRewardPolicy internal rewards;
    BlacklightPool internal pool;

    address internal owner = address(0xA1);
    address internal operator = address(0xB1);
    address internal user = address(0xC1);
    address internal platformFeeRecipient = address(0xD1);

    function setUp() public {
        token = new MockToken();
        staking = new MockStakingOperators(address(token));
        rewards = new MockRewardPolicy(address(token));

        pool = new BlacklightPool(address(token), address(staking), address(rewards), platformFeeRecipient);

        // fund owner and user
        token.mint(owner, 100_000 * 1e6);
        token.mint(user, 100_000 * 1e6);

        vm.prank(owner);
        pool.initialize(operator, owner, 0, 500 * 1e6);
    }

    function testStakeInIdlePhaseAllowed() public {
        staking.setApprovedStaker(operator, address(pool));
        // owner stakes while pool is Idle
        vm.startPrank(owner);
        token.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();

        (uint256 proc, uint256 staked,,) = pool.stakers(owner);
        assertEq(proc + staked, 10_000 * 1e6);
    }

    function testImmediateWithdrawInIdlePhase() public {
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);

        uint256 balBefore = token.balanceOf(owner);
        pool.withdrawProcessingStake(5_000 * 1e6);
        uint256 balAfter = token.balanceOf(owner);
        vm.stopPrank();

        assertEq(balAfter, balBefore + 5_000 * 1e6);
        (uint256 proc, uint256 staked,,) = pool.stakers(owner);
        assertEq(proc + staked, 5_000 * 1e6);
    }

    function testActivateOperatorRequiresApprovedStaker() public {
        // Without approval, stake() would revert; pool has no processing stake. Mint to pool to have balance.
        token.mint(address(pool), 70_000 * 1e6);

        // no approved staker set yet → should revert
        vm.prank(owner);
        vm.expectRevert(BlacklightPool.OperatorNotUsingPoolAsStaker.selector);
        pool.activateOperator(70_000 * 1e6);

        // set approved staker, then owner must stake so totalProcessingStake >= 70k
        staking.setApprovedStaker(operator, address(pool));
        token.mint(owner, 70_000 * 1e6);
        vm.startPrank(owner);
        token.approve(address(pool), 70_000 * 1e6);
        pool.stake(70_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        assertTrue(pool.operatorInitialized());
    }

    function testWithdrawalRespectsPoolFloorAfterActivation() public {
        // prepare: operator approves pool, then owner stakes and activate
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 80_000 * 1e6);
        pool.stake(80_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        // now a withdrawal that would drop totalUserStakes below 70k should revert
        vm.startPrank(owner);
        vm.expectRevert();
        pool.requestWithdraw(20_001 * 1e6);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  SHUTDOWN (Active pools only; 1-day cooling-off)
    // ─────────────────────────────────────────────────────────────────────

    function testShutdown_initiateAndCancelByOwner() public {
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 80_000 * 1e6);
        pool.stake(80_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        vm.prank(owner);
        pool.initiateShutdown();
        assertGt(pool.shutdownInitiatedAt(), 0);
        assertEq(pool.shutdownInitiatedBy(), owner);

        vm.prank(owner);
        pool.cancelShutdown();
        assertEq(pool.shutdownInitiatedAt(), 0);
        assertEq(pool.shutdownInitiatedBy(), address(0));
    }

    function testShutdown_confirmAfterCoolingOff_transitionsToShuttingDown() public {
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 80_000 * 1e6);
        pool.stake(80_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        vm.prank(owner);
        pool.initiateShutdown();

        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);

        vm.prank(user);
        pool.confirmShutdown();

        assertEq(uint8(pool.poolPhase()), 3); // PoolPhase.ShuttingDown = 3
    }

    function testShutdown_stakeBlockedWhenShuttingDown() public {
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 80_000 * 1e6);
        pool.stake(80_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        vm.prank(owner);
        pool.initiateShutdown();
        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);
        pool.confirmShutdown();

        vm.startPrank(user);
        token.approve(address(pool), 5_000 * 1e6);
        vm.expectRevert(BlacklightPool.OperatorNotInitialized.selector);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
    }

    function testShutdown_requestWithdrawBypasses70kFloorInShuttingDown() public {
        staking.setApprovedStaker(operator, address(pool));
        vm.startPrank(owner);
        token.approve(address(pool), 80_000 * 1e6);
        pool.stake(80_000 * 1e6);
        pool.activateOperator(70_000 * 1e6);
        vm.stopPrank();

        vm.prank(owner);
        pool.initiateShutdown();
        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);
        pool.confirmShutdown();

        // Owner requests full exit (70k at-node) - would normally revert (below 70k floor)
        vm.prank(owner);
        pool.requestWithdraw(70_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 70_000 * 1e6);
        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalUserStakes(), 10_000 * 1e6);
    }
}

