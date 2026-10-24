# RBI rules in the HyperNexus agent wallet

Every amount in this prototype is in Indian Rupees. The wallet holds a **simulated Digital Rupee (e₹)**: an ERC-20 token with 2 decimals, so 1 unit is 1 paisa. This file maps each RBI rule the prototype follows to the code that enforces it.

> **This is a hackathon prototype, not legal or compliance advice.** RBI's real e₹ is not issued on public EVM chains, so here it is simulated on a local chain only. The limits below reflect RBI and NPCI guidance as the team understands it. Verify every figure against the current circulars before relying on it. Limits change: the e-mandate relaxation, for example, has been raised several times since 2019.

The on-chain ceilings live in [`contracts/src/lib/RBIRules.sol`](../contracts/src/lib/RBIRules.sol), mirrored in [`services/src/lib/rbi.ts`](../services/src/lib/rbi.ts). The owner can always configure **stricter** limits, but never looser ones.

| Rule | Source | How the prototype enforces it | Where |
|---|---|---|---|
| **Additional Factor of Authentication (AFA).** Recurring/e-mandate payments may skip AFA only up to **₹15,000**. | RBI e-mandate framework for recurring transactions (2019; relaxation limit raised to ₹15,000 in 2022) | The agent's auto-approve limit (`perTxLimit`) can't be set above ₹15,000. A bigger payment to an allowed merchant becomes a **pending request**, and the owner's approval is the additional factor. | `AgentWallet._checkLimits`, `_classify` (`OverAfaLimit`), `approvePending` |
| **Per-transaction ceiling of ₹1,00,000** for retail digital payments. | NPCI/UPI general per-transaction limit | Hard cap: even an owner-approved agent payment can't exceed ₹1,00,000. | `approvePending` (`AboveHardCap`) |
| **Wallet holding limit of ₹2,00,000** (full-KYC prepaid payment instruments). | RBI Master Direction on Prepaid Payment Instruments (2021) | The e₹ issuer contract caps each registered wallet at ₹2,00,000. Instead of bouncing an incoming payment, it **sweeps the excess to the owner's linked bank account** (a reverse waterfall), so refunds never fail. | `ERupee._update`, `ReverseWaterfallSweep` |
| **Customer-set limits and an on/off switch** for digital transactions. | RBI, *Enhancing Security of Card Transactions* (2020) | The owner sets per-payment, daily and hourly limits, and can switch the agent off (`freeze`) and on (`unfreeze`) at any time. | `setLimits`, `freeze`, `unfreeze` |
| **Alerts for every transaction**, plus a liability framework that rewards prompt reporting. | RBI, *Customer Protection – Limiting Liability of Customers in Unauthorised Electronic Banking Transactions* (2017) | Every agent attempt (paid, pending or blocked) emits an event that appears in the dashboard passbook. "Report fraud" freezes the agent and timestamps the report on-chain. | `AgentPayment`, `AgentBlocked`, `reportFraud` |
| **The e₹ (CBDC) is non-remunerative.** | RBI Concept Note on Central Bank Digital Currency (2022) | Agents may only make payment transfers. `approve`, `transferFrom`, `increaseAllowance` and `permit` are banned outright, and yield vaults are never allowlisted. Attack A09 tests this. | `PolicyLib.isForbiddenSelector`, Merkle allowlist |
| **Indian calendar day.** Daily limits should match the user's day. | — | Daily limits reset at **midnight IST** (UTC+05:30), not UTC midnight. | `RBIRules.istDay`, `AgentWallet._rollWindows` |

## Not covered by the prototype

- **KYC.** Wallets are "registered" by the issuer contract to model a KYC'd instrument. No identity checks happen.
- **Payment data localisation** (RBI, *Storage of Payment System Data*, 2018). Everything runs locally. A production deployment would keep paymaster logs and transaction data on servers in India.
- **Pre-debit notifications** for recurring mandates (24 hours before each debit). The agent makes one-off payments; recurring mandates are future work.
- **The real e₹ rails.** Settlement uses the simulated token on a local chain.

## The demo defaults

| Setting | Default | RBI ceiling |
|---|---|---|
| Auto-approve per payment | ₹5,000 | ₹15,000 (AFA) |
| Daily limit (IST day) | ₹20,000 | owner's choice |
| Payments per hour | 5 | owner's choice |
| Owner-approved payment | up to ₹1,00,000 | ₹1,00,000 |
| Wallet balance | ₹50,000 funded | ₹2,00,000 holding cap |
| Agent session | 7 days | owner's choice |
