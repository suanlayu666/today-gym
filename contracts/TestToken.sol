// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @dev Test-only fault injection; never deployed by the production/demo deployment script.
contract TestToken is ERC20 {
    bool public fail; bool public attack; address public escrow; bool public callbackBlocked;
    constructor(address recipient) ERC20("Test-only token", "TEST") { _mint(recipient, 30000); }
    function configure(bool f, bool a, address e) external { fail=f; attack=a; escrow=e; }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if(fail) return false; return super.transfer(to,amount);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if(fail) return false; return super.transferFrom(from,to,amount);
    }
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from,to,amount);
        if(attack && (to==escrow || from==escrow)) {
            attack=false;
            (bool ok,)=escrow.call(abi.encodeWithSignature("refund(uint256)",1));
            callbackBlocked=!ok;
        }
    }
}
