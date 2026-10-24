// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AgentWallet} from "../src/AgentWallet.sol";

contract RecoveryTest is Fixture {
    address internal newOwner = address(0x0E70);

    function _reachThreshold() internal {
        vm.prank(guardians[0]);
        wallet.proposeRecovery(newOwner);
        vm.prank(guardians[1]);
        wallet.supportRecovery();
        vm.prank(guardians[2]);
        wallet.supportRecovery();
    }

    function test_threeOfFiveThenFortyEightHours() public {
        _reachThreshold();
        (address proposed, uint64 executableAt, uint8 approvals,) = wallet.recovery();
        assertEq(proposed, newOwner);
        assertEq(approvals, 3);
        assertEq(executableAt, block.timestamp + 48 hours);

        vm.warp(executableAt - 1);
        vm.expectRevert(AgentWallet.RecoveryNotReady.selector);
        wallet.executeRecovery();

        vm.warp(executableAt);
        wallet.executeRecovery();
        assertEq(wallet.owner(), newOwner);
        assertTrue(wallet.frozen(), "stays frozen until the new owner acts");
        (bool active,,,,,) = wallet.sessions(agent);
        assertFalse(active, "all agent sessions revoked");
    }

    function test_twoGuardiansAreNotEnough() public {
        vm.prank(guardians[0]);
        wallet.proposeRecovery(newOwner);
        vm.prank(guardians[1]);
        wallet.supportRecovery();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(AgentWallet.RecoveryNotReady.selector);
        wallet.executeRecovery();
    }

    function test_ownerVetoDuringTimelock() public {
        _reachThreshold();
        vm.warp(block.timestamp + 47 hours);
        vm.prank(owner);
        wallet.cancelRecovery();

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(AgentWallet.RecoveryNotReady.selector);
        wallet.executeRecovery();
        assertEq(wallet.owner(), owner);
    }

    function test_votesDoNotCarryOverAfterVeto() public {
        _reachThreshold();
        vm.prank(owner);
        wallet.cancelRecovery();

        vm.prank(guardians[3]);
        wallet.proposeRecovery(newOwner);
        vm.prank(guardians[0]); // voted in the vetoed round; may vote again in the new one
        wallet.supportRecovery();
        (,, uint8 approvals,) = wallet.recovery();
        assertEq(approvals, 2);
    }

    function test_guardianCannotVoteTwice() public {
        vm.prank(guardians[0]);
        wallet.proposeRecovery(newOwner);
        vm.prank(guardians[0]);
        vm.expectRevert(AgentWallet.AlreadyVoted.selector);
        wallet.supportRecovery();
    }

    function test_nonGuardiansAndAgentCannotRecover() public {
        vm.prank(attacker);
        vm.expectRevert(AgentWallet.Unauthorized.selector);
        wallet.proposeRecovery(attacker);
        vm.prank(agent);
        vm.expectRevert(AgentWallet.Unauthorized.selector);
        wallet.proposeRecovery(attacker);
    }

    function test_onlyOwnerCanVeto() public {
        _reachThreshold();
        vm.prank(guardians[4]);
        vm.expectRevert(AgentWallet.Unauthorized.selector);
        wallet.cancelRecovery();
    }

    function test_guardiansCannotBeChangedMidRecovery() public {
        vm.prank(guardians[0]);
        wallet.proposeRecovery(newOwner);
        vm.prank(owner);
        vm.expectRevert(AgentWallet.RecoveryConflict.selector);
        wallet.setGuardians(guardians);
    }
}
