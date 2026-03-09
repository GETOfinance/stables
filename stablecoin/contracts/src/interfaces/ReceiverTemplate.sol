// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165, IReceiver} from "./IReceiver.sol";

/// @title ReceiverTemplate
/// @notice Bootcamp-style minimal receiver template guarded by a CRE forwarder.
abstract contract ReceiverTemplate is IReceiver {
    error InvalidForwarder();
    error UnauthorizedForwarder(address caller);

    address public immutable forwarderAddress;

    constructor(address _forwarderAddress) {
        if (_forwarderAddress == address(0)) revert InvalidForwarder();
        forwarderAddress = _forwarderAddress;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarderAddress) revert UnauthorizedForwarder(msg.sender);
        _beforeProcessReport(metadata, report);
        _processReport(report);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _beforeProcessReport(bytes calldata metadata, bytes calldata report) internal virtual {
        metadata;
        report;
    }

    function _processReport(bytes calldata report) internal virtual;
}
