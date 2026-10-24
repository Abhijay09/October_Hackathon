import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  paths: {
    sources: "src",
    tests: { solidity: "test" },
  },
  solidity: {
    // Emit an artifact for the canonical EntryPoint v0.7 so local deploys use the real contract.
    npmFilesToBuild: ["@account-abstraction/contracts/core/EntryPoint.sol"],
    profiles: {
      default: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
  },
  test: {
    solidity: {
      fuzz: { runs: 256 },
      invariant: { runs: 256, depth: 50, failOnRevert: false },
    },
  },
  networks: {
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
  },
});
