// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "./utils/Fixture.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {ERupee} from "../src/ERupee.sol";
import {RBIRules} from "../src/lib/RBIRules.sol";

contract AgentWalletTest is Fixture {
    function test_inPolicyPaymentSettlesInRupees() public {
        agentPays(railtix, rs(1_250));

        assertEq(inr.balanceOf(railtix), rs(1_250));
        assertEq(inr.balanceOf(address(wallet)), rs(50_000) - rs(1_250));
        (,,, uint128 spentToday) = wallet.usage(agent);
        assertEq(spentToday, rs(1_250));
        assertFalse(wallet.frozen());
        assertGt(pm.gasSpent(address(wallet)), 0, "gas sponsored by paymaster");
    }

    function test_eRupeeHasTwoDecimals() public view {
        assertEq(inr.decimals(), 2);
        assertEq(rs(1), 100);
    }

    function test_overAfaLimitGoesToOwnerApproval() public {
        agentPays(kirana, rs(18_000)); // above ₹5,000 auto limit

        assertEq(inr.balanceOf(kirana), 0, "nothing moves without approval");
        assertFalse(wallet.frozen(), "a big honest purchase is not a hijack signal");
        AgentWallet.PendingRequest memory p = wallet.getPending(1);
        assertEq(uint8(p.status), uint8(AgentWallet.PendingStatus.Open));
        assertEq(uint8(p.reason), uint8(AgentWallet.Reason.OverAfaLimit));
        assertEq(p.amount, rs(18_000));

        vm.prank(owner);
        wallet.approvePending(1);
        assertEq(inr.balanceOf(kirana), rs(18_000));
        assertEq(uint8(wallet.getPending(1).status), uint8(AgentWallet.PendingStatus.Approved));
        assertEq(wallet.openPending(), 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.NotOpen.selector, 1));
        wallet.approvePending(1);
    }

    function test_ownerCanRejectPending() public {
        agentPays(kirana, rs(9_000));
        vm.prank(owner);
        wallet.rejectPending(1);
        assertEq(uint8(wallet.getPending(1).status), uint8(AgentWallet.PendingStatus.Rejected));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.NotOpen.selector, 1));
        wallet.approvePending(1);
    }

    function test_pendingExpiresAfter24h() public {
        agentPays(kirana, rs(9_000));
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.Expired.selector, 1));
        wallet.approvePending(1);
    }

    function test_onlyOwnerApproves() public {
        agentPays(kirana, rs(9_000));
        vm.prank(attacker);
        vm.expectRevert(AgentWallet.Unauthorized.selector);
        wallet.approvePending(1);
        vm.prank(agent);
        vm.expectRevert(AgentWallet.Unauthorized.selector);
        wallet.approvePending(1);
    }

    function test_hardCapOfOneLakhAppliesEvenWithApproval() public {
        inr.mint(address(wallet), rs(1_00_000));
        agentPays(kirana, rs(1_50_000));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.AboveHardCap.selector, rs(1_50_000)));
        wallet.approvePending(1);
    }

    function test_cannotConfigureAutoLimitAboveRbiAfaLimit() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentWallet.InvalidLimits.selector);
        wallet.setLimits(agent, uint128(rs(15_001)), uint128(rs(50_000)), 5);
        wallet.setLimits(agent, uint128(RBIRules.AFA_EXEMPT_LIMIT), uint128(rs(50_000)), 5);
        vm.stopPrank();
        (,,,, uint128 perTx,) = wallet.sessions(agent);
        assertEq(perTx, rs(15_000));
    }

    function test_dailyLimitResetsAtIstMidnight() public {
        for (uint256 i; i < 4; ++i) {
            agentPays(kirana, rs(4_900));
            vm.warp(block.timestamp + 1 hours + 1);
        }
        (,,, uint128 spent) = wallet.usage(agent);
        assertEq(spent, rs(19_600));

        // 23:59 IST the same day = 18:29 UTC: still the same IST day
        uint256 istMidnight = ((block.timestamp + RBIRules.IST_OFFSET) / 1 days + 1) * 1 days - RBIRules.IST_OFFSET;
        vm.warp(istMidnight - 60);
        agentPays(kirana, rs(300));
        (,,, spent) = wallet.usage(agent);
        assertEq(spent, rs(19_900));

        // 00:01 IST next day: fresh limit
        vm.warp(istMidnight + 60);
        agentPays(kirana, rs(4_900));
        (,,, spent) = wallet.usage(agent);
        assertEq(spent, rs(4_900));
        assertFalse(wallet.frozen());
    }

    function test_holdingCapSweepsExcessToLinkedBank() public {
        inr.mint(address(wallet), rs(1_80_000)); // 50k + 1.8L = 2.3L > 2L cap
        assertEq(inr.balanceOf(address(wallet)), RBIRules.WALLET_HOLDING_CAP);
        assertEq(inr.balanceOf(bank), rs(30_000));
    }

    function test_holdingCapRevertsWithoutLinkedAccount() public {
        address w = address(0x7777);
        inr.registerWallet(w, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(ERupee.HoldingCapExceeded.selector, w, rs(2_00_001), RBIRules.WALLET_HOLDING_CAP)
        );
        inr.mint(w, rs(2_00_001));
    }

    function test_ownerUserOpCanAdministerWallet() public {
        bytes memory adminCall = abi.encodeCall(AgentWallet.freeze, ());
        send(buildOp(address(wallet), ownerPk, abi.encodeCall(AgentWallet.execute, (address(wallet), 0, adminCall))));
        assertTrue(wallet.frozen());
    }

    function test_ownerDirectExecute() public {
        vm.prank(owner);
        wallet.execute(address(inr), 0, abi.encodeCall(IERC20.transfer, (bank, rs(10_000))));
        assertEq(inr.balanceOf(bank), rs(10_000));
    }

    function test_agentOpWithoutPaymasterIsRejected() public {
        vm.deal(address(wallet), 1 ether);
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        op.paymasterAndData = "";
        op.signature = signUserOp(op, agentPk);
        expectFailedOp("AA24 signature error");
        send(op);
    }

    function test_rotateKeyOnUnfreeze() public {
        vm.prank(owner);
        wallet.freeze();
        address newAgent = vm.addr(0xA6E48);
        vm.prank(owner);
        wallet.unfreeze(agent, newAgent);
        (bool oldActive,,,,,) = wallet.sessions(agent);
        (bool newActive,,,,,) = wallet.sessions(newAgent);
        assertFalse(oldActive);
        assertTrue(newActive);
        assertFalse(wallet.frozen());

        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        expectFailedOp("AA24 signature error");
        send(op); // old key is dead
    }

    function test_recordsEveryPaymentAsAnAlertEvent() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentWallet.AgentPayment(agent, address(inr), apiCredits, rs(499), rs(499));
        agentPays(apiCredits, rs(499));
    }
}
