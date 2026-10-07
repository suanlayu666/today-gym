// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply demo credit. No mint admin, appreciation or RMB backing.
contract GymToken is ERC20 {
    constructor(address[] memory recipients, uint256[] memory amounts) ERC20("Gym Demo Credit", "GYM") {
        require(recipients.length == amounts.length && recipients.length > 0, "Invalid distribution");
        for (uint256 i; i < recipients.length; i++) {
            require(recipients[i] != address(0) && amounts[i] > 0, "Invalid recipient");
            _mint(recipients[i], amounts[i]);
        }
    }
    function decimals() public pure override returns (uint8) { return 0; }
}
