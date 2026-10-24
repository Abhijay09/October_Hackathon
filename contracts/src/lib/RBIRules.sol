// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title RBIRules
/// @notice Reserve Bank of India limits the prototype enforces. All amounts are in paise
///         (1 INR = 100 paise), the base unit of the simulated e-Rupee (e₹).
/// @dev Values mirror RBI circulars as of 2026 (see docs/RBI_COMPLIANCE.md). They are compile-time
///      ceilings: owners may configure stricter limits but never looser ones.
library RBIRules {
    uint256 internal constant PAISE_PER_RUPEE = 100;

    /// @dev Additional Factor of Authentication (AFA) relaxation ceiling for recurring / e-mandate
    ///      payments. Agent payments above this always need the owner's explicit approval (the AFA).
    uint256 internal constant AFA_EXEMPT_LIMIT = 15_000 * PAISE_PER_RUPEE;

    /// @dev General per-transaction ceiling for retail digital payments (UPI). Applies even to
    ///      owner-approved agent payments.
    uint256 internal constant HARD_PER_TX_CAP = 1_00_000 * PAISE_PER_RUPEE;

    /// @dev Outstanding-balance ceiling for full-KYC prepaid payment instruments (PPI Master Direction).
    ///      Used as the holding cap of agent wallets; excess sweeps to the linked bank account.
    uint256 internal constant WALLET_HOLDING_CAP = 2_00_000 * PAISE_PER_RUPEE;

    /// @dev India Standard Time is UTC+05:30. Daily limits reset at IST midnight, not UTC.
    uint256 internal constant IST_OFFSET = 5 hours + 30 minutes;

    function istDay(uint256 timestamp) internal pure returns (uint64) {
        return uint64((timestamp + IST_OFFSET) / 1 days);
    }

    function hourIndex(uint256 timestamp) internal pure returns (uint64) {
        return uint64(timestamp / 1 hours);
    }
}
