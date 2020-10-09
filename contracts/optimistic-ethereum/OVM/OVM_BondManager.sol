// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.0;

import { Lib_AddressResolver } from "../libraries/resolver/Lib_AddressResolver.sol";
import { iOVM_FraudVerifier } from "../iOVM/verification/iOVM_FraudVerifier.sol";

interface ERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// All the errors which may be encountered on the bond manager
library Errors {
    string constant ERC20_ERR = "BondManager: Could not post bond";
    string constant NOT_ENOUGH_COLLATERAL = "BondManager: Sequencer is not sufficiently collateralized";
    string constant LOW_VALUE = "BondManager: New collateral value must be greater than the previous one";
    string constant NOT_OWNER = "BondManager: Only the contract's owner can call this function";
    string constant TRANSITIONER_INCOMPLETE = "BondManager: Transitioner is still calculating the post state root";
}

contract OVM_BondManager is Lib_AddressResolver {
    /// Owner used to bump the security bond size
    address public owner;

    /// The bond token
    ERC20 immutable public token;

    /// The fraud verifier contract, used to get data about transitioners for a pre-state root
    // address public ovmFraudVerifier;
    address public ovmCanonicalStateCommitmentChain;

    uint256 requiredCollateral = 1 ether;

    /// A bond posted by a sequencer
    /// The bonds posted by each sequencer
    mapping(address => uint256) public bonds;

    // Per pre-state root, store the number of state provisions that were made
    // and how many of these calls were made by each user. Payouts will then be
    // claimed by users proportionally for that dispute.
    struct Rewards {
        bool canClaim;
        // Total number of `storeWitnessProvider` calls made
        uint256 total;
        // The sum of all values inside this map MUST be equal to the
        // value of `totalClaims`
        mapping(address => uint256) numClaims;
    }
    /// For each pre-state root, there's an array of witnessProviders that must be rewarded
    /// for posting witnesses
    mapping(bytes32 => Rewards) public witnessProviders;

    /// Mapping of pre-state root to sequencer
    mapping(uint256 => address) public sequencers;

    /// Initializes with a ERC20 token to be used for the fidelity bonds
    /// and with the Address Manager
    constructor(ERC20 _token, address _libAddressManager)
        Lib_AddressResolver(_libAddressManager)
    {
        owner = msg.sender;
        token = _token;
        // ovmFraudVerifier = resolve("OVM_FraudVerifier"); // TODO: Re-enable this
        ovmCanonicalStateCommitmentChain = resolve("OVM_CanonicalStateCommitmentChain");
    }

    /// Adds `who` to the list of witnessProviders for the provided `preStateRoot`.
    function storeWitnessProvider(bytes32 _preStateRoot, address who) public {
        // The sender must be the transitioner that corresponds to the claimed pre-state root
        address transitioner = address(iOVM_FraudVerifier(resolve("OVM_FraudVerifier")).getStateTransitioner(_preStateRoot));
        require(transitioner == msg.sender);

        witnessProviders[_preStateRoot].total += 1;
        witnessProviders[_preStateRoot].numClaims[who] += 1;
    }

    /// Slashes + distributes rewards or frees up the sequencer's bond, only called by
    /// `FraudVerifier.finalizeFraudVerification`
    function finalize(bytes32 _preStateRoot, uint256 batchIndex, bool isFraud) public {
        require(msg.sender == resolve("OVM_FraudVerifier"), "ERR not callable by non fraud verifier");

        // TODO: can this be removed?
        require(sequencers[batchIndex] != address(0), "err: sequencer already claimed");
        require(witnessProviders[_preStateRoot].canClaim == false, "err users already claimed");

        if (isFraud) {
            // allow users to claim from that state root's
            // pool of collateral (effectively slashing the sequencer)
            witnessProviders[_preStateRoot].canClaim = true;
        } else {
            // refund collateral to the sequencer for that batch
            // TODO: Should this actually be refunded? Can't there be more than 1
            // cases of fraud for a batch e.g. because of multiple invalid state
            // transitions? should these be penalized multiple times?
            bonds[sequencers[batchIndex]] += requiredCollateral;
        }

        // Reset the storage slot to disallow this from being called multiple times
        delete sequencers[batchIndex];
    }

    // Claims the user's proportion of the provided state
    function claim(bytes32 _preStateRoot) public {
        Rewards storage rewards = witnessProviders[_preStateRoot];

        // only allow claiming if fraud was proven in `finalize`
        require(rewards.canClaim, "Cannot claim rewards");

        // proportional allocation
        uint256 amount = (requiredCollateral * rewards.numClaims[msg.sender]) / rewards.total;

        // reset the user's claims so they cannot double claim
        rewards.numClaims[msg.sender] = 0;

        // transfer
        require(token.transfer(msg.sender, amount), Errors.ERC20_ERR);
    }

    ////////////////////////
    // Collateral Management
    ////////////////////////

    // Stakes the user for the provided batch index
    function stake(address who, uint256 batchIndex) public returns (bool) {
        // only callable by the state commitment chain in the `appendBatch` call
        require(msg.sender == ovmCanonicalStateCommitmentChain);

        // `batchIndex` MUST BE a strictly increasing number in the state commitment chain
        // this check can be removed if that invariant is guaranteed
        require(sequencers[batchIndex] == address(0), "already staked for this batch");

        // lock up the collateral
        require(bonds[who] >= requiredCollateral, Errors.NOT_ENOUGH_COLLATERAL);
        bonds[who] -= requiredCollateral;

        // store the sequencer's address as the proposer of the provided batch idx
        sequencers[batchIndex] = who;

        return true;
    }

    /// Sequencers call this function to post collateral which will be used for
    /// the `appendBatch` call
    function deposit(uint256 amount) public {
        require(
            token.transferFrom(msg.sender, address(this), amount),
            Errors.ERC20_ERR
        );

        // This cannot overflow
        bonds[msg.sender] += amount;
    }

    /// Sequencers call this function to withdraw collateral that they were able
    /// to reclaim as a result of no fraud proof being initialized for their batch
    function withdraw(uint256 amount) public {
        require(bonds[msg.sender] >= amount);
        bonds[msg.sender] -= amount;
        require(
            token.transfer(msg.sender, amount),
            Errors.ERC20_ERR
        );
    }

    /// Sets the required collateral for posting a state root
    /// Callable only by the contract's deployer.
    function setRequiredCollateral(uint256 newValue) public {
        require(newValue > requiredCollateral, Errors.LOW_VALUE);
        require(msg.sender == owner, Errors.NOT_OWNER);
        requiredCollateral = newValue;
    }

    function getNumberOfClaims(bytes32 preStateRoot, address who) public view returns (uint256) {
        return witnessProviders[preStateRoot].numClaims[who];
    }
}
