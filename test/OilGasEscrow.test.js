const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Числовые значения enum Status из контракта
const Status = { Created: 0n, Funded: 1n, Delivered: 2n, Released: 3n, Refunded: 4n };

const ID = 1n;
const VOLUME = 50_000n; // баррелей
const PRICE = ethers.parseEther("10");
const SPEC = ethers.id("Urals; sulfur<=1.8%; API 31; docs v1");
const WEEK = 7n * 24n * 3600n;

// ---------------------------------------------------------------- фикстуры
async function deployFixture() {
  const [buyer, supplier, stranger] = await ethers.getSigners();
  const Escrow = await ethers.getContractFactory("OilGasEscrow");
  const escrow = await Escrow.deploy(buyer.address, supplier.address);
  const deadline = BigInt(await time.latest()) + WEEK;
  const BUYER_ROLE = await escrow.BUYER_ROLE();
  const SUPPLIER_ROLE = await escrow.SUPPLIER_ROLE();
  return { Escrow, escrow, buyer, supplier, stranger, deadline, BUYER_ROLE, SUPPLIER_ROLE };
}

async function createdFixture() {
  const f = await deployFixture();
  await f.escrow.connect(f.buyer).createBatch(ID, VOLUME, PRICE, SPEC, f.deadline);
  return f;
}

async function fundedFixture() {
  const f = await createdFixture();
  await f.escrow.connect(f.buyer).fundBatch(ID, { value: PRICE });
  return f;
}

async function deliveredFixture() {
  const f = await fundedFixture();
  await f.escrow.connect(f.supplier).markDelivered(ID);
  return f;
}

// Проверка инварианта: баланс контракта равен сумме заблокированных средств
async function expectInvariant(escrow) {
  const balance = await ethers.provider.getBalance(await escrow.getAddress());
  expect(balance).to.equal(await escrow.totalLocked());
}

