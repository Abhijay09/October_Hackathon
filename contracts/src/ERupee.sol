// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RBIRules} from "./lib/RBIRules.sol";

/// @title ERupee — simulated Digital Rupee (e₹) for local prototyping
/// @notice A stand-in for RBI's retail CBDC. 2 decimals (paise). It is not the real e₹, which
///         is not issued on public EVM chains. The issuer role models RBI and its distributing banks.
/// @dev Wallets registered by the issuer are subject to a holding cap. Instead of bouncing an
///      incoming payment that would breach the cap, the excess is swept to the wallet's linked
///      bank account (a "reverse waterfall"), so refunds to an agent wallet never fail.
contract ERupee is ERC20 {
    address public issuer;
    uint256 public holdingCap = RBIRules.WALLET_HOLDING_CAP;

    mapping(address => bool) public isCappedWallet;
    mapping(address => address) public linkedAccount;

    event WalletRegistered(address indexed wallet, address indexed linkedBankAccount);
    event ReverseWaterfallSweep(address indexed wallet, address indexed linkedBankAccount, uint256 amount);

    error OnlyIssuer();
    error HoldingCapExceeded(address wallet, uint256 balance, uint256 cap);
    error CapAboveRbiLimit();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    constructor() ERC20("Digital Rupee (simulated)", "eINR") {
        issuer = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    function mint(address to, uint256 amountPaise) external onlyIssuer {
        _mint(to, amountPaise);
    }

    function burn(address from, uint256 amountPaise) external onlyIssuer {
        _burn(from, amountPaise);
    }

    /// @notice Register a KYC'd wallet: it becomes subject to the holding cap, with any excess
    ///         swept to `linkedBankAccount` (zero address = incoming payments over the cap revert).
    function registerWallet(address wallet, address linkedBankAccount) external onlyIssuer {
        isCappedWallet[wallet] = true;
        linkedAccount[wallet] = linkedBankAccount;
        emit WalletRegistered(wallet, linkedBankAccount);
    }

    function setHoldingCap(uint256 capPaise) external onlyIssuer {
        if (capPaise > RBIRules.WALLET_HOLDING_CAP) revert CapAboveRbiLimit();
        holdingCap = capPaise;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == address(0) || !isCappedWallet[to]) return;

        uint256 balance = balanceOf(to);
        if (balance <= holdingCap) return;

        address bank = linkedAccount[to];
        if (bank == address(0)) revert HoldingCapExceeded(to, balance, holdingCap);
        uint256 excess = balance - holdingCap;
        super._update(to, bank, excess);
        emit ReverseWaterfallSweep(to, bank, excess);
    }
}
