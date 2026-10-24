// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "./utils/Fixture.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {PolicyPaymaster} from "../src/PolicyPaymaster.sol";
import {MockYieldVault} from "../src/mocks/MockYieldVault.sol";

/// @notice The hijack suite: each test is an attack a leaked key or a prompt-injected agent could try.
///         The containment property checked throughout: the attacker gets ₹0 and agent losses never
///         exceed the daily limit.
contract AttacksTest is Fixture {
    function _assertContained() internal view {
        assertEq(inr.balanceOf(attacker), 0, "attacker must get nothing");
        (,,, uint128 spent) = wallet.usage(agent);
        assertLe(spent, rs(20_000), "agent spend within daily limit");
    }

    function _assertFrozenFor(AgentWallet.Reason reason) internal view {
        assertTrue(wallet.frozen(), "agent frozen");
        assertEq(uint8(wallet.lastFreezeReason()), uint8(reason));
    }

    /// 1. Prompt injection: "send all funds to this address".
    function test_attack01_promptInjectedDrainToAttacker() public {
        bytes memory drain = abi.encodeCall(IERC20.transfer, (attacker, rs(50_000)));
        send(buildOp(address(wallet), agentPk, agentCall(address(inr), drain, proofFor(kirana))));
        _assertFrozenFor(AgentWallet.Reason.NotAllowlisted);
        _assertContained();
        assertEq(uint8(lastPendingReason()), uint8(AgentWallet.Reason.NotAllowlisted), "queued for owner review");
    }

    /// 2. Malicious approval: grant the attacker an unlimited allowance to pull funds later.
    function test_attack02_unlimitedApproval() public {
        bytes memory approve = abi.encodeCall(IERC20.approve, (attacker, type(uint256).max));
        send(buildOp(address(wallet), agentPk, agentCall(address(inr), approve, new bytes32[](0))));
        _assertFrozenFor(AgentWallet.Reason.ForbiddenSelector);
        assertEq(inr.allowance(address(wallet), attacker), 0);
    }

    /// 3. Arbitrary contract call outside the allowlist.
    function test_attack03_nonAllowlistedContract() public {
        bytes memory call = abi.encodeWithSignature("withdrawTo(address,uint256)", attacker, 1 ether);
        send(buildOp(address(wallet), agentPk, agentCall(address(pm), call, new bytes32[](0))));
        _assertFrozenFor(AgentWallet.Reason.NotAllowlisted);
    }

    /// 4. Salami slicing: many in-limit payments to an allowlisted merchant until the day is drained.
    function test_attack04_salamiSlicingStopsAtDailyLimit() public {
        uint256 before = inr.balanceOf(address(wallet));
        for (uint256 i; i < 5; ++i) {
            agentPays(kirana, rs(4_999));
            vm.warp(block.timestamp + 61 minutes); // stay under the hourly velocity limit
        }
        _assertFrozenFor(AgentWallet.Reason.DailyLimit);
        assertEq(before - inr.balanceOf(address(wallet)), rs(4_999) * 4, "loss capped at daily limit");
        _assertContained();

        // once frozen, further ops cannot even pass validation (so they cost the paymaster nothing)
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(1)));
        expectFailedOp("AA24 signature error");
        send(op);
    }

    /// 5. Velocity burst: rapid-fire tiny payments (the pattern of a looping, hijacked agent).
    function test_attack05_velocityBurst() public {
        for (uint256 i; i < 6; ++i) {
            agentPays(apiCredits, rs(10));
        }
        _assertFrozenFor(AgentWallet.Reason.VelocityLimit);
        assertEq(inr.balanceOf(apiCredits), rs(50), "only the first 5 settle");
    }

    /// 6a. Cross-chain replay: an op signed for this chain is useless on another chain id.
    function test_attack06a_crossChainReplay() public {
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        vm.chainId(1);
        // The paymaster hash also binds the chain, so either signature check may trip first.
        vm.expectRevert();
        send(op);
        assertEq(inr.balanceOf(kirana), 0);
    }

    /// 6b. Same-chain replay of an already-executed op.
    function test_attack06b_nonceReplay() public {
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        send(op);
        expectFailedOp("AA25 invalid account nonce");
        send(op);
        assertEq(inr.balanceOf(kirana), rs(100));
    }

    /// 6c. Cross-wallet replay: the same agent key is a session on a second wallet.
    function test_attack06c_crossWalletReplay() public {
        AgentWallet wallet2 =
            new AgentWallet(IEntryPoint(address(ep)), IERC20(address(inr)), owner, address(pm), guardians);
        inr.mint(address(wallet2), rs(10_000));
        vm.startPrank(owner);
        wallet2.setPolicyRoot(root);
        wallet2.addSession(agent, uint48(START), uint48(START + 7 days), uint128(rs(5_000)), uint128(rs(20_000)), 5);
        vm.stopPrank();

        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        op.sender = address(wallet2);
        op = signPaymaster(op, pmSignerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
        // keep the agent's original signature, which committed to `wallet`
        PackedUserOperation memory original = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        op.signature = original.signature;
        expectFailedOp("AA24 signature error");
        send(op);
    }

    /// 7. A leaked key used after the session expired.
    function test_attack07_expiredSessionKey() public {
        vm.warp(START + 7 days + 1);
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        expectFailedOp("AA22 expired or not due");
        send(op);
    }

    /// 8a. Privilege escalation: the agent calls the wallet's own admin functions.
    function test_attack08a_selfCallToAdmin() public {
        bytes memory escalate = abi.encodeCall(
            AgentWallet.addSession,
            (attacker, uint48(START), uint48(START + 365 days), uint128(rs(15_000)), uint128(rs(10_00_000)), 1000)
        );
        send(buildOp(address(wallet), agentPk, agentCall(address(wallet), escalate, new bytes32[](0))));
        _assertFrozenFor(AgentWallet.Reason.SelfCall);
        (bool active,,,,,) = wallet.sessions(attacker);
        assertFalse(active);

        uint256 id = wallet.pendingCount();
        vm.prank(owner);
        vm.expectRevert(AgentWallet.InvalidCall.selector);
        wallet.approvePending(id); // even the owner cannot approve a self-call
    }

    /// 8b. The agent signs owner-only calldata (execute) instead of executeAsAgent.
    function test_attack08b_agentSignsOwnerExecute() public {
        bytes memory steal =
            abi.encodeCall(AgentWallet.execute, (address(inr), 0, abi.encodeCall(IERC20.transfer, (attacker, rs(1)))));
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, steal);
        expectFailedOp("AA24 signature error");
        send(op);
    }

    /// 8c. The agent impersonates another identity inside executeAsAgent.
    function test_attack08c_agentClaimsOtherIdentity() public {
        bytes memory call = abi.encodeCall(
            AgentWallet.executeAsAgent,
            (owner, address(inr), abi.encodeCall(IERC20.transfer, (kirana, rs(1))), proofFor(kirana))
        );
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, call);
        expectFailedOp("AA24 signature error");
        send(op);
    }

    /// 8d. Calling the wallet directly with the leaked key, bypassing the EntryPoint.
    function test_attack08d_directCallBypassingEntryPoint() public {
        vm.prank(agent);
        vm.expectRevert("account: not from EntryPoint");
        wallet.executeAsAgent(agent, address(inr), abi.encodeCall(IERC20.transfer, (attacker, rs(1))), new bytes32[](0));
    }

    /// 9. Yield farming the e₹ (RBI: CBDC is non-remunerative).
    function test_attack09_yieldDepositBlocked() public {
        MockYieldVault vault = new MockYieldVault(IERC20(address(inr)));
        bytes memory dep = abi.encodeCall(MockYieldVault.deposit, (rs(10_000)));
        send(buildOp(address(wallet), agentPk, agentCall(address(vault), dep, new bytes32[](0))));
        _assertFrozenFor(AgentWallet.Reason.NotAllowlisted);
        assertEq(inr.balanceOf(address(vault)), 0);
    }

    /// 10. Gas spam through the paymaster: the on-chain quota caps total sponsorship.
    function test_attack10_paymasterGasSpam() public {
        pm.setQuota(address(wallet), 0.0015 ether); // room for only a few ops
        uint256 settled;
        for (uint256 i; i < 10; ++i) {
            PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(apiCredits, rs(1)));
            PackedUserOperation[] memory ops = new PackedUserOperation[](1);
            ops[0] = op;
            vm.prank(bundler, bundler);
            try ep.handleOps(ops, bundler) {
                settled++;
            } catch {}
            vm.warp(block.timestamp + 13 minutes); // dodge the velocity check: pure gas spam
        }
        assertLt(settled, 10, "spam stopped by quota");
        assertLe(pm.gasSpent(address(wallet)), 0.0015 ether, "never exceeds quota");
    }

    /// Bundle attack: validation runs for every op before any executes, so ops validated while the
    /// wallet was unfrozen still execute after the first one trips the freeze. They must be no-ops.
    function test_bundleAfterFreezeIsBlocked() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](3);
        bytes memory drain = abi.encodeCall(IERC20.transfer, (attacker, rs(1_000)));
        uint256 nonceKey = uint192(uint160(agent));
        for (uint256 i; i < 3; ++i) {
            PackedUserOperation memory op = buildOp(address(wallet), agentPk, i == 0
                ? agentCall(address(inr), drain, new bytes32[](0))
                : payCall(kirana, rs(4_000)));
            op.nonce = ep.getNonce(address(wallet), uint192(nonceKey)) + i;
            op = signPaymaster(op, pmSignerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
            op.signature = signUserOp(op, agentPk);
            ops[i] = op;
        }
        sendBundle(ops);
        assertTrue(wallet.frozen());
        assertEq(inr.balanceOf(kirana), 0, "post-freeze ops do nothing");
        _assertContained();
    }

    /// Detection metrics: honest traffic must not trip the freeze (false-freeze rate 0%).
    function test_legitTrafficNeverFreezes() public {
        uint256[5] memory amounts = [rs(499), rs(1_250), rs(2_340), rs(18_000), rs(3_100)];
        address[5] memory to = [apiCredits, railtix, kirana, kirana, railtix];
        for (uint256 i; i < 5; ++i) {
            agentPays(to[i], amounts[i]);
            vm.warp(block.timestamp + 20 minutes);
        }
        assertFalse(wallet.frozen(), "no false freeze");
        assertEq(wallet.openPending(), 1, "the laptop waits for the owner");
    }
}
