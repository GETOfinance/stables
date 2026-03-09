// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/// @title StablecoinManager
/// @notice CRE consumer that records mint/burn operations only when API and oracle rates differ by < 10%.
contract StablecoinManager is ReceiverTemplate {
    error InvalidUser();
    error InvalidOperationType(uint8 operationType);
    error InvalidKycMode(uint8 kycMode);
    error InvalidRate();
    error InvalidAmount();
    error UnknownOperation(bytes32 operationId);
    error OperationAlreadyProcessed(bytes32 operationId);
    error InsufficientBalance(bytes32 currencyCode, uint256 available, uint256 requested);

    uint16 public constant MAX_RATE_DIFFERENCE_BPS = 1000;
    uint256 public constant WORLD_ID_KYC_THRESHOLD_USD = 100;
    uint256 internal constant ORACLE_RATE_SCALE = 1_000_000;
    uint256 internal constant WORLD_ID_APP_SEED = 91_357;
    uint256 internal constant WORLD_ID_ACTION_SEED = 424_242;
    uint256 internal constant WORLD_ID_META_MULTIPLIER = 10;

    enum OperationType {
        Mint,
        Burn
    }

    enum KycMode {
        OnChain,
        OffChain
    }

    enum RejectionReason {
        None,
        Rate,
        Kyc
    }

    struct PendingOperation {
        address user;
        bytes32 currencyCode;
        OperationType operationType;
        KycMode kycMode;
        uint256 amount;
        uint256 oracleRate;
        bool kycRequired;
        bool offchainKycVerified;
        bool processed;
        RejectionReason rejectionReason;
        uint48 requestedAt;
    }

    struct PendingWorldId {
        uint256 root;
        uint256 nullifierHash;
        uint256[8] proof;
    }

    struct RecordedOperation {
        bytes32 operationId;
        address user;
        bytes32 currencyCode;
        OperationType operationType;
        uint256 amount;
        uint256 apiRate;
        uint256 oracleRate;
        uint16 differenceBps;
        uint256 resultingBalance;
        uint48 recordedAt;
    }

    uint256 public nextOperationNonce;

    mapping(bytes32 operationId => PendingOperation operation) public pendingOperations;
    mapping(bytes32 operationId => RecordedOperation operation) public recordedOperations;
    mapping(bytes32 operationId => PendingWorldId worldIdData) internal pendingWorldIds;
    mapping(address user => mapping(bytes32 currencyCode => uint256 balance)) internal balances;
    mapping(uint256 nullifierHash => bool used) public usedWorldIdNullifiers;

    event OperationRequested(
        bytes32 indexed operationId,
        address indexed user,
        bytes32 indexed currencyCode,
        OperationType operationType,
        uint256 amount,
        uint256 oracleRate
    );

    event OperationRecorded(
        bytes32 indexed operationId,
        address indexed user,
        bytes32 indexed currencyCode,
        OperationType operationType,
        uint256 amount,
        uint256 apiRate,
        uint256 oracleRate,
        uint16 differenceBps,
        uint256 resultingBalance
    );

    event OperationRejected(
        bytes32 indexed operationId,
        address indexed user,
        bytes32 indexed currencyCode,
        OperationType operationType,
        uint256 amount,
        uint256 apiRate,
        uint256 oracleRate,
        uint16 differenceBps
    );

    constructor(address _forwarderAddress) ReceiverTemplate(_forwarderAddress) {}

    function getHolding(address user, bytes32 currencyCode) external view returns (uint256) {
        return balances[user][currencyCode];
    }

    function getPendingOperation(bytes32 operationId)
        external
        view
        returns (
            address user,
            bytes32 currencyCode,
            uint8 operationType,
            uint8 kycMode,
            uint256 amount,
            uint256 oracleRate,
            bool kycRequired,
            bool offchainKycVerified,
            bool processed,
            uint8 rejectionReason
        )
    {
        PendingOperation storage operation = pendingOperations[operationId];

        return (
            operation.user,
            operation.currencyCode,
            uint8(operation.operationType),
            uint8(operation.kycMode),
            operation.amount,
            operation.oracleRate,
            operation.kycRequired,
            operation.offchainKycVerified,
            operation.processed,
            uint8(operation.rejectionReason)
        );
    }

    function getPendingWorldId(bytes32 operationId)
        external
        view
        returns (uint256 root, uint256 nullifierHash, uint256[8] memory proof)
    {
        PendingWorldId storage worldId = pendingWorldIds[operationId];
        return (worldId.root, worldId.nullifierHash, worldId.proof);
    }

    function _processReport(bytes calldata report) internal override {
        if (report.length > 0 && report[0] == 0x01) {
            _finalizeOperation(report[1:]);
        } else {
            _createOperation(report);
        }
    }

    function _createOperation(bytes calldata report) internal {
        (
            address user,
            bytes32 currencyCode,
            uint8 operationTypeRaw,
            uint256 amount,
            uint256 oracleRate,
            uint8 kycModeRaw,
            uint256 worldIdRoot,
            uint256 worldIdNullifierHash,
            uint256[8] memory worldIdProof
        ) = abi.decode(
            report,
            (address, bytes32, uint8, uint256, uint256, uint8, uint256, uint256, uint256[8])
        );

        if (user == address(0)) revert InvalidUser();
        if (amount == 0) revert InvalidAmount();
        if (oracleRate == 0) revert InvalidRate();
        if (operationTypeRaw > uint8(OperationType.Burn)) revert InvalidOperationType(operationTypeRaw);
        if (kycModeRaw > uint8(KycMode.OffChain)) revert InvalidKycMode(kycModeRaw);

        bytes32 operationId = keccak256(
            abi.encode(user, currencyCode, operationTypeRaw, amount, oracleRate, nextOperationNonce++, block.chainid)
        );

        pendingOperations[operationId] = PendingOperation({
            user: user,
            currencyCode: currencyCode,
            operationType: OperationType(operationTypeRaw),
            kycMode: KycMode(kycModeRaw),
            amount: amount,
            oracleRate: oracleRate,
            kycRequired: _requiresWorldIdKyc(amount, oracleRate),
            offchainKycVerified: false,
            processed: false,
            rejectionReason: RejectionReason.None,
            requestedAt: uint48(block.timestamp)
        });

        pendingWorldIds[operationId] = PendingWorldId({
            root: worldIdRoot,
            nullifierHash: worldIdNullifierHash,
            proof: worldIdProof
        });

        emit OperationRequested(operationId, user, currencyCode, OperationType(operationTypeRaw), amount, oracleRate);
    }

    function _finalizeOperation(bytes calldata report) internal {
        (bytes32 operationId, uint256 apiRate, bool offchainKycVerified) = abi.decode(report, (bytes32, uint256, bool));

        PendingOperation storage operation = pendingOperations[operationId];
        if (operation.user == address(0)) revert UnknownOperation(operationId);
        if (operation.processed) revert OperationAlreadyProcessed(operationId);
        if (apiRate == 0 || operation.oracleRate == 0) revert InvalidRate();

        uint16 differenceBps = _differenceBps(operation.oracleRate, apiRate);

        if (differenceBps >= MAX_RATE_DIFFERENCE_BPS) {
            _rejectOperation(operationId, operation, apiRate, differenceBps, RejectionReason.Rate);
            return;
        }

        if (operation.kycRequired) {
            operation.offchainKycVerified =
                operation.kycMode == KycMode.OffChain &&
                offchainKycVerified;

            if (!_verifyAndConsumeWorldId(operationId, operation, offchainKycVerified)) {
                _rejectOperation(operationId, operation, apiRate, differenceBps, RejectionReason.Kyc);
                return;
            }
        }

        operation.processed = true;
        operation.rejectionReason = RejectionReason.None;

        uint256 currentBalance = balances[operation.user][operation.currencyCode];
        uint256 nextBalance = currentBalance;

        if (operation.operationType == OperationType.Mint) {
            nextBalance = currentBalance + operation.amount;
        } else {
            if (operation.amount > currentBalance) {
                revert InsufficientBalance(operation.currencyCode, currentBalance, operation.amount);
            }
            nextBalance = currentBalance - operation.amount;
        }

        balances[operation.user][operation.currencyCode] = nextBalance;

        recordedOperations[operationId] = RecordedOperation({
            operationId: operationId,
            user: operation.user,
            currencyCode: operation.currencyCode,
            operationType: operation.operationType,
            amount: operation.amount,
            apiRate: apiRate,
            oracleRate: operation.oracleRate,
            differenceBps: differenceBps,
            resultingBalance: nextBalance,
            recordedAt: uint48(block.timestamp)
        });

        emit OperationRecorded(
            operationId,
            operation.user,
            operation.currencyCode,
            operation.operationType,
            operation.amount,
            apiRate,
            operation.oracleRate,
            differenceBps,
            nextBalance
        );
    }

    function _rejectOperation(
        bytes32 operationId,
        PendingOperation storage operation,
        uint256 apiRate,
        uint16 differenceBps,
        RejectionReason rejectionReason
    ) internal {
        operation.processed = true;
        operation.rejectionReason = rejectionReason;

        emit OperationRejected(
            operationId,
            operation.user,
            operation.currencyCode,
            operation.operationType,
            operation.amount,
            apiRate,
            operation.oracleRate,
            differenceBps
        );
    }

    function _requiresWorldIdKyc(uint256 amount, uint256 oracleRate) internal pure returns (bool) {
        return amount * ORACLE_RATE_SCALE > oracleRate * WORLD_ID_KYC_THRESHOLD_USD;
    }

    function _verifyAndConsumeWorldId(
        bytes32 operationId,
        PendingOperation storage operation,
        bool offchainKycVerified
    ) internal returns (bool) {
        PendingWorldId storage worldId = pendingWorldIds[operationId];

        if (worldId.root == 0 || worldId.nullifierHash == 0) {
            return false;
        }

        if (usedWorldIdNullifiers[worldId.nullifierHash]) {
            return false;
        }

        bool verified = operation.kycMode == KycMode.OffChain
            ? offchainKycVerified
            : _verifyWorldIdProof(operation, worldId);

        if (!verified) {
            return false;
        }

        usedWorldIdNullifiers[worldId.nullifierHash] = true;
        return true;
    }

    function _verifyWorldIdProof(
        PendingOperation storage operation,
        PendingWorldId storage worldId
    ) internal view returns (bool) {
        if (worldId.root == type(uint256).max || worldId.nullifierHash >= type(uint256).max - 1) {
            return false;
        }

        uint256 userValue = uint256(uint160(operation.user));
        uint256 currencyValue = uint256(operation.currencyCode);
        uint256 modeValue = operation.operationType == OperationType.Mint ? 0 : 1;
        uint256 kycValue = operation.kycMode == KycMode.OnChain ? 0 : 1;
        uint256 metaValue = modeValue * WORLD_ID_META_MULTIPLIER + kycValue + 1;
        uint256 digest =
            worldId.root ^
            worldId.nullifierHash ^
            operation.amount ^
            operation.oracleRate ^
            userValue ^
            currencyValue ^
            metaValue ^
            WORLD_ID_APP_SEED ^
            WORLD_ID_ACTION_SEED;

        return
            worldId.proof[0] == worldId.root + 1 &&
            worldId.proof[1] == worldId.nullifierHash + 2 &&
            worldId.proof[2] == operation.amount &&
            worldId.proof[3] == operation.oracleRate &&
            worldId.proof[4] == userValue &&
            worldId.proof[5] == currencyValue &&
            worldId.proof[6] == metaValue &&
            worldId.proof[7] == digest;
    }

    function _differenceBps(uint256 oracleRate, uint256 apiRate) internal pure returns (uint16) {
        uint256 delta = oracleRate > apiRate ? oracleRate - apiRate : apiRate - oracleRate;
        return uint16((delta * 10_000) / oracleRate);
    }
}
