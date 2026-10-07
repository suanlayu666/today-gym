// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A demo 100-visit card. Only the consumer can confirm consumption.
contract GymEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public immutable merchant;
    address public payoutAddress;
    uint256 public constant sessionPrice = 30;
    uint256 public constant cardDuration = 365 days;
    uint256 public constant requestDuration = 1 days;
    mapping(address => uint256) public balances;
    mapping(address => uint256) public validUntil;
    uint256 public totalUserCredit;
    uint256 public merchantAvailable;
    uint256 public nextRequestId = 1;
    enum Status { None, Requested, Confirmed, Rejected, Cancelled, Expired }
    struct Request { address user; bytes32 sessionKey; uint256 amount; uint256 createdAt; uint256 expiresAt; Status status; }
    mapping(uint256 => Request) public requests;
    mapping(address => uint256) public activeRequest;
    mapping(address => mapping(bytes32 => bool)) public usedSessionKeys;

    error Unauthorized(); error InvalidAmount(); error InvalidAddress(); error CardExpired();
    error InsufficientCredit(); error PendingRequest(); error DuplicateSession();
    error InvalidRequest(); error RequestExpired(); error NotExpired(); error InsufficientRevenue();

    event Deposited(address indexed user, uint256 amount, uint256 validUntil);
    event ConsumptionRequested(uint256 indexed id, address indexed user, bytes32 sessionKey, uint256 amount, uint256 expiresAt);
    event ConsumptionConfirmed(uint256 indexed id, address indexed user, uint256 amount, address confirmer);
    event ConsumptionRejected(uint256 indexed id, address indexed user);
    event ConsumptionCancelled(uint256 indexed id, address indexed user);
    event ConsumptionExpired(uint256 indexed id, address indexed user);
    event Refunded(address indexed user, uint256 amount);
    event Withdrawn(address indexed operator, address indexed to, uint256 amount, uint256 availableBefore);
    event PayoutAddressChanged(address indexed operator, address indexed oldAddress, address indexed newAddress);

    constructor(address tokenAddress, address merchantAddress, address initialPayout) {
        if (tokenAddress.code.length == 0 || merchantAddress == address(0) || initialPayout == address(0)) revert InvalidAddress();
        token = IERC20(tokenAddress); merchant = merchantAddress; payoutAddress = initialPayout;
    }
    modifier onlyMerchant() { if (msg.sender != merchant) revert Unauthorized(); _; }
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0 || amount % sessionPrice != 0) revert InvalidAmount();
        if (validUntil[msg.sender] == 0) validUntil[msg.sender] = block.timestamp + cardDuration;
        else if (block.timestamp >= validUntil[msg.sender]) revert CardExpired();
        balances[msg.sender] += amount; totalUserCredit += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, validUntil[msg.sender]);
    }
    function requestConsumption(address user, bytes32 sessionKey) external onlyMerchant nonReentrant returns (uint256 id) {
        if (user == address(0) || sessionKey == bytes32(0)) revert InvalidAddress();
        if (block.timestamp >= validUntil[user]) revert CardExpired();
        if (balances[user] < sessionPrice) revert InsufficientCredit();
        uint256 active = activeRequest[user];
        if (active != 0) {
            if (block.timestamp < requests[active].expiresAt) revert PendingRequest();
            _finish(active, Status.Expired); emit ConsumptionExpired(active, user);
        }
        if (usedSessionKeys[user][sessionKey]) revert DuplicateSession();
        usedSessionKeys[user][sessionKey] = true;
        id = nextRequestId++;
        requests[id] = Request(user, sessionKey, sessionPrice, block.timestamp, block.timestamp + requestDuration, Status.Requested);
        activeRequest[user] = id;
        emit ConsumptionRequested(id, user, sessionKey, sessionPrice, requests[id].expiresAt);
    }
    function confirmConsumption(uint256 id) external nonReentrant {
        Request storage r = _pending(id);
        if (r.user != msg.sender) revert Unauthorized();
        if (block.timestamp >= r.expiresAt) revert RequestExpired();
        if (block.timestamp >= validUntil[msg.sender]) revert CardExpired();
        if (balances[msg.sender] < r.amount) revert InsufficientCredit();
        balances[msg.sender] -= r.amount; totalUserCredit -= r.amount; merchantAvailable += r.amount;
        _finish(id, Status.Confirmed);
        emit ConsumptionConfirmed(id, msg.sender, r.amount, msg.sender);
    }
    function rejectConsumption(uint256 id) external nonReentrant {
        Request storage r = _pending(id);
        if (r.user != msg.sender) revert Unauthorized();
        address user = r.user; _finish(id, Status.Rejected); emit ConsumptionRejected(id, user);
    }
    function cancelConsumption(uint256 id) external onlyMerchant nonReentrant {
        address user = _pending(id).user; _finish(id, Status.Cancelled); emit ConsumptionCancelled(id, user);
    }
    function expireConsumption(uint256 id) external nonReentrant {
        Request storage r = _pending(id);
        if (block.timestamp < r.expiresAt) revert NotExpired();
        address user = r.user; _finish(id, Status.Expired); emit ConsumptionExpired(id, user);
    }
    function refund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (amount > balances[msg.sender]) revert InsufficientCredit();
        balances[msg.sender] -= amount; totalUserCredit -= amount;
        token.safeTransfer(msg.sender, amount); emit Refunded(msg.sender, amount);
    }
    function withdraw(uint256 amount) external onlyMerchant nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 availableBefore = merchantAvailable;
        if (amount > availableBefore) revert InsufficientRevenue();
        merchantAvailable -= amount;
        token.safeTransfer(payoutAddress, amount);
        emit Withdrawn(msg.sender, payoutAddress, amount, availableBefore);
    }
    function setPayoutAddress(address next) external onlyMerchant nonReentrant {
        if (next == address(0) || next == payoutAddress) revert InvalidAddress();
        address old = payoutAddress; payoutAddress = next; emit PayoutAddressChanged(msg.sender, old, next);
    }
    function getAccounting() external view returns (uint256 assets, uint256 userCredit, uint256 revenue, uint256 surplus, uint256 deficit) {
        assets = token.balanceOf(address(this)); userCredit = totalUserCredit; revenue = merchantAvailable;
        uint256 liabilities = userCredit + revenue;
        if (assets >= liabilities) surplus = assets - liabilities; else deficit = liabilities - assets;
    }
    function _pending(uint256 id) private view returns (Request storage r) {
        r = requests[id]; if (r.status != Status.Requested) revert InvalidRequest();
    }
    function _finish(uint256 id, Status status) private {
        Request storage r = requests[id]; r.status = status; activeRequest[r.user] = 0;
    }
}
