type DexId = 1 | 2;

type MethodConfig = {
  key: string;
  label: string;
  selector?: string;
};

type DexConfig = {
  id: DexId;
  name: string;
  chainId: number;
  address?: string;
  methods: MethodConfig[];
};

type BlockRange = [number, number];

type TxSample = {
  hash: string;
  gasUsed: number;
  blockNumber: string;
};

type Samples = Record<string, TxSample[]>;

type EtherscanTx = {
  hash: string;
  input: string;
  gasUsed: string;
  blockNumber: string;
  isError: string;
};

type EtherscanResponse = {
  status: string;
  message: string;
  result: EtherscanTx[];
};

type SummaryRow = {
  method: string;
  samples: number;
  avg: number;
  min: number;
  max: number;
};

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const BLOCK_RANGES: Record<DexId, BlockRange[]> = {
  1: [
    [4400000, 5500000],
    [5500000, 6500000],
    [6500000, 7000000],
    [7000000, 22000000],
  ],
  2: [
    [5847000, 7500000],
    [7500000, 9500000],
    [9500000, 11500000],
  ],
};

const DEX_CONFIGS: Record<DexId, DexConfig> = {
  1: {
    id: 1,
    name: "EtherDelta",
    chainId: 1,
    address: "0x8d12a197cb00d4747a1fe03395095ce2a5cc6819",
    methods: [
      { key: "depositEth", label: "deposit()", selector: "0xd0e30db0" },
      { key: "withdrawEth", label: "withdraw(uint256)", selector: "0x2e1a7d4d" },
      { key: "depositERC20", label: "depositToken(address,uint256)", selector: "0x338b5dea" },
      { key: "withdrawERC20", label: "withdrawToken(address,uint256)", selector: "0x9e281a98" },
      { key: "settle", label: "trade(...)", selector: "0x0a19b14a" },
      { key: "placeOrder", label: "order(...)", selector: "0x0b927666" },
      { key: "cancelOrder", label: "cancelOrder(...)", selector: "0x278b8c0e" },
    ],
  },
  2: {
    id: 2,
    name: "IDEX",
    chainId: 1,
    address: "0x2a0c0dbecc7e4d658f48e01e3fa353f44050c208",
    methods: [
      { key: "depositETH", label: "deposit()", selector: "0xd0e30db0" },
      { key: "depositERC20", label: "depositToken(address,uint256)", selector: "0x338b5dea" },
      { key: "withdraw", label: "withdraw(address,uint256)", selector: "0xf3fef3a3" },
      { key: "adminWithdraw", label: "adminWithdraw(...)", selector: "0x2295115b" },
      { key: "trade", label: "trade(...)", selector: "0xef343588" },
      { key: "cancelOrder", label: "invalidateOrdersBefore(...)", selector: "0xb12de559" },
    ],
  },
};

function createSamples(methods: MethodConfig[]): Samples {
  return Object.fromEntries(methods.map((method) => [method.key, [] as TxSample[]]));
}

function normalizeSelector(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function validateAddress(value: string): string {
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`Invalid contract address: ${value}`);
  }
  return trimmed;
}

function identifyMethod(input: string, selectorMap: Record<string, string>): string | null {
  if (!input || input.length < 10) return null;

  const selector = input.slice(0, 10).toLowerCase();
  for (const [method, id] of Object.entries(selectorMap)) {
    if (selector === id) return method;
  }

  return null;
}

async function fetchTransactions(
  address: string,
  chainId: number,
  startBlock: number,
  endBlock: number,
  page = 1,
  offset = 1000
): Promise<EtherscanTx[]> {
  if (!ETHERSCAN_API_KEY) {
    throw new Error("Missing ETHERSCAN_API_KEY environment variable.");
  }

  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist&address=${address}&startblock=${startBlock}&endblock=${endBlock}&page=${page}&offset=${offset}&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const data = (await res.json()) as EtherscanResponse;

  if (data.status !== "1") {
    throw new Error(`Etherscan error: ${data.message}`);
  }

  return data.result;
}

function printMenu(): void {
  console.log("Choose the DEX to query:");
  console.log("  1 - EtherDelta");
  console.log("  2 - IDEX");
}

