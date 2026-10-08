// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OilGasEscrow — эскроу-контракт для поставки партий нефти/газа
/// @notice Покупатель создаёт партию и вносит оплату на контракт. Поставщик отмечает поставку.
///         Покупатель подтверждает приёмку (деньги уходят поставщику) или отклоняет партию
///         (деньги возвращаются покупателю). Если партия не поставлена до дедлайна —
///         покупатель забирает деньги через refund().
/// @dev Роли buyer/supplier назначаются один раз в конструкторе. Администратор ролей
///      (DEFAULT_ADMIN_ROLE) намеренно не назначается, поэтому роли нельзя переназначить.
///      Все функции с переводом ETH защищены nonReentrant и следуют паттерну
///      Checks-Effects-Interactions.
contract OilGasEscrow is AccessControl, ReentrancyGuard {
    /// @notice Роль покупателя
    bytes32 public constant BUYER_ROLE = keccak256("BUYER_ROLE");
    /// @notice Роль поставщика
    bytes32 public constant SUPPLIER_ROLE = keccak256("SUPPLIER_ROLE");

    /// @notice Жизненный цикл партии
    enum Status {
        Created,   // партия создана покупателем, оплаты ещё нет
        Funded,    // оплата внесена на контракт
        Delivered, // поставщик отметил поставку
        Released,  // оплата переведена поставщику (конечный статус)
        Refunded   // оплата возвращена покупателю (конечный статус)
    }

    /// @notice Партия нефти/газа
    struct Batch {
        uint256 id;        // идентификатор партии
        uint256 volume;    // объём партии (например, баррели или тыс. м3)
        uint256 priceWei;  // цена партии в wei
        bytes32 specHash;  // хэш спецификации и сопроводительных документов
        Status status;     // текущий статус
        uint256 deadline;  // крайний срок поставки (unix time, секунды)
    }

    /// @notice Адрес покупателя (получатель возвратов)
    address public immutable buyer;
    /// @notice Адрес поставщика (получатель оплаты)
    address public immutable supplier;
    /// @notice Сумма, заблокированная на контракте по оплаченным, но не закрытым партиям
    /// @dev Инвариант: address(this).balance >= totalLocked
    uint256 public totalLocked;

    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => bool) private _exists;
    uint256[] private _batchIds;

    // ----------------------------------------------------------------- события
    event BatchCreated(uint256 indexed id, uint256 volume, uint256 priceWei, bytes32 specHash, uint256 deadline);
    event Funded(uint256 indexed id, address indexed from, uint256 amount);
    event Delivered(uint256 indexed id, address indexed by);
    event PaymentReleased(uint256 indexed id, address indexed to, uint256 amount);
    event Refunded(uint256 indexed id, address indexed to, uint256 amount);

    // ----------------------------------------------------------------- ошибки
    error ZeroAddress();
    error SameParties();
    error InvalidParameter(string field);
    error BatchAlreadyExists(uint256 id);
    error BatchNotFound(uint256 id);
    error InvalidStatus(uint256 id, Status current);
    error WrongPaymentAmount(uint256 expected, uint256 sent);
    error DeadlinePassed(uint256 id);
    error DeadlineNotReached(uint256 id);
    error NotAuthorized();
    error TransferFailed();

    /// @param buyer_ адрес покупателя
    /// @param supplier_ адрес поставщика
    constructor(address buyer_, address supplier_) {
        if (buyer_ == address(0) || supplier_ == address(0)) revert ZeroAddress();
        if (buyer_ == supplier_) revert SameParties();
        buyer = buyer_;
        supplier = supplier_;
        _grantRole(BUYER_ROLE, buyer_);
        _grantRole(SUPPLIER_ROLE, supplier_);
    }

    // ------------------------------------------------------- основные функции

    /// @notice Создать партию (только покупатель)
    /// @param id уникальный идентификатор партии
    /// @param volume объём партии, > 0
    /// @param priceWei цена партии в wei, > 0
    /// @param specHash хэш спецификации и документов, не нулевой
    /// @param deadline крайний срок поставки, должен быть в будущем
    function createBatch(
        uint256 id,
        uint256 volume,
        uint256 priceWei,
        bytes32 specHash,
        uint256 deadline
    ) external onlyRole(BUYER_ROLE) {
        if (_exists[id]) revert BatchAlreadyExists(id);
        if (volume == 0) revert InvalidParameter("volume");
        if (priceWei == 0) revert InvalidParameter("priceWei");
        if (specHash == bytes32(0)) revert InvalidParameter("specHash");
        if (deadline <= block.timestamp) revert InvalidParameter("deadline");

        _exists[id] = true;
        _batchIds.push(id);
        _batches[id] = Batch({
            id: id,
            volume: volume,
            priceWei: priceWei,
            specHash: specHash,
            status: Status.Created,
            deadline: deadline
        });

        emit BatchCreated(id, volume, priceWei, specHash, deadline);
    }

    /// @notice Внести оплату за партию (только покупатель, сумма строго равна priceWei)
    function fundBatch(uint256 id) external payable nonReentrant onlyRole(BUYER_ROLE) {
        Batch storage b = _getBatch(id);
        if (b.status != Status.Created) revert InvalidStatus(id, b.status);
        if (block.timestamp > b.deadline) revert DeadlinePassed(id);
        if (msg.value != b.priceWei) revert WrongPaymentAmount(b.priceWei, msg.value);

        b.status = Status.Funded;
        totalLocked += msg.value;

        emit Funded(id, msg.sender, msg.value);
    }

    /// @notice Отметить поставку партии (только поставщик, не позднее дедлайна)
    function markDelivered(uint256 id) external onlyRole(SUPPLIER_ROLE) {
        Batch storage b = _getBatch(id);
        if (b.status != Status.Funded) revert InvalidStatus(id, b.status);
        if (block.timestamp > b.deadline) revert DeadlinePassed(id);

        b.status = Status.Delivered;

        emit Delivered(id, msg.sender);
    }

    /// @notice Перевести оплату поставщику после поставки
    /// @dev Покупатель может подтвердить приёмку в любой момент после Delivered.
    ///      Поставщик может забрать оплату сам только после дедлайна, если покупатель
    ///      не подтвердил и не отклонил партию (защита от «зависания» средств).
    function releasePayment(uint256 id) external nonReentrant {
        Batch storage b = _getBatch(id);
        // Checks
        if (b.status != Status.Delivered) revert InvalidStatus(id, b.status);
        bool byBuyer = hasRole(BUYER_ROLE, msg.sender);
        bool bySupplierAfterDeadline = hasRole(SUPPLIER_ROLE, msg.sender) && block.timestamp > b.deadline;
        if (!byBuyer && !bySupplierAfterDeadline) revert NotAuthorized();

        // Effects
        uint256 amount = b.priceWei;
        b.status = Status.Released;
        totalLocked -= amount;
        emit PaymentReleased(id, supplier, amount);

        // Interactions
        _sendValue(supplier, amount);
    }

    /// @notice Вернуть оплату покупателю, если партия не поставлена до дедлайна
    function refund(uint256 id) external nonReentrant onlyRole(BUYER_ROLE) {
        Batch storage b = _getBatch(id);
        // Checks
        if (b.status != Status.Funded) revert InvalidStatus(id, b.status);
        if (block.timestamp <= b.deadline) revert DeadlineNotReached(id);

        // Effects
        uint256 amount = b.priceWei;
        b.status = Status.Refunded;
        totalLocked -= amount;
        emit Refunded(id, buyer, amount);

        // Interactions
        _sendValue(buyer, amount);
    }

    /// @notice Отклонить поставленную партию (не соответствует спецификации) и вернуть оплату
    /// @dev Доступно только покупателю и только до дедлайна.
    function rejectDelivery(uint256 id) external nonReentrant onlyRole(BUYER_ROLE) {
        Batch storage b = _getBatch(id);
        // Checks
        if (b.status != Status.Delivered) revert InvalidStatus(id, b.status);
        if (block.timestamp > b.deadline) revert DeadlinePassed(id);

        // Effects
        uint256 amount = b.priceWei;
        b.status = Status.Refunded;
        totalLocked -= amount;
        emit Refunded(id, buyer, amount);

        // Interactions
        _sendValue(buyer, amount);
    }

    // ----------------------------------------------------------------- геттеры

    /// @notice Полная информация о партии
    function getBatch(uint256 id) external view returns (Batch memory) {
        if (!_exists[id]) revert BatchNotFound(id);
        return _batches[id];
    }

    /// @notice Текущий статус партии
    function statusOf(uint256 id) external view returns (Status) {
        if (!_exists[id]) revert BatchNotFound(id);
        return _batches[id].status;
    }

    /// @notice Существует ли партия с таким id
    function batchExists(uint256 id) external view returns (bool) {
        return _exists[id];
    }

    /// @notice Количество созданных партий
    function batchCount() external view returns (uint256) {
        return _batchIds.length;
    }

    /// @notice Список id всех партий
    function getBatchIds() external view returns (uint256[] memory) {
        return _batchIds;
    }

    // ------------------------------------------------------------ внутренние

    function _getBatch(uint256 id) private view returns (Batch storage) {
        if (!_exists[id]) revert BatchNotFound(id);
        return _batches[id];
    }

    function _sendValue(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
