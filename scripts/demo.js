// Демонстрация полного сценария на встроенной сети Hardhat:
// 1) create -> fund -> deliver -> release (успешная поставка)
// 2) create -> fund -> timeout -> refund (поставки не было)
// Запуск: npm run demo
const { ethers, network } = require("hardhat");

const STATUS = ["Created", "Funded", "Delivered", "Released", "Refunded"];
const fmt = (wei) => `${ethers.formatEther(wei)} ETH`;

async function main() {
  const [buyer, supplier] = await ethers.getSigners();
  const Escrow = await ethers.getContractFactory("OilGasEscrow");
  const escrow = await Escrow.deploy(buyer.address, supplier.address);
  await escrow.waitForDeployment();
  const addr = await escrow.getAddress();
  console.log(`Контракт: ${addr}\n`);

  const price = ethers.parseEther("10");
  const spec = ethers.id("Urals; sulfur<=1.8%; API 31; docs v1");
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const deadline = now + 7 * 24 * 3600;

  const show = async (id, step) => {
    const b = await escrow.getBatch(id);
    const bal = await ethers.provider.getBalance(addr);
    console.log(`  [${step}] партия ${id}: статус=${STATUS[Number(b.status)]}, баланс контракта=${fmt(bal)}`);
  };

  console.log("Сценарий 1: успешная поставка");
  const supBefore = await ethers.provider.getBalance(supplier.address);
  await (await escrow.connect(buyer).createBatch(1, 50000, price, spec, deadline)).wait();
  await show(1, "createBatch");
  await (await escrow.connect(buyer).fundBatch(1, { value: price })).wait();
  await show(1, "fundBatch");
  await (await escrow.connect(supplier).markDelivered(1)).wait();
  await show(1, "markDelivered");
  await (await escrow.connect(buyer).releasePayment(1)).wait();
  await show(1, "releasePayment");
  const supAfter = await ethers.provider.getBalance(supplier.address);
  console.log(`  Поставщик получил: ${fmt(supAfter - supBefore)} (минус газ на markDelivered)\n`);

  console.log("Сценарий 2: поставки не было, возврат по таймауту");
  await (await escrow.connect(buyer).createBatch(2, 30000, price, spec, deadline)).wait();
  await (await escrow.connect(buyer).fundBatch(2, { value: price })).wait();
  await show(2, "fundBatch");
  await network.provider.send("evm_increaseTime", [8 * 24 * 3600]);
  await network.provider.send("evm_mine");
  console.log("  ...прошло 8 дней, дедлайн истёк");
  await (await escrow.connect(buyer).refund(2)).wait();
  await show(2, "refund");

  console.log(`\nВсего партий: ${await escrow.batchCount()}, заблокировано: ${fmt(await escrow.totalLocked())}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
