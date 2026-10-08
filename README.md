# OilGasEscrow — смартконтракт эскроу для поставки нефти/газа

Учебный проект: эскроу-контракт на Solidity, который хранит оплату покупателя до подтверждения поставки партии нефти или газа. Код, тесты и документация подготовлены с помощью ИИ (prompt coding), ключевые промпты — в `prompt-log.md`, результаты ревью безопасности — в `audit-notes.md`.

## Стек

- Solidity ^0.8.24 (компилятор 0.8.24)
- Hardhat 2 + `@nomicfoundation/hardhat-toolbox` (ethers v6, chai, coverage, gas reporter)
- OpenZeppelin Contracts 5: `AccessControl`, `ReentrancyGuard`
- Тесты: JavaScript (Mocha + Chai)

## Структура

```
contracts/
  OilGasEscrow.sol            основной контракт
  test/MaliciousSupplier.sol  контракты-«злоумышленники» для тестов безопасности
test/
  OilGasEscrow.test.js        юнит-тесты
scripts/
  deploy.js                   деплой
  demo.js                     демонстрация двух сценариев
prompt-log.md                 ключевые промпты и ответы ИИ
audit-notes.md                мини-аудит: проблемы и исправления
```

## Установка и запуск

Нужны Node.js 18+ (рекомендуется 20 LTS) и Git.

```bash
npm install          # установка зависимостей
npx hardhat compile  # компиляция
npx hardhat test     # тесты
npx hardhat coverage # покрытие кода тестами
npm run demo         # демонстрация сценариев в консоли
```

Деплой в локальную сеть:

```bash
npx hardhat node        # терминал 1: локальный блокчейн
npm run deploy:local    # терминал 2: деплой
```

Адреса сторон можно передать через переменные окружения `BUYER_ADDRESS` и `SUPPLIER_ADDRESS`; по умолчанию берутся первые два тестовых аккаунта Hardhat.

## Архитектура

### Роли

| Роль | Кто | Что может |
|---|---|---|
| `BUYER_ROLE` | покупатель | создать партию, оплатить, подтвердить приёмку, отклонить партию, вернуть деньги по таймауту |
| `SUPPLIER_ROLE` | поставщик | отметить поставку; забрать оплату сам после дедлайна, если покупатель не ответил |

Роли назначаются один раз в конструкторе. Администратор ролей не назначается, поэтому роли нельзя переназначить или отобрать. Оплата всегда уходит на неизменяемый адрес `supplier`, возврат — на `buyer`.

### Партия (Batch)

`id`, `volume`, `priceWei`, `specHash` (bytes32-хэш спецификации и сопроводительных документов), `status`, `deadline` (unix time).

### Статусы и переходы

```
Created --fundBatch--> Funded --markDelivered--> Delivered --releasePayment--> Released
                          |                          |
                          |                          +--rejectDelivery (до дедлайна)--> Refunded
                          +--refund (после дедлайна)------------------------------------> Refunded
```

| Функция | Кто | Условия |
|---|---|---|
| `createBatch(id, volume, priceWei, specHash, deadline)` | покупатель | id новый; volume, priceWei > 0; specHash ≠ 0; deadline в будущем |
| `fundBatch(id)` payable | покупатель | статус Created; `msg.value == priceWei`; не позже дедлайна |
| `markDelivered(id)` | поставщик | статус Funded; не позже дедлайна |
| `releasePayment(id)` | покупатель; поставщик — только после дедлайна | статус Delivered |
| `refund(id)` | покупатель | статус Funded; строго после дедлайна |
| `rejectDelivery(id)` | покупатель | статус Delivered; не позже дедлайна |

Геттеры: `getBatch`, `statusOf`, `batchExists`, `batchCount`, `getBatchIds`, `totalLocked`.

События: `BatchCreated`, `Funded`, `Delivered`, `PaymentReleased`, `Refunded`.

### Безопасность

- `nonReentrant` на всех функциях, работающих с ETH (`fundBatch`, `releasePayment`, `refund`, `rejectDelivery`).
- Паттерн Checks-Effects-Interactions: статус меняется и событие эмитится до перевода ETH.
- Модификаторы доступа `onlyRole`, строгая проверка статусов (повторные выплаты/возвраты невозможны).
- Инвариант `address(this).balance >= totalLocked` проверяется в тестах.
- Контракт не принимает прямые переводы ETH (нет `receive`/`fallback`).
- Перевод через `call` с проверкой результата (`TransferFailed`).

## Ограничения

- Одна пара покупатель–поставщик на один экземпляр контракта.
- Факт поставки и соответствие спецификации подтверждаются сторонами вручную; оракулов (датчики, инспекция) нет.
- Если покупатель не ответил до дедлайна после отметки о поставке, поставщик может забрать оплату сам — покупатель должен успеть отклонить партию до дедлайна.
- Оплата только в ETH (без ERC-20), учебный проект, не проходил профессиональный аудит.
