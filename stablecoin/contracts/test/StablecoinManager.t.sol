// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StablecoinManager} from "../src/StablecoinManager.sol";

contract StablecoinManagerTest {
    uint256 internal constant WORLD_ID_APP_SEED = 91_357;
    uint256 internal constant WORLD_ID_ACTION_SEED = 424_242;
    uint256 internal constant WORLD_ID_META_MULTIPLIER = 10;

    address internal constant USER = address(0xBEEF);
    bytes32 internal constant USD = bytes32("USD");

    StablecoinManager internal manager;

    struct WorldIdFixture {
        uint256 root;
        uint256 nullifierHash;
        uint256[8] proof;
    }

    function setUp() public {
        manager = new StablecoinManager(address(this));
    }

    function testAllowsRequestsAtThresholdWithoutWorldId() public {
        bytes32 operationId = _createOperation(USER, USD, 0, 100, 1_000_000, 0, 0, 0, _emptyProof());

        manager.onReport("", _finalizeReport(operationId, 1_018_000, false));

        require(manager.getHolding(USER, USD) == 100, "holding not updated");
        (, , , , , , bool kycRequired, , bool processed, uint8 rejectionReason) = manager.getPendingOperation(operationId);
        require(!kycRequired, "threshold request should not require kyc");
        require(processed, "operation should be processed");
        require(rejectionReason == 0, "unexpected rejection reason");
    }

    function testOnChainWorldIdVerificationAboveThreshold() public {
        WorldIdFixture memory worldId = _buildWorldId(USER, USD, 0, 101, 1_000_000, 0, 11);
        bytes32 operationId = _createOperation(USER, USD, 0, 101, 1_000_000, 0, worldId.root, worldId.nullifierHash, worldId.proof);

        manager.onReport("", _finalizeReport(operationId, 1_005_000, false));

        require(manager.getHolding(USER, USD) == 101, "on-chain kyc mint failed");
        require(manager.usedWorldIdNullifiers(worldId.nullifierHash), "nullifier should be marked used");
        (, , , uint8 kycMode, , , bool kycRequired, bool offchainKycVerified, bool processed, uint8 rejectionReason) = manager
            .getPendingOperation(operationId);
        require(kycRequired, "kyc should be required");
        require(kycMode == 0, "expected on-chain mode");
        require(!offchainKycVerified, "off-chain flag should be false");
        require(processed, "operation should be processed");
        require(rejectionReason == 0, "operation should not be rejected");
    }

    function testOffChainWorldIdVerificationAboveThreshold() public {
        WorldIdFixture memory worldId = _buildWorldId(USER, USD, 0, 101, 1_000_000, 1, 22);
        bytes32 operationId = _createOperation(USER, USD, 0, 101, 1_000_000, 1, worldId.root, worldId.nullifierHash, worldId.proof);

        manager.onReport("", _finalizeReport(operationId, 1_004_000, true));

        require(manager.getHolding(USER, USD) == 101, "off-chain kyc mint failed");
        require(manager.usedWorldIdNullifiers(worldId.nullifierHash), "off-chain nullifier should be marked used");
        (, , , uint8 kycMode, , , bool kycRequired, bool offchainKycVerified, bool processed, uint8 rejectionReason) = manager
            .getPendingOperation(operationId);
        require(kycRequired, "kyc should be required");
        require(kycMode == 1, "expected off-chain mode");
        require(offchainKycVerified, "off-chain verification flag should be stored");
        require(processed, "operation should be processed");
        require(rejectionReason == 0, "operation should not be rejected");
    }

    function testRejectsReusedWorldIdNullifier() public {
        WorldIdFixture memory worldId = _buildWorldId(USER, USD, 0, 101, 1_000_000, 0, 33);
        bytes32 firstOperationId = _createOperation(USER, USD, 0, 101, 1_000_000, 0, worldId.root, worldId.nullifierHash, worldId.proof);

        manager.onReport("", _finalizeReport(firstOperationId, 1_003_000, false));
        require(manager.getHolding(USER, USD) == 101, "first mint should succeed");

        bytes32 secondOperationId = _createOperation(USER, USD, 0, 101, 1_000_000, 0, worldId.root, worldId.nullifierHash, worldId.proof);
        manager.onReport("", _finalizeReport(secondOperationId, 1_003_000, false));

        require(manager.getHolding(USER, USD) == 101, "replayed nullifier should not change holdings");
        (, , , , , , , , bool processed, uint8 rejectionReason) = manager.getPendingOperation(secondOperationId);
        require(processed, "replayed operation should be processed");
        require(rejectionReason == 2, "replayed nullifier should reject for kyc");
    }

    function testBurnStillRevertsWhenBalanceIsInsufficient() public {
        bytes32 mintOperationId = _createOperation(USER, USD, 0, 20, 1_000_000, 0, 0, 0, _emptyProof());
        manager.onReport("", _finalizeReport(mintOperationId, 1_002_000, false));
        require(manager.getHolding(USER, USD) == 20, "setup mint failed");

        bytes32 burnOperationId = _createOperation(USER, USD, 1, 50, 1_000_000, 0, 0, 0, _emptyProof());

        try manager.onReport("", _finalizeReport(burnOperationId, 1_002_000, false)) {
            revert("expected insufficient balance revert");
        } catch (bytes memory reason) {
            require(_selector(reason) == StablecoinManager.InsufficientBalance.selector, "wrong revert selector");
        }

        require(manager.getHolding(USER, USD) == 20, "balance should remain unchanged");
        (, , , , , , , , bool processed, ) = manager.getPendingOperation(burnOperationId);
        require(!processed, "failed burn should not remain processed after revert");
    }

    function _createOperation(
        address user,
        bytes32 currencyCode,
        uint8 operationType,
        uint256 amount,
        uint256 oracleRate,
        uint8 kycMode,
        uint256 root,
        uint256 nullifierHash,
        uint256[8] memory proof
    ) internal returns (bytes32 operationId) {
        uint256 nonce = manager.nextOperationNonce();
        operationId = keccak256(abi.encode(user, currencyCode, operationType, amount, oracleRate, nonce, block.chainid));
        manager.onReport("", abi.encode(user, currencyCode, operationType, amount, oracleRate, kycMode, root, nullifierHash, proof));
    }

    function _finalizeReport(bytes32 operationId, uint256 apiRate, bool offchainKycVerified)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(bytes1(0x01), abi.encode(operationId, apiRate, offchainKycVerified));
    }

    function _buildWorldId(
        address user,
        bytes32 currencyCode,
        uint8 operationType,
        uint256 amount,
        uint256 oracleRate,
        uint8 kycMode,
        uint256 seed
    ) internal pure returns (WorldIdFixture memory worldId) {
        worldId.root = seed * 17 + uint256(currencyCode) + WORLD_ID_APP_SEED;
        worldId.nullifierHash = seed * 31 + amount + oracleRate + WORLD_ID_ACTION_SEED;

        uint256 userValue = uint256(uint160(user));
        uint256 modeValue = operationType == 0 ? 0 : 1;
        uint256 kycValue = kycMode == 0 ? 0 : 1;
        uint256 metaValue = modeValue * WORLD_ID_META_MULTIPLIER + kycValue + 1;
        uint256 digest =
            worldId.root ^
            worldId.nullifierHash ^
            amount ^
            oracleRate ^
            userValue ^
            uint256(currencyCode) ^
            metaValue ^
            WORLD_ID_APP_SEED ^
            WORLD_ID_ACTION_SEED;

        worldId.proof = [
            worldId.root + 1,
            worldId.nullifierHash + 2,
            amount,
            oracleRate,
            userValue,
            uint256(currencyCode),
            metaValue,
            digest
        ];
    }

    function _emptyProof() internal pure returns (uint256[8] memory proof) {
        return proof;
    }

    function _selector(bytes memory revertData) internal pure returns (bytes4 value) {
        if (revertData.length < 4) {
            return bytes4(0);
        }

        assembly {
            value := mload(add(revertData, 32))
        }
    }
}