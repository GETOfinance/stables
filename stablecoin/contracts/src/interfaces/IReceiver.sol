// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal IERC165 interface used by the CRE receiver scaffold.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title IReceiver
/// @notice Minimal receiver interface for CRE-forwarded reports.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
