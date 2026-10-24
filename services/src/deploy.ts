// Deploys the full stack to the local chain and writes deployments/local.json.
//   EntryPoint v0.7 → e₹ (ERupee) → PolicyPaymaster → AgentWallet → MockYieldVault
// then KYC-registers the wallet, funds it with ₹50,000 and gives the agent a 7-day session.
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abis, artifacts, DEV_ROLES, devKey, makeClients } from "./lib/chain.js";
import { saveDeployment, type Deployment, type Merchant } from "./lib/deployment.js";
import { buildPolicy } from "./lib/policy.js";
import { formatINR, toPaise } from "./lib/rupee.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PAYMASTER_QUOTA = parseEther(process.env.PAYMASTER_QUOTA_ETH ?? "0.25");

const MERCHANTS: Omit<Merchant, "address">[] = [
  { id: "kirana", name: "Kirana Mart", category: "Groceries" },
  { id: "railtix", name: "RailTix", category: "Train tickets" },
  { id: "apicredits", name: "API Credits Co.", category: "Developer tools" },
  { id: "gadgets", name: "Gadget Bazaar", category: "Electronics" },
];

async function main() {
  const probe = makeClients(RPC_URL, 31337);
  const chainId = await probe.publicClient.getChainId();
  const { publicClient, walletFor } = makeClients(RPC_URL, chainId);

  const keys = {
    issuer: devKey(DEV_ROLES.issuer),
    owner: devKey(DEV_ROLES.owner),
    bundler: devKey(DEV_ROLES.bundler),
    paymasterSigner: devKey(DEV_ROLES.paymasterSigner),
    attacker: devKey(DEV_ROLES.attacker),
    agent: generatePrivateKey(),
    guardians: DEV_ROLES.guardians.map(devKey),
  };
  const addr = (pk: Hex) => privateKeyToAccount(pk).address;
  const bank = addr(devKey(DEV_ROLES.bank));
  const merchants: Merchant[] = MERCHANTS.map((m, i) => ({ ...m, address: addr(devKey(DEV_ROLES.merchants[i])) }));

  const issuer = walletFor(keys.issuer);
  const owner = walletFor(keys.owner);
  const wait = async (hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
    return r;
  };
  const deploy = async (name: keyof typeof artifacts, args: unknown[] = []) => {
    const { abi, bytecode } = artifacts[name];
    const r = await wait(await issuer.deployContract({ abi, bytecode, args }));
    console.log(`  ${name.padEnd(16)} ${r.contractAddress}`);
    return r.contractAddress as Address;
  };

  console.log(`Deploying to ${RPC_URL} (chain ${chainId})`);
  const entryPoint = await deploy("EntryPoint");
  const rupee = await deploy("ERupee");
  const paymaster = await deploy("PolicyPaymaster", [entryPoint, addr(keys.paymasterSigner), PAYMASTER_QUOTA]);
  const guardians = keys.guardians.map(addr);
  const wallet = await deploy("AgentWallet", [entryPoint, rupee, addr(keys.owner), paymaster, guardians]);
  const yieldVault = await deploy("MockYieldVault", [rupee]);

  await wait(await issuer.writeContract({ address: paymaster, abi: abis.paymaster, functionName: "deposit", value: parseEther("50") }));
  await wait(await issuer.writeContract({ address: rupee, abi: abis.rupee, functionName: "registerWallet", args: [wallet, bank] }));
  await wait(await issuer.writeContract({ address: rupee, abi: abis.rupee, functionName: "mint", args: [wallet, toPaise(50_000)] }));

  const policy = buildPolicy(rupee, merchants.map((m) => m.address));
  const perTx = toPaise(5_000);
  const daily = toPaise(20_000);
  const maxTxPerHour = 5;
  const now = Number((await publicClient.getBlock()).timestamp);
  const validUntil = now + 7 * 86_400;
  await wait(await owner.writeContract({ address: wallet, abi: abis.wallet, functionName: "setPolicyRoot", args: [policy.root] }));
  await wait(
    await owner.writeContract({
      address: wallet,
      abi: abis.wallet,
      functionName: "addSession",
      args: [addr(keys.agent), now - 60, validUntil, perTx, daily, maxTxPerHour],
    }),
  );

  const dep: Deployment = {
    chainId,
    rpcUrl: RPC_URL,
    deployedAt: now,
    contracts: { entryPoint, rupee, paymaster, wallet, yieldVault },
    accounts: {
      issuer: addr(keys.issuer),
      owner: addr(keys.owner),
      bundler: addr(keys.bundler),
      paymasterSigner: addr(keys.paymasterSigner),
      attacker: addr(keys.attacker),
      bank,
      agent: addr(keys.agent),
      guardians,
    },
    devKeys: keys,
    merchants,
    policy: policy.dump(),
    session: { perTxLimit: perTx.toString(), dailyLimit: daily.toString(), maxTxPerHour, validUntil },
    paymasterQuotaWei: PAYMASTER_QUOTA.toString(),
  };
  saveDeployment(dep);
  console.log(`\nWallet funded with ${formatINR(toPaise(50_000))} e₹; agent ${dep.accounts.agent}`);
  console.log(`Limits: auto-approve ≤ ${formatINR(perTx)}/tx, ${formatINR(daily)}/IST day, ${maxTxPerHour} tx/hour`);
  console.log("Wrote deployments/local.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
