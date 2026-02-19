// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  MockNILToken
/// @notice Minimal ERC-20 mock for testing.  Anyone can mint.
/// @dev    Uses 6 decimals to match the real NIL token on Blacklight L2.
contract MockNILToken is ERC20 {
    constructor() ERC20("Nillion", "NIL") {}

    /// @notice Returns 6 decimals to match the real NIL token.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` tokens to `to`.  No access control (test only).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
