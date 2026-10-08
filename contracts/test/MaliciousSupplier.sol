// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOilGasEscrow {
    function markDelivered(uint256 id) external;
    function releasePayment(uint256 id) external;
}

/// @notice Тестовый «злоумышленник»: при получении оплаты пытается повторно вызвать releasePayment
contract MaliciousSupplier {
    IOilGasEscrow public escrow;
    uint256 public targetId;
    bool public reentryBlocked;
    uint256 public receiveCalls;
    uint256 public receivedTotal;

    function setEscrow(address escrow_) external {
        escrow = IOilGasEscrow(escrow_);
    }

    function deliver(uint256 id) external {
        targetId = id;
        escrow.markDelivered(id);
    }

    receive() external payable {
        receiveCalls++;
        receivedTotal += msg.value;
        try escrow.releasePayment(targetId) {
            // повторный вызов не должен пройти
        } catch {
            reentryBlocked = true;
        }
    }
}

/// @notice Тестовый поставщик без receive(): перевод ему ETH всегда завершается ошибкой
contract NonPayableSupplier {
    IOilGasEscrow public escrow;

    function setEscrow(address escrow_) external {
        escrow = IOilGasEscrow(escrow_);
    }

    function deliver(uint256 id) external {
        escrow.markDelivered(id);
    }
}
