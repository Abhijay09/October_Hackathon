// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "../utils/Fixture.sol";
import {AgentWallet} from "../../src/AgentWallet.sol";
import {RBIRules} from "../../src/lib/RBIRules.sol";

/// @dev Drives random agent / attacker / owner / guardian behaviour through the real EntryPoint and
///      keeps ghost accounting of every authorised outflow.
contract WalletHandler is Fixture {
    uint256 public ghostAuthorisedOutflow; // agent in-policy payments + owner-approved pendings
    mapping(uint64 => uint256) public ghostAgentSpendByDay;
    uint64[] public daysSeen;
    uint256 public ghostOwnerWithdrawals;
    uint256 public calls;

    function _agentOp(bytes memory callData) internal returns (bool ok) {
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, callData);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        uint256 before = inr.balanceOf(address(wallet));
        vm.prank(bundler, bundler);
        try ep.handleOps(ops, bundler) {
            ok = true;
        } catch {}
        uint256 afterwards = inr.balanceOf(address(wallet));
        if (afterwards < before) {
            uint64 day = RBIRules.istDay(block.timestamp);
            if (ghostAgentSpendByDay[day] == 0) daysSeen.push(day);
            ghostAgentSpendByDay[day] += before - afterwards;
            ghostAuthorisedOutflow += before - afterwards;
        }
        calls++;
    }

    function agentPay(uint8 merchantIdx, uint256 amountRupees, uint32 warpSeconds) external {
        vm.warp(block.timestamp + (warpSeconds % 3 hours));
        address[3] memory m = [kirana, railtix, apiCredits];
        _agentOp(payCall(m[merchantIdx % 3], bound(amountRupees, 1, 25_000) * 100));
    }

    function agentDrainToAttacker(uint256 amountRupees) external {
        bytes memory drain = abi.encodeCall(IERC20.transfer, (attacker, bound(amountRupees, 1, 60_000) * 100));
        _agentOp(agentCall(address(inr), drain, proofFor(kirana)));
    }

    function agentApproveAttacker() external {
        _agentOp(agentCall(address(inr), abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)), new bytes32[](0)));
    }

    function agentSelfCall() external {
        bytes memory esc = abi.encodeCall(AgentWallet.setPolicyRoot, (bytes32(uint256(1))));
        _agentOp(agentCall(address(wallet), esc, new bytes32[](0)));
    }

    function attackerUsesOwnKey(uint256 amountRupees) external {
        PackedUserOperation memory op = buildOp(
            address(wallet),
            attackerPk,
            abi.encodeCall(
                AgentWallet.executeAsAgent,
                (attacker, address(inr), abi.encodeCall(IERC20.transfer, (attacker, bound(amountRupees, 1, 50_000) * 100)), new bytes32[](0))
            )
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        try ep.handleOps(ops, bundler) {} catch {}
        calls++;
    }

    function ownerUnfreeze() external {
        if (!wallet.frozen()) return;
        vm.prank(owner);
        wallet.unfreeze(address(0), address(0));
    }

    function ownerApproveLatest() external {
        uint256 id = wallet.pendingCount();
        if (id == 0) return;
        AgentWallet.PendingRequest memory p = wallet.getPending(id);
        // A careful owner only approves payments to known merchants.
        if (p.status != AgentWallet.PendingStatus.Open || p.reason != AgentWallet.Reason.OverAfaLimit) return;
        uint256 before = inr.balanceOf(address(wallet));
        vm.prank(owner);
        try wallet.approvePending(id) {} catch {}
        ghostAuthorisedOutflow += before - inr.balanceOf(address(wallet));
    }

    function ownerWithdraw(uint256 amountRupees) external {
        uint256 amount = bound(amountRupees, 1, 5_000) * 100;
        if (amount > inr.balanceOf(address(wallet))) return;
        vm.prank(owner);
        wallet.execute(address(inr), 0, abi.encodeCall(IERC20.transfer, (bank, amount)));
        ghostOwnerWithdrawals += amount;
    }

    function guardiansStartRecovery() external {
        (address pending,,,) = wallet.recovery();
        if (pending != address(0)) return;
        vm.prank(guardians[0]);
        wallet.proposeRecovery(attacker);
        vm.prank(guardians[1]);
        wallet.supportRecovery();
    }

    function ownerVeto() external {
        (address pending,,,) = wallet.recovery();
        if (pending == address(0)) return;
        vm.prank(owner);
        wallet.cancelRecovery();
    }

    function daysCount() external view returns (uint256) {
        return daysSeen.length;
    }

    // expose fixture state to the invariant contract
    function walletAddr() external view returns (address) {
        return address(wallet);
    }

    function tokenAddr() external view returns (address) {
        return address(inr);
    }

    function attackerAddr() external view returns (address) {
        return attacker;
    }

    function ownerAddr() external view returns (address) {
        return owner;
    }

    function pmAddr() external view returns (address) {
        return address(pm);
    }
}