describe("OilGasEscrow", function () {
  // ------------------------------------------------------------ развёртывание
  describe("Развёртывание", function () {
    it("назначает роли покупателя и поставщика", async function () {
      const { escrow, buyer, supplier, BUYER_ROLE, SUPPLIER_ROLE } = await loadFixture(deployFixture);
      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.supplier()).to.equal(supplier.address);
      expect(await escrow.hasRole(BUYER_ROLE, buyer.address)).to.equal(true);
      expect(await escrow.hasRole(SUPPLIER_ROLE, supplier.address)).to.equal(true);
      expect(await escrow.hasRole(SUPPLIER_ROLE, buyer.address)).to.equal(false);
    });

    it("не назначает администратора ролей (роли нельзя переназначить)", async function () {
      const { escrow, buyer } = await loadFixture(deployFixture);
      const ADMIN = await escrow.DEFAULT_ADMIN_ROLE();
      expect(await escrow.hasRole(ADMIN, buyer.address)).to.equal(false);
    });

    it("отклоняет нулевой адрес", async function () {
      const { Escrow, supplier } = await loadFixture(deployFixture);
      await expect(Escrow.deploy(ethers.ZeroAddress, supplier.address))
        .to.be.revertedWithCustomError(Escrow, "ZeroAddress");
    });

    it("отклоняет одинаковые адреса покупателя и поставщика", async function () {
      const { Escrow, buyer } = await loadFixture(deployFixture);
      await expect(Escrow.deploy(buyer.address, buyer.address))
        .to.be.revertedWithCustomError(Escrow, "SameParties");
    });
  });

  // ---------------------------------------------------------------- createBatch
  describe("createBatch", function () {
    it("создаёт партию и генерирует событие BatchCreated", async function () {
      const { escrow, buyer, deadline } = await loadFixture(deployFixture);
      await expect(escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, SPEC, deadline))
        .to.emit(escrow, "BatchCreated")
        .withArgs(ID, VOLUME, PRICE, SPEC, deadline);

      const b = await escrow.getBatch(ID);
      expect(b.id).to.equal(ID);
      expect(b.volume).to.equal(VOLUME);
      expect(b.priceWei).to.equal(PRICE);
      expect(b.specHash).to.equal(SPEC);
      expect(b.status).to.equal(Status.Created);
      expect(b.deadline).to.equal(deadline);
      expect(await escrow.batchCount()).to.equal(1n);
      expect(await escrow.batchExists(ID)).to.equal(true);
    });

    it("доступна только покупателю", async function () {
      const { escrow, supplier, deadline, BUYER_ROLE } = await loadFixture(deployFixture);
      await expect(escrow.connect(supplier).createBatch(ID, VOLUME, PRICE, SPEC, deadline))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(supplier.address, BUYER_ROLE);
    });

    it("не позволяет создать партию с существующим id", async function () {
      const { escrow, buyer, deadline } = await loadFixture(createdFixture);
      await expect(escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, SPEC, deadline))
        .to.be.revertedWithCustomError(escrow, "BatchAlreadyExists")
        .withArgs(ID);
    });

    it("проверяет параметры: объём, цену, хэш спецификации, дедлайн", async function () {
      const { escrow, buyer, deadline } = await loadFixture(deployFixture);
      const now = BigInt(await time.latest());
      await expect(escrow.connect(buyer).createBatch(ID, 0, PRICE, SPEC, deadline))
        .to.be.revertedWithCustomError(escrow, "InvalidParameter").withArgs("volume");
      await expect(escrow.connect(buyer).createBatch(ID, VOLUME, 0, SPEC, deadline))
        .to.be.revertedWithCustomError(escrow, "InvalidParameter").withArgs("priceWei");
      await expect(escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, ethers.ZeroHash, deadline))
        .to.be.revertedWithCustomError(escrow, "InvalidParameter").withArgs("specHash");
      await expect(escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, SPEC, now))
        .to.be.revertedWithCustomError(escrow, "InvalidParameter").withArgs("deadline");
    });
  });

  // ------------------------------------------------------------------ fundBatch
  describe("fundBatch", function () {
    it("принимает точную сумму, меняет статус и баланс", async function () {
      const { escrow, buyer } = await loadFixture(createdFixture);
      const tx = escrow.connect(buyer).fundBatch(ID, { value: PRICE });
      await expect(tx).to.emit(escrow, "Funded").withArgs(ID, buyer.address, PRICE);
      await expect(tx).to.changeEtherBalances([buyer, escrow], [-PRICE, PRICE]);
      expect(await escrow.statusOf(ID)).to.equal(Status.Funded);
      expect(await escrow.totalLocked()).to.equal(PRICE);
      await expectInvariant(escrow);
    });

    it("отклоняет сумму меньше и больше цены", async function () {
      const { escrow, buyer } = await loadFixture(createdFixture);
      await expect(escrow.connect(buyer).fundBatch(ID, { value: PRICE - 1n }))
        .to.be.revertedWithCustomError(escrow, "WrongPaymentAmount").withArgs(PRICE, PRICE - 1n);
      await expect(escrow.connect(buyer).fundBatch(ID, { value: PRICE + 1n }))
        .to.be.revertedWithCustomError(escrow, "WrongPaymentAmount").withArgs(PRICE, PRICE + 1n);
    });

    it("доступна только покупателю", async function () {
      const { escrow, stranger, BUYER_ROLE } = await loadFixture(createdFixture);
      await expect(escrow.connect(stranger).fundBatch(ID, { value: PRICE }))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, BUYER_ROLE);
    });

    it("не позволяет оплатить партию повторно", async function () {
      const { escrow, buyer } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).fundBatch(ID, { value: PRICE }))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Funded);
    });

    it("отклоняет несуществующую партию", async function () {
      const { escrow, buyer } = await loadFixture(createdFixture);
      await expect(escrow.connect(buyer).fundBatch(999, { value: PRICE }))
        .to.be.revertedWithCustomError(escrow, "BatchNotFound").withArgs(999);
    });

    it("граница дедлайна: ровно в дедлайн — можно, позже — нельзя", async function () {
      const f1 = await loadFixture(createdFixture);
      await time.increaseTo(f1.deadline - 1n); // следующая транзакция будет ровно в deadline
      await expect(f1.escrow.connect(f1.buyer).fundBatch(ID, { value: PRICE })).to.not.be.reverted;

      const f2 = await loadFixture(createdFixture);
      await time.increaseTo(f2.deadline); // следующая транзакция будет в deadline + 1
      await expect(f2.escrow.connect(f2.buyer).fundBatch(ID, { value: PRICE }))
        .to.be.revertedWithCustomError(f2.escrow, "DeadlinePassed").withArgs(ID);
    });

    it("контракт не принимает прямые переводы ETH", async function () {
      const { escrow, buyer } = await loadFixture(deployFixture);
      await expect(buyer.sendTransaction({ to: await escrow.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  // -------------------------------------------------------------- markDelivered
  describe("markDelivered", function () {
    it("поставщик отмечает поставку", async function () {
      const { escrow, supplier } = await loadFixture(fundedFixture);
      await expect(escrow.connect(supplier).markDelivered(ID))
        .to.emit(escrow, "Delivered").withArgs(ID, supplier.address);
      expect(await escrow.statusOf(ID)).to.equal(Status.Delivered);
    });

    it("доступна только поставщику", async function () {
      const { escrow, buyer, SUPPLIER_ROLE } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).markDelivered(ID))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(buyer.address, SUPPLIER_ROLE);
    });

    it("нельзя отметить неоплаченную партию", async function () {
      const { escrow, supplier } = await loadFixture(createdFixture);
      await expect(escrow.connect(supplier).markDelivered(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Created);
    });

    it("граница дедлайна: ровно в дедлайн — можно, позже — нельзя", async function () {
      const f1 = await loadFixture(fundedFixture);
      await time.increaseTo(f1.deadline - 1n);
      await expect(f1.escrow.connect(f1.supplier).markDelivered(ID)).to.not.be.reverted;

      const f2 = await loadFixture(fundedFixture);
      await time.increaseTo(f2.deadline);
      await expect(f2.escrow.connect(f2.supplier).markDelivered(ID))
        .to.be.revertedWithCustomError(f2.escrow, "DeadlinePassed").withArgs(ID);
    });
  });

  // ------------------------------------------------------------- releasePayment
  describe("releasePayment", function () {
    it("позитивный сценарий: create -> fund -> deliver -> release", async function () {
      const { escrow, buyer, supplier } = await loadFixture(deliveredFixture);
      const tx = escrow.connect(buyer).releasePayment(ID);
      await expect(tx).to.emit(escrow, "PaymentReleased").withArgs(ID, supplier.address, PRICE);
      await expect(tx).to.changeEtherBalances([escrow, supplier], [-PRICE, PRICE]);
      expect(await escrow.statusOf(ID)).to.equal(Status.Released);
      expect(await escrow.totalLocked()).to.equal(0n);
      await expectInvariant(escrow);
    });

    it("повторная выплата невозможна", async function () {
      const { escrow, buyer } = await loadFixture(deliveredFixture);
      await escrow.connect(buyer).releasePayment(ID);
      await expect(escrow.connect(buyer).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Released);
    });

    it("нельзя выплатить до отметки о поставке", async function () {
      const { escrow, buyer } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Funded);
    });

    it("поставщик не может забрать оплату сам до дедлайна", async function () {
      const { escrow, supplier } = await loadFixture(deliveredFixture);
      await expect(escrow.connect(supplier).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    });

    it("поставщик может забрать оплату после дедлайна, если покупатель молчит", async function () {
      const { escrow, supplier, deadline } = await loadFixture(deliveredFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(supplier).releasePayment(ID))
        .to.changeEtherBalances([escrow, supplier], [-PRICE, PRICE]);
      expect(await escrow.statusOf(ID)).to.equal(Status.Released);
    });

    it("посторонний адрес не может вызвать выплату", async function () {
      const { escrow, stranger } = await loadFixture(deliveredFixture);
      await expect(escrow.connect(stranger).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "NotAuthorized");
    });
  });

  // --------------------------------------------------------------------- refund
  describe("refund", function () {
    it("негативный сценарий: create -> fund -> timeout -> refund", async function () {
      const { escrow, buyer, deadline } = await loadFixture(fundedFixture);
      await time.increaseTo(deadline);
      const tx = escrow.connect(buyer).refund(ID);
      await expect(tx).to.emit(escrow, "Refunded").withArgs(ID, buyer.address, PRICE);
      await expect(tx).to.changeEtherBalances([escrow, buyer], [-PRICE, PRICE]);
      expect(await escrow.statusOf(ID)).to.equal(Status.Refunded);
      await expectInvariant(escrow);
    });

    it("до дедлайна и ровно в дедлайн возврат невозможен", async function () {
      const { escrow, buyer, deadline } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).refund(ID))
        .to.be.revertedWithCustomError(escrow, "DeadlineNotReached").withArgs(ID);
      await time.increaseTo(deadline - 1n); // следующая транзакция — ровно в deadline
      await expect(escrow.connect(buyer).refund(ID))
        .to.be.revertedWithCustomError(escrow, "DeadlineNotReached").withArgs(ID);
    });

    it("повторный возврат невозможен", async function () {
      const { escrow, buyer, deadline } = await loadFixture(fundedFixture);
      await time.increaseTo(deadline);
      await escrow.connect(buyer).refund(ID);
      await expect(escrow.connect(buyer).refund(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Refunded);
    });

    it("нельзя вернуть деньги за поставленную партию", async function () {
      const { escrow, buyer, deadline } = await loadFixture(deliveredFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(buyer).refund(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Delivered);
    });

    it("нельзя вернуть деньги за неоплаченную партию", async function () {
      const { escrow, buyer, deadline } = await loadFixture(createdFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(buyer).refund(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Created);
    });

    it("доступен только покупателю", async function () {
      const { escrow, supplier, deadline, BUYER_ROLE } = await loadFixture(fundedFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(supplier).refund(ID))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(supplier.address, BUYER_ROLE);
    });
  });

  // ------------------------------------------------------------- rejectDelivery
  describe("rejectDelivery", function () {
    it("покупатель отклоняет партию и получает деньги обратно", async function () {
      const { escrow, buyer, supplier } = await loadFixture(deliveredFixture);
      const tx = escrow.connect(buyer).rejectDelivery(ID);
      await expect(tx).to.emit(escrow, "Refunded").withArgs(ID, buyer.address, PRICE);
      await expect(tx).to.changeEtherBalances([escrow, buyer], [-PRICE, PRICE]);
      await expect(escrow.connect(supplier).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(ID, Status.Refunded);
    });

    it("после дедлайна отклонить партию нельзя", async function () {
      const { escrow, buyer, deadline } = await loadFixture(deliveredFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(buyer).rejectDelivery(ID))
        .to.be.revertedWithCustomError(escrow, "DeadlinePassed").withArgs(ID);
    });

    it("доступно только покупателю", async function () {
      const { escrow, supplier, BUYER_ROLE } = await loadFixture(deliveredFixture);
      await expect(escrow.connect(supplier).rejectDelivery(ID))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(supplier.address, BUYER_ROLE);
    });
  });

  // ------------------------------------------------------- безопасность и инварианты
  describe("Безопасность", function () {
    it("ReentrancyGuard блокирует повторный вход при выплате", async function () {
      const [buyer] = await ethers.getSigners();
      const Attacker = await ethers.getContractFactory("MaliciousSupplier");
      const attacker = await Attacker.deploy();
      const Escrow = await ethers.getContractFactory("OilGasEscrow");
      const escrow = await Escrow.deploy(buyer.address, await attacker.getAddress());
      await attacker.setEscrow(await escrow.getAddress());

      const deadline = BigInt(await time.latest()) + WEEK;
      await escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, SPEC, deadline);
      await escrow.connect(buyer).fundBatch(ID, { value: PRICE });
      await attacker.deliver(ID);

      await escrow.connect(buyer).releasePayment(ID);
      expect(await attacker.reentryBlocked()).to.equal(true);
      expect(await attacker.receiveCalls()).to.equal(1n);
      expect(await attacker.receivedTotal()).to.equal(PRICE);
      await expectInvariant(escrow);
    });

    it("если поставщик не принимает ETH, транзакция откатывается целиком", async function () {
      const [buyer] = await ethers.getSigners();
      const Bad = await ethers.getContractFactory("NonPayableSupplier");
      const bad = await Bad.deploy();
      const Escrow = await ethers.getContractFactory("OilGasEscrow");
      const escrow = await Escrow.deploy(buyer.address, await bad.getAddress());
      await bad.setEscrow(await escrow.getAddress());

      const deadline = BigInt(await time.latest()) + WEEK;
      await escrow.connect(buyer).createBatch(ID, VOLUME, PRICE, SPEC, deadline);
      await escrow.connect(buyer).fundBatch(ID, { value: PRICE });
      await bad.deliver(ID);

      await expect(escrow.connect(buyer).releasePayment(ID))
        .to.be.revertedWithCustomError(escrow, "TransferFailed");
      // статус не изменился — средства остались на контракте
      expect(await escrow.statusOf(ID)).to.equal(Status.Delivered);
      await expectInvariant(escrow);
    });

    it("инвариант balance == totalLocked сохраняется для нескольких партий", async function () {
      const { escrow, buyer, supplier, deadline } = await loadFixture(deployFixture);
      for (const id of [1n, 2n, 3n]) {
        await escrow.connect(buyer).createBatch(id, VOLUME, PRICE * id, SPEC, deadline);
        await escrow.connect(buyer).fundBatch(id, { value: PRICE * id });
        await expectInvariant(escrow);
      }
      expect(await escrow.totalLocked()).to.equal(PRICE * 6n);

      await escrow.connect(supplier).markDelivered(1n);
      await escrow.connect(buyer).releasePayment(1n);
      await expectInvariant(escrow);

      await escrow.connect(supplier).markDelivered(2n);
      await escrow.connect(buyer).rejectDelivery(2n);
      await expectInvariant(escrow);

      await time.increaseTo(deadline);
      await escrow.connect(buyer).refund(3n);
      await expectInvariant(escrow);
      expect(await escrow.totalLocked()).to.equal(0n);
      expect(await escrow.getBatchIds()).to.deep.equal([1n, 2n, 3n]);
    });

    it("геттеры отклоняют несуществующую партию", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.getBatch(42)).to.be.revertedWithCustomError(escrow, "BatchNotFound").withArgs(42);
      await expect(escrow.statusOf(42)).to.be.revertedWithCustomError(escrow, "BatchNotFound").withArgs(42);
      expect(await escrow.batchExists(42)).to.equal(false);
    });
  });
});
