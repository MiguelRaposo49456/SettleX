import { network } from "hardhat";

export async function deploySystem(ethers: any) {
    const [admin, client1, client2] = await ethers.getSigners();

    // Deploy MockERC20 tokens
    const tokenA = await ethers.deployContract("MockERC20", ["TokenA", "TKA", 18]);
    const tokenB = await ethers.deployContract("MockERC20", ["TokenB", "TKB", 18]);

    // Deploy core contracts
    const tokenRegistry = await ethers.deployContract("TokenRegistry");
    const orderbook = await ethers.deployContract("OrderBook", [tokenRegistry.target]);
    const custodian = await ethers.deployContract("Custodian", [tokenRegistry.target]);
    const settlementEngine = await ethers.deployContract("SettlementEngine", [tokenRegistry.target]);

    // Initialize them
    await orderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
    await custodian.connect(admin).initialize(orderbook.target, settlementEngine.target);
    await settlementEngine.connect(admin).initialize(orderbook.target, custodian.target);

    return { admin, client1, client2, tokenRegistry, orderbook, custodian, settlementEngine, tokenA, tokenB };
}