contract WalletInvariantTest is Test {
    WalletHandler internal handler;
    IERC20 internal inr;
    AgentWallet internal wallet;
    uint256 internal initialBalance;

    function setUp() public {
        handler = new WalletHandler();
        vm.deal(address(handler), 1_000 ether);
        handler.setUp();
        inr = IERC20(handler.tokenAddr());
        wallet = AgentWallet(payable(handler.walletAddr()));
        initialBalance = inr.balanceOf(address(wallet));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = WalletHandler.agentPay.selector;
        selectors[1] = WalletHandler.agentPay.selector; // weight honest traffic higher
        selectors[2] = WalletHandler.agentDrainToAttacker.selector;
        selectors[3] = WalletHandler.agentApproveAttacker.selector;
        selectors[4] = WalletHandler.agentSelfCall.selector;
        selectors[5] = WalletHandler.attackerUsesOwnKey.selector;
        selectors[6] = WalletHandler.ownerUnfreeze.selector;
        selectors[7] = WalletHandler.ownerApproveLatest.selector;
        selectors[8] = WalletHandler.ownerWithdraw.selector;
        selectors[9] = WalletHandler.guardiansStartRecovery.selector;
        selectors[10] = WalletHandler.ownerVeto.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Smoke check that the handler's honest path really settles payments (so the invariants
    /// are exercised against real outflows, not just reverts).
    function test_handlerHonestPathSettles() public {
        handler.agentPay(0, 1_000, 0);
        assertEq(handler.ghostAuthorisedOutflow(), 1_000 * 100);
        handler.agentDrainToAttacker(500);
        assertTrue(wallet.frozen());
        handler.ownerUnfreeze();
        assertFalse(wallet.frozen());
    }

    /// The attacker never receives a single paisa, by any path.
    function invariant_attackerGetsNothing() public view {
        assertEq(inr.balanceOf(handler.attackerAddr()), 0);
        assertEq(inr.allowance(address(wallet), handler.attackerAddr()), 0);
    }

    /// Agent-driven outflow per IST day never exceeds the daily limit (₹20,000).
    function invariant_agentSpendWithinDailyLimit() public view {
        uint256 n = handler.daysCount();
        for (uint256 i; i < n; ++i) {
            assertLe(handler.ghostAgentSpendByDay(handler.daysSeen(i)), 20_000 * 100);
        }
    }

    /// Funds only move via the owner, an in-policy agent payment, or an owner-approved request.
    function invariant_everyOutflowIsAuthorised() public view {
        assertEq(
            inr.balanceOf(address(wallet)),
            initialBalance - handler.ghostAuthorisedOutflow() - handler.ghostOwnerWithdrawals()
        );
    }

    /// Ownership can only change through a completed recovery, which the handler never completes.
    function invariant_ownerUnchanged() public view {
        assertEq(wallet.owner(), handler.ownerAddr());
    }

    /// The policy root can never be changed by the agent.
    function invariant_policyRootIntact() public view {
        assertTrue(wallet.policyRoot() != bytes32(uint256(1)));
    }
}
