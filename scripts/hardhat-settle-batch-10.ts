import { network } from "hardhat";
import { performance } from "node:perf_hooks";

const { ethers } = await network.connect();

const CommitType = { Order: 0, Take: 1 };
const Side = { BUY: 0, SELL: 1 };

const TOKEN_AMOUNT_SMALL = ethers.parseUnits("25", 18);
const TOKEN_AMOUNT_LARGE = ethers.parseUnits("200", 18);
const TOKEN_DEPOSIT = ethers.parseUnits("10000", 18);
const SETTLEMENT_WINDOW_SECONDS = 120;
const MAX_APPROVAL = (1n << 256n) - 1n;
const BATCH_SIZE = 10;

type BenchmarkRow = {
  operation: string;
  gasUsed: string;
  durationMs: string;
  txHash?: string;
};

function computeOrderHash(
  sender: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
  side: number,
  partialAllowed: boolean,
  salt: string
): string {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "uint256", "uint8", "bool", "bytes32"],
    [sender, tokenIn, tokenOut, amountIn, amountOut, side, partialAllowed, salt]
  );
}

function computeTakeHash(sender: string, makerOrderId: bigint, takerAmount: bigint, salt: string): string {
  return ethers.solidityPackedKeccak256(["address", "uint256", "uint256", "bytes32"], [sender, makerOrderId, takerAmount, salt]);
}

async function getLatestEventArgs(contract: any, filter: any, blockNumber: number) {
  const events = await contract.queryFilter(filter, blockNumber, blockNumber);

  if (events.length === 0) {
    throw new Error(`No event found for block ${blockNumber}`);
  }

  return events[events.length - 1].args;
}

async function measureTx<T>(rows: BenchmarkRow[], label: string, txFactory: () => Promise<T>): Promise<any> {
  const startedAt = performance.now();
  const tx: any = await txFactory();
  const receipt = await tx.wait();
  const durationMs = Math.round(performance.now() - startedAt);

  rows.push({ operation: label, gasUsed: receipt.gasUsed.toString(), durationMs: durationMs.toString(), txHash: String(tx.hash) });
  console.log(`${label}: ${receipt.gasUsed.toString()} gas, ${durationMs} ms`);

  return receipt;
}

async function createMatchedTrades(
  rows: BenchmarkRow[],
  fungibleOrderbook: any,
  client1: any,
  client2: any,
  tokenAAddress: string,
  tokenBAddress: string
): Promise<void> {
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const salt = ethers.encodeBytes32String(`batch10-${String(index + 1).padStart(2, "0")}`);

    const makerCommitReceipt = await measureTx(rows, `FungibleOrderbook.commit(${index + 1})`, () =>
      fungibleOrderbook.connect(client1).commit(
        computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt),
        CommitType.Order
      )
    );
    const makerCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), makerCommitReceipt.blockNumber);
    const makerCommitId = makerCommitArgs.commitId as bigint;

    const makerRevealReceipt = await measureTx(rows, `FungibleOrderbook.revealOrder(${index + 1})`, () =>
      fungibleOrderbook.connect(client1).revealOrder(
        makerCommitId,
        tokenAAddress,
        tokenBAddress,
        TOKEN_AMOUNT_SMALL,
        TOKEN_AMOUNT_SMALL,
        Side.SELL,
        true,
        salt
      )
    );
    const makerOrderArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), makerRevealReceipt.blockNumber);
    const makerOrderId = makerOrderArgs.orderId as bigint;

    const takerCommitReceipt = await measureTx(rows, `FungibleOrderbook.commitTake(${index + 1})`, () =>
      fungibleOrderbook.connect(client2).commit(
        computeTakeHash(client2.address, makerOrderId, TOKEN_AMOUNT_SMALL, salt),
        CommitType.Take
      )
    );
    const takerCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), takerCommitReceipt.blockNumber);
    const takerCommitId = takerCommitArgs.commitId as bigint;

    await measureTx(rows, `FungibleOrderbook.revealTake(${index + 1})`, () =>
      fungibleOrderbook.connect(client2).revealTake(takerCommitId, makerOrderId, TOKEN_AMOUNT_SMALL, salt)
    );
  }
}

async function main() {
  const rows: BenchmarkRow[] = [];
  const [admin, client1, client2, , client3] = await ethers.getSigners();

  const tokenA = await ethers.deployContract("MockERC20", ["TokenA", "TKA", 18]);
  const tokenB = await ethers.deployContract("MockERC20", ["TokenB", "TKB", 18]);
  const mockLendingPool = await ethers.deployContract("MockLendingPool");
  const mockWeth = await ethers.deployContract("MockWETH");
  const complianceManager = await ethers.deployContract("ComplianceManager");
  const fungibleOrderbook = await ethers.deployContract("FungibleOrderbook", [complianceManager.target]);
  const nftOrderbook = await ethers.deployContract("NFTOrderbook", [complianceManager.target]);
  const custodian = await ethers.deployContract("Custodian", [complianceManager.target, mockLendingPool.target, mockWeth.target]);
  const settlementEngine = await ethers.deployContract("SettlementEngine", [complianceManager.target, SETTLEMENT_WINDOW_SECONDS, BATCH_SIZE]);

  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await mockLendingPool.waitForDeployment();
  await mockWeth.waitForDeployment();
  await complianceManager.waitForDeployment();
  await fungibleOrderbook.waitForDeployment();
  await nftOrderbook.waitForDeployment();
  await custodian.waitForDeployment();
  await settlementEngine.waitForDeployment();

  await (await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA")).wait();
  await (await tokenA.connect(admin).mint(admin.address, TOKEN_AMOUNT_LARGE)).wait();
  await (await tokenA.connect(admin).approve(mockLendingPool.target, TOKEN_AMOUNT_LARGE)).wait();
  await (await mockLendingPool.connect(admin).addLiquidity(tokenA.target, TOKEN_AMOUNT_LARGE)).wait();

  const tokenAUnderlyingAddress = String(tokenA.target);
  const tokenAAddress = String(await mockLendingPool.getAToken(tokenA.target));
  const tokenBAddress = String(tokenB.target);

  await fungibleOrderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
  await nftOrderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
  await custodian.connect(admin).initialize(fungibleOrderbook.target, nftOrderbook.target, settlementEngine.target);
  await settlementEngine.connect(admin).initialize(fungibleOrderbook.target, nftOrderbook.target, custodian.target);
  await settlementEngine.connect(admin).setMaxBatchSize(BATCH_SIZE);

  for (const client of [client1, client2]) {
    await (await tokenA.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE)).wait();
    await (await tokenB.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE)).wait();
    await (await tokenA.connect(client).approve(custodian.target, MAX_APPROVAL)).wait();
    await (await tokenB.connect(client).approve(custodian.target, MAX_APPROVAL)).wait();
    await (await custodian.connect(client).deposit(tokenAUnderlyingAddress, TOKEN_DEPOSIT)).wait();
    await (await custodian.connect(client).deposit(tokenBAddress, TOKEN_DEPOSIT)).wait();
  }

  await createMatchedTrades(rows, fungibleOrderbook, client1, client2, tokenAAddress, tokenBAddress);

  await measureTx(rows, "SettlementEngine.settleBatch (batch=10)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).settleBatch();
  });

  await createMatchedTrades(rows, fungibleOrderbook, client1, client2, tokenAAddress, tokenBAddress);

  await measureTx(rows, 'SettlementEngine.performUpkeep (batch=10)', async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).performUpkeep("0x");
  });

  console.log("\nBenchmark summary");
  console.table(rows);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
