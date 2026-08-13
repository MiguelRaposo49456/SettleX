# SettleX

SettleX is a fully on-chain trading and settlement system for tokenized financial assets. The protocol keeps the full trade lifecycle on-chain: users deposit into a custodian vault, place and reveal orders through commit-reveal orderbooks, and settle trades atomically through a batch-oriented settlement engine.

The system is designed around five core ideas:

- Custody with separated available and locked balances.
- Front-running resistance through commit-reveal order placement.
- Atomic delivery-versus-payment settlement for fungible and NFT trades.
- Compliance controls through roles, blacklists, and a global pause switch.
- Capital efficiency through optional lending-pool routing for idle assets.

## What Is In This Repository

- `contracts/` contains the Solidity implementation of the protocol.
- `interfaces/` contains the external interfaces used by the contracts.
- `ignition/modules/` contains deployment modules for local Hardhat runs and Sepolia.
- `scripts/` contains benchmark and evaluation scripts used to measure gas usage and latency.
- `test/` contains the Hardhat test suite.
- `frontend/` contains a separate Vite-based dApp frontend.

## Main Contracts

- `Custodian.sol` handles deposits, withdrawals, internal balances, and asset locking.
- `FungibleOrderbook.sol` manages ERC-20 order flow with commit-reveal matching.
- `NFTOrderbook.sol` manages ERC-721 listings and offers with commit-reveal matching.
- `SettlementEngine.sol` batches and settles matched trades atomically.
- `ComplianceManager.sol` centralizes roles, blacklist checks, and emergency pause logic.

For testing and benchmarking, the repo also includes mock assets and a mock lending pool used by the deployment modules and scripts.

## Tech Stack

- Solidity 0.8.28
- Hardhat 3
- ethers.js
- OpenZeppelin contracts
- Chainlink CRE-compatible automation hooks used by the settlement flow
- TypeScript for tests, scripts, and deployment logic
- Vite + React in `frontend/`

## Setup

Install the root dependencies first:

```shell
npm install
```

If you want to use the frontend, install its dependencies too:

```shell
cd frontend
npm install
```

## Environment Variables

The root Hardhat config loads variables from `.env`.

```env
SEPOLIA_RPC_URL=https://your-sepolia-rpc-url
DEPLOYER_PRIVATE_KEY=your_64_char_private_key_without_0x
TEST_ACCOUNT_1_PRIVATE_KEY=your_second_private_key_without_0x
```

The Sepolia network config prefixes the private keys with `0x` automatically, so store them as raw hex strings without the prefix.

If you run the frontend against Sepolia, set the matching Vite variable as well:

```env
VITE_SEPOLIA_RPC_URL=https://your-sepolia-rpc-url
```

## How The Protocol Works

1. Users deposit ERC-20, ETH, or ERC-721 assets into the `Custodian`.
2. The `ComplianceManager` validates whether the caller, token, and contract state are allowed.
3. Traders submit commit hashes first, then reveal order details to avoid mempool sniping.
4. The orderbooks match compatible orders and forward the result to the `SettlementEngine`.
5. The settlement engine performs atomic internal transfers and clears trades in batches.
6. When enabled, idle capital can be routed through the lending pool for yield generation.

## Build, Test, and Benchmark

Compile the contracts:

```shell
npx hardhat compile
```

Run the tests:

```shell
npx hardhat test
```

Run the benchmark scripts:

```shell
npm run hardhat:eval
npm run hardhat:settle-batch-10
npm run sepolia:eval
npm run sepolia:settle-batch-10
npm run dex:eval
```

These scripts collect gas and latency data for deposits, withdrawals, order placement, trade settlement, batch settlement, and lending-pool routing.

## Deployment

### Local Deployment

The local deployment module is designed for simulated Hardhat networks and deploys the full protocol stack, mock assets, and mock lending pool.

Start off by running a Hardhat node in one terminal:

```shell
npx hardhat node
```

Then deploy the protocol in another terminal:

```shell
npx hardhat ignition deploy ./ignition/modules/LocalDeployment.ts --network localhost
```
After this open a third terminal to start the frontend application:

```shell
cd frontend
npm run dev
```
Lastly, open your browser on the endpoint that the frontend is running on to interact with the dApp.

### Sepolia Deployment

The Sepolia deployment module uses the same protocol wiring but is configured for the live Sepolia network. So theres no need to run a local node now, just make sure your environment variables are set and provide the CRE forwarder address required by `AutomationReceiver` when you deploy:

```shell
npx hardhat ignition deploy ./ignition/modules/SepoliaDeployment.ts --network sepolia
```

After deployment, you only need to run the frontend application in a separate terminal:

```shell
cd frontend
npm run dev
```

And since the deployment stays on Sepolia there is no need to keep deploying it every time you want to test the frontend. You can just run the frontend and interact with the deployed contracts.


## Notes

- The contracts and scripts in this repository are built for experimentation, evaluation, and thesis presentation.
- The settlement engine is batch-oriented so gas costs can be amortized across multiple matched trades.
- The lending-pool path is optional and exists to measure the trade-off between yield generation and extra gas overhead.