async function promptText(question: string, defaultValue = ""): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptDexChoice(): Promise<DexId> {
  while (true) {
    printMenu();
    const answer = await promptText("Enter 1 or 2");

    if (answer === "1" || answer === "2") {
      return Number(answer) as DexId;
    }

    console.log("Invalid choice. Please enter 1 or 2.\n");
  }
}

async function resolveSelectorMap(config: DexConfig): Promise<Record<string, string>> {
  const selectorMap: Record<string, string> = {};

  for (const method of config.methods) {
    const envKey = `${config.name.toUpperCase().replace(/\s+/g, "_")}_${method.key.toUpperCase()}_SELECTOR`;
    const selector = normalizeSelector(method.selector ?? process.env[envKey] ?? "");

    if (selector.length !== 10) {
      throw new Error(
        `Missing selector for ${config.name} ${method.key}. Set ${envKey} or add a default in the script.`
      );
    }

    selectorMap[method.key] = selector;
  }

  return selectorMap;
}

function resolveAddress(config: DexConfig): string {
  if (!config.address) {
    throw new Error(`Missing contract address for ${config.name}. Set the address in the script or env.`);
  }

  return validateAddress(config.address);
}

async function main(): Promise<void> {
  const selectedDex = await promptDexChoice();
  const config = DEX_CONFIGS[selectedDex];

  console.log(`\nSelected: ${config.name}`);

  const contractAddress = resolveAddress(config);
  const selectorMap = await resolveSelectorMap(config);
  const samplesNeeded = 10;
  const samples = createSamples(config.methods);

  console.log(`\nFetching ${config.name} transactions from Etherscan...\n`);

  const ranges = BLOCK_RANGES[selectedDex];

  for (const [startBlock, endBlock] of ranges) {
    let page = 1;

    while (true) {
      const allFull = Object.values(samples).every((arr) => arr.length >= samplesNeeded);
      if (allFull) break;

      let txs: EtherscanTx[];
      try {
        txs = await fetchTransactions(contractAddress, config.chainId, startBlock, endBlock, page, 1000);
      } catch (error) {
        console.error(`Range ${startBlock}-${endBlock} page ${page} failed: ${(error as Error).message}`);
        break;
      }

      if (!txs || txs.length === 0) break;

      for (const tx of txs) {
        if (tx.isError === "1") continue;

        const method = identifyMethod(tx.input, selectorMap);
        if (!method || !samples[method]) continue;
        if (samples[method].length >= samplesNeeded) continue;

        samples[method].push({
          hash: tx.hash,
          gasUsed: parseInt(tx.gasUsed, 10),
          blockNumber: tx.blockNumber,
        });
      }

      console.log(
        `Range ${startBlock}-${endBlock}, page ${page}: collected so far — ${Object.entries(samples)
          .map(([name, txsForMethod]) => `${name}:${txsForMethod.length}`)
          .join(", ")}`
      );

      page++;
      if (txs.length < 1000) break;

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const allFull = Object.values(samples).every((arr) => arr.length >= samplesNeeded);
    if (allFull) break;
  }

  console.log(`\n=== ${config.name} Gas Usage Summary ===\n`);

  const summary: SummaryRow[] = [];

  for (const [method, txList] of Object.entries(samples)) {
    if (txList.length === 0) {
      console.log(`${method}: no samples found`);
      continue;
    }

    const gasValues = txList.map((tx) => tx.gasUsed);
    const avg = Math.round(gasValues.reduce((a, b) => a + b, 0) / gasValues.length);
    const min = Math.min(...gasValues);
    const max = Math.max(...gasValues);

    summary.push({ method, samples: txList.length, avg, min, max });

    console.log(`${method}:`);
    console.log(`  Samples : ${txList.length}`);
    console.log(`  Avg gas : ${avg.toLocaleString()}`);
    console.log(`  Range   : ${min.toLocaleString()} - ${max.toLocaleString()}`);
    console.log(`  Tx hashes (for citation):`);
    for (const tx of txList) {
      console.log(
        `    https://etherscan.io/tx/${tx.hash}  (block ${tx.blockNumber}, gas: ${tx.gasUsed.toLocaleString()})`
      );
    }
    console.log();
  }

  console.log("\n=== Table for Report ===");
  console.table(
    summary.map(({ method, avg, min, max }) => ({
      operation: method,
      avgGas: avg.toLocaleString(),
      minGas: min.toLocaleString(),
      maxGas: max.toLocaleString(),
    }))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
