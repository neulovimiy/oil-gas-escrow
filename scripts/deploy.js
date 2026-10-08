// Деплой OilGasEscrow.
// Локально: npx hardhat node  (в отдельном терминале), затем npm run deploy:local
// Адреса сторон можно задать переменными окружения BUYER_ADDRESS и SUPPLIER_ADDRESS,
// иначе используются первые два тестовых аккаунта Hardhat.
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer, second] = await ethers.getSigners();
  const buyer = process.env.BUYER_ADDRESS || deployer.address;
  const supplier = process.env.SUPPLIER_ADDRESS || second.address;

  console.log(`Сеть:       ${network.name}`);
  console.log(`Деплоер:    ${deployer.address}`);
  console.log(`Покупатель: ${buyer}`);
  console.log(`Поставщик:  ${supplier}`);

  const Escrow = await ethers.getContractFactory("OilGasEscrow");
  const escrow = await Escrow.deploy(buyer, supplier);
  await escrow.waitForDeployment();

  console.log(`OilGasEscrow развёрнут по адресу: ${await escrow.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
