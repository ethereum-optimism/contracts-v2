// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

/* Interface Imports */
import { iOVM_ECDSAContractAccount } from "../../iOVM/accounts/iOVM_ECDSAContractAccount.sol";

/* Library Imports */
import { Lib_OVMCodec } from "../../libraries/codec/Lib_OVMCodec.sol";
import { Lib_ECDSAUtils } from "../../libraries/utils/Lib_ECDSAUtils.sol";
import { Lib_SafeExecutionManagerWrapper } from "../../libraries/wrappers/Lib_SafeExecutionManagerWrapper.sol";

/**
 * @title OVM_ECDSAContractAccount
 */
contract OVM_ECDSAContractAccount is iOVM_ECDSAContractAccount {

    address constant ETH_ERC20_ADDRESS = 0x4200000000000000000000000000000000000006;
    uint256 constant MIN_GAS_LIMIT_PER_TRANSACTION = 2000;

    /********************
     * Public Functions *
     ********************/

    /**
     * Executes a signed transaction.
     * @param _transaction Signed EOA transaction.
     * @param _signatureType Hashing scheme used for the transaction (e.g., ETH signed message).
     * @param _v Signature `v` parameter.
     * @param _r Signature `r` parameter.
     * @param _s Signature `s` parameter.
     * @return _success Whether or not the call returned (rather than reverted).
     * @return _returndata Data returned by the call.
     */
    function execute(
        bytes memory _transaction,
        Lib_OVMCodec.EOASignatureType _signatureType,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    )
        override
        public
        returns (
            bool _success,
            bytes memory _returndata
        )
    {
        bool isEthSign = _signatureType == Lib_OVMCodec.EOASignatureType.ETH_SIGNED_MESSAGE;

        // Address of this contract within the ovm (ovmADDRESS) should be the same as the
        // recovered address of the user who signed this message. This is how we manage to shim
        // account abstraction even though the user isn't a contract.
        // Need to make sure that the transaction nonce is right and bump it if so.
        Lib_SafeExecutionManagerWrapper.safeREQUIRE(
            Lib_ECDSAUtils.recover(
                _transaction,
                isEthSign,
                _v,
                _r,
                _s
            ) == Lib_SafeExecutionManagerWrapper.safeADDRESS(),
            "Signature provided for EOA transaction execution is invalid."
        );

        Lib_OVMCodec.EIP155Transaction memory decodedTx = Lib_OVMCodec.decodeEIP155Transaction(_transaction, isEthSign);

        // Need to make sure that the transaction chainId is correct.
        Lib_SafeExecutionManagerWrapper.safeREQUIRE(
            decodedTx.chainId == Lib_SafeExecutionManagerWrapper.safeCHAINID(),
            "Transaction chainId does not match expected OVM chainId."
        );

        // Need to make sure that the transaction nonce is right.
        Lib_SafeExecutionManagerWrapper.safeREQUIRE(
            decodedTx.nonce == Lib_SafeExecutionManagerWrapper.safeGETNONCE(),
            "Transaction nonce does not match the expected nonce."
        );

        // Need to check that the gas limit will not cause underflow.
        Lib_SafeExecutionManagerWrapper.safeREQUIRE(
            decodedTx.gasLimit >= MIN_GAS_LIMIT_PER_TRANSACTION,
            "Transaction gasLimit is below the minimum needed."
        );

        // Transfer fee to relayer.
        address relayer = Lib_SafeExecutionManagerWrapper.safeCALLER();
        uint256 fee = decodedTx.gasLimit * decodedTx.gasPrice;
        Lib_SafeExecutionManagerWrapper.safeCALL(
            gasleft(),
            ETH_ERC20_ADDRESS,
            abi.encodeWithSignature("transfer(address,uint256)", relayer, fee)
        );

        // Contract creations are signalled by sending a transaction to the zero address.
        if (decodedTx.to == address(0)) {
            address created = Lib_SafeExecutionManagerWrapper.safeCREATE(
                decodedTx.gasLimit - MIN_GAS_LIMIT_PER_TRANSACTION,
                decodedTx.data
            );

            // EVM doesn't tell us whether a contract creation failed, even if it reverted during
            // initialization. Always return `true` for our success value here.
            return (true, abi.encode(created));
        } else {
            // We only want to bump the nonce for `ovmCALL` because `ovmCREATE` automatically bumps
            // the nonce of the calling account. Normally an EOA would bump the nonce for both
            // cases, but since this is a contract we'd end up bumping the nonce twice.
            Lib_SafeExecutionManagerWrapper.safeSETNONCE(decodedTx.nonce + 1);

            return Lib_SafeExecutionManagerWrapper.safeCALL(
                decodedTx.gasLimit,
                decodedTx.to,
                decodedTx.data
            );
        }
    }
}